/* 生物朝向 vs 移动方向：被攻击击退时「脸必须朝着自己实际移动的那一边」。
   背景：击退只改 vx（`mob.vx=(mob.x>p.x?1:-1)*6`），而 face 只在 AI 决策分支里更新，
   于是被推开的那 0.25 秒里模型朝玩家、人却被推远 —— 看起来就是「倒着走路」。
   本探针在页面内高频采样 vx / face / yaw，事后逐帧比对符号。 */
const PORT = process.env.CDP_PORT || 9301;
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const check = (ok, msg, detail) => {
  if (!ok) problems.push(msg + (detail !== undefined ? ` → 实际 ${JSON.stringify(detail)}` : ''));
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${msg}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
};

/** 把一只生物放到玩家旁边并朝指定方向站好，返回它的索引信息。
 *  ★ 先就地削一块 9 列同高的平台：`attack()` 带 3.5 格距离门禁 + `reachable()`
 *  视线射线，坡地上射线会被地形挡住、attack 直接返回 false，于是整组断言
 *  测的全是「没打中」——空断言通过的老套路。返回里带上 reach 便于自证。
 *  ★ 玩家一起挪到同一水平面（脚底 = 平台顶）。 */
const SETUP = (type, offset, face) => `(()=>{
  const w=window.zfsnMC.world, p=w.player, W=window.zfsnMC.W;
  w.mobs.length=0;
  const x=Math.max(8,Math.min(W-9,Math.floor(p.x)+(${offset})));
  const h=w.surface[x];
  for(let c=x-4;c<=x+4;c++){
    for(let dy=0;dy<5;dy++) w.set(c,h-1-dy,0);   // 清空上方
    w.set(c,h,3);                                 // 地表统一铺石头
    w.surface[c]=h;
  }
  const m=w.makeMob('${type}',x,0);
  m.y=h-m.h;
  m.face=${face}; m.yaw=${face}>0?0.95:-0.95; m.health=20;
  w.mobs.push(m);
  p.x=(${offset})>0?m.x-2.2:m.x+m.w+2.2;
  p.y=h-p.h; p.vx=0; p.vy=0;
  return {x:m.x,y:m.y,w:m.w,h:m.h,px:p.x,py:p.y,
    dist:+Math.hypot(m.x-p.x,m.y-p.y).toFixed(2),
    reach:w.reachable(Math.floor(m.x),Math.floor(m.y))};})()`;

/** 页面内采样：每 12ms 记一条，持续 ms 毫秒。 */
const START_LOG = (ms) => `(()=>{
  const w=window.zfsnMC.world, m=w.mobs[0];
  window.__mobLog=[];
  if(!m) return 'no-mob';
  const t0=performance.now();
  window.__mobTimer=setInterval(()=>{
    window.__mobLog.push({t:Math.round(performance.now()-t0),
      x:+m.x.toFixed(3), y:+m.y.toFixed(3), vx:+m.vx.toFixed(2),
      face:m.face, yaw:+m.yaw.toFixed(3), panic:+(m.panic||0).toFixed(2)});
    if(performance.now()-t0>${ms}) clearInterval(window.__mobTimer);
  },12);
  return true;})()`;

const STOP_LOG = `(()=>{clearInterval(window.__mobTimer);return window.__mobLog;})()`;

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
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-FACE';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`); await sleep(1800);
  check(await ev('window.zfsnMC.playing===true'), '进入游戏');

  // 关掉夜色与僵尸骚扰的干扰：固定在白天，且清空随机刷的怪
  await ev(`(()=>{const w=window.zfsnMC.world;w.time=120;w.mobs.length=0;return true;})()`);

  /* ── ① 猪在玩家右侧、面朝左（朝着玩家），一打就该被向右推 ── */
  const pos = await ev(SETUP('pig', 3, -1));
  check(pos && pos.x > 0, '猪已放在玩家右侧 3 格', pos);

  await ev(START_LOG(900));
  await sleep(60);
  const hit = await ev(`(()=>{const w=window.zfsnMC.world,m=w.mobs[0];
    w.attackCooldown=0;
    const before=m.health;
    const ok=w.attack(m.x+m.w/2,m.y+m.h/2);
    return {ok,damage:before-m.health,vx:m.vx,face:m.face,panic:m.panic};})()`);
  check(hit.ok === true, '攻击命中', hit);
  check(hit.vx > 0, '击退方向 = 远离玩家（向右，+x）', hit.vx);
  check(hit.face > 0, '★ 被击退的同一时刻脸也转向右边（不是原地朝左被推走）', hit.face);

  await sleep(950);
  const log = await ev(STOP_LOG);
  check(Array.isArray(log) && log.length > 20, '采到足够帧', log && log.length);

  // 逐帧：只要在动，脸就必须朝着运动方向
  const moving = log.filter((f) => Math.abs(f.vx) > 0.25);
  const backward = moving.filter((f) => Math.sign(f.vx) !== f.face);
  check(backward.length === 0, '★ 整段击退过程零「倒着走」的帧',
    backward.slice(0, 6).map((f) => `t=${f.t} vx=${f.vx} face=${f.face}`));
  check(moving.length > 3, '确实采到了运动帧（不是一直在原地不动）', moving.length);

  // 转身动画应当很快完成：yaw 在 250ms 内指向右边
  const turned = log.find((f) => f.t <= 260 && f.yaw > 0.5);
  check(!!turned, '转身动画在 250ms 内完成（yaw>0.5）',
    log.slice(0, 18).map((f) => `${f.t}:${f.yaw}`));

  // 被打后要真的跑开（原版 panic），而不是挨完打就原地站着
  const first = log[0], last = log[log.length - 1];
  check(last.x - first.x > 0.7, '★ 被打后朝远离玩家方向逃开（位移 >0.7 格）',
    { from: first.x, to: last.x, diff: +(last.x - first.x).toFixed(2) });
  const panicFrames = log.filter((f) => f.panic > 0).length;
  check(panicFrames > 0, '存在 panic 计时（逃跑状态是显式的，不是巧合）', panicFrames);

  /* ── ② 反向：猪在玩家左侧、面朝右，一打就被向左推 ── */
  const pos2 = await ev(SETUP('pig', -3, 1));
  await ev(START_LOG(600));
  await sleep(60);
  const hit2 = await ev(`(()=>{const w=window.zfsnMC.world,m=w.mobs[0];
    w.attackCooldown=0;const ok=w.attack(m.x+m.w/2,m.y+m.h/2);
    return {ok,vx:m.vx,face:m.face};})()`);
  await sleep(650);
  const log2 = await ev(STOP_LOG);
  check(hit2.ok === true, '反向攻击命中', hit2);
  check(hit2.vx < 0, '左侧的猪被向左推（−x）', hit2.vx);
  check(hit2.face < 0, '★ 同一时刻脸转向左边', hit2.face);
  const back2 = (log2 || []).filter((f) => Math.abs(f.vx) > 0.25 && Math.sign(f.vx) !== f.face);
  check(back2.length === 0, '反向同样零倒走帧', back2.slice(0, 4).map((f) => `t=${f.t} vx=${f.vx} face=${f.face}`));

  /* ── ③ 僵尸：被打退之后还得重新朝玩家追过来 ── */
  await ev(`(()=>{const w=window.zfsnMC.world;w.time=12000;return true;})()`);
  const zpos = await ev(SETUP('zombie', 4, -1));
  await ev(`(()=>{const w=window.zfsnMC.world,m=w.mobs[0];m.health=20;return true;})()`);
  await ev(START_LOG(1400));
  await sleep(60);
  const zhit = await ev(`(()=>{const w=window.zfsnMC.world,m=w.mobs[0];
    w.attackCooldown=0;w.attack(m.x+m.w/2,m.y+m.h/2);return {vx:m.vx,face:m.face};})()`);
  check(zhit.vx > 0 && zhit.face > 0, '僵尸被击退时脸朝击退方向', zhit);
  await sleep(1450);
  const zlog = await ev(STOP_LOG);
  const zback = (zlog || []).filter((f) => Math.abs(f.vx) > 0.25 && Math.sign(f.vx) !== f.face);
  check(zback.length === 0, '僵尸整段零倒走帧', zback.slice(0, 4).map((f) => `t=${f.t} vx=${f.vx} face=${f.face}`));
  const zchase = (zlog || []).filter((f) => f.t > 700 && f.vx < -0.5);
  check(zchase.length > 3, '被打退后僵尸重新朝玩家走来（vx<0）', zchase.length);

  /* ── ④ 撞墙：被推到墙上时不该来回翻面抖成筛子 ── */
  await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    w.mobs.length=0;
    const x=Math.floor(p.x)+2, h=w.surface[x];
    for(let c=x-4;c<=x+4;c++){
      for(let dy=0;dy<5;dy++) w.set(c,h-1-dy,0);
      w.set(c,h,3);
      w.surface[c]=h;
    }
    const m=w.makeMob('pig',x,0);
    m.y=h-m.h; m.face=-1; m.yaw=-0.95; m.health=20;
    w.mobs.push(m);
    p.x=m.x-2.2; p.y=h-p.h; p.vx=0; p.vy=0;
    // 在猪右侧堆一堵 3 格高的墙（它会被往右推，撞上就停）
    for(let dy=1;dy<=3;dy++)for(let dx=2;dx<=3;dx++)w.set(x+dx,h-dy,3);
    return true;})()`);
  await ev(START_LOG(900));
  await sleep(60);
  await ev(`(()=>{const w=window.zfsnMC.world,m=w.mobs[0];w.attackCooldown=0;
    w.attack(m.x+m.w/2,m.y+m.h/2);return true;})()`);
  await sleep(950);
  const wlog = await ev(STOP_LOG);
  const flipFrames = (wlog || []).filter((f) => f.x > 0 && Math.abs(f.vx) > 0.25 && Math.sign(f.vx) !== f.face);
  check(flipFrames.length === 0, '撞墙后也没有倒走帧', flipFrames.slice(0, 4).map((f) => `t=${f.t} vx=${f.vx} face=${f.face}`));
  const faces = [...new Set((wlog || []).map((f) => f.face))];
  check(faces.length <= 2, '撞墙后朝向不会反复横跳', faces);

  /* ── ⑤ 随机游走的动物：方向也必须与脸一致 ── */
  await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    w.mobs.length=0;
    const x=Math.floor(p.x)-5, h=w.surface[x];
    for(let c=x-4;c<=x+4;c++){
      for(let dy=0;dy<5;dy++) w.set(c,h-1-dy,0);
      w.set(c,h,3);
      w.surface[c]=h;
    }
    const m=w.makeMob('cow',x,0);
    m.y=h-m.h; m.face=1; m.yaw=0.95; m.health=20;
    // clock 压在 3 以下，AI 就不会重新随机方向；vx 手动给一个稳定值
    m.clock=0.1; m.vx=-0.7;
    w.mobs.push(m);
    p.x=m.x+9; p.vx=0; p.vy=0;   // 走开点，别挡住它
    return {x:m.x,y:m.y};})()`);
  await ev(START_LOG(2000));
  await sleep(2100);
  const rlog = await ev(STOP_LOG);
  const rback = (rlog || []).filter((f) => Math.abs(f.vx) > 0.25 && Math.sign(f.vx) !== f.face);
  check(rback.length === 0, '随机游走时零倒走帧', rback.slice(0, 4).map((f) => `t=${f.t} vx=${f.vx} face=${f.face}`));
  const rmove = (rlog || []).filter((f) => Math.abs(f.vx) > 0.25).length;
  check(rmove > 5, '随机游走确实动过（否则上面那条是空断言）', rmove);

  // 收尾：离开游戏页，别让 rAF 常驻把渲染进程占死
  await cdp.send('Page.navigate', { url: 'about:blank' });
  console.log('');
  if (problems.length) { console.log(`PROBLEMS (${problems.length}):`); problems.forEach((p) => console.log('  - ' + p)); process.exit(1); }
  console.log('ALL PASS');
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
