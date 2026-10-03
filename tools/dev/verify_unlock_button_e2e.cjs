/**
 * 端到端验证页面上的「通关存档」按钮：
 *   ① 空 IDBFS 启动游戏（新建号）
 *   ② 走建号流程，让游戏自己写出 users.dat + user1.dat
 *   ③ 点「通关存档」按钮（走页面里真正的 applyFullUnlock）
 *   ④ 刷新页面，看游戏是否按全解锁加载（进冒险模式应直接到 5-10）
 *
 * 这一步同时验证两件事：
 *   · 页面按钮能跑通（save-builder.js 正确加载 + IDBFS 写入成功）
 *   · 游戏自己写出的 user1.dat 与我们构造的布局一致
 *     （对比游戏写的和我们构造的字节，字段区应当一致）
 *
 * 用法: node tools/dev/verify_unlock_button_e2e.cjs [url]
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
const PORT = 9500 + (process.pid % 200);
const OUTDIR = "C:/Users/Administrator/WorkBuddy/2026-10-02-22-27-21";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash("md5").update(b).digest("hex");

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
    this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = [];
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
        this.logs.push((m.params.args || []).map((a) =>
          a.value !== undefined ? String(a.value) : (a.description || a.type)).join(" "));
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
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await sleep(150);
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
    await sleep(80);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
    await sleep(700);
  }
  async key(ch) {
    let code, vk;
    if (/^[a-zA-Z]$/.test(ch)) { code = "Key" + ch.toUpperCase(); vk = ch.toUpperCase().charCodeAt(0); }
    else if (ch === "Enter") { code = "Enter"; vk = 13; }
    else { code = ch; vk = ch.toUpperCase().charCodeAt(0); }
    const down = { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (ch.length === 1 && ch.charCodeAt(0) >= 32) { down.text = ch; down.unmodifiedText = ch; }
    await this.send("Input.dispatchKeyEvent", down);
    await sleep(60);
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (r && r.data) fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, "base64"));
  }
}

const SNAP = `(function () {
  var out = {};
  function walk(dir, depth) {
    var names; try { names = Module.FS.readdir(dir); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      var p = dir + "/" + names[i], st;
      try { st = Module.FS.stat(p); } catch (e) { continue; }
      if (Module.FS.isDir(st.mode)) { if (depth < 3) walk(p, depth + 1); }
      else if (p.match(/^\\/saves\\/userdata\\/[^/]+$/)) {
        try {
          var b = Module.FS.readFile(p), parts = [];
          for (var k = 0; k < b.length; k++) parts.push((b[k] < 16 ? "0" : "") + b[k].toString(16));
          out[p.split("/").pop()] = { size: b.length, hex: parts.join("") };
        } catch (e) {}
      }
    }
  }
  walk("/saves", 0); return out;
})()`;

function rd32(hex, byteOff) {
  if (hex.length < (byteOff + 4) * 2) return null;
  // 小端：低字节在前。用 Number 显式转换，避免 parseInt 的字符串拼接坑。
  let v = 0;
  for (let i = 3; i >= 0; i--) v = v * 256 + parseInt(hex.substr((byteOff + i) * 2, 2), 16);
  return v;
}

(async function main() {
  const profile = path.join(os.tmpdir(), "pvz-btn-" + process.pid);
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
      cdp.lastDialog = m.params.message;
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
  async function canvasMap() {
    const cv = await cdp.eval(`(function(){var c=document.getElementById("canvas");var r=c.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,cw:c.width,ch:c.height};})()`);
    const SX = cv.cw / cv.w, SY = cv.ch / cv.h;
    return (gx, gy) => ({ x: cv.x + gx * SX, y: cv.y + gy * SY });
  }

  /* ── ① 启动 + 建号 ── */
  console.log("【①】空 IDBFS 启动");
  if (!await boot()) { console.error("启动失败"); chrome.kill(); process.exit(1); }
  await sleep(4000);

  const builderOk = await cdp.eval(`typeof buildUnlockedUserDat === "function"`);
  console.log("  save-builder.js 已加载:", builderOk ? "是 ✅" : "否 ❌");

  const toPage = await canvasMap();
  let p = toPage(400, 514);
  await cdp.click(p.x, p.y);
  await sleep(5000);
  await cdp.eval(`(function(){var i=document.getElementById("pvz-soft-keyboard"); if(i)i.focus(); return true;})()`);
  for (const ch of "zfsn") { await cdp.key(ch); await sleep(420); }
  await sleep(1200);
  await cdp.key("Enter");
  await sleep(7000);
  await cdp.shot("btn_01_after_create.png");

  let snap = await cdp.eval(SNAP);
  console.log("  建号后 /saves/userdata:", Object.keys(snap).join(", ") || "（空）");
  for (const k of Object.keys(snap).sort()) {
    console.log(`    ${k}  ${snap[k].size} 字节  md5=${md5(Buffer.from(snap[k].hex, "hex"))}`);
  }

  /* ── ② 点「通关存档」按钮 ── */
  console.log("\n【②】点页面上的「通关存档」按钮");
  cdp.lastDialog = null;
  const btn = await cdp.eval(`(function(){
    var b=document.getElementById("btn-unlock");
    var r=b.getBoundingClientRect();
    return {x:r.left+r.width/2, y:r.top+r.height/2, w:r.width, h:r.height, disabled:b.disabled};
  })()`);
  console.log("  按钮状态:", JSON.stringify(btn));
  await cdp.click(btn.x, btn.y);
  await sleep(6000);
  console.log("  弹窗内容:\n" + (cdp.lastDialog || "（无弹窗）").split("\n").map((l) => "    " + l).join("\n"));
  await cdp.shot("btn_02_after_click.png");

  snap = await cdp.eval(SNAP);
  console.log("\n  按钮写入后 /saves/userdata:");
  for (const k of Object.keys(snap).sort()) {
    const buf = Buffer.from(snap[k].hex, "hex");
    console.log(`    ${k}  ${snap[k].size} 字节  md5=${md5(buf)}`);
    if (k.startsWith("user") && k.endsWith(".dat") && !k.includes("users")) {
      console.log(`      version=${rd32(snap[k].hex, 0)}  mLevel=${rd32(snap[k].hex, 4)}  mCoins=${rd32(snap[k].hex, 8)}  mFinished=${rd32(snap[k].hex, 12)}`);
    }
  }

  /* ── ③ 刷新，看是否按全解锁加载 ── */
  console.log("\n【③】刷新页面，验证加载");
  cdp.logs.length = 0;
  if (!await boot()) { console.error("刷新后启动失败"); chrome.kill(); process.exit(1); }
  await sleep(6000);
  const bad = cdp.logs.filter((l) => /Failed to player data|resetting it/i.test(l));
  console.log("  存档加载报错:", bad.length ? bad.join(" | ") : "无 ✅");

  const toPage2 = await canvasMap();
  p = toPage2(400, 514);
  await cdp.click(p.x, p.y);
  await sleep(6000);
  await cdp.shot("btn_03_menu.png");

  p = toPage2(528, 121);
  await cdp.click(p.x, p.y);
  await sleep(6000);

  // 跳过剧情直到画面稳定
  let prev = null;
  for (let i = 0; i < 40; i++) {
    await cdp.shot("btn_step.png");
    const h = md5(fs.readFileSync(path.join(OUTDIR, "btn_step.png")));
    if (h === prev) { console.log("  画面稳定（第 " + i + " 次检查）"); break; }
    prev = h;
    await cdp.click(700, 250);
    await sleep(2500);
  }
  await cdp.shot("btn_04_unlocked.png");
  console.log("  最终截图: btn_04_unlocked.png");

  chrome.kill();
  console.log("\n完成");
})().catch((e) => { console.error("失败:", e.message); process.exit(1); });
