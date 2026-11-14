/* 放大截取 HUD 区域（生命/护甲/吸收/饥饿/经验条），用来肉眼确认图标与排版 */
const PORT = process.env.CDP_PORT || '9334';
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8899/minecraft/';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.resolve(__dirname, '../../.tmp-mc');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
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
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
    return r.result.value;
  };
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.enable');
  await send('Page.navigate', { url: PAGE });
  await sleep(1800);
  await ev('localStorage.clear(); true');
  await send('Page.navigate', { url: PAGE });
  await sleep(2000);
  await ev(`document.querySelector('#play').click()`);
  await sleep(250);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-HUD';const s=document.querySelector('[name=mode][value=survival]');if(s)s.checked=true;})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2500);
  // 摆一个「有护甲 + 有吸收 + 满饥饿」的状态
  await ev(`(()=>{const w=window.zfsnMC.world,p=w.player;
    p.health=11;p.food=15;p.saturation=6;p.absorption=6;p.level=3;p.xp=9;
    p.armor={helmet:{id:'diamond_helmet',n:1,dur:363},chestplate:{id:'diamond_chestplate',n:1,dur:528},
      leggings:{id:'diamond_leggings',n:1,dur:495},boots:{id:'diamond_boots',n:1,dur:429}};
    w.recalcArmor();window.zfsnMC.refreshInv();return true;})()`);
  await sleep(600);
  // 用元素的真实位置算裁剪区（视口大小随窗口变，写死会截偏）
  const rect = await ev(`(()=>{
    const hud=document.querySelector('#hud');
    const wr=hud.querySelector('#hotbar-wrap').getBoundingClientRect();
    const ab=document.querySelector('#absorption').getBoundingClientRect();
    const ar=document.querySelector('#armor').getBoundingClientRect();
    const he=document.querySelector('#health').getBoundingClientRect();
    const hu=document.querySelector('#hunger').getBoundingClientRect();
    const xp=document.querySelector('#xp-bar').getBoundingClientRect();
    return {vw:innerWidth,vh:innerHeight,
      x:Math.min(ab.left,ar.left,he.left,hu.left,xp.left),
      y:Math.min(ab.top,ar.top,he.top,hu.top,xp.top),
      w:Math.max(hu.right,xp.right)-Math.min(ab.left,ar.left,he.left,hu.left,xp.left),
      h:Math.max(he.bottom,hu.bottom,xp.bottom)-Math.min(ab.top,ar.top,he.top,hu.top,xp.top)};
  })()`);
  console.log('裁剪区', rect);
  const r = await send('Page.captureScreenshot', { format: 'png', clip: {
    x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y - 8),
    width: Math.min(rect.w + 16, rect.vw), height: Math.min(rect.h + 16, rect.vh), scale: 3 } });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'combat-hud-zoom.png'), Buffer.from(r.data, 'base64'));
  console.log('已保存 .tmp-mc/combat-hud-zoom.png');
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
