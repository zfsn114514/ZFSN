/* ══════════════════════════════════════════════════════════════
   ZFSN 站点 —— Cloudflare Worker 入口
   ───────────────────────────────────────────────────────────────
   请求先到这里：
     /api/*    动态接口（留言 / 作品 / 点赞评论 / 上传 / 管理员）
     /media/*  KV 里的媒体（视频、下载文件、新上传的图片）
     其他      回落到静态资源 assets（Cloudflare Workers Assets）
   ══════════════════════════════════════════════════════════════ */

import * as L from "./lib.js";
import * as M from "./media.js";

/* ── 常量（与旧后端保持一致，避免前端行为突变）───────────────── */
const MAX_NAME = 24;
const MAX_TEXT = 800;
const MSG_MAX_IMAGES = 4;
const MSG_MAX_VOICES = 1;
const MSG_IMG_LIMIT = 5 * 1024 * 1024;
const MSG_VOICE_LIMIT = 4 * 1024 * 1024;
const MSG_BODY_LIMIT = 22 * 1024 * 1024;
const MESSAGE_KEEP = 5000;

const ID_RE = "[a-f0-9]{8,32}";

/* ── 小工具 ──────────────────────────────────────────────────── */

function parseJSON(s, fallback) {
  if (!s) return fallback;
  try {
    const v = JSON.parse(s);
    return v === null || v === undefined ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function msgKey(id, file) {
  return "msg/" + id + "/" + file;
}

/** URL 路径 → KV key。同时挡住目录穿越。 */
function safeKey(p) {
  const s = String(p || "").replace(/^\/+/, "");
  if (!s || s.indexOf("..") >= 0 || s.indexOf("\\") >= 0) return null;
  return s;
}

/** 归一化媒体路径：只接受 media/works/... 与 assets/works/... 两类 */
function normalizeMediaPath(p) {
  const s = String(p || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!s || s.indexOf("..") >= 0) return "";
  if (/^https?:/i.test(s)) return "";
  return s;
}

function normPaths(arr, max) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    const p = normalizeMediaPath(typeof it === "string" ? it : (it && it.path));
    if (!p) continue;
    if (out.indexOf(p) >= 0) continue;
    out.push(p);
    if (out.length >= (max || 30)) break;
  }
  return out;
}

function normFileList(arr, max) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it) continue;
    const p = normalizeMediaPath(typeof it === "string" ? it : it.path);
    if (!p) continue;
    if (out.some((x) => x.path === p)) continue;
    const size = Number(typeof it === "object" ? it.size : 0) || 0;
    const name = L.clean(typeof it === "object" ? it.name : "", 120) || p.split("/").pop();
    out.push({ name, path: p, size, sizeText: size ? L.humanSize(size) : "" });
    if (out.length >= (max || 10)) break;
  }
  return out;
}

/* ── 行 → 前端期望的对象 ─────────────────────────────────────── */

function rowToMessage(r) {
  return {
    id: r.id,
    name: r.name,
    text: r.text,
    ts: Number(r.ts),
    time: r.time,
    ip: r.ip || "",
    geo: parseJSON(r.geo, {}),
    ua: r.ua || "",
    images: parseJSON(r.images, []),
    voices: parseJSON(r.voices, []),
    deleted: !!r.deleted
  };
}

function rowToWork(r) {
  return {
    id: r.id,
    title: r.title,
    desc: r.descr || "",
    link: r.link || "",
    cover: r.cover || "",
    tag: r.tag || "",
    images: parseJSON(r.images, []),
    video: r.video || "",
    files: parseJSON(r.files, []),
    order: Number(r.ord) || 0,
    ts: Number(r.ts),
    time: r.time || "",
    updatedAt: r.updated_at || "",
    likes: Number(r.like_count) || 0,
    comments: Number(r.comment_count) || 0
  };
}

/* ══════════════════════════════════════════════════════════════
   入口
   ══════════════════════════════════════════════════════════════ */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p.indexOf("/api/") === 0) {
        const res = await handleAPI(request, env, ctx, url);
        if (res) return res;
        return L.fail("接口不存在", 404);
      }
      if (p.indexOf("/media/") === 0) return await handleMedia(request, env, url);
      return await serveAsset(request, env, p);
    } catch (e) {
      // 兜底：接口崩了也别把整站拖成 500，静态资源照常返回
      console.error("[worker] %s %s -> %s", request.method, p, e && e.stack ? e.stack : e);
      if (p.indexOf("/api/") === 0 || p.indexOf("/media/") === 0) {
        return L.fail("服务异常：" + ((e && e.message) || "unknown"), 500);
      }
      return notFound();
    }
  }
};

/* ══════════════════════════════════════════════════════════════
   静态资源
   ══════════════════════════════════════════════════════════════ */

/** 图片类资源（后缀判断，够用且不用解析路径） */
const IMG_EXT = /\.(jpg|jpeg|png|webp|avif|gif|svg|ico)$/i;

function notFound() {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/**
 * 发静态资源。
 *
 * 两件事：
 * 1) **缺失资源必须回 404，不能冒泡成 500。**
 *    ASSETS 绑定在找不到文件时会抛异常，旧代码在 catch 里又调了一次
 *    env.ASSETS.fetch(request) —— 第二次照样抛，于是异常逃出 fetch()，
 *    客户端收到 500。PageSpeed 抓 /llms.txt 报的就是这个（HTTP 500），
 *    「智能体浏览器」这项直接被判不合格。对搜索引擎来说 500 还会被
 *    当成站点有错误，比正常的 404 伤害大得多。
 * 2) **图片给长缓存。** Workers 静态资源默认 Cache-Control 是
 *    public, max-age=0, must-revalidate，每次访问都要回源验证一次，
 *    PageSpeed「使用高效的缓存生命周期」说的就是它。作品图文件名带
 *    时间戳、平台封面基本不会更名，缓存 30 天是安全的；
 *    HTML / JS / CSS 不加长缓存 —— 改完得立刻生效。
 */
async function serveAsset(request, env, p) {
  let res;
  try {
    res = await env.ASSETS.fetch(request);
  } catch (e) {
    console.warn("[assets] 未命中，按 404 处理: %s", p);
    return notFound();
  }
  if (res && res.status === 200 && IMG_EXT.test(p)) {
    const h = new Headers(res.headers);
    h.set("Cache-Control", "public, max-age=2592000");
    return new Response(res.body, { status: 200, headers: h });
  }
  return res;
}

/* ══════════════════════════════════════════════════════════════
   /media/* —— KV 媒体
   ══════════════════════════════════════════════════════════════ */

async function handleMedia(request, env, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return L.fail("不支持的方法", 405);
  }
  const key = safeKey(url.pathname);
  if (!key) return L.fail("非法路径", 400);
  const res = await M.serveObject(request, env, key);
  if (!res) return new Response("Not Found", { status: 404 });
  return res;
}

/* ══════════════════════════════════════════════════════════════
   /api/* —— 全部接口
   ══════════════════════════════════════════════════════════════ */

async function handleAPI(request, env, ctx, url) {
  const p = url.pathname;
  const method = request.method.toUpperCase();
  const ip = L.clientIP(request);
  const ua = request.headers.get("user-agent") || "";
  const tz = env.TZ_OFFSET;
  // 只在记录里没存轮数时才用得上（老的 config.json 平移记录）。
  // ⚠ 别往上调：Workers 硬上限 100000，超了 PBKDF2 直接抛错。
  // 这里**故意不 clamp** —— 静默夹到上限只会让校验失败，
  // 用户看到"密码错误"却不知道是轮数问题。宁可让 L.verifyPassword
  // 抛出明确的错误信息，由登录接口转达。
  const ITER = Number(env.PBKDF2_ITERATIONS) || L.PBKDF2_DEFAULT_ITERATIONS;

  /* ── 健康检查（前端靠它探测后端在不在）───────────────────── */
  if (p === "/api/health" && method === "GET") {
    return L.ok({
      service: "ZFSN site backend",
      runtime: "cloudflare-workers",
      time: L.stamp(L.now(), tz),
      uptime: "0s",
      node: "workers",
      colo: (request.cf && request.cf.colo) || ""
    });
  }

  /* ── 部署自检：给管理页「部署自检」标签页用 ──────────────────
     迁到 Workers 之后已经没有"本机端口/端口映射"这回事了，
     所以这里如实报告：一切由 Cloudflare 边缘提供。 */
  if (p === "/api/netcheck" && method === "GET") {
    return L.ok({
      your_ip: ip,
      is_local_request: L.isPrivateIP(ip),
      trust_proxy: true,
      peer_ip: ip,
      via_proxy: false,
      listen: { host: "cloudflare-edge", port: url.port || "443" },
      https: { enabled: true, port: 443, cert: "cloudflare-managed", self_signed: false },
      local_ips: [],
      site_root: "cloudflare-workers",
      node: "workers",
      uptime: "0s",
      time: L.stamp(L.now(), tz),
      colo: (request.cf && request.cf.colo) || "",
      country: (request.cf && request.cf.country) || ""
    });
  }

  /* ── 归属地 ──────────────────────────────────────────────── */
  if (p === "/api/geo" && method === "GET") {
    return L.json(await L.lookupGeo(request, env));
  }

  /* ══ 留言 ══ */

  if (p === "/api/messages" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
    const rs = await env.DB.prepare(
      "SELECT * FROM messages WHERE deleted = 0 ORDER BY ts DESC LIMIT ?"
    ).bind(limit).all();
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE deleted = 0"
    ).first();
    return L.ok({
      count: cnt ? cnt.c : 0,
      items: (rs.results || []).map(rowToMessage)
    });
  }

  if (p === "/api/messages" && method === "POST") {
    let body;
    try {
      body = await L.readJSON(request, MSG_BODY_LIMIT);
    } catch (e) {
      return L.fail(
        e.tooBig
          ? "留言+附件总大小超过上限（" + L.humanSize(MSG_BODY_LIMIT) + "），请压缩或减少图片"
          : "请求体格式错误",
        e.tooBig ? 413 : 400
      );
    }

    const name = L.clean(body.name, MAX_NAME);
    const text = L.clean(body.text, MAX_TEXT);
    if (!name) return L.fail("请填写名字");
    if (!text) return L.fail("请填写留言内容");

    // 每个 IP 每分钟最多 3 条
    if (!(await L.rateAllow(env, "msg:" + ip, 3, 60 * 1000))) {
      return L.fail("发言太快了，请稍等一分钟", 429);
    }

    const geo = await L.lookupGeo(request, env);
    const id = L.randomHex(8);
    const ts = L.now();

    const images = [];
    const voices = [];
    const inImg = Array.isArray(body.images) ? body.images : [];
    const inVoi = Array.isArray(body.voices) ? body.voices : [];

    for (let i = 0; i < Math.min(inImg.length, MSG_MAX_IMAGES); i++) {
      const dec = M.decodeDataUrl(inImg[i]);
      if (!dec || !dec.buf || dec.buf.length > MSG_IMG_LIMIT) continue;
      const ext = M.sniffImage(dec.buf);
      if (!ext) continue;
      const fname = String(i) + ext;
      try {
        await M.putObject(env, msgKey(id, fname), dec.buf, M.mimeOf(fname));
        images.push("/api/media/messages/" + id + "/" + fname);
      } catch (_) { /* 单张失败不影响其它 */ }
    }

    for (let i = 0; i < Math.min(inVoi.length, MSG_MAX_VOICES); i++) {
      const v = inVoi[i];
      // 兼容两种形态：字符串 dataURL，或 { dataUrl | data, duration }。
      // （前端以前发的是 dataUrl 字段，这里只读 data 会整条丢掉录音。）
      const raw = typeof v === "string"
        ? v
        : ((v && (v.dataUrl || v.data || v.src)) || "");
      const dec = M.decodeDataUrl(raw);
      if (!dec || !dec.buf || !dec.buf.length || dec.buf.length > MSG_VOICE_LIMIT) continue;
      const sniffed = M.sniffAudio(dec.buf);
      // 认不出容器时兜底：只有客户端自己声明的就是 audio/* 才放行。
      // 图片那边是认不出直接拒；录音这里留一点余地 —— 各家浏览器的
      // MediaRecorder 容器不同（Chrome/Firefox=webm|ogg，Safari=mp4），
      // 但都不能让任意字节冒充"录音"存进 KV。
      if (!sniffed && !/^audio\//i.test(dec.type || "")) continue;
      const ext = sniffed || ".webm";
      const fname = "v" + i + ext;
      const duration = (v && typeof v === "object" && Number(v.duration)) || 0;
      try {
        // 录音一律按音频 MIME 存（.webm 要 audio/webm 而不是 video/webm）
        await M.putObject(env, msgKey(id, fname), dec.buf, M.audioMimeOf(ext));
        voices.push({ url: "/api/media/messages/" + id + "/" + fname, duration });
      } catch (_) { /* 单条失败不影响其它 */ }
    }

    await env.DB.prepare(
      "INSERT INTO messages (id, name, text, ts, time, ip, geo, ua, images, voices, deleted) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
    ).bind(
      id, name, text, ts, L.stamp(ts, tz), ip,
      JSON.stringify(L.geoFields(geo)), L.clean(ua, 160),
      JSON.stringify(images), JSON.stringify(voices)
    ).run();

    // 安全上限：最多保留 5000 条
    await env.DB.prepare(
      "DELETE FROM messages WHERE id IN (" +
      "  SELECT id FROM messages ORDER BY ts DESC LIMIT -1 OFFSET ?" +
      ")"
    ).bind(MESSAGE_KEEP).run();

    if (ctx && ctx.waitUntil) ctx.waitUntil(L.rateClean(env));

    const item = {
      id, name, text, ts, time: L.stamp(ts, tz), ip,
      geo: L.geoFields(geo), ua: L.clean(ua, 160),
      images, voices, deleted: false
    };
    return L.ok({ item });
  }

  // 删除留言（管理员）
  let m = new RegExp("^/api/messages/(" + ID_RE + ")$").exec(p);
  if (m && (method === "DELETE" || method === "POST")) {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }
    const id = m[1];
    const row = await env.DB.prepare("SELECT id FROM messages WHERE id = ?").bind(id).first();
    if (!row) return L.fail("留言不存在", 404);
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
    // 附件一并清掉，避免 KV 里留孤儿键。
    // 分片键 <key>!N 与清单键 <key> 同前缀，一次 list 就能全捞出来。
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(M.listMedia(env, "msg/" + id + "/").then((keys) => M.deleteMedia(env, keys)));
    }
    return L.ok({ id });
  }

  // 留言附件
  m = new RegExp("^/api/media/messages/(" + ID_RE + ")/([\\w.\\-]+)$").exec(p);
  if (m && (method === "GET" || method === "HEAD")) {
    const res = await M.serveObject(request, env, msgKey(m[1], m[2]));
    if (!res) return new Response("Not Found", { status: 404 });
    return res;
  }

  /* ══ 作品 ══ */

  if (p === "/api/works" && method === "GET") {
    const rs = await env.DB.prepare(
      "SELECT w.*, " +
      "  (SELECT COUNT(*) FROM likes l WHERE l.work_id = w.id) AS like_count, " +
      "  (SELECT COUNT(*) FROM comments c WHERE c.work_id = w.id) AS comment_count " +
      "FROM works w ORDER BY w.ord ASC, w.ts DESC"
    ).all();
    const items = (rs.results || []).map(rowToWork);
    return L.ok({ count: items.length, items });
  }

  if (p === "/api/works" && method === "POST") {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }
    let body;
    try { body = await L.readJSON(request); } catch (_) { return L.fail("请求体格式错误"); }

    const title = L.clean(body.title, 60);
    if (!title) return L.fail("请填写作品标题");
    const images = normPaths(body.images, 30);
    const video = normPaths([body.video], 1)[0] || "";
    const files = normFileList(body.files, 10);
    let cover = L.clean(body.cover, 800);
    if (!cover && images.length) cover = images[0];
    if (!cover && video) cover = "";

    const id = L.randomHex(8);
    const ts = L.now();
    await env.DB.prepare(
      "INSERT INTO works (id, title, descr, link, cover, tag, images, video, files, ord, ts, time) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      id, title, L.clean(body.desc, 300), L.clean(body.link, 500), cover,
      L.clean(body.tag, 24), JSON.stringify(images), video, JSON.stringify(files),
      Number(body.order) || 0, ts, L.stamp(ts, tz)
    ).run();

    return L.ok({ item: rowToWork({
      id, title, descr: L.clean(body.desc, 300), link: L.clean(body.link, 500),
      cover, tag: L.clean(body.tag, 24), images: JSON.stringify(images), video,
      files: JSON.stringify(files), ord: Number(body.order) || 0, ts,
      time: L.stamp(ts, tz), like_count: 0, comment_count: 0
    }) });
  }

  // 作品互动：点赞 / 评论 / 明细
  m = new RegExp("^/api/works/(" + ID_RE + ")/interactions$").exec(p);
  if (m && method === "GET") {
    const workId = m[1];
    const lk = await env.DB.prepare(
      "SELECT ip, geo, ua, ts, time FROM likes WHERE work_id = ? ORDER BY ts DESC"
    ).bind(workId).all();
    const cm = await env.DB.prepare(
      "SELECT id, name, text, ip, geo, ts, time FROM comments WHERE work_id = ? ORDER BY ts ASC"
    ).bind(workId).all();
    return L.ok({
      likes: (lk.results || []).map((r) => ({
        ip: r.ip, geo: parseJSON(r.geo, {}), ts: Number(r.ts), time: r.time
      })),
      comments: (cm.results || []).map((r) => ({
        id: r.id, name: r.name, text: r.text, ip: r.ip,
        geo: parseJSON(r.geo, {}), ts: Number(r.ts), time: r.time
      }))
    });
  }

  m = new RegExp("^/api/works/(" + ID_RE + ")/like$").exec(p);
  if (m && method === "POST") {
    const workId = m[1];
    const work = await env.DB.prepare("SELECT id, title FROM works WHERE id = ?").bind(workId).first();
    if (!work) return L.fail("作品不存在", 404);

    if (!(await L.rateAllow(env, "like:" + ip, 20, 60 * 1000))) {
      return L.fail("操作太快了，请稍后再试", 429);
    }

    const exist = await env.DB.prepare(
      "SELECT ip FROM likes WHERE work_id = ? AND ip = ?"
    ).bind(workId, ip).first();

    let liked;
    if (exist) {
      await env.DB.prepare("DELETE FROM likes WHERE work_id = ? AND ip = ?").bind(workId, ip).run();
      liked = false;
    } else {
      const geo = await L.lookupGeo(request, env);
      await env.DB.prepare(
        "INSERT INTO likes (work_id, ip, geo, ua, ts, time) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(workId, ip, JSON.stringify(L.geoFields(geo)), L.clean(ua, 160), L.now(), L.stamp(L.now(), tz)).run();
      liked = true;
    }
    const cnt = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM likes WHERE work_id = ?"
    ).bind(workId).first();
    if (ctx && ctx.waitUntil) ctx.waitUntil(L.rateClean(env));
    return L.ok({ liked, likes: cnt ? cnt.c : 0 });
  }

  m = new RegExp("^/api/works/(" + ID_RE + ")/comments$").exec(p);
  if (m && method === "POST") {
    const workId = m[1];
    const work = await env.DB.prepare("SELECT id FROM works WHERE id = ?").bind(workId).first();
    if (!work) return L.fail("作品不存在", 404);

    let body;
    try { body = await L.readJSON(request); } catch (_) { return L.fail("请求体格式错误"); }
    const name = L.clean(body.name, MAX_NAME);
    const text = L.clean(body.text, 300);
    if (!name) return L.fail("请填写名字");
    if (!text) return L.fail("请填写评论内容");

    if (!(await L.rateAllow(env, "cmt:" + ip, 10, 60 * 1000))) {
      return L.fail("评论太快了，请稍后再试", 429);
    }

    const geo = await L.lookupGeo(request, env);
    const id = L.randomHex(8);
    const ts = L.now();
    await env.DB.prepare(
      "INSERT INTO comments (id, work_id, name, text, ip, geo, ua, ts, time) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, workId, name, text, ip, JSON.stringify(L.geoFields(geo)),
      L.clean(ua, 160), ts, L.stamp(ts, tz)).run();

    if (ctx && ctx.waitUntil) ctx.waitUntil(L.rateClean(env));
    return L.ok({
      item: {
        id, workId, name, text, ip, geo: L.geoFields(geo),
        ts, time: L.stamp(ts, tz)
      }
    });
  }

  m = new RegExp("^/api/works/(" + ID_RE + ")/comments/(" + ID_RE + ")$").exec(p);
  if (m && (method === "DELETE" || method === "POST")) {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }
    const r = await env.DB.prepare("SELECT id FROM comments WHERE id = ? AND work_id = ?")
      .bind(m[2], m[1]).first();
    if (!r) return L.fail("评论不存在", 404);
    await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(m[2]).run();
    return L.ok({ id: m[2] });
  }

  // 下载作品附件：保留上传时的原始文件名
  m = new RegExp("^/api/download/(" + ID_RE + ")/(\\d+)$").exec(p);
  if (m && (method === "GET" || method === "HEAD")) {
    const row = await env.DB.prepare("SELECT files FROM works WHERE id = ?").bind(m[1]).first();
    if (!row) return L.fail("作品不存在", 404);
    const files = parseJSON(row.files, []);
    const f = files[Number(m[2])];
    if (!f || !f.path) return L.fail("文件不存在", 404);
    const key = safeKey(f.path);
    if (!key) return L.fail("非法路径", 400);
    const res = await M.serveObject(request, env, key, { downloadName: f.name });
    if (!res) return new Response("Not Found", { status: 404 });
    return res;
  }

  // 单件作品详情（作品详情页用）。
  // 一次请求把详情页要的东西全给到：作品本身 + 点赞/评论明细 + 相邻作品，
  // 免得前端"先拉列表再 find"——列表接口不返回完整明细。
  // ⚠ 这个 GET 分支曾经漏掉，结果详情页一律报"接口不存在"，别删。
  m = new RegExp("^/api/works/(" + ID_RE + ")$").exec(p);
  if (m && method === "GET") {
    const workId = m[1];
    const row = await env.DB.prepare(
      "SELECT w.*, " +
      "  (SELECT COUNT(*) FROM likes l WHERE l.work_id = w.id) AS like_count, " +
      "  (SELECT COUNT(*) FROM comments c WHERE c.work_id = w.id) AS comment_count " +
      "FROM works w WHERE w.id = ?"
    ).bind(workId).first();
    if (!row) return L.fail("作品不存在", 404);

    const lk = await env.DB.prepare(
      "SELECT ip FROM likes WHERE work_id = ?"
    ).bind(workId).all();
    const cm = await env.DB.prepare(
      "SELECT id, name, text, geo, ts, time FROM comments WHERE work_id = ? ORDER BY ts DESC"
    ).bind(workId).all();

    // 相邻作品：排序口径必须和 GET /api/works 完全一致
    // （ord 升序，同 ord 新的在前），否则详情页翻页顺序会跟列表对不上
    const all = await env.DB.prepare(
      "SELECT id, title, cover FROM works ORDER BY ord ASC, ts DESC"
    ).all();
    const rows = all.results || [];
    const i = rows.findIndex((r) => r.id === workId);
    const nb = (j) => (i < 0 || j < 0 || j >= rows.length ? null : {
      id: rows[j].id, title: rows[j].title, cover: rows[j].cover || ""
    });

    return L.ok({
      item: rowToWork(row),
      liked: (lk.results || []).some((r) => r.ip === ip),
      commentList: (cm.results || []).map((r) => ({
        id: r.id, name: r.name, text: r.text,
        ts: Number(r.ts), time: r.time,
        geo: parseJSON(r.geo, { region: "", country: "", province: "", city: "", isp: "" })
      })),
      prev: nb(i - 1),
      next: nb(i + 1)
    });
  }

  // 修改 / 删除作品
  m = new RegExp("^/api/works/(" + ID_RE + ")$").exec(p);
  if (m && (method === "DELETE" || method === "PUT" || method === "POST")) {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }
    const id = m[1];
    const row = await env.DB.prepare("SELECT * FROM works WHERE id = ?").bind(id).first();
    if (!row) return L.fail("作品不存在", 404);

    if (method === "DELETE") {
      await env.DB.prepare("DELETE FROM works WHERE id = ?").bind(id).run();
      // 连带清掉点赞评论，不留孤儿数据
      await env.DB.prepare("DELETE FROM likes WHERE work_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM comments WHERE work_id = ?").bind(id).run();
      return L.ok({ id });
    }

    let body;
    try { body = await L.readJSON(request); } catch (_) { return L.fail("请求体格式错误"); }

    const title = body.title !== undefined ? L.clean(body.title, 60) : row.title;
    const descr = body.desc !== undefined ? L.clean(body.desc, 300) : row.descr;
    const link = body.link !== undefined ? L.clean(body.link, 500) : row.link;
    const tag = body.tag !== undefined ? L.clean(body.tag, 24) : row.tag;
    const ord = body.order !== undefined ? (Number(body.order) || 0) : Number(row.ord) || 0;
    const images = body.images !== undefined ? normPaths(body.images, 30) : parseJSON(row.images, []);
    const video = body.video !== undefined ? (normPaths([body.video], 1)[0] || "") : (row.video || "");
    const files = body.files !== undefined ? normFileList(body.files, 10) : parseJSON(row.files, []);
    let cover = body.cover !== undefined ? L.clean(body.cover, 800) : (row.cover || "");
    if (!cover && images.length) cover = images[0];

    const updatedAt = L.stamp(L.now(), tz);
    await env.DB.prepare(
      "UPDATE works SET title=?, descr=?, link=?, cover=?, tag=?, images=?, video=?, files=?, ord=?, updated_at=? " +
      "WHERE id=?"
    ).bind(title, descr, link, cover, tag, JSON.stringify(images), video,
      JSON.stringify(files), ord, updatedAt, id).run();

    return L.ok({ item: rowToWork({
      id, title, descr, link, cover, tag,
      images: JSON.stringify(images), video, files: JSON.stringify(files),
      ord, ts: row.ts, time: row.time, updated_at: updatedAt,
      like_count: 0, comment_count: 0
    }) });
  }

  /* ══ 上传（管理员）══ */

  if (p === "/api/upload" && method === "POST") {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }

    const kindOf = (k) => {
      const v = String(k || "").toLowerCase();
      return v === "video" || v === "file" ? v : "image";
    };
    const kind = kindOf(url.searchParams.get("kind"));
    const limit = M.UPLOAD_LIMITS[kind];

    let form;
    try {
      form = await request.formData();
    } catch (e) {
      return L.fail("上传数据格式错误：" + ((e && e.message) || ""), 400);
    }
    if (form.get("kind")) {
      // 表单里带了就以表单为准
      const k2 = kindOf(form.get("kind"));
      if (k2 !== kind) {
        return await doUpload(request, env, k2, form, tz);
      }
    }

    return await doUpload(request, env, kind, form, tz);
  }

  /* ══ 管理员 ══ */

  if (p === "/api/admin/login" && method === "POST") {
    let body;
    try { body = await L.readJSON(request); } catch (_) { return L.fail("请求体格式错误"); }

    // 防暴力破解：同 IP 5 分钟内失败 5 次就锁住
    if (!(await L.rateAllow(env, "login:" + ip, 5, 5 * 60 * 1000))) {
      return L.fail("尝试次数过多，请稍后再试", 429);
    }

    let rec = await L.getPasswordRecord(env);
    if (!rec) {
      // 库里还没有密码记录（比如还没灌种子数据）——用默认值初始化一次
      rec = await L.hashPassword(env.DEFAULT_ADMIN_PASSWORD || "zfsn114514.", null, ITER);
      await L.setPasswordRecord(env, rec);
    }

    let pwdOK = false;
    try {
      pwdOK = await L.verifyPassword(String(body.password || ""), rec, ITER);
    } catch (e) {
      // 轮数超上限之类的配置问题不是"密码错"，得给出能照着做的提示
      return L.fail("密码校验配置异常：" + ((e && e.message) || e), 500);
    }
    if (!pwdOK) return L.fail("密码错误", 401);

    // 登录成功：把这几次失败计数清掉，免得正常登录后立刻被锁
    await env.DB.prepare("DELETE FROM rate WHERE k = ?").bind("login:" + ip).run();
    const t = await L.issueToken(env, ip, ua, tz);
    return L.ok({ token: t.token, expiresIn: t.expiresIn });
  }

  if (p === "/api/admin/check" && method === "GET") {
    const valid = await L.checkToken(env, L.adminTokenOf(request));
    return L.ok({ valid });
  }

  if (p === "/api/admin/logout" && method === "POST") {
    await L.revokeToken(env, L.adminTokenOf(request));
    return L.ok();
  }

  if (p === "/api/admin/password" && method === "POST") {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }
    let body;
    try { body = await L.readJSON(request); } catch (_) { return L.fail("请求体格式错误"); }
    const oldPwd = String(body.old || "");
    const newPwd = String(body.new || "");
    if (newPwd.length < 6) return L.fail("新密码至少 6 位");
    if (newPwd.length > 128) return L.fail("新密码过长");

    const rec = await L.getPasswordRecord(env);
    try {
      if (!(await L.verifyPassword(oldPwd, rec, ITER))) return L.fail("原密码错误");
    } catch (e) {
      return L.fail("密码校验配置异常：" + ((e && e.message) || e), 500);
    }

    const next = await L.hashPassword(newPwd, null, ITER);
    await L.setPasswordRecord(env, next);
    // 改密后强制所有设备重新登录
    await L.revokeAllTokens(env);
    return L.ok({ message: "密码已修改，请重新登录" });
  }

  if (p === "/api/admin/stats" && method === "GET") {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }
    const mc = await env.DB.prepare("SELECT COUNT(*) AS c FROM messages WHERE deleted = 0").first();
    const wc = await env.DB.prepare("SELECT COUNT(*) AS c FROM works").first();
    const sc = await env.DB.prepare("SELECT COUNT(*) AS c FROM sessions WHERE exp > ?").bind(L.now()).first();
    const rows = await env.DB.prepare("SELECT geo FROM messages WHERE deleted = 0").all();

    const dist = {};
    for (const r of rows.results || []) {
      const g = parseJSON(r.geo, {});
      const key = g.region || "未知";
      dist[key] = (dist[key] || 0) + 1;
    }
    const regions = Object.keys(dist)
      .map((k) => [k, dist[k]])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);

    return L.ok({
      messages: mc ? mc.c : 0,
      works: wc ? wc.c : 0,
      updated: L.stamp(L.now(), tz),
      sessions: sc ? sc.c : 0,
      regions
    });
  }

  if (p === "/api/admin/work-interactions" && method === "GET") {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }
    const ws = await env.DB.prepare("SELECT id, title FROM works ORDER BY ord ASC, ts DESC").all();
    const items = [];
    for (const w of ws.results || []) {
      const lk = await env.DB.prepare(
        "SELECT ip, geo, ua, ts, time FROM likes WHERE work_id = ? ORDER BY ts DESC"
      ).bind(w.id).all();
      const cm = await env.DB.prepare(
        "SELECT id, name, text, ip, geo, ts, time FROM comments WHERE work_id = ? ORDER BY ts DESC"
      ).bind(w.id).all();
      items.push({
        id: w.id,
        title: w.title,
        likes: (lk.results || []).length,
        comments: (cm.results || []).length,
        likeList: (lk.results || []).map((r) => ({
          ip: r.ip, geo: parseJSON(r.geo, {}), ua: r.ua, ts: Number(r.ts), time: r.time
        })),
        commentList: (cm.results || []).map((r) => ({
          id: r.id, name: r.name, text: r.text, ip: r.ip,
          geo: parseJSON(r.geo, {}), ts: Number(r.ts), time: r.time
        }))
      });
    }
    return L.ok({ items, updated: L.stamp(L.now(), tz) });
  }

  return null;
}

/* ══════════════════════════════════════════════════════════════
   上传落库
   ══════════════════════════════════════════════════════════════ */

async function doUpload(request, env, kind, form, tz) {
  const limit = M.UPLOAD_LIMITS[kind] || M.UPLOAD_LIMITS.image;
  const maxFiles = M.MAX_FILES[kind] || 1;

  // 收集表单里的文件（不关心字段名，跟旧后端一致）
  const files = [];
  for (const pair of form.entries()) {
    const v = pair[1];
    if (v && typeof v === "object" && typeof v.arrayBuffer === "function") {
      files.push({ field: pair[0], file: v });
    }
  }
  if (!files.length) return L.fail("没有收到文件");
  if (files.length > maxFiles) {
    return L.fail(
      kind === "video" ? "一次只能上传 1 个视频，请逐个上传"
        : "一次最多上传 " + maxFiles + (kind === "image" ? "张图片" : "个文件")
    );
  }

  const saved = [];
  const skipped = [];

  for (const { field, file } of files) {
    const label = file.name || "未命名";
    const buf = new Uint8Array(await file.arrayBuffer());

    if (buf.length > limit) {
      skipped.push(label + "（超过 " + L.humanSize(limit) + "）");
      continue;
    }

    let ext;
    if (kind === "image") {
      ext = M.sniffImage(buf);
      if (!ext) { skipped.push(label + "（不是有效图片）"); continue; }
    } else if (kind === "video") {
      const sn = M.sniffVideo(buf);
      const e = M.extForVideo(file.name);
      if (!e) { skipped.push(label + "（不支持的视频格式）"); continue; }
      ext = sn && sn !== "?" ? sn : e;
    } else {
      ext = M.extForFile(file.name);
      if (!ext) { skipped.push(label + "（不支持的文件类型）"); continue; }
    }

    const name = M.uploadName(ext, tz);
    // 图片也进 KV：不再依赖 git push 那一轮发布
    const rel = kind === "image"
      ? "media/works/image/" + name
      : "media/works/" + (kind === "video" ? "video" : "file") + "/" + name;

    await M.putObject(env, rel, buf, M.mimeOf(name));

    saved.push({
      field: field || "file",
      kind,
      path: rel,
      url: "/" + rel,
      size: buf.length,
      sizeText: L.humanSize(buf.length),
      name,
      origin: label,
      type: M.mimeOf(name)
    });
  }

  if (!saved.length) {
    return L.fail("全部文件都不符合要求" + (skipped.length ? "：" + skipped.join("；") : ""));
  }

  const first = saved[0];
  return L.ok({
    kind,
    count: saved.length,
    files: saved,
    skipped,
    path: first.path,
    url: first.url,
    size: first.size,
    name: first.name
  });
}
