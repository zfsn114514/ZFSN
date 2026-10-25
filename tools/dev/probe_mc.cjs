/* 最小探针：定位 evaluate 卡在哪一步 */
const http = require('node:http');
const PORT = Number(process.env.CDP_PORT || 9401);
const URL_ = process.env.MC_URL || 'http://127.0.0.1:8900/minecraft/';
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let s = ''; r.on('data', (c) => s += c); r.on('end', () => res(JSON.parse(s))); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const page = (await get('/json/list')).find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) events.push(m);
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}, ms = 8000) => new Promise((res, rej) => {
    const mid = ++id;
    const t = setTimeout(() => { pending.delete(mid); rej(new Error(`TIMEOUT ${method} ${params.expression?.slice(0, 60) || ''}`)); }, ms);
    pending.set(mid, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  console.log('导航…');
  await send('Page.navigate', { url: URL_ });
  await sleep(3000);
  const ev = async (label, expr) => {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) console.log(label, 'THROW', r.exceptionDetails.exception?.description?.split('\n')[0]);
      else console.log(label, '=', JSON.stringify(r.result.value));
      return r.result.value;
    } catch (e) { console.log(label, 'ERR', e.message); }
  };
  await ev('title', `document.title`);
  await ev('fonts', `document.fonts.check('16px MCBitmap')`);
  await ev('click#play', `document.querySelector('#play').click(), 'ok'`);
  await sleep(300);
  await ev('formVisible', `!document.querySelector('#new-world').hidden`);
  await ev('setSeed', `(()=>{document.querySelector('#seed').value='ZFSN-CHECK';return 'ok'})()`);
  console.log('提交表单…');
  await ev('submit', `document.querySelector('#new-world').requestSubmit(), 'ok'`);
  await sleep(2500);
  await ev('playing', `window.zfsnMC && window.zfsnMC.playing`);
  await ev('mobs', `window.zfsnMC.world.mobs.length`);
  await ev('rafAlive', `new Promise(r=>requestAnimationFrame(()=>r('raf ok')))`);
  const errs = events.filter((e) => e.method === 'Runtime.exceptionThrown');
  console.log('异常数', errs.length);
  for (const e of errs.slice(0, 5)) console.log('  !', e.params.exceptionDetails?.exception?.description?.split('\n')[0]);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
