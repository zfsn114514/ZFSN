/**
 * 诊断软键盘状态：为什么输入没进游戏
 * ─────────────────────────────────────────────────────────────
 * 背景：想自动走完"建号 → 存档写入"，好拿到 mod 版真实的存档字节。
 * 但往 `#pvz-soft-keyboard` 写值后，游戏里的 NEW USER 输入框始终是空的。
 *
 * 已知的机制（从 pvz-portable.js 读出来的）：
 *   这版 Emscripten **不注册 keydown 回调**（`onKeyDown` 出现 0 次），
 *   游戏只通过 5 个 import 与 JS 通信：
 *     WasmHasSoftKeyboardEvents  —— 问有没有字符可取
 *     WasmPopSoftKeyboardChar    —— 取一个字符
 *     WasmStartSoftKeyboard      —— **游戏主动开启**软键盘
 *     WasmChar / WasmKeycode     —— 取修饰键状态
 *     WasmSetTextInputRect       —— 定位光标
 *
 *   `state.active` 只有在游戏调了 WasmStartSoftKeyboard 之后才为 true。
 *   我的实现里 active=false 就直接 return，所以字符不入队 —— 这就是
 *   输入框空着的直接原因。
 *
 * 这个问题脚本要回答：
 *   ① 走到 NEW USER 时，state.active 到底是什么值
 *   ② 游戏的 WasmStartSoftKeyboard 是不是真的注册进了 Module
 *   ③ 往 textarea 写值 + input 事件后，pendingChars 里有没有东西
 *   ④ 游戏的轮询循环是否在跑（用一个随时间增长的计数器间接判断）
 *
 * 用法: node tools/dev/diag_softkb.cjs [url]
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9800 + (process.pid % 200);
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
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result && r.result.value;
  }
  async click(x, y) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await sleep(500);
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (r && r.data) {
      fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, "base64"));
    }
  }
}

(async function main() {
  const profile = path.join(os.tmpdir(), "softkb-cdp-" + process.pid);
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

  await cdp.send("Page.navigate", { url: URL_ });
  console.log("等游戏加载…");
  let booted = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await cdp.eval(`(function(){
      var b=document.getElementById("boot");
      return { hidden: !!(b && b.style.display==="none") };
    })()`);
    if (st && st.hidden) { booted = true; break; }
  }
  if (!booted) { console.error("游戏没启动"); chrome.kill(); process.exit(1); }
  await sleep(3000);

  /* 装一个探针：记录 softkb 相关的一切 */
  const PROBE = `(function(){
    window.__probe = { startCalls: 0, inputEvents: 0, lastValue: null, samples: [] };
    var inp = document.getElementById("pvz-soft-keyboard");
    if (!inp) return { err: "没有 #pvz-soft-keyboard textarea" };
    inp.addEventListener("input", function(){
      window.__probe.inputEvents++;
      window.__probe.lastValue = inp.value;
    });
    return {
      hasTextarea: true,
      stateExists: !!Module.wasmSoftKeyboardState,
      stateActive: Module.wasmSoftKeyboardState ? !!Module.wasmSoftKeyboardState.active : null,
      tag: inp.tagName, id: inp.id,
    };
  })()`;
  console.log("\n=== ① 装探针（标题页状态）===");
  console.log("  ", JSON.stringify(await cdp.eval(PROBE)));

  /* 点 CLICK TO START —— 800x600 里木牌中心约 (400, 560) */
  const cv = await cdp.eval(`(function(){
    var c=document.getElementById("canvas"); if(!c) return null;
    var r=c.getBoundingClientRect();
    return { x:r.left, y:r.top, w:r.width, h:r.height, cw:c.width, ch:c.height };
  })()`);
  const toPage = (gx, gy) => ({
    x: cv.x + (gx / cv.cw) * cv.w,
    y: cv.y + (gy / cv.ch) * cv.h,
  });

  let p = toPage(400, 560);
  console.log("\n=== ② 点 CLICK TO START ===");
  console.log("  页面坐标:", JSON.stringify(p));
  await cdp.click(p.x, p.y);
  await sleep(4000);
  await cdp.shot("softkb_01_after_click.png");

  console.log("\n=== ③ NEW USER 弹窗状态 ===");
  console.log("  ", JSON.stringify(await cdp.eval(`(function(){
    var s = Module.wasmSoftKeyboardState;
    var inp = document.getElementById("pvz-soft-keyboard");
    return {
      stateExists: !!s,
      active: s ? !!s.active : null,
      pendingChars: s ? (s.pendingChars ? s.pendingChars.length : null) : null,
      textareaValue: inp ? inp.value : null,
      probeInputEvents: window.__probe ? window.__probe.inputEvents : null,
    };
  })()`)));
  await cdp.shot("softkb_02_newuser.png");

  /* 尝试写值并派发 input，看 pendingChars 会不会涨 */
  console.log("\n=== ④ 写 textarea + 派发 input，看字符能否入队 ===");
  const write = await cdp.eval(`(function(){
    var inp = document.getElementById("pvz-soft-keyboard");
    var s = Module.wasmSoftKeyboardState;
    if (!inp) return { err: "no textarea" };
    inp.focus();
    var before = s ? (s.pendingChars ? s.pendingChars.length : -1) : -1;
    inp.value = "z";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    var after = s ? (s.pendingChars ? s.pendingChars.length : -1) : -1;
    return {
      active: s ? !!s.active : null,
      pendingBefore: before,
      pendingAfter: after,
      queued: s && s.pendingChars ? Array.from(s.pendingChars) : null,
      focused: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
    };
  })()`);
  console.log("  ", JSON.stringify(write));

  await sleep(1500);
  console.log("\n=== ⑤ 等游戏轮询，看字符是否被取走 ===");
  console.log("  ", JSON.stringify(await cdp.eval(`(function(){
    var s = Module.wasmSoftKeyboardState;
    return {
      active: s ? !!s.active : null,
      pendingChars: s && s.pendingChars ? s.pendingChars.length : null,
      textareaValue: document.getElementById("pvz-soft-keyboard").value,
      probeInputEvents: window.__probe ? window.__probe.inputEvents : null,
    };
  })()`)));
  await cdp.shot("softkb_03_after_type.png");

  /* ⑥ 关键验证：主动调 WasmStartSoftKeyboard
   *
   * 源码确认 `WasmStartSoftKeyboard` 就是创建 state + 挂 input 监听的地方，
   * 而且它是 wasm 的 import —— 有没有挂在 Module 上决定了能不能直接调。
   * 这一步要回答：wasmImports 能不能拿到、调用后字符是否真的进队、
   * 以及游戏会不会真的把字符取走（pendingChars 归零 = 被消费了）。 */
  console.log("\n=== ⑥ 尝试主动调 WasmStartSoftKeyboard ===");
  const start = await cdp.eval(`(function(){
    var out = {
      onModule: typeof Module.WasmStartSoftKeyboard,
      byShortName: typeof Module.zb,
      keys: Object.keys(Module).filter(function(k){
        return /soft|Soft|keyboard|Keyboard|^z[a-z]$/.test(k);
      }).slice(0, 20),
    };
    var fn = Module.WasmStartSoftKeyboard;
    if (typeof fn === "function") {
      try { fn(); out.called = true; } catch (e) { out.err = String(e); }
      var s = Module.wasmSoftKeyboardState;
      out.stateExists = !!s;
      out.active = s ? !!s.active : null;
    }
    return out;
  })()`);
  console.log("  调用结果:", JSON.stringify(start));

  if (start && start.stateExists) {
    console.log("\n=== ⑦ state 已建立，重新写字符 ===");
    console.log("  ", JSON.stringify(await cdp.eval(`(function(){
      var inp = document.getElementById("pvz-soft-keyboard");
      var s = Module.wasmSoftKeyboardState;
      var b = s.pendingChars ? s.pendingChars.length : -1;
      inp.value = "zfsn";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      return { active: !!s.active, before: b,
               after: s.pendingChars ? s.pendingChars.length : -1,
               queued: s.pendingChars ? Array.from(s.pendingChars) : null };
    })()`)));
    await sleep(2000);
    console.log("\n=== ⑧ 游戏是否消费了字符（pendingChars 归零 = 被取走）===");
    console.log("  ", JSON.stringify(await cdp.eval(`(function(){
      var s = Module.wasmSoftKeyboardState;
      return {
        pendingChars: s && s.pendingChars ? Array.from(s.pendingChars) : null,
        textareaValue: document.getElementById("pvz-soft-keyboard").value,
        lastValue: s ? s.lastValue : null,
      };
    })()`)));
    await cdp.shot("softkb_04_after_start.png");
  }

  /* 结论 */
  console.log("\n=== 结论 ===");
  const w = write;
  if (!w || w.err) {
    console.log("textarea 不存在");
  } else if (!start || !start.stateExists) {
    console.log("★ Module.wasmSoftKeyboardState 不存在 —— 游戏的 WasmStartSoftKeyboard 从未被调用。");
    console.log("  由此确认：走到 NEW USER 弹窗时软键盘机制根本没启用，");
    console.log("  所以往 textarea 写值不会有任何效果（input 监听器也没挂）。");
    console.log("  wasmImports 是模块内局部变量，页面上拿不到 —— 除非它被挂到了 Module 上。");
  } else if (start.err) {
    console.log("★ 调用 WasmStartSoftKeyboard 抛错:", start.err);
  } else {
    console.log("★ WasmStartSoftKeyboard 可以调用，state 已建立。");
    console.log("  上一轮脚本失败的原因就是这个 state 一直没被创建。");
  }

  try { ws.close(); } catch (e) {}
  chrome.kill();
})();
