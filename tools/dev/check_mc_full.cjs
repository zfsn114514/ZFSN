/* 方块世界：功能实测（生物 3D / 水流 / 挖掘 / 音效 / UI 几何）
 * 用法：sh tools/dev/mc_shot.sh tools/dev/check_mc_full.cjs
 *
 * 只看「页面没报错」不算通过。这里每一项都有可观测判据：
 * 音效看 audio.played 计数、水流看水格数量是否随 stepWater 变化、
 * 挖掘看背包是否真的多出东西、UI 看真实 getBoundingClientRect。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.CDP_PORT || 9401);
const URL_ = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const OUT = path.resolve(__dirname, '../../.tmp-mc');
const problems = [];

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s)));
  }).on('error', rej);
});

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  return {
    events: [],
    ready: new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    onMessage() {
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
          const { resolve, reject } = pending.get(m.id);
          pending.delete(m.id);
          m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        } else if (m.method) this.events.push(m);
      });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let list = await get('/json/list');
  let page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到可用的页面目标');
  const cdp = connect(page.webSocketDebuggerUrl);
  cdp.onMessage();
  await cdp.ready;

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  // 复用同一个浏览器 profile 时里面可能残留上一次的存档，
  // 那样创建新世界会弹 confirm()，而 headless 下没人点 → 主线程直接卡死。
  cdp.events.length = 0;
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(3500);
  await cdp.send('Runtime.evaluate', { expression: 'localStorage.clear()' });
  // 万一还有别的原生弹窗，自动确认，别让测试挂住
  setInterval(() => cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}), 500);

  // ★ awaitPromise 默认 true：async IIFE 返回的是 Promise，returnByValue 会把它序列化成 {}，
  //   于是断言永远看到空对象（「验证脚本撒谎」的经典死法）。对同步表达式没有副作用。
  const ev = async (expr, awaitPromise = true) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed');
    return r.result.value;
  };
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('   截图', name);
  };
  const key = async (code, vk, keyStr) => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyStr || code, windowsVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyStr || code, windowsVirtualKeyCode: vk });
  };
  const check = (ok, msg, detail) => {
    if (!ok) problems.push(msg + (detail !== undefined ? ` → 实际 ${JSON.stringify(detail)}` : ''));
    console.log(`   ${ok ? 'PASS' : 'FAIL'} ${msg}${detail !== undefined ? '  ' + JSON.stringify(detail) : ''}`);
  };

  // ── 1. 进游戏 ────────────────────────────────────────────────
  console.log('→ 创建世界（固定种子，便于复现）');
  // ★ 必须清存档：profile 是复用的，上一次跑完世界会被自动保存下来。
  //   同一个种子再跑一次会 restore 出「上次已经倒过水 / 挖过方块」的世界，
  //   水流测试就会因为水面已饱和而误判成"水不流动"。
  await ev(`localStorage.clear(); true`);
  await sleep(200);
  await ev(`document.querySelector('#play').click()`);
  await sleep(200);
  await ev(`(()=>{const s=document.querySelector('#seed');s.value='ZFSN-CHECK';})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await sleep(2000);
  check(await ev(`window.zfsnMC?.playing === true`), '世界已创建且进入游玩状态');

  // ── 2. HUD 几何 ──────────────────────────────────────────────
  console.log('→ HUD 几何');
  const geo = await ev(`(()=>{
    const r=document.querySelector('#hotbar').getBoundingClientRect();
    const h=document.querySelector('#health').getBoundingClientRect();
    return {bottom:r.bottom,vh:innerHeight,barW:r.width,barH:r.height,
      hearts:document.querySelectorAll('#health i').length,
      food:document.querySelectorAll('#hunger i').length,
      slots:document.querySelectorAll('#hotbar .slot').length,
      heartsAboveHotbar:h.bottom<=r.top+2};
  })()`);
  console.log('   ', JSON.stringify(geo));
  check(geo.barW === 364 && geo.barH === 44, '快捷栏尺寸是原版 182×22 的 2 倍', [geo.barW, geo.barH]);
  check(geo.bottom <= geo.vh, '快捷栏没有被屏幕底边裁掉', [geo.bottom, geo.vh]);
  check(geo.slots === 9 && geo.hearts === 10 && geo.food === 10, '快捷栏 9 格 / 生命 10 心 / 饥饿 10 格');
  check(geo.heartsAboveHotbar, '生命与饥饿在快捷栏上方');

  // ── 3. 生物：是不是真的 3D、每种都在 ─────────────────────────
  console.log('→ 生物 3D 模型');
  const mobReport = await ev(`(()=>{
    const mc=window.zfsnMC, types=['pig','cow','sheep','chicken','zombie','steve'];
    const faceCount={};
    for(const t of types)faceCount[t]=mc.drawEntity(document.createElement('canvas').getContext('2d'),mc.images,{type:t,vx:0,yaw:.95},0,0,0,100,.95);
    const top=window.__mobTop||null;
    return {faceCount, spawned:[...new Set(mc.world.mobs.map(m=>m.type))], total:mc.world.mobs.length};
  })()`);
  console.log('   ', JSON.stringify(mobReport));
  for (const t of ['pig', 'cow', 'sheep', 'chicken', 'zombie', 'steve']) {
    check(mobReport.faceCount[t] > 10, `${t} 的模型输出了多个可见面（3D 而不是一张平面图）`, mobReport.faceCount[t]);
  }
  check(mobReport.spawned.length >= 3, '开局世界里有多种生物，不只是猪', mobReport.spawned);

  // 六种生物并排渲染，方便肉眼看
  await ev(`(()=>{
    const mc=window.zfsnMC, types=[['pig','猪'],['cow','牛'],['sheep','羊'],['chicken','鸡'],['zombie','僵尸'],['steve','玩家']];
    const c=document.createElement('canvas');c.width=1280;c.height=320;
    c.id='mobsheet';c.style.cssText='position:fixed;left:0;top:0;z-index:99999';
    document.body.append(c);
    const g=c.getContext('2d');g.imageSmoothingEnabled=false;
    g.fillStyle='#7fa3ad';g.fillRect(0,0,c.width,c.height);
    types.forEach(([t],i)=>{
      mc.drawEntity(g,mc.images,{type:t,vx:1.2,yaw:.95},0.4,110+i*205,300,190,.95);
      g.fillStyle='#000';g.font='16px monospace';g.fillText(t,80+i*205,315);
    });
  })()`);
  await sleep(300);
  await shot('mobs-sheet.png');
  await ev(`document.querySelector('#mobsheet').remove()`);

  // ── 4. 音效 ─────────────────────────────────────────────────
  console.log('→ 音效');
  // 真实 Input 事件才算用户手势，AudioContext 才能 resume
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 900, y: 300, button: 'none' });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 900, y: 300, button: 'left', clickCount: 1 });
  await sleep(600);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 900, y: 300, button: 'left', clickCount: 1 });
  await sleep(900);
  await sleep(1500);   // 首次播放要 fetch + decode ogg，played 计数是异步加上去的
  // 显式驱动一次播放：点击不一定落在能发声的东西上，失败原因也拿不到
  const audioProbe = await ev(`(async()=>{
    const a = window.zfsnMC.audio;
    await a.unlock();
    a.failed = 0; a.lastError = null;
    const before = a.played;
    await a.play('dig_stone', 0, .8);
    await new Promise(r=>setTimeout(r,800));
    return {before, after:a.played, failed:a.failed, lastError:a.lastError||null,
            state:a.context?.state||'none', buffers:[...a.buffers.keys()]};
  })()`);
  console.log('    显式播放:', JSON.stringify(audioProbe));
  const audioState = await ev(`(()=>{const a=window.zfsnMC.audio;return {
    state:a.context?.state||'none', played:a.played, failed:a.failed,
    groups:a.manifest?Object.keys(a.manifest).length:0};})()`);
  console.log('   ', JSON.stringify(audioState));
  check(audioState.state === 'running', 'AudioContext 已被用户手势解锁（running）', audioState.state);
  check(audioState.groups >= 20, '音效清单已加载（挖掘/脚步/受伤/生物叫声等）', audioState.groups);
  check(audioProbe.buffers.length > 0, 'ogg 被成功 fetch + decode 成 AudioBuffer', audioProbe.buffers);
  check(audioProbe.failed === 0, '音效加载/播放没有异常', audioProbe.lastError || 0);
  check(audioState.played > 0, '真的播放了音效（played 计数增加）', audioState.played);

  // ── 5. 水流 ─────────────────────────────────────────────────
  console.log('→ 水流模拟');
  const flow = await ev(`(()=>{
    const w=window.zfsnMC.world, W=w.surface.length;
    const count=()=>w.blocks.reduce((n,v)=>n+(v===17?1:0),0);
    // 找一块「同高、开阔、两边都是实心草方块」的平地，从半空倒一桶水。
    // ★ 两个坑都会让测试误判成「水不流动」：
    //   1) 世界里有自然生成的橡树，倒在树干/树叶中间会被直接挡住；
    //   2) stepWater 要求「目标格下方能托住水」才不会横向铺（否则会变成悬空水板），
    //      所以站在悬崖边倒水只会垂直落下，不会铺开。
    let x=60;
    const flat=(xx,y0)=>w.surface[xx]===y0&&w.get(xx,y0)===1&&w.get(xx,y0-1)===0&&w.get(xx,y0-2)===0;
    while(x<W-40&&!(()=>{const y0=w.surface[x];
      return flat(x,y0)&&flat(x-2,y0)&&flat(x+2,y0)&&flat(x-4,y0)&&flat(x+4,y0);})())x++;
    const y=w.surface[x]-4;
    const before=count();
    w.setWaterSource(x,y);
    const steps=[];
    for(let i=0;i<8;i++){w.stepWater();steps.push(count());}
    let maxLevel=0,levels={};
    for(let i=0;i<w.water.length;i++)if(w.blocks[i]===17){levels[w.water[i]]=(levels[w.water[i]]||0)+1;maxLevel=Math.max(maxLevel,w.water[i]);}
    return {x,y,before,steps,levels,spread:steps[steps.length-1]-before,
      seed:w.seed,dims:[w.surface.length,w.blocks.length/w.surface.length],
      atY:w.get(x,y),below:w.get(x,y+1),around:[w.get(x-1,y),w.get(x+1,y),w.get(x-1,y+1),w.get(x+1,y+1)]};
  })()`);
  console.log('   ', JSON.stringify(flow));
  check(flow.spread > 4, '倒水后水体横向/纵向扩散出多格', flow.spread);
  check(Object.keys(flow.levels).length >= 2, '水有多个 level（不是一整片固定蓝方块）', flow.levels);
  check(Number(flow.levels['8']) > 0, '存在满级水（水源/落水柱）', flow.levels['8']);

  // ── 6. 挖掘 ─────────────────────────────────────────────────
  console.log('→ 挖掘');
  const dig = await ev(`(()=>{
    const w=window.zfsnMC.world,p=w.player;
    const bx=Math.floor(p.x)+2,by=w.surface[Math.floor(p.x)+2];
    const before=w.get(bx,by),reach=w.reachable(bx,by),dropsBefore=w.drops.length;
    for(let i=0;i<40;i++)w.mine(bx,by,0.1);
    return {before,after:w.get(bx,by),reach,drops:w.drops.length-dropsBefore};
  })()`);
  console.log('   ', JSON.stringify(dig));
  check(dig.before > 0 && dig.after === 0, '目标方块被真的挖掉了', [dig.before, dig.after]);
  check(dig.drops > 0, '挖掉后掉落了物品实体（掉落物要靠近才会进背包）', dig.drops);

  // ── 7. 画面：地表 / 水 / 背包 ────────────────────────────────
  console.log('→ 画面');
  await sleep(400);
  await shot('chk-ingame.png');
  await ev(`(()=>{const w=window.zfsnMC.world;w.player.x=${flow.x}+1.5;w.player.y=w.surface[${flow.x}]-2;})()`);
  await sleep(1200);
  await shot('chk-water.png');

  await key('KeyE', 69, 'e');
  await sleep(600);
  await shot('chk-inventory.png');
  const inv = await ev(`(()=>{
    const p=document.querySelector('.inv-panel').getBoundingClientRect();
    return {w:p.width,h:p.height,titled:document.querySelector('#recipe-title').textContent,
      rows:document.querySelectorAll('#slots .slot').length};
  })()`);
  console.log('   ', JSON.stringify(inv));
  check(Math.round(inv.w) === 352 && Math.round(inv.h) === 332, '背包面板是原版 176×166 的 2 倍', [inv.w, inv.h]);
  check(inv.rows === 27, '主物品栏 27 格');
  await key('KeyE', 69, 'e');
  await sleep(300);

  console.log('→ 熔炉界面');
  await ev(`(()=>{const w=window.zfsnMC.world;w.player.x=${flow.x}+1.5;
    const tx=Math.floor(w.player.x)+1,ty=w.surface[Math.floor(w.player.x)]-1;w.set(tx,ty,14);})()`);
  await sleep(300);
  await key('KeyF', 70, 'f');
  await sleep(600);
  await shot('chk-furnace.png');
  check(await ev(`document.querySelector('#furnace-dialog').open`), '靠近熔炉按 F 能打开熔炉界面');
  await ev(`document.querySelector('#close-furnace').click()`);

  // ── 8. 错误汇总 ─────────────────────────────────────────────
  const errors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown'
    || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'));
  console.log('\n=== 运行期错误 (' + errors.length + ') ===');
  for (const e of errors.slice(0, 10)) {
    console.log('  !', e.params.exceptionDetails?.exception?.description?.split('\n')[0] || e.params.entry?.text);
  }
  if (errors.length) problems.push(`${errors.length} 条运行期错误`);

  console.log('\n' + (problems.length ? 'FAIL:\n  - ' + problems.join('\n  - ')
    : 'PASS — 生物 3D、水流、挖掘、音效、UI 几何全部通过'));

  await cdp.send('Page.navigate', { url: 'about:blank' });
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
