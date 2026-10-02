// 诊断：钩住空间页自己的 fetch/XHR，捕获 arc/search 的真实请求 URL 与响应体。
// 目的：搞清「点第 3 页时活动页码变了、列表却不刷新」到底是请求失败还是被风控挡回。
// 用法: node tools/dev/cdp_capture.js
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9335;
const MID = 1220210222;
const PROFILE = path.join(__dirname, "..", ".cache", "chrome-cdp-cap");
const OUTDIR = path.join(__dirname, "_shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " timeout")); } }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
}

// 在页面 JS 之前注入：记录所有 arc/search 的 URL 与响应
const HOOK = `(() => {
  if (window.__CAP__) return;
  window.__CAP__ = [];
  const KEEP = ['arc/search', 'seasons', 'relation/stat', 'acc/info'];
  function keep(u){ return u && KEEP.some(k => String(u).indexOf(k) >= 0); }
  const of = window.fetch;
  window.fetch = function(...args) {
    let u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    const p = of.apply(this, args);
    if (keep(u)) {
      p.then(r => { r.clone().text().then(t => window.__CAP__.push({ url: u, status: r.status, body: t.slice(0, 3000) })).catch(()=>{}); }).catch(()=>{});
    }
    return p;
  };
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) { this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function() {
    if (keep(this.__u)) {
      this.addEventListener('load', () => { try { window.__CAP__.push({ url: this.__u, status: this.status, body: String(this.responseText).slice(0, 3000) }); } catch (e) {} });
    }
    return os.apply(this, arguments);
  };
})()`;

const STATE = `(() => {
  const cards = [...document.querySelectorAll('.upload-video-card')];
  const bvs = cards.map(c => { const a = c.querySelector('a[href*="/video/BV"]'); return a ? (a.getAttribute('href').match(/BV[0-9A-Za-z]{10}/)||[''])[0] : ''; }).filter(Boolean);
  const active = document.querySelector('.vui_pagenation--btn-num.vui_button--active');
  return { active: active ? active.textContent.trim() : '', n: bvs.length, first: bvs[0]||'', bvs };
})()`;

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1400,3000", "about:blank",
  ], { stdio: "ignore" });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`); if (targets && targets.length) break; } catch (e) {}
    await sleep(500);
  }
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });

  // 加载到有卡片为止
  let st = null;
  for (let a = 1; a <= 8 && !st; a++) {
    await cdp.send("Page.navigate", { url: `https://space.bilibili.com/${MID}/video` });
    await sleep(2500);
    for (let i = 0; i < 25; i++) {
      const s = await cdp.eval(STATE);
      if (s && s.n) { st = s; break; }
      await sleep(800);
    }
    if (!st) console.log(`(第 ${a} 次加载失败，重试)`);
  }
  if (!st) { console.log("页 1 始终加载不出来"); chrome.kill(); return; }
  console.log(`[页1] 活动页=${st.active} 卡片=${st.n} 首=${st.first}`);

  let cap = await cdp.eval("window.__CAP__ || []");
  console.log(`\n捕获到 ${cap.length} 条请求：`);
  cap.forEach((c, i) => {
    console.log(`  [${i}] status=${c.status} ${String(c.url).slice(0, 110)}`);
    console.log(`      body: ${String(c.body).slice(0, 160)}`);
  });
  fs.writeFileSync(path.join(OUTDIR, "cap_page1.json"), JSON.stringify(cap, null, 2), "utf8");

  // 点第 2 页
  console.log("\n=== 点击第 2 页 ===");
  await cdp.eval(`(() => { const b=[...document.querySelectorAll('.vui_pagenation--btn-num')].find(x=>x.textContent.trim()==='2'); if(b) b.click(); return !!b; })()`);
  await sleep(6000);
  let s2 = await cdp.eval(STATE);
  console.log(`活动页=${s2.active} 卡片=${s2.n} 首=${s2.first}`);

  // 点第 3 页
  console.log("\n=== 点击第 3 页 ===");
  await cdp.eval(`(() => { const b=[...document.querySelectorAll('.vui_pagenation--btn-num')].find(x=>x.textContent.trim()==='3'); if(b) b.click(); return !!b; })()`);
  await sleep(9000);
  let s3 = await cdp.eval(STATE);
  console.log(`活动页=${s3.active} 卡片=${s3.n} 首=${s3.first}`);

  cap = await cdp.eval("window.__CAP__ || []");
  console.log(`\n共捕获 ${cap.length} 条请求：`);
  cap.forEach((c, i) => {
    const m = String(c.url).match(/[?&]pn=(\d+)/);
    console.log(`  [${i}] pn=${m ? m[1] : '?'} status=${c.status} body=${String(c.body).slice(0, 120)}`);
  });
  fs.writeFileSync(path.join(OUTDIR, "cap_all.json"), JSON.stringify(cap, null, 2), "utf8");
  console.log("\n已写入 tools/dev/_shots/cap_page1.json 与 cap_all.json");

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
}

main().catch((e) => { console.error("失败: " + e.message); process.exit(1); });
