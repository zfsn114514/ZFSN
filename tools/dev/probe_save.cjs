/* 存档专项：世界从 640×160 扩到 4096×256 之后最危险的一块。
   线上所有人手里都是 v3 的 640×160 存档，新版一上线就必须能吃下它 ——
   吃不下就是丢档，报错也不行。

   覆盖：
   1. 新世界生成耗时（104 万格，用户要干等多久）
   2. v4 存档体积 vs localStorage 配额（压不进 5MB 等于自动存档失效）
   3. v4 往返一致
   4. v3（640×160，RLE）迁移 —— 地形铺到左上角、玩家数据全保留
   5. v2（384×144，裸数组，非 RLE）迁移
   6. 损坏存档必须报错，不能静默吞 */
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
  const logs = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || 'exception');
    }
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
  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    if (!r.data) throw new Error('截图失败');
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  };

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(2000);
  await ev('localStorage.clear(); true');
  await cdp.send('Page.navigate', { url: PAGE });
  await sleep(2200);

  // ── 1. 新世界生成耗时 ──
  await ev(`document.querySelector('#play').click()`);
  await sleep(300);
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-SAVE';
    const s=document.querySelector('[name=mode][value=survival]');if(s)s.checked=true;})()`);
  const t0 = Date.now();
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  let entered = false;
  for (let i = 0; i < 40 && !entered; i++) { await sleep(300); entered = await ev(`window.zfsnMC?.playing === true`); }
  const genMs = Date.now() - t0;
  check(entered, '新世界能进游戏', { 生成耗时: genMs + 'ms' });
  check(genMs < 4000, '生成 4096×256 世界在 4 秒内（超过就是用户能感知的卡）', genMs + 'ms');

  // ── 2. 存档体积与能否真的写进 localStorage ──
  const vol = await ev(`(()=>{
    const s=JSON.stringify(window.zfsnMC.world.serialize());
    const key='zfsn.probe.save';
    let wrote=false,err=null;
    try{localStorage.setItem(key,s);wrote=localStorage.getItem(key)===s;localStorage.removeItem(key);}
    catch(e){err=String(e.name||e.message);}
    return {chars:s.length,mb:+(s.length/1048576).toFixed(2),
            perCell:+(s.length/(4096*256)).toFixed(3),wrote,err};})()`);
  check(vol.chars > 0, '存档能序列化', { 字符数: vol.chars });
  // Chrome 每个源大约 5M 个 UTF-16 字符。留 20% 余量给别的东西。
  check(vol.chars < 4_000_000, '存档体积在 localStorage 配额内（<400 万字符）', vol);
  check(vol.wrote, '★ 存档真的写进 localStorage 并能原样读回', { wrote: vol.wrote, err: vol.err });
  console.log(`      存档 ${vol.mb}MB / ${vol.chars} 字符 / 每格 ${vol.perCell} 字符`);

  // ── 3. v4 往返 ──
  const rt = await ev(`(()=>{const W=window.zfsnMC.world,C=W.constructor;
    const data=JSON.parse(JSON.stringify(W.serialize()));
    const t0=performance.now();const w2=C.restore(data);
    const ms=+(performance.now()-t0).toFixed(0);
    let same=0;for(let k=0;k<300;k++){const x=(k*7919)%4096,y=(k*104729)%256;if(W.get(x,y)===w2.get(x,y))same++;}
    return {ms,same,total:300,migrated:w2.migrated,version:data.version};})()`);
  check(rt.same === rt.total, 'v4 存档往返后方块逐个一致', { 一致: `${rt.same}/${rt.total}` });
  check(rt.migrated === false, '同尺寸恢复不该标记 migrated', rt.migrated);
  console.log(`      恢复耗时 ${rt.ms}ms`);

  // ── 4. v3 旧档迁移（线上所有人手里的那份） ──
  const mig3 = await ev(`(()=>{const C=window.zfsnMC.world.constructor;
    const OW=640,OH=160,cells=OW*OH;
    // 造一份「全空气 + (10,10) 一块石头」的 RLE。重数上限 65535 所以要切段。
    const seg=(v,n)=>{const out=[];let left=n;while(left>0){const k=Math.min(65535,left);out.push(v,k);left-=k;}return out;};
    const idx=10*OW+10;
    const blocks=[...seg(0,idx),1,1,...seg(0,cells-idx-1)];
    const old={version:3,seed:'ZFSN-OLD-V3',mode:'survival',
      blocks,natural:seg(0,cells),water:seg(0,cells),
      surface:new Array(OW).fill(50),spawn:{x:40,y:48},
      player:{x:120,y:47,w:.65,h:1.8,vx:0,vy:0,ground:false,health:17,food:12,invuln:0,face:1,crouch:false},
      // ★ 背包必须是 36 格：restore 会严格校验 length===36（历史上一直是 36，
      //   不是这次改的）。造测试数据时漏了这点，会被误判成「背包数据损坏」。
      // ★ 带耐久的物品（工具）还必须给 dur：校验里有
      //   ITEMS[s.id].durability && (!Number.isInteger(s.dur) ...)，
      //   只给 {id,n} 一样会被判成背包损坏。
      inventory:Array(36).fill(null).map((_,i)=>i===0?{id:'wooden_pickaxe',n:1,dur:59}:i===1?{id:'oak_log',n:12}:null),
      selected:1,
      time:300,elapsed:300,weather:'rain',drops:[],mobs:[],furnaces:{},exhaustion:.3,
      craftGrid:[null,null,null,null],tableGrid:new Array(9).fill(null)};
    try{
      const w=C.restore(old);
      return {ok:true,migrated:w.migrated,
        blocksAt:(()=>{try{return w.get(10,10);}catch(e){return 'err';}})(),
        px:+w.player.x.toFixed(1),py:+w.player.y.toFixed(1),
        health:w.player.health,food:w.player.food,
        inv:w.inventory.slice(0,2).map(s=>s&&s.id),selected:w.selected,
        time:w.time,weather:w.weather,exhaustion:w.exhaustion,
        surfaceLen:w.surface.length,newArea:typeof w.get(3000,100)};
    }catch(e){return {ok:false,err:String(e.message||e)};}})()`);
  check(mig3.ok, '★ v3（640×160）旧档能恢复，不报错', mig3);
  if (mig3.ok) {
    check(mig3.migrated === true, 'v3 尺寸不符时标记 migrated', mig3.migrated);
    check(mig3.blocksAt === 1, '★ 旧地形真的铺进了新世界（(10,10) 那块石头还在）', mig3.blocksAt);
    check(mig3.health === 17 && mig3.food === 12, '生命/饱食度保留', { hp: mig3.health, food: mig3.food });
    check(mig3.px === 120 && mig3.py === 47, '玩家坐标保留', [mig3.px, mig3.py]);
    check((mig3.inv || []).join(',') === 'wooden_pickaxe,oak_log', '背包两格都搬过来了', mig3.inv);
    check(mig3.selected === 1, '选中的快捷栏格保留', mig3.selected);
    check(mig3.time === 300 && mig3.weather === 'rain', '时间与天气保留', { time: mig3.time, weather: mig3.weather });
    check(mig3.surfaceLen === 4096, 'surface 扩到新宽度', mig3.surfaceLen);
    check(mig3.newArea !== 'undefined', '新扩出来的区域能正常读方块', mig3.newArea);
  }

  // ── 5. v2（384×144，裸数组） ──
  const mig2 = await ev(`(()=>{const C=window.zfsnMC.world.constructor;
    const OW=384,OH=144,cells=OW*OH;
    const blocks=new Array(cells).fill(0);blocks[5*OW+5]=1;
    const old={version:2,seed:'ZFSN-OLD-V2',mode:'survival',blocks,
      surface:new Array(OW).fill(50),spawn:{x:40,y:48},
      player:{x:30,y:40,w:.65,h:1.8,vx:0,vy:0,ground:false,health:9,food:8,invuln:0,face:1},
      inventory:Array(36).fill(null).map((_,i)=>i===0?{id:'stone',n:5}:null),selected:0,time:100,elapsed:100,weather:'clear',
      drops:[],mobs:[],furnaces:{}};
    try{const w=C.restore(old);
      return {ok:true,migrated:w.migrated,blocksAt:w.get(5,5),health:w.player.health,
        inv:w.inventory[0]?.id,px:+w.player.x.toFixed(1)};
    }catch(e){return {ok:false,err:String(e.message||e)};}})()`);
  check(mig2.ok, '★ v2（384×144，非 RLE 裸数组）旧档也能恢复', mig2);
  if (mig2.ok) {
    check(mig2.blocksAt === 1 && mig2.health === 9, 'v2 的地形和玩家数据都搬过来了', mig2);
  }

  // ── 6. 损坏存档必须报错，且报对原因 ──
  // ★ 只断言「抛错了」不够：数据本身就不合法的话，会在第一个校验处就炸，
  //   于是每条用例都以「玩家数据损坏」通过 —— 看着全绿，其实一条都没测到目标分支。
  //   这里 base 是合法的，每个 case 只破坏一项，并要求报错信息命中预期关键词。
  const bad = await ev(`(()=>{const C=window.zfsnMC.world.constructor;
    const OW=640,OH=160,cells=OW*OH;
    const seg=(v,n)=>{const out=[];let left=n;while(left>0){const k=Math.min(65535,left);out.push(v,k);left-=k;}return out;};
    const base={version:3,seed:'BAD',mode:'survival',
      blocks:seg(0,cells),natural:seg(0,cells),water:seg(0,cells),
      surface:new Array(OW).fill(50),spawn:{x:1,y:1},
      player:{x:1,y:1,health:20,food:20},
      inventory:Array(36).fill(null),selected:0,time:0,elapsed:0,weather:'clear',
      drops:[],mobs:[],furnaces:{}};
    const cases=[
      ['方块长度不符',{blocks:[0,10]},'方块'],
      ['地图尺寸为 0',{version:4,width:0,height:0},'尺寸'],
      ['地图尺寸超上限',{version:4,width:99999,height:99999},'尺寸'],
      ['空对象','EMPTY','格式'],
      ['方块 id 越界',{blocks:seg(9999,cells)},'方块'],
      ['背包只有 35 格',{inventory:Array(35).fill(null)},'背包'],
      ['生命值 99',{player:{x:1,y:1,health:99,food:20}},'玩家'],
    ];
    return cases.map(([name,patch,expect])=>{
      const d=patch==='EMPTY'?{}:{...base,...patch};
      try{C.restore(d);return {name,threw:false,expect};}
      catch(e){const msg=String(e.message||e);
        return {name,threw:true,msg,hit:msg.includes(expect),expect};}});})()`);
  for (const b of bad) {
    check(b.threw && b.hit, `损坏存档「${b.name}」被拒绝，且原因指向${b.expect}`, { 报错: b.msg, 期望含: b.expect });
  }

  const errs = logs.filter((t) => t && !/favicon/.test(t));
  check(errs.length === 0, '全程没有未捕获异常', errs.slice(0, 3));

  await shot('save-ingame.png');
  console.log('');
  if (problems.length) {
    console.log(`✗ FAIL — ${problems.length} 个问题`);
    problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
    process.exitCode = 1;
  } else {
    console.log('✓ PASS — 生成耗时 / 存档体积 / v4 往返 / v3 v2 迁移 / 损坏拒绝 全部通过');
  }
  await cdp.send('Page.navigate', { url: 'about:blank' });
  ws.close();
}

main().catch((e) => { console.error('运行失败:', e.message); process.exit(1); });
