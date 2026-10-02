// 临时探针：看看 /admin 在无头浏览器里到底卡在哪一步
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const BASE = process.argv[2] || "http://127.0.0.1:3100";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9342;
const PROFILE = path.join(__dirname, "..", ".cache", "chrome-cdp-probe");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
  });
}
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } }; }
  send(method, params = {}) { const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " timeout")); } }, 30000); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: JSON.stringify(r.exceptionDetails).slice(0, 400) };
    return r.result && r.result.value; }
}

(async () => {
  const lg = await fetch(BASE + "/api/admin/login", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.ADMIN_PASSWORD || "zfsn114514." }) }).then((r) => r.json());
  console.log("token:", lg.token ? lg.token.slice(0, 12) + "…" : lg);

  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox",
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1400,1100", "about:blank"], { stdio: "ignore" });
  let targets = null;
  for (let i = 0; i < 40; i++) { try { targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`); if (targets && targets.length) break; } catch (e) {} await sleep(500); }
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable");

  const logs = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.type + ": " + (m.params.args || []).map((a) => a.value || a.description || "").join(" "));
    if (m.method === "Runtime.exceptionThrown") logs.push("EXC: " + JSON.stringify(m.params.exceptionDetails).slice(0, 300));
  });

  await cdp.send("Page.navigate", { url: BASE + "/admin" });
  await sleep(2000);
  console.log("URL:", await cdp.eval("location.href"));
  console.log("setToken:", await cdp.eval(`localStorage.setItem('zfsn_admin_token', ${JSON.stringify(lg.token)}); localStorage.getItem('zfsn_admin_token').slice(0,10)`));
  await cdp.send("Page.navigate", { url: BASE + "/admin" });
  await sleep(3500);
  console.log("URL:", await cdp.eval("location.href"));
  console.log("typeof WORKS:", await cdp.eval("typeof WORKS"));
  console.log("typeof openWorkForm:", await cdp.eval("typeof openWorkForm"));
  console.log("WORKS.length:", await cdp.eval("(typeof WORKS!=='undefined') ? WORKS.length : 'n/a'"));
  console.log("API_BASE:", await cdp.eval("typeof API_BASE!=='undefined' ? JSON.stringify(API_BASE) : 'n/a'"));
  console.log("login visible?:", await cdp.eval(`(()=>{const l=document.querySelector('#login'); return l? (l.className||'') : 'no #login';})()`));
  console.log("app visible?:", await cdp.eval(`(()=>{const a=document.querySelector('#app'); return a? (a.className||'') : 'no #app';})()`));
  console.log("body classes:", await cdp.eval("document.body.className"));
  console.log("check result:", await cdp.eval(`fetch('/api/admin/check',{headers:{'X-Admin-Token':localStorage.getItem('zfsn_admin_token')}}).then(r=>r.text())`));
  console.log("\n--- console ---"); logs.slice(0, 25).forEach((l) => console.log("  " + l));

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
})();
