/**
 * PvZ WASM 版真实启动验证（CDP）
 * ---------------------------------------------------------------
 * 为什么不用 `chrome --headless --dump-dom`：
 *   它抓的是**加载完成瞬间**的 DOM 快照，之后 setTimeout / setInterval /
 *   rAF 都不再跑 —— 游戏还没画出第一帧就被抓走了，看起来像"没启动"，
 *   其实是抓早了（这个坑我踩过一次，白排查了很久）。
 *   --screenshot 同理，虚拟时间下截不到游戏画面。
 *
 * 这个脚本用 CDP 连一个真实的 Chrome（--headless=new 仍有完整运行时，
 * 定时器/rAF 正常走），真的等 45 秒，然后：
 *   ① 读页面状态：boot 是否隐藏、canvas 是否显示、错误区有没有内容
 *   ② 直接在页面上下文里 getImageData 量canvas 的非黑像素与颜色分布
 *   ③ 读 Emscripten 虚拟文件系统：/main.pak 实际大小、properties 内容
 *   ④ 收集 console 报错与未捕获异常
 *   ⑤ 截图存盘
 *
 * CDP 类实现沿用 tools/dev/cdp_capture.js（Node 22+ 内置全局 WebSocket，
 * 不需要装依赖）。
 *
 * 用法: node tools/dev/verify_pvz.js [url]
 * ───────────────────────────────────────────────────────────── */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9500 + (process.pid % 400);
const OUTDIR = "C:/Users/Administrator/WorkBuddy/2026-10-02-22-27-21";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let b = "";
      r.on("data", (d) => (b += d));
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

class CDP {
  constructor(ws, onEvent) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      if (onEvent) onEvent(m);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " timeout")); }
      }, 90000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  }
}

const STATE_JS = `(function () {
  var out = {};
  function $(id) { return document.getElementById(id); }
  var boot = $("boot"), cont = $("canvas-container"), cv = $("canvas");
  var pct = $("pct"), err = $("err");
  out.title = document.title;
  out.bootHidden = boot ? boot.style.display === "none" : null;
  out.contShown = cont ? cont.style.display === "flex" : null;
  out.progress = pct ? pct.textContent : null;
  out.errorText = err && err.style.display === "block"
    ? err.textContent.replace(/\\s+/g, " ").slice(0, 300) : null;
  out.canvasAttr = cv ? cv.width + "x" + cv.height : null;
  out.canvasCss = cv ? (cv.style.width + " x " + cv.style.height) : null;
  if (cv) {
    try {
      var d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      var nb = 0, colors = {};
      for (var i = 0; i < d.length; i += 4) {
        if (d[i] > 8 || d[i + 1] > 8 || d[i + 2] > 8) {
          nb++;
          var k = (d[i] >> 4) + "," + (d[i + 1] >> 4) + "," + (d[i + 2] >> 4);
          colors[k] = (colors[k] || 0) + 1;
        }
      }
      out.nonBlackPixels = nb;
      out.distinctColors = Object.keys(colors).length;
      out.totalPixels = cv.width * cv.height;
      out.coveragePct = +((nb / (cv.width * cv.height)) * 100).toFixed(2);
      out.topColors = Object.keys(colors)
        .sort(function (a, b) { return colors[b] - colors[a]; })
        .slice(0, 6).map(function (k) { return k + " x" + colors[k]; });
    } catch (e) { out.pixelErr = e.message; }
  }
  try { out.fsRoot = Module.FS.readdir("/").join(","); } catch (e) { out.fsErr = e.message; }
  try { out.pakSize = Module.FS.stat("/main.pak").size; } catch (e) { out.pakErr = e.message; }
  try { out.props = Module.FS.readdir("/properties").join(","); } catch (e) { out.propsErr = e.message; }
  return out;
})()`;

(async function main() {
  const profile = path.join(os.tmpdir(), "pvz-cdp-" + process.pid);
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile,
    "--window-size=1280,800", "about:blank",
  ], { stdio: "ignore" });

  let targets = null;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await httpJson("http://127.0.0.1:" + PORT + "/json/list");
      if (targets && targets.length) break;
    } catch (e) { /* 还没起来 */ }
    await sleep(500);
  }
  if (!targets || !targets.length) { console.error("Chrome 起不来"); process.exit(1); }

  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });

  const logs = [];
  const cdp = new CDP(ws, (m) => {
    if (m.method === "Runtime.consoleAPICalled") {
      const text = (m.params.args || [])
        .map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(" ");
      logs.push({ level: m.params.type, text: String(text).slice(0, 500) });
    }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails || {};
      logs.push({ level: "exception", text: String(d.text || "") + " " +
        ((d.exception && d.exception.description) || "").slice(0, 500) });
    }
  });

  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  console.log("打开:", URL_);
  await cdp.send("Page.navigate", { url: URL_ });

  // 真实等待：下载 44MB 素材 + 编译 7MB wasm + pak 合并 + 游戏启动
  const WAIT = 50000;
  process.stdout.write("等待游戏启动");
  for (let i = 0; i < WAIT / 5000; i++) { await sleep(5000); process.stdout.write("."); }
  console.log("");

  let state = null, evalErr = null;
  try { state = await cdp.eval(STATE_JS); } catch (e) { evalErr = e.message; }

  let shotPath = null;
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    if (shot && shot.data) {
      shotPath = path.join(OUTDIR, "pvz_verify.png");
      fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
    }
  } catch (e) { logs.push({ level: "screenshot-fail", text: e.message }); }

  const result = { url: URL_, waitedMs: WAIT, state, evalErr, logs: logs.slice(-50), shotPath };
  fs.writeFileSync(path.join(OUTDIR, "pvz_verify.json"), JSON.stringify(result, null, 2));

  console.log("\n=== 页面状态 ===");
  console.log(JSON.stringify(state, null, 2));
  if (evalErr) console.log("eval 失败:", evalErr);
  console.log("\n=== 控制台（最后 25 条）===");
  logs.slice(-25).forEach((l) => console.log("[" + l.level + "]", l.text));
  if (shotPath) console.log("\n截图:", shotPath);

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})();
