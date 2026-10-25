/* 新功能探针：双击收集同名 / Shift 快速移动与自动穿戴 / 盔甲减伤与磨损 /
   一键合成 / 弓（拉弓-发射-消耗）/ 箭（抛物线-插方块-靠近拾取-命中生物）/ 存档往返。 */
const PORT = process.env.CDP_PORT || 9301;
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, msg, detail) => {
  if (!ok) problems.push(msg + (detail !== undefined ? ` → 实际 ${JSON.stringify(detail)}` : ''));
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${msg}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

const READ = `(()=>{
  const w=window.zfsnMC.world;
  const inv=w.inventory.map(s=>s?s.id+':'+s.n:null);
  return {inv,armor:JSON.parse(JSON.stringify(w.player.armor)),arrows:w.arrows.length,
    draw:w.drawBow?+w.drawBow.t.toFixed(2):null,held:window.zfsnMC.held?window.zfsnMC.held.id+':'+window.zfsnMC.held.n:null,
    health:+w.player.health.toFixed(2),face:w.player.face,px:+w.player.x.toFixed(2),py:+w.player.y.toFixed(2)};})()`;

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
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-GEAR';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`); await sleep(1800);
  check(await ev('window.zfsnMC.playing===true'), '进入游戏');

  // 鼠标点击工具：mode=0 左键 / 2 右键；mods 位掩码（Shift=8）
  const mouse = (type, x, y, button = 'left', buttons = 0, mods = 0) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0, modifiers: mods });
  const slotPos = (sel, nth = 1) => ev(`(()=>{const el=document.querySelectorAll('${sel} .slot')[${nth - 1}];
    if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
  const click = async (pos, button = 'left', mods = 0) => {
    await mouse('mouseMoved', pos.x, pos.y, 'none', 0);
    await mouse('mousePressed', pos.x, pos.y, button, button === 'left' ? 1 : 2, mods);
    await sleep(40);
    await mouse('mouseReleased', pos.x, pos.y, button, 0, mods);
    await sleep(120);
  };

  /* ═══ A. 双击收集同名 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory=Array(36).fill(null);
    w.inventory[10]={id:'oak_planks',n:3};w.inventory[20]={id:'oak_planks',n:5};
    w.inventory[21]={id:'dirt',n:1};
    w.player.armor={helmet:null,chestplate:null,leggings:null,boots:null};
    window.zfsnMC.refreshInv();return true;})()`);
  await ev(`document.querySelector('#touch-inventory').click(); true`); await sleep(450);
  const c1 = await slotPos('#slots', 2);       // inventory[10] → #slots 第 2 格
  check(!!c1, '打开背包并定位到格 10', c1);
  await click(c1); await click(c1);            // 双击（<350ms）
  let st = await ev(READ);
  check(st.held === 'oak_planks:8', '★ 双击把两格同名收进手里（3+5=8）', st.held);
  check(st.inv[10] === null && st.inv[20] === null && st.inv[21] === 'dirt:1', '同名格清空、异类不受影响', { 10: st.inv[10], 20: st.inv[20], 21: st.inv[21] });
  const c3 = await slotPos('#slots', 13);      // inventory[21] → #slots 第 13 格
  await click(c3);                             // 点 dirt：异类交换
  st = await ev(READ);
  check(st.held === 'dirt:1', '异类正常交换', st.held);
  await click(c1);                             // 放下 dirt，收尾
  await ev(`window.zfsnMC.world.add('oak_planks',8);window.zfsnMC.world.inventory[10]=null;true`);

  /* ═══ B. Shift 快速移动 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory[10]={id:'stone',n:10};window.zfsnMC.refreshInv();return true;})()`);
  await click(c1, 'left', 8);                  // Shift+点击主背包格 → 应移到快捷栏
  st = await ev(READ);
  check(st.inv[10] === null && st.inv.slice(0, 9).some((s) => s?.startsWith('stone')), '★ Shift+点击：主背包 → 快捷栏', { 10: st.inv[10], hotbar: st.inv.slice(0, 9) });
  const hb = await slotPos('#inv-hotbar', 1);
  await click(hb, 'left', 8);                  // 再 Shift 回去
  st = await ev(READ);
  // 注意：A 步收尾 add 的木板可能占了格 9，回移会落进第一个空格 —— 所以查「主背包里有它」而不是具体格号
  check(st.inv[0] === null && st.inv.slice(9).includes('stone:10'), '★ Shift+点击：快捷栏 → 主背包', { 0: st.inv[0], main: st.inv.slice(9).find((s) => s?.startsWith('stone')) });

  /* ═══ C. 盔甲 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory[12]={id:'iron_chestplate',n:1,dur:240};w.inventory[13]={id:'iron_helmet',n:1,dur:165};
    w.player.invuln=0;window.zfsnMC.refreshInv();return true;})()`);
  const c13 = await slotPos('#slots', 5);      // inventory[13] → #slots 第 5 格
  await click(c13, 'left', 8);                 // Shift 穿头盔
  st = await ev(READ);
  check(st.armor.helmet?.id === 'iron_helmet' && st.inv[13] === null, '★ Shift+点击穿戴件自动穿上（头盔）', st.armor.helmet);
  const c12 = await slotPos('#slots', 4);      // inventory[12] → #slots 第 4 格
  await click(c12, 'left', 8);                 // Shift 穿胸甲
  st = await ev(READ);
  check(st.armor.chestplate?.id === 'iron_chestplate', '胸甲也穿上了', st.armor.chestplate);

  const h0 = st.health;
  await ev(`(()=>{const w=window.zfsnMC.world;w.player.invuln=0;w.damage(4,'测试');return true;})()`);
  st = await ev(READ);
  const lost = h0 - st.health;
  check(lost > 0 && lost < 3.7, '★ 盔甲减伤生效（iron 头盔+胸甲=8 点 → 4 伤害打 2.88）',
    { lost: +lost.toFixed(2), expect: +(4 * (1 - 8 * .04)).toFixed(2) });
  check(st.armor.helmet.dur === 164 && st.armor.chestplate.dur === 239, '★ 受伤时护甲磨损 1 耐久',
    { helmet: st.armor.helmet.dur, chestplate: st.armor.chestplate.dur });

  // 错位拒绝：摘掉胸甲后，试着把它塞进头盔槽
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory[12]={id:'iron_chestplate',n:1,dur:240};window.zfsnMC.refreshInv();return true;})()`);
  const helmSlot = await slotPos('#armor-slots', 1);
  const chest = await slotPos('#slots', 4);
  await click(chest);                          // 左键拿起胸甲
  st = await ev(READ);
  check(st.held === 'iron_chestplate:1', '拿起胸甲', st.held);
  await click(helmSlot);                       // 塞进头盔槽 → 必须拒绝
  st = await ev(READ);
  // 头盔本来还穿在槽里 —— 拒绝的标志是「胸甲仍在手上、头盔槽没有被顶掉」
  check(st.held === 'iron_chestplate:1' && st.armor.helmet?.id === 'iron_helmet', '★ 头盔槽拒绝胸甲（部位校验）', { held: st.held, helmet: st.armor.helmet });
  await click(chest);                          // 放回原格
  // Shift 摘甲
  await click(helmSlot, 'left', 8);
  st = await ev(READ);
  check(st.armor.helmet === null && st.inv.includes('iron_helmet:1'), '★ Shift+点击已穿盔甲摘回背包', { helmet: st.armor.helmet });
  // 恢复：头盔穿回去，方便后面截图
  const helmBack = await slotPos('#slots', st.inv.findIndex((s) => s?.startsWith('iron_helmet')) - 8 + 1);
  if (helmBack) await click(helmBack, 'left', 8);

  /* ═══ D. 一键合成 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;
    w.craftGrid=[{id:'oak_log',n:4},null,null,null];
    w.inventory=w.inventory.map(s=>null);
    window.zfsnMC.refreshInv();return true;})()`);
  const out = await slotPos('#craft-result', 1);
  await click(out, 'left', 8);                 // Shift+点击产物 = 一键合成
  st = await ev(READ);
  const planks = st.inv.filter((s) => s?.startsWith('oak_planks')).reduce((n, s) => n + Number(s.split(':')[1]), 0);
  check(planks === 16 && st.inv.every((s, i) => !s?.startsWith('oak_log')), '★ 一键合成：4 根原木 → 16 块木板，材料扣光',
    { planks, log: st.inv.filter((s) => s?.startsWith('oak_log')) });
  await ev('(()=>{window.zfsnMC.world.craftGrid=[null,null,null,null];window.zfsnMC.refreshInv();return true;})()');
  await ev(`document.querySelector('#inventory-dialog .mc-panel.inv-panel').dispatchEvent(new Event('close'));true`).catch(() => {});
  await ev(`(()=>{const d=document.querySelector('#inventory-dialog');if(d.open)d.close();return !d.open;})()`); await sleep(250);

  /* ═══ E. 弓与箭 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;w.arrows=[];w.time=120;w.mobs.length=0;
    w.inventory=Array(36).fill(null);
    w.inventory[0]={id:'bow',n:1,dur:384};w.inventory[1]={id:'arrow',n:5};
    w.player.face=1;w.player.vx=0;window.zfsnMC.refreshInv();return true;})()`);
  const cv = await ev(`(()=>{const r=document.querySelector('#world').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height*.8};})()`);
  await mouse('mouseMoved', cv.x, cv.y, 'none', 0);
  await mouse('mousePressed', cv.x, cv.y);      // 按住左键 → 拉弓
  await sleep(400);
  st = await ev(READ);
  check(st.draw !== null && st.draw > 0.25, '★ 按住左键进入拉弓蓄力（t 累加）', st.draw);
  check(st.arrows === 0 && st.inv[1] === 'arrow:5', '蓄力中不发射也不耗箭', { arrows: st.arrows, arrow: st.inv[1] });
  await mouse('mouseReleased', cv.x, cv.y, 'left', 0);
  await sleep(150);
  st = await ev(READ);
  check(st.draw === null && st.arrows === 1, '★ 松开发射一支箭', { draw: st.draw, arrows: st.arrows });
  check(st.inv[1] === 'arrow:4', '★ 背包里少了一支箭', st.inv[1]);

  // 抛物线：往空中打一支（手动构造，绕开瞄准不确定性），采样轨迹
  const traj = await ev(`(async()=>{
    const w=window.zfsnMC.world;
    w.arrows.length=0;
    w.arrows.push({x:w.player.x+1,y:w.player.y+1.2,vx:12,vy:-6,ang:0,age:0,stuck:false,damage:6,dead:false});
    const path=[];
    for(let i=0;i<26;i++){await new Promise(r=>setTimeout(r,40));
      const a=w.arrows[0];if(!a)break;path.push(+a.y.toFixed(2));if(a.stuck)break;}
    return {path,arrows:w.arrows.map(a=>({y:+a.y.toFixed(2),stuck:a.stuck}))};})()`);
  const top = Math.min(...traj.path);
  check(traj.path.length > 5 && traj.path[0] > top && traj.path[traj.path.length - 1] > top + 0.2,
    '★ 箭沿抛物线飞行（先升后降）', traj.path.slice(0, 12));

  // 插方块 + 靠近拾取
  await sleep(400);
  st = await ev(READ);
  const stuckArrow = await ev(`(()=>{const w=window.zfsnMC.world;return w.arrows.map(a=>({stuck:a.stuck,x:+a.x.toFixed(2),y:+a.y.toFixed(2)}))[0]||null;})()`);
  check(stuckArrow && stuckArrow.stuck, '★ 箭插进方块保留原地', stuckArrow);
  await ev(`(()=>{const w=window.zfsnMC.world;const a=w.arrows[0];if(a){w.player.x=a.x-0.8;w.player.y=a.y-1;w.player.vy=0;}return true;})()`);
  await sleep(900);
  st = await ev(READ);
  check(st.arrows === 0 && st.inv.filter((s) => s?.startsWith('arrow')).reduce((n, s) => n + Number(s.split(':')[1]), 0) === 5,
    '★ 走近插在地上的箭自动拾回背包（又回到 5 支）', { arrows: st.arrows, inv: st.inv.filter((s) => s?.startsWith('arrow')) });

  // 命中生物：先削一块平台，保证箭的飞行路径上没有地形
  const mobHp = await ev(`(()=>{
    const w=window.zfsnMC.world;
    const x=Math.floor(w.player.x)+5,h=w.surface[x];
    for(let c=x-4;c<=x+4;c++){
      for(let dy=0;dy<5;dy++)w.set(c,h-1-dy,0);
      w.set(c,h,3);w.surface[c]=h;
    }
    const m=w.makeMob('pig',x,0);m.y=h-m.h;m.face=-1;m.health=10;
    w.mobs.length=0;w.mobs.push(m);
    w.player.x=x-3;w.player.y=h-w.player.h;w.player.vx=0;w.player.vy=0;w.player.face=1;
    w.arrows.length=0;
    // 从玩家胸口水平射出一支快箭
    w.arrows.push({x:w.player.x+1,y:h-m.h/2,vx:40,vy:0,ang:0,age:0,stuck:false,damage:6,dead:false});
    return {hp:m.health};})()`);
  await sleep(700);
  const afterHit = await ev(`(()=>{const w=window.zfsnMC.world;return {hp:w.mobs[0]?w.mobs[0].health:'gone',
    arrows:w.arrows.length};})()`);
  check(afterHit.hp === 'gone' || afterHit.hp < mobHp.hp, '★ 箭命中生物造成伤害（猪 10 血吃 6 点）', { before: mobHp.hp, after: afterHit.hp });
  check(afterHit.arrows === 0, '命中的箭消失（不会同时插在地上）', afterHit.arrows);

  /* ═══ F. 存档往返 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;
    w.player.armor={helmet:{id:'iron_helmet',n:1,dur:100},chestplate:{id:'iron_chestplate',n:1,dur:200},leggings:null,boots:null};
    w.arrows=[{x:w.player.x+2,y:w.player.y+1,vx:0,vy:0,ang:.7,age:3,stuck:true,damage:6,dead:false}];
    return true;})()`);
  const saved = await ev(`JSON.stringify(window.zfsnMC.world.serialize())`);
  await ev(`localStorage.setItem('zfsn.minecraft2d.v1', ${JSON.stringify(saved)})`);
  await cdp.send('Page.navigate', { url: PAGE }); await sleep(1600);
  await ev(`document.querySelector('#continue').click()`); await sleep(1600);
  st = await ev(READ);
  check(st.armor.helmet?.id === 'iron_helmet' && st.armor.helmet?.dur === 100 && st.armor.chestplate?.id === 'iron_chestplate',
    '★ 盔甲随存档往返（id+耐久）', st.armor);
  const sa = await ev(`(()=>{const a=window.zfsnMC.world.arrows[0];return a?{x:+a.x.toFixed(1),stuck:a.stuck,age:+a.age.toFixed(1)}:null;})()`);
  check(sa && sa.stuck === true && sa.age >= 3, '★ 插住的箭随存档往返', sa);

  await cdp.send('Page.navigate', { url: 'about:blank' });
  console.log('');
  if (problems.length) { console.log(`PROBLEMS (${problems.length}):`); problems.forEach((p) => console.log('  - ' + p)); process.exit(1); }
  console.log('ALL PASS');
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
