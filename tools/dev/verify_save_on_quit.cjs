/**
 * 收官实验：让游戏**正常退出**，看它到底写不写 user{N}.dat
 * ─────────────────────────────────────────────────────────────
 * 前面几轮已经摸清的事实：
 *   · 存档路径确实是 userdata/user{N}.dat + users.dat（wasm 里挖到的）
 *   · 但不管建号、进关卡、还是输入作弊码，/saves/userdata 下
 *     **始终只有 users.dat（19 字节，只存用户名）**，
 *     user{N}.dat 从来没出现过
 *   · users.dat 内容: 0e000000 0100 0300 4666736e 01000000 01000000
 *     = 版本 14、1 个用户、名字长度 3、"Fsn"、然后两个计数
 *     跟零售原版 users.dat 结构一模一样（对比 D:\Desktop 的
 *     0e000000 0100 0400 31333132 ...）—— 说明 mod 沿用了原版容器格式
 *
 * 也就是说：**进度数据在 user{N}.dat 里，而这个文件只有游戏
 * 真正落盘时才生成**。之前所有测试都是 headless 里跑完就 kill，
 * 进程被 SIGKILL，游戏的保存逻辑根本没跑完。
 *
 * 这一步要验证的：走游戏自己的「退出」流程（QUIT 按钮或确认弹窗），
 * 让它正常保存并关闭，然后看 user{N}.dat 是否出现、内容长什么样。
 * 拿到它 = 拿到全解锁所需的完整格式信息。
 *
 * 用法: node tools/dev/verify_save_on_quit.cjs [url]
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9400 + (process.pid % 150);
const OUTDIR = "C:/Users/Administrator/WorkBuddy/2026-10-02-22-27-21";
const crypto = require("crypto");

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
      throw new Error("JS err " + (d.exception ? d.exception.description : d.text).slice(0, 400));
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
    await sleep(600);
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
    if (r && r.data) { fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, "base64")); }
  }
}

const SNAP = `(function () {
  function walk(dir, depth, out) {
    var names; try { names = Module.FS.readdir(dir); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      var p = dir + "/" + names[i], st;
      try { st = Module.FS.stat(p); } catch (e) { continue; }
      if (Module.FS.isDir(st.mode)) { if (depth < 3) walk(p, depth + 1, out); }
      else {
        var norm = p.replace(/\\\\/g, "/").replace(/\\/\\.\\//g, "/").replace(/\\/\\.\\.\\//g, "/");
        var m = norm.match(/^\\/saves\\/userdata\\/([^/]+)$/);
        if (m) {
          try {
            var b = Module.FS.readFile(p), hex = "", txt = null;
            for (var k = 0; k < b.length; k++) hex += (b[k] < 16 ? "0" : "") + b[k].toString(16);
            try { txt = UTF8ToString(b); } catch (e) {}
            out[m[1]] = { size: b.length, hex: hex, text: txt };
          } catch (e) {}
        }
      }
    }
  }
  var out = {}; walk("/saves", 0, out); return out;
})()`;

function summarize(s) {
  const lines = [];
  for (const k of Object.keys(s).sort()) {
    const md5 = crypto.createHash("md5").update(Buffer.from(s[k].hex, "hex")).digest("hex");
    lines.push(`  ${k}  ${s[k].size} 字节  md5=${md5}`);
  }
  return lines.join("\n") || "  （空）";
}

(async function main() {
  const profile = path.join(os.tmpdir(), "pvz-quit-" + process.pid);
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
    const st = await cdp.eval(`(function(){var b=document.getElementById("boot");return {hidden:!!(b&&b.style.display==="none")};})()`).catch(() => null);
    if (st && st.hidden) { booted = true; break; }
  }
  if (!booted) { console.error("没启动成功"); chrome.kill(); process.exit(1); }
  console.log("游戏已启动");
  await sleep(4000);

  const cv = await cdp.eval(`(function(){var c=document.getElementById("canvas");var r=c.getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height,cw:c.width,ch:c.height};})()`);
  const SX = cv.cw / cv.w, SY = cv.ch / cv.h;
  const toPage = (gx, gy) => ({ x: cv.x + gx * SX, y: cv.y + gy * SY });
  console.log("scale=(" + SX.toFixed(4) + "," + SY.toFixed(4) + ")");

  // 建号
  console.log("\n① CLICK TO START");
  let p = toPage(400, 514);
  await cdp.click(p.x, p.y);
  await sleep(5000);
  await cdp.eval(`(function(){var i=document.getElementById("pvz-soft-keyboard"); if(i)i.focus(); return true;})()`);
  for (const ch of "zfsn") { await cdp.key(ch); await sleep(450); }
  await sleep(1500);
  await cdp.key("Enter");
  await sleep(7000);
  await cdp.shot("q_01_menu.png");
  console.log("   建号完成");

  // 进冒险模式 → 关卡地图（先不进关卡！）
  console.log("② 点 START ADVENTURE → 关卡选择地图");
  p = toPage(528, 121);
  await cdp.click(p.x, p.y);
  await sleep(14000);
  await cdp.shot("q_02_map.png");

  const s1 = await cdp.eval(SNAP);
  console.log("   此刻存档: " + Object.keys(s1).join(", "));

  /* 关键：在关卡地图上先不点关卡，直接测作弊码，然后走正常退出。
   * 作弊码 future 必须在关卡地图输入 —— 之前几次失败就是因为
   * 点进了关卡实战画面（截图 cr_04 显示的是战斗画面，不是地图）。
   */
  console.log('\n③ 在关卡地图输入 "future"');
  await cdp.eval(`(function(){try{document.getElementById("canvas").focus();}catch(e){}return true;})()`);
  for (const ch of "future") { await cdp.key(ch); await sleep(450); }
  await sleep(3000);
  await cdp.shot("q_03_after_code.png");

  const s2 = await cdp.eval(SNAP);
  console.log("   输入后: " + Object.keys(s2).join(", "));

  /* 再点一次 START ADVENTURE 会进第一关。我们不要。
   * 直接回主菜单：先按 Esc 或点左上角的返回。
   * 老马 mod 主菜单墓碑上 QUIT 在右下 (533,494) 游戏坐标。
   * 但现在在关卡地图 —— 先退回主菜单。
   * 关卡地图上左下角有 "MAIN MENU" 按钮，位置需要实测。
   * 这里用最稳的办法：直接调 wasm 退出不可行，改为点墓碑 QUIT。
   * 先看看能不能通过键盘返回。
   */
  console.log("\n④ 尝试正常退出（Esc → 可能弹确认框）");
  await cdp.key("Escape");
  await sleep(2500);
  await cdp.shot("q_04_esc.png");

  // 如果有确认框，点 YES
  const before = await cdp.eval(SNAP);
  console.log("   退出前: " + Object.keys(before).join(", "));

  await sleep(1500);
  await cdp.shot("q_05_before_quit.png");

  // 尝试点击可能的 YES 位置（确认框一般在中间）
  for (const [gx, gy, label] of [[400, 320, "确认框YES"], [400, 350, "确认框YES2"], [330, 400, "左侧返回"]]) {
    const q = toPage(gx, gy);
    await cdp.click(q.x, q.y);
    await sleep(2000);
    await cdp.shot("q_06_after_" + label + ".png");
  }

  // 强制 syncfs
  await cdp.eval(`(function(){
    return new Promise(function(res){ try{ Module.FS.syncfs(false, function(){res(1);}); }catch(e){res(0);} });
  })()`);
  await sleep(5000);

  const s3 = await cdp.eval(SNAP);
  console.log("\n=== 最终存档 ===");
  console.log(summarize(s3));

  const dir = path.join(OUTDIR, "pvz_quit_saves");
  fs.mkdirSync(dir, { recursive: true });
  for (const k of Object.keys(s3)) {
    const buf = Buffer.from(s3[k].hex, "hex");
    fs.writeFileSync(path.join(dir, k), buf);
    console.log(`\n${k}  (${buf.length} 字节)`);
    console.log("  hex 头 128: " + s3[k].hex.slice(0, 256));
    if (s3[k].text) {
      const clean = s3[k].text.replace(/[^\x09\x0a\x0d\x20-\x7e一-鿿]/g, "·");
      console.log("  可读化: " + clean.slice(0, 400));
    }
  }

  try { ws.close(); } catch (e) {}
  chrome.kill();
})();
