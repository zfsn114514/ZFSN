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

// 「关于我」自我介绍：纯文本 + 换行。4000 字够写一大段了，
// 再长首页也放不下；上限同时也限制了 config 表那一行的大小。
const ABOUT_MAX = 4000;

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

/* 规范域名 —— 只保留 www 这一个入口。
   workers.dev 是 Cloudflare 自动分配的共享托管域名，搜索引擎也会抓它，
   结果同一份内容出现两个搜索结果、权重被分散
   （GSC 实测两个都已「已编入索引」）。
   全部 301 永久重定向到 www，权重集中、用户也只看到一个地址。

   ⚠ 必须是 301（永久）不是 302：302 是临时的，搜索引擎会继续把两个地址
      都当作有效入口，等于没做。
   ⚠ 改 hostname 时要保留 path 和 query，否则 /pvz/pvz-portable、
      /feed.xml 这类深层链接会全部 404。 */
const CANON_HOST = "www.zfsnnb.dpdns.org";
const WORKERS_HOST = "zfsn.zfsn114514.workers.dev";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;

    // 共享托管域名 → 规范域名，301。放在所有路由之前（连 /api/ 也一样）。
    if (url.hostname === WORKERS_HOST) {
      url.hostname = CANON_HOST;
      return Response.redirect(url.toString(), 301);
    }

    try {
      if (p.indexOf("/api/") === 0) {
        const res = await handleAPI(request, env, ctx, url);
        if (res) return res;
        return L.fail("接口不存在", 404);
      }
      if (p.indexOf("/media/") === 0) return await handleMedia(request, env, url);
      // RSS 订阅源。放在 Worker 而不是静态文件：
      // 作品是存在 D1 里、可以随时在后台增删的，静态 feed 一发布就过期了。
      // 由 Worker 每次现读 D1 生成，新作品立刻能被订阅者看到。
      if (p === "/feed.xml" || p === "/rss.xml") return await serveFeed(request, env, url);
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
 * 一件事：**缺失资源必须回 404，不能冒泡成 500。**
 *    ASSETS 绑定在找不到文件时会抛异常，旧代码在 catch 里又调了一次
 *    env.ASSETS.fetch(request) —— 第二次照样抛，于是异常逃出 fetch()，
 *    客户端收到 500。PageSpeed 抓 /llms.txt 报的就是这个（HTTP 500），
 *    「智能体浏览器」这项直接被判不合格。对搜索引擎来说 500 还会被
 *    当成站点有错误，比正常的 404 伤害大得多。
 *
 * 关于图片长缓存：那个**不在这里做**。Workers 静态资源层的请求
 * （命中已存在的文件时）根本进不到 Worker，所以在这里设 Cache-Control
 * 是无效的；真正的规则写在仓库根目录的 `_headers` 里。
 *
 * 关于图片格式协商：也**不在 Worker 做**。曾试过把 .jpg/.png 换成
 * 同名 .webp，但图片路径散落在 index.html、bili_videos.json、
 * xbox_games.json、steam_games.json 和 D1 的作品记录里（后台可编辑），
 * 换扩展名会让这些引用直接 404。现在改为离线「原地压缩、保留扩展名」。
 */
async function serveAsset(request, env, p) {
  let res;
  try {
    res = await env.ASSETS.fetch(request);
  } catch (e) {
    /* ★ 必须自己补全 index.html，否则首页会 404。
     *
     * CF 静态资源层的「自动补 index.html」是**在它自己处理请求时**做的。
     * 一旦某个路径被 wrangler.toml 的 `assets.run_worker_first` 命中，
     * 请求就会改走 Worker —— 此时 ASSETS.fetch() 拿到的是**原始路径**，
     * `/` 不会自动对应到 `index.html`、目录页同理，于是全部 404。
     *
     * 实测踩过：为了让 workers.dev 的 301 对首页生效而加了 run_worker_first，
     * 结果 `/` 和 `/pvz/pvz-portable` 双双 404，整站 HTML 挂掉。
     * 静态层不报错、不告警，只是静默返回 404。 */
    const alt = await assetWithIndexHtml(request, env, p);
    if (alt) return alt;
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

/**
 * ASSETS 未命中时，按 CF 的 `html_handling: auto-trailing-slash` 语义
 * 手动补全「无扩展名路径 → HTML」的两条映射。
 *
 * 为什么需要：CF 静态资源层的自动补全是**在它自己处理请求时**做的。
 * 一旦某路径被 wrangler.toml 的 `assets.run_worker_first` 命中，请求改走
 * Worker —— 此时 ASSETS.fetch() 拿到的是**原始路径**，补全不再发生。
 *
 * 实测踩过：为让 workers.dev 的 301 对首页生效而加了 run_worker_first，
 * 结果 `/` 和 `/pvz/pvz-portable` 双双 404，整站 HTML 挂掉，
 * 静态层不报错、不告警，只是静默返回 404。
 *
 * ⚠ **两种映射都要试，且顺序不能反**（先试哪个以实测为准，别推理）：
 *    `/`                      → `/index.html`          （根目录）
 *    `/a/b`（无扩展名）        → `/a/b.html`            （本站 pvz 就是这种：
 *                                                        仓库里是
 *                                                        pvz/pvz-portable.html，
 *                                                        是**文件**不是目录）
 *                              → `/a/b/index.html`      （另一种常见结构）
 *    只试 index.html 会漏掉本站 pvz 页 —— 它的真实文件是 `x.html`。
 *
 * ⚠ 只在 200 时返回；非 200 一律 null，让上层走 notFound()。
 *    这里绝不能「兜底返回 200 空页」—— 那会把真 404 掩盖成假成功。
 */
async function assetWithIndexHtml(request, env, p) {
  // 只对无扩展名的路径重试。有扩展名（如 .css/.txt）没命中就是真 404。
  if (p !== "/" && /\.[a-z0-9]+$/i.test(p)) return null;

  const candidates = p === "/"
    ? ["/index.html"]
    : [p + ".html", p + "/index.html"];

  for (const target of candidates) {
    try {
      const r2 = await env.ASSETS.fetch(new Request("https://placeholder.local" + target, {
        method: "GET",
        headers: request.headers,
      }));
      if (r2 && r2.status === 200) return r2;
    } catch (e) {
      /* 试下一个候选；都不中就是真的没有，交给上层 404 */
    }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════
   /feed.xml —— RSS 2.0 订阅源
   ══════════════════════════════════════════════════════════════ */

/** RSS 里所有文本都要转义（含引号，属性里要用） */
function xmlEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 生成作品 RSS。
 *
 * 为什么值得做：站点是单页应用（hash 路由 `#work/<id>`），
 * 搜索引擎抓不到、也没有「新作品」的通知渠道。
 * RSS 给订阅者（人 + 部分聚合器）一个「有新作品了」的推送口。
 *
 * ⚠ 关于 hash 路由的取舍：
 *   RSS 的 <link> 必须是可被聚合器打开的完整 URL。这里给的是
 *   `https://<host>/#work/<id>` —— 浏览器打开能正确落到详情页。
 *   严格说 hash 后面的部分不会发给服务器，但对「人点开看」这个唯一用途
 *   来说没问题；真要 SEO 友好得改成 history 路由 + Worker 重写，
 *   那是更大的改动，不在本次范围。
 *
 * ⚠ <pubDate> 必须是 **RFC 822** 格式（`Wed, 02 Oct 2026 03:33:00 GMT`），
 *   不是 ISO 8601。用 toUTCString() 得到的就是 RFC 1123/822 兼容格式，
 *   别自己拼日期字符串。
 */
async function serveFeed(request, env, url) {
  const host = url.host;
  const origin = url.protocol + "//" + host;

  let items = [];
  try {
    const rs = await env.DB.prepare(
      "SELECT id, title, descr, cover, tag, ts, time FROM works " +
      "ORDER BY ts DESC LIMIT 40"
    ).all();
    items = rs.results || [];
  } catch (e) {
    // D1 挂了也让 feed 可用（返回空列表），不要给订阅器一个 5xx
    console.error("[feed] 读库失败: %s", (e && e.message) || e);
  }

  const selfLink = origin + "/feed.xml";
  const now = new Date();

  // 频道级 pubDate 取最新一条作品的时间，没有就用当前时间
  const newest = items.length && Number(items[0].ts)
    ? new Date(Number(items[0].ts))
    : now;

  const lastBuild = (d) => {
    const t = Number(d.ts);
    if (t) return new Date(t).toUTCString();
    // ts 缺失时退回解析 time 字符串（"2026-10-02 03:33"）
    if (d.time) {
      const p = new Date(String(d.time).replace(" ", "T"));
      if (!isNaN(p.getTime())) return p.toUTCString();
    }
    return now.toUTCString();
  };

  const body = items.map(function (w) {
    const link = origin + "/#work/" + w.id;
    // 描述里带上封面图，聚合器（如 Feedly）能直接显示缩略图。
    // 宽度用 CSS 限制在 480，避免撑破阅读器版面。
    const descParts = [];
    if (w.cover) {
      descParts.push(
        '<p><img src="' + xmlEsc(origin + "/" + String(w.cover).replace(/^\/+/, "")) +
        '" alt="' + xmlEsc(w.title) + '" style="max-width:480px;height:auto"></p>'
      );
    }
    if (w.descr) descParts.push("<p>" + xmlEsc(w.descr) + "</p>");
    if (w.tag) descParts.push("<p>标签：" + xmlEsc(w.tag) + "</p>");
    descParts.push('<p><a href="' + xmlEsc(link) + '">查看作品详情 →</a></p>');

    return "    <item>\n" +
      "      <title>" + xmlEsc(w.title) + "</title>\n" +
      "      <link>" + xmlEsc(link) + "</link>\n" +
      // guid 用链接并标 isPermaLink=false：hash 路由下它不是"永久链接"的
      // 严格意义，但作为唯一标识是稳定的
      '      <guid isPermaLink="false">zfsn-work-' + xmlEsc(w.id) + "</guid>\n" +
      "      <pubDate>" + lastBuild(w) + "</pubDate>\n" +
      "      <description>" + xmlEsc(descParts.join("")) + "</description>\n" +
      "    </item>";
  }).join("\n");

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    "  <channel>\n" +
    "    <title>ZFSN 的作品</title>\n" +
    "    <link>" + xmlEsc(origin + "/") + "</link>\n" +
    "    <description>ZFSN 的作品更新 — 二次元插画 / 视觉创作</description>\n" +
    "    <language>zh-cn</language>\n" +
    "    <pubDate>" + newest.toUTCString() + "</pubDate>\n" +
    "    <lastBuildDate>" + now.toUTCString() + "</lastBuildDate>\n" +
    // atom:self 让聚合器知道 feed 的规范地址（很重要：站点有 www 和裸域两个入口）
    '    <atom:link href="' + xmlEsc(selfLink) + '" rel="self" type="application/rss+xml"/>\n' +
    "    <ttl>60</ttl>\n" +
    body + "\n" +
    "  </channel>\n" +
    "</rss>\n";

  return new Response(xml, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      // 缓存 10 分钟：够新，又不会每次请求都打 D1。
      // 再加上 stale-while-revalidate，聚合器高频轮询时几乎零延迟。
      "cache-control": "public, max-age=600, stale-while-revalidate=1800",
      "x-content-type-options": "nosniff",
    },
  });
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

  /* ══ 访问统计（第一方，无 cookie、无第三方脚本）═══════════════
   *
   * 隐私取舍（写清楚，免得以后自己都怀疑）：
   *   · 不存原始 IP。存的是 SHA-256(ip + ua + 日期 + salt) 的前 32 位。
   *     它当天内能用来去重（算 UV），跨天无法把两条记录关联到同一个人，
   *     也无法逆推出原始 IP。
   *   · 不存 cookie、不存完整 UA。
   *   · 因此不需要 cookie 同意弹窗。
   *
   * path 由前端上报，但**必须白名单校验** —— 否则任何人可以往库里
   * 塞任意字符串，表会被撑爆，统计也会被污染。
   */
  if (p === "/api/pv" && method === "POST") {
    // 上报频率限制放很宽：正常用户一次会话只报几次，
    // 但被脚本刷时这层能挡住绝大多数无脑循环。
    if (!(await L.rateAllow(env, "pv:" + ip, 60, 60 * 1000))) {
      return L.ok({ counted: false });   // 静默丢弃，不报错打扰用户
    }

    let body;
    try { body = await L.readJSON(request); } catch (_) { return L.ok({ counted: false }); }

    const ALLOWED = ["home", "works", "work", "bili", "steam", "guest"];
    const view = ALLOWED.indexOf(String(body.view || "")) >= 0 ? String(body.view) : "home";

    // 作品页额外记 work_id（只接受合法 ID 格式，防止注入奇怪字符串）
    let workId = "";
    if (view === "work") {
      const wid = String(body.workId || "");
      if (/^[a-f0-9]{8,32}$/i.test(wid)) workId = wid;
    }

    const ts = L.now();
    const d = new Date(ts + (Number(tz) || 0) * 3600 * 1000);
    const day = d.toISOString().slice(0, 10);   // 按站点时区的 'YYYY-MM-DD'

    // 访客指纹。salt 复用 PBKDF2 的配置值没意义（那是密码用的），
    // 这里用固定串 + 站点标识即可 —— 目的只是"当天去重"，不是安全用途。
    const raw = ip + "|" + ua + "|" + day + "|zfsn-pv-v1";
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    const vhash = L.bytesToHex(new Uint8Array(buf)).slice(0, 32);

    // 注意：这几步放在 waitUntil 里，让上报请求尽快返回，
    // 不占用用户可感知的等待时间。统计迟到几百毫秒完全无所谓。
    const work = (async () => {
      try {
        // PV：upsert 递增
        await env.DB.prepare(
          "INSERT INTO pageviews (day, path, views, visitors) VALUES (?, ?, 1, 0) " +
          "ON CONFLICT(day, path) DO UPDATE SET views = views + 1"
        ).bind(day, view).run();

        // UV：当天该指纹第一次出现才 +1。
        // INSERT OR IGNORE 的 changes 为 0 就说明已存在 → 不是新访客。
        const ins = await env.DB.prepare(
          "INSERT OR IGNORE INTO pv_visitors (day, hash) VALUES (?, ?)"
        ).bind(day, vhash).run();
        const isNew = ins.meta && ins.meta.changes > 0;
        if (isNew) {
          await env.DB.prepare(
            "UPDATE pageviews SET visitors = visitors + 1 WHERE day = ? AND path = ?"
          ).bind(day, view).run();
        }

        // 作品累计浏览
        if (workId) {
          await env.DB.prepare(
            "INSERT INTO work_views (work_id, views) VALUES (?, 1) " +
            "ON CONFLICT(work_id) DO UPDATE SET views = views + 1"
          ).bind(workId).run();
        }
      } catch (e) {
        console.error("[pv] 写入失败: %s", (e && e.message) || e);
      }
    })();

    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    return L.ok({ counted: true });
  }

  /* 统计概览（仅管理员可见）—— 后台「访问统计」标签页用 */
  if (p === "/api/stats" && method === "GET") {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }

    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 365);

    const total = await env.DB.prepare(
      "SELECT COALESCE(SUM(views),0) AS views, COALESCE(SUM(visitors),0) AS visitors FROM pageviews"
    ).first();

    const daily = await env.DB.prepare(
      "SELECT day, SUM(views) AS views, SUM(visitors) AS visitors " +
      "FROM pageviews GROUP BY day ORDER BY day DESC LIMIT ?"
    ).bind(days).all();

    const byPath = await env.DB.prepare(
      "SELECT path, SUM(views) AS views FROM pageviews GROUP BY path ORDER BY views DESC"
    ).all();

    // 作品排行：联表取标题，没有浏览记录的也要显示（LEFT JOIN，views 为 0）
    const topWorks = await env.DB.prepare(
      "SELECT w.id, w.title, COALESCE(v.views,0) AS views " +
      "FROM works w LEFT JOIN work_views v ON v.work_id = w.id " +
      "ORDER BY views DESC, w.ts DESC LIMIT 20"
    ).all();

    return L.ok({
      total: { views: Number(total && total.views) || 0, visitors: Number(total && total.visitors) || 0 },
      daily: (daily.results || []).reverse(),   // 按时间正序给前端画图
      byPath: byPath.results || [],
      topWorks: topWorks.results || [],
    });
  }

  /* ══ 「关于我」══
   *
   * 存在 D1 的 config 表里（k='about'），跟密码记录同一张表 ——
   * 只有一条记录、没有查询需求，为它单开一张表不值得。
   *
   * 为什么不像留言那样存 IP/UA：这是一段由站长自己维护的静态文案，
   * 不是用户产出内容，没有溯源需求。
   *
   * 公开读不鉴权：它本来就要显示在首页给所有人看。
   */
  if (p === "/api/about" && method === "GET") {
    const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'about'").first();
    let data = { text: "", updated: "" };
    if (row) {
      try { data = Object.assign(data, JSON.parse(row.v)); } catch (_) { /* 脏数据当空处理 */ }
    }
    return L.ok({
      text: String(data.text || ""),
      // 展示用：没填过就是空串，前端据此决定要不要显示这一块
      has_content: !!(data.text && String(data.text).trim()),
      updated: String(data.updated || "")
    });
  }

  if (p === "/api/admin/about" && method === "POST") {
    if (!(await L.checkToken(env, L.adminTokenOf(request)))) {
      return L.fail("未登录或会话已过期", 401);
    }
    let body;
    try { body = await L.readJSON(request, 64 * 1024); } catch (_) { return L.fail("请求体格式错误"); }

    // 保留换行（前端用 white-space:pre-wrap 渲染），所以不能走 L.clean ——
    // 它会把 \n \r 一起当控制字符清掉。这里只挡其它控制字符。
    const raw = String(body.text == null ? "" : body.text);
    const text = raw
      .replace(/\r\n?/g, "\n")                  // 统一换行符
      .replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F]/g, "")  // 除 \n 外的控制字符
      .slice(0, ABOUT_MAX);

    const updated = L.stamp(L.now(), tz);
    await env.DB.prepare(
      "INSERT INTO config (k, v) VALUES ('about', ?) " +
      "ON CONFLICT(k) DO UPDATE SET v = excluded.v"
    ).bind(JSON.stringify({ text, updated })).run();

    return L.ok({ text, has_content: !!text.trim(), updated });
  }

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
