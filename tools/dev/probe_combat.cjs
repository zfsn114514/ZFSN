/* 战斗系统浏览器实测（CDP 直连）
 * 验证点：
 *   1. HUD 新增元素（护甲条 / 经验条 / 冷却遮罩 / 战斗状态）真的渲染出来了
 *   2. 近战命中 → 伤害走管线、击退把生物推开、攻击冷却重置
 *   3. 攻击冷却遮罩随冷却推进而收缩
 *   4. 穿甲后伤害被减免、护甲条图标数量正确
 *   5. 盾牌正面挡住攻击（不掉血 + 提示），斧击触发冷却
 *   6. 饥饿/自然恢复在浏览器里按 tick 走
 *   7. F3 调试面板显示新的战斗字段
 */
const PORT = process.env.CDP_PORT || '9334';
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8899/minecraft/';
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
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });   // 别用旧模块
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(2200);

  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-COMBAT';
    const s=document.querySelector('[name=mode][value=survival]');if(s)s.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2600);
  check(await ev(`window.zfsnMC?.playing === true`), '进入游戏');
  check(await ev(`typeof window.zfsnMC?.world?.recalcArmor === 'function'`), '加载到新版 game.js（含 recalcArmor）');

  // ── 1. HUD 元素 ─────────────────────────────────────────────
  const hud = await ev(`(()=>{
    const q=s=>document.querySelector(s);
    return {
      armor: !!q('#armor'), xp: !!q('#xp-bar'), cd: !!q('#hotbar-cooldown'), status: !!q('#combat-status'),
      absorption: !!q('#absorption'),
      hudHidden: q('#hud')?.hidden,
    };
  })()`);
  check(hud.armor && hud.xp && hud.cd && hud.status && hud.absorption, 'HUD 新增元素都存在', hud);

  // ── 2. 近战：伤害 / 击退 / 冷却重置 ──────────────────────────
  const melee = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    w.mode='survival';
    w.mobs=[];w.drops=[];w.arrows=[];
    w.inventory.fill(null);
    w.inventory[0]={id:'diamond_sword',n:1};w.selected=0;p.lastHeldId='diamond_sword';
    p.health=20;p.food=20;p.saturation=5;p.exhaustion=0;
    p.armor={helmet:null,chestplate:null,leggings:null,boots:null};
    w.recalcArmor();
    p.ticksSinceLastAttack=99;p.ground=true;p.vy=0;
    // 找一个不卡在方块里的落点（玩家脚边 +1.2 格）
    let m=null;
    for(const dx of [1.2,1.6,2.0,-1.2,-1.6]){
      const c=w.makeMob('zombie',p.x+dx,p.y);
      if(!w.collides(c)){m=c;break;}
    }
    if(!m)return {error:'no spot'};
    m.ground=true;w.mobs.push(m);
    const before=m.health;
    const hit=w.attack(m.x+m.w/2,m.y+m.h/2);
    return {hit,before,after:m.health,vx:+m.vx.toFixed(3),face:m.face,ticks:p.ticksSinceLastAttack};
  })()`);
  check(melee.hit === true, '攻击命中生物', melee);
  check(melee.before - melee.after === 7, '钻石剑满强度打 7 点', melee);
  check(melee.vx > 0, '命中后生物被推开（击退方向朝远离玩家）', melee);
  check(melee.face === 1, '生物转身面向被推的方向', melee);
  check(melee.ticks === 0, '攻击后攻击冷却清零', melee);

  // ── 3. 冷却遮罩会随冷却推进收缩 ────────────────────────────
  // 冷却遮罩由主循环每帧刷新，所以两次取值之间要等一帧
  // 冷却遮罩由主循环每帧刷新，所以连续采样看它是否单调变矮并最终消失
  await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;p.ticksSinceLastAttack=0;return true;})()`);
  const samples = [];
  for (let i = 0; i < 8; i++) {
    await sleep(60);
    samples.push(await ev(`(()=>{const el=document.querySelector('#hotbar-cooldown');return {hidden:el.hidden,h:parseFloat(el.style.height)||0};})()`));
  }
  const heights = samples.map((s) => s.h);
  const shrinking = heights.every((h, i) => i === 0 || h <= heights[i - 1] + 0.01);
  check(!samples[0].hidden && samples[0].h > 0, '冷却中显示冷却遮罩', samples[0]);
  check(shrinking, '冷却遮罩随冷却推进单调变矮', heights);
  check(samples[samples.length - 1].hidden, '冷却结束后遮罩消失', samples[samples.length - 1]);

  // ── 4. 护甲减伤 + 护甲条 ────────────────────────────────────
  const armor = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    p.armor={helmet:{id:'diamond_helmet',n:1,dur:363},chestplate:{id:'diamond_chestplate',n:1,dur:528},
      leggings:{id:'diamond_leggings',n:1,dur:495},boots:{id:'diamond_boots',n:1,dur:429}};
    w.recalcArmor();
    const points=p.armorPoints,tough=p.armorToughness;
    p.health=20;p.invulnerableTicks=0;p.lastDamage=0;
    w.damage(10,'测试',{type:'melee',attackerX:p.x+1});
    const loss=20-p.health;
    document.querySelector('#hud').hidden=false;
    window.zfsnMC.refreshInv();
    return {points,tough,loss,icons:document.querySelectorAll('#armor i').length};
  })()`);
  check(armor.points === 20 && armor.tough === 8, '钻石全套 → 20 点护甲 / 8 韧性', armor);
  check(armor.loss > 0 && armor.loss < 10, '穿甲后 10 点伤害被减免', armor);
  await sleep(400);
  const icons = await ev(`document.querySelectorAll('#armor i').length`);
  check(icons === 10, '护甲条显示 10 个图标（20 点 / 每格 2 点）', { icons });

  // ── 5. 盾牌 ─────────────────────────────────────────────────
  const shield = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    p.health=20;p.invulnerableTicks=0;p.lastDamage=0;p.face=1;p.shieldRaised=true;p.shieldTicks=6;p.shieldCooldown=0;
    w.damage(6,'僵尸',{type:'melee',attackerX:p.x+1});
    const front=p.health;
    p.health=20;p.invulnerableTicks=0;p.lastDamage=0;p.face=1;p.shieldRaised=true;p.shieldTicks=6;
    w.damage(6,'僵尸',{type:'melee',attackerX:p.x+1,weaponIsAxe:true});
    return {front,back:p.health,cooldown:p.shieldCooldown};
  })()`);
  check(shield.front === 20, '正面举盾挡住近战（不掉血）', shield);
  check(shield.cooldown === 100, '斧击盾 → 100 tick 冷却', shield);

  // ── 6. 饥饿 / 自然恢复 ──────────────────────────────────────
  const hunger = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    w.mobs=[];                       // 清场：僵尸接触攻击会干扰掉血测量
    p.invulnerableTicks=0;p.lastDamage=0;
    p.health=10;p.food=18;p.saturation=0;p.exhaustion=0;
    for(let i=0;i<80;i++)w.tick({});
    const regen=p.health;
    p.invulnerableTicks=0;p.lastDamage=0;
    p.food=0;p.saturation=0;
    for(let i=0;i<80;i++)w.tick({});
    return {regen,starved:p.health};
  })()`);
  check(hunger.regen === 11, '饥饿≥18 每 80 tick 回 1 点', hunger);
  check(hunger.starved === 10, '饥饿=0 每 80 tick 掉 1 点', hunger);

  // ── 7. F3 调试面板（用真实按键事件） ───────────────────────
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'F3', key: 'F3', windowsVirtualKeyCode: 114 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'F3', key: 'F3', windowsVirtualKeyCode: 114 });
  await sleep(400);
  const dbg = await ev(`(()=>{const t=document.querySelector('#debug').textContent;return {text:t,hidden:document.querySelector('#debug').hidden};})()`);
  check(!dbg.hidden, 'F3 调试面板已打开', dbg);
  check(/生命/.test(dbg.text) && /攻击强度/.test(dbg.text) && /难度/.test(dbg.text), '调试面板含生命/攻击强度/难度等战斗字段', { text: dbg.text.slice(0, 220) });

  // ── 8. 挥空也重置攻击冷却 ───────────────────────────────────
  const swing = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    w.mobs=[];p.ticksSinceLastAttack=99;
    for(let i=0;i<2;i++)w.tick({});
    const before=p.ticksSinceLastAttack;
    w.attack(p.x+9,p.y-6);          // 点空气
    return {before,after:p.ticksSinceLastAttack};
  })()`);
  check(swing.after === 0, '挥空也把攻击冷却清零', swing);

  // ── 9. 横扫：主目标周围水平 1 格内的生物受 1 点伤害 ─────────
  const sweep = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    w.mobs=[];w.drops=[];
    w.inventory.fill(null);w.inventory[0]={id:'diamond_sword',n:1};w.selected=0;p.lastHeldId='diamond_sword';
    p.health=20;p.ground=true;p.vy=0;p.ticksSinceLastAttack=99;
    for(let i=0;i<2;i++)w.tick({});
    const mk=(type,dx)=>{const m=w.makeMob(type,p.x+dx,p.y);m.y=p.y+p.h-m.h;m.ground=true;w.mobs.push(m);return m;};
    const main=mk('zombie',1.2), side=mk('pig',2.0), far=mk('pig',5.0);
    const beforeSide=side.health,beforeFar=far.health;
    w.attack(main.x+main.w/2,main.y+main.h/2);
    return {side:beforeSide-side.health,far:beforeFar-far.health};
  })()`);
  check(sweep.side === 1, '横扫命中 1 格内的生物 → 1 点伤害', sweep);
  check(sweep.far === 0, '横扫够不到 1 格外的生物', sweep);

  // ── 10. 僵尸接触伤害按难度 2/3/4 ───────────────────────────
  const zombie = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    const out={};
    p.armor={helmet:null,chestplate:null,leggings:null,boots:null};   // 脱甲，测的是基础伤害
    w.recalcArmor();
    for(const d of ['easy','normal','hard']){
      w.mobs=[];w.difficulty=d;p.health=20;p.invulnerableTicks=0;p.lastDamage=0;p.vx=0;
      const z=w.makeMob('zombie',p.x+0.3,p.y);z.y=p.y+p.h-z.h;z.ground=true;w.mobs.push(z);
      w.tick({});
      out[d]=+(20-p.health).toFixed(2);
    }
    w.difficulty='normal';
    return out;
  })()`);
  check(zombie.easy === 2 && zombie.normal === 3 && zombie.hard === 4, '僵尸近战伤害 简单2/普通3/困难4', zombie);

  // ── 11. 生物死亡 20 tick 倒地后才消失并掉落 ────────────────
  const death = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    w.mobs=[];w.drops=[];
    const m=w.makeMob('zombie',p.x+1.2,p.y);m.y=p.y+p.h-m.h;m.ground=true;w.mobs.push(m);
    m.health=0;w.killMob(m);
    const dying=m.dying,stillThere=w.mobs.includes(m),dropsNow=w.drops.length;
    for(let i=0;i<21;i++)w.tick({});
    return {dying,stillThere,dropsNow,gone:!w.mobs.includes(m),drops:w.drops.map(d=>d.id)};
  })()`);
  check(death.dying === true && death.stillThere === true, '死亡后进入倒地动画并留在场上', death);
  check(death.dropsNow === 0, '倒地期间不掉落', death);
  check(death.gone === true && death.drops.includes('rotten_flesh'), '20 tick 后消失并掉落腐肉', death);

  // ── 12. 截图 ─────────────────────────────────────────────────
  await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    w.mobs=[];w.drops=[];
    p.health=14;p.food=12;p.absorption=4;p.level=2;p.xp=13;
    p.armor={helmet:{id:'diamond_helmet',n:1,dur:363},chestplate:{id:'diamond_chestplate',n:1,dur:528},leggings:null,boots:null};
    w.recalcArmor();window.zfsnMC.refreshInv();return true;})()`);
  await sleep(600);
  await shot('combat-hud.png');
  console.log('   截图 → .tmp-mc/combat-hud.png');

  console.log(problems.length ? `\n共 ${problems.length} 个问题：\n - ` + problems.join('\n - ') : '\n全部通过 ✓');
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error('探针异常：', e.message); process.exit(2); });
