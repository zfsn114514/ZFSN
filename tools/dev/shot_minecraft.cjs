/* 方块世界：实机截图核对（原生 CDP，不依赖 playwright）
 * 用法：node tools/dev/shot_minecraft.cjs
 * 环境：CDP_PORT / MC_URL
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.CDP_PORT || 9401);
const URL_ = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const OUT = path.resolve(__dirname, '../../.tmp-mc');

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej);
});

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    } else if (m.method) events.push(m);
  });
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  return {
    ready, events,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ★ 必须连「页面」目标，不能连 /json/version 给的浏览器目标 ——
  //   浏览器目标上根本没有 Page 域，会报 'Page.enable' wasn't found。
  let list = await get('/json/list');
  let page = list.find((t) => t.type === 'page');
  if (!page) {
    await new Promise((res, rej) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: '/json/new?about:blank', method: 'PUT' }, (r) => {
        let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(s));
      });
      req.on('error', rej); req.end();
    });
    list = await get('/json/list');
    page = list.find((t) => t.type === 'page');
  }
  if (!page) throw new Error('找不到可用的页面目标');
  const cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(3500);

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('  截图', name);
  };
  const ev = async (expr, awaitPromise = false) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };

  console.log('→ 标题画面');
  await shot('ui-title.png');
  console.log('  标题状态:', await ev(`document.querySelector('#title-status')?.textContent`));
  console.log('  字体是否加载:', await ev(`document.fonts.check('16px MCBitmap')`));

  console.log('→ 进入游戏');
  await ev(`document.querySelector('#play').click()`);
  await sleep(300);
  await ev(`(()=>{const s=document.querySelector('#seed');s.value='ZFSN-VERIFY';})()`);
  await shot('ui-newworld.png');
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2500);
  await shot('ui-ingame.png');

  const state = await ev(`(()=>{const w=window.__zfsn;return null})()`);
  console.log('  ' + JSON.stringify(await ev(`({
    hud: !document.querySelector('#hud').hidden,
    slots: document.querySelectorAll('#hotbar .slot').length,
    hearts: document.querySelectorAll('#health i').length,
    food: document.querySelectorAll('#hunger i').length,
    selLeft: document.querySelector('#hotbar-selection')?.style.left,
  })`)));

  console.log('→ F3 调试 + 背包');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F3', code: 'F3', windowsVirtualKeyCode: 114 });
  await sleep(400);
  await shot('ui-debug.png');
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 });
  await sleep(600);
  await shot('ui-inventory.png');
  console.log('  背包打开:', await ev(`document.querySelector('#inventory-dialog').open`));
  console.log('  配方条数:', await ev(`document.querySelectorAll('#recipes .recipe').length`));
  console.log('  槽位数:', await ev(`document.querySelectorAll('#slots .slot').length + '/' + document.querySelectorAll('#inv-hotbar .slot').length + '/' + document.querySelectorAll('#craft-grid .slot').length`));
  await ev(`document.querySelector('#close-inventory').click()`);
  await sleep(300);

  const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
  console.log('\n=== 运行期错误 (' + errors.length + ') ===');
  for (const e of errors.slice(0, 8)) {
    const p = e.params;
    console.log('  !', p.exceptionDetails?.exception?.description?.split('\n')[0] || p.entry?.text);
  }

  await cdp.send('Page.navigate', { url: 'about:blank' });
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
