/* 本轮新功能实测：聊天栏 / 斜杠指令 / 天气 / Shift 蹲下 / 自然树木可穿透 / 世界尺寸 */
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
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed');
    return r.result.value;
  };
  const keyDown = (code, key, vk, extra = {}) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', code, key, windowsVirtualKeyCode: vk, ...extra });
  const keyUp = (code, key, vk) => send('Input.dispatchKeyEvent', { type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
  const tap = async (code, key, vk, extra = {}) => { await keyDown(code, key, vk, extra); await keyUp(code, key, vk); await sleep(90); };
  const chat = async (text) => {
    // 先按 T 打开聊天，输入文字，回车发送
    await tap('KeyT', 't', 84);
    await sleep(220);
    const open = await ev(`window.zfsnMC.chatOpen === true`);
    if (!open) return { ok: false, open };
    await send('Input.insertText', { text });
    await sleep(60);
    await tap('Enter', 'Enter', 13, { text: '\r' });
    await sleep(320);
    return { ok: true, open, log: await ev(`(()=>{const l=[...document.querySelectorAll('.chat-line')].map(n=>n.textContent);
      return l.slice(-3);})()`) };
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev('localStorage.clear(); true');
  await send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-FEAT';
    const m=document.querySelector('[name=mode][value=survival]');if(m)m.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2000);
  check(await ev(`window.zfsnMC?.playing === true`), '进入游戏');

  // ── 1. 世界尺寸 ─────────────────────────────────────────────
  const dims = await ev(`(()=>{const w=window.zfsnMC.world;
    return {W:window.zfsnMC.W,H:window.zfsnMC.H,
      trees:Array.from(w.natural).filter(v=>v===1).length,
      mobs:w.mobs.length};})()`);
  console.log('   ', JSON.stringify(dims));
  check(dims.W === 640 && dims.H === 160, '★ 世界放大到 640×160（原来 384×144）', [dims.W, dims.H]);
  check(dims.trees > 200, '新世界里有自然生成的橡树', dims.trees);
  check(dims.mobs >= 16, '生物铺满整张地图，不是只挤在出生点', dims.mobs);

  // ── 2. 自然树可穿透 / 玩家放的树是实体 ──────────────────────
  const trees = await ev(`(()=>{const w=window.zfsnMC.world,W=window.zfsnMC.W;
    const found={log:null,leaf:null};
    for(let i=0;i<w.blocks.length;i++){
      if(w.natural[i]!==1)continue;
      const x=i%W,y=(i/W)|0;
      if(w.blocks[i]===5&&!found.log)found.log={x,y,solid:w.solid(x,y)};
      if(w.blocks[i]===6&&!found.leaf)found.leaf={x,y,solid:w.solid(x,y)};
      if(found.log&&found.leaf)break;
    }
    // 玩家自己放的：清掉 natural 位后应该变实心
    let placed=null;
    if(found.log){
      const {x,y}=found.log;
      const id=w.blocks[y*W+x];
      w.set(x,y,0);            // 先挖掉（顺手把 natural 清 0）
      w.set(x,y,id);           // 再放回去
      placed={x,y,solid:w.solid(x,y),natural:w.natural[y*W+x]};
    }
    return {found,placed};})()`);
  console.log('   ', JSON.stringify(trees));
  check(trees.found.log?.solid === false, '★ 自然生成的树干可以穿过去（不碰撞）', trees.found.log);
  check(trees.found.leaf?.solid === false, '★ 自然生成的树叶可以穿过去（不碰撞）', trees.found.leaf);
  check(trees.placed?.solid === true, '★ 玩家自己放下的树干是实体方块（有碰撞）', trees.placed);

  // ── 3. Shift 蹲下 ───────────────────────────────────────────
  console.log('→ Shift 蹲下');
  const standH = await ev(`window.zfsnMC.world.player.h`);
  await keyDown('ShiftLeft', 'Shift', 16, { modifiers: 8 });
  await sleep(400);
  const crouch = await ev(`(()=>{const p=window.zfsnMC.world.player;
    return {h:p.h,crouch:p.crouch};})()`);
  await keyUp('ShiftLeft', 'Shift', 16);
  await sleep(400);
  const stand2 = await ev(`(()=>{const p=window.zfsnMC.world.player;
    return {h:p.h,crouch:p.crouch};})()`);
  console.log('   ', JSON.stringify({ standH, crouch, stand2 }));
  check(standH === 1.8, '站立时身高 1.8 格', standH);
  check(crouch.h === 1.5 && crouch.crouch === true, '★ 按 Shift 蹲下（碰撞盒 1.8 → 1.5）', crouch);
  check(stand2.h === 1.8 && stand2.crouch === false, '松开 Shift 站起来', stand2);

  // 蹲下时速度要降到 ~30%
  const speed = await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    p.x=100;p.y=w.surface[100]-3;p.vy=0;p.vx=0;
    const run=(crouch)=>{p.crouch=false;p.h=1.8;p.x=100;p.vx=0;
      w.setCrouch(crouch);
      for(let i=0;i<30;i++)w.update(1/60,{right:true,crouch});
      return +((p.x-100)).toFixed(3);};
    const fast=run(false), slow=run(true);
    p.crouch=false;p.h=1.8;
    return {fast,slow,ratio:+(slow/Math.max(fast,1e-6)).toFixed(2)};})()`);
  console.log('   ', JSON.stringify(speed));
  check(speed.slow < speed.fast * 0.45, '★ 蹲下时移动明显变慢（原版约 30%）', speed.slow);

  // ── 4. 聊天与指令 ───────────────────────────────────────────
  console.log('→ 聊天栏');
  await ev(`window.zfsnMC.world.player.x=100; true`);
  const chatOpen = await chat('');
  check(chatOpen.open === true, '★ 按 T 能打开聊天输入框', chatOpen.open);
  await ev(`(()=>{const i=document.querySelector('#chat-input');if(i)i.blur();return true;})()`);

  console.log('→ 斜杠指令');
  const gm = await chat('/gamemode creative');
  const mode = await ev(`window.zfsnMC.world.mode`);
  check(mode === 'creative', '★ /gamemode creative 切换游戏模式', mode);

  const w1 = await chat('/weather thunder');
  const weather = await ev(`window.zfsnMC.world.weather`);
  check(weather === 'thunder', '★ /weather thunder 切换天气', weather);

  const t1 = await chat('/time set night');
  const night = await ev(`(()=>{const w=window.zfsnMC.world;return {night:w.night(),phase:+((w.time%1200)/1200).toFixed(3)};})()`);
  check(night.night === true, '★ /time set night 切到夜晚', night);

  const g1 = await chat('/give diamond 5');
  const diamond = await ev(`window.zfsnMC.world.count('diamond')`);
  check(diamond === 5, '★ /give diamond 5 给予物品', diamond);

  const tp = await chat('/tp 300');
  const pos = await ev(`(()=>{const p=window.zfsnMC.world.player;return {x:+p.x.toFixed(1),y:+p.y.toFixed(1)};})()`);
  check(Math.abs(pos.x - 300) < 1.5, '★ /tp 300 传送', pos);

  const bad = await chat('/nonsense');
  const hasErr = await ev(`[...document.querySelectorAll('.chat-line')].some(n=>/未知指令/.test(n.textContent))`);
  check(hasErr === true, '未知指令会报错提示（不会静默失败）', hasErr);

  const help = await chat('/help');
  const helpLines = await ev(`[...document.querySelectorAll('.chat-line')].filter(n=>/gamemode|weather/.test(n.textContent)).length`);
  check(help.open === true && helpLines >= 2, '★ /help 列出可用指令', helpLines);

  await ev(`(()=>{const i=document.querySelector('#chat-input');if(i)i.blur();return true;})()`);
  await sleep(200);

  // ── 5. 聊天时不能触发游戏按键 ───────────────────────────────
  await tap('KeyT', 't', 84);
  await sleep(250);
  const beforeSel = await ev(`window.zfsnMC.world.selected`);
  await send('Input.insertText', { text: '1234567890' });
  await sleep(150);
  const afterSel = await ev(`window.zfsnMC.world.selected`);
  const invOpen = await ev(`document.querySelector('#inventory-dialog').open`);
  check(afterSel === beforeSel && invOpen === false, '聊天输入时数字键不会切快捷栏、E 不会开背包', { beforeSel, afterSel, invOpen });
  await tap('Escape', 'Escape', 27);
  await sleep(250);
  check(await ev(`window.zfsnMC.chatOpen === false`), 'Esc 关闭聊天', true);

  // ── 6. 截图 ────────────────────────────────────────────────
  const fs = require('node:fs');
  const path = require('node:path');
  const out = process.env.SHOT_DIR || 'D:/ZFSNwebsite/.tmp-mc';
  fs.mkdirSync(out, { recursive: true });
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name), Buffer.from(r.data, 'base64'));
  };
  await ev(`window.zfsnMC.runCommand('weather rain'); window.zfsnMC.runCommand('time set day'); true`);
  await sleep(900);
  await shot('feat-rain.png');
  await ev(`window.zfsnMC.runCommand('weather clear'); window.zfsnMC.runCommand('time set noon'); true`);
  await sleep(900);
  await shot('feat-noon.png');
  await ev(`window.zfsnMC.runCommand('weather clear'); window.zfsnMC.runCommand('time set midnight'); true`);
  await sleep(900);
  await shot('feat-night.png');

  console.log(`\n=== 问题 (${problems.length}) ===`);
  problems.forEach((p) => console.log('  - ' + p));
  console.log(problems.length ? 'FAIL' : 'PASS — 聊天/指令/蹲下/树木穿透/世界尺寸全部通过');
  ws.close();
  process.exit(problems.length ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
