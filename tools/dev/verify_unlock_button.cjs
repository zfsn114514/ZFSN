/**
 * 验证页面上的「通关存档」按钮是否真的能解锁
 * ══════════════════════════════════════════════════════════════
 * 这是最终验证：走真实玩家路径到主菜单，然后**点击页面上的按钮**
 * （而不是自己模拟输入），最后读存档字节对比。
 *
 * 前面踩过的坑，都体现在这个脚本的注释里：
 *   · 游戏不注册 keydown，KeyboardEvent / CDP 原生键盘都没用
 *   · 真正通道是隐藏 textarea #pvz-soft-keyboard 的 value 变化
 *   · 点错坐标会直接进关卡，而不是停在选关地图
 *   · 画面变化不能作为解锁证据（标题动画自己就会变）
 *
 * 判定标准：/saves/userdata/ 下 *.dat 的字节和发生变化 = 解锁生效。
 *
 * 用法: node tools/dev/verify_unlock_button.cjs [url]
 * ───────────────────────────────────────────────────────────── */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9600 + (process.pid % 150);
const OUTDIR = "C:/Users/Administrator/WorkBuddy/2026-10-02-22-27-21";
const PROFILE_DIR = path.join(OUTDIR, "pvz_unl_profile_" + process.pid);

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
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
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
  async click(x, y) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await sleep(500);
  }
  async shot(tag) {
    const s = await this.send("Page.captureScreenshot", { format: "png" });
    if (s && s.data) fs.writeFileSync(path.join(OUTDIR, "pvz_unl_" + tag + ".png"), Buffer.from(s.data, "base64"));
  }
}

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
      if (!/userdata\\/.*\\.dat$/.test(files[i].p)) continue;  // 只看用户存档，跳过 cache32
      var d = Module.FS.readFile(files[i].p);
      var sum = 0;
      for (var k = 0; k < d.length; k++) sum = (sum + d[k] * (k % 251 + 1)) % 4294967296;
      out.push({ path: files[i].p, size: files[i].size, sum: sum,
                 head: Array.prototype.slice.call(d.subarray(0, 16)) });
    }
    return out;
  } catch (e) { return { err: String(e && e.message || e) }; }
})()`;

/* 软键盘通道输入（与页面里 typeViaSoftKeyboard 同一套机制） */
const SOFT_TYPE_JS = `(function (s) {
  var input = document.getElementById("pvz-soft-keyboard");
  if (!input) return { err: "no soft keyboard" };
  var st = Module.wasmSoftKeyboardState;
  if (!st) return { err: "no state yet" };
  var wasActive = st.active;
  if (!wasActive) {
    st.active = true; st.pendingChars.length = 0; st.pendingKeys.length = 0; st.lastValue = "";
    input.value = "";
    try { input.focus(); } catch (e) {}
  }
  var i = 0;
  (function step() {
    if (i >= s.length) {
      if (!wasActive) setTimeout(function(){ st.active=false; input.value=""; st.lastValue=""; }, 1200);
      return;
    }
    input.value = s.slice(0, i + 1);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    i++; setTimeout(step, 260);
  })();
  return { ok: true, wasActive: wasActive };
})`;

(async function main() {
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
  const cdp = new CDP(ws);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  // 页面上的按钮点完会弹 alert。CDP 里不处理的话，JS 执行会被阻塞，
  // 后续 eval 全部超时。这里注册自动接受。
  // （CDP 类用的是 ws.onmessage，这里用 addEventListener 不会互相覆盖。）
  ws.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m.method === "Page.javascriptDialogOpening") {
      console.log("   [自动关闭 alert]:", String(m.params.message || "").slice(0, 60).replace(/\n/g, " "));
      cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
    }
  });

  console.log("打开:", URL_);
  await cdp.send("Page.navigate", { url: URL_ });

  const WAIT = Number(process.env.PVZ_WAIT_MS || 55000);
  process.stdout.write("等待游戏启动");
  for (let i = 0; i < WAIT / 5000; i++) { await sleep(5000); process.stdout.write("."); }
  console.log("");

  const ready = await cdp.eval(`(function(){
    var b=document.getElementById("boot");
    return { bootHidden: b && b.style.display==="none", pct:(document.getElementById("pct")||{}).textContent };
  })()`);
  console.log("启动:", JSON.stringify(ready));
  if (!ready || !ready.bootHidden) { console.error("游戏没启动"); process.exit(1); }

  const geom = await cdp.eval(`(function(){
    var cv=document.getElementById("canvas"); var r=cv.getBoundingClientRect();
    return { x:r.left, y:r.top, w:r.width, h:r.height, cw:cv.width, ch:cv.height };
  })()`);
  console.log("canvas:", JSON.stringify(geom));
  const toPage = (gx, gy) => ({ x: geom.x + (gx / geom.cw) * geom.w, y: geom.y + (gy / geom.ch) * geom.h });

  // 关掉启动页里的 confirm 弹窗干扰：直接开始建用户
  await sleep(3000);
  let p = toPage(640, 95);
  console.log("① 点 START ADVENTURE");
  await cdp.click(p.x, p.y);
  await sleep(2500);

  console.log("② 输入用户名（软键盘通道）");
  console.log("   ", JSON.stringify(await cdp.eval(`(${SOFT_TYPE_JS})("zfsn")`)));
  await sleep(1500);
  await cdp.shot("03_name");

  console.log("③ 回车确认");
  await cdp.eval(`(function(){
    var s=Module.wasmSoftKeyboardState; if(!s||!s.active) return "not active";
    s.pendingKeys.push(13); return "ok";
  })()`);
  await sleep(3500);
  await cdp.shot("04_menu");
  console.log("   已到主菜单");

  // 进 START ADVENTURE，停在关卡地图（不点关卡卡片）
  // 坐标从 04_menu 截图量出：START ADVENTURE 文字中心约 (637, 100)
  console.log("\n④ 进 START ADVENTURE，停在关卡地图");
  p = toPage(637, 100);
  await cdp.click(p.x, p.y);
  for (let i = 0; i < 8; i++) {
    await sleep(2500);
    await cdp.shot("05_map_" + i);
  }
  console.log("   已进入关卡地图");

  // 记录点击按钮前的存档（必须在关卡地图上取基线）
  const before = await cdp.eval(READ_SAVE_JS);
  console.log("\n=== 点按钮前 ===");
  console.log(JSON.stringify(before, null, 1));

  // 找页面上的按钮并点击
  const btnBox = await cdp.eval(`(function(){
    var b=document.getElementById("btn-unlock");
    if(!b) return null;
    var r=b.getBoundingClientRect();
    return { x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height,
             text:b.textContent, visible:r.width>0&&r.height>0 };
  })()`);
  console.log("\nbtn-unlock:", JSON.stringify(btnBox));
  if (!btnBox || !btnBox.visible) {
    console.error("按钮不可见，无法点击");
  } else {
    console.log("⑤ 点击「通关存档」按钮");
    await cdp.click(btnBox.x, btnBox.y);
    await sleep(7000);   // 6 字符 × 260ms + 处理 + 弹窗
  }

  await cdp.shot("05_after_btn");

  const after = await cdp.eval(READ_SAVE_JS);
  console.log("\n=== 点按钮后 ===");
  console.log(JSON.stringify(after, null, 1));

  console.log("\n=== 结论 ===");
  const bOK = Array.isArray(before), aOK = Array.isArray(after);
  if (!bOK || !aOK) {
    console.log("读存档失败:", bOK ? "" : JSON.stringify(before), aOK ? "" : JSON.stringify(after));
  } else {
    const bmap = {}; before.forEach((f) => (bmap[f.path] = f));
    const diff = [];
    after.forEach((f) => {
      const o = bmap[f.path];
      if (!o) diff.push(f.path + " 新增 size=" + f.size);
      else if (o.sum !== f.sum) diff.push(f.path + " 变化 " + o.size + "->" + f.size);
    });
    if (diff.length) {
      console.log("✅ 用户存档被改写 —— 解锁生效:");
      diff.forEach((d) => console.log("   " + d));
    } else {
      console.log("❌ 用户存档没变化 —— 解锁未生效");
    }
  }

  console.log("\n截图前缀: pvz_unl_");
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  await sleep(300);
  process.exit(0);
})();
