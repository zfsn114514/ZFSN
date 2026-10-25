/* 背包面板 vs 屏幕底部快捷栏：内容必须始终一致。
   面板是「打开时一次性渲染」的，捡东西 / /give / 吃东西 / 熔炉取产物 / 死亡重生 /
   读档 都不会重画面板 —— 用户截图里两处内容对不上就是这个。
   这里直接改 world.inventory（等价于那些外部改动），等 HUD 的那一拍过去，
   断言面板已经自己补画回来。 */
const PORT = process.env.CDP_PORT || 9301;
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, msg, detail) => {
  if (!ok) problems.push(msg + (detail !== undefined ? ` → 实际 ${JSON.stringify(detail)}` : ''));
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${msg}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

const READ = `(()=>{
  const read=(sel)=>[...document.querySelectorAll(sel+' .slot')].map(s=>{
    const img=(s.querySelector('img')?.getAttribute('src')||'').split('/').pop().replace(/\\.png$/,'');
    return img+':'+(s.querySelector('.count')?.textContent||1);});
  return {hud:read('#hotbar'),panel:read('#inv-hotbar'),grid:read('#slots'),
    open:document.querySelector('#inventory-dialog').open};})()`;

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
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-SYNC';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`); await sleep(1800);
  check(await ev('window.zfsnMC.playing===true'), '进入游戏');

  await ev(`document.querySelector('#touch-inventory').click(); true`); await sleep(450);
  const opened = await ev(READ);
  check(opened.open === true, '背包已打开');
  check(JSON.stringify(opened.hud) === JSON.stringify(opened.panel), '打开瞬间：面板快捷栏 === 底部快捷栏', opened.panel);

  // ① 外部改动（捡东西 / give / 熔炉 / 重生 都长这样）：只动数据，不碰面板
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory=Array(36).fill(null);
    for(let i=0;i<9;i++)w.inventory[i]={id:'lapis_block',n:64};
    w.inventory[20]={id:'stone',n:7};return true;})()`);
  await sleep(400);   // HUD 每 120ms 一拍
  const after = await ev(READ);
  check(after.panel.filter((s) => s.startsWith('lapis_block')).length === 9,
    '外部改动后：面板自己补画了 9 格蓝晶块', after.panel.filter((s) => s.startsWith('lapis_block')).length);
  check(after.grid[11] === 'stone:7', '外部改动后：面板里（第 20 格 → 网格第 12 格）是石头 ×7', after.grid[11]);
  check(JSON.stringify(after.hud) === JSON.stringify(after.panel), '外部改动后：面板 === 底部快捷栏（不再各说各话）',
    { hud: after.hud.slice(0, 3), panel: after.panel.slice(0, 3) });

  // ② 反向：清空背包，面板要跟着空
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory=Array(36).fill(null);return true;})()`);
  await sleep(400);
  const cleared = await ev(READ);
  check(cleared.panel.every((s) => s === ':1'), '清空背包后面板也清空', cleared.panel.slice(0, 3));
  check(JSON.stringify(cleared.hud) === JSON.stringify(cleared.panel), '清空后面板 === 底部快捷栏');

  // ③ 合成格 / 手上的东西变化也要同步（指纹里带了它们）
  await ev(`(()=>{const w=window.zfsnMC.world;w.craftGrid[0]={id:'oak_log',n:3};return true;})()`);
  await sleep(400);
  const gridSync = await ev(`(()=>{const g=document.querySelector('#craft-grid .slot img');
    return g?(g.getAttribute('src')||'').split('/').pop():null;})()`);
  check(gridSync === 'oak_log.png', '合成格数据变了，面板里的 2×2 也跟着画出来了', gridSync);

  // ④ 点格子拿起来再放下：手指下这一套不能因为面板重画而失灵
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory=Array(36).fill(null);
    w.inventory[0]={id:'stone',n:64};window.zfsnMC.refreshInv();return true;})()`);
  await sleep(300);
  const pos = await ev(`(()=>{const c=(i)=>{const r=document.querySelectorAll('#inv-hotbar .slot')[i].getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};};return {from:c(0),to:c(2)};})()`);
  const mouse = (type, x, y, button = 'left', buttons = 1) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0 });
  await mouse('mouseMoved', pos.from.x, pos.from.y, 'none', 0);
  await mouse('mousePressed', pos.from.x, pos.from.y);
  await sleep(60);
  await mouse('mouseReleased', pos.from.x, pos.from.y, 'left', 0);
  await sleep(120);
  const held = await ev(`(()=>{const h=window.zfsnMC.held;return h?h.id+':'+h.n:null;})()`);
  await mouse('mouseMoved', pos.to.x, pos.to.y, 'none', 0);
  await mouse('mousePressed', pos.to.x, pos.to.y);
  await sleep(60);
  await mouse('mouseReleased', pos.to.x, pos.to.y, 'left', 0);
  await sleep(350);
  const pick = await ev(READ);
  check(held === 'stone:64', '左键点一下能整叠拿起来', held);
  check(pick.panel[0] === ':1' && pick.panel[2] === 'stone:64', '再点空格放下，格子确实动了', pick.panel.slice(0, 4));
  check(JSON.stringify(pick.hud) === JSON.stringify(pick.panel), '放下后面板 === 底部快捷栏', pick.panel.slice(0, 4));

  await cdp.send('Page.navigate', { url: 'about:blank' });
  console.log('');
  if (problems.length) { console.log(`问题（${problems.length}）:`); for (const p of problems) console.log('  - ' + p); process.exit(1); }
  console.log('PASS — 背包面板与快捷栏始终同步');
  process.exit(0);
}
main().catch((e) => { console.error('探针异常:', e.message); process.exit(1); });
