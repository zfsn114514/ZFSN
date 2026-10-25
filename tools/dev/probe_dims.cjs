// 诊断：确认浏览器里跑的是新代码，并 dump 目标列的方块
const PORT = process.env.CDP_PORT || 9333;
const BASE = (process.env.MC_URL || 'http://127.0.0.1:8931/minecraft/').replace(/\/$/, '/');

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || 'eval failed');
    return r.result.value;
  };

  await send('Page.enable');
  await send('Page.navigate', { url: BASE });
  await new Promise((r) => setTimeout(r, 2000));
  await ev('localStorage.clear(); true');
  await new Promise((r) => setTimeout(r, 200));

  const boot = await ev(`(()=>{const w=window.zfsnMC.world;
    return {seed:w.seed,dims:[w.surface.length,w.blocks.length/w.surface.length],
      weather:w.weather,hasNatural:!!w.natural,
      water:w.blocks.reduce((n,v)=>n+(v===17?1:0),0)};})()`);
  console.log('boot world:', JSON.stringify(boot));

  await ev(`document.querySelector('#play').click()`);
  await new Promise((r) => setTimeout(r, 200));
  await ev(`(()=>{document.querySelector('#seed').value='ZFSN-CHECK';})()`);
  await ev(`document.querySelector('#new-world').requestSubmit()`);
  await new Promise((r) => setTimeout(r, 2000));

  const info = await ev(`(()=>{const w=window.zfsnMC.world;
    const col=[];for(let y=44;y<=66;y++)col.push(y+':'+w.get(60,y));
    return {seed:w.seed,surface60:w.surface[60],water:w.blocks.reduce((n,v)=>n+(v===17?1:0),0),col};})()`);
  console.log('after create:', JSON.stringify(info, null, 1));

  const fresh = await ev(`(async()=>{
    const m=await import('./game.8977be1d.js');
    const w2=new m.World('ZFSN-CHECK','survival');
    const col=[];for(let y=44;y<=66;y++)col.push(y+':'+w2.get(60,y));
    return {surface60:w2.surface[60],water:w2.blocks.reduce((n,v)=>n+(v===17?1:0),0),col};
  })()`);
  console.log('fresh World:', JSON.stringify(fresh, null, 1));

  ws.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
