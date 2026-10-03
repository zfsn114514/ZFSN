/**
 * 快速探测：游戏起来后往当前画面盲发一段按键，看事件有没有到达页面
 * ══════════════════════════════════════════════════════════════
 * ⚠ 这个脚本**不能证明作弊码生效**，只能证明「事件送到了」。
 *   我曾经拿它的输出当证据，误判过一次 —— 教训记在下面。
 *
 *   它在标题画面盲发 `future`，结果：
 *     · 截图变了 → 但那是标题动画自己在推进到「新建用户」弹窗
 *     · 控制台出现 DelayLoad_Zombatar / SelectorScreen.reanim
 *       → 那是正常加载流程，跟解锁毫无关系，我却当成了证据
 *   真正的问题：新存档第一次启动必然停在「NEW USER 输入姓名」弹窗，
 *   焦点在 Emscripten 的软键盘 textarea(#pvz-soft-keyboard)，
 *   按键被它截走，游戏逻辑一个字符都收不到。
 *
 * 要真正验证解锁，用 tools/dev/verify_cheat_e2e.cjs ——
 * 它会走完「建用户 → 进选关 → 输 future」，并且**读存档字节对比**
 * 来判断，而不是看画面。
 *
 * 背景（为什么怀疑 future 是全解锁）：
 *   pvz-portable.wasm 是 strip 过的，看不到符号，但 data 段里留着
 *   原版 PvZ 的作弊码表（func#6560）：
 *     mustache / moustache / trickedout / "tricked out" /
 *     future / pinata / dance / daisies
 *   消费方是选关画面的按键处理（func#3350，日志 "Selector cheat key"）。
 *
 * 为什么用 CDP 而不是 `chrome --headless --dump-dom`：
 *   后者抓的是加载瞬间的 DOM 快照，之后定时器/rAF 都不再跑，
 *   游戏还没画出第一帧就被抓走了（看起来像"没启动"，其实是抓早了）。
 *
 * 用法: node tools/dev/verify_cheat.cjs [url] [作弊码]
 * ───────────────────────────────────────────────────────────── */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CODE = (process.argv[3] || "future").split("");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9700 + (process.pid % 300);
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
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result && r.result.value;
  }
}

/* canvas 指纹：用来判断画面有没有变化（解锁后选关界面会重绘）
 * 注意：不能直接用 getContext("2d") —— 游戏把 canvas 交给了 WebGL，
 * 一个 canvas 只能有一种上下文类型，2d 会返回 null（我第一版就踩了，
 * 报 "Cannot read properties of null (reading 'getImageData')"）。
 * 所以画面变化只用 CDP 截图的字节直方图来判断。 */
const CANVAS_INFO_JS = `(function () {
  var cv = document.getElementById("canvas");
  if (!cv) return { err: "no canvas" };
  return { w: cv.width, h: cv.height, cssW: cv.style.width, cssH: cv.style.height };
})()`;

/* 截图并算指纹（对 PNG 原始字节做统计） */
async function shotFingerprint(cdp, tag) {
  const s = await cdp.send("Page.captureScreenshot", { format: "png" });
  if (!s || !s.data) return null;
  const buf = Buffer.from(s.data, "base64");
  fs.writeFileSync(path.join(OUTDIR, "pvz_cheat_" + tag + ".png"), buf);
  // 用字节直方图当指纹：画面变了直方图就会变
  const hist = new Array(256).fill(0);
  for (const byte of buf) hist[byte]++;
  let norm = 0;
  for (let i = 0; i < 256; i++) norm += hist[i] * hist[i];
  return { bytes: buf.length, norm };
}

/* 在页面里装一个键盘探针，确认合成事件真的到达了 document */
const INSTALL_PROBE_JS = `(function () {
  window.__keyLog = [];
  window.__probeInstalled = true;
  var rec = function (e) {
    window.__keyLog.push({
      key: e.key, code: e.code, keyCode: e.keyCode, which: e.which,
      trusted: e.isTrusted, target: e.target && e.target.nodeName,
    });
    if (window.__keyLog.length > 80) window.__keyLog.shift();
  };
  ["keydown", "keyup", "keypress"].forEach(function (t) {
    document.addEventListener(t, rec, true);   // 捕获阶段，先于 SDL
  });
  return true;
})()`;

/* 探针保留在页面里，用来观察事件是否到达、trusted 是否为 true。
 * 派发本身走 CDP 的 Input.dispatchKeyEvent（见下方主流程），
 * 不用 JS 合成事件 —— 合成事件在游戏处于文本输入模式时行为不对。 */

(async function main() {
  const profile = path.join(os.tmpdir(), "pvz-cheat-" + process.pid);
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
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
      logs.push({ level: m.params.type, text: String(text).slice(0, 300) });
    }
  });

  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  console.log("打开:", URL_);
  await cdp.send("Page.navigate", { url: URL_ });

  // 等游戏真正启动（下载 44MB 素材 + 编译 wasm + pak 合并）
  const WAIT = Number(process.env.PVZ_WAIT_MS || 55000);
  process.stdout.write("等待游戏启动");
  for (let i = 0; i < WAIT / 5000; i++) { await sleep(5000); process.stdout.write("."); }
  console.log("");

  const ready = await cdp.eval(`(function(){
    var b=document.getElementById("boot"), c=document.getElementById("canvas-container");
    var cv=document.getElementById("canvas");
    return {
      hasBoot: !!b, hasCanvas: !!cv,
      bootHidden: b ? b.style.display==="none" : null,
      contShown: c ? c.style.display==="flex" : null,
      pct: (document.getElementById("pct")||{}).textContent,
      err: (function(){ var e=document.getElementById("err");
        return e && e.style.display==="block" ? e.textContent.replace(/\\s+/g," ").slice(0,300) : null; })(),
    };
  })()`);
  console.log("启动状态:", JSON.stringify(ready));
  if (!ready || !ready.bootHidden) {
    console.error("游戏没启动成功，后面的按键测试没有意义。");
    console.error("  hasCanvas=" + (ready && ready.hasCanvas) +
      "  进度=" + (ready && ready.pct) +
      "  错误=" + (ready && ready.err));
  }

  // 装探针
  await cdp.eval(INSTALL_PROBE_JS);
  console.log("键盘探针已安装");

  const info = await cdp.eval(CANVAS_INFO_JS);
  console.log("canvas:", JSON.stringify(info));

  const before = await shotFingerprint(cdp, "before");
  console.log("作码前截图:", JSON.stringify(before));

  // 派发作弊码
  // 关键：不能只发 JS 合成事件 —— 我第一版就是这么做的，结果按键被
  // 游戏自己的 "NEW USER" 姓名输入框吃掉了（输入框里显示成 "TURE"，
  // f 之后丢了），说明游戏此刻处于文本输入模式，合成事件虽然到达了
  // document，但走的路径和真实键盘不同。
  // 改用 Input.dispatchKeyEvent —— CDP 原生输入，会走浏览器真实输入管线。
  console.log("派发作弊码（CDP 原生输入）:", CODE.join(""));
  const KEYCODE = { f: 70, u: 85, t: 84, r: 82, e: 69 };
  for (const ch of CODE) {
    const lower = ch.toLowerCase();
    const code = KEYCODE[lower];
    const evBase = {
      key: lower,
      code: "Key" + lower.toUpperCase(),
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    };
    await cdp.send("Input.dispatchKeyEvent", {
      type: code ? "keyDown" : "char",
      text: code ? undefined : lower,
      unmodifiedText: code ? undefined : lower,
      ...evBase,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...evBase });
    await sleep(240);   // 比人打字慢一点，保证游戏每帧都能读到
  }

  await sleep(2500);   // 等游戏重绘

  const after = await shotFingerprint(cdp, "after");
  console.log("作码后截图:", JSON.stringify(after));

  const keyLog = await cdp.eval(`(window.__keyLog||[]).slice(-40)`);
  console.log("\n=== 页面收到的键盘事件（末尾） ===");
  (keyLog || []).forEach((k) => console.log("  ", JSON.stringify(k)));

  // 决定性线索：按键落在哪个元素上。
  // TEXTAREA = 被 Emscripten 软键盘(#pvz-soft-keyboard)吞掉，游戏收不到 → 作弊码无效
  // BODY/DOCUMENT = 正常送达游戏
  const evTargets = [...new Set((keyLog || []).map((k) => k.target))];
  const swallowed = evTargets.some((t) => t === "TEXTAREA" || t === "INPUT");
  console.log("\n事件落点:", evTargets.join(", ") || "(无)");
  if (swallowed) {
    console.log("⚠ 按键被软键盘 textarea 吞掉了 —— 游戏逻辑收不到，作弊码不会生效。");
    console.log("  （这是新存档停在「输入姓名」弹窗时的典型情况）");
  }

  const cheatLogs = logs.filter((l) => /cheat|unlock|Selector/i.test(l.text));
  console.log("\n=== 控制台里与 cheat/unlock 相关的行 ===");
  if (!cheatLogs.length) console.log("  （无）");
  cheatLogs.forEach((l) => console.log("  [" + l.level + "]", l.text));

  const changed = before && after && before.norm !== after.norm;
  console.log("\n画面是否变化:", changed ? "是" : "否");
  console.log("⚠ 画面变化**不能**说明解锁生效 —— 标题动画自己就会变。");
  console.log("  要判断解锁，请用 verify_cheat_e2e.cjs（会读存档字节对比）。");
  console.log("  另外留意上面事件日志的 target：如果是 TEXTAREA，");
  console.log("  说明按键被软键盘吞了，游戏根本没收到。");
  console.log("截图: pvz_cheat_before.png / pvz_cheat_after.png");

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})();
