/* 堆叠上限：装备类（工具/盔甲/弓弩/盾/鞘翅…）必须是 1，
   其余保持原版（方块 64、空桶 16、水桶 1）。
   ★ 不能只抽查几个 id —— 装备是「按 id 模式」判定的，漏了 hoe、马铠、
     netherite 这些变体就会漏。这里对全部 ITEMS 做一遍全量扫描。
   ★ 还要验旧存档：上一版装备能叠 64，线上玩家手里可能有这种档，
     改成 1 之后必须「能读、截到上限」，绝不能抛错丢整档。 */
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
  const mouse = (type, x, y, button = 'none', buttons = 0) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 0 });
  const hover = async (x, y) => { await mouse('mouseMoved', 2, 2); await sleep(30); await mouse('mouseMoved', x, y); await sleep(80); };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);

  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-STACK';
    const m=document.querySelector('[name=mode][value=creative]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(1800);
  check(await ev(`window.zfsnMC?.playing === true`), '进入游戏（创造，方便取任意物品）');

  // ── 1. 数据层：全量扫描堆叠上限 ───────────────────────────────
  const scan = await ev(`(()=>{const it=window.zfsnMC.items,ids=Object.keys(it);
    const arm=ids.filter(i=>/_(helmet|chestplate|leggings|boots|horse_armor)$/.test(i));
    const tool=ids.filter(i=>/_(sword|axe|pickaxe|shovel|hoe)$/.test(i));
    const single=['bow','crossbow','trident','shield','elytra','fishing_rod','shears',
      'flint_and_steel','saddle','totem_of_undying','carrot_on_a_stick','warped_fungus_on_a_stick'];
    const bad=[...arm,...tool,...single.filter(id=>it[id])].filter(id=>it[id].stack!==1);
    return {total:ids.length,arm:arm.length,tool:tool.length,
      bad,
      stone:it['stone'].stack,log:it['oak_log'].stack,
      bucket:it['bucket'].stack,water:it['water_bucket'].stack,
      chest:it['diamond_chestplate'].stack,hoe:it['wooden_hoe'].stack,
      neth:it['netherite_sword'].stack,horse:it['iron_horse_armor'].stack,
      turtle:it['turtle_helmet'].stack,bowl:it['bowl'].stack,
      waxed:it['waxed_copper_block']?.stack};})()`);
  console.log('   ', JSON.stringify(scan));
  check(scan.arm > 25 && scan.tool > 20, '扫描到足量装备（不是空集假通过）', { 盔甲: scan.arm, 工具: scan.tool });
  check(scan.bad.length === 0, '所有装备的堆叠上限都是 1（含 hoe / 马铠 / 下界合金变体）', scan.bad);
  check(scan.chest === 1 && scan.hoe === 1 && scan.neth === 1 && scan.horse === 1 && scan.turtle === 1,
    '抽查盔甲 / 锄 / 下界合金剑 / 马铠 / 海龟壳都是 1', scan);
  check(scan.stone === 64 && scan.log === 64, '普通方块仍是 64', { stone: scan.stone, log: scan.log });
  check(scan.bucket === 16 && scan.water === 1, '空桶 16、水桶 1（原版）', { bucket: scan.bucket, water: scan.water });
  check(scan.bowl === 64, 'bowl 没被 category 误伤（catalog 把它分到了 equipment）', scan.bowl);
  check(scan.waxed === 64, 'waxed 铜块没被 category 误伤', scan.waxed);

  // ── 2. 运行时：add() 是否真的按上限分格 ───────────────────────
  const addTest = await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory=Array(36).fill(null);
    const rest=w.add('diamond_chestplate',5);
    const cells=w.inventory.map(s=>s?s.n:0);
    const used=w.inventory.filter(Boolean).length;
    w.inventory=Array(36).fill(null);
    w.add('stone',70);
    const stone=w.inventory.filter(Boolean).map(s=>s.n);
    return {rest,used,cells:cells.slice(0,8),stone};})()`);
  console.log('   ', JSON.stringify(addTest));
  check(addTest.rest === 0 && addTest.used === 5 && addTest.cells.slice(0, 5).every((n) => n === 1),
    'add 5 件胸甲 → 占 5 格、每格 1 个（不合并成一摞）', addTest);
  check(JSON.stringify(addTest.stone) === '[64,6]', 'add 70 石头 → 64 + 6，照常堆叠', addTest.stone);

  // 背包里已有同 id 装备时，再给一个必须另起一格（不能叠上去）
  const mergeTest = await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory=Array(36).fill(null);w.add('iron_helmet',1);
    w.add('iron_helmet',1);
    const used=w.inventory.filter(Boolean).length;
    const ns=w.inventory.filter(Boolean).map(s=>s.n);
    return {used,ns};})()`);
  check(mergeTest.used === 2 && mergeTest.ns.every((n) => n === 1),
    '再给一件同类头盔 → 另起一格，不会叠到已有格', mergeTest);

  // ── 3. /give 指令 ─────────────────────────────────────────────
  const give = await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory=Array(36).fill(null);
    window.zfsnMC.runCommand('give diamond_chestplate 5');
    return {used:w.inventory.filter(Boolean).length,ns:w.inventory.filter(Boolean).map(s=>s.n)};})()`);
  console.log('   ', JSON.stringify(give));
  check(give.used === 5 && give.ns.every((n) => n === 1), '/give 5 件胸甲 → 5 格各 1', give);

  const giveStone = await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory=Array(36).fill(null);
    window.zfsnMC.runCommand('give stone 70');
    return {ns:w.inventory.filter(Boolean).map(s=>s.n)};})()`);
  check(JSON.stringify(giveStone.ns) === '[64,6]', '/give 70 石头 → 64 + 6', giveStone.ns);

  // ── 4. 创造栏点装备 → 手上只有 1 个 ──────────────────────────
  await ev(`(async()=>{document.querySelector('#touch-inventory').click();
    await new Promise(r=>setTimeout(r,320));return true;})()`);
  await sleep(400);
  check(await ev(`document.querySelector('#inventory-dialog').open`), '创造栏已打开');

  // 走「搜索」tab 精确定位一件胸甲：分类分页要翻好几页才可能翻到，太脆。
  const pick = await ev(`(async()=>{
    const tabs=[...document.querySelectorAll('#creative-tabs-top button,#creative-tabs-bottom button')];
    const sTab=tabs.find(b=>b.dataset.tip==='搜索');
    if(!sTab)return {found:false,reason:'没有搜索标签'};
    sTab.click();await new Promise(r=>setTimeout(r,220));
    const s=document.querySelector('#creative-search');
    s.value='diamond_chestplate';s.dispatchEvent(new Event('input',{bubbles:true}));
    await new Promise(r=>setTimeout(r,240));
    const btn=[...document.querySelectorAll('#creative-grid button')]
      .find(b=>/diamond_chestplate/.test(b.querySelector('img')?.getAttribute('src')||''));
    if(!btn)return {found:false,reason:'搜索结果里没有胸甲',n:document.querySelectorAll('#creative-grid button:not(:disabled)').length};
    btn.click();await new Promise(r=>setTimeout(r,160));
    const h=window.zfsnMC.held;
    return {found:true,held:h?{id:h.id,n:h.n}:null};})()`);
  console.log('   ', JSON.stringify(pick));
  if (pick.found) {
    check(pick.held && pick.held.n === 1, '创造栏点一件胸甲 → 手上只有 1 个', pick.held);
  } else {
    check(false, '创造栏里没找到胸甲格子（无法验证取件数量）', pick);
  }

  // ── 5. 旧存档兼容：v4 档里存着 32 件胸甲 ─────────────────────
  const legacy = await ev(`(()=>{const C=window.zfsnMC.world.constructor;
    const d=JSON.parse(JSON.stringify(window.zfsnMC.world.serialize()));
    d.inventory=Array(36).fill(null);
    d.inventory[0]={id:'diamond_chestplate',n:32,dur:528};
    d.inventory[1]={id:'stone',n:64};
    try{const w=C.restore(d);
      const arm=w.inventory.filter(s=>s?.id==='diamond_chestplate');
      return {threw:false,armor:w.inventory[0]?{id:w.inventory[0].id,n:w.inventory[0].n,dur:w.inventory[0].dur}:null,
        total:arm.reduce((a,s)=>a+s.n,0),slots:arm.length,
        stone:w.inventory[1]?.n};}
    catch(e){return {threw:true,msg:String(e.message||e).slice(0,40)};}})()`);
  console.log('   ', JSON.stringify(legacy));
  check(legacy.threw === false, '旧存档里超量堆叠的装备不会让整档被拒（放宽校验）', legacy);
  check(legacy.armor && legacy.armor.n === 1 && legacy.armor.dur === 528,
    '超量格子被拆到上限（原格留 1 个，耐久保留）', legacy.armor);
  check(legacy.total === 32 && legacy.slots === 32,
    '32 件胸甲拆成 32 格，一件都没丢', { total: legacy.total, slots: legacy.slots });
  check(legacy.stone === 64, '同档里的普通方块不受影响', legacy.stone);

  // 真正非法的档仍然要拒（别把校验放得太松）
  const illegal = await ev(`(()=>{const C=window.zfsnMC.world.constructor;
    const mk=n=>{const d=JSON.parse(JSON.stringify(window.zfsnMC.world.serialize()));
      d.inventory=Array(36).fill(null);d.inventory[0]={id:'stone',n};return d;};
    const out={};
    try{C.restore(mk(99));out.tooMany=false;}catch(e){out.tooMany=true;}
    try{C.restore(mk(0));out.zero=false;}catch(e){out.zero=true;}
    return out;})()`);
  check(illegal.tooMany === true, '数量 99 仍然被拒绝（明显非法的档照样挡住）', illegal);
  check(illegal.zero === true, '数量 0 仍然被拒绝', illegal);

  // ── 6. 背包 UI：装备格不显示数量角标 ─────────────────────────
  await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory=Array(36).fill(null);
    w.inventory[9]={id:'diamond_chestplate',n:1,dur:528};
    w.inventory[10]={id:'diamond_chestplate',n:1,dur:528};
    w.inventory[11]={id:'stone',n:64};
    window.zfsnMC.refreshInv();return true;})()`);
  await sleep(200);
  const ui = await ev(`(()=>{const slots=[...document.querySelectorAll('#slots .slot')];
    const at=i=>{const b=slots.find(s=>Number(s.dataset.index)===i);
      return {count:b?.querySelector('.count')?.textContent||null,dur:!!b?.querySelector('.dur'),tip:b?.dataset.tip};};
    return {a:at(9),b:at(10),c:at(11)};})()`);
  console.log('   ', JSON.stringify(ui));
  check(ui.a.count === null && ui.a.dur === true, '胸甲格不显示数量角标（只显示耐久条）', ui.a);
  check(ui.b.count === null && ui.c.count === '64', '石头格显示 64，胸甲格不显示', { b: ui.b.count, c: ui.c.count });

  // 截图：切到「生存物品栏」标签，能直接看到两件胸甲各占一格、石头显示 64
  await ev(`(async()=>{const t=[...document.querySelectorAll('#creative-tabs-top button,#creative-tabs-bottom button')]
      .find(b=>b.dataset.tip==='生存物品栏');
    if(t){t.click();await new Promise(r=>setTimeout(r,280));}
    return true;})()`);
  await sleep(300);
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = require('node:fs'), path = require('node:path');
  fs.mkdirSync('.tmp-mc', { recursive: true });
  fs.writeFileSync(path.join('.tmp-mc', 'stack-inv.png'), Buffer.from(r.data, 'base64'));

  await cdp.send('Page.navigate', { url: 'about:blank' });

  console.log('');
  if (problems.length) {
    console.log(`问题（${problems.length}）:`);
    for (const p of problems) console.log('  - ' + p);
    process.exit(1);
  }
  console.log('PASS — 装备堆叠上限 / 分格 / 旧档兼容 全部通过');
  process.exit(0);
}

main().catch((e) => { console.error('探针异常:', e.message); process.exit(1); });
