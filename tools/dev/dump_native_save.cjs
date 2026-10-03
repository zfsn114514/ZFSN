/**
 * 让游戏自己生成一个原生存档，用来确定它实际使用的存档格式
 * ─────────────────────────────────────────────────────────────
 * 为什么这么做：
 *   逆向 wasm 找存档加密函数成本很高，而且很容易被 libpng / OpenGL 里
 *   同样含 "profile" 字样的代码误导（我第一版就反查到了 zlib 的
 *   "length does not match profile" 和 ICC 相关报错，全是无关代码）。
 *
 *   更可靠的办法是让游戏自己写一个存档出来，然后 dump 字节看格式。
 *   如果用户提供的原版存档能被游戏接受，就直接用；
 *   如果不能，dump 出来的字节能告诉我们差在哪。
 *
 * 产出：
 *   nat_*.png   —— 各阶段截图
 *   以及终端里打印的 /saves/userdata 下每个文件的大小与前若干字节
 *
 * 用法: node tools/dev/dump_native_save.cjs [url]
 */
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const URL_ = process.argv[2] || "http://127.0.0.1:8910/pvz/pvz-portable.html";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9600 + (process.pid % 400);
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
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 300));
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
      const p = path.join(OUTDIR, name);
      fs.writeFileSync(p, Buffer.from(r.data, "base64"));
      return p;
    }
  }
}

/* 列出 /saves 下的文件，带大小与十六进制预览 */
const DUMP_SAVE_JS = `(function () {
  function walk(dir, depth, out) {
    var names;
    try { names = Module.FS.readdir(dir); } catch (e) { return; }
    for (var i = 0; i < names.length; i++) {
      var p = dir + "/" + names[i];
      var st;
      try { st = Module.FS.stat(p); } catch (e) { continue; }
      if (Module.FS.isDir(st.mode)) {
        if (depth < 3) walk(p, depth + 1, out);
      } else {
        var bytes = [];
        try {
          var f = Module.FS.readFile(p);
          for (var k = 0; k < Math.min(f.length, 64); k++) bytes.push(f[k]);
        } catch (e) { /* 读不了就算了 */ }
        out.push({
          path: p, size: st.size,
          head: Array.from(bytes),
        });
      }
    }
  }
  var out = [];
  walk("/saves", 0, out);
  return out;
})()`;

function hexPreview(head) {
  return head
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

(async function main() {
  const profile = path.join(os.tmpdir(), "pvzsave-cdp-" + process.pid);
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

  console.log("打开:", URL_);
  await cdp.send("Page.navigate", { url: URL_ });

  // 等游戏加载（分片 46MB，本地也要一会儿）
  console.log("等游戏加载（约 60 秒）…");
  let booted = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await cdp.eval(`(function(){
      var b=document.getElementById("boot");
      return { hidden: !!(b && b.style.display==="none"),
               pct: (document.getElementById("pct")||{}).textContent,
               err: (document.getElementById("err")||{}).textContent };
    })()`);
    if (st && st.hidden) { booted = true; break; }
    if (i % 5 === 0) console.log(`  +${(i+1)*2}s`, JSON.stringify(st));
  }
  if (!booted) {
    console.error("游戏没启动成功");
    await cdp.shot("nat_fail.png");
    chrome.kill();
    process.exit(1);
  }
  console.log("游戏已启动");
  await sleep(3000);
  await cdp.shot("nat_01_title.png");

  // 页面里点 START ADVENTURE → 走建号流程
  // 800x600 游戏坐标 → 页面坐标
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

  console.log("\n=== 走建号流程 ===");
  // 这个 mod 的标题页不是「START ADVENTURE」，是「CLICK TO START」木牌，
  // 在 800x600 里约 (400, 514)。我第一版点 (640, 95) 落在标题图上，
  // 点了没反应，白等一轮。
  let p = toPage(400, 514);
  console.log("① CLICK TO START");
  await cdp.click(p.x, p.y);
  await sleep(4000);
  await cdp.shot("nat_02_newuser.png");

  // 用软键盘通道输入用户名
  console.log("② 用软键盘输入用户名 'zfsn'");
  const typed = await cdp.eval(`(function(){
    var inp=document.getElementById("pvz-soft-keyboard");
    if(!inp) return {err:"没有软键盘 textarea"};
    inp.focus();
    inp.value="";
    inp.value="z";
    inp.dispatchEvent(new Event("input",{bubbles:true}));
    return {ok:true, value:inp.value};
  })()`);
  console.log("   ", JSON.stringify(typed));
  for (const ch of "zfsn".slice(1)) {
    await sleep(300);
    await cdp.eval(`(function(){
      var inp=document.getElementById("pvz-soft-keyboard");
      inp.value = inp.value + ${JSON.stringify(ch)};
      inp.dispatchEvent(new Event("input",{bubbles:true}));
    })()`);
  }
  await sleep(1500);
  await cdp.shot("nat_03_named.png");

  console.log("③ 回车确认");
  await cdp.eval(`(function(){
    var inp=document.getElementById("pvz-soft-keyboard");
    inp.value = inp.value + "\\n";
    inp.dispatchEvent(new Event("input",{bubbles:true}));
  })()`);
  await sleep(5000);
  await cdp.shot("nat_04_after_ok.png");

  // 进冒险模式，让游戏写一次存档
  console.log("④ 进冒险模式（触发存档写入）");
  p = toPage(640, 100);
  await cdp.click(p.x, p.y);
  await sleep(8000);
  await cdp.shot("nat_05_ingame.png");

  // 强制同步存档到 IDBFS
  console.log("⑤ syncfs 落盘");
  await cdp.eval(`(function(){
    try { Module.FS.syncfs(false, function(e){ console.log("[t] syncfs cb err=" + e); }); }
    catch(e){ console.log("[t] syncfs 抛错 " + e); }
    return true;
  })()`);
  await sleep(4000);

  const files = await cdp.eval(DUMP_SAVE_JS);
  // cache32/ 里是资源编译缓存，几百个文件会把真正的存档淹没。
  //
  // ⚠ 不要靠路径前缀判断哪些是"存档"：IDBFS 挂载后 /saves 下会看到
  // 整个根目录的内容，/main.pak 也列在里面（路径显示成
  // /saves/userdata/../../main.pak，看起来很像存档）。
  // 真正的判据只有一条：**文件名是 users.dat 或 userN.dat**。
  const isSave = (f) => /\/(users|user\d+)\.dat$/.test(f.path);
  const saves = (files || []).filter(isSave);
  const skipped = (files || []).filter((f) => !isSave(f));
  console.log(`\n=== 用户存档（${saves.length} 个；`
    + `另有 ${skipped.length} 个资源/缓存文件已略过）===`);
  if (!saves.length) {
    console.log("（没有 users.dat / userN.dat —— 游戏可能还没建号成功）");
  } else {
    for (const f of saves) {
      console.log(`\n${f.path}`);
      console.log(`  大小: ${f.size} 字节`);
      console.log(`  头 64 字节: ${hexPreview(f.head)}`);
      const printable = f.head.filter((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)).length;
      console.log(`  可打印比例: ${(printable / Math.max(1, f.head.length) * 100).toFixed(0)}%`);
    }
  }

  // 把文件 dump 到本地
  console.log("\n=== 导出存档文件 ===");
  const dumped = await cdp.eval(`(function(){
    /* 逐字节转成 hex 字符串返回，不走 base64。
       base64 要么用 String.fromCharCode.apply（有参数个数上限，大文件直接
       RangeError），要么逐字符拼接（46MB 要几十秒，eval 超时）。
       存档只有几百字节，用 hex 是最稳的。 */
    function collect(dir,out){
      var names; try{names=Module.FS.readdir(dir);}catch(e){return;}
      for(var i=0;i<names.length;i++){
        var p=dir+"/"+names[i]; var st;
        try{st=Module.FS.stat(p);}catch(e){continue;}
        if(Module.FS.isDir(st.mode)) collect(p,out);
        else if(/\\/(users|user\\d+)\\.dat$/.test(p)){
          try{
            var b=Module.FS.readFile(p), hex="";
            for(var k=0;k<b.length;k++) hex += (b[k]<16?"0":"") + b[k].toString(16);
            out.push({path:p, size:b.length, hex:hex});
          }catch(e){}
        }
      }
    }
    var out=[]; collect("/saves",out); return out;
  })()`);
  if (dumped && dumped.length) {
    const dir = path.join(OUTDIR, "pvz_native_saves");
    fs.mkdirSync(dir, { recursive: true });
    for (const f of dumped) {
      const name = f.path.replace(/[/\\]/g, "_").replace(/^_+/, "");
      const p = path.join(dir, name);
      const buf = Buffer.from(f.hex, "hex");
      fs.writeFileSync(p, buf);
      console.log("  已导出", p, buf.length, "字节");
    }
  }

  try { ws.close(); } catch (e) {}
  chrome.kill();
})();
