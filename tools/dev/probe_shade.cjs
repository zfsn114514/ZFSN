// 明暗层的「网格细缝」量化：旧画法逐格 fillRect(tile+1) 会重叠 1px，
// 该像素被叠加两次 → alpha 明显更高，形成整片网格暗线。
// 新画法把每格暗度写进 1 像素/格的小图再放大，一次绘制，不存在重叠。
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
  const evalJS=async(e)=>{
    const r=await send('Runtime.evaluate',{expression:e,awaitPromise:true,returnByValue:true,userGesture:true});
    if(r.result?.exceptionDetails){const d=r.result.exceptionDetails;return {ERR:d.text+' '+(d.exception?.description||'')};}
    return r.result?.result?.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:PAGE});
  await new Promise(r=>setTimeout(r,4000));

  const probe = `(()=>{
    const dpr=window.devicePixelRatio||1;
    const viewW=innerWidth;
    const tile=viewW<650?26:viewW<1100?30:34;
    const snap=v=>Math.round(v*dpr)/dpr;
    const camX=Math.round(34*3.7), camY=Math.round(34*2.3);
    const N=12;
    const out={dpr,tile};
    const ALPHA=.42;   // 相当于 darkness

    function stats(px,W,H,pad){
      const hist={};
      let mx=0,mn=999;
      for(let y=pad;y<H-pad;y++)for(let x=pad;x<W-pad;x++){
        const a=px[(y*W+x)*4+3];
        hist[a]=(hist[a]||0)+1;
        if(a>mx)mx=a; if(a<mn)mn=a;
      }
      return {minAlpha:mn,maxAlpha:mx,hist};
    }

    // ── 旧画法：逐格 fillRect(tile+1) 半透明黑
    {
      const cw=N*tile, c=document.createElement('canvas');
      c.width=Math.round(cw*dpr); c.height=Math.round(cw*dpr);
      const g=c.getContext('2d',{willReadFrequently:true});
      g.setTransform(dpr,0,0,dpr,0,0);
      g.fillStyle='rgba(4,8,18,'+ALPHA+')';
      for(let y=0;y<N;y++)for(let x=0;x<N;x++) g.fillRect(x*tile,y*tile,tile+1,tile+1);
      const px=g.getImageData(0,0,c.width,c.height).data;
      out.old=stats(px,c.width,c.height,Math.ceil(tile*dpr)+1);
      c.width=0;c.height=0;
    }

    // ── 新画法：1 像素/格 的 ImageData 再放大
    {
      const cw=N*tile, c=document.createElement('canvas');
      c.width=Math.round(cw*dpr); c.height=Math.round(cw*dpr);
      const g=c.getContext('2d',{willReadFrequently:true});
      g.setTransform(dpr,0,0,dpr,0,0);
      g.imageSmoothingEnabled=false;
      const small=document.createElement('canvas');
      small.width=N; small.height=N;
      const sg=small.getContext('2d');
      const im=sg.createImageData(N,N);
      for(let i=0;i<N*N;i++){
        im.data[i*4]=4; im.data[i*4+1]=8; im.data[i*4+2]=18;
        im.data[i*4+3]=Math.round(ALPHA*255);
      }
      sg.putImageData(im,0,0);
      g.drawImage(small,0,0,N*tile,N*tile);
      const px=g.getImageData(0,0,c.width,c.height).data;
      out.fixed=stats(px,c.width,c.height,Math.ceil(tile*dpr)+1);
      c.width=0;c.height=0;small.width=0;
    }
    return out;
  })()`;

  const rows=[];
  for(const s of [1,1.25]){
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:s,mobile:false});
    await evalJS('dispatchEvent(new Event("resize")); true');
    await new Promise(r=>setTimeout(r,300));
    const r = await evalJS(probe);
    // 只打关键数字，hist 太长
    if(r.old) r.old={minAlpha:r.old.minAlpha,maxAlpha:r.old.maxAlpha,levels:Object.keys(r.old.hist).length};
    if(r.fixed) r.fixed={minAlpha:r.fixed.minAlpha,maxAlpha:r.fixed.maxAlpha,levels:Object.keys(r.fixed.hist).length};
    rows.push(r);
  }
  console.log(JSON.stringify(rows,null,2));
  await send('Emulation.clearDeviceMetricsOverride');
  ws.close();
}
main().catch(e=>{console.error('FATAL',e);process.exit(1);});
