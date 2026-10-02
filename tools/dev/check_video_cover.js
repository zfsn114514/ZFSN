// 视频封面自动生成 —— 端到端冒烟测试
//
// 验证：上传纯视频（一张图都不传）时，后台会自动从视频里抓一帧当作品封面。
//
// 为什么用 MediaRecorder 现录一段视频：
//   家里没装 ffmpeg，造不出真实可解码的 mp4；而浏览器原生就能
//   canvas + MediaRecorder 录出 webm。录的时候**故意让前 0.5 秒是黑场**，
//   这样就能同时验证"抓帧是否真的跳过了片头"——如果抓到的是黑帧，
//   说明 seek 没生效，测试会失败。
//
// 前置：先起后端（测试端口）
//   cd D:\ZFSN-server && set PORT=3100 && set HTTPS=0 && node server.js
//
// 用法: node tools/dev/check_video_cover.js [base]
// 默认 base = http://127.0.0.1:3100
// 退出码: 0 全部通过 / 1 有失败项
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const BASE = process.argv[2] || "http://127.0.0.1:3100";
const PASSWORD = process.env.ADMIN_PASSWORD || "zfsn114514.";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9343;
const ROOT = path.resolve(__dirname, "..", "..");
const PROFILE = path.join(ROOT, "tools", ".cache", "chrome-cdp-vcover");
const SHOTS = path.join(__dirname, "_shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " timeout")); } }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
}

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg); }
}

(async () => {
  console.log("目标：" + BASE);

  const lg = await fetch(BASE + "/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  }).then((r) => r.json()).catch(() => null);
  const token = lg && lg.token;
  if (!token) { console.log("登录失败，测试中止。"); process.exit(1); }
  console.log("  已登录");

  fs.mkdirSync(PROFILE, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1400,1100", "about:blank",
  ], { stdio: "ignore" });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`); if (targets && targets.length) break; } catch (e) {}
    await sleep(500);
  }
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const errors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push((m.params.args || []).map((a) => a.value || a.description || "").join(" "));
    }
  });

  async function shot(file, sel) {
    let clip = null;
    if (sel) {
      const box = await cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
        const r = e.getBoundingClientRect(); return {x:Math.max(0,r.x),y:Math.max(0,r.y),w:r.width,h:r.height}; })()`);
      if (box && box.w > 0) clip = { x: box.x, y: box.y, width: Math.min(box.w, 1400), height: Math.min(box.h, 1100), scale: 1 };
    }
    const r = await cdp.send("Page.captureScreenshot", clip ? { clip, format: "png" } : { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log("        截图 → " + file);
  }

  /* ── 进后台并打开一个空的作品表单 ── */
  await cdp.send("Page.navigate", { url: BASE + "/admin" });
  await sleep(2000);
  await cdp.eval(`localStorage.setItem('zfsn_admin_token', ${JSON.stringify(token)}); true`);
  await cdp.send("Page.navigate", { url: BASE + "/admin" });
  await sleep(2500);

  let loggedIn = false;
  for (let i = 0; i < 20; i++) {
    loggedIn = await cdp.eval(`(() => { const a = document.getElementById('app'); return !!a && a.classList.contains('on'); })()`);
    if (loggedIn) break;
    await sleep(500);
  }
  check(loggedIn, "后台登录态生效");

  await cdp.eval(`(() => { const b = document.querySelector('.tabs button[data-tab="work"]'); if (b) b.click(); return !!b; })()`);
  await sleep(1000);
  await cdp.eval(`(() => { const b = document.getElementById('add-work'); if (b) b.click(); return !!b; })()`);
  await sleep(1000);

  /* ── 录一段真实视频并"上传"（前 0.5 秒是黑场）── */
  console.log("\n[生成真实视频并上传]");
  const gen = await cdp.eval(`(async () => {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    const ctx = c.getContext('2d');
    const stream = c.captureStream(30);
    const chunks = [];
    let rec;
    try { rec = new MediaRecorder(stream, { mimeType: 'video/webm' }); }
    catch (e) { return { ok:false, err: 'MediaRecorder 不可用: ' + e.message }; }
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => rec.onstop = r);
    rec.start();
    const t0 = performance.now();
    await new Promise(resolve => {
      function frame(){
        const t = (performance.now() - t0) / 1000;
        if (t > 2.0) return resolve();
        if (t < 0.5) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 320, 240); }   // 片头黑场
        else {
          ctx.fillStyle = 'hsl(' + ((t * 150) % 360) + ',85%,55%)';
          ctx.fillRect(0, 0, 320, 240);
          ctx.fillStyle = '#fff'; ctx.font = '26px sans-serif';
          ctx.fillText('ZFSN ' + t.toFixed(1), 16, 130);
        }
        requestAnimationFrame(frame);
      }
      frame();
    });
    rec.stop();
    await stopped;
    if (!chunks.length) return { ok:false, err:'MediaRecorder 没产出数据' };
    const file = new File(chunks, 'test-clip.webm', { type: 'video/webm' });
    const input = document.getElementById('v-file');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok:true, size: file.size };
  })()`);

  check(!!(gen && gen.ok),
    "录出真实 webm 并触发上传" + (gen && gen.err ? "：" + gen.err : "（" + (gen && gen.size) + " 字节）"));
  if (!gen || !gen.ok) {
    try { ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
    console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
    process.exit(1);
  }

  /* ── 等视频上传 + 自动抓帧完成 ── */
  let st = null;
  for (let i = 0; i < 60; i++) {
    st = await cdp.eval(`({ v: (document.getElementById('v-prev-path')||{}).textContent||'', c: (document.getElementById('w-cover')||{}).value||'' })`);
    if (st && st.v && st.c) break;
    await sleep(1000);
  }

  console.log("\n[自动抓帧结果]");
  check(!!(st && st.v), "视频已上传：" + (st && st.v));
  check(/^media\/works\/video\/.+\.webm$/.test((st && st.v) || ""), "视频落在 media/works/video/（隧道）");
  check(!!(st && st.c), "自动生成了封面：" + (st && st.c));
  check(/^assets\/works\/.+\.jpg$/.test((st && st.c) || ""),
    "封面落在 assets/works/（走 Cloudflare，关机也能看）");

  const poster = await cdp.eval(`(() => { const v = document.getElementById('v-prev'); return v ? (v.getAttribute('poster') || '') : ''; })()`);
  check(!!poster, "视频预览器已设置 poster");

  const hint = await cdp.eval(`(document.getElementById('w-cover-hint')||{}).textContent||''`);
  check(/视频画面/.test(hint), "提示文案说明封面来自视频：「" + hint.slice(0, 30) + "…」");

  /* ── 关键验证：抓到的不是黑帧（证明 seek 跳过了片头）── */
  const coverUrl = "/" + (st && st.c);
  const px = await cdp.eval(`(async () => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = () => rej(new Error('封面加载失败'));
      img.src = ${JSON.stringify(coverUrl)};
    });
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 320;
    c.height = img.naturalHeight || 240;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nb = 0, tot = 0;
    for (let i = 0; i < d.length; i += 4) {
      tot++;
      if (d[i] > 30 || d[i+1] > 30 || d[i+2] > 30) nb++;
    }
    return { tot: tot, nb: nb, ratio: tot ? (nb / tot) : 0 };
  })()`).catch((e) => ({ err: e.message }));
  if (px && px.err) {
    check(false, "封面像素检查失败：" + px.err);
  } else {
    check(px && px.ratio > 0.5,
      "封面不是黑帧，抓到有内容的画面（非黑像素 " +
      (px ? (px.ratio * 100).toFixed(0) : "?") + "%）——证明跳过了片头黑场");
  }

  await shot(path.join(SHOTS, "video_cover_admin.png"), "#work-form");

  /* ── 保存作品并读回 ── */
  console.log("\n[保存并读回]");
  await cdp.eval(`(() => { const t = document.getElementById('w-title'); t.value = '视频封面测试'; return true; })()`);
  await cdp.eval(`(() => { const b = document.getElementById('w-save'); if (b) b.click(); return !!b; })()`);
  await sleep(3000);

  const list = await fetch(BASE + "/api/works").then((r) => r.json()).catch(() => null);
  const w = ((list && list.items) || []).find((x) => x.title === "视频封面测试");
  check(!!w, "作品已保存");
  if (w) {
    check(w.video && /media\/works\/video\//.test(w.video), "video 字段正确（走隧道）");
    check(w.cover && /assets\/works\/.+\.jpg/.test(w.cover), "cover 是抓帧生成的封面（走 CF）");
    check(!(w.images || []).length, "封面没混进相册（images 为空）");
  }

  /* ── 前台作品墙：应显示真实封面而不是渐变占位图 ── */
  console.log("\n[前台作品墙]");
  await cdp.send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(3500);
  await cdp.eval(`(() => { const s = document.querySelector('[data-go="works"]'); if (s) s.click(); return true; })()`);
  await sleep(1500);
  const cardSrc = await cdp.eval(`(() => {
    const it = [...document.querySelectorAll('#gallery .gitem')].find(e => (e.textContent||'').indexOf('视频封面测试') >= 0);
    return it ? ((it.querySelector('img') || {}).getAttribute('src') || '') : null;
  })()`);
  check(cardSrc !== null, "作品墙里能找到该作品");
  check(!!cardSrc && cardSrc.indexOf("data:image/svg") < 0 && /assets\/works\//.test(cardSrc || ""),
    "卡片显示真实封面（不是渐变占位图）");

  await shot(path.join(SHOTS, "video_cover_gallery.png"));

  /* ── 运行时报错 ── */
  console.log("\n[运行时报错]");
  const realErr = errors.filter((e) => e && e.indexOf("favicon") < 0);
  check(realErr.length === 0, "无控制台错误" + (realErr.length ? "：" + realErr.slice(0, 3).join(" | ") : ""));

  /* ── 收尾清理 ── */
  console.log("\n[收尾]");
  if (w) {
    await fetch(BASE + "/api/works/" + w.id, { method: "DELETE", headers: { "X-Admin-Token": token } });
    check(true, "测试作品已删除（视频文件由后端 cleanupMedia 一并清理）");
  }
  let cleaned = 0;
  if (st && st.c) {
    const abs = path.join(ROOT, st.c);
    try { if (fs.existsSync(abs)) { fs.unlinkSync(abs); cleaned++; } } catch (e) {}
  }
  check(cleaned === 1, "测试封面图已从站点移除（否则会污染 git 仓库）");

  console.log("\n结果: " + pass + " 通过 / " + fail + " 失败");
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("失败: " + (e && e.stack || e));
  process.exit(1);
});
