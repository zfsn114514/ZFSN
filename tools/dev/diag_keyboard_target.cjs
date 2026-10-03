/**
 * 诊断：WASM 版 PvZ 的键盘事件到底绑在哪个 target 上
 * ─────────────────────────────────────────────────────────────
 * 为什么要查这个：
 *   「通关存档」按钮靠输入官方作弊码 `future` 来解锁。
 *   之前用 document.dispatchEvent(new KeyboardEvent(...)) 无效，
 *   用 CDP Input.dispatchKeyEvent 也无效（被软键盘 textarea 截走）。
 *
 *   读了 Emscripten glue 后发现它有三条键盘通道：
 *     · 软键盘 textarea（只服务游戏内的文本框，比如建号输名字）
 *     · registerKeyEventCallback → keydown/keypress/keyup
 *       绑到 findEventTarget(target)，target 可能是
 *       #document / #window / #screen / 具体选择器
 *     · Emscripten 默认还会往 canvas 上挂一批监听
 *   作弊码走的是**第二条**（游戏主循环的键盘处理），不是软键盘。
 *   所以必须知道它到底绑在哪，才能用对的派发目标。
 *
 * 做法：注入探针，遍历所有可能的 target 试派发，
 *      同时用 getEventListeners（只在 DevTools 可用）交叉验证。
 *
 * 用法: node tools/dev/diag_keyboard_target.cjs [url]
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9700 + (process.pid % 200);
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
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error("JS err " + (d.exception ? d.exception.description : d.text).slice(0, 400));
    }
    return r.result && r.result.value;
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

/* ── 探针 1：Emscripten 内部事件表 ──
 * glue 是闭包，JSEvents 拿不到。但 registerKeyEventCallback 会把
 * handler 塞进 JSEvents.eventHandler.xxxByTarget。拿不到就退而
 * 求其次：直接在候选 target 上装捕获阶段探针，看事件能否到达。
 */
const PROBE_JS = `(function () {
  var canvas = document.getElementById("canvas");
  var soft = document.getElementById("pvz-soft-keyboard");
  var targets = {
    window: window,
    document: document,
    canvas: canvas,
    softKeyboard: soft,
    body: document.body,
  };
  window.__kbHits = {};
  Object.keys(targets).forEach(function (name) {
    var t = targets[name];
    if (!t) { window.__kbHits[name] = "no-target"; return; }
    window.__kbHits[name] = 0;
    ["keydown", "keypress", "keyup"].forEach(function (evt) {
      t.addEventListener(evt, function () { window.__kbHits[name]++; }, true);
    });
  });
  return { targets: Object.keys(targets).filter(function (k) { return !!targets[k]; }) };
})()`;

/* 派发一个 'f'，看哪些 target 的捕获探针计数涨了 */
const DISPATCH_JS = `(function (where) {
  var t = where === "window" ? window
        : where === "document" ? document
        : document.getElementById(where);
  if (!t) return { ok: false, err: "no target " + where };
  var hits = {};
  ["keydown", "keypress", "keyup"].forEach(function (evt) {
    var ev;
    try {
      ev = new KeyboardEvent(evt, {
        key: "f", code: "KeyF", keyCode: 70, which: 70,
        charCode: evt === "keypress" ? 102 : 0,
        bubbles: true, cancelable: true,
      });
    } catch (e) { return; }
    var got = false;
    var probe = function () { got = true; };
    t.addEventListener(evt, probe, false);
    var ok = t.dispatchEvent(ev);
    t.removeEventListener(evt, probe, false);
    hits[evt] = { dispatched: ok, seenAtTarget: got, defaultPrevented: ev.defaultPrevented };
  });
  return { where: where, hits: hits };
})`;

(async function main() {
  const profile = path.join(os.tmpdir(), "pvz-kbdiag-" + process.pid);
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
    } catch (e) { /* 还没起来 */ }
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
  await cdp.send("DOM.enable");
  await cdp.send("Log.enable").catch(() => {});

  console.log("打开:", URL_);
  await cdp.send("Page.navigate", { url: URL_ });

  console.log("等游戏加载…");
  let booted = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await cdp.eval(`(function(){
      var b=document.getElementById("boot");
      return { hidden: !!(b && b.style.display==="none"),
               pct: (document.getElementById("pct")||{}).textContent };
    })()`).catch(() => null);
    if (st && st.hidden) { booted = true; break; }
    if (i % 5 === 0) console.log(`  +${(i+1)*2}s`, JSON.stringify(st));
  }
  if (!booted) { console.error("游戏没启动成功"); await cdp.shot("kbdiag_fail.png"); chrome.kill(); process.exit(1); }
  console.log("游戏已启动");
  await sleep(3000);

  // 先用 CDP 原生 API 列出所有 keydown 监听器（DevTools 专用接口）
  console.log("\n=== CDP DOMDebugger 视角：谁注册了 keydown ===");
  try {
    const { objectGroup } = await cdp.send("Runtime.evaluate", { expression: "window" });
    const listeners = await cdp.send("DOMDebugger.getEventListeners", {
      objectId: objectGroup.objectId || (await cdp.send("Runtime.evaluate", { expression: "window" })).result.objectId,
      depth: 2,
    }).catch((e) => ({ error: String(e) }));
    console.log("window keydown 监听器:", (listeners.listeners || []).length);
    (listeners.listeners || []).forEach((l) => {
      console.log(`  type=${l.type} useCapture=${l.useCapture} passive=${l.passive} line=${l.lineNumber}`);
    });
  } catch (e) {
    console.log("  (getEventListeners 不可用:", e.message + ")");
  }

  // 同样看 document 和 canvas
  for (const expr of ["document", "document.getElementById('canvas')", "document.getElementById('pvz-soft-keyboard')"]) {
    try {
      const r = await cdp.send("Runtime.evaluate", { expression: expr });
      if (!r.result || !r.result.objectId) { console.log(`\n${expr}: 无 objectId`); continue; }
      const ls = await cdp.send("DOMDebugger.getEventListeners", {
        objectId: r.result.objectId, depth: 2,
      });
      const kd = (ls.listeners || []).filter((l) => /key|input/.test(l.type));
      console.log(`\n${expr} 的键盘/输入监听器: ${kd.length}`);
      kd.forEach((l) => console.log(`  type=${l.type} useCapture=${l.useCapture} line=${l.lineNumber}`));
      await cdp.send("Runtime.releaseObject", { objectId: r.result.objectId });
    } catch (e) {
      console.log(`\n${expr}: ${e.message}`);
    }
  }

  // 实际派发测试
  console.log("\n=== 派发测试：'f' 打到各 target ===");
  const probeSetup = await cdp.eval(PROBE_JS);
  console.log("可用 target:", JSON.stringify(probeSetup.targets));

  for (const where of ["canvas", "document", "window", "softKeyboard"]) {
    const r = await cdp.eval(`${DISPATCH_JS}(${JSON.stringify(where)})`).catch((e) => ({ err: e.message }));
    console.log(`\n派发到 ${where}:`);
    console.log("  " + JSON.stringify(r));
  }
  const hits = await cdp.eval("JSON.stringify(window.__kbHits)");
  console.log("\n各 target 捕获探针计数（派发后）:", hits);

  // 关键：Emscripten 处理器有没有真的调 preventDefault
  // —— 如果游戏收到了，它会 preventDefault（glue 里就是这么做的）
  console.log("\n=== 用 CDP 原生输入（走真实管线）===");
  for (const where of ["canvas", "softKeyboard"]) {
    const box = await cdp.eval(`(function(){
      var e=document.getElementById(${JSON.stringify(where)});
      if(!e) return null; var r=e.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })()`);
    if (!box) { console.log(`${where}: 元素不存在`); continue; }
    try {
      await cdp.eval(`document.getElementById(${JSON.stringify(where)}).focus()`);
    } catch (e) { /* 忽略 */ }
    const before = await cdp.eval("JSON.stringify(window.__kbHits)");
    for (const type of ["keyDown", "char", "keyUp"]) {
      await cdp.send("Input.dispatchKeyEvent", {
        type,
        key: "f", code: "KeyF", text: type === "char" ? "f" : undefined,
        unmodifiedText: type === "char" ? "f" : undefined,
        windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 70,
      });
    }
    await sleep(300);
    const after = await cdp.eval("JSON.stringify(window.__kbHits)");
    console.log(`原生输入到 ${where}: before=${before} after=${after}`);
  }

  const activeEl = await cdp.eval("(document.activeElement && document.activeElement.id) || document.activeElement.tagName");
  console.log("\n当前焦点元素:", activeEl);

  await cdp.shot("kbdiag_final.png");
  try { ws.close(); } catch (e) {}
  chrome.kill();
})();
