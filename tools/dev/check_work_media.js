// 作品媒体功能冒烟测试（多图 / 视频 / 附件下载）
//
// 为什么需要它：
//   「发布作品」从"只能传一张图"扩到"多图 + 视频 + 下载文件"，
//   牵动了 后端上传/静态服务/作品字段 + 后台表单 + 前台详情页 三层。
//   光测接口不够 —— 必须确认浏览器里真的渲染出了相册缩略图、<video>
//   和下载列表，而且没有运行时报错。
//
// 前置：先起后端（建议用测试端口，别动线上那个）
//   cd D:\ZFSN-server && set PORT=3100 && set HTTPS=0 && node server.js
//
// 用法: node tools/dev/check_work_media.js [base]
// 默认 base = http://127.0.0.1:3100
// 退出码: 0 全部通过 / 1 有失败项
"use strict";
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");

const BASE = process.argv[2] || "http://127.0.0.1:3100";
const PASSWORD = process.env.ADMIN_PASSWORD || "zfsn114514.";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9341;
const ROOT = path.resolve(__dirname, "..", "..");
const PROFILE = path.join(ROOT, "tools", ".cache", "chrome-cdp-media");
const SHOTS = path.join(__dirname, "_shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ══════ 造一张真 PNG（浏览器能渲染，截图才好看） ══════ */
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_T[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
/** 生成 w×h 的斜向渐变 PNG（c1 → c2） */
function gradPng(w, h, c1, c2) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const off = y * (w * 3 + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const t = (x / (w - 1) + y / (h - 1)) / 2;
      raw[off + 1 + x * 3] = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      raw[off + 2 + x * 3] = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      raw[off + 3 + x * 3] = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
/** 假 mp4：只要 ftyp 头对，后端就收；浏览器元素照样建出来 */
function fakeMp4(size) {
  const head = Buffer.alloc(64, 0);
  head.write("ftyp", 4, "ascii");
  head.write("isom", 8, "ascii");
  return Buffer.concat([head, Buffer.alloc((size || 65536) - 64, 0x41)]);
}

/* ══════ HTTP 小工具 ══════ */
async function jget(url, headers) {
  const r = await fetch(url, { headers: headers || {} });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}
async function upload(token, kind, files) {
  const fd = new FormData();
  fd.append("kind", kind);
  for (const f of files) fd.append("file", f);
  const r = await fetch(BASE + "/api/upload?kind=" + kind, {
    method: "POST", headers: { "X-Admin-Token": token }, body: fd,
  });
  let d = null; try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

/* ══════ CDP ══════ */
function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " timeout")); } }, 40000);
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
  console.log("目标站点：" + BASE);

  /* ── 0. 准备数据 ── */
  const lg2 = await fetch(BASE + "/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  }).then((r) => r.json()).catch(() => null);
  const token = lg2 && lg2.token;
  if (!token) { console.log("登录失败，测试中止。"); process.exit(1); }

  const imgs = [
    new File([gradPng(480, 600, [255, 45, 74], [40, 0, 20])], "渐变一.png", { type: "image/png" }),
    new File([gradPng(480, 600, [60, 200, 255], [0, 20, 60])], "渐变二.png", { type: "image/png" }),
    new File([gradPng(480, 600, [255, 200, 60], [60, 30, 0])], "渐变三.png", { type: "image/png" }),
  ];
  const upI = await upload(token, "image", imgs);
  const upV = await upload(token, "video", [new File([fakeMp4(131072)], "演示视频.mp4", { type: "video/mp4" })]);
  const upF = await upload(token, "file", [
    new File([Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(30000, 0x5a)])], "素材包.zip", { type: "application/zip" }),
    new File([Buffer.from("%PDF-1.4\n" + "y".repeat(9000))], "说明书.pdf", { type: "application/pdf" }),
  ]);
  if (!upI.d || !upI.d.ok || !upV.d || !upV.d.ok || !upF.d || !upF.d.ok) {
    console.log("上传失败，测试中止。", JSON.stringify(upI.d), JSON.stringify(upV.d), JSON.stringify(upF.d));
    process.exit(1);
  }
  const imgPaths = upI.d.files.map((f) => f.path);
  const vidPath = upV.d.files[0].path;
  const fileList = upF.d.files.map((f) => ({ name: f.origin, path: f.path, size: f.size }));

  const created = await fetch(BASE + "/api/works", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": token },
    body: JSON.stringify({
      title: "冒烟测试 · 相册+视频+附件",
      desc: "自动化冒烟测试创建，测试结束会自动删除",
      tag: "TEST",
      images: imgPaths,
      cover: imgPaths[0],
      video: vidPath,
      files: fileList,
      order: 999,
    }),
  }).then((r) => r.json()).catch(() => null);
  const workId = created && created.item && created.item.id;
  if (!workId) { console.log("建作品失败，测试中止。", JSON.stringify(created)); process.exit(1); }
  console.log("  测试作品 id = " + workId);

  /* ── 1. 起 Chrome ── */
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

  /* ── 2. 前台详情页 ── */
  console.log("\n[前台 · 作品详情页]");
  await cdp.send("Page.navigate", { url: BASE + "/index.html#work/" + workId });
  await sleep(3500);
  // 等详情页渲染出来
  for (let i = 0; i < 20; i++) {
    const has = await cdp.eval(`!!document.getElementById('wd-video') || !!document.querySelector('.wd-dl')`);
    if (has) break;
    await sleep(500);
  }

  const vSrc = await cdp.eval(`(document.getElementById('wd-video')||{}).currentSrc || (document.querySelector('#wd-video source')||{}).src || ''`);
  check(/\/media\/works\/video\/.+\.mp4$/.test(vSrc), "视频元素存在且 src 指向后端隧道（" + vSrc + "）");

  const nThumb = await cdp.eval(`document.querySelectorAll('#wd-thumbs button').length`);
  check(nThumb === 3, "相册缩略图 3 张（实际 " + nThumb + "）");

  const nDl = await cdp.eval(`document.querySelectorAll('.wd-dl a').length`);
  check(nDl === 2, "下载列表 2 个附件（实际 " + nDl + "）");

  const dlHref = await cdp.eval(`(document.querySelector('.wd-dl a')||{}).getAttribute('href') || ''`);
  check(/\/api\/download\/[a-f0-9]+\/0$/.test(dlHref), "下载链接指向 /api/download（" + dlHref + "）");

  const dlName = await cdp.eval(`(document.querySelector('.wd-dl a .nm')||{}).textContent || ''`);
  check(dlName === "素材包.zip", "下载列表显示原始文件名（" + dlName + "）");

  const dlSize = await cdp.eval(`(document.querySelector('.wd-dl a .sz')||{}).textContent || ''`);
  check(/KB|MB|B/.test(dlSize), "下载列表显示体积（" + dlSize + "）");

  const stats = await cdp.eval(`[...document.querySelectorAll('.wd-stat .k')].map(e=>e.textContent)`);
  check(stats.indexOf("图片") >= 0 && stats.indexOf("附件") >= 0,
    "统计条含「图片」「附件」（" + stats.join("/") + "）");

  const poster0 = await cdp.eval(`(document.getElementById('wd-video')||{}).getAttribute ? document.getElementById('wd-video').getAttribute('poster') : ''`);
  check(!!poster0, "视频有封面（poster=" + String(poster0).slice(-24) + "）");

  // 点第 3 张缩略图 → 视频封面应切换
  await cdp.eval(`(() => { const b = document.querySelectorAll('#wd-thumbs button')[2]; if (b) b.click(); return !!b; })()`);
  await sleep(400);
  const poster1 = await cdp.eval(`document.getElementById('wd-video').getAttribute('poster')`);
  check(poster1 !== poster0 && /\.png$/.test(poster1 || ""), "点缩略图可切换视频封面");

  const onIdx = await cdp.eval(`[...document.querySelectorAll('#wd-thumbs button')].findIndex(b=>b.classList.contains('on'))`);
  check(onIdx === 2, "当前选中的缩略图高亮正确（index=" + onIdx + "）");

  await shot(path.join(SHOTS, "work_media_detail.png"));
  // 滚到附件下载区再截一张：确认下载列表真的渲染出来了
  await cdp.eval(`(() => { const e = document.querySelector('.wd-dl'); if (e) e.scrollIntoView({block:'center'}); return !!e; })()`);
  await sleep(600);
  await shot(path.join(SHOTS, "work_media_downloads.png"));

  /* ── 3. 前台作品墙角标 ── */
  console.log("\n[前台 · 作品墙角标]");
  await cdp.send("Page.navigate", { url: BASE + "/index.html" });
  await sleep(3500);
  await cdp.eval(`(() => { const s = document.querySelector('[data-go="works"]'); if (s) s.click(); return true; })()`);
  await sleep(1500);
  const badges = await cdp.eval(`(() => { const it = [...document.querySelectorAll('#gallery .gitem')].find(e => (e.textContent||'').indexOf('冒烟测试') >= 0);
    return it ? [...it.querySelectorAll('.gbadge span')].map(e=>e.textContent.trim()) : null; })()`);
  check(badges && badges.length === 3, "卡片角标 3 个（" + JSON.stringify(badges) + "）");
  check(badges && badges.some((b) => /3\s*张/.test(b)), "角标含「3 张」");
  check(badges && badges.some((b) => /视频/.test(b)), "角标含「视频」");
  check(badges && badges.some((b) => /2\s*个附件/.test(b)), "角标含「2 个附件」");

  /* ── 4. 后台表单回填 ──
     注意：admin 的脚本整体包在一个 IIFE 里，WORKS / openWorkForm 都不是全局，
     所以不能直接调用它们 —— 这里走真实用户路径：点「作品」标签 → 点这条作品的「编辑」。 */
  console.log("\n[后台 · 作品表单回填]");
  await cdp.send("Page.navigate", { url: BASE + "/admin" });
  await sleep(2000);
  await cdp.eval(`localStorage.setItem('zfsn_admin_token', ${JSON.stringify(token)}); true`);
  await cdp.send("Page.navigate", { url: BASE + "/admin" });
  await sleep(2500);

  // 等登录态确认（#app 拿到 on）
  let loggedIn = false;
  for (let i = 0; i < 20; i++) {
    loggedIn = await cdp.eval(`(() => { const a = document.getElementById('app'); return !!a && a.classList.contains('on'); })()`);
    if (loggedIn) break;
    await sleep(500);
  }
  check(loggedIn, "后台登录态生效");

  // 切到「作品」标签
  await cdp.eval(`(() => { const b = document.querySelector('.tabs button[data-tab="work"]'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);

  // 等作品列表渲染出这条作品的「编辑」按钮，然后点它
  let opened = false;
  for (let i = 0; i < 24; i++) {
    opened = await cdp.eval(`(() => {
      const b = document.querySelector('button[data-edit="${workId}"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (opened) break;
    await sleep(500);
  }
  check(opened, "后台作品列表里能找到该作品并点开编辑");
  await sleep(600);

  const aThumb = await cdp.eval(`document.querySelectorAll('#w-thumbs .thumb').length`);
  check(aThumb === 3, "后台回填 3 张图片缩略图（实际 " + aThumb + "）");

  const coverOn = await cdp.eval(`document.querySelectorAll('#w-thumbs .thumb.iscover').length`);
  check(coverOn === 1, "第 1 张被标为封面");

  const vShown = await cdp.eval(`!document.getElementById('v-drop-prev').classList.contains('hide')`);
  const vPath = await cdp.eval(`document.getElementById('v-prev-path').textContent`);
  check(vShown && /media\/works\/video\//.test(vPath), "后台回填视频（" + vPath + "）");

  const fItems = await cdp.eval(`document.querySelectorAll('#f-list .fitem').length`);
  const fNames = await cdp.eval(`[...document.querySelectorAll('#f-list .fitem .nm')].map(e=>e.textContent)`);
  check(fItems === 2, "后台回填 2 个附件（实际 " + fItems + "）");
  check(fNames.indexOf("素材包.zip") >= 0, "附件名保留原始文件名（" + JSON.stringify(fNames) + "）");

  const coverVal = await cdp.eval(`document.getElementById('w-cover').value`);
  check(coverVal === imgPaths[0], "隐藏 cover 字段已同步为第一张图");

  // 点「设为封面」→ 第 2 张应挪到最前
  await cdp.eval(`(() => { const b = document.querySelectorAll('#w-thumbs .thumb')[1].querySelector('button[data-cv]'); if (b) b.click(); return !!b; })()`);
  await sleep(300);
  const newCover = await cdp.eval(`document.getElementById('w-cover').value`);
  check(newCover === imgPaths[1], "「设为封面」把第 2 张挪到最前");

  await shot(path.join(SHOTS, "work_media_admin.png"), "#work-form");
  // 再截视频 / 附件两块
  await cdp.eval(`(() => { const e = document.getElementById('v-drop'); if (e) e.scrollIntoView({block:'center'}); return !!e; })()`);
  await sleep(500);
  await shot(path.join(SHOTS, "work_media_admin_av.png"));

  /* ── 5. 控制台错误 ── */
  console.log("\n[运行时报错]");
  const realErr = errors.filter((e) => e && e.indexOf("favicon") < 0 && e.indexOf("ERR_BLOCKED") < 0);
  check(realErr.length === 0, "无控制台错误" + (realErr.length ? "：" + realErr.slice(0, 3).join(" | ") : ""));

  /* ── 6. 收尾：删掉测试作品与上传的图片 ── */
  console.log("\n[收尾]");
  const del = await fetch(BASE + "/api/works/" + workId, {
    method: "DELETE", headers: { "X-Admin-Token": token },
  }).then((r) => r.json()).catch(() => null);
  check(del && del.ok, "测试作品已删除");
  let cleaned = 0;
  for (const p of imgPaths) {
    const abs = path.join(ROOT, p);
    try { if (fs.existsSync(abs)) { fs.unlinkSync(abs); cleaned++; } } catch (_) {}
  }
  check(cleaned === imgPaths.length, "测试图片已从站点移除（" + cleaned + "/" + imgPaths.length + "）");

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("失败: " + (e && e.stack || e)); process.exit(1); });
