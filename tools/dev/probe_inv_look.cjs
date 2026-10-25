/* 背包 / 快捷栏数量角标的排版体检：
   ★ 只对比「数字相对自己格子」的关系，不硬编码像素 —— 面板会随 zoom 缩放。 */
const PORT = process.env.CDP_PORT || 9301;
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const cdp = {
    send: (method, params = {}) => new Promise((res, rej) => {
      const mid = ++id;
      pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
      ws.send(JSON.stringify({ id: mid, method, params }));
    }),
  };
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed');
    return r.result.value;
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1600);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1600);
  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-LOOK';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(1800);

  // 塞满 9 格快捷栏 + 27 格主背包
  await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory=Array(36).fill(null);
    for(let i=0;i<9;i++)w.inventory[i]={id:'lapis_block',n:64};
    for(let i=9;i<36;i++)w.inventory[i]={id:'cobblestone',n:64};
    w.inventory[9]={id:'diamond_chestplate',n:1,dur:528};
    window.zfsnMC.refreshInv();document.querySelector('#touch-inventory').click();return true;})()`);
  await sleep(500);

  const geo = await ev(`(()=>{
    const rect=el=>{const r=el.getBoundingClientRect();return {x:+r.x.toFixed(1),y:+r.y.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)};};
    const one=(sel)=>{const s=document.querySelector(sel);if(!s)return null;
      const c=s.querySelector('.count'),im=s.querySelector('img');
      return {slot:rect(s),count:c?rect(c):null,img:im?rect(im):null,
        countText:c?c.textContent:null,
        countFont:c?getComputedStyle(c).fontSize:null,
        countPos:c?getComputedStyle(c).position:null,
        slotPos:getComputedStyle(s).position,
        zoom:getComputedStyle(s).zoom};};
    const panel=document.querySelector('#inventory-dialog .inv-panel,#inventory-dialog .mc-panel,#inventory-dialog');
    return {dpr:devicePixelRatio,zoomRoot:getComputedStyle(document.querySelector('#inventory-dialog')).zoom,
      panel:panel?rect(panel):null,
      hot0:one('#inv-hotbar .slot'), hot8:one('#inv-hotbar .slot:nth-child(9)'),
      grid0:one('#slots .slot'),
      slotsBox:rect(document.querySelector('#slots')),
      hotBox:rect(document.querySelector('#inv-hotbar')),
      cssCount:[...document.styleSheets].flatMap(s=>{try{return [...s.cssRules]}catch(e){return []}})
        .filter(r=>r.selectorText&&/\\.count/.test(r.selectorText)).map(r=>r.selectorText+' {'+r.style.cssText+'}')};})()`);
  console.log(JSON.stringify(geo, null, 1));

  // 放大截图：只截背包面板
  const clip = geo.panel;
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, clip.x - 4), y: Math.max(0, clip.y - 4), width: clip.w + 8, height: clip.h + 8, scale: 2 },
  });
  const fs = require('node:fs');
  fs.mkdirSync('.tmp-mc', { recursive: true });
  fs.writeFileSync('.tmp-mc/inv-look.png', Buffer.from(r.data, 'base64'));
  console.log('shot → .tmp-mc/inv-look.png');

  await cdp.send('Page.navigate', { url: 'about:blank' });
  process.exit(0);
}
main().catch((e) => { console.error('探针异常:', e.message); process.exit(1); });
