/**
 * 作品媒体功能自测（多图 / 视频 / 文件下载）—— 纯接口层，不开浏览器
 * 用法：node tools/dev/check_media_api.js [base]
 * 默认 base = http://127.0.0.1:3100
 *
 * 前置：先起后端（建议用测试端口，别动线上那个）
 *   cd D:\ZFSN-server && set PORT=3100 && set HTTPS=0 && node server.js
 *
 * 覆盖：
 *   1. 登录拿 token
 *   2. 多图上传（kind=image）
 *   3. 视频上传（kind=video）
 *   4. 文件上传（kind=file）
 *   5. 建作品（images/video/files）→ 读回校验
 *   6. 视频 Range 请求（206 + Content-Range + Accept-Ranges）
 *   7. 附件下载（200 + Content-Disposition 原始文件名）
 *   8. 反例：文本冒充图片 → 拒绝；不在白名单的扩展名 → 拒绝；无 token → 401
 *   9. 编辑作品（去掉视频）→ 校验
 *  10. 删除作品 → 校验媒体文件被清理
 */
"use strict";
const fs = require("fs");
const path = require("path");

const BASE = process.argv[2] || "http://127.0.0.1:3100";
const PASS = process.env.ADMIN_PASSWORD || "zfsn114514.";
/** 站点仓库根（本文件在 <站点>/tools/dev/ 下） */
const SITE_ROOT = path.resolve(__dirname, "..", "..");
/** 后端目录（与站点同级） */
const SERVER_ROOT = path.resolve(SITE_ROOT, "..", "ZFSN-server");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
}
function section(t) { console.log("\n── " + t + " ──"); }

/* ── 造几个假文件（够过魔数校验即可）── */
function fakePng() {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"),
    Buffer.alloc(64, 7)
  ]);
}
function fakeJpg() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(96, 3)]);
}
/** PNG 内容 + .jpg 文件名：用来验证「以真实文件头为准」 */
function pngWithJpgName() {
  return fakePng();
}
function fakeMp4(size) {
  const head = Buffer.alloc(64, 0);
  head.write("ftyp", 4, "ascii");
  head.write("isom", 8, "ascii");
  return Buffer.concat([head, Buffer.alloc((size || 4096) - 64, 0x41)]);
}
function fakeZip() {
  return Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(2048, 0x5a)]);
}

function fileOf(buf, name, type) {
  return new File([buf], name, { type });
}

async function j(url, opts) {
  const r = await fetch(url, opts);
  let d = null;
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d, r };
}

async function upload(token, kind, files) {
  const fd = new FormData();
  fd.append("kind", kind);
  for (const f of files) fd.append("file", f);
  const r = await fetch(BASE + "/api/upload?kind=" + kind, {
    method: "POST",
    headers: { "X-Admin-Token": token },
    body: fd
  });
  let d = null;
  try { d = await r.json(); } catch (_) {}
  return { status: r.status, d };
}

function diskOf(rel) {
  // "media/works/video/x.mp4" → <后端>/data/media/works/video/x.mp4
  if (rel.indexOf("media/works/") !== 0) return null;
  return path.join(SERVER_ROOT, "data", rel);
}

(async () => {
  console.log("测试目标：" + BASE);

  /* 1. 登录 */
  section("1. 登录");
  const lg = await j(BASE + "/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASS })
  });
  ok("登录成功", lg.status === 200 && lg.d && lg.d.ok, "HTTP " + lg.status);
  const token = lg.d && lg.d.token;
  if (!token) { console.log("\n无法登录，后续测试中止。"); process.exit(1); }

  /* 2. 多图上传 */
  section("2. 多图上传（kind=image）");
  const upImg = await upload(token, "image", [
    fileOf(fakePng(), "测试图一.png", "image/png"),
    fileOf(pngWithJpgName(), "伪装成jpg.png", "image/jpeg"),
    fileOf(fakePng(), "测试图三.png", "image/png")
  ]);
  ok("HTTP 200 且 ok=true", upImg.status === 200 && upImg.d && upImg.d.ok,
    JSON.stringify(upImg.d).slice(0, 200));
  ok("返回 3 个文件", upImg.d && upImg.d.files && upImg.d.files.length === 3,
    upImg.d && upImg.d.count);
  const imgPaths = (upImg.d && upImg.d.files || []).map((f) => f.path);
  ok("图片路径形如 assets/works/*", imgPaths.length === 3 &&
    imgPaths.every((p) => /^assets\/works\/w\d{8}-\d{6}-[0-9a-f]{8}\.(png|jpg)$/.test(p)),
    imgPaths.join(", "));
  ok("魔数优先：PNG 内容 + .jpg 文件名 → 仍存成 .png",
    (upImg.d && upImg.d.files || [])[1] &&
    /\.png$/.test(upImg.d.files[1].path), imgPaths[1]);
  ok("兼容旧字段 path", upImg.d && typeof upImg.d.path === "string" && upImg.d.path.length > 0);

  /* 3. 视频上传 */
  section("3. 视频上传（kind=video）");
  const upVid = await upload(token, "video", [fileOf(fakeMp4(8192), "演示视频.mp4", "video/mp4")]);
  ok("HTTP 200 且 ok=true", upVid.status === 200 && upVid.d && upVid.d.ok,
    JSON.stringify(upVid.d).slice(0, 200));
  const vidPath = upVid.d && upVid.d.files && upVid.d.files[0] && upVid.d.files[0].path;
  ok("路径形如 media/works/video/*.mp4",
    !!vidPath && /^media\/works\/video\/w\d{8}-\d{6}-[0-9a-f]{8}\.mp4$/.test(vidPath), vidPath);
  ok("文件确实落盘", !!vidPath && fs.existsSync(diskOf(vidPath)));

  /* 4. 文件上传 */
  section("4. 文件上传（kind=file）");
  const upFile = await upload(token, "file", [
    fileOf(fakeZip(), "素材包.zip", "application/zip"),
    fileOf(Buffer.from("%PDF-1.4\n" + "x".repeat(500)), "说明书.pdf", "application/pdf")
  ]);
  ok("HTTP 200 且 ok=true", upFile.status === 200 && upFile.d && upFile.d.ok,
    JSON.stringify(upFile.d).slice(0, 200));
  const fileList = (upFile.d && upFile.d.files) || [];
  ok("返回 2 个文件", fileList.length === 2, fileList.length);
  ok("路径形如 media/works/file/*",
    fileList.every((f) => /^media\/works\/file\/w\d{8}-\d{6}-[0-9a-f]{8}\.(zip|pdf)$/.test(f.path)),
    fileList.map((f) => f.path).join(", "));
  ok("保留原始文件名", fileList[0] && fileList[0].origin === "素材包.zip", fileList[0] && fileList[0].origin);

  /* 5. 建作品 */
  section("5. 建作品并读回");
  const body = {
    title: "自测作品 · 多图+视频+附件",
    desc: "自动化测试创建，稍后删除",
    tag: "TEST",
    images: imgPaths,
    cover: imgPaths[0],
    video: vidPath,
    files: fileList.map((f) => ({ name: f.origin, path: f.path, size: f.size })),
    order: 999
  };
  const created = await j(BASE + "/api/works", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Token": token },
    body: JSON.stringify(body)
  });
  ok("创建成功", created.status === 200 && created.d && created.d.ok,
    JSON.stringify(created.d).slice(0, 200));
  const workId = created.d && created.d.item && created.d.item.id;
  ok("返回作品 id", !!workId);

  const one = await j(BASE + "/api/works/" + workId);
  const w = one.d && one.d.item;
  ok("详情接口可读", one.status === 200 && !!w);
  ok("images 3 张", w && (w.images || []).length === 3, w && (w.images || []).length);
  ok("video 已保存", w && w.video === vidPath, w && w.video);
  ok("files 2 个", w && (w.files || []).length === 2, w && (w.files || []).length);
  ok("files 带 name/size", w && w.files[0] && w.files[0].name === "素材包.zip" && w.files[0].size > 0,
    w && JSON.stringify(w.files[0]));
  ok("cover 已回填", w && w.cover === imgPaths[0], w && w.cover);

  /* 6. 视频 Range */
  section("6. 视频 Range 请求");
  const r1 = await fetch(BASE + "/" + vidPath);
  ok("整文件 200", r1.status === 200, "HTTP " + r1.status);
  ok("Accept-Ranges: bytes", r1.headers.get("accept-ranges") === "bytes",
    r1.headers.get("accept-ranges"));
  ok("Content-Type 是 video/mp4", r1.headers.get("content-type") === "video/mp4",
    r1.headers.get("content-type"));

  const r2 = await fetch(BASE + "/" + vidPath, { headers: { Range: "bytes=0-99" } });
  ok("Range → 206", r2.status === 206, "HTTP " + r2.status);
  ok("Content-Range 正确", r2.headers.get("content-range") === "bytes 0-99/8192",
    r2.headers.get("content-range"));
  const chunk = Buffer.from(await r2.arrayBuffer());
  ok("返回 100 字节", chunk.length === 100, chunk.length);

  const r3 = await fetch(BASE + "/" + vidPath, { headers: { Range: "bytes=8180-" } });
  const tail = Buffer.from(await r3.arrayBuffer());
  ok("bytes=8180- → 尾部 12 字节", r3.status === 206 && tail.length === 12,
    r3.status + " / " + tail.length);

  const r4 = await fetch(BASE + "/" + vidPath, { headers: { Range: "bytes=999999-" } });
  ok("越界 → 416", r4.status === 416, "HTTP " + r4.status);

  /* 7. 下载 */
  section("7. 附件下载");
  const dl = await fetch(BASE + "/api/download/" + workId + "/0");
  ok("HTTP 200", dl.status === 200, "HTTP " + dl.status);
  const cd = dl.headers.get("content-disposition") || "";
  ok("Content-Disposition 带原始文件名（RFC5987）",
    cd.indexOf("attachment") === 0 && cd.indexOf("filename*=UTF-8''%E7%B4%A0%E6%9D%90%E5%8C%85.zip") > 0,
    cd);
  const dlBody = Buffer.from(await dl.arrayBuffer());
  ok("下载内容完整（2052 字节）", dlBody.length === 2052, dlBody.length);
  ok("下载内容是 zip 魔数", dlBody.slice(0, 4).toString("binary") === "PK\x03\x04",
    dlBody.slice(0, 4).toString("hex"));

  const dlBad = await fetch(BASE + "/api/download/" + workId + "/9");
  ok("越界附件索引 → 404", dlBad.status === 404, "HTTP " + dlBad.status);

  /* 8. 反例 */
  section("8. 反例（应当被拒绝）");
  const badImg = await upload(token, "image", [fileOf(Buffer.from("这不是图片"), "fake.png", "image/png")]);
  ok("文本冒充图片 → 400", badImg.status === 400, "HTTP " + badImg.status + " " +
    (badImg.d && badImg.d.error));

  const badFile = await upload(token, "file", [fileOf(Buffer.alloc(64, 1), "奇怪的东西.xyz", "application/octet-stream")]);
  ok(".xyz 不在下载白名单 → 400", badFile.status === 400, "HTTP " + badFile.status + " " +
    (badFile.d && badFile.d.error));

  const badKind = await upload(token, "video", [fileOf(Buffer.alloc(64, 1), "x.xyz", "application/octet-stream")]);
  ok("不支持的视频扩展名 → 400", badKind.status === 400, "HTTP " + badKind.status);

  // .exe / .apk / .msi 是刻意放行的（站主分发自己做的工具），这里明确固化该行为
  const exeUp = await upload(token, "file", [fileOf(Buffer.alloc(2048, 0x4d), "小工具.exe", "application/octet-stream")]);
  ok(".exe 在下载白名单内（刻意放行）", exeUp.status === 200 && exeUp.d && exeUp.d.ok,
    "HTTP " + exeUp.status + " " + JSON.stringify(exeUp.d).slice(0, 120));
  if (exeUp.d && exeUp.d.files && exeUp.d.files[0]) {
    const exeDisk = diskOf(exeUp.d.files[0].path);
    try { if (exeDisk && fs.existsSync(exeDisk)) fs.unlinkSync(exeDisk); } catch (_) {}
  }

  const noAuth = await upload("", "image", [fileOf(fakePng(), "a.png", "image/png")]);
  ok("无 token → 401", noAuth.status === 401, "HTTP " + noAuth.status);

  /* 9. 编辑作品：去掉视频、只留 1 张图 */
  section("9. 编辑作品");
  const upd = await j(BASE + "/api/works/" + workId, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Admin-Token": token },
    body: JSON.stringify({ images: [imgPaths[0]], video: "", files: [] })
  });
  ok("PUT 成功", upd.status === 200 && upd.d && upd.d.ok, JSON.stringify(upd.d).slice(0, 160));
  const one2 = await j(BASE + "/api/works/" + workId);
  const w2 = one2.d && one2.d.item;
  ok("images 变成 1 张", w2 && (w2.images || []).length === 1, w2 && (w2.images || []).length);
  ok("video 已清空", w2 && w2.video === "", JSON.stringify(w2 && w2.video));
  ok("files 已清空", w2 && (w2.files || []).length === 0);

  /* 10. 删除作品 → 媒体文件应被清理 */
  section("10. 删除作品与媒体清理");
  const beforeVid = fs.existsSync(diskOf(vidPath));
  const del = await j(BASE + "/api/works/" + workId, {
    method: "DELETE", headers: { "X-Admin-Token": token }
  });
  ok("DELETE 成功", del.status === 200 && del.d && del.d.ok, JSON.stringify(del.d));
  const gone = await j(BASE + "/api/works/" + workId);
  ok("作品已不存在", gone.status === 404, "HTTP " + gone.status);
  await new Promise((r) => setTimeout(r, 300));
  ok("视频文件已被清理", beforeVid && !fs.existsSync(diskOf(vidPath)), vidPath);
  ok("附件文件已被清理", fileList.every((f) => !fs.existsSync(diskOf(f.path))));

  /* 收尾：图片走 git，不自动删；但测试图不该留在站点里 */
  section("收尾");
  let cleaned = 0;
  imgPaths.forEach((p) => {
    const abs = path.join(SITE_ROOT, p);
    try { if (fs.existsSync(abs)) { fs.unlinkSync(abs); cleaned++; } } catch (_) {}
  });
  ok("测试图片已从站点移除", cleaned === imgPaths.length, cleaned + "/" + imgPaths.length);

  console.log("\n════════════════════════════════");
  console.log("  通过 " + pass + " 项，失败 " + fail + " 项");
  console.log("════════════════════════════════\n");
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n测试异常终止：", e);
  process.exit(1);
});
