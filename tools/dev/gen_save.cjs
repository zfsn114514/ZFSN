/**
 * 关键实验：让 WASM 版 PvZ 自己写出一个存档，然后看它到底是什么格式
 * ─────────────────────────────────────────────────────────────
 * 背景（这次真的挖到东西了）：
 *   1. 用户给的 user2.dat / users.dat 是**零售原版**的存档
 *      （C:\ProgramData\PopCap Games，gdi42.dll，2009 年），
 *      格式是 888 字节定长二进制，只有 2 个非零字节 = 全新空档，没有通关进度。
 *   2. WASM 版是 2019-2020 的老马 mod，存档路径 userdata/user{N}.dat，
 *      头部标识 PVZP_SAVE4 —— 和零售版完全不兼容。
 *   3. 在 wasm 里挖到字符串：
 *        userdata/user{}.dat / userdata/game{}_{}.dat / userdata/users.dat
 *        Failed to player data, resetting it
 *        profile ' / in File ' / Invalid Section ' / Unexpected Section: '
 *        Invalid Integer Value: ' / Invalid Boolean Value: '
 *        % Achievement! / More slots! / Tuning '
 *      最后这批是 **INI 文本解析器** 的报错模板 —— 强烈暗示存档是可读文本，
 *      类似 [Profile]/[Progress] 节的 key=value。
 *   4. RTTI 里有 7LawnApp / 19PvzpResourceManager / 10ProfileMgr
 *      —— ProfileMgr 就是管存档的类。
 *
 * 所以：只要让游戏自己写一次存档，把字节 dump 出来，
 * 就能拿到真实格式，然后直接改字节实现全解锁 —— 不再依赖作弊码输入。
 *
 * 做法：
 *   1. 打开游戏，等加载完
 *   2. 走建号流程（CLICK TO START → 输名字 → 回车）
 *   3. 进冒险模式，让它写一次存档
 *   4. syncfs 落盘
 *   5. 读 /saves/userdata 下所有文件，逐字节 dump 到本地
 *
 * 用法: node tools/dev/gen_save.cjs [url]
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9800 + (process.pid % 150);
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
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0,
      });
    }
    await sleep(600);
  }
  /* ⚠ CDP Input.dispatchKeyEvent 校验很严：
   *   text 只能传单个可打印字符；Enter 等不可打印键必须完全省略该字段
   *   （传 undefined 在 JSON 里会变 null，同样报 Invalid 'text' parameter）。 */
  async key(key, code, keyCode, text) {
    const printable = text && text.length === 1 && text.charCodeAt(0) >= 32 && text.charCodeAt(0) < 127;
    const down = { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
    if (printable) { down.text = text; down.unmodifiedText = text; }
    await this.send("Input.dispatchKeyEvent", down);
    await sleep(40);
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode,
    });
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

/* 读 /saves 下所有文件，hex 字符串返回（存档很小，安全） */
const DUMP_ALL = `(function () {
  function walk(dir, depth, out) {
    var names; try { names = Module.FS.readdir(dir); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      var p = dir + "/" + names[i], st;
      try { st = Module.FS.stat(p); } catch (e) { continue; }
      if (Module.FS.isDir(st.mode)) { if (depth < 3) walk(p, depth + 1, out); }
      else out.push({ path: p, size: st.size });
    }
  }
  var out = []; walk("/saves", 0, out);
  // 只留存档相关
  var keep = out.filter(function (f) { return /\\/(users|user\\d+|game[^/]*)\\.dat$/.test(f.path); });
  return { saves: keep, total: out.length };
})()`;

const READ_ONE = `(function (p) {
  var b = Module.FS.readFile(p), hex = "", txt = null;
  for (var i = 0; i < b.length; i++) hex += (b[i] < 16 ? "0" : "") + b[i].toString(16);
  try { txt = UTF8ToString(b); } catch (e) { txt = null; }
  return { path: p, size: b.length, hex: hex, text: txt };
})`;

(async function main() {
  const profile = path.join(os.tmpdir(), "pvz-gen-" + process.pid);
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
      return { hidden: !!(b && b.style.display==="none"),
               pct: (document.getElementById("pct")||{}).textContent };
    })()`).catch(() => null);
    if (st && st.hidden) { booted = true; break; }
    if (i % 5 === 0) console.log(`  +${(i+1)*2}s`, JSON.stringify(st));
  }
  if (!booted) { console.error("没启动成功"); await cdp.shot("gen_fail.png"); chrome.kill(); process.exit(1); }
  console.log("游戏已启动");
  await sleep(4000);
  await cdp.shot("gen_01_title.png");

  const cv = await cdp.eval(`(function(){
    var c=document.getElementById("canvas"); if(!c) return null;
    var r=c.getBoundingClientRect();
    return { x:r.left, y:r.top, w:r.width, h:r.height, cw:c.width, ch:c.height };
  })()`);
  if (!cv) { console.error("找不到 canvas"); chrome.kill(); process.exit(1); }
  const toPage = (gx, gy) => ({
    x: cv.x + (gx / cv.cw) * cv.w,
    y: cv.y + (gy / cv.ch) * cv.h,
  });

  console.log("\n=== 建号流程 ===");
  let p = toPage(400, 514);
  console.log("① CLICK TO START");
  await cdp.click(p.x, p.y);
  await sleep(5000);
  await cdp.shot("gen_02_newname.png");

  // 检查软键盘状态是否被游戏激活
  const kb = await cdp.eval(`(function(){
    var s = Module.wasmSoftKeyboardState;
    return { exists: !!s, active: s ? !!s.active : null,
             chars: s ? s.pendingChars.length : null,
             keys: s ? s.pendingKeys.length : null };
  })()`);
  console.log("② 软键盘状态:", JSON.stringify(kb));

  // 激活软键盘并输名字
  const NAME = "zfsn";
  console.log("③ 输用户名 " + NAME + "（走真实 WasmStartSoftKeyboard 路径）");
  // 直接调 wasmImports 里的 WasmStartSoftKeyboard 不可行（闭包内），
  // 但游戏自己会调它 —— 输名字的界面就是它主动开的。
  // 所以这里模拟真实按键：聚焦 textarea 后用 CDP 敲字符。
  await cdp.eval(`(function(){
    var i=document.getElementById("pvz-soft-keyboard");
    if(i) i.focus(); return true;
  })()`);
  for (const ch of NAME) {
    await cdp.key(ch, "Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), ch);
    await sleep(200);
  }
  await sleep(1000);
  const typedState = await cdp.eval(`(function(){
    var i=document.getElementById("pvz-soft-keyboard");
    var s=Module.wasmSoftKeyboardState;
    return { textareaValue: i?i.value:null,
             active: s?!!s.active:null,
             pendingChars: s?s.pendingChars.length:null };
  })()`);
  console.log("   打字后:", JSON.stringify(typedState));
  await cdp.shot("gen_03_named.png");

  console.log("④ 回车确认");
  await cdp.key("Enter", "Enter", 13);
  await sleep(6000);
  await cdp.shot("gen_04_after_ok.png");

  const kb2 = await cdp.eval(`(function(){
    var s=Module.wasmSoftKeyboardState;
    return { active: s?!!s.active:null, pendingChars: s?s.pendingChars.length:null };
  })()`);
  console.log("   回车后软键盘:", JSON.stringify(kb2));

  // 进冒险模式，触发存档写入
  console.log("\n⑤ 进冒险模式");
  p = toPage(640, 100);
  await cdp.click(p.x, p.y);
  await sleep(10000);
  await cdp.shot("gen_05_ingame.png");

  console.log("⑥ syncfs 落盘");
  await cdp.eval(`(function(){
    return new Promise(function(res){
      try { Module.FS.syncfs(false, function(e){ console.log("[gen] syncfs err="+e); res(e); }); }
      catch(e){ res("throw "+e); }
    });
  })()`).then((r) => console.log("   syncfs:", r)).catch((e) => console.log("   syncfs 失败:", e.message));
  await sleep(5000);

  const listing = await cdp.eval(DUMP_ALL);
  console.log(`\n=== /saves 下共 ${listing.total} 个文件，其中存档类 ${listing.saves.length} 个 ===`);
  if (!listing.saves.length) {
    console.log("（没有存档 —— 建号可能没成功）");
    await cdp.shot("gen_06_nosave.png");
  } else {
    const dir = path.join(OUTDIR, "pvz_gen_saves");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of listing.saves) {
      const r = await cdp.eval(`${READ_ONE}(${JSON.stringify(f.path)})`);
      const name = f.path.replace(/[/\\]/g, "_").replace(/^_+/, "");
      const buf = Buffer.from(r.hex, "hex");
      const outPath = path.join(dir, name);
      fs.writeFileSync(outPath, buf);
      console.log(`\n${f.path}`);
      console.log(`  大小: ${r.size} 字节 → ${outPath}`);
      console.log(`  头 96 字节: ${r.hex.slice(0, 192)}`);
      if (r.text && /^[\x09\x0a\x0d\x20-\x7e一-鿿]*$/.test(r.text.slice(0, 4000))) {
        console.log("  ★ 是可读文本！内容:");
        console.log(r.text.split("\n").slice(0, 60).map((l) => "    " + l).join("\n"));
      } else {
        const printable = r.hex.match(/../g).filter((b) => {
          const v = parseInt(b, 16);
          return (v >= 32 && v < 127) || v === 9 || v === 10 || v === 13;
        }).length;
        console.log(`  可打印字节比例: ${(printable / Math.max(1, r.size) * 100).toFixed(1)}%`);
      }
    }
  }

  try { ws.close(); } catch (e) {}
  chrome.kill();
})();
