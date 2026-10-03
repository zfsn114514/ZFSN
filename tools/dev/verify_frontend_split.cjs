// 前端拆分后的渲染验证：内嵌静态服务 + headless Chrome，检查 JS 报错与资源加载。
// 用法: node tools/dev/.render_check.cjs
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const ROOT = path.resolve(__dirname, "..", "..");
const PORT = 9411;
const HTTP_PORT = 8300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
  ".jpg": "image/jpeg", ".png": "image/png", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml" };

function httpJson(url) {
  return new Promise((res, rej) => {
    const q = http.get(url, (r) => { let b = ""; r.on("data", (d) => (b += d));
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } }); });
    q.on("error", rej);
    q.setTimeout(5000, () => q.destroy(new Error("timeout")));
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on("message", (raw) => {
      let d = raw; if (typeof d !== "string") { try { d = Buffer.from(d).toString("utf8"); } catch (_) { return; } }
      let m; try { m = JSON.parse(d); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
  }
  send(method, params) {
    return new Promise((r) => { const id = ++this.id; this.pending.set(id, r);
      this.ws.send(JSON.stringify({ id, method, params })); });
  }
}

(async () => {
  // ① 内嵌静态服务（避开沙箱里可能被占用的 8000/8199）
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404); return res.end("not found");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => srv.listen(HTTP_PORT, "127.0.0.1", r));
  console.log("静态服务 :" + HTTP_PORT);

  // ② 起 headless Chrome
  const profile = path.join(__dirname, ".cdp-tmp");
  fs.rmSync(profile, { recursive: true, force: true });
  const ch = spawn(CHROME, ["--headless=new", "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile, "--no-first-run", "--disable-gpu",
    "--window-size=1440,900", "about:blank"], { stdio: "ignore" });
  await sleep(3500);

  const ver = await httpJson(`http://127.0.0.1:${PORT}/json/version`);
  const bws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => bws.on("open", r));
  const browser = new CDP(bws);
  const t = await browser.send("Target.createTarget", { url: "about:blank" });
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const tp = list.find((x) => x.id === t.result.targetId);
  const pws = new WebSocket(tp.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => pws.on("open", r));
  const page = new CDP(pws);

  const errs = [], reqs = [], fails = [];
  pws.on("message", (raw) => {
    let d = raw; if (typeof d !== "string") { try { d = Buffer.from(d).toString("utf8"); } catch (_) { return; } }
    let m; try { m = JSON.parse(d); } catch (_) { return; }
    if (m.method === "Runtime.exceptionThrown") {
      const dd = m.params.exceptionDetails;
      errs.push(dd.exception && dd.exception.description ? dd.exception.description.split("\n")[0] : dd.text);
    }
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") errs.push("[log] " + m.params.entry.text);
    if (m.method === "Network.requestWillBeSent") reqs.push(m.params.request.url);
    if (m.method === "Network.loadingFailed") fails.push(m.params.errorText + " | " + (m.params.requestId||""));
    if (m.method === "Network.responseReceived" && m.params.response.status >= 400) fails.push("HTTP "+m.params.response.status+" "+m.params.response.url);
  });

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Network.enable");
  await page.send("Page.navigate", { url: `http://127.0.0.1:${HTTP_PORT}/` });
  await sleep(7000);

  const expr = `(function(){
    var imgs=[].slice.call(document.images);
    return JSON.stringify({
      title: document.title,
      scripts: [].slice.call(document.querySelectorAll('script[src]')).map(function(s){return s.getAttribute('src')}),
      hasZFSN: typeof window.ZFSN,
      hasApi: !!(window.ZFSN && window.ZFSN.api),
      navLinks: document.querySelectorAll('.nav a').length,
      cards: document.querySelectorAll('.card').length,
      galleryItems: document.querySelectorAll('.gitem').length,
      imgsTotal: imgs.length,
      imgsNoDim: imgs.filter(function(i){return !i.getAttribute('width')||!i.getAttribute('height')}).length,
      bodyH: document.body.scrollHeight
    });
  })()`;
  const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true });
  const val = r && r.result && r.result.result ? r.result.result.value : "(无返回值)";
  console.log("\n=== 渲染结果 ===");
  try { console.log(JSON.stringify(JSON.parse(val), null, 1)); } catch (_) { console.log(val); }

  console.log("\n=== JS 错误 (" + errs.length + ") ===");
  errs.slice(0, 10).forEach((e) => console.log("  x " + e));
  console.log("\n=== 网络 ===");
  console.log("  失败:", fails.length ? fails.join(", ") : "无");
  console.log("  app.js 被请求:", reqs.some((u) => u.indexOf("app.js") >= 0));
  console.log("  danmaku.js 被请求:", reqs.some((u) => u.indexOf("danmaku.js") >= 0));

  pws.close(); bws.close(); ch.kill();
  srv.close();
  fs.rmSync(profile, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error("验证失败:", e.message); process.exit(2); });
