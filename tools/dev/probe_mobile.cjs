// 手机端：375 / 390 宽实测（横向溢出、快捷栏、按钮可点、触屏键）
const PORT = process.env.CDP_PORT || '9401';
const PAGE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const fs = require('node:fs');
const path = require('node:path');
const OUT = path.resolve(__dirname, '../../.tmp-mc');

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
    if(r.result?.exceptionDetails){const d=r.result.exceptionDetails;return {ERR:d.text+' '+(d.exception?.description||'').split('\n')[0]};}
    return r.result?.result?.value;
  };
  const shot=async(name)=>{const r=await send('Page.captureScreenshot',{format:'png'});
    if(!r.result?.data) throw new Error('截图失败: '+JSON.stringify(r).slice(0,200));
    fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,name),Buffer.from(r.result.data,'base64'));};

  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:PAGE});
  await new Promise(r=>setTimeout(r,1500));
  await evalJS('localStorage.clear(); true');
  // ★ 有存档时创建新世界会弹 confirm()，headless 下没人点 → 主线程卡死，后续 evaluate 全部超时
  const dlg = setInterval(() => send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}), 400);

  const report=[];
  // ★ coarse 是 game.js 启动时读一次的常量，媒体模拟必须在 navigate 之前设好，
  //   否则首轮读到 pointer:fine，#touch-controls 一直 hidden。
  await send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  await send('Emulation.setEmulatedMedia',{features:[{name:'pointer',value:'coarse'},{name:'hover',value:'none'}]});
  for(const [w,h,label] of [[375,812,'iPhone SE/8'],[390,844,'iPhone 12/13']]){
    // 每轮重载，否则第二轮截到的还是上一轮的游戏画面
    await send('Page.navigate',{url:PAGE});
    await new Promise(r=>setTimeout(r,1500));
    await evalJS('localStorage.clear(); true');
    await send('Emulation.setDeviceMetricsOverride',{width:w,height:h,deviceScaleFactor:2,mobile:true});
    await evalJS('dispatchEvent(new Event("resize")); true');
    await new Promise(r=>setTimeout(r,1600));

    const m = await evalJS(`(()=>{
      const de=document.documentElement;
      const bar=document.querySelector('#hotbar');
      const r=bar?bar.getBoundingClientRect():null;
      const btns=[...document.querySelectorAll('button.mc-btn,a.mc-btn')]
        .filter(b=>b.offsetParent!==null)
        .map(b=>{const q=b.getBoundingClientRect();return {t:(b.textContent||'').trim().slice(0,10),w:Math.round(q.width),h:Math.round(q.height),inView:q.left>=0&&q.right<=innerWidth};});
      const tc=document.querySelector('#touch-controls');
      const tcBtns=tc?[...tc.querySelectorAll('button')]:[];
      return {
        vw:innerWidth, vh:innerHeight, dpr:devicePixelRatio, coarse:matchMedia('(pointer:coarse)').matches,
        docScrollW:de.scrollWidth, overflowX:de.scrollWidth-innerWidth,
        bar:r?{x:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height),right:Math.round(r.right)}:null,
        barOverflow:r?(r.left<-1||r.right>innerWidth+1):null,
        buttons:btns,
        touchHidden:tc?tc.hidden:null,
        touchVisible:tc?tc.offsetParent!==null:null,
        touchBtnCount:tcBtns.length,
        touchInView:tcBtns.length?tcBtns.every(b=>{const q=b.getBoundingClientRect();return q.width>0&&q.left>=-1&&q.right<=innerWidth+1&&q.bottom<=innerHeight+1;}):false,
        footClip:(()=>{const f=document.querySelector('.title-foot');if(!f)return null;const q=f.getBoundingClientRect();return q.left<-1||q.right>innerWidth+1;})(),
      };
    })()`);
    await shot(`mob-${w}-title.png`);
    report.push({label,w,h,m});

    // 进游戏：#play 打开表单 → 点表单里的「开始游戏」（submit 按钮）
    const entered = await evalJS(`(()=>{
      const play=document.querySelector('#play');
      if(play)play.click();
      const form=document.querySelector('#new-world');
      const sub=form?form.querySelector('button[type=submit]'):null;
      if(sub)sub.click();
      return {play:!!play, form:!!form, sub:!!sub};
    })()`);
    await new Promise(r=>setTimeout(r,2000));
    const inGame = await evalJS(`(()=>{
      const bar=document.querySelector('#hotbar');
      const r=bar?bar.getBoundingClientRect():null;
      const tc=document.querySelector('#touch-controls');
      const tcBtns=tc?[...tc.querySelectorAll('button')].filter(b=>b.offsetParent!==null):[];
      return {barBottom:r?Math.round(r.bottom):null, vh:innerHeight,
              barW:r?Math.round(r.width):null,
              fits:r?r.bottom<=innerHeight+1&&r.left>=-1&&r.right<=innerWidth+1:null,
              overflowX:document.documentElement.scrollWidth-innerWidth,
              playing:!!window.zfsnMC?.playing,
              touchVisible:tc?tc.offsetParent!==null:null,
              touchBtnCount:tcBtns.length,
              touchInView:tcBtns.length?tcBtns.every(b=>{const q=b.getBoundingClientRect();
                return q.width>0&&q.left>=-1&&q.right<=innerWidth+1&&q.bottom<=innerHeight+1;}):false,
              // ★ 盒子在视口内不等于文字也在：flex 会把按钮压窄到文字溢出，
              //   必须同时看容器有没有横向溢出、按钮有没有被压到点不动
              touchOverflow:tc?tc.scrollWidth-tc.clientWidth:null,
              touchMinW:tcBtns.length?Math.round(Math.min(...tcBtns.map(b=>b.getBoundingClientRect().width))):null,
              // 触屏键不能压住快捷栏
              touchOverBar:tcBtns.length?tcBtns.some(b=>{const q=b.getBoundingClientRect();
                return r?q.bottom>r.top&&q.top<r.bottom:false;}):false};
    })()`);
    await shot(`mob-${w}-ingame.png`);
    report.push({label,w,phase:'ingame',entered,inGame});
    await send('Emulation.clearDeviceMetricsOverride');
  }
  console.log(JSON.stringify(report,null,2));
  clearInterval(dlg);
  ws.close();
  process.exit(0);
}
main().catch(e=>{console.error('FATAL',e);process.exit(1);});
