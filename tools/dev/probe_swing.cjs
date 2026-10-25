/* 挥手动画 + 手上物品显示实测。
   要验证的东西：
   1. 手上物品真的画出来了（drawEntity 多出一个 sprite 面）
   2. 挖掘时手臂角度跟着变（连续循环）
   3. 放置 / 攻击触发一次性挥臂
   4. 模型动的是「朝镜头那条手臂」（x=-6），不是被身体挡住那条
   ★ 位置判断不能只靠截图肉眼看，要用 entityMesh 的角度数值 + drawEntity 的返回面数。 */
const PORT = process.env.CDP_PORT || '9401';
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.resolve(__dirname, '../../.tmp-mc');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, msg, detail) => {
  if (!ok) problems.push(msg + (detail !== undefined ? ` → 实际 ${JSON.stringify(detail)}` : ''));
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${msg}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

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
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed');
    return r.result.value;
  };
  const mouse = (type, x, y, button = 'left', buttons = 0) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!r.data) throw new Error('截图失败');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  };
  // 放大看手部细节：CDP 的 clip+scale 直接出放大图，不用装图像库
  const zoom = async (name, cx, cy, size = 110, scale = 6) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png',
      clip: { x: Math.max(0, cx - size / 2), y: Math.max(0, cy - size / 2), width: size, height: size, scale } });
    if (!r.data) throw new Error('放大截图失败');
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  };
  const playerScreen = () => ev(`(()=>{const p=window.zfsnMC.world.player;
    return window.zfsnMC.screenOf(p.x+p.w/2,p.y+p.h/2);})()`);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);

  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-SWING';
    // ★ 必须用生存模式：创造模式挖方块只要 0.12 秒，探针还没取样就已经挖穿、
    //   world.mining 被置回 null，看起来像「鼠标没生效」。
    const s=document.querySelector('[name=mode][value=survival]');if(s)s.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2200);
  check(await ev(`window.zfsnMC?.playing === true`), '进入游戏（生存模式，挖掘有耗时）');

  // 手上塞一把木镐
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory.fill(null);
    w.inventory[0]={id:'wooden_pickaxe',n:1};w.inventory[1]={id:'oak_planks',n:64};
    w.selected=0;window.zfsnMC.refreshInv();return true;})()`);
  await sleep(250);
  check(await ev(`window.zfsnMC.world.held()?.id === 'wooden_pickaxe'`), '手里拿着木镐', await ev(`window.zfsnMC.world.held()`));

  // ── 1. 模型：动的必须是朝镜头那条手臂 ──
  // 真正的约束不是「角度等于某个硬编码数字」，而是「模型上的手臂角度
  // 必须与 steveArmAngle 的计算完全一致」——物品挂的是同一个函数，
  // 一旦两边算歪，挥手时物品就会跟手脱开。
  const armInfo = await ev(`(()=>{
    const arm=(parts)=>parts.find(b=>Math.round(b.center[0])===-6&&Math.round(b.size[1])===12)?.angle;
    const mc=window.zfsnMC;
    const rows=[null,0,.25,.5,.75].map(t=>({t,
      mesh:+arm(mc.entityMesh('steve',0,0,t)).toFixed(4),
      fn:+mc.steveArmAngle(0,0,t).toFixed(4)}));
    return {rows,
      rest:+mc.steveArmAngle(0,0,null).toFixed(3),
      peak:Math.min(...rows.map(r=>r.mesh)),
      zombieArm:+arm(mc.entityMesh('zombie',0,0,null)).toFixed(3),
      hand0:mc.steveHand(mc.steveArmAngle(0,0,null)),
      handUp:mc.steveHand(mc.steveArmAngle(0,0,.5))};})()`);
  check(armInfo.rows.every(r => Math.abs(r.mesh - r.fn) < 1e-3),
    '模型手臂角度与 steveArmAngle 处处一致（物品挂在同一函数上，不会脱手）',
    armInfo.rows.map(r => [r.t, r.mesh, r.fn]));
  check(armInfo.rest < 0 && armInfo.rest > -.6, '静止时手臂略微前倾（不是死垂着，物品才不会贴在大腿上）', armInfo.rest);
  check(armInfo.peak < -1.5, '挥到最高点手臂抬起超过 1.5 rad', armInfo.peak);
  check(armInfo.zombieArm === -1.35, '僵尸手臂仍是固定平举（没被挥手逻辑带跑）', armInfo.zombieArm);
  check(armInfo.hand0.z > 2, '静止时手已经往前伸一点（z>2）', armInfo.hand0);
  check(armInfo.handUp.z > 10, '抬起后手往前伸到 z>10', armInfo.handUp);

  // ── 2. 手上物品真的画出来了：drawEntity 多一个 sprite 面 ──
  const faceCounts = await ev(`(()=>{
    const mc=window.zfsnMC;
    const c=document.createElement('canvas');c.width=200;c.height=200;
    const g=c.getContext('2d');
    const plain=mc.drawEntity(g,mc.images,{type:'steve'},0,100,180,80,.95);
    const withItem=mc.drawEntity(g,mc.images,{type:'steve'},0,100,180,80,.95,
      {img:mc.images['wooden_pickaxe'],swing:null});
    const emptyHand=mc.drawEntity(g,mc.images,{type:'steve'},0,100,180,80,.95,
      {img:null,swing:null});
    return {plain,withItem,emptyHand};})()`);
  check(faceCounts.withItem === faceCounts.plain + 1, '手上有物品时多画一个面（物品贴图）', faceCounts);
  check(faceCounts.emptyHand === faceCounts.plain, '空手不多画面', faceCounts.emptyHand);

  // ── 3. 挖掘：真实鼠标按住 → 挥臂相位在推进 ──
  const target = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    // ★ 不能取 floor(p.y+p.h)：那是玩家「脚底所在的那一格」，也就是空气。
    //   地面方块是 surface[x]。第一次就是取了空气，world.mine 里 get()===0 直接 return，
    //   于是 mining 一直是 null —— 看起来像鼠标没生效，其实是根本没东西可挖。
    const bx=Math.floor(p.x+p.w)+1,by=w.surface[bx];
    return {bx,by,s:window.zfsnMC.screenOf(bx+.5,by+.5),block:w.get(bx,by),
      reach:w.reachable(bx,by),feet:[+p.y.toFixed(2),+(p.y+p.h).toFixed(2)],surface:by};})()`);
  console.log('      目标格诊断: ' + JSON.stringify(target));
  await shot('swing-idle.png');
  {const c=await playerScreen();await zoom('zoom-idle.png',c.x,c.y);}
  await mouse('mouseMoved', target.s.x, target.s.y, 'none', 0);
  await sleep(60);
  // 记录 canvas 到底有没有收到指针事件（收不到就是被别的元素挡住了）
  await ev(`(()=>{window.__dbg={down:0,up:0,top:(document.elementFromPoint(${target.s.x},${target.s.y})||{}).id||'(no-id)'};
    document.querySelector('canvas').addEventListener('pointerdown',()=>window.__dbg.down++);
    return true;})()`);
  await mouse('mousePressed', target.s.x, target.s.y, 'left', 1);
  await sleep(150);
  const mining1 = await ev(`(()=>{const w=window.zfsnMC.world;
    return {mining:!!w.mining,swingT:w.mining?.swingT??null,target:w.mining?[w.mining.x,w.mining.y]:null,dbg:window.__dbg};})()`);
  await shot('swing-mine1.png');
  {const c=await playerScreen();await zoom('zoom-mine1.png',c.x,c.y);}
  await sleep(220);
  const mining2 = await ev(`(()=>{const w=window.zfsnMC.world;
    return {swingT:w.mining?.swingT??null};})()`);
  await shot('swing-mine2.png');
  {const c=await playerScreen();await zoom('zoom-mine2.png',c.x,c.y);}
  check(mining1.mining === true, '按住鼠标真的在挖方块', mining1);
  check(mining2.swingT !== null && mining2.swingT > mining1.swingT, '挖掘时挥臂相位在推进', {a: mining1.swingT, b: mining2.swingT});
  await mouse('mouseReleased', target.s.x, target.s.y, 'left', 0);
  await sleep(120);

  // ── 4. 放置：右键 → 一次性挥臂 ──
  const placeAt = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    w.selected=1;   // oak_planks
    // 找一个能放的空中格：贴着玩家脚下的地面
    for(let bx=Math.floor(p.x)+3;bx<Math.floor(p.x)+9;bx++){
      const by=w.surface[bx]-1;
      if(w.get(bx,by)===0)return {bx,by,s:window.zfsnMC.screenOf(bx+.5,by+.5)};
    }
    return null;})()`);
  check(!!placeAt, '找到可放置的格子', placeAt);
  if (placeAt) {
    await mouse('mousePressed', placeAt.s.x, placeAt.s.y, 'right', 2);
    await mouse('mouseReleased', placeAt.s.x, placeAt.s.y, 'right', 0);
    await sleep(40);
    const sw = await ev(`(()=>{const p=window.zfsnMC.world.player;return {swing:+p.swing.toFixed(3),dur:p.swingDur};})()`);
    await shot('swing-place.png');
    {const c=await playerScreen();await zoom('zoom-place.png',c.x,c.y);}
    check(sw.swing > 0, '放置方块后手臂开始挥', sw);
    await ev(`(()=>{window.zfsnMC.world.player.swing=0;return true;})()`);
  }

  // ── 5. 攻击：造一只贴脸僵尸 → 左键 → 一次性挥臂 ──
  const atk = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    const m=w.makeMob('zombie',p.x+p.w+.5,p.y);
    w.mobs.push(m);
    return {x:m.x,y:m.y,s:window.zfsnMC.screenOf(m.x+m.w/2,m.y+m.h/2)};})()`);
  await mouse('mouseMoved', atk.s.x, atk.s.y, 'none', 0);
  await sleep(60);
  await mouse('mousePressed', atk.s.x, atk.s.y, 'left', 1);
  await sleep(50);
  const atkSwing = await ev(`(()=>{const p=window.zfsnMC.world.player;return {swing:+p.swing.toFixed(3),hit:window.zfsnMC.world.attackCooldown>0};})()`);
  await shot('swing-attack.png');
  {const c=await playerScreen();await zoom('zoom-attack.png',c.x,c.y);}
  await mouse('mouseReleased', atk.s.x, atk.s.y, 'left', 0);
  check(atkSwing.swing > 0, '攻击时手臂开始挥', atkSwing);

  // ── 6. 空手：不该画出物品，但仍可挥 ──
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory[0]=null;w.selected=0;window.zfsnMC.refreshInv();return true;})()`);
  await sleep(200);
  const emptyHold = await ev(`(()=>{const w=window.zfsnMC.world;
    return {id:w.held()?.id??null,img:!!(w.held()&&window.zfsnMC.images[w.held().id])};})()`);
  check(emptyHold.id === null, '空手时 held 为 null（不会画出上一件物品）', emptyHold);

  console.log(`\n=== 问题 (${problems.length}) ===`);
  for (const p of problems) console.log('  - ' + p);
  if (!problems.length) console.log('PASS — 挥手动画 / 手上物品全部通过'); else console.log('FAIL');
  ws.close();
  process.exit(problems.length ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
