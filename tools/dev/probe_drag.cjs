/* 物品栏原版交互实测：右键拿一半 / 右键放一个 / 左键全部放下 /
   左键拖拽均分 / 右键拖拽每格一个。
   ★ 全部用 Input.dispatchMouseEvent 真实按下-移动-松开，
     用 el.click() 或直接改数据都测不出拖拽。 */
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
  const mouse = (type, x, y, button = 'left', buttons = 0) =>
    cdp.send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1 });

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);

  // 进游戏
  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-DRAG';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(1800);
  check(await ev(`window.zfsnMC?.playing === true`), '进入游戏');
  await ev(`(async()=>{document.querySelector('#touch-inventory').click();
    await new Promise(r=>setTimeout(r,300));return true;})()`);
  await sleep(400);
  check(await ev(`document.querySelector('#inventory-dialog').open`), '背包已打开');

  // 造一份可控的背包：#slots 第 0 格 = inventory[9]
  const reset = async (slots) => {
    await ev(`(()=>{const w=window.zfsnMC.world;
      w.inventory.fill(null);
      ${JSON.stringify(slots)}.forEach(([i,n])=>{ if(n>0) w.inventory[i]={id:'cobblestone',n}; });
      window.zfsnMC.refreshInv();
      return true;})()`);
    await sleep(200);
  };
  const read = () => ev(`(()=>{const w=window.zfsnMC.world,h=window.zfsnMC.held;
    return {bag:[0,1,2,3].map(i=>w.inventory[9+i]?.n||0),
            held:h?{id:h.id,n:h.n}:null,
            cursorShown:!document.querySelector('#held-cursor').hidden};})()`);
  const box = async (idx) => ev(`(()=>{const n=document.querySelectorAll('#slots .slot')[${idx}];
    const r=n.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
  const click = async (idx, button) => {
    const p = await box(idx);
    await mouse('mouseMoved', p.x, p.y, 'none', 0);
    await mouse('mousePressed', p.x, p.y, button, button === 'right' ? 2 : 1);
    await mouse('mouseReleased', p.x, p.y, button, 0);
    await sleep(120);
  };
  const drag = async (from, to, button) => {
    const a = await box(from), b = await box(to);
    await mouse('mouseMoved', a.x, a.y, 'none', 0);
    await mouse('mousePressed', a.x, a.y, button, button === 'right' ? 2 : 1);
    const steps = Math.abs(to - from);
    for (let s = 1; s <= steps; s++) {
      const p = await box(from + (to - from > 0 ? s : -s));
      await mouse('mouseMoved', p.x, p.y, 'none', button === 'right' ? 2 : 1);
      await sleep(60);
    }
    const end = await box(to);
    await mouse('mouseReleased', end.x, end.y, button, 0);
    await sleep(160);
  };

  // ── 1. 右键拿一半 ────────────────────────────────────────────
  console.log('→ 右键拿一半');
  await reset([[9, 10]]);
  const before1 = await read();
  await click(0, 'right');
  const half = await read();
  console.log('   ', JSON.stringify({ before1, half }));
  check(half.held?.id === 'cobblestone' && half.held.n === 5, '★ 右键点整叠：拿走一半（10 → 手上 5）', half.held);
  check(half.bag[0] === 5, '原格子剩下一半（5 个）', half.bag[0]);
  check(half.cursorShown === true, '★ 手上的物品跟随鼠标显示（#held-cursor 可见）', half.cursorShown);

  // ── 2. 右键放一个 ────────────────────────────────────────────
  console.log('→ 右键放一个');
  await click(1, 'right');
  const one = await read();
  console.log('   ', JSON.stringify(one));
  check(one.bag[1] === 1, '★ 右键点空格：只放下 1 个（不是整叠）', one.bag[1]);
  check(one.held?.n === 4, '手上还剩 4 个', one.held?.n);

  // ── 3. 左键全部放下 ──────────────────────────────────────────
  console.log('→ 左键全部放下');
  await click(2, 'left');
  const all = await read();
  console.log('   ', JSON.stringify(all));
  check(all.bag[2] === 4, '★ 左键点空格：把剩下的全放下（4 个）', all.bag[2]);
  check(all.held === null, '手上已空', all.held);

  // ── 4. 左键拖拽均分 ──────────────────────────────────────────
  console.log('→ 左键拖拽均分');
  await reset([[9, 9]]);
  await drag(0, 2, 'left');
  const spread = await read();
  console.log('   ', JSON.stringify(spread));
  const total = spread.bag.slice(0, 3).reduce((a, b) => a + b, 0);
  check(spread.bag[0] > 0 && spread.bag[1] > 0 && spread.bag[2] > 0, '★ 左键拖过 3 个格子：每格都有物品', spread.bag.slice(0, 3));
  check(total === 9, '一个都没丢（总共还是 9 个）', total);
  check(spread.held === null, '松开后手上空了（均分完）', spread.held);
  const spreadEven = Math.max(...spread.bag.slice(0, 3)) - Math.min(...spread.bag.slice(0, 3)) <= 1;
  check(spreadEven, '分配均匀（各格相差不超过 1）', spread.bag.slice(0, 3));

  // ── 5. 右键拖拽每格一个 ──────────────────────────────────────
  console.log('→ 右键拖拽（每格一个）');
  await reset([[9, 8]]);
  await click(0, 'left');       // 先整叠拿到手上
  await drag(1, 3, 'right');    // 从空格拖到第 4 格
  const oneEach = await read();
  console.log('   ', JSON.stringify(oneEach));
  check(oneEach.bag[1] === 1 && oneEach.bag[2] === 1 && oneEach.bag[3] === 1,
    '★ 右键拖过 3 格：每格只放 1 个', oneEach.bag.slice(1, 4));
  check(oneEach.held?.n === 5, '剩余留在手上（8-3=5）', oneEach.held);

  // ── 6. 关界面时手上的东西要还回背包 ──────────────────────────
  console.log('→ 关闭界面');
  await ev(`document.querySelector('#inventory-dialog').close(); true`);
  await sleep(300);
  const afterClose = await ev(`(()=>{const w=window.zfsnMC.world;
    return {held:!!window.zfsnMC.held, total:w.count('cobblestone'),
            cursorHidden:document.querySelector('#held-cursor').hidden};})()`);
  console.log('   ', JSON.stringify(afterClose));
  check(afterClose.held === false, '★ 手上物品已清空（不会凭空消失）', afterClose.held);
  check(afterClose.cursorHidden === true, '跟随鼠标的图标已隐藏', afterClose.cursorHidden);
  check(afterClose.total === 8, '物品总数没丢（8 个都在背包里）', afterClose.total);

  // ── 7. 截图 ──────────────────────────────────────────────────
  await ev(`(async()=>{document.querySelector('#touch-inventory').click();
    await new Promise(r=>setTimeout(r,300));return true;})()`);
  await sleep(400);
  await reset([[9, 12]]);
  await click(0, 'left');
  const holdBox = await box(3);
  await mouse('mouseMoved', holdBox.x + 18, holdBox.y - 26, 'none', 0);
  await sleep(200);
  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const fs = require('node:fs');
  const path = require('node:path');
  const out = process.env.SHOT_DIR || 'D:/ZFSNwebsite/.tmp-mc';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'drag-1-held.png'), Buffer.from(shot1.data, 'base64'));

  console.log(`\n=== 问题 (${problems.length}) ===`);
  problems.forEach((p) => console.log('  - ' + p));
  console.log(problems.length ? 'FAIL' : 'PASS — 物品栏拖拽/右键/分堆全部通过');
  ws.close();
  process.exit(problems.length ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
