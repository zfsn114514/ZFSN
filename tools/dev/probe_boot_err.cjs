const PORT=process.env.CDP_PORT||9401, PAGE=process.env.MC_URL||'http://127.0.0.1:8900/minecraft/';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
  const list=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page=list.find(t=>t.type==='page');
  const ws=new WebSocket(page.webSocketDebuggerUrl);
  let id=0;const pending=new Map();const errs=[];
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);
    if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);return;}
    if(m.method==='Runtime.exceptionThrown')errs.push(JSON.stringify(m.params.exceptionDetails).slice(0,600));
    if(m.method==='Log.entryAdded'&&m.params.entry.level==='error')errs.push('LOG: '+m.params.entry.text.slice(0,400));
  });
  await new Promise(r=>ws.addEventListener('open',r));
  const send=(method,params={})=>new Promise((res,rej)=>{const mid=++id;pending.set(mid,m=>m.error?rej(new Error(JSON.stringify(m.error))):res(m.result));ws.send(JSON.stringify({id:mid,method,params}));});
  await send('Runtime.enable');await send('Page.enable');await send('Log.enable');
  await send('Page.navigate',{url:PAGE});await sleep(2500);
  const z=await send('Runtime.evaluate',{expression:'typeof window.zfsnMC',returnByValue:true});
  console.log('zfsnMC:',z.result.value);
  console.log('errors:',errs.length);errs.forEach(e=>console.log(' ',e));
  process.exit(0);
}
main().catch(e=>{console.error('ERR',e.message);process.exit(1);});
