/* 量三处数量角标的几何：面板格子 / 面板快捷栏 / 屏幕底部 HUD 快捷栏。
   ★ 只比「数字底边 - 格子底边」的差，不硬编码像素 —— 各处 zoom 不同。 */
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
  await cdp.send('Page.navigate', { url: PAGE }); await sleep(1600);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE }); await sleep(1600);
  await ev(`document.querySelector('#play').click()`); await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-GEO';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`); await sleep(1600);
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory=Array(36).fill(null);
    for(let i=0;i<36;i++)w.inventory[i]={id:'lapis_block',n:64};
    window.zfsnMC.refreshInv();document.querySelector('#touch-inventory').click();return true;})()`);
  await sleep(500);

  const out = await ev(`(()=>{
    const R=el=>{const r=el.getBoundingClientRect();return {l:+r.left.toFixed(1),r:+r.right.toFixed(1),t:+r.top.toFixed(1),b:+r.bottom.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1)};};
    const one=(sel)=>{const s=document.querySelector(sel);if(!s)return null;
      const c=s.querySelector('.count');return {slot:R(s),count:c?R(c):null};};
    const bar=document.querySelector('#hotbar'),wrap=document.querySelector('#hotbar-wrap');
    const hud0=one('#hotbar .slot');
    const hudCount=hud0.count, hudSlot=hud0.slot;
    return {hudFrame:R(bar),hudWrap:R(wrap),
      hudSlot,hudCount,
      hudOverflow: hudCount? +(hudCount.b - R(bar).b).toFixed(1):null,
      hudRightOverflow: hudCount? +(hudCount.r - R(bar).r).toFixed(1):null,
      panelHot:one('#inv-hotbar .slot'),grid:one('#slots .slot'),
      barBg:getComputedStyle(bar).backgroundImage.slice(-40),
      zoomInv:getComputedStyle(document.querySelector('#inventory-dialog .inv-root')).zoom};})()`);
  console.log(JSON.stringify(out, null, 1));

  await cdp.send('Page.navigate', { url: 'about:blank' });
  process.exit(0);
}
main().catch((e) => { console.error('探针异常:', e.message); process.exit(1); });
