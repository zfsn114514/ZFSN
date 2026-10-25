// 方块接缝检测：在真实 dpr 变换下铺满方块，统计未被覆盖（alpha<255）的像素
// 三种画法对比：重叠 1px / 精确 tile / 按设备像素对齐（snap）
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
    if(r.result?.exceptionDetails){
      const d=r.result.exceptionDetails;
      return {ERR:d.text+' '+(d.exception?.description||'')};
    }
    return r.result?.result?.value;
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:PAGE});
  await new Promise(r=>setTimeout(r,4000));

  const probe = `(()=>{
    const mc=window.zfsnMC;
    if(!mc?.images) return {ERR:'没有 images 探针'};
    const img=mc.images.stone||mc.images.dirt||mc.images.grass_block_side;
    if(!img) return {ERR:'找不到方块贴图'};
    const dpr=window.devicePixelRatio||1;
    const viewW=innerWidth;
    const tileBase=viewW<650?26:viewW<1100?30:34;
    const snap=v=>Math.round(v*dpr)/dpr;
    const modes={
      'overlap_+1': {tile:tileBase,      drawW:tileBase+1},
      'exact':      {tile:tileBase,      drawW:tileBase},
      'snap':       {tile:snap(tileBase),drawW:snap(tileBase)},
    };
    const out={dpr, viewW, tileBase};
    for(const [label,m] of Object.entries(modes)){
      const t=m.tile, w=m.drawW;
      const camX=snap(3.7), camY=snap(2.3);
      const N=16, cw=Math.ceil(N*t), ch=Math.ceil(N*t);
      const c=document.createElement('canvas');
      c.width=Math.round(cw*dpr); c.height=Math.round(ch*dpr);
      const g=c.getContext('2d',{willReadFrequently:true});
      g.setTransform(dpr,0,0,dpr,0,0);
      g.imageSmoothingEnabled=false;
      // 多铺一圈，保证四边不出界
      for(let y=-1;y<=N;y++)for(let x=-1;x<=N;x++){
        g.drawImage(img,0,0,16,16, x*t-camX, y*t-camY, w, w);
      }
      // 只采样「内部」区域：边一圈的留白不算
      const pad=Math.ceil(t*dpr)+1;
      const W2=c.width, H2=c.height;
      const px=g.getImageData(0,0,W2,H2).data;
      let gap=0, total=0;
      for(let yy=pad; yy<H2-pad; yy++){
        for(let xx=pad; xx<W2-pad; xx++){
          total++;
          if(px[(yy*W2+xx)*4+3]<255) gap++;
        }
      }
      out[label]={tile:+t.toFixed(3), drawW:+w.toFixed(3), gapPx:gap, totalPx:total, pct:+(gap/total*100).toFixed(3)};
      c.width=0;c.height=0;
    }
    return out;
  })()`;

  const rows=[];
  for(const s of [1,1.25,1.5]){
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:720,deviceScaleFactor:s,mobile:false});
    await evalJS('dispatchEvent(new Event("resize")); true');
    await new Promise(r=>setTimeout(r,350));
    rows.push(await evalJS(probe));
  }
  console.log(JSON.stringify(rows,null,2));
  await send('Emulation.clearDeviceMetricsOverride');
  ws.close();
}
main().catch(e=>{console.error('FATAL',e);process.exit(1);});
