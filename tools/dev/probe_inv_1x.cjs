/* 桌面视口（1280×800，不触发窄屏 media query）下的背包截图，
   用来和用户给的截图做 1:1 对照。 */
const PORT = process.env.CDP_PORT || 9301;
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = { send: (method, params = {}) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result))); ws.send(JSON.stringify({ id: mid, method, params })); }) };
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed');
    return r.result.value;
  };
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: PAGE }); await sleep(1600);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE }); await sleep(1600);
  await ev(`document.querySelector('#play').click()`); await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-LOOK2';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`); await sleep(1800);
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory=Array(36).fill(null);
    for(let i=0;i<9;i++)w.inventory[i]={id:'lapis_block',n:64};
    w.inventory[11]={id:'lapis_block',n:60};w.inventory[12]={id:'lapis_block',n:3};
    w.inventory[13]={id:'lapis_block',n:9};w.inventory[14]={id:'lapis_block',n:32};
    w.inventory[15]={id:'lapis_block',n:64};w.inventory[10]={id:'arrow',n:32};
    window.zfsnMC.refreshInv();document.querySelector('#touch-inventory').click();return true;})()`);
  await sleep(600);
  const panel = await ev(`(()=>{const p=document.querySelector('#inventory-dialog .inv-panel').getBoundingClientRect();
    return {x:p.x,y:p.y,w:p.width,h:p.height};})()`);
  console.log('panel', JSON.stringify(panel));
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: panel.x, y: panel.y, width: panel.w, height: panel.h, scale: 1 },
  });
  const fs = require('node:fs');
  fs.mkdirSync('.tmp-mc', { recursive: true });
  fs.writeFileSync('.tmp-mc/inv-1x.png', Buffer.from(r.data, 'base64'));
  console.log('shot → .tmp-mc/inv-1x.png');
  await cdp.send('Page.navigate', { url: 'about:blank' });
  process.exit(0);
}
main().catch((e) => { console.error('探针异常:', e.message); process.exit(1); });
