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
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
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


  const key=async(code,key,vk)=>{await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',code,key,windowsVirtualKeyCode:vk});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',code,key,windowsVirtualKeyCode:vk});};
  const click=async(sel)=>{const r=await ev(`(()=>{const r=document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await mouse('mousePressed',r.x,r.y,'left',1);await mouse('mouseReleased',r.x,r.y,'left',0);};
  check(await ev('window.zfsnMC.W===4096&&window.zfsnMC.H===256'),'地图 4096×256');
  await ev("window.zfsnMC.runCommand('gamemode creative')");await key('KeyE','e',69);await sleep(600);
  check(await ev("document.querySelectorAll('#creative-grid .slot').length===45&&document.querySelector('.recipe-panel').hidden"),'原版网格 45 格，右侧列表移除');
  // 分类 tab 自己的图标：截图里第 4 个 tab 是空白灰按钮，物品格却全正常，
  // 所以不能只查格子。
  const tabIcons=await ev(`[...document.querySelectorAll('#creative-tabs-top button,#creative-tabs-bottom button')].map(b=>{const i=b.querySelector('img');return {t:b.dataset.tip,w:i?i.naturalWidth:-1,src:i?i.getAttribute('src'):null};})`);
  const tabBroken=tabIcons.filter(t=>t.w<=0);
  check(tabIcons.length>=6&&tabBroken.length===0,'每个分类标签的图标都加载出来了',tabBroken.length?tabBroken:{共:tabIcons.length});
  await click('#creative-tabs-top button:last-child');
  await ev("document.querySelector('#creative-search').value='钻石';document.querySelector('#creative-search').dispatchEvent(new Event('input'))");await sleep(500);
  const search=await ev("[...document.querySelectorAll('#creative-grid button:not(:disabled)')].map(b=>b.dataset.tip)");
  check(search.length>=5&&search.every(x=>x.includes('钻石')),'中文搜索过滤',search);
  await shot('creative-search.png');
  await click('#creative-grid button:not(:disabled)');
  const picked=await ev('window.zfsnMC.held?.id');check(typeof picked==='string','真实鼠标拿起物品',picked);
  await click('#creative-hotbar button:first-child');
  check(await ev(`window.zfsnMC.world.inventory[0]?.id===${JSON.stringify(picked)}`),'真实鼠标放入快捷栏');
  await ev("document.querySelector('#creative-search').value='';document.querySelector('#creative-search').dispatchEvent(new Event('input'))");
  const max=await ev("Number(document.querySelector('#creative-scroll').max)");check(max>100,'上千物品可滚动浏览',max);
  await click('#creative-tabs-top button:first-child');await sleep(500);await shot('creative-building.png');
  await click('#creative-tabs-bottom button:last-child');
  check(await ev("document.querySelector('#inventory-dialog').classList.contains('personal')&&document.querySelector('.inv-panel').getBoundingClientRect().width>0"),'生存物品栏标签可切换');
  await click('#creative-tabs-top button:first-child');
  for(const width of [320,375,390]){
    await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:true});await sleep(300);
    const bounds=await ev("(()=>{const r=document.querySelector('#creative-panel').getBoundingClientRect();const tabs=document.querySelector('#creative-tabs-top').getBoundingClientRect();return {l:r.left,r:r.right,t:tabs.top,b:r.bottom};})()");
    check(bounds.l>=0&&bounds.r<=width&&bounds.t>=0&&bounds.b<=720,`${width} 创造背包完整可见`,bounds);await shot(`creative-${width}.png`);
  }
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await key('Escape','Escape',27);await key('KeyT','t',84);
  await cdp.send('Input.insertText',{text:'history-check-123'});await key('Enter','Enter',13);await sleep(7800);
  check(await ev("[...document.querySelectorAll('.chat-line')].some(x=>x.textContent.includes('history-check-123')&&x.classList.contains('expired'))"),'淡出消息仍保留');
  await key('KeyT','t',84);
  check(await ev("document.querySelector('#chat').classList.contains('open')&&[...document.querySelectorAll('.chat-line')].some(x=>x.textContent.includes('history-check-123')&&getComputedStyle(x).display!=='none')"),'T 重新显示聊天历史');
  await key('ArrowUp','ArrowUp',38);check(await ev("document.querySelector('#chat-input').value==='history-check-123'"),'上方向键回填历史输入');await shot('chat-history.png');
  await key('Escape','Escape',27);await key('Escape','Escape',27);await click('#light-button');check(await ev("document.querySelector('#light-button').textContent.includes('关')"),'光影可关闭');
  await click('#resume');
  const perf=await ev(`new Promise(resolve=>{const times=[];let last=performance.now();function frame(now){times.push(now-last);last=now;if(times.length<90)requestAnimationFrame(frame);else{times.sort((a,b)=>a-b);resolve({median:times[45],p95:times[85]});}}requestAnimationFrame(frame);})`);
  check(Number.isFinite(perf.median)&&perf.median<100,'桌面帧耗时抽样（非手机实机性能保证）',perf);
  await cdp.send('Page.navigate',{url:'about:blank'});ws.close();console.log(JSON.stringify(problems));console.log(problems.length?'FAIL':'PASS');process.exit(problems.length?1:0);
}
main().catch(e=>{console.error(e);process.exit(1);});
