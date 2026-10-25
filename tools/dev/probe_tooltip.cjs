/* 物品名提示框 + 右键菜单屏蔽。
   ★ 悬停必须用 Input.dispatchMouseEvent 真实移动鼠标：pointerover/pointermove
     是浏览器 hit-test 出来的，直接派发合成事件到元素上测不到「跟手」「贴边翻转」。
   ★ 右键菜单用 dispatchEvent contextmenu 的**返回值**判定（false = 被 preventDefault），
     比监听 defaultPrevented 更直接。 */
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
  // 先挪开再移到目标：确保产生 pointerout/pointerover，而不是只有 pointermove
  const hover = async (x, y) => { await mouse('mouseMoved', 2, 2); await sleep(40); await mouse('mouseMoved', x, y); await sleep(90); };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const fs = require('node:fs');
    const path = require('node:path');
    fs.mkdirSync('.tmp-mc', { recursive: true });
    fs.writeFileSync(path.join('.tmp-mc', name), Buffer.from(r.data, 'base64'));
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(1800);

  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-TIP';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(1800);
  check(await ev(`window.zfsnMC?.playing === true`), '进入游戏');

  // 新世界的背包是空的 —— 不塞东西的话所有「悬停出名字」的断言都测不到目标，
  // 只会得到「hidden:true」然后误判成通过。
  const seeded = await ev(`(()=>{const w=window.zfsnMC.world,it=window.zfsnMC.items;
    w.inventory[9]={id:'oak_log',n:12};
    w.inventory[10]={id:'cobblestone',n:32};
    w.inventory[0]={id:'wooden_pickaxe',n:1,dur:59};
    w.selected=0;window.zfsnMC.refreshInv();
    return {log:it['oak_log']?.name,stone:it['cobblestone']?.name,pick:it['wooden_pickaxe']?.name};})()`);
  console.log('   ', JSON.stringify(seeded));
  check(!!seeded.log && !!seeded.pick, '物品表能取到中文名（否则断言无从比对）', seeded);

  // ── 1. 右键菜单 ────────────────────────────────────────────────
  const ctx = await ev(`(()=>{
    const fire=el=>{try{return el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));}catch(e){return 'err';}};
    const out={};
    out.canvas=fire(document.querySelector('#world'));
    out.hotbar=fire(document.querySelector('#hotbar .slot'));
    out.touch=fire(document.querySelector('#touch-controls'));
    out.seed=fire(document.querySelector('#seed'));                 // 输入框应该放行
    return out;})()`);
  console.log('   ', JSON.stringify(ctx));
  check(ctx.canvas === false, '游戏画面右键不弹浏览器菜单', ctx.canvas);
  check(ctx.hotbar === false, 'HUD 快捷栏右键不弹浏览器菜单', ctx.hotbar);
  check(ctx.touch === false, '触屏键区域右键不弹浏览器菜单', ctx.touch);
  check(ctx.seed === true, '输入框（种子）右键菜单仍然保留，可以粘贴', ctx.seed);

  // 背包里的格子（dialog 内）也要被挡住
  await ev(`(async()=>{document.querySelector('#touch-inventory').click();
    await new Promise(r=>setTimeout(r,320));return true;})()`);
  await sleep(400);
  check(await ev(`document.querySelector('#inventory-dialog').open`), '背包已打开');
  const ctxInv = await ev(`(()=>{const s=document.querySelector('#slots .slot');
    return s?s.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true})):'no-slot';})()`);
  check(ctxInv === false, '背包格子（dialog 内）右键不弹浏览器菜单', ctxInv);
  const ctxChat = await ev(`(()=>{const el=document.querySelector('#chat-input');
    return el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));})()`);
  check(ctxChat === true, '聊天输入框右键仍可用（粘贴指令）', ctxChat);

  // ── 2. 悬停显示名字 ────────────────────────────────────────────
  const first = await ev(`(()=>{const s=[...document.querySelectorAll('#slots .slot')]
      .find(b=>window.zfsnMC.world.inventory[Number(b.dataset.index)]);
    if(!s)return null;const q=s.getBoundingClientRect();
    const st=window.zfsnMC.world.inventory[Number(s.dataset.index)];
    return {x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2),
      id:st.id,name:window.zfsnMC.items[st.id].name};})()`);
  check(!!first, '背包里找到有物品的格子', first && first.id);
  if (first) {
    await hover(first.x, first.y);
    const tip = await ev(`(()=>{const t=document.querySelector('#mc-tooltip');
      const q=t.getBoundingClientRect();
      return {hidden:t.hidden,display:getComputedStyle(t).display,text:t.textContent,
        x:Math.round(q.left),y:Math.round(q.top),w:Math.round(q.width),h:Math.round(q.height),
        host:t.parentElement?.id||t.parentElement?.tagName};})()`);
    console.log('   ', JSON.stringify(tip));
    check(!tip.hidden && tip.display !== 'none', '悬停物品格显示名字（hidden 属性真的生效）', tip);
    check(tip.text === first.name, '提示框文字就是这件物品的中文名', { got: tip.text, want: first.name });
    check(tip.w > 0 && tip.h > 0, '提示框有实际尺寸（不是零宽假通过）', { w: tip.w, h: tip.h });
    check(tip.x >= first.x && tip.y >= first.y, '提示框在指针右下方（不挡住指的东西）', { x: tip.x, y: tip.y });
    check(tip.host === 'inventory-dialog', '提示框挂在 dialog 内部（top layer 才不会被盖住）', tip.host);

    // 背景色应该是原版深紫而不是系统菜单白
    const bg = await ev(`getComputedStyle(document.querySelector('#mc-tooltip')).color`);
    check(bg === 'rgb(255, 255, 255)', '提示框文字是白色', bg);
    await shot('tip-inventory.png');
  }

  // ── 3. 移到空格子 → 隐藏 ───────────────────────────────────────
  const empty = await ev(`(()=>{const s=[...document.querySelectorAll('#slots .slot')]
      .find(b=>!window.zfsnMC.world.inventory[Number(b.dataset.index)]);
    if(!s)return null;const q=s.getBoundingClientRect();
    return {x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2)};})()`);
  if (empty) {
    await hover(empty.x, empty.y);
    const t = await ev(`(()=>{const t=document.querySelector('#mc-tooltip');
      return {hidden:t.hidden,display:getComputedStyle(t).display};})()`);
    check(t.hidden === true && t.display === 'none', '移到空格子后名字消失', t);
  }

  // ── 4. 贴右下角 → 翻转，不溢出视口 ────────────────────────────
  // 把东西放进物品栏最后一格（面板右下角），指针压在它右下角才可能溢出
  const edge = await ev(`(()=>{const w=window.zfsnMC.world;
    w.inventory[35]={id:'stone',n:64};window.zfsnMC.refreshInv();
    const s=[...document.querySelectorAll('#slots .slot')].find(b=>Number(b.dataset.index)===35);
    if(!s)return null;const q=s.getBoundingClientRect();
    return {x:Math.round(q.right-4),y:Math.round(q.bottom-4),name:window.zfsnMC.items['stone'].name};})()`);
  if (edge) {
    await hover(edge.x, edge.y);
    const t = await ev(`(()=>{const t=document.querySelector('#mc-tooltip');
      const q=t.getBoundingClientRect();return {hidden:t.hidden,text:t.textContent,left:Math.round(q.left),right:Math.round(q.right),
        top:Math.round(q.top),bottom:Math.round(q.bottom),vw:innerWidth,vh:innerHeight};})()`);
    console.log('   ', JSON.stringify(t));
    check(t.hidden === false && t.text === edge.name, '贴角落的格子也能显示名字', t);
    check(t.left >= 0 && t.right <= t.vw, '贴右边缘时提示框翻到左侧，不溢出视口', t);
    check(t.bottom <= t.vh, '提示框不溢出视口底部', t);
  }

  // ── 5. HUD 快捷栏（dialog 外）也要显示 ────────────────────────
  // 背包打开时全屏遮罩会挡住 HUD，那一次悬停没有意义，先关掉再测。
  await ev(`document.querySelector('#inventory-dialog').close()`);
  await sleep(250);
  const hot = await ev(`(()=>{const s=document.querySelector('#hotbar .slot');
    const q=s.getBoundingClientRect();return {x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2)};})()`);
  await hover(hot.x, hot.y);
  const tipHot = await ev(`(()=>{const t=document.querySelector('#mc-tooltip');
    return {hidden:t.hidden,text:t.textContent,host:t.parentElement?.id||t.parentElement?.tagName};})()`);
  console.log('   ', JSON.stringify(tipHot));
  check(tipHot.host === 'game', '背包关闭后提示框移回 #game（快捷栏在 dialog 外）', tipHot.host);
  check(tipHot.hidden === false && tipHot.text === seeded.pick,
    'HUD 快捷栏悬停显示手持物品名', { got: tipHot.text, want: seeded.pick });

  // ── 6. 创造栏分类标签 / 物品格 ─────────────────────────────────
  await ev(`(()=>{window.zfsnMC.runCommand('gamemode creative');window.zfsnMC.refreshInv();return true;})()`);
  await sleep(300);
  await ev(`(async()=>{document.querySelector('#touch-inventory').click();
    await new Promise(r=>setTimeout(r,320));return true;})()`);
  await sleep(400);
  const tab = await ev(`(()=>{const b=document.querySelector('#creative-tabs-top button');
    if(!b)return null;const q=b.getBoundingClientRect();
    return {x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2),tip:b.dataset.tip};})()`);
  if (tab) {
    await hover(tab.x, tab.y);
    const t = await ev(`(()=>{const t=document.querySelector('#mc-tooltip');
      return {hidden:t.hidden,text:t.textContent};})()`);
    check(t.hidden === false && t.text === tab.tip, '创造栏分类标签悬停显示分类名', { got: t.text, want: tab.tip });
  }
  const cg = await ev(`(()=>{const b=document.querySelector('#creative-grid button img')?.closest('button');
    if(!b)return null;const q=b.getBoundingClientRect();
    return {x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2),tip:b.dataset.tip};})()`);
  if (cg) {
    await hover(cg.x, cg.y);
    const t = await ev(`(()=>{const t=document.querySelector('#mc-tooltip');
      const lines=[...t.querySelectorAll('div')].map(d=>d.textContent);
      return {hidden:t.hidden,text:t.textContent,lines,sub:!!t.querySelector('.tip-sub')};})()`);
    console.log('   ', JSON.stringify(t));
    check(t.hidden === false && t.lines[0] === cg.tip.split('\n')[0], '创造栏物品格悬停显示物品名',
      { got: t.lines[0], want: cg.tip.split('\n')[0] });
    check(!t.sub, '普通物品不会被渲染出多余的灰色副行', { tip: cg.tip, sub: t.sub });
  }

  // ── 7. 贴边翻转 + 多行：构造一个压在视口右下角的元素 ───────────
  // 面板里的格子离视口边缘还远，光靠它们测不到翻转分支，得人为造一个贴边的。
  await ev(`document.querySelector('#inventory-dialog').close(); true`);
  await sleep(200);
  const fx = await ev(`(()=>{let d=document.querySelector('#tip-probe');
    if(!d){d=document.createElement('div');d.id='tip-probe';
      d.style.cssText='position:fixed;right:0;bottom:0;width:24px;height:24px';
      d.dataset.tip='第一行·很长的物品名占位\\n第二行是灰色副标题';document.body.append(d);}
    const q=d.getBoundingClientRect();
    return {x:Math.round(q.right-4),y:Math.round(q.bottom-4)};})()`);
  await hover(fx.x, fx.y);
  const ft = await ev(`(()=>{const t=document.querySelector('#mc-tooltip');
    const q=t.getBoundingClientRect();
    return {hidden:t.hidden,lines:[...t.querySelectorAll('div')].map(d=>d.textContent),
      sub:t.querySelector('.tip-sub')?.textContent||'',
      left:Math.round(q.left),right:Math.round(q.right),bottom:Math.round(q.bottom),
      vw:innerWidth,vh:innerHeight};})()`);
  console.log('   ', JSON.stringify(ft));
  check(ft.hidden === false && ft.left < fx.x, '贴右边缘时提示框翻到指针左侧', { left: ft.left, pointerX: fx.x });
  check(ft.right <= ft.vw, '翻转后仍留在视口内', { right: ft.right, vw: ft.vw });
  check(ft.bottom <= ft.vh, '贴底边时提示框翻到指针上方', { bottom: ft.bottom, vh: ft.vh });
  check(ft.lines.length === 2 && ft.sub === '第二行是灰色副标题', '两行提示：第二行用灰色副标题样式',
    { lines: ft.lines, sub: ft.sub });
  await ev(`document.querySelector('#tip-probe')?.remove(); true`);

  // ── 8. 截图 ────────────────────────────────────────────────────
  await ev(`document.querySelector('#inventory-dialog').close(); true`);
  await sleep(150);
  await ev(`document.querySelector('#touch-inventory').click();true`);
  await sleep(400);
  const anySlot = await ev(`(()=>{const b=document.querySelector('#creative-grid button');
    if(!b)return null;const q=b.getBoundingClientRect();
    return {x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2)};})()`);
  if (anySlot) { await hover(anySlot.x, anySlot.y); }
  await shot('tip-creative.png');

  // 收尾：让页面停下来，避免 RAF 常驻把下一次连接卡死
  await cdp.send('Page.navigate', { url: 'about:blank' });

  console.log('');
  if (problems.length) {
    console.log(`问题（${problems.length}）:`);
    for (const p of problems) console.log('  - ' + p);
    process.exit(1);
  }
  console.log('PASS — 物品名提示 + 右键菜单屏蔽全部通过');
  process.exit(0);
}

main().catch((e) => { console.error('探针异常:', e.message); process.exit(1); });
