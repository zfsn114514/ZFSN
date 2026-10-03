/**
 * 诊断：canvas 坐标映射 + 点击到底有没有被游戏收到
 * ─────────────────────────────────────────────────────────────
 * 为什么要查：
 *   verify_cheat_real 换了正确坐标后，主菜单画面**依然没变化**
 *   （cr_04/cr_06 截图都还停在 WELCOME BACK 主菜单）。
 *   坐标算过是对的（游戏坐标 528,121 → 页面坐标），
 *   所以问题只可能在两头之一：
 *     A. canvas.getBoundingClientRect() 和截图里的实际位置对不上
 *        （headless 窗口 1280x800，但截图只有 1080x547 ——
 *         说明有 DPR 缩放或视口差异，rect 和截图不是同一套坐标）
 *     B. CDP 的 Input.dispatchMouseEvent 没进到游戏
 *        （游戏用 Emscripten 的 mousemove/mousedown 回调，
 *         如果监听挂在 canvas 上而事件没命中 canvas，就直接丢了）
 *
 *   验证办法：
 *     · 打印 rect / devicePixelRatio / innerWidth/Height，和截图尺寸对照
 *     · 在页面上装 mousemove/mousedown 探针，派发点击看事件到没到
 *     · 用 Emulation.setDeviceMetricsOverride 强制视口，
 *       让截图坐标系 == 页面坐标系，消除歧义
 *
 * 用法: node tools/dev/diag_click.cjs [url]
 */
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
      }, 120000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("JS err " + (d.exception ? d.exception.description : d.text).slice(0, 500));
    }
    return r.result && r.result.value;
  }
  async click(x, y) {
    /* ⚠ 关键：Input.dispatchMouseEvent 默认不带按钮信息之外的细节，
     *   而且必须显式给出 button/clickCount，否则游戏可能当成移动事件。
     *   还要先 move 再 press，模拟真实移动-点击序列。 */
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await sleep(120);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
    });
    await sleep(80);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(500);
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (r && r.data) { fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, "base64")); }
  }
}

(async function main() {
  const profile = path.join(os.tmpdir(), "pvz-click-" + process.pid);
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + profile,
    "--window-size=1280,800", "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 60; i++) {
    try {
      const t = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      const page = t.find((x) => x.type === "page");
      if (page) { target = page; break; }
    } catch (e) { /* 等 */ }
    await sleep(300);
  }
  if (!target) { console.error("Chrome 没起来"); chrome.kill(); process.exit(1); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws, (m) => {
    if (m.method === "Page.javascriptDialogOpening") {
      cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    }
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  console.log("打开:", URL_);
  await cdp.send("Page.navigate", { url: URL_ });

  console.log("等游戏加载…");
  let booted = false;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const st = await cdp.eval(`(function(){
      var b=document.getElementById("boot");
      return { hidden: !!(b && b.style.display==="none") };
    })()`).catch(() => null);
    if (st && st.hidden) { booted = true; break; }
  }
  if (!booted) { console.error("没启动成功"); chrome.kill(); process.exit(1); }
  console.log("游戏已启动");
  await sleep(4000);

  /* ── 关键对照：视口 / DPR / rect / 截图尺寸 ── */
  const geo = await cdp.eval(`(function(){
    var c=document.getElementById("canvas");
    var r=c.getBoundingClientRect();
    return {
      innerW: window.innerWidth, innerH: window.innerHeight,
      dpr: window.devicePixelRatio,
      screenW: screen.width, screenH: screen.height,
      rect: { x:r.left, y:r.top, w:r.width, h:r.height },
      attr: { w:c.width, h:c.height },
      style: { w:c.style.width, h:c.style.height },
    };
  })()`);
  console.log("\n=== 视口与 canvas 几何 ===");
  console.log(JSON.stringify(geo, null, 2));

  const metrics = await cdp.send("Page.getLayoutMetrics").catch(() => null);
  if (metrics) {
    console.log("\n=== Page.getLayoutMetrics ===");
    const csm = metrics.cssLayoutViewport || metrics.layoutViewport;
    const cvm = metrics.cssContentSize || metrics.contentSize;
    console.log("  cssLayoutViewport:", JSON.stringify(csm));
    console.log("  cssContentSize:   ", JSON.stringify(cvm));
  }

  // 装探针：看点击事件落在哪个元素上
  await cdp.eval(`(function () {
    window.__clicks = [];
    var c = document.getElementById("canvas");
    ["mousemove","mousedown","mouseup","click"].forEach(function (t) {
      c.addEventListener(t, function (e) {
        window.__clicks.push({ type: t, x: e.clientX, y: e.clientY,
                               offX: e.offsetX, offY: e.offsetY, target: e.target.id || e.target.tagName });
      }, true);
    });
    return true;
  })()`);

  // 建号
  const toPage = (gx, gy) => ({
    x: geo.rect.x + (gx / geo.attr.w) * geo.rect.w,
    y: geo.rect.y + (gy / geo.attr.h) * geo.rect.h,
  });

  console.log("\n=== 建号 ===");
  let p = toPage(400, 514);
  console.log("CLICK TO START @ 页面坐标", JSON.stringify(p));
  await cdp.click(p.x, p.y);
  await sleep(5000);
  let clicks = await cdp.eval("JSON.stringify(window.__clicks)");
  console.log("  收到事件:", clicks);

  await cdp.eval(`(function(){var i=document.getElementById("pvz-soft-keyboard"); if(i)i.focus(); return true;})()`);
  for (const ch of "zfsn") {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: ch, code: "Key" + ch.toUpperCase(), text: ch, unmodifiedText: ch,
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    });
    await sleep(50);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: ch, code: "Key" + ch.toUpperCase(),
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    });
    await sleep(400);
  }
  await sleep(1500);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(60);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Enter", code: "Enter",
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });
  await sleep(7000);
  await cdp.shot("click_01_menu.png");

  await cdp.eval("window.__clicks = []");

  console.log("\n=== 点 START ADVENTURE ===");
  p = toPage(528, 121);
  console.log("  目标页面坐标:", JSON.stringify(p));
  await cdp.click(p.x, p.y);
  await sleep(3000);
  clicks = await cdp.eval("JSON.stringify(window.__clicks)");
  console.log("  收到事件:", clicks);
  await cdp.shot("click_02_after.png");

  // 换算：事件到达 canvas 时的 offsetX/offsetY 是多少？
  const parsed = JSON.parse(clicks);
  const down = parsed.find((c) => c.type === "mousedown");
  if (down) {
    console.log("\n=== 事件在 canvas 内的位置 ===");
    console.log(`  offsetX=${down.offX} offsetY=${down.offY}  (游戏内部坐标应约等于这个)`);
    console.log(`  期望 ≈ 528,121   偏差 dx=${down.offX - 528} dy=${down.offY - 121}`);
  } else {
    console.log("\n⚠ canvas 上根本没收到 mousedown —— 点击没进游戏！");
  }

  await sleep(8000);
  await cdp.shot("click_03_final.png");

  try { ws.close(); } catch (e) {}
  chrome.kill();
})();
