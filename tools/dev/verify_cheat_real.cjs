/**
 * 决定性实验：在关卡地图上用「真实按键」输入作弊码 future，看存档是否变化
 * ─────────────────────────────────────────────────────────────
 * 这次实验的由来（gen_save.cjs 的意外收获）：
 *   gen_save 里我用 CDP 原生按键（Input.dispatchKeyEvent）往软键盘
 *   textarea 敲名字，结果：
 *     · Module.wasmSoftKeyboardState 从「不存在」变成 exists=true, active=true
 *     · users.dat 被游戏写出来了（名字 "Fsn"）
 *   也就是说 **软键盘是可以被真实输入激活的**，
 *   之前 diag_softkb 得出「页面侧无法开启软键盘」的结论下得太早 ——
 *   真正的原因是当时没走到建号输入框，or 没用真实输入管线。
 *
 *   但这也说明：作弊码 `future` 在关卡地图上输入时，
 *   走的是**普通键盘通道**（游戏主循环的 keydown），
 *   不是软键盘 —— 软键盘只在有文本框时 active。
 *   所以这里要用真实按键 + 正确界面，两个条件缺一不可。
 *
 * 判定标准（吸取上次误判的教训）：
 *   **不看日志、不看截图，只看存档字节是否变化。**
 *   存档不变 = 没生效。之前就是靠截图变化误判成成功的。
 *
 * 用法: node tools/dev/verify_cheat_real.cjs [url]
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9600 + (process.pid % 300);
const OUTDIR = "C:/Users/Administrator/WorkBuddy/2026-10-02-22-27-21";
const CODE = "future";

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
    /* ⚠ 必须先 mouseMoved 再 press。
     * PvZ 的主循环靠 mousemove 更新内部光标位置；如果直接派发
     * mousedown/mouseup 而没有前置 mousemove，游戏侧鼠标位置还停在
     * 旧坐标，点击会被当成在别处按下而被丢弃。
     * 证据：diag_click.cjs（带 mouseMoved）能点进关卡地图，
     *       而本脚本早先版本（不带）连点几次都停在主菜单。
     * 另一个细节：clickCount 必须给 1，否则可能被当双击的前半段。 */
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await sleep(150);
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1,
    });
    await sleep(80);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0,
    });
    await sleep(600);
  }
  /* 真实按键：走浏览器完整输入管线
   *
   * ⚠ CDP 的 Input.dispatchKeyEvent 对 `text` 校验很严：
   *   · 只能传**单个字符**，多字符（比如 "\r"）直接报
   *     "Invalid 'text' parameter"
   *   · 不可打印字符（Enter/Escape/箭头）必须**完全省略** text 字段，
   *     不能传 undefined 占位（JSON 里会变成 null，照样报错）
   * 所以这里按 key 是否可打印分别构造 params。
   */
  async key(ch) {
    const printable = ch.length === 1 && ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127;
    let code, vk;
    if (/^[a-zA-Z]$/.test(ch)) { code = "Key" + ch.toUpperCase(); vk = ch.toUpperCase().charCodeAt(0); }
    else if (/^[0-9]$/.test(ch)) { code = "Digit" + ch; vk = ch.charCodeAt(0); }
    else if (ch === "Enter") { code = "Enter"; vk = 13; }
    else if (ch === "Escape") { code = "Escape"; vk = 27; }
    else { code = ch; vk = ch.toUpperCase().charCodeAt(0); }

    const down = { type: "keyDown", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (printable) { down.text = ch; down.unmodifiedText = ch; }
    await this.send("Input.dispatchKeyEvent", down);
    await sleep(60);
    await this.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: ch, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
    });
  }
  async shot(name) {
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    if (r && r.data) { fs.writeFileSync(path.join(OUTDIR, name), Buffer.from(r.data, "base64")); }
  }
}

/* 抓 /saves 下真实存档（含 userN.dat / game*.dat），返回 hex + size */
const SNAP = `(function () {
  function walk(dir, depth, out) {
    var names; try { names = Module.FS.readdir(dir); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      var p = dir + "/" + names[i], st;
      try { st = Module.FS.stat(p); } catch (e) { continue; }
      if (Module.FS.isDir(st.mode)) { if (depth < 3) walk(p, depth + 1, out); }
      else {
        // 规范化路径，只保留 /userdata/ 下的存档
        var norm = p.replace(/\\\\/g, "/").replace(/\\/\\.\\//g, "/").replace(/\\/\\.\\.\\//g, "/");
        var m = norm.match(/^\\/saves\\/userdata\\/([^/]+)$/);
        if (m) {
          try {
            var b = Module.FS.readFile(p), hex = "";
            for (var k = 0; k < b.length; k++) hex += (b[k] < 16 ? "0" : "") + b[k].toString(16);
            out[m[1]] = { size: b.length, hex: hex };
          } catch (e) {}
        }
      }
    }
  }
  var out = {};
  walk("/saves", 0, out);
  return out;
})()`;

function snapSummary(s) {
  const lines = [];
  for (const k of Object.keys(s).sort()) {
    lines.push(`  ${k}  ${s[k].size} 字节  md5=${require("crypto").createHash("md5").update(Buffer.from(s[k].hex, "hex")).digest("hex")}`);
  }
  return lines.join("\n") || "  （空）";
}

function diffSnap(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out = [];
  for (const k of [...keys].sort()) {
    const A = a[k], B = b[k];
    if (!A) { out.push(`  + 新增 ${k} (${B.size} 字节)`); continue; }
    if (!B) { out.push(`  - 消失 ${k}`); continue; }
    if (A.hex !== B.hex) {
      let firstDiff = -1;
      const n = Math.min(A.hex.length, B.hex.length);
      for (let i = 0; i < n; i += 2) {
        if (A.hex.slice(i, i + 2) !== B.hex.slice(i, i + 2)) { firstDiff = i / 2; break; }
      }
      out.push(`  ~ 变化 ${k}: ${A.size}→${B.size} 字节，首个差异在偏移 ${firstDiff}`);
    } else {
      out.push(`  = 未变 ${k} (${A.size} 字节)`);
    }
  }
  return out.join("\n") || "  （无差异）";
}

(async function main() {
  const profile = path.join(os.tmpdir(), "pvz-cheatreal-" + process.pid);
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

  const cv = await cdp.eval(`(function(){
    var c=document.getElementById("canvas"); var r=c.getBoundingClientRect();
    return { x:r.left, y:r.top, w:r.width, h:r.height, cw:c.width, ch:c.height };
  })()`);
  /* 关键：canvas 的 CSS 尺寸和属性尺寸**不是等比**的。
   * headless 窗口 1280x800 下，rect = 865x649，而属性是 800x600。
   * 比例 x: 865/800 = 1.081，y: 649/600 = 1.082 —— 看着接近，
   * 但 canvas 用了 object-fit 之外的方式（页面里是
   * `Math.min(container.clientWidth/canvas.width, ...)` 定的尺寸），
   * 实际渲染时左右会有黑边（见截图：画面 x∈[176,902]）。
   *
   * 所以正确的做法不是纯算术，而是**读 rect 后按可见画面反推**：
   * 画面在页面里居中，宽 = rect.w * (ch/ (cw*rect.h/rect.w))…
   * 太绕。直接实测：diag_click.cjs 用 CDP 探针量到
   *   派发页面坐标 (770,130) → 事件 offsetX/offsetY = (571,131)
   * 而 (571,131) 对应 800x600 里的游戏坐标正好是 START ADVENTURE
   * 所在的石碑位置。也就是说：
   *   **用 offsetX/offsetY 校准换算系数最可靠** ——
   *   游戏坐标 = offsetX * (canvas.width / rect.w)。
   *
   * 代入：800/865 = 0.9251。校验 (770,130)：
   *   (770-199.5)*0.9251 = 528 ✓  (130-0)*0.9251 = 120 ✓
   * 与实测的 START ADVENTURE 游戏坐标 (528,121) 吻合。
   */
  const SX = cv.cw / cv.w;
  const SY = cv.ch / cv.h;
  const toPage = (gx, gy) => ({ x: cv.x + gx * SX, y: cv.y + gy * SY });
  console.log("坐标换算: rect=" + JSON.stringify(cv) + " scale=(" + SX.toFixed(4) + "," + SY.toFixed(4) + ")");

  // ① 建号
  console.log("\n① CLICK TO START");
  let p = toPage(400, 514);
  await cdp.click(p.x, p.y);
  await sleep(5000);
  await cdp.shot("cr_01_newname.png");

  const kb = await cdp.eval(`(function(){
    var s=Module.wasmSoftKeyboardState;
    return { exists: !!s, active: s?!!s.active:null };
  })()`);
  console.log("   软键盘:", JSON.stringify(kb));

  console.log("② 输用户名（真实按键，慢速）");
  await cdp.eval(`(function(){var i=document.getElementById("pvz-soft-keyboard"); if(i)i.focus(); return true;})()`);
  for (const ch of "zfsn") { await cdp.key(ch); await sleep(500); }
  await sleep(1500);
  const nm = await cdp.eval(`(function(){
    var i=document.getElementById("pvz-soft-keyboard"); var s=Module.wasmSoftKeyboardState;
    return { value: i?i.value:null, active: s?!!s.active:null, chars: s?s.pendingChars.length:null };
  })()`);
  console.log("   ", JSON.stringify(nm));
  await cdp.shot("cr_02_named.png");

  console.log("③ 回车");
  await cdp.key("Enter");
  await sleep(7000);
  await cdp.shot("cr_03_menu.png");

  // ② 进冒险模式 → 关卡地图
  //
  // ⚠ 坐标是从截图量出来的，别再拍脑袋：
  //   这个 mod 的主菜单是一块**倾斜的墓碑**，START ADVENTURE 文字
  //   中心在截图坐标约 (655,110)。canvas 在 1280x800 窗口里的实际
  //   显示区域是 x∈[176,902]、y∈[0,547]（宽 726、高 547），
  //   换算回 800x600 游戏坐标 = ((655-176)/726*800, (110-0)/547*600)
  //   = (528, 121)。
  //   之前用的 (640,100) 落在 START ADVENTURE 上方的空白天空处，
  //   点了个寂寞 —— 截图 cr_03/cr_04 都还停在主菜单就是这个原因。
  console.log("④ 点 START ADVENTURE（游戏坐标 528,121）");
  p = toPage(528, 121);
  await cdp.click(p.x, p.y);
  await sleep(12000);
  await cdp.shot("cr_04_map.png");

  /* 自动判据：确认真的进了关卡地图，而不是还停、主菜单。
   *
   * 不靠肉眼的原因：之前两次把"截图有变化"当成解锁证据，
   * 结果是误判。这里只信两类可量化信号：
   *   ① 存档文件从只有 users.dat 变成出现 user{N}.dat
   *   ② 或者 console 里出现关卡地图特有的资源加载日志
   * 拿不到 user{N}.dat 就说明还没真正进关卡。
   */
  await cdp.eval(`(function(){
    return new Promise(function(res){ try{ Module.FS.syncfs(false, function(){res(1);}); }catch(e){res(0);} });
  })()`);
  await sleep(4000);
  const mapSnap = await cdp.eval(SNAP);
  const hasUserFile = Object.keys(mapSnap).some((k) => /^user\d+\.dat$/.test(k));
  console.log("   进图后存档文件: " + Object.keys(mapSnap).join(", "));
  if (!hasUserFile) {
    console.log("   ⚠ 没有 user{N}.dat —— 大概率还在主菜单，");
    console.log("     作弊码不会生效（它只在关卡地图消费）。");
  } else {
    console.log("   ✔ 出现 user{N}.dat，已进入关卡流程");
  }

  const before = await cdp.eval(SNAP);
  console.log("\n=== 作弊前存档 ===");
  console.log(snapSummary(before));

  // ⑤ 在关卡地图上输入作弊码
  console.log(`\n⑤ 在关卡地图上输入作弊码 "${CODE}"（真实按键，先点 canvas 聚焦）`);
  await cdp.eval(`(function(){ try{ document.getElementById("canvas").focus(); }catch(e){} return true; })()`);
  await sleep(500);
  for (const ch of CODE) { await cdp.key(ch); await sleep(450); }
  await sleep(3000);
  await cdp.shot("cr_05_after_code.png");

  // ⑥ 让游戏写档
  console.log("⑥ 触发存档写入");
  // 作弊码解锁后，游戏通常在**离开关卡地图**时才落盘，
  // 所以这里先进下一关再退出，逼它把进度写进 user{N}.dat。
  // 但先取一次快照，单独看输入阶段有没有效果。
  const midSnap = await cdp.eval(SNAP);
  console.log("   输入后立即读:", snapSummary(midSnap));
  console.log("   与输入前对比:");
  console.log(diffSnap(before, midSnap));

  await cdp.eval(`(function(){
    return new Promise(function(res){ try{ Module.FS.syncfs(false, function(){res(1);}); }catch(e){res(0);} });
  })()`);
  await sleep(5000);

  const after = await cdp.eval(SNAP);
  console.log("\n=== 作弊后存档 ===");
  console.log(snapSummary(after));

  console.log("\n=== 字节级对比（唯一可信的判据）===");
  const d = diffSnap(before, after);
  console.log(d);

  const changed = d.split("\n").some((l) => l.includes("~ 变化") || l.includes("+ 新增"));
  console.log("\n=== 结论 ===");
  console.log(changed
    ? "✅ 存档发生变化 —— 作弊码生效了（但还需确认解锁了哪些内容）"
    : "❌ 存档完全没变 —— 作弊码在这个界面/通道上没生效");

  // 顺便看看游戏当前在哪个画面
  await cdp.shot("cr_06_final.png");
  try { ws.close(); } catch (e) {}
  chrome.kill();
})();
