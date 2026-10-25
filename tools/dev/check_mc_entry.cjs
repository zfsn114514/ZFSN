/* 首页 / 游戏库的「方块世界」入口是否真的渲染并可跳转
 * 用法：CDP_PORT=9334 node tools/dev/check_mc_entry.cjs
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CDP_PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.SITE_URL || 'http://127.0.0.1:8900';
const OUT = path.resolve(__dirname, '../../.tmp-mc');

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (r) => {
    let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej);
});

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  return {
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('timeout ' + method)); } }, 25000);
    }),
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const targets = await get('/json/list');
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension'));
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const problems = [];

  // ── 首页 ──
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(4000);

  const home = await ev(`(() => {
    // 注意：本站是「单 HTML 多 page 区块」的结构，所有页面都在同一份文档里，
    // 所以不能直接 querySelectorAll('a.card') —— 那会把隐藏的 #page-steam
    // 里的卡片也算成首页的。必须按所属区块过滤。
    const links = [...document.querySelectorAll('a.card')];
    const mc = links.filter(a => a.getAttribute('href') === '/minecraft/' && !a.closest('#page-steam'));
    const first = mc[0];
    let color = null, bg = null;
    if (first) {
      const cs = getComputedStyle(first);
      color = getComputedStyle(first.querySelector('svg')).color;
      bg = cs.getPropertyValue('--c').trim();
      const r = first.getBoundingClientRect();
      var rect = { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top + scrollY) };
    }
    return {
      totalCards: links.length,
      minecraftCards: mc.length,
      visible: first ? first.getBoundingClientRect().width > 0 : false,
      title: first?.querySelector('.t')?.textContent?.trim(),
      sub: first?.querySelector('.s')?.textContent?.trim(),
      iconColor: color,
      cssVarC: bg,
      rect: first ? rect : null,
      href: first?.getAttribute('href'),
    };
  })()`);
  console.log('首页:', JSON.stringify(home, null, 0));

  if (home.minecraftCards !== 1) problems.push(`首页 minecraft 卡片数量 = ${home.minecraftCards}（应为 1）`);
  if (!home.visible) problems.push('首页卡片宽度为 0，没渲染出来');
  if (!home.iconColor || home.iconColor === 'rgb(0, 0, 0)') problems.push(`图标颜色未生效：${home.iconColor}`);
  if (!home.cssVarC) problems.push('--c 变量为空，.card.minecraft 样式没命中');
  if (home.title !== '方块世界 2D') problems.push(`标题不对：${home.title}`);

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) =>
    fs.writeFileSync(path.join(OUT, 'home-entry.png'), Buffer.from(r.data, 'base64')));

  // ── 游戏库页 ──
  await cdp.send('Page.navigate', { url: BASE + '/#steam' });
  await sleep(2500);
  const steamPage = await ev(`(() => {
    const sec = document.querySelector('#page-steam');
    const mc = sec ? [...sec.querySelectorAll('a.card[href="/minecraft/"]')] : [];
    const sub = sec ? [...sec.querySelectorAll('.subhead')].map(e => e.textContent.trim()) : [];
    return {
      pageExists: !!sec,
      pageVisible: sec ? getComputedStyle(sec).display !== 'none' : false,
      minecraftInLibrary: mc.length,
      visible: mc[0] ? mc[0].getBoundingClientRect().width > 0 : false,
      subheads: sub.slice(0, 4),
    };
  })()`);
  console.log('游戏库:', JSON.stringify(steamPage));

  if (!steamPage.pageExists) problems.push('找不到 #page-steam');
  if (steamPage.minecraftInLibrary !== 1) problems.push(`游戏库内 minecraft 卡片 = ${steamPage.minecraftInLibrary}（应为 1）`);
  if (!steamPage.visible) problems.push('游戏库内卡片不可见');

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) =>
    fs.writeFileSync(path.join(OUT, 'library-entry.png'), Buffer.from(r.data, 'base64')));

  // ── 点击跳转 ──
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await sleep(2500);
  await ev(`document.querySelector('a.card[href="/minecraft/"]').click()`);
  await sleep(3500);
  const after = await ev(`({ url: location.pathname, title: document.title, hasStart: !!document.querySelector('#start-screen') })`);
  console.log('点击后:', JSON.stringify(after));
  if (after.url !== '/minecraft/') problems.push(`点击后路径是 ${after.url}`);
  if (!after.hasStart) problems.push('跳转后没有看到开始界面');

  console.log('\n' + (problems.length ? 'FAIL:\n  - ' + problems.join('\n  - ') : 'PASS — 首页与游戏库入口都正常，点击可进入游戏'));
  cdp.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
