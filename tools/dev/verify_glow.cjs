/**
 * 首页光圈跟随定位验证（CDP）
 * ─────────────────────────────────────────────────────────────
 * bug 现象：光圈不跟随鼠标正中央，而是偏到鼠标右下角。
 *
 * 根因不在 JS，而在 CSS 居中方式。`.glow` 是 620×620 的 fixed 元素，
 * JS 每帧写 `transform: translate3d(客户端X, 客户端Y, 0)`。要让圆心对准鼠标，
 * 必须再减掉自身尺寸的一半（310px）。原先这个抵消写在了
 * `transform: translate(-50%,-50%)` 里，后来为了性能把它去掉、改用
 * margin 居中 —— 但 margin 那一步没落地，CSS 里既没有
 * `translate(-50%,-50%)` 也没有 `margin`，于是左上角贴住鼠标，
 * 圆心偏到右下 310px。
 *
 * 这个脚本怎么测：
 *   只看"光圈矩形的几何中心"和"鼠标坐标"是否一致。
 *   元素中心 = getBoundingClientRect() 的 left+width/2、top+height/2。
 *   用 getBoundingClientRect 而不是算 transform，是因为它反映的是
 *   浏览器**最终合成后的位置**，margin / transform / 缩放全都算在内 ——
 *   正好是用户看到的位置。
 *
 * 顺带覆盖：初始位置（鼠标没动时应在视口中心）、缓动收敛后是否精确对齐。
 *
 * 用法: node tools/dev/verify_glow.cjs [url]
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/index.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9700 + (process.pid % 400);
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
      }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
  async moveMouse(x, y) {
    for (const type of ["mouseMoved"]) {
      await this.send("Input.dispatchMouseEvent", { type, x, y, button: "none" });
    }
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (r && r.data) {
      const p = path.join(OUTDIR, name);
      fs.writeFileSync(p, Buffer.from(r.data, "base64"));
      return p;
    }
  }
}

/* 量光圈几何中心相对鼠标的偏移 */
const GLOW_JS = `(function () {
  var g = document.getElementById("glow");
  if (!g) return { err: "找不到 #glow" };
  var r = g.getBoundingClientRect();
  var cs = getComputedStyle(g);
  return {
    left: +r.left.toFixed(1), top: +r.top.toFixed(1),
    w: +r.width.toFixed(1), h: +r.height.toFixed(1),
    centerX: +(r.left + r.width / 2).toFixed(1),
    centerY: +(r.top + r.height / 2).toFixed(1),
    margin: cs.margin,
    transform: cs.transform,
    opacity: cs.opacity,
    vw: innerWidth, vh: innerHeight,
  };
})()`;

(async function main() {
  const profile = path.join(os.tmpdir(), "glow-cdp-" + process.pid);
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile,
    "--window-size=1280,800", "about:blank",
  ], { stdio: "ignore" });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      const t = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = t.find((x) => x.type === "page");
      if (page) { targets = page; break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(300);
  }
  if (!targets) {
    console.error("Chrome 没起来");
    chrome.kill();
    process.exit(1);
  }

  const ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const logs = [];
  const cdp = new CDP(ws, (m) => {
    if (m.method === "Runtime.consoleAPICalled" || m.method === "Runtime.exceptionThrown") {
      logs.push(m);
    }
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  console.log("打开:", URL_);
  await cdp.send("Page.navigate", { url: URL_ });
  await sleep(3500);

  // 记录最后一次派发的鼠标坐标，供对比
  let mx = 0, my = 0;

  console.log("\n=== ① 初始位置（鼠标未移动，应在视口中心）===");
  const init = await cdp.eval(GLOW_JS);
  if (init.err) { console.error(init.err); chrome.kill(); process.exit(1); }
  console.log("  视口:", init.vw + "x" + init.vh);
  console.log("  光圈 rect:", `left=${init.left} top=${init.top} ${init.w}x${init.h}`);
  console.log("  光圈中心:", `(${init.centerX}, ${init.centerY})`);
  console.log("  应在视口中心:", `(${(init.vw / 2).toFixed(1)}, ${(init.vh / 2).toFixed(1)})`);
  console.log("  margin:", init.margin);
  const initDX = init.centerX - init.vw / 2;
  const initDY = init.centerY - init.vh / 2;
  console.log("  初始偏差:", `${initDX.toFixed(1)}, ${initDY.toFixed(1)}`);

  const cases = [
    [300, 250],
    [640, 400],
    [900, 300],
    [400, 620],
  ];
  let allOK = true;
  console.log("\n=== ② 跟随精度（等缓动收敛后比对）===");
  console.log("  鼠标位置".padEnd(18), "光圈中心".padEnd(20), "偏差".padEnd(20), "判定");
  for (const [px, py] of cases) {
    mx = px; my = py;
    await cdp.moveMouse(px, py);
    await sleep(2200);   // 缓动系数 .12，约 1.5s 收敛到亚像素
    const g = await cdp.eval(GLOW_JS);
    const dx = g.centerX - px;
    const dy = g.centerY - py;
    // 容差 3px：收敛是渐近的，且 toFixed(1) 本身有舍入
    const ok = Math.abs(dx) <= 3 && Math.abs(dy) <= 3;
    if (!ok) allOK = false;
    console.log(
      `  (${px}, ${py})`.padEnd(18),
      `(${g.centerX}, ${g.centerY})`.padEnd(20),
      `(${dx.toFixed(1)}, ${dy.toFixed(1)})`.padEnd(20),
      ok ? "OK" : "★偏移"
    );
  }

  const shot = await cdp.shot("glow_fixed.png");

  console.log("\n=== 结论 ===");
  const initOK = Math.abs(initDX) <= 3 && Math.abs(initDY) <= 3;
  console.log("初始居中:", initOK ? "OK" : `★偏差 ${initDX.toFixed(1)},${initDY.toFixed(1)}`);
  console.log("跟随精度:", allOK ? "全部 OK（光圈圆心与鼠标重合）" : "★存在偏移");
  if (shot) console.log("截图:", shot);

  try { ws.close(); } catch (e) {}
  chrome.kill();
  process.exit(allOK && initOK ? 0 : 1);
})();
