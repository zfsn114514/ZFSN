/* 精确量 GUI 贴图里格子的像素边界，校验 HTML 格子的 left/top 是否逐像素对齐。
 *
 * 原版 GUI 格子是 1px 凹陷边框（深色），面板底 #c6c6c6，格内 #8b8b8b。
 * 扫一行/一列找连续深色段 = 格子的边框位置。
 */
const http = require('node:http');

const PORT = Number(process.env.CDP_PORT || 9401);
const BASE = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';

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
    ready: new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); }),
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const mid = ++id; pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    onMessage() {
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
          const { resolve, reject } = pending.get(m.id); pending.delete(m.id);
          m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        }
      });
    },
    close() { ws.close(); },
  };
}

async function main() {
  const targets = await get('/json/list');
  const page = targets.find((t) => t.type === 'page');
  const cdp = connect(page.webSocketDebuggerUrl); cdp.onMessage(); await cdp.ready;
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed');
    return r.result.value;
  };
  await cdp.send('Page.enable');
  // 必须先导航到同源页面：about:blank 里 drawImage 跨域图会污染 canvas，getImageData 直接抛 SecurityError
  await cdp.send('Page.navigate', { url: BASE });
  await new Promise((r) => setTimeout(r, 1800));

  const geo = await ev(`(async()=>{
    const load=(f)=>new Promise((res,rej)=>{const i=new Image();
      i.src=${JSON.stringify(BASE)}+'textures/'+f+'?'+Math.random();
      i.onload=()=>res(i);i.onerror=rej;});
    const readImage=async(f)=>{
      const img=await load(f);
      const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
      const g=c.getContext('2d');g.drawImage(img,0,0);
      const d=g.getImageData(0,0,c.width,c.height).data;
      const dark=(x,y)=>{const i=(y*c.width+x)*4;return d[i]<90&&d[i+1]<90&&d[i+2]<90;};
      const runsX=(y,x0,x1)=>{const out=[];let s=null;
        for(let x=x0;x<=x1;x++){const v=dark(x,y);
          if(v&&s===null)s=x;
          if(!v&&s!==null){out.push([s,x-1]);s=null;}}
        if(s!==null)out.push([s,x1]);return out;};
      const runsY=(x,y0,y1)=>{const out=[];let s=null;
        for(let y=y0;y<=y1;y++){const v=dark(x,y);
          if(v&&s===null)s=y;
          if(!v&&s!==null){out.push([s,y-1]);s=null;}}
        if(s!==null)out.push([s,y1]);return out;};
      return {w:img.width,h:img.height,runsX,runsY};
    };
    const craft=await readImage('gui_crafting.png');
    const inv=await readImage('gui_inventory.png');
    // 3×3 网格：横穿第一行格子、竖穿第一列格子
    const gridRow=craft.runsX(20,20,120), gridCol=craft.runsY(32,10,80);
    // 产物格
    const outRow=craft.runsX(40,115,170);
    // 背包的 2×2
    const inv2Row=inv.runsX(30,90,140), inv2Col=inv.runsY(105,10,60);
    const invOut=inv.runsX(40,145,175);
    // 两个界面的物品栏/快捷栏（应完全一致）
    const invBar=inv.runsX(92,4,175), craftBar=craft.runsX(92,4,175);
    const invHot=inv.runsX(150,4,175), craftHot=craft.runsX(150,4,175);
    // 竖直方向：在格子内部（避开左边框）扫，只会命中每行的「上边框」（原版凹陷格
    // 左上深色、右下白色高光），所以每段起点就是该行的 top。
    return {craftSize:[craft.w,craft.h],invSize:[inv.w,inv.h],
      gridRow,gridCol,outRow,inv2Row,inv2Col,invOut,invBar,craftBar,invHot,craftHot,
      invBarY:inv.runsY(20,60,150),invHotY:inv.runsY(20,130,170),invOutY:inv.runsY(160,20,60),
      craftOutY:craft.runsY(126,20,64),craftBarY:craft.runsY(20,60,150),craftHotY:craft.runsY(20,130,170)};
  })()`);

  console.log(JSON.stringify(geo, null, 1));

  // 每格 18px，起点由第一段深色边框推出
  const first = (a) => (a && a.length ? a[0][0] : null);
  console.log('\n--- 结论（原图坐标；CSS 里要 ×2）---');
  console.log('工作台 3×3 左上:', first(geo.gridRow), first(geo.gridCol), '→ CSS', first(geo.gridRow) * 2, first(geo.gridCol) * 2);
  console.log('工作台产物格:', first(geo.outRow), '→ CSS x', first(geo.outRow) * 2);
  console.log('背包 2×2 左上:', first(geo.inv2Row), first(geo.inv2Col), '→ CSS', first(geo.inv2Row) * 2, first(geo.inv2Col) * 2);
  console.log('物品栏行起点:', first(geo.invBar), '→ CSS x', first(geo.invBar) * 2);
  console.log('快捷栏行起点:', first(geo.invHot), '→ CSS x', first(geo.invHot) * 2);

  cdp.close();
}
main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
