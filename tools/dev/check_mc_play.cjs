/* 方块世界：核心交互实测（移动 / 背包 / 挖掘）
 * 用法：CDP_PORT=9334 node tools/dev/check_mc_play.cjs
 *
 * 只看「页面没报错」是不够的：canvas 游戏完全可以在不抛异常的情况下
 * 对键盘毫无反应（事件监听绑错元素、焦点在 body 外的 iframe 里等）。
 * 这里用真实键盘事件驱动，再用游戏自己的状态读数验证真的动了。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CDP_PORT = Number(process.env.CDP_PORT || 9334);
const URL_ = process.env.MC_URL || 'http://127.0.0.1:8899/';
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

// 真实键盘事件：游戏读 keydown/keyup，必须成对发送并带 code/key。
const KEYS = {
  KeyD: { key: 'd', vk: 68 },
  KeyA: { key: 'a', vk: 65 },
  Space: { key: ' ', vk: 32 },
  KeyE: { key: 'e', vk: 69 },
  Escape: { key: 'Escape', vk: 27 },
};

async function key(cdp, code, type) {
  const k = KEYS[code];
  await cdp.send('Input.dispatchKeyEvent', {
    type,
    code,
    key: k.key,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
    ...(type === 'keyDown' ? { text: k.key.length === 1 ? k.key : undefined } : {}),
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const targets = await get('/json/list');
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension'));
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 游戏启动后 rAF 循环会长时间占住主线程，evaluate 容易撞上 25s 超时。
  // 重试比单纯加长等待稳：主线程一有空档，下一次立刻返回。
  const ev = async (expr) => {
    let last;
    for (let i = 1; i <= 3; i++) {
      try {
        const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      } catch (e) {
        last = e;
        if (/timeout/.test(e.message)) await sleep(1200 * i);
        else throw e;
      }
    }
    throw last;
  };

  const problems = [];
  const loc = () => ev(`document.querySelector('#coordinates')?.textContent?.trim() || ''`);
  const num = (s) => { const m = /X\s*(-?\d+)/.exec(s || ''); return m ? Number(m[1]) : null; };

  // 从干净状态进入世界
  try { await cdp.send('Storage.clearDataForOrigin', { origin: new URL(URL_).origin, storageTypes: 'local_storage,indexeddb,cache_storage' }); } catch {}
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(250);
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(4000);
  await ev(`document.querySelector('#new-world button[type=submit]').click()`);
  await sleep(2500);

  // 让 canvas 拿到焦点（游戏可能把键盘监听绑在 canvas 上）
  await ev(`(() => { const c = document.querySelector('#world'); c.focus?.(); c.click?.(); return document.activeElement?.id; })()`);
  await sleep(300);

  // ---- 1. 向右移动 ----
  const before = num(await loc());
  await key(cdp, 'KeyD', 'keyDown');
  await sleep(900);
  await key(cdp, 'KeyD', 'keyUp');
  await sleep(300);
  const afterRight = num(await loc());
  console.log(`向右: X ${before} → ${afterRight}`);
  if (before === null || afterRight === null) problems.push('读不到坐标，无法判断移动');
  else if (afterRight <= before) problems.push(`按 D 后 X 没有增加（${before} → ${afterRight}）`);

  // ---- 2. 向左移动 ----
  // 读数坐标是「方块坐标」整数，移动速度约 1 格/秒，按太短会因取整看不出变化。
  // 所以这里按足 1600ms，确保至少跨过一整格。
  await key(cdp, 'KeyA', 'keyDown');
  await sleep(1600);
  await key(cdp, 'KeyA', 'keyUp');
  await sleep(300);
  const afterLeft = num(await loc());
  console.log(`向左: X ${afterRight} → ${afterLeft}`);
  if (afterLeft !== null && afterRight !== null && afterLeft >= afterRight) {
    problems.push(`按 A 后 X 没有减少（${afterRight} → ${afterLeft}）`);
  }

  // ---- 3. 背包 ----
  await key(cdp, 'KeyE', 'keyDown');
  await key(cdp, 'KeyE', 'keyUp');
  await sleep(900);
  const inv = await ev(`(() => {
    const d = document.querySelector('#inventory-dialog');
    return {
      exists: !!d,
      open: d ? d.open : null,
      slots: document.querySelectorAll('#slots > *').length,
      recipes: document.querySelectorAll('#recipes > *').length,
      station: document.querySelector('#station-status')?.textContent?.trim()?.slice(0, 40) || '',
    };
  })()`);
  console.log('背包:', JSON.stringify(inv));
  if (!inv.open) problems.push('按 E 后背包没有打开');
  if (inv.slots < 9) problems.push(`背包格子只有 ${inv.slots} 个（至少应有 9 格快捷栏）`);
  if (inv.recipes < 1) problems.push('配方书是空的');

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) =>
    fs.writeFileSync(path.join(OUT, 'mc-inventory.png'), Buffer.from(r.data, 'base64')));

  // ---- 4. 关闭背包后挖掘 ----
  await key(cdp, 'Escape', 'keyDown');
  await key(cdp, 'Escape', 'keyUp');
  await sleep(600);
  const closed = await ev(`document.querySelector('#inventory-dialog')?.open === false`);
  if (!closed) problems.push('Esc 没能关闭背包');

  const box = await ev(`(() => { const r = document.querySelector('#world').getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height}; })()`);

  // 屏幕中心往往是天空（空目标）。从上往下扫描，找到第一个真的有方块的位置，
  // 否则「点了没反应」会被误判成挖掘坏了。
  let hit = null;
  for (let dy = 20; dy <= 260 && !hit; dy += 40) {
    const y = box.y + dy;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y, button: 'none', clickCount: 0 });
    await sleep(220);
    const label = await ev(`document.querySelector('#target-label')?.textContent?.trim() || ''`);
    if (label) hit = { x: box.x, y, label };
  }
  console.log('找到可挖目标:', hit ? hit.label + ' @ dy=' + (hit.y - box.y) : '(没找到)');
  if (!hit) problems.push('光标扫过画布中下部都没有识别到目标方块');

  const target = hit || { x: box.x, y: box.y };
  const beforeMine = await ev(`document.querySelector('#item-name')?.textContent?.trim() || ''`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await sleep(1800);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
  await sleep(800);
  const mineResult = await ev(`({
    label: document.querySelector('#target-label')?.textContent?.trim() || '',
    item: document.querySelector('#item-name')?.textContent?.trim() || '',
    toast: document.querySelector('#toast')?.textContent?.trim() || '',
    hotbarFirst: document.querySelector('#hotbar > *')?.textContent?.trim() || '',
  })`);
  console.log('挖掘后:', JSON.stringify(mineResult), '| 之前手持:', beforeMine || '(空)');

  // 判成功的正确口径是「手持/背包里的东西变了」，而不是目标标签还在不在。
  // 方块被挖掉后目标自然消失，label 变空恰恰是成功的结果，不是中断。
  const minedSomething = mineResult.item && mineResult.item !== beforeMine && mineResult.item !== '空手';
  console.log('   → 挖到了:', minedSomething ? mineResult.item : '(没有变化)');
  if (hit && !minedSomething) problems.push(`挖了 ${hit.label} 但手持物品没变（${beforeMine || '空手'} → ${mineResult.item}）`);

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) =>
    fs.writeFileSync(path.join(OUT, 'mc-after-mine.png'), Buffer.from(r.data, 'base64')));

  console.log('\n' + (problems.length ? 'FAIL:\n  - ' + problems.join('\n  - ')
    : 'PASS — 移动、背包、挖掘都真实响应（截图见 .tmp-mc/mc-*.png）'));

  // ★ 必须善后：游戏一旦进入世界就会常驻 requestAnimationFrame 死循环，
  // 页面不关，headless 渲染进程会一直被占着，下一次 CDP evaluate 直接超时
  // （表现为连 Page.enable 都无响应，像是 Chrome 卡死）。
  // 导航到空白页即可让 rAF 循环停下来。
  try { await cdp.send('Page.navigate', { url: 'about:blank' }); await sleep(400); } catch {}

  cdp.close();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
