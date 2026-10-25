const PORT=process.env.CDP_PORT||9301,PAGE=process.env.MC_URL||'http://127.0.0.1:8900/minecraft/';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page=list.find(t=>t.type==='page');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  let id=0;const pending=new Map();
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
  await new Promise(r=>ws.addEventListener('open',r));
  const cdp={send:(m,p={})=>new Promise((res,rej)=>{const i=++id;pending.set(i,x=>x.error?rej(new Error(JSON.stringify(x.error))):res(x.result));ws.send(JSON.stringify({id:i,method:m,params:p}));})};
  const ev=async x=>{const r=await cdp.send('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0]);return r.result.value;};
  await cdp.send('Page.enable');await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate',{url:PAGE});await sleep(1600);
  await ev('localStorage.clear();true');
  await cdp.send('Page.navigate',{url:PAGE});await sleep(1600);
  await ev(`document.querySelector('#play').click()`);await sleep(250);
  await ev(`document.querySelector('#seed').value='ZFSN-D';document.querySelector('#new-world').requestSubmit()`);await sleep(1800);
  await ev(`(()=>{const w=window.zfsnMC.world;w.inventory=Array(36).fill(null);
    w.player.armor.helmet={id:'iron_helmet',n:1,dur:164};window.zfsnMC.refreshInv();return true;})()`);
  await ev(`document.querySelector('#touch-inventory').click();true`);await sleep(450);
  const info=await ev(`(()=>{
    const slots=[...document.querySelectorAll('#armor-slots .slot')].map(b=>({area:b.dataset.area,index:b.dataset.index,tip:b.dataset.tip}));
    return slots;})()`);
  console.log('armor slots:',JSON.stringify(info));
  // 直接用 DOM 事件测 shift 摘甲（绕过 CDP 坐标）
  const r=await ev(`(()=>{
    const b=document.querySelectorAll('#armor-slots .slot')[0];
    const rect=b.getBoundingClientRect(),x=rect.x+rect.width/2,y=rect.y+rect.height/2;
    const el=document.elementFromPoint(x,y);
    document.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,shiftKey:true,clientX:x,clientY:y,pointerId:7}));
    window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,shiftKey:true,clientX:x,clientY:y,pointerId:7}));
    return {target:el?el.className+' / '+(el.closest('.slot')?.dataset.area||'无 slot 祖先'):null,
      armor:window.zfsnMC.world.player.armor.helmet};})()`);
  console.log('after dom shift-click:',JSON.stringify(r));
  process.exit(0);
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1);});
