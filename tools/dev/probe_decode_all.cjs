// 逐个 fetch+decode 全部 ogg，找出坏文件
const PORT = process.env.CDP_PORT || '9401';
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
async function main(){
  let list;
  for(let i=0;i<40;i++){
    try{ const r=await fetch(`http://127.0.0.1:${PORT}/json/list`); const a=await r.json(); list=a.filter(t=>t.type==='page'); if(list.length)break; }catch{}
    await new Promise(r=>setTimeout(r,300));
  }
  const ws=new WebSocket(list[0].webSocketDebuggerUrl);
  await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  let id=0; const pending=new Map();
  ws.onmessage=ev=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}};
  const send=(me,p={})=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:me,params:p}));});
  const evalJS=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true});
    if(r.result?.exceptionDetails)return {ERR:r.result.exceptionDetails.text}; return r.result?.result?.value;};

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:PAGE});
  await new Promise(r=>setTimeout(r,4000));

  const out = await evalJS(`(async()=>{
    const man = await fetch('sounds/manifest.json').then(r=>r.json());
    const names = [...new Set(Object.values(man).flat())];
    const ac = new AudioContext();
    const bad = [], ok = [];
    for(const n of names){
      try{
        const r = await fetch('sounds/'+n);
        const b = await r.arrayBuffer();
        if(!b.byteLength) throw Error('empty body status='+r.status);
        const buf = await ac.decodeAudioData(b);
        ok.push({n, dur:+buf.duration.toFixed(3), sr:buf.sampleRate});
      }catch(e){ bad.push({n, err:String(e&&e.message||e)}); }
    }
    await ac.close();
    return {total:names.length, okCount:ok.length, badCount:bad.length, bad, sample:ok.slice(0,4)};
  })()`);
  console.log(JSON.stringify(out,null,2));
  ws.close();
}
main().catch(e=>{console.error('FATAL',e);process.exit(1);});
