/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 本地完整 Worker 运行时（开发 / 验收用，不随站点部署）
 *
 *  为什么需要它：
 *    wrangler.toml 的 assets.directory = "." 会让 wrangler dev 监视整个仓库，
 *    而 .wrangler/state 里的 SQLite 又被 Worker 自己持续写入，本机形成
 *    「写库 → 触发 reload → 再写库」的无限热重载循环，请求长时间无响应。
 *    这个脚本用 Node 直接加载同一个 src/index.js，配上 D1 / KV / ASSETS 的
 *    本地实现，等价于一个完整的 Worker 运行时，绕开了热重载，且能验证
 *    真实 SQL、真实 Cookie 和真实注册登录流程。
 *
 *  用法：
 *    node tools/dev/voice-dev-server.mjs            # 默认 8790
 *    PORT=8791 node tools/dev/voice-dev-server.mjs
 *    VOICE_DEV_ADMIN_PASSWORD=你的密码 node ...     # 固定密码；不设则随机生成
 *    VOICE_DEV_DB=/tmp/test.sqlite VOICE_DEV_MEDIA=/tmp/media VOICE_DEV_CRED=/tmp/cred
 *      # 端到端测试用独立库 / 独立头像目录 / 独立凭据文件，不污染日常开发库
 *
 *  ⚠ 仅本机 127.0.0.1 监听。所有密钥与账号都是本地生成，绝不进仓库、绝不部署
 *    （tools/ 已在 .assetsignore 中排除）。数据落在 tools/dev/.voice-dev.sqlite。
 * ══════════════════════════════════════════════════════════════ */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { WebSocketServer } from "ws";
import worker from "../../src/index.js";
import * as C from "../../src/voice-core.js";
import { VoiceRoomDO } from "../../src/voice-room.js";

/* ── Durable Object 本地实现 ───────────────────────────────────
 *  直接实例化线上同一个 VoiceRoomDO 类，只是把 Cloudflare 的
 *  WebSocket Hibernation API 用 ws 包做一层等价适配。
 *  这样本地与线上跑的是完全相同的房间逻辑（成员、信令、踢人、设置下发）。
 * ────────────────────────────────────────────────────────────── */
class DevWebSocket {
  constructor(ws) { this.ws = ws; this.attachment = null; }
  send(text) { if (this.ws.readyState === 1) this.ws.send(text); }
  close(code, reason) { try { this.ws.close(code, reason); } catch (_) {} }
  serializeAttachment(obj) { this.attachment = obj; }
  deserializeAttachment() { return this.attachment; }
}

class DevDOState {
  constructor() { this.list = []; }
  acceptWebSocket(ws) { if (this.list.indexOf(ws) < 0) this.list.push(ws); }
  getWebSockets() { return this.list.filter(function (w) { return w.ws.readyState <= 1; }); }
  remove(ws) { const i = this.list.indexOf(ws); if (i >= 0) this.list.splice(i, 1); }
}

const rooms = new Map();
function roomInstance(channelId) {
  if (!rooms.has(channelId)) rooms.set(channelId, new VoiceRoomDO(new DevDOState(), env));
  return rooms.get(channelId);
}

const wss = new WebSocketServer({ noServer: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const DB_FILE = path.resolve(process.env.VOICE_DEV_DB || path.join(HERE, ".voice-dev.sqlite"));
const MEDIA_DIR = path.resolve(process.env.VOICE_DEV_MEDIA || path.join(HERE, ".voice-media"));
const CRED_FILE = path.resolve(process.env.VOICE_DEV_CRED || path.join(HERE, ".voice-dev-credentials.txt"));
const PORT = Number(process.env.PORT || 8790);
// 隔离模式下库文件可能位于临时目录，先确保父目录存在
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }

/* ── D1 适配器：把 node:sqlite 包装成 Workers D1 的 API ─────── */
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL;");
// 端到端测试会从另一个进程打开同一个库预置验证码 / 用户，给一点锁等待余量
db.exec("PRAGMA busy_timeout = 5000;");

function toBind(v) {
  if (v === undefined) return null;
  if (v instanceof Uint8Array || ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  return String(v);
}

const DB = {
  prepare(sql) {
    const stmt = db.prepare(sql);
    // Cloudflare D1 允许 prepare(sql).all() 不带 bind，也允许 .bind(...).all()
    function withArgs(args) {
      const bound = args.map(toBind);
      return {
        async first() {
          const r = stmt.get(...bound);
          return r === undefined ? null : r;
        },
        async all() { return { results: stmt.all(...bound) }; },
        async run() {
          const r = stmt.run(...bound);
          return { success: true, meta: { changes: Number(r.changes) || 0 } };
        }
      };
    }
    return Object.assign(withArgs([]), {
      bind(...args) { return withArgs(args); }
    });
  }
};

/* ── KV 适配器：头像等小文件落本地目录，重启不丢 ───────────── */
fs.mkdirSync(MEDIA_DIR, { recursive: true });
function mediaPath(key) {
  return path.join(MEDIA_DIR, encodeURIComponent(String(key)) + ".bin");
}
const MEDIA = {
  async put(key, value) {
    const buf = typeof value === "string" ? Buffer.from(value)
      : (value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value));
    fs.writeFileSync(mediaPath(key), buf);
  },
  async get(key, type) {
    const p = mediaPath(key);
    if (!fs.existsSync(p)) return null;
    const b = fs.readFileSync(p);
    if (type === "arrayBuffer") return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    if (type === "json") { try { return JSON.parse(b.toString("utf8")); } catch (_) { return null; } }
    return b.toString("utf8");
  },
  async delete(key) {
    try { fs.unlinkSync(mediaPath(key)); } catch (_) {}
  },
  async list() { return { keys: [], list_complete: true }; }
};

/* ── ASSETS 适配器：从仓库目录发静态文件 ────────────────────── */
const MIME = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".wav": "audio/wav", ".pdf": "application/pdf", ".wasm": "application/wasm",
  ".pak": "application/octet-stream", ".md": "text/markdown; charset=utf-8"
};

function resolveAsset(pathname) {
  let p;
  try { p = decodeURIComponent(pathname); } catch (_) { p = pathname; }
  if (p.endsWith("/")) return p + "index.html";
  if (!path.extname(p)) {
    if (fs.existsSync(path.join(ROOT, p, "index.html"))) return p + "/index.html";
    return p + ".html";
  }
  return p;
}

const ASSETS = {
  async fetch(request) {
    const rel = resolveAsset(new URL(request.url).pathname);
    const file = path.resolve(ROOT, "." + rel);
    if (!file.startsWith(ROOT)) return new Response("Forbidden", { status: 403 });
    let st;
    try { st = fs.statSync(file); } catch (_) { return new Response("Not Found", { status: 404 }); }
    if (!st.isFile()) return new Response("Not Found", { status: 404 });
    const data = fs.readFileSync(file);
    return new Response(data, {
      status: 200,
      headers: {
        "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
        "content-length": String(data.length),
        "cache-control": "no-store"
      }
    });
  }
};

/* ── 初始化数据库与本地账号 ─────────────────────────────────── */
db.exec(read("schema/0001_init.sql"));
db.exec(read("schema/0002_analytics.sql"));
db.exec(read("schema/0003_voice.sql"));

/* 随机生成的本地密码只存哈希；为了让重启后仍能显示，额外写一份到
   本地临时文件（tools/ 已被 .assetsignore / .gitignore 排除，绝不部署）。
   用 VOICE_DEV_ADMIN_PASSWORD 指定时不落盘。 */
let adminPassword = process.env.VOICE_DEV_ADMIN_PASSWORD || "";
if (!adminPassword && fs.existsSync(CRED_FILE)) {
  adminPassword = fs.readFileSync(CRED_FILE, "utf8").trim();
}
if (!adminPassword) {
  adminPassword = crypto.randomBytes(12).toString("base64url");
  fs.writeFileSync(CRED_FILE, adminPassword, "utf8");
}

let createdAdmin = false;
const hasSitePwd = db.prepare("SELECT k FROM config WHERE k = 'password'").get();
if (!hasSitePwd) {
  const rec = await C.hashPasswordRecord(adminPassword);
  db.prepare("INSERT OR REPLACE INTO config (k, v) VALUES ('password', ?)")
    .run(JSON.stringify(rec));
  createdAdmin = true;
}

const hasVoiceAdmin = db.prepare("SELECT id FROM voice_users WHERE role = 'admin' LIMIT 1").get();
if (!hasVoiceAdmin) {
  const rec = await C.hashPasswordRecord(adminPassword);
  db.prepare(
    "INSERT INTO voice_users " +
    "(id, username, display_name, avatar_ref, avatar_color, password_rec, role, status, created_at, last_login_at) " +
    "VALUES (?,?,?,?,?,?,?,?,?,NULL)"
  ).run(crypto.randomBytes(12).toString("hex"), "admin", "管理员", null,
    C.avatarColorFor("admin"), JSON.stringify(rec), "admin", "active", Date.now());
  createdAdmin = true;
}

let devInvite = null;
const invites = db.prepare("SELECT id, code_mask FROM invite_codes WHERE deleted_at IS NULL").all();
if (!invites.length) {
  const code = C.generateInviteCode();
  const id = crypto.randomBytes(12).toString("hex");
  db.prepare(
    "INSERT INTO invite_codes " +
    "(id, code_hash, code_mask, note, expires_at, max_uses, use_count, created_by, created_at, deleted_at) " +
    "VALUES (?,?,?,?,NULL,NULL,0,?,?,NULL)"
  ).run(id, await C.inviteHash(code), C.maskInvite(code), "本地开发测试邀请码（不限次数）",
    "dev-server", Date.now());
  devInvite = code;
}

/* ── env / ctx ───────────────────────────────────────────────── */
const env = {
  DB, MEDIA, ASSETS,
  TZ_OFFSET: "8",
  PBKDF2_ITERATIONS: "100000",
  GEO_SOURCE: "cf",
  TURNSTILE_SITE_KEY: "",
  VOICE_CAPTCHA_SECRET: "zf-voice-dev-only",
  // 本地不配置 SFU / TURN / LiveKit 密钥：前端自动使用「本地直连降级模式」，
  // 可以用两台无头浏览器真实建立 WebRTC 通话，不需要任何外部凭据。
  VOICE_ROOM: {
    idFromName: function (name) { return { name: name }; },
    get: function (id) {
      const inst = roomInstance(String(id.name || "").replace(/^zf-voice:/, ""));
      return { fetch: function (request) { return inst.http(request); } };
    }
  }
};

let pending = [];
const ctx = { waitUntil: function (p) { pending.push(p); } };

/* ── HTTP 服务 ───────────────────────────────────────────────── */
const server = http.createServer(async function (req, res) {
  const host = req.headers.host || "127.0.0.1:" + PORT;
  const url = "http://" + host + req.url;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers(req.headers);
  // Cloudflare 在边缘注入的可信 IP；本地统一记为 127.0.0.1
  headers.set("cf-connecting-ip", "127.0.0.1");
  const request = new Request(url, {
    method: req.method,
    headers: headers,
    body: (req.method === "GET" || req.method === "HEAD") ? undefined : body
  });

  let response;
  try {
    response = await worker.fetch(request, env, ctx);
    if (pending.length) {
      const jobs = pending.splice(0);
      await Promise.allSettled(jobs);
    }
  } catch (e) {
    console.error("[dev] Worker 异常:", e);
    response = new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), {
      status: 500, headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
  res.statusCode = response.status;
  // Node 的 Headers.forEach 会为每一条 set-cookie 单独回调一次，
  // 而 res.setHeader 同名覆盖 —— 登录下发的两条 Cookie 就只剩最后一条了。
  // 这里显式收集成数组一次性写出，保证本地行为与 Workers 运行时一致。
  const allCookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie() : null;
  response.headers.forEach(function (v, k) {
    if (k === "set-cookie" && allCookies) return;
    res.setHeader(k, v);
  });
  if (allCookies && allCookies.length) res.setHeader("set-cookie", allCookies);
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(req.method === "HEAD" ? undefined : buf);
});

/* ── WebSocket：房间票据校验 + 复用线上 DO 逻辑 ──────────────── */
server.on("upgrade", function (req, socket, head) {
  const u = new URL(req.url, "http://" + (req.headers.host || "127.0.0.1"));
  const match = u.pathname.match(/^\/api\/voice\/room\/([^/]+)\/ws$/);
  if (!match) { socket.destroy(); return; }
  const channelId = decodeURIComponent(match[1]);
  C.verifyRoomTicket(env, u.searchParams.get("ticket"), channelId).then(function (ticket) {
    wss.handleUpgrade(req, socket, head, function (ws) {
      if (!ticket) { ws.close(4401, "房间票据无效或已过期"); return; }
      const inst = roomInstance(channelId);
      const wrap = new DevWebSocket(ws);
      inst.state.acceptWebSocket(wrap);
      ws.on("message", function (data) { inst.onMessage(wrap, data.toString()); });
      ws.on("close", function () { inst.state.remove(wrap); inst.onClose(wrap); });
      ws.on("error", function () { inst.state.remove(wrap); inst.onClose(wrap); });
      inst.attach(wrap, ticket, channelId);
    });
  }).catch(function () { socket.destroy(); });
});

server.listen(PORT, "127.0.0.1", function () {
  console.log("");
  console.log("  ZF语音 本地 Worker 运行时已启动：http://127.0.0.1:" + PORT);
  console.log("  ─────────────────────────────────────────────────────────");
  console.log("  /voice/      登录 / 注册 → 语音页面     /admin/  管理后台 → ZF语音标签页");
  console.log("");
  console.log("  本地账号（仅本机有效" + (createdAdmin ? "，本次新建" : "") + "）：");
  console.log("    主站后台：用户名 ZFSN　密码 " + adminPassword);
  console.log("    ZF语音管理员：用户名 admin　密码 " + adminPassword);
  console.log("    注：若在后台改过密码或重置过管理员密码，以上仅首次初始化时有效。");
  if (devInvite) console.log("  本地测试邀请码：" + devInvite + "（不限次数；也可在后台自行创建）");
  console.log("");
  console.log("  数据库：" + DB_FILE);
  console.log("  ⚠ 这是本地开发工具，不要部署、不要对公网开放。Ctrl+C 结束。");
  console.log("");
});
