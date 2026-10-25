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
  // ★ 合成 KeyboardEvent 派发到 window 不会传播到 document 上的监听器，
  //   实测 chatOpen 恒为 false。必须走 CDP 的真实按键事件。
  const key = (code,k,vk,extra={}) => send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k, windowsVirtualKeyCode: vk, ...extra })
    .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k, windowsVirtualKeyCode: vk, ...extra }));
  const pressT = () => key('KeyT','t',84);
  const pressE = () => key('KeyE','e',69);
  const pressEsc = () => key('Escape','Escape',27);
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
  for(const [w,h,label] of [[320,568,'Small phone'],[375,812,'iPhone SE/8'],[390,844,'iPhone 12/13']]){
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
                return r?q.bottom>r.top&&q.top<r.bottom:false;}):false,
              // ★ 也不能压住血条 / 饥饿条（HUD 贴着屏幕底，触屏键很容易整条盖上去）
              touchOverStats:(()=>{
                const st=document.querySelector('.stats');
                if(!st||!tcBtns.length)return null;
                const sr=st.getBoundingClientRect();
                return tcBtns.some(b=>{const q=b.getBoundingClientRect();
                  return q.bottom>sr.top+1&&q.top<sr.bottom-1&&q.right>sr.left+1&&q.left<sr.right-1;});
              })(),
              statsRect:(()=>{const st=document.querySelector('.stats');if(!st)return null;
                const q=st.getBoundingClientRect();
                return {t:Math.round(q.top),b:Math.round(q.bottom),l:Math.round(q.left),r:Math.round(q.right)};})(),
              // ★ 跳跃键必须落在右手边（左半边只留左右移动）
              jump:(()=>{const j=document.querySelector('[data-hold="jump"]');if(!j)return null;
                const q=j.getBoundingClientRect();
                return {cx:Math.round(q.left+q.width/2),right:Math.round(q.right),w:Math.round(q.width),
                        // 只判「过半屏」太松：5 个按钮组成的右手组，组首位中心 x≈145 也能过。
                        // 必须落在右侧 30% 以内，才真的够得着右手拇指。
                        onRight:q.left+q.width/2>innerWidth*.7,
                        inView:q.left>=-1&&q.right<=innerWidth+1};})(),
              moveBtns:(()=>{const g=document.querySelector('.touch-move');
                return g?[...g.querySelectorAll('button')].map(b=>b.dataset.hold||b.id):[];})()};
    })()`);
    await shot(`mob-${w}-ingame.png`);
    report.push({label,w,phase:'ingame',entered,inGame});

    // ── 跳跃键搬位置后必须真的还能跳（位置对 ≠ 事件还连着）──
    // 合成 PointerEvent 不行：处理函数第一行 setPointerCapture 对未激活的 pointerId 会抛
    // NotFoundError，heldTouches 根本不会被写入。必须走真实触摸事件。
    const jc = await evalJS(`(()=>{const j=document.querySelector('[data-hold="jump"]');
      const q=j.getBoundingClientRect();return {x:Math.round(q.left+q.width/2),y:Math.round(q.top+q.height/2)};})()`);
    const before = await evalJS(`(()=>{const p=window.zfsnMC.world.player;
      return {y:p.y,vy:p.vy,ground:p.ground,mode:window.zfsnMC.world.mode};})()`);
    await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:jc.x,y:jc.y,id:1}]});
    await new Promise(r=>setTimeout(r,180));
    const during = await evalJS(`(()=>{const p=window.zfsnMC.world.player;
      return {y:p.y,vy:p.vy,ground:p.ground};})()`);
    await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const jumped = during.vy<-1||during.y<before.y-.05||(!during.ground&&before.ground);
    report.push({label,w,phase:'jump',at:jc,before,during,jumped});

    // ── 聊天栏：T 打开后不能横向溢出，输入框要留在屏幕里 ──
    await pressT();
    await new Promise(r=>setTimeout(r,350));
    const chat = await evalJS(`(()=>{
      const root=document.querySelector('#chat');
      const bar=document.querySelector('#chat-bar');
      const inp=document.querySelector('#chat-input');
      if(!root||!bar||!inp)return {missing:true};
      const r=root.getBoundingClientRect(), b=bar.getBoundingClientRect(), i=inp.getBoundingClientRect();
      // ★ 触屏键会盖住聊天提示（两者都贴底），必须量「聊天栏底边」和「触屏键顶边」的关系
      const tc=document.querySelector('#touch-controls');
      const tcb=tc?[...tc.querySelectorAll('button')].filter(x=>x.offsetParent!==null):[];
      const tcTop=tcb.length?Math.min(...tcb.map(x=>x.getBoundingClientRect().top)):null;
      return {open:!bar.hidden, chatOpen:!!window.zfsnMC?.chatOpen,
              barVisible:b.width>0,
              chatBottom:Math.round(r.bottom), touchTop:tcTop===null?null:Math.round(tcTop),
              overlapsTouch:tcTop===null?false:r.bottom>tcTop+1,
              root:{l:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width),b:Math.round(r.bottom)},
              inpFits:i.left>=-1&&i.right<=innerWidth+1&&i.bottom<=innerHeight+1,
              inpW:Math.round(i.width), inpLeft:Math.round(i.left), inpRight:Math.round(i.right),
              overflowX:document.documentElement.scrollWidth-innerWidth};
    })()`);
    await shot(`mob-${w}-chat.png`);
    await pressEsc();
    await new Promise(r=>setTimeout(r,250));
    report.push({label,w,phase:'chat',chat});

    // ── 背包面板：整块必须落在视口内，否则手机端点不到角落格子 ──
    await pressE();
    await new Promise(r=>setTimeout(r,400));
    const inv = await evalJS(`(()=>{
      const d=document.querySelector('#inventory-dialog');
      if(!d)return {missing:true};
      const r=d.getBoundingClientRect();
      const p=d.querySelector('.mc-panel');
      const pr=p?p.getBoundingClientRect():null;
      return {open:!!d.open,
              dialog:{l:Math.round(r.left),r:Math.round(r.right),t:Math.round(r.top),b:Math.round(r.bottom),w:Math.round(r.width)},
              panel:pr?{l:Math.round(pr.left),r:Math.round(pr.right),w:Math.round(pr.width)}:null,
              fits:pr?pr.left>=-1&&pr.right<=innerWidth+1:null,
              overflowX:document.documentElement.scrollWidth-innerWidth};
    })()`);
    await shot(`mob-${w}-inv.png`);
    report.push({label,w,phase:'inv',inv});
    await pressEsc();
    await evalJS(`(()=>{const w=window.zfsnMC.world,p=w.player;w.set(Math.floor(p.x)+2,Math.floor(p.y),14);return true;})()`);
    await key('KeyF','f',70);await new Promise(r=>setTimeout(r,200));
    const furnace=await evalJS(`(()=>{const d=document.querySelector('#furnace-dialog'),p=d.querySelector('.furnace-panel'),wrap=d.querySelector('.furnace-wrap');
      const r=p.getBoundingClientRect();const b=d.querySelector('#close-furnace');b.scrollIntoView({block:'nearest'});const br=b.getBoundingClientRect();
      return {open:d.open,left:r.left,right:r.right,recipes:d.querySelectorAll('[data-smelt]').length,closeVisible:br.top>=0&&br.bottom<=innerHeight,overflow:wrap.scrollWidth-wrap.clientWidth};})()`);
    report.push({w,phase:'furnace',furnace});await shot(`mob-${w}-furnace.png`);
    await send('Emulation.clearDeviceMetricsOverride');
  }
  console.log(JSON.stringify(report,null,2));
  // ── 汇总断言：把「肉眼看得懂」的结论打出来，别让 JSON 自己说话 ──
  const bad=[];
  const ok=[];
  const check=(label,list,fn)=>{const before=bad.length;fn();if(bad.length===before)ok.push(label);};
  for(const e of report){
    if(e.phase==='ingame'){
      const g=e.inGame;
      if(g.barW>e.w) bad.push(`${e.w} 快捷栏宽于实际屏幕 ${g.barW}`);
      if(g.jump?.right>e.w) bad.push(`${e.w} 跳跃键超出实际屏幕 ${g.jump.right}`);
      check(`${e.w} 进游戏布局正常（快捷栏 ${g.barW}px，触屏键 ${g.touchBtnCount} 个，最窄 ${g.touchMinW}px）`, bad, ()=>{
        if(!g.playing) bad.push(`${e.w} 没进入游戏`);
        if(g.overflowX>0) bad.push(`${e.w} 进游戏后横向溢出 ${g.overflowX}px`);
        if(g.fits===false) bad.push(`${e.w} 快捷栏超出视口`);
        if(!g.touchVisible) bad.push(`${e.w} 触屏键不可见`);
        if(g.touchOverflow>0) bad.push(`${e.w} 触屏键容器横向溢出 ${g.touchOverflow}px`);
        if(g.touchOverBar) bad.push(`${e.w} 触屏键压住快捷栏`);
        if(g.touchOverStats) bad.push(`${e.w} 触屏键压住血条/饥饿条（${JSON.stringify(g.statsRect)}）`);
        if(!g.jump) bad.push(`${e.w} 找不到跳跃键`);
        else{
          if(!g.jump.onRight) bad.push(`${e.w} 跳跃键不在右手边（中心 x=${g.jump.cx} / 视口宽 ${e.w}）`);
          if(!g.jump.inView) bad.push(`${e.w} 跳跃键超出视口`);
        }
        if(g.moveBtns.join(',')!=='left,right') bad.push(`${e.w} 左手组应该只有左右移动，实际 ${JSON.stringify(g.moveBtns)}`);
        if(!g.touchInView) bad.push(`${e.w} 触屏键超出视口`);
      });
    }
    if(e.phase==='furnace'){
      const f=e.furnace;
      if(!f?.open||f.recipes!==9||f.left<0||f.right>e.w||!f.closeVisible||f.overflow>0)bad.push(`${e.w} 熔炉菜单异常 ${JSON.stringify(f)}`);
      else ok.push(`${e.w} 九种冶炼入口与关闭按钮可访问`);
    }
    if(e.phase==='jump'){
      check(`${e.w} 触摸跳跃键真的跳起来了（y ${e.before?.y?.toFixed?.(2)} → ${e.during?.y?.toFixed?.(2)}，vy ${e.during?.vy?.toFixed?.(2)}）`, bad, ()=>{
        if(!e.jumped) bad.push(`${e.w} 按住跳跃键没反应（vy=${e.during?.vy}）`);
      });
    }
    if(e.phase==='chat'){
      const c=e.chat;
      check(`${e.w} 聊天栏正常（宽 ${c.root?.w}px，输入框 ${c.inpW}px）`, bad, ()=>{
        if(c.missing) return bad.push(`${e.w} 找不到聊天栏元素`);
        if(!c.open||!c.chatOpen) bad.push(`${e.w} 按 T 没打开聊天栏`);
        if(!c.barVisible) bad.push(`${e.w} 聊天输入条宽度为 0（不可见）`);
        if(!c.inpFits) bad.push(`${e.w} 聊天输入框超出视口（${c.inpLeft}~${c.inpRight}）`);
        if(c.overflowX>0) bad.push(`${e.w} 聊天栏导致横向溢出 ${c.overflowX}px`);
        if(c.overlapsTouch) bad.push(`${e.w} 聊天栏压住了触屏键（聊天底边 ${c.chatBottom} > 触屏顶边 ${c.touchTop}）`);
      });
    }
    if(e.phase==='inv'){
      const v=e.inv;
      check(`${e.w} 背包面板正常（面板宽 ${v.panel?.w}px）`, bad, ()=>{
        if(v.missing) return bad.push(`${e.w} 找不到背包对话框`);
        if(!v.open) return bad.push(`${e.w} 按 E 没打开背包`);
        if(v.panel && (v.panel.l<0 || v.panel.r>e.w)) bad.push(`${e.w} 背包超出实际屏幕`);
        if(v.fits===false) bad.push(`${e.w} 背包面板超出视口（${v.panel.left}~${v.panel.right}）`);
        if(v.overflowX>0) bad.push(`${e.w} 背包导致横向溢出 ${v.overflowX}px`);
      });
    }
  }
  for(const l of ok) console.log('   PASS '+l);
  if(bad.length){ console.log('\n=== 问题 ('+bad.length+') ==='); for(const b of bad) console.log('  - '+b); console.log('FAIL'); }
  else console.log('\nPASS — 手机端 320/375/390 布局全部通过');
  clearInterval(dlg);
  ws.close();
  process.exit(bad.length ? 1 : 0);
}
main().catch(e=>{console.error('FATAL',e);process.exit(1);});
