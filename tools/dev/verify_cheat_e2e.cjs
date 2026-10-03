/**
 * 端到端验证：走完「建用户 → 进选关 → 输 future → 看是否解锁」
 * ─────────────────────────────────────────────────────────────
 * 为什么要这么麻烦：
 *   verify_cheat.cjs 只在标题画面盲发按键，结果并不能证明任何事 ——
 *   我据此误判过一次，以为 `future` 生效了。实际情况是：
 *     · 新存档第一次启动必然停在「NEW USER 输入姓名」弹窗
 *     · 此时焦点在 Emscripten 的软键盘 textarea(#pvz-soft-keyboard)
 *     · 按键被 textarea 截走，游戏逻辑一个字符都收不到
 *     · 画面变化只是标题动画自己在推进，与作弊码无关
 *
 * 所以这个脚本按真实玩家的顺序走：
 *   ① 等标题画面 → 点 START ADVENTURE
 *   ② 在姓名框输入名字 → 点 OK（建出用户，存档落盘）
 *   ③ 进主菜单 → 点 ADVENTURE → 进选关画面
 *   ④ 在选关画面输 future
 *   ⑤ 判断是否解锁
 *
 * 判断解锁的可靠方法：**读存档**。
 *   /saves/userdata/user0.dat 是二进制，头部 PVZP_SAVE4。
 *   记录输入 future 前后的字节，对比差异 —— 解锁一定会改写存档，
 *   而「按键没送到」则字节完全不变。这比看画面靠谱得多。
 *
 * 用法: node tools/dev/verify_cheat_e2e.cjs [url]
 * ───────────────────────────────────────────────────────────── */
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
const PROFILE_DIR = path.join(OUTDIR, "pvz_e2e_profile_" + process.pid);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYCODE = { f: 70, u: 85, t: 84, r: 82, e: 69, enter: 13, escape: 27 };

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
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result && r.result.value;
  }
  /* 原生按键：留着备用。游戏走软键盘通道，通常用不上 softType。 */
  async key(ch, delay = 240) {
    const lower = ch.toLowerCase();
    const code = KEYCODE[lower];
    const base = {
      key: ch === "\n" ? "Enter" : lower,
      code: ch === "\n" ? "Enter" : "Key" + lower.toUpperCase(),
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    };
    await this.send("Input.dispatchKeyEvent", {
      type: code ? "keyDown" : "char",
      text: code ? undefined : lower,
      unmodifiedText: code ? undefined : lower,
      ...base,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await sleep(delay);
  }
  async click(x, y) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await sleep(500);
  }
  /* 通过软键盘通道输入字符 —— 游戏只读这个 textarea，不看键盘事件。
   * 见 pvz-portable.html 里 typeViaSoftKeyboard 的详细说明。 */
  async softType(str, perChar = 260) {
    return this.eval(`(function (s) {
      var input = document.getElementById("pvz-soft-keyboard");
      if (!input) return { err: "no soft keyboard element" };
      var state = Module.wasmSoftKeyboardState;
      if (!state) return { err: "no state" };
      if (!state.active) return { err: "state.active=false（游戏没在收字符）" };
      // 一次性写入；syncInputValue 会把增量全部推进 pendingChars
      input.value = s;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true, pending: state.pendingChars.length };
    })(${JSON.stringify(str)})`);
  }
  async softState() {
    return this.eval(`(function(){
      var s = Module.wasmSoftKeyboardState;
      if (!s) return { err: "no state" };
      return { active: s.active, pendingChars: s.pendingChars.length,
               pendingKeys: s.pendingKeys.length, value: (s.lastValue||"") };
    })()`);
  }
  async shot(tag) {
    const s = await this.send("Page.captureScreenshot", { format: "png" });
    if (s && s.data) {
      const p = path.join(OUTDIR, "pvz_e2e_" + tag + ".png");
      fs.writeFileSync(p, Buffer.from(s.data, "base64"));
    }
  }
}

/* 读存档：返回 { file, size, hex摘要 }，用于对比输入前后的变化 */
const READ_SAVE_JS = `(function () {
  try {
    function walk(dir, acc) {
      var names = Module.FS.readdir(dir);
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (n === "." || n === "..") continue;
        var full = dir + "/" + n;
        var st = Module.FS.stat(full);
        if (Module.FS.isDir(st.mode)) walk(full, acc);
        else acc.push({ p: full, size: st.size });
      }
      return acc;
    }
    var files = walk("/saves", []);
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var d = Module.FS.readFile(files[i].p);
      // 取前 64 字节做指纹，整份做简单校验和
      var sum = 0;
      for (var k = 0; k < d.length; k++) sum = (sum + d[k] * (k % 251 + 1)) % 4294967296;
      out.push({
        path: files[i].p, size: files[i].size, sum: sum,
        head: Array.prototype.slice.call(d.subarray(0, 12)),
      });
    }
    return out;
  } catch (e) { return { err: String(e && e.message || e) }; }
})()`;

(async function main() {
  // 用固定 profile 目录，方便跨轮次复用存档
  try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (e) {}
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox",
    "--autoplay-policy=no-user-gesture-required",
    "--remote-debugging-port=" + PORT,
    "--user-data-dir=" + PROFILE_DIR,
    "--window-size=1280,800", "about:blank",
  ], { stdio: "ignore" });

  let targets = null;
  for (let i = 0; i < 60; i++) {
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
      logs.push(String(text).slice(0, 240));
    }
  });
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  console.log("打开:", URL_);
  await cdp.send("Page.navigate", { url: URL_ });

  // 等游戏启动
  const WAIT = Number(process.env.PVZ_WAIT_MS || 55000);
  process.stdout.write("等待游戏启动");
  for (let i = 0; i < WAIT / 5000; i++) { await sleep(5000); process.stdout.write("."); }
  console.log("");

  const ready = await cdp.eval(`(function(){
    var b=document.getElementById("boot");
    return { bootHidden: b && b.style.display==="none",
             pct: (document.getElementById("pct")||{}).textContent };
  })()`);
  console.log("启动:", JSON.stringify(ready));
  if (!ready || !ready.bootHidden) { console.error("游戏没启动，后续无意义"); process.exit(1); }

  // canvas 在页面上的实际位置与大小（点击坐标要用页面坐标）
  const geom = await cdp.eval(`(function(){
    var cv=document.getElementById("canvas");
    var r=cv.getBoundingClientRect();
    return { x:r.left, y:r.top, w:r.width, h:r.height, cw:cv.width, ch:cv.height };
  })()`);
  console.log("canvas 几何:", JSON.stringify(geom));

  // 页面坐标 = canvas 游戏坐标的换算
  const toPage = (gx, gy) => ({
    x: geom.x + (gx / geom.cw) * geom.w,
    y: geom.y + (gy / geom.ch) * geom.h,
  });

  await sleep(3000);
  await cdp.shot("01_title");
  console.log("→ 标题画面已截图");

  // ① 点 START ADVENTURE
  //    从 01_title 截图量出来的：800x600 里 START ADVENTURE 文字在
  //    约 x 560-720 / y 75-115，取中心 (640, 95)
  let p = toPage(640, 95);
  console.log("① 点击 START ADVENTURE @", JSON.stringify(p));
  await cdp.click(p.x, p.y);
  await sleep(2500);
  await cdp.shot("02_after_start");
  console.log("   软键盘状态:", JSON.stringify(await cdp.softState()));

  // ② 输入姓名（走软键盘通道）
  console.log("② 输入用户名 zfsn");
  console.log("   结果:", JSON.stringify(await cdp.softType("zfsn")));
  await sleep(1200);
  await cdp.shot("03_name_typed");
  console.log("   软键盘状态:", JSON.stringify(await cdp.softState()));

  // ③ 回车确认 —— 注意也要走软键盘（pendingKeys），键盘事件同样不被游戏读取
  console.log("③ 回车确认");
  await cdp.eval(`(function(){
    var s = Module.wasmSoftKeyboardState;
    if (!s || !s.active) return "not active";
    s.pendingKeys.push(13);
    return "queued, pendingKeys=" + s.pendingKeys.length;
  })()`);
  await sleep(3000);
  await cdp.shot("04_after_ok");

  const saveAfterCreate = await cdp.eval(READ_SAVE_JS);
  const userFiles = Array.isArray(saveAfterCreate)
    ? saveAfterCreate.filter((f) => /user|game|\.dat/.test(f.path))
    : saveAfterCreate;
  console.log("建号后用户存档:", JSON.stringify(userFiles, null, 1));

  // ④ 进冒险模式 → 选关地图（不是直接进关卡！）
  //    从 04_after_ok 截图量出来的：START ADVENTURE 文字在 800x600 里
  //    约 x 555-720 / y 78-122，取中心 (637, 100)
  //    ⚠ 我上一版点的是 (300,175) —— 那是左边的房子/木牌区域，
  //    结果游戏直接进了关卡 1-1（截图里能看到草坪和 "Level 1-1"），
  //    而关卡内没有文本框、软键盘也不激活，输码当然没反应。
  p = toPage(637, 100);
  console.log("④ 点击 START ADVENTURE @", JSON.stringify(p));
  await cdp.click(p.x, p.y);

  // 等选关地图加载完（进冒险模式有黑屏加载期）
  console.log("   等待选关地图…");
  for (let i = 0; i < 12; i++) {
    await sleep(2500);
    await cdp.shot("05_selector_" + i);
  }
  console.log("   软键盘状态:", JSON.stringify(await cdp.softState()));

  // 记录输入前的存档状态
  const before = await cdp.eval(READ_SAVE_JS);
  console.log("\n=== 输入 future 前的用户存档 ===");
  console.log(JSON.stringify(Array.isArray(before) ? before.filter((f) => /user|game|\.dat/.test(f.path)) : before, null, 1));

  // 诊断：此刻到底在哪个画面、软键盘是什么状态
  console.log("\n=== 诊断 ===");
  console.log("软键盘:", JSON.stringify(await cdp.softState()));
  await cdp.shot("05b_before_cheat");

  // ⑤ 输入 future
  //    注意：选关画面通常**不会**激活软键盘（软键盘只在有文本框时激活）。
  //    所以这里两条路都试：
  //      A) 软键盘通道（若已激活）
  //      B) CDP 原生键盘事件（走浏览器真实输入管线）
  console.log("\n⑤ 输入 future");
  const st5 = await cdp.softState();
  if (st5 && st5.active) {
    console.log("   A) 走软键盘通道:", JSON.stringify(await cdp.softType("future")));
  } else {
    console.log("   A) 软键盘未激活 —— 选关画面没有文本框");
  }
  await sleep(3000);

  // B) 原生键盘
  console.log("   B) 走 CDP 原生键盘事件");
  for (const ch of "future") await cdp.key(ch, 300);
  await sleep(3500);
  console.log("   软键盘状态:", JSON.stringify(await cdp.softState()));
  await cdp.shot("06_after_cheat");

  const after = await cdp.eval(READ_SAVE_JS);
  console.log("\n=== 输入 future 后的用户存档 ===");
  console.log(JSON.stringify(Array.isArray(after) ? after.filter((f) => /user|game|\.dat/.test(f.path)) : after, null, 1));

  // 对比：只看用户存档（user*.dat / game*.dat / users.dat），
  // 排除 cache32 编译缓存 —— 那是资源缓存，跟解锁无关，
  // 而且它每帧都在变，拿来对比只会得到噪声。
  console.log("\n=== 结论 ===");
  const isUserFile = (f) => /userdata\/.*\.dat$/.test(f.path);
  const bOK = Array.isArray(before), aOK = Array.isArray(after);
  if (!bOK || !aOK) {
    console.log("读存档失败，无法判断:", bOK ? "" : JSON.stringify(before), aOK ? "" : JSON.stringify(after));
  } else {
    const bu = before.filter(isUserFile), au = after.filter(isUserFile);
    console.log("用户存档文件数:", bu.length, "->", au.length);
    const bmap = {}; bu.forEach((f) => (bmap[f.path] = f));
    const diff = [];
    au.forEach((f) => {
      const o = bmap[f.path];
      if (!o) diff.push(f.path + " 新增 size=" + f.size);
      else if (o.sum !== f.sum) diff.push(f.path + " 内容变化 size=" + o.size + "->" + f.size);
    });
    if (diff.length) {
      console.log("✅ 用户存档被改写 —— 解锁生效的证据:");
      diff.forEach((d) => console.log("   " + d));
    } else {
      console.log("❌ 用户存档完全没变 —— 按键没被游戏逻辑接收");
    }
  }

  const cheatLogs = logs.filter((l) => /cheat|unlock|Selector|cheat key/i.test(l));
  console.log("\n=== 控制台 cheat/Selector 相关 ===");
  if (!cheatLogs.length) console.log("  （无）");
  cheatLogs.slice(-20).forEach((l) => console.log("  " + l));

  console.log("\n截图前缀: pvz_e2e_  （01标题 02点开始 03输入名 04确认 05选关 06作码后）");

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  await sleep(300);
  process.exit(0);
})();
