/* 背包交互实测：格子不重叠 + 真实鼠标点击拿起/放下 + 2×2 手动合成
 *
 * 为什么必须用 Input.dispatchMouseEvent 而不是 el.click()：
 * 之前的 bug 是 27 个格子全叠在容器左上角，el.click() 直接调 onclick 依然能"过"，
 * 只有真实坐标点击才能暴露「点哪都命中同一格」。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.CDP_PORT || 9401);
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const OUT = path.resolve(__dirname, '../../.tmp-mc');
const problems = [];

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej);
});

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  return {
    ready: new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    onMessage() {
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
          const { resolve, reject } = pending.get(m.id);
          pending.delete(m.id);
          m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        }
      });
    },
    close() { ws.close(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, name, actual) => {
  console.log(`   ${ok ? 'PASS' : 'FAIL'} ${name}  ${actual === undefined ? '' : JSON.stringify(actual)}`);
  if (!ok) problems.push(name);
};

async function main() {
  const targets = await get('/json/list');
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面目标');
  const cdp = connect(page.webSocketDebuggerUrl);
  cdp.onMessage();
  await cdp.ready;

  const ev = async (expr, awaitPromise = true) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed');
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  };

  let dialogTimer = null;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  dialogTimer = setInterval(() => cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}), 400);

  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1600);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);

  // 真实鼠标点击（视口坐标）
  const clickAt = async (x, y) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(120);
  };
  // 点击某个选择器命中的元素中心
  const clickSel = async (sel, idx = 0) => {
    const box = await ev(`(()=>{const n=document.querySelectorAll(${JSON.stringify(sel)})[${idx}];
      if(!n)return null;const r=n.getBoundingClientRect();
      return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};})()`);
    if (!box) throw new Error(`找不到 ${sel}[${idx}]`);
    await clickAt(box.x, box.y);
    return box;
  };

  // 原版规则：手上拿着东西时取不了产物。合成格每格只放 1 个，点完还剩一叠在手上，
  // 所以取产物前必须先把手上那叠放回背包（找一个空格点一下）。
  const stowHeld = async () => {
    const held = await ev(`(()=>{const h=window.zfsnMC.held;return h?{id:h.id,n:h.n}:null;})()`);
    if (!held) return null;
    const free = await ev(`(()=>{const w=window.zfsnMC.world;
      for(let i=0;i<36;i++)if(!w.inventory[i])return i;return -1;})()`);
    if (free < 0) return held;
    if (free < 9) await clickSel('#inv-hotbar .slot', free);
    else await clickSel('#slots .slot', free - 9);
    return held;
  };

  // 进入游戏（生存模式，固定种子便于复现）
  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{const s=document.querySelector('#seed');s.value='ZFSN-INV';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2000);
  const entered = await ev(`(()=>({playing:!!window.zfsnMC?.playing,mode:window.zfsnMC?.world?.mode}))()`);
  check(entered.playing === true, '进入游戏', entered);
  await shot('inv-0-ingame.png');

  // 塞点材料，便于验证合成
  await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory[9]={id:'oak_log',n:3};
    w.inventory[10]={id:'stone',n:12};
    w.inventory[0]={id:'wooden_pickaxe',n:1,dur:40};
    return true;})()`);

  // 打开背包（背包的开关键绑在 #touch-inventory 上，桌面端元素在但不可见）
  await ev(`(async()=>{document.querySelector('#touch-inventory').click();
    await new Promise(r=>setTimeout(r,300));return true;})()`);
  await sleep(400);
  const opened = await ev(`(()=>{const d=document.querySelector('#inventory-dialog');return d?d.open:false;})()`);
  check(opened === true, '背包能打开', opened);

  // ── 格子几何：必须互不重叠 ────────────────────────────────────
  const geom = await ev(`(()=>{
    const read=(sel)=>[...document.querySelectorAll(sel)].map(n=>{const r=n.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};});
    // 注意要选 .slot 本身：#slots 是容器，选它会得到 1 个元素，断言会假通过
    const slots=read('#slots .slot'),hot=read('#inv-hotbar .slot'),grid=read('#craft-grid .slot');
    const overlap=(list)=>{let n=0;
      for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
        const a=list[i],b=list[j];
        // 允许 1px 取整误差：缩放后 rect 取整会让相邻格边界差 1px，不是真重叠。
        // 真正的 bug（全叠在左上角）是 27 格两两重叠，数量级完全不同。
        if(a.x<b.x+b.w-1&&b.x<a.x+a.w-1&&a.y<b.y+b.h-1&&b.y<a.y+a.h-1)n++;
      } return n;};
    const cols=(list)=>new Set(list.map(r=>r.x)).size;
    const rows=(list)=>new Set(list.map(r=>r.y)).size;
    const p=document.querySelector('.inv-panel');
    return {slotN:slots.length,slotOverlap:overlap(slots),slotCols:cols(slots),slotRows:rows(slots),
            slotSize:slots[0]?[slots[0].w,slots[0].h]:null,
            hotN:hot.length,hotOverlap:overlap(hot),hotCols:cols(hot),
            hotRowAligned:hot.every(r=>r.y===hot[0].y),
            gridN:grid.length,gridOverlap:overlap(grid),gridCols:cols(grid),gridRows:rows(grid),
            recipeHidden:document.querySelector('.recipe-panel')?.hidden,
            invW:p.offsetWidth,invH:p.offsetHeight};
  })()`);
  console.log('   ', JSON.stringify(geom));
  check(geom.slotN === 27, '物品栏 27 格都在', geom.slotN);
  check(geom.slotOverlap === 0, '★ 27 个物品格互不重叠（之前的 bug 就是全部叠在左上角）', geom.slotOverlap);
  check(geom.slotCols === 9 && geom.slotRows === 3, '物品栏排成 9 列 × 3 行', [geom.slotCols, geom.slotRows]);
  check(geom.hotOverlap === 0, '快捷栏 9 格互不重叠', geom.hotOverlap);
  check(geom.gridOverlap === 0, '2×2 合成格互不重叠', geom.gridOverlap);
  check(geom.gridCols === 2 && geom.gridRows === 2, '合成格是 2×2', [geom.gridCols, geom.gridRows]);
  check(geom.recipeHidden === true, '生存模式不显示配方书面板（纯原版背包）', geom.recipeHidden);
  check(geom.invW === 352 && geom.invH === 332, '背包就是原版 176×166 的 2 倍', [geom.invW, geom.invH]);

  // ── 真实点击：拿起 → 放下 ────────────────────────────────────
  await clickSel('#slots .slot', 0);   // 第 1 格（原木）
  const afterPick = await ev(`(()=>{const t=document.querySelector('#slot-description').textContent;
    return {text:t, firstSlotEmpty:!window.zfsnMC.world.inventory[9]};})()`);
  console.log('   ', JSON.stringify(afterPick));
  check(/已拿起/.test(afterPick.text || ''), '★ 点物品能拿起来（提示显示已拿起）', afterPick.text);

  await clickSel('#slots .slot', 4);   // 放到第 5 格
  const afterDrop = await ev(`(()=>{const w=window.zfsnMC.world;
    return {from:w.inventory[9],to:w.inventory[13],
            text:document.querySelector('#slot-description').textContent};})()`);
  console.log('   ', JSON.stringify(afterDrop));
  check(!!afterDrop.to && afterDrop.to.id === 'oak_log', '★ 能放到另一个格子（原木去了第 5 格）', afterDrop.to);
  check(!afterDrop.from, '原格子被清空（真的搬走了，不是复制）', afterDrop.from);
  await shot('inv-1-moved.png');

  // ── 手动 2×2 合成：原木 → 木板 ───────────────────────────────
  await clickSel('#slots .slot', 4);        // 拿起第 5 格的原木
  await clickSel('#craft-grid .slot', 0);   // 放进合成格
  const inGrid = await ev(`(()=>{const w=window.zfsnMC.world;
    return {grid0:w.craftGrid[0],inv13:w.inventory[13]};})()`);
  console.log('   ', JSON.stringify(inGrid));
  check(!!inGrid.grid0 && inGrid.grid0.id === 'oak_log', '★ 能把材料放进 2×2 合成格', inGrid.grid0);

  const result = await ev(`(()=>{const n=document.querySelector('#craft-result .slot');
    return n?{icon:!!n.querySelector('img'),count:n.querySelector('.count')?.textContent}:null;})()`);
  console.log('   ', JSON.stringify(result));
  check(!!result && result.icon === true, '★ 合成格放材料后出现产物（原版行为）', result);

  // 点产物取出：产物先进「手上」（原版就是先到手上），再放下
  await stowHeld();
  await clickSel('#craft-result .slot', 0);
  const crafted = await ev(`(()=>{const w=window.zfsnMC.world,h=window.zfsnMC.held;
    const inBag=w.inventory.reduce((s,x)=>s+(x?.id==='oak_planks'?x.n:0),0);
    return {inBag,held:h?{id:h.id,n:h.n}:null,grid0:w.craftGrid[0]};})()`);
  console.log('   ', JSON.stringify(crafted));
  check((crafted.held?.id === 'oak_planks' && crafted.held.n >= 4) || crafted.inBag >= 4,
    '★ 点产物真的拿到木板（原版先放到手上）', crafted);
  await shot('inv-2-crafted.png');

  // ── 快捷栏（HUD）物品不重叠 ──────────────────────────────────
  // 用真实点击「界面外」关闭：生存模式没有完成按钮，这是唯一的鼠标关闭方式
  await clickAt(5, 5);
  await sleep(350);
  const closed = await ev(`(()=>{const d=document.querySelector('#inventory-dialog');return d.open;})()`);
  check(closed === false, '★ 点界面外能关闭背包（原版行为，生存模式没有完成按钮）', closed);
  const hudGeom = await ev(`(()=>{
    const list=[...document.querySelectorAll('#hotbar .slot')].map(n=>{const r=n.getBoundingClientRect();
      return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)};});
    let overlap=0;
    for(let i=0;i<list.length;i++)for(let j=i+1;j<list.length;j++){
      const a=list[i],b=list[j];
      if(a.x<b.x+b.w-1&&b.x<a.x+a.w-1&&a.y<b.y+b.h-1&&b.y<a.y+a.h-1)overlap++;
    }
    return {n:list.length,overlap,cols:new Set(list.map(r=>r.x)).size,
            barW:Math.round(document.querySelector('#hotbar').getBoundingClientRect().width)};
  })()`);
  console.log('   ', JSON.stringify(hudGeom));
  check(hudGeom.n === 9, 'HUD 快捷栏 9 格', hudGeom.n);
  check(hudGeom.overlap === 0, '★ HUD 快捷栏 9 格不重叠', hudGeom.overlap);
  check(hudGeom.cols === 9, 'HUD 快捷栏排成一行 9 列', hudGeom.cols);
  await shot('inv-3-hud.png');

  console.log(`\n=== 问题 (${problems.length}) ===`);
  problems.forEach((p) => console.log('  - ' + p));

  // ── 工作台 3×3（点工作台要开 3×3，不是 2×2）──────────────────
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1600);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{const s=document.querySelector('#seed');s.value='ZFSN-TABLE';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2000);

  const placed = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    const x=Math.floor(p.x)+1,y=Math.floor(p.y)-1;
    w.set(x,y,13);
    w.inventory[9]={id:'oak_planks',n:3};
    w.inventory[10]={id:'stick',n:2};
    return {x,y,block:w.get(x,y),near:!!w.nearBlock(13)};})()`);
  check(placed.near === true, '工作台已放在玩家旁边', placed);

  // 按 F 使用。★ 必须 dispatch 到 body：监听器第一行是 e.target.matches(...)，
  //   发给 document/window 会抛 TypeError（它们没有 matches），整个监听器直接中断。
  await ev(`document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyF',key:'f',bubbles:true}));true`);
  await sleep(600);
  const tbl = await ev(`(()=>{
    const d=document.querySelector('#inventory-dialog'),panel=document.querySelector('.inv-panel');
    const grid=document.querySelectorAll('#craft-grid .slot');
    const out=document.querySelector('#craft-result');
    const cols=new Set([...grid].map(n=>Math.round(n.getBoundingClientRect().left))).size;
    return {open:d.open,isTable:panel.classList.contains('is-table'),
      bg:getComputedStyle(panel).backgroundImage.includes('gui_crafting'),
      gridN:grid.length,cols,
      outLeft:out.offsetLeft,outTop:out.offsetTop,
      playerHidden:document.querySelector('#inv-player').hidden};})()`);
  console.log('   ', JSON.stringify(tbl));
  check(tbl.open === true, '点工作台能打开界面', tbl.open);
  check(tbl.isTable === true && tbl.bg === true, '面板换成了原版工作台贴图（gui_crafting.png）', [tbl.isTable, tbl.bg]);
  check(tbl.gridN === 9 && tbl.cols === 3, '★ 工作台是 3×3 网格（不是背包的 2×2）', [tbl.gridN, tbl.cols]);
  check(tbl.outLeft === 238 && tbl.outTop === 60, '产物格贴着贴图里的产物槽 (119,30)×2', [tbl.outLeft, tbl.outTop]);
  check(tbl.playerHidden === true, '工作台界面不显示玩家模型（原版如此）', tbl.playerHidden);

  // 3 木板 + 2 木棍 → 木镐（station 配方，只能在 3×3 出）。
  // 合成格每格只放 1 个，所以要一格一格点：左手那叠会自己减少。
  await clickSel('#slots .slot', 0);          // 拿起 3 个木板
  await clickSel('#craft-grid .slot', 0);     // 放进第 1 格（剩 2）
  await clickSel('#craft-grid .slot', 1);     // 第 2 格（剩 1）
  await clickSel('#craft-grid .slot', 2);     // 第 3 格（整叠放完）
  await clickSel('#slots .slot', 1);          // 拿起 2 个木棍
  await clickSel('#craft-grid .slot', 4);     // 第 4 格（剩 1）
  await clickSel('#craft-grid .slot', 5);     // 第 5 格
  await stowHeld();
  const pick = await ev(`(()=>{const b=document.querySelector('#craft-result .slot');const w=window.zfsnMC.world;
    return {has:!!b,icon:b?b.querySelector('img')?.getAttribute('src'):null,
      title:b?b.title:null,grid:w.tableGrid.filter(Boolean).length,
      cells:w.tableGrid.map(x=>x?x.id+'x'+x.n:null).filter(Boolean),
      recipe:w.findTableRecipe()?w.findTableRecipe().out:null,
      dbg:(()=>{const m={};for(const c of w.tableGrid)if(c)m[c.id]=(m[c.id]||0)+1;
        const R=w.constructor===Object?null:null;
        return {map:m,hasFn:typeof w.recipeIn,table:w.findTableRecipe()};})(),
      inv9:w.inventory[9],inv10:w.inventory[10]};})()`);
  console.log('   ', JSON.stringify(pick));
  check(pick.has === true && /镐/.test(pick.title || ''), '★ 3×3 能合成工作台专属配方（木镐）', pick.title);
  check(/pickaxe/.test(pick.icon || ''), '产物图标就是木镐', pick.icon);
  await shot('inv-6-table.png');

  await clickSel('#craft-result .slot', 0);
  const got = await ev(`(()=>{const w=window.zfsnMC.world;
    const h=window.zfsnMC.held;
    return {inBag:w.count('wooden_pickaxe'),held:h?{id:h.id,n:h.n}:null,
            grid:w.tableGrid.filter(Boolean).length};})()`);
  console.log('   ', JSON.stringify(got));
  check((got.held?.id === 'wooden_pickaxe') || got.inBag >= 1,
    '★ 点产物真的拿到木镐（原版先放到手上）', got);
  check(got.grid === 0, '合成后 3×3 网格被清空', got.grid);
  await clickAt(5, 5);
  await sleep(300);

  // ── 窄屏背包不溢出 ──────────────────────────────────────────
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  await ev('dispatchEvent(new Event("resize")); true');
  await sleep(800);
  await ev(`document.querySelector('#touch-inventory').click()`);
  await sleep(500);
  const m = await ev(`(()=>{const p=document.querySelector('.inv-panel').getBoundingClientRect();
    const slots=[...document.querySelectorAll('#slots .slot')].map(n=>n.getBoundingClientRect());
    return {vw:innerWidth,panel:[Math.round(p.left),Math.round(p.right)],
      overflowX:document.documentElement.scrollWidth-innerWidth,
      panelInView:p.left>=-1&&p.right<=innerWidth+1,
      slotMinW:slots.length?Math.round(Math.min(...slots.map(r=>r.width))):0,
      recipeHidden:document.querySelector('.recipe-panel')?.hidden};})()`);
  console.log('   ', JSON.stringify(m));
  check(m.panelInView === true, '375 宽下背包面板没有溢出视口', m.panel);
  check(m.overflowX === 0, '375 宽下没有横向滚动', m.overflowX);
  check(m.recipeHidden === true, '375 宽生存模式也不显示配方书', m.recipeHidden);
  await shot('inv-4-mobile.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  // ── 创造模式：这块列表是唯一还会显示的场景，不能坏 ──────────
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1600);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{const s=document.querySelector('#seed');s.value='ZFSN-CREATIVE';
    const m=document.querySelector('[name=mode][value=creative]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2000);
  const cre = await ev(`(async()=>{
    document.querySelector('#touch-inventory').click();
    await new Promise(r=>setTimeout(r,400));
    const p=document.querySelector('.recipe-panel');
    return {mode:window.zfsnMC?.world?.mode,panelHidden:p.hidden,
      rows:document.querySelectorAll('#recipes .recipe').length,
      slots:document.querySelectorAll('#slots .slot').length};})()`);
  console.log('   ', JSON.stringify(cre));
  check(cre.mode === 'creative', '创造模式已进入', cre.mode);
  check(cre.panelHidden === false, '创造模式仍能看到物品列表（否则创造模式没物品来源）', cre.panelHidden);
  check(cre.rows > 5, '创造模式物品列表有内容', cre.rows);
  check(cre.slots === 27, '创造模式物品栏也是 27 格', cre.slots);
  await shot('inv-5-creative.png');

  console.log(`\n=== 问题合计 (${problems.length}) ===`);
  problems.forEach((p) => console.log('  - ' + p));
  console.log(problems.length ? 'FAIL' : 'PASS — 背包交互全部通过');

  clearInterval(dialogTimer);
  cdp.close();
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
