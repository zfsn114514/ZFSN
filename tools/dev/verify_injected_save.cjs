/**
 * 验证「构造存档」方案：把 gen_unlocked_save.py 生成的
 * user1.dat / users.dat 写进 IDBFS，然后重载游戏，
 * 看它是否真的按「已通关」加载（金币 99999、关卡全解锁）。
 *
 * 关键点：IDBFS 里的文件是持久化的，所以要**先写、再重载**，
 * 让游戏自己走 Load() → SyncState → LoadDetails 读一遍。
 * 只有这样才能证明字节布局是对的 —— 游戏读到错误的 version
 * 会打印 "Failed to player data, resetting it" 并把字段清零。
 *
 * 用法: node tools/dev/verify_injected_save.cjs [url]
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9700 + (process.pid % 200);
const OUTDIR = "C:/Users/Administrator/WorkBuddy/2026-10-02-22-27-21";
const SAVEDIR = path.join(OUTDIR, "unlock_save");

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
    this.logs = [];
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        return;
      }
      if (m.method === "Runtime.consoleAPICalled") {
        const txt = (m.params.args || []).map((a) =>
          a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" ");
        this.logs.push(txt);
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
  async move(x, y) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  }
  async click(x, y) {
    await this.move(x, y);
    await sleep(150);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    await sleep(80);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
    await sleep(700);
  }
  async key(ch) {
    const printable = ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127;
    let code, vk;
    if (/^[a-zA-Z]$/.test(ch)) { code = "Key" + ch.toUpperCase(); vk = ch.toUpperCase().charCodeAt(0); }
    else if (ch === "Enter") { code = "Enter"; vk = 13; }
    else { code = ch; vk = ch.toUpperCase().charCodeAt(0); }
    const down = { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (printable) { down.text = ch; down.unmodifiedText = ch; }
    await this.send("Input.dispatchKeyEvent", down);
    await sleep(60);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (r && r.data) fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, "base64"));
  }
}

/* 列出 /saves/userdata 下所有文件（hex + size + md5） */
const SNAP = `(function () {
  var out = {};
  function walk(dir, depth) {
    var names; try { names = Module.FS.readdir(dir); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      var p = dir + "/" + names[i], st;
      try { st = Module.FS.stat(p); } catch (e) { continue; }
      if (Module.FS.isDir(st.mode)) { if (depth < 3) walk(p, depth + 1); }
      else {
        var m = p.match(/^\\/saves\\/userdata\\/([^/]+)$/);
        if (m) {
          try {
            var b = Module.FS.readFile(p), hex = "", parts = [];
            for (var k = 0; k < b.length; k++) parts.push((b[k] < 16 ? "0" : "") + b[k].toString(16));
            out[m[1]] = { size: b.length, hex: parts.join("") };
          } catch (e) {}
        }
      }
    }
  }
  walk("/saves", 0); return out;
})()`;

/* 把 base64 存档写进 IDBFS */
const WRITE = (name, b64) => `(function(){
  var bin = atob(${JSON.stringify(b64)});
  var buf = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  try { Module.FS.mkdir("/saves/userdata"); } catch (e) {}
  Module.FS.writeFile("/saves/userdata/" + ${JSON.stringify(name)}, buf);
  return buf.length;
})()`;

function u32(hex, off) {
  return hex.length >= off + 8 ? parseInt(hex.substr(off * 2, 8), 16) : null;
}

(async function main() {
  const userDat = fs.readFileSync(path.join(SAVEDIR, "user1.dat"));
  const usersDat = fs.readFileSync(path.join(SAVEDIR, "users.dat"));
  console.log("待注入：user1.dat %d 字节 / users.dat %d 字节", userDat.length, usersDat.length);
  console.log("  user1.dat md5 =", crypto.createHash("md5").update(userDat).digest("hex"));
  console.log("  users.dat md5 =", crypto.createHash("md5").update(usersDat).digest("hex"));

  const profile = path.join(os.tmpdir(), "pvz-inject-" + process.pid);
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

  async function boot() {
    await cdp.send("Page.navigate", { url: URL_ });
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const st = await cdp.eval(`(function(){var b=document.getElementById("boot");return {hidden:!!(b&&b.style.display==="none")};})()`).catch(() => null);
      if (st && st.hidden) return true;
    }
    return false;
  }

  console.log("\n【第 1 轮】空 IDBFS，启动游戏");
  if (!await boot()) { console.error("启动失败"); chrome.kill(); process.exit(1); }
  await sleep(4000);

  let snap = await cdp.eval(SNAP);
  console.log("  注入前 /saves/userdata:", Object.keys(snap).join(", ") || "（空）");

  // ── 写入存档 ──
  console.log("\n【注入】写入 user1.dat + users.dat 并 syncfs");
  const n1 = await cdp.eval(WRITE("user1.dat", userDat.toString("base64")));
  const n2 = await cdp.eval(WRITE("users.dat", usersDat.toString("base64")));
  console.log("  写入字节:", n1, n2);
  await cdp.eval(`new Promise(function(r){ Module.FS.syncfs(false, function(){ r(1); }); })`);
  await sleep(2500);

  snap = await cdp.eval(SNAP);
  console.log("  注入后 /saves/userdata:");
  for (const k of Object.keys(snap).sort()) {
    console.log(`    ${k}  ${snap[k].size} 字节  md5=${crypto.createHash("md5").update(Buffer.from(snap[k].hex, "hex")).digest("hex")}`);
  }

  // ── 重载，让游戏自己读 ──
  console.log("\n【第 2 轮】重载页面，让游戏自己读存档");
  cdp.logs.length = 0;
  if (!await boot()) { console.error("重载后启动失败"); chrome.kill(); process.exit(1); }
  await sleep(6000);

  const bad = cdp.logs.filter((l) => /Failed to player data|resetting it/i.test(l));
  console.log("  存档加载报错:", bad.length ? bad.join(" | ") : "无 ✅");

  snap = await cdp.eval(SNAP);
  console.log("  重载后 /saves/userdata:", Object.keys(snap).join(", ") || "（空）");

  // ── 游戏内表现：主菜单应显示 99999 金币 ──
  const cv = await cdp.eval(`(function(){var c=document.getElementById("canvas");var r=c.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,cw:c.width,ch:c.height};})()`);
  const SX = cv.cw / cv.w, SY = cv.ch / cv.h;
  const toPage = (gx, gy) => ({ x: cv.x + gx * SX, y: cv.y + gy * SY });
  console.log("  canvas scale =", SX.toFixed(4), SY.toFixed(4));

  await cdp.shot("inj_01_boot.png");

  // CLICK TO START → 若是新号会要求建号；若是老号直接进主菜单
  let p = toPage(400, 514);
  await cdp.click(p.x, p.y);
  await sleep(6000);
  await cdp.shot("inj_02_after_start.png");

  console.log("\n  全部控制台日志（存档相关）:");
  cdp.logs.filter((l) => /player data|profile|user|save|reset/i.test(l))
    .slice(0, 20).forEach((l) => console.log("   ", l));

  chrome.kill();
  console.log("\n完成。截图: inj_01_boot.png / inj_02_after_start.png");
})().catch((e) => { console.error("失败:", e.message); process.exit(1); });
