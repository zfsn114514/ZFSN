/* 方块世界（minecraft/）运行时自检
 *
 * 用途：在不依赖 playwright 的前提下，用原生 CDP 把游戏真的跑一遍，
 *       抓 console 错误 / 未捕获异常，并验证「创建世界 → 进入游戏」这条主路径。
 *
 * 用法：
 *   node tools/dev/check_minecraft.cjs                      # 默认 http://127.0.0.1:8899/
 *   MC_URL=http://127.0.0.1:8899/ CDP_PORT=9333 node tools/dev/check_minecraft.cjs
 *
 * 前置：一个已开启 --remote-debugging-port 的无头 Chrome，以及一个静态服务器。
 *
 * 为什么不用 --dump-dom：它只给 DOM，拿不到运行时异常；而这类 canvas 游戏
 * 最常见的失败（贴图加载 reject、requestAnimationFrame 里抛错）恰恰只在
 * console 里出现，DOM 看上去完全正常。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CDP_PORT = Number(process.env.CDP_PORT || 9333);
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
  const events = [];
  const listeners = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
      listeners.forEach((fn) => fn(msg));
    }
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });
  return {
    ready, events,
    on: (fn) => listeners.push(fn),
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id: mid, method, params, sessionId } : { id: mid, method, params }));
      setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error('CDP timeout: ' + method)); } }, 30000);
    }),
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const targets = await get('/json/list');
  const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension'));
  if (!page) throw new Error('找不到可用的 page target');

  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;

  const consoleErrors = [];
  const exceptions = [];
  const failedRequests = [];

  cdp.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      const text = (m.params.args || []).map((a) => a.value ?? a.description ?? a.preview?.description ?? '').join(' ').trim();
      if (text) consoleErrors.push(`[${m.params.type}] ${text}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      exceptions.push(d.exception?.description || d.text || 'unknown exception');
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      // /favicon.ico 是绝对路径，指向站点根。本地把静态服务器根设成 minecraft/
      // 时必然 404；线上站点根存在该文件，所以这是测试环境的假阳性，不是游戏缺陷。
      const u = m.params.entry.url || '';
      if (!/\/favicon\.ico(\?|$)/.test(u)) consoleErrors.push('[log] ' + m.params.entry.text + ' ' + u);
    }
    if (m.method === 'Network.loadingFailed') {
      failedRequests.push(`${m.params.type} ${m.params.errorText}`);
    }
  });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');

  // 每次都从「从未玩过」的干净状态开始。否则第二次运行会带着上一轮的存档，
  // 首页变成「继续我的世界」而不是「创建世界」，测的就不是同一条路径了。
  const origin = new URL(URL_).origin;
  try { await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage,indexeddb,cache_storage' }); } catch { /* 老版本 Chrome 无此域，忽略 */ }
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await sleep(300);

  console.log('导航到', URL_);
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(4000);

  // 贴图解码和大段脚本初始化会占住主线程，evaluate 排队时容易撞上 30s 超时。
  // 重试比单纯加长等待更可靠：一旦空闲，下一次就立刻返回。
  const evalJs = async (expr, awaitPromise = true) => {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: expr, returnByValue: true, awaitPromise,
        });
        if (r.exceptionDetails) throw new Error('EVAL ERROR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
        return r.result.value;
      } catch (e) {
        lastErr = e;
        if (/CDP timeout/.test(e.message)) await sleep(1500 * attempt);
        else throw e;
      }
    }
    throw lastErr;
  };

  // ---- 1. 首屏状态 ----
  const startState = await evalJs(`(() => {
    const cs = getComputedStyle(document.querySelector('#start-screen') || document.body);
    const cv = document.querySelector('#world');
    return {
      title: document.title,
      hasStart: !!document.querySelector('#start-screen'),
      startVisible: cs.display !== 'none' && cs.visibility !== 'hidden',
      canvasW: cv ? cv.width : 0,
      canvasH: cv ? cv.height : 0,
      hudHidden: document.querySelector('#hud')?.hidden,
      seedInput: !!document.querySelector('#seed'),
      submitBtn: !!document.querySelector('#new-world button[type=submit]'),
    };
  })()`);
  console.log('首屏:', JSON.stringify(startState));

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) =>
    fs.writeFileSync(path.join(OUT, 'mc-start.png'), Buffer.from(r.data, 'base64')));

  // ---- 2. 创建世界 ----
  const clicked = await evalJs(`(() => {
    const btn = document.querySelector('#new-world button[type=submit]');
    if (!btn) return 'NO_BUTTON';
    btn.click();
    return 'CLICKED';
  })()`);
  console.log('创建世界:', clicked);
  await sleep(3000);

  // ---- 3. 进入游戏后的状态 ----
  const playState = await evalJs(`(() => {
    const cv = document.querySelector('#world');
    const hud = document.querySelector('#hud');
    const start = document.querySelector('#start-screen');
    let painted = null;
    try {
      const ctx = cv.getContext('2d');
      const d = ctx.getImageData(0, 0, Math.min(cv.width, 200), Math.min(cv.height, 200)).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i+1] + ',' + d[i+2] + ',' + d[i+3]);
      painted = seen.size;
    } catch (e) { painted = 'ERR:' + e.message; }
    return {
      startHidden: start ? getComputedStyle(start).display === 'none' || start.hidden : null,
      hudVisible: hud ? !hud.hidden : null,
      hotbarSlots: document.querySelectorAll('#hotbar .slot, #hotbar > *').length,
      healthNodes: document.querySelectorAll('#health > *').length,
      coords: document.querySelector('#coordinates')?.textContent?.trim() || '',
      biome: document.querySelector('#biome')?.textContent?.trim() || '',
      distinctColorsInCanvasCorner: painted,
    };
  })()`);
  console.log('游戏中:', JSON.stringify(playState));

  await cdp.send('Page.captureScreenshot', { format: 'png' }).then((r) =>
    fs.writeFileSync(path.join(OUT, 'mc-play.png'), Buffer.from(r.data, 'base64')));

  // ---- 4. 汇总 ----
  console.log('\n=== 未捕获异常 (' + exceptions.length + ') ===');
  exceptions.slice(0, 10).forEach((e) => console.log('  !', e.split('\n')[0]));
  console.log('=== console error/warn (' + consoleErrors.length + ') ===');
  consoleErrors.slice(0, 10).forEach((e) => console.log('  !', e.slice(0, 200)));
  console.log('=== 失败请求 (' + failedRequests.length + ') ===');
  failedRequests.slice(0, 10).forEach((e) => console.log('  !', e));

  const ok = exceptions.length === 0 && consoleErrors.length === 0
    && playState.startHidden === true && playState.hudVisible === true
    && typeof playState.distinctColorsInCanvasCorner === 'number' && playState.distinctColorsInCanvasCorner > 1;

  console.log('\n结论:', ok ? 'PASS — 世界创建成功，画布已绘制，无运行时错误'
    : 'FAIL — 见上方异常/状态，截图在 ' + OUT);
  cdp.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e.message); process.exit(2); });
