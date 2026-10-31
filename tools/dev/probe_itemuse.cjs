/* 探针：①箭矢发射不再「原地消失」（贴脸射墙 / 抬头射箭 / 正常飞行）
   ②物品使用：药水/牛奶/投掷物/唱片/时钟/指南针/盔甲/剪刀/原材料提示。 */
const PORT = process.env.CDP_PORT || 9301;
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
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
  await cdp.send('Page.navigate', { url: PAGE }); await sleep(1500);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE }); await sleep(1500);
  await ev(`document.querySelector('#play').click()`); await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-USE';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`); await sleep(2000);
  check(await ev('window.zfsnMC.playing===true'), '进入游戏');

  /* 平整石台，排除山坡干扰：x 20..90 / 顶面 y=40 */
  const PLATEAU = `(()=>{const w=window.zfsnMC.world,p=w.player;
    w.mobs.length=0;w.drops.length=0;w.arrows.length=0;
    for(let x=20;x<90;x++){for(let y=40;y<46;y++)w.set(x,y,3);for(let y=32;y<40;y++)w.set(x,y,0);}
    p.x=40;p.y=40-p.h;p.vx=0;p.vy=0;p.face=1;p.health=20;p.food=20;p.invuln=0;
    w.inventory=Array(36).fill(null);w.inventory[0]={id:'bow',n:1,dur:384};
    w.inventory[1]={id:'arrow',n:16};w.selected=0;
    return true;})()`;
  await ev(PLATEAU); await sleep(120);

  const POS = `(()=>{const w=window.zfsnMC.world,p=w.player;
    return {px:+p.x.toFixed(2),py:+p.y.toFixed(2),ox:+(p.x+p.w/2).toFixed(3),oy:+(p.y+p.h*.66).toFixed(3)};})()`;
  const pos0 = await ev(POS);

  /* ═══ A. 正常平射：必须真的飞出去、不会没 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;w.arrows.length=0;
    const p=w.player;w.shootBow(1,{x:p.x+20,y:p.y+p.h*.66});return true;})()`);
  let a = await ev(`(()=>{const w=window.zfsnMC.world;return w.arrows.map(x=>({x:+x.x.toFixed(2),y:+x.y.toFixed(2),vx:+x.vx.toFixed(1),vy:+x.vy.toFixed(1),stuck:x.stuck,kind:x.kind,tex:x.tex}));})()`);
  check(a.length === 1 && a[0].kind === 'arrow' && a[0].tex === 'arrow_projectile', '★ 平射：箭一发射就存在且带贴图', a);
  check(Math.abs(a[0].vy) < 6, '★ 平射不再是固定的上抛 vy=-5（改为朝光标方向）', a[0].vy);
  await sleep(300);
  a = await ev(`(()=>{const w=window.zfsnMC.world;return w.arrows.map(x=>({x:+x.x.toFixed(2),y:+x.y.toFixed(2),stuck:x.stuck}));})()`);
  check(a.length === 1 && a[0].x > pos0.ox + 6, '★ 300ms 后箭还在，且已经飞了 6 格以上', a);

  /* ═══ B. 抬头射：初速必须有向上分量 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;w.arrows.length=0;
    const p=w.player;w.shootBow(1,{x:p.x+6,y:p.y+p.h*.66-12});return true;})()`);
  a = await ev(`(()=>window.zfsnMC.world.arrows.map(x=>({vy:+x.vy.toFixed(2),vx:+x.vx.toFixed(2)})))()`);
  check(a.length === 1 && a[0].vy < -8, '★ 抬头瞄准时箭真的向上飞', a[0]);

  /* ═══ C. 贴脸射墙（原始 bug）：不能同一帧被吸回背包 ═══ */
  await ev(`(()=>{const w=window.zfsnMC.world;w.arrows.length=0;w.inventory[1]={id:'arrow',n:9};
    for(let y=38;y<40;y++)w.set(42,y,3);          // 玩家前方 2 格立一堵墙
    w.player.x=40;w.player.y=40-w.player.h;w.player.face=1;
    const p=w.player;w.shootBow(1,{x:43,y:p.y+p.h*.66});return true;})()`);
  await sleep(120);
  let c = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    return {n:w.arrows.length,stuck:w.arrows[0]?.stuck,x:w.arrows[0]&&+w.arrows[0].x.toFixed(2),
      arrows:w.inventory[1]?.n??0};})()`);
  check(c.n === 1, '★ 贴脸射墙：120ms 后箭仍在原地（不被自动拾取吞掉）', c);
  check(c.stuck === true, '箭插在墙面上（stuck）', { stuck: c.stuck, x: c.x });
  check(c.arrows === 8, '★ 箭矢数量只减 1（没有被同帧吸回背包）', c.arrows);

  /* ═══ D. 物品使用 ═══ */
  const USE = (id, extra = '') => `(()=>{const w=window.zfsnMC.world;
    w.inventory[0]=${extra ? `{id:'${id}',n:1,${extra}}` : `{id:'${id}',n:1}`};w.selected=0;
    return w.useItem({x:w.player.x+4,y:w.player.y+w.player.h*.66});})()`;

  // 药水
  await ev(`window.zfsnMC.world.player.health=8;true`);
  let msg = await ev(USE('potion'));
  let hp = await ev(`window.zfsnMC.world.player.health`);
  check(hp > 8 && /药水/.test(String(msg)), '★ 药水：右键喝下并回血', { hp, msg });

  // 牛奶
  await ev(`window.zfsnMC.world.player.health=15;true`);
  msg = await ev(USE('milk_bucket'));
  hp = await ev(`window.zfsnMC.world.player.health`);
  check(hp > 15 && /牛奶/.test(String(msg)), '牛奶：喝下回复生命', { hp, msg });

  // 蜂蜜
  await ev(`window.zfsnMC.world.player.food=6;true`);
  msg = await ev(USE('honey_bottle'));
  const food = await ev(`window.zfsnMC.world.player.food`);
  check(food > 6, '蜂蜜：补充饱食度', { food, msg });

  // 食物右键即吃（不需要按 F）
  await ev(`window.zfsnMC.world.player.food=8;true`);
  msg = await ev(USE('apple'));
  const food2 = await ev(`window.zfsnMC.world.player.food`);
  check(food2 > 8, '★ 食物：右键直接进食', { food2, msg });

  // 投掷物
  await ev(`(()=>{const w=window.zfsnMC.world;w.arrows.length=0;return true;})()`);
  msg = await ev(USE('snowball'));
  let th = await ev(`(()=>window.zfsnMC.world.arrows.map(x=>({kind:x.kind,tex:x.tex,pickup:x.pickup,v:+Math.hypot(x.vx,x.vy).toFixed(1)})))()`);
  check(th.length === 1 && th[0].kind === 'snowball' && th[0].pickup === false && th[0].v > 10,
    '★ 雪球：抛出成实体（不可拾取、带初速）', th);

  await ev(`(()=>{const w=window.zfsnMC.world;w.arrows.length=0;return true;})()`);
  await ev(USE('splash_potion'));
  th = await ev(`(()=>window.zfsnMC.world.arrows.map(x=>({kind:x.kind,splash:!!x.splash,dmg:x.damage})))()`);
  check(th.length === 1 && th[0].kind === 'splash_potion' && th[0].splash && th[0].dmg > 0,
    '★ 喷溅药水：带溅射伤害标记', th);

  // 末影珍珠：落地后传送
  await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;w.arrows.length=0;
    w.mobs.length=0;w.inventory[0]={id:'ender_pearl',n:4};w.selected=0;
    for(let y=38;y<40;y++)w.set(42,y,0);      // 拆掉 C 段立的墙，别让珍珠撞在它上面
    p.x=40;p.y=40-p.h;w.useItem({x:p.x+9,y:p.y+p.h*.5});return true;})()`);
  const beforePearl = await ev(`+window.zfsnMC.world.player.x.toFixed(2)`);
  await sleep(900);
  const afterPearl = await ev(`(()=>{const w=window.zfsnMC.world;return {x:+w.player.x.toFixed(2),n:w.arrows.length};})()`);
  check(afterPearl.x > beforePearl + 2, '★ 末影珍珠：命中后把玩家传送过去', { beforePearl, after: afterPearl });

  // 唱片 / 时钟 / 指南针 / 剪刀 / 盔甲 / 原材料
  msg = await ev(USE('music_disc_13'));
  check(/播放/.test(String(msg)), '唱片：返回播放提示', msg);
  msg = await ev(USE('clock'));
  check(/第 .* 天/.test(String(msg)), '时钟：报出天数与昼夜', msg);
  msg = await ev(USE('compass'));
  check(/出生点/.test(String(msg)), '指南针：报出生点方位', msg);

  await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    w.player.armor={helmet:null,chestplate:null,leggings:null,boots:null};
    w.inventory[0]={id:'iron_helmet',n:1,dur:165};w.selected=0;
    w.useItem({x:p.x+3,y:p.y+p.h*.5});return true;})()`);
  const helm = await ev(`window.zfsnMC.world.player.armor.helmet&&window.zfsnMC.world.player.armor.helmet.id`);
  check(helm === 'iron_helmet', '★ 盔甲：右键直接穿上', helm);

  // 剪刀剪羊毛
  const sheepSet = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;w.mobs.length=0;w.drops.length=0;
    p.x=40;p.y=40-p.h;
    const s=w.makeMob('sheep',p.x+1.4,0);s.y=40-s.h;s.health=8;w.mobs.push(s);
    w.inventory[0]={id:'shears',n:1,dur:238};w.selected=0;
    return {n:w.mobs.length,dx:+(s.x-p.x).toFixed(2),dy:+(s.y-p.y).toFixed(2)};})()`);
  await sleep(80);
  msg = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    return w.useItem({x:p.x+2,y:p.y+p.h*.5});})()`);
  const wool = await ev(`window.zfsnMC.world.drops.filter(d=>d.id==='white_wool').length`);
  check(wool > 0 && /羊毛/.test(String(msg)), '剪刀：对羊剪毛掉羊毛', { wool, msg, sheepSet });

  // 无功能物品的提示（不能静默）
  msg = await ev(USE('iron_ingot'));
  check(/合成材料/.test(String(msg)), '原材料：给出「用于合成」的提示而不是静默', msg);
  msg = await ev(USE('diamond_sword'));
  check(/左键/.test(String(msg)), '武器：提示左键使用', msg);

  // 未实现的刷怪蛋 / 桶类：必须给出准确提示而不是「放不下」
  msg = await ev(USE('creeper_spawn_egg'));
  check(/只实现了/.test(String(msg)), '未实现的刷怪蛋：提示支持范围', msg);
  msg = await ev(USE('bucket'));
  check(/装水/.test(String(msg)), '空桶：提示去水源装水', msg);
  // 已实现的刷怪蛋仍然走 place()（不能被新提示抢走）
  const eggSpawn = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;w.mobs.length=0;
    w.inventory[0]={id:'pig_spawn_egg',n:3};w.selected=0;
    const ok=w.place(Math.floor(p.x)+3,Math.floor(p.y+p.h)-1);
    return {ok,n:w.mobs.length,type:w.mobs[0]&&w.mobs[0].type};})()`);
  check(eggSpawn.ok === true && eggSpawn.type === 'pig', '★ 猪刷怪蛋仍能正常放置生物', eggSpawn);

  /* ═══ E. 真实右键走完整链路（place 失败 → useItem）═══ */
  await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    w.inventory[0]={id:'potion',n:2};w.selected=0;p.health=9;p.food=20;
    p.x=40;p.y=40-p.h;w.arrows.length=0;return true;})()`);
  const pt = await ev(`(()=>{const c=document.querySelector('#world');const r=c.getBoundingClientRect();
    return {x:Math.round(r.x+r.width*.5),y:Math.round(r.y+r.height*.32),vw:innerWidth,vh:innerHeight};})()`);
  const hitEl = await ev(`(()=>{const e=document.elementFromPoint(${pt.x},${pt.y});
    return e?e.id||e.tagName+'/'+e.className:null;})()`);
  check(hitEl === 'world', '右键落点在游戏画布 #world 上（不受 HUD 遮挡）', { pt, hitEl });
  const mouse = (type, button = 'none', buttons = 0) =>
    cdp.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button, buttons, clickCount: 1 });
  await mouse('mouseMoved'); await sleep(60);
  await mouse('mousePressed', 'right', 2); await sleep(60);
  await mouse('mouseReleased', 'right', 0); await sleep(300);
  const afterRC = await ev(`(()=>{const w=window.zfsnMC.world;return {hp:+w.player.health.toFixed(0),held:w.inventory[0]?w.inventory[0].n:0};})()`);
  check(afterRC.hp > 9 && afterRC.held === 1, '★ 真实右键：药水被喝掉（place 失败后走 useItem）', afterRC);

  /* ═══ F. 存档带上投掷物类型 ═══ */
  const ser = await ev(`(()=>{const w=window.zfsnMC.world;w.arrows.length=0;
    const p=w.player;w.throwItem('snowball',{speed:20,damage:0},null);
    const a=w.serialize().arrows[0];return {kind:a.kind,tex:a.tex,pickup:a.pickup};})()`);
  check(ser.kind === 'snowball' && ser.tex === 'snowball' && ser.pickup === false, '存档带上投掷物类型', ser);

  console.log(problems.length ? `\n❌ ${problems.length} 项未通过` : '\n✅ ALL PASS');
  process.exit(problems.length ? 1 : 0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
