/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 服务端 API（阶段 2：账号体系 / 邀请码 / 验证码 / 管理）
 *
 *  设计约束：
 *  · 完全独立文件，不修改 handleAPI 的任何既有分支；src/index.js 只加一行分发。
 *  · 所有表以 voice_ / invite_ / captcha_ / audit_ 前缀隔离，不碰主站业务表。
 *  · 写接口全部做 Origin 校验 + 参数化 SQL；Cookie 为 HttpOnly + SameSite=Lax，
 *    数据库只存 token 的 SHA-256。
 *  · 验证码与邀请码的「一次性 / 上限」必须用**原子条件 UPDATE**，
 *    不能先 SELECT 再写，否则并发下会被重复消费。
 *  · 密码复用 lib.js 的 PBKDF2-SHA512（WebCrypto 在 Workers 里没有 argon2/scrypt，
 *    且迭代数有 100000 硬上限，见 lib.js 的详细注释）。
 * ══════════════════════════════════════════════════════════════ */

import * as L from "./lib.js";
import * as M from "./media.js";
import * as C from "./voice-core.js";

const SETTINGS_KEY = "voice:settings";
const PREFIX = "/api/voice/";

/* ── 通用小工具 ──────────────────────────────────────────────── */

/** D1 的 run() 在不同运行时把 changes 放在 meta 里或顶层，两种都兼容。 */
function changesOf(r) {
  if (!r) return 0;
  if (r.meta && typeof r.meta.changes === "number") return r.meta.changes;
  if (typeof r.changes === "number") return r.changes;
  return 0;
}

/** 统一口径见 voice-core.js 的 originOK（含本地 IIS 镜像的说明）。 */
function originOK(request) { return C.originOK(request); }

function err(msg, status) { return L.fail(msg, status || 400); }

/** cookie 可以是单条字符串，也可以是数组（登录要同时下发主 Cookie 与可读标记）。
 *  用 headers.append 而不是塞进构造参数，才能保留多条独立的 Set-Cookie。 */
function ok(data, status, cookie) {
  const res = L.json(Object.assign({ ok: true }, data || {}), status || 200);
  const list = Array.isArray(cookie) ? cookie : (cookie ? [cookie] : []);
  list.forEach(function (c) { res.headers.append("Set-Cookie", c); });
  return res;
}

async function readBody(request) {
  try { return await L.readJSON(request, 512 * 1024); }
  catch (_) { return null; }
}

export async function audit(env, ctx, request, actor, action, target, detail) {
  const job = (async function () {
    try {
      await env.DB.prepare(
        "INSERT INTO audit_logs (id, ts, actor, action, target, detail, ip) VALUES (?,?,?,?,?,?,?)"
      ).bind(L.randomHex(12), Date.now(), actor || "", action, target || "",
        JSON.stringify(detail || {}), L.clientIP(request) || "").run();
    } catch (e) {
      console.warn("[voice] 审计写入失败: %s", e && e.message);
    }
  })();
  // 生产用 waitUntil 不拖慢响应；本地测试传不带 waitUntil 的 ctx，同步等待便于断言。
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
  else await job;
}

/* ── 系统设置 ────────────────────────────────────────────────── */

export async function getSettings(env) {
  try {
    const row = await env.DB.prepare("SELECT v FROM config WHERE k = ?").bind(SETTINGS_KEY).first();
    if (row && row.v) {
      const saved = JSON.parse(row.v);
      return Object.assign({}, C.DEFAULT_SETTINGS, saved);
    }
  } catch (_) { /* 表还没建或 JSON 坏了，一律回落默认值 */ }
  return Object.assign({}, C.DEFAULT_SETTINGS);
}

export async function saveSettings(env, patch) {
  const next = Object.assign({}, await getSettings(env), patch || {});
  await env.DB.prepare(
    "INSERT INTO config (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ).bind(SETTINGS_KEY, JSON.stringify(next)).run();
  return next;
}

/* ── 会话 ────────────────────────────────────────────────────── */

export async function currentUser(env, request) {
  const token = C.parseCookies(request.headers.get("cookie"))[C.COOKIE_NAME];
  if (!token) return null;
  const th = await C.sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT u.* FROM voice_sessions s JOIN voice_users u ON u.id = s.user_id " +
    "WHERE s.token_hash = ? AND s.exp > ?"
  ).bind(th, Date.now()).first();
  return row || null;
}

/**
 * 签发会话。remember === false 时只给「浏览器会话级」Cookie（不带 Max-Age，
 * 关掉浏览器就失效），数据库仍留 12 小时兜底，防止服务端残留孤儿会话。
 * 默认（含老前端不传该字段）为「保持登录 30 天」。
 */
async function issueSession(env, request, user, remember) {
  const kind = remember === false ? "short" : "remember";
  const token = C.newSessionToken(kind === "remember");
  const th = await C.sha256Hex(token);
  const ttl = C.sessionTTL(kind);
  const exp = Date.now() + ttl;
  await env.DB.prepare(
    "INSERT INTO voice_sessions (token_hash, user_id, exp, ip, ua, created_at) VALUES (?,?,?,?,?,?)"
  ).bind(th, user.id, exp, L.clientIP(request) || "",
    L.clean(request.headers.get("user-agent") || "", 120), Date.now()).run();
  return {
    token: token,
    cookies: C.sessionCookies(request, token, kind === "short" ? 0 : ttl),
    session: { remember: kind === "remember", expiresAt: exp, renewed: false }
  };
}

/**
 * 会话滑动续期：只在 /me 与 /bootstrap 这两个「打开页面必调」的入口用，
 * 不会让每个语音 API 都去写一次库。续期沿用同一个令牌（不轮换），
 * 否则页面并发请求会互相把对方的令牌顶掉。
 *  · 只有「保持登录」会话会续，且从签发日起最多累计 90 天；
 *  · 临时会话与升级前的老令牌保持原过期时间，不改变用户的选择。
 * 返回 { user, cookies, session }；cookies 为空表示这次无需回写。
 */
export async function touchSession(env, request) {
  const token = C.parseCookies(request.headers.get("cookie"))[C.COOKIE_NAME];
  if (!token) return { user: null, cookies: [], session: null };
  const th = await C.sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT u.*, s.exp AS _exp, s.created_at AS _created FROM voice_sessions s " +
    "JOIN voice_users u ON u.id = s.user_id WHERE s.token_hash = ?"
  ).bind(th).first();
  if (!row) return { user: null, cookies: [], session: null };
  const now = Date.now();
  const exp = Number(row._exp) || 0;
  if (exp <= now) return { user: null, cookies: [], session: null };

  const kind = C.sessionKind(token);
  let cookies = [];
  let renewed = false;
  let finalExp = exp;
  if (kind === "remember") {
    // 绝对寿命上限：无论续多少次，令牌最多活 90 天，之后必须重新登录。
    const limit = (Number(row._created) || now) + C.MAX_SESSION_LIFE;
    const target = Math.min(now + C.REMEMBER_TTL, limit);
    if (target > exp && target - exp >= C.RENEW_BELOW) {
      finalExp = target;
      await env.DB.prepare("UPDATE voice_sessions SET exp = ? WHERE token_hash = ?")
        .bind(finalExp, th).run();
      cookies = C.sessionCookies(request, token, C.REMEMBER_TTL);
      renewed = true;
    }
  }
  return {
    user: row,
    cookies: cookies,
    session: { remember: kind === "remember", expiresAt: finalExp, renewed: renewed }
  };
}

/**
 * 管理接口双通道鉴权：
 *  · 现有后台的 X-Admin-Token（localStorage 里的管理员令牌，兼容现有 /admin）
 *  · ZF语音管理员的 HttpOnly Cookie（从 /voice 里直接调管理接口）
 * 两条通道都不依赖跨源 Cookie，避免为本地调试放宽 CORS credentials。
 */
export async function adminContext(env, request) {
  const at = L.adminTokenOf(request);
  if (at && await L.checkToken(env, at)) return { via: "admin-token", user: null };
  const u = await currentUser(env, request);
  if (u && u.role === "admin" && u.status === "active") {
    return { via: "voice", user: u };
  }
  return null;
}

/** 写接口统一鉴权 + CSRF。X-Admin-Token 是显式令牌，不受跨站表单伪造，故放宽 Origin。 */
async function requireAdminWrite(env, request) {
  const ac = await adminContext(env, request);
  if (!ac) return { error: err("需要管理员权限", 403) };
  if (ac.via === "voice" && !originOK(request)) {
    return { error: err("请求来源不合法（跨站请求已被拒绝）", 403) };
  }
  return { ac: ac };
}

/* ── 限流与失败冷却 ──────────────────────────────────────────── */

async function guard(env, keys, limit, windowMs) {
  for (let i = 0; i < keys.length; i++) {
    if (!(await L.rateAllow(env, keys[i], limit, windowMs))) return false;
  }
  return true;
}

async function recordFailure(env, key) {
  await env.DB.prepare("INSERT INTO rate (k, ts) VALUES (?, ?)")
    .bind("voice:fail:" + key, Date.now()).run();
}

async function clearFailures(env, key) {
  await env.DB.prepare("DELETE FROM rate WHERE k = ?").bind("voice:fail:" + key).run();
}

/** 连续失败 5 次后进入递增冷却（15s 起，最长 5 分钟）。返回还需等待的秒数。 */
export async function cooldownRemaining(env, key) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c, MAX(ts) AS last FROM rate WHERE k = ? AND ts > ?"
  ).bind("voice:fail:" + key, Date.now() - 15 * 60 * 1000).first();
  const n = Number(row && row.c ? row.c : 0);
  if (n < 5) return 0;
  const wait = Math.min(300, 15 * (n - 4));
  const elapsed = (Date.now() - Number(row && row.last ? row.last : 0)) / 1000;
  return Math.max(0, Math.ceil(wait - elapsed));
}

/* ── 验证码消费（原子、一次性）──────────────────────────────── */

/**
 * 无论答对答错都立刻把挑战置为 consumed=1：
 * 需求要求「验证失败或使用后立即作废」，且能阻止对同一张图的暴力枚举。
 * 条件 UPDATE 的 changes 为 0 说明已被用过或已过期。
 */
export async function consumeCaptcha(env, id, answer, secret) {
  if (!id || !answer) return { ok: false, error: "请填写验证码" };
  const row = await env.DB.prepare(
    "SELECT answer_hash, exp, consumed FROM captcha_challenges WHERE id = ?"
  ).bind(String(id)).first();
  if (!row) return { ok: false, error: "验证码无效，请点击图片刷新" };

  const r = await env.DB.prepare(
    "UPDATE captcha_challenges SET consumed = 1 WHERE id = ? AND consumed = 0 AND exp > ?"
  ).bind(String(id), Date.now()).run();
  if (changesOf(r) !== 1) return { ok: false, error: "验证码已过期或已使用，请刷新" };

  if (Number(row.exp) < Date.now()) return { ok: false, error: "验证码已过期，请刷新" };
  const wanted = await C.captchaHash(String(id), String(answer), secret);
  if (!L.safeEqual(wanted, String(row.answer_hash))) {
    return { ok: false, error: "验证码错误，请刷新后重试" };
  }
  return { ok: true };
}

/* ── 邀请码消费（原子、上限）────────────────────────────────── */

/** 一条条件 UPDATE 同时完成「存在 / 未删除 / 未过期 / 未超上限」与计数递增。 */
export async function consumeInvite(env, code) {
  const hash = await C.inviteHash(code);
  const r = await env.DB.prepare(
    "UPDATE invite_codes SET use_count = use_count + 1 " +
    "WHERE code_hash = ? AND deleted_at IS NULL " +
    "AND (expires_at IS NULL OR expires_at > ?) " +
    "AND (max_uses IS NULL OR use_count < max_uses)"
  ).bind(hash, Date.now()).run();
  if (changesOf(r) !== 1) {
    return { ok: false, error: "邀请码无效、已删除、已过期或已达使用上限" };
  }
  const row = await env.DB.prepare("SELECT id FROM invite_codes WHERE code_hash = ?").bind(hash).first();
  return { ok: true, id: row ? row.id : "" };
}

async function refundInvite(env, id) {
  if (!id) return;
  try {
    await env.DB.prepare("UPDATE invite_codes SET use_count = MAX(0, use_count - 1) WHERE id = ?")
      .bind(id).run();
  } catch (_) { /* 回滚失败只影响计数，审计里有记录，不阻断注册响应 */ }
}

/* ── 人机验证统一入口 ────────────────────────────────────────── */

async function verifyHuman(env, body, request, settings) {
  // 总开关：管理员关掉人机验证后，登录/注册/游客一律直接放行。
  if (settings && settings.captchaEnabled === false) return { ok: true, skipped: true };
  const mode = settings && settings.captchaMode === "turnstile" ? "turnstile" : "image";
  if (mode === "turnstile") {
    if (!env.TURNSTILE_SECRET_KEY) {
      return { ok: false, error: "管理员尚未配置 Turnstile 密钥，请改用图片验证码或联系管理员" };
    }
    const passed = await L.verifyTurnstile(
      env.TURNSTILE_SECRET_KEY, body.turnstileToken, L.clientIP(request)
    );
    return passed ? { ok: true } : { ok: false, error: "人机验证未通过，请重试" };
  }
  return await consumeCaptcha(env, body.captchaId, body.captcha, captchaSecret(env));
}

function captchaSecret(env) {
  return env.VOICE_CAPTCHA_SECRET || "zf-voice-captcha-v1";
}

/* ── 头像 ────────────────────────────────────────────────────── */

/** 前端已用 canvas 裁成正方形并压到 256px；服务端仍独立校验魔数与大小。 */
export function parseAvatar(dataUrl) {
  if (!dataUrl) return { ok: true, empty: true };
  const d = M.decodeDataUrl(dataUrl);
  if (!d || !d.buf) return { ok: false, error: "头像数据格式错误" };
  const ext = M.sniffImage(d.buf);
  if (!ext || [".jpg", ".png", ".webp"].indexOf(ext) < 0) {
    return { ok: false, error: "头像仅支持 jpg / png / webp" };
  }
  if (d.buf.length > C.AVATAR_LIMIT) return { ok: false, error: "头像不能超过 2 MB" };
  const type = ext === ".jpg" ? "image/jpeg" : ext === ".png" ? "image/png" : "image/webp";
  if (d.type && !/^image\/(jpeg|png|webp)$/.test(d.type)) {
    return { ok: false, error: "头像文件类型与实际内容不符" };
  }
  return { ok: true, empty: false, buf: d.buf, ext: ext, type: type };
}

/* ══════════════════════════════════════════════════════════════
   HTTP 分发
   ══════════════════════════════════════════════════════════════ */

export async function handleVoiceAPI(request, env, ctx, url) {
  const p = url.pathname;
  if (p.indexOf(PREFIX) !== 0) return null;
  const m = request.method.toUpperCase();
  const ip = L.clientIP(request) || "local";
  const settings = await getSettings(env);

  /* ── 公开：前端配置 ───────────────────────────────────────── */
  if (p === "/api/voice/config" && m === "GET") {
    const captchaEnabled = settings.captchaEnabled !== false;
    return ok({
      registrationOpen: !!settings.registrationOpen,
      captchaEnabled: captchaEnabled,
      guestLoginOpen: settings.guestLoginOpen !== false,
      captchaMode: captchaEnabled && settings.captchaMode === "turnstile" ? "turnstile" : "image",
      turnstileSiteKey: captchaEnabled && settings.captchaMode === "turnstile"
        ? (env.VOICE_TURNSTILE_SITE_KEY || env.TURNSTILE_SITE_KEY || "") : "",
      captchaLength: 5
    });
  }

  /* ── 公开：生成验证码图片 ─────────────────────────────────── */
  if (p === "/api/voice/captcha" && m === "GET") {
    if (!(await guard(env, ["voice:captcha:" + ip], 40, 60 * 1000))) {
      return err("验证码请求过于频繁，请稍后再试", 429);
    }
    const c = await C.makeCaptcha(captchaSecret(env));
    await env.DB.prepare(
      "INSERT INTO captcha_challenges (id, answer_hash, exp, consumed, ip, created_at) VALUES (?,?,?,0,?,?)"
    ).bind(c.id, c.answerHash, c.exp, ip, Date.now()).run();
    // 顺手清掉过期挑战，表不会无限增长
    try {
      await env.DB.prepare("DELETE FROM captcha_challenges WHERE exp < ?").bind(Date.now() - 60000).run();
    } catch (_) {}
    return ok({ captchaId: c.id, image: c.image, expiresIn: C.CAPTCHA_TTL / 1000 });
  }

  /* ── 公开：当前登录态 ─────────────────────────────────────── */
  if (p === "/api/voice/me" && m === "GET") {
    const t = await touchSession(env, request);
    return ok({ user: C.publicUser(t.user), session: t.session }, 200, t.cookies);
  }

  /* ── 登录用户：修改资料 / 头像 ───────────────────────────── */
  if (p === "/api/voice/me" && m === "PATCH") {
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    const u = await currentUser(env, request);
    if (!u || u.status !== "active") return err("请先登录 ZF语音", 401);
    if (!(await guard(env, ["voice:profile:" + u.id], 20, 60000))) return err("操作太频繁，请稍后再试", 429);
    const body = await readBody(request);
    if (!body) return err("请求内容无效或过大");
    const sets = [], args = [];
    if (body.displayName !== undefined) {
      const vd = C.validateDisplayName(body.displayName);
      if (!vd.ok) return err(vd.error);
      sets.push("display_name = ?"); args.push(vd.value);
    }
    if (body.avatar !== undefined) {
      const avatar = parseAvatar(body.avatar);
      if (!avatar.ok) return err(avatar.error);
      if (avatar.empty) return err("请选择要上传的头像");
      const ref = "voice/avatars/" + u.id + avatar.ext;
      await env.MEDIA.put(ref, avatar.buf, { httpMetadata: { contentType: avatar.type } });
      if (u.avatar_ref && u.avatar_ref !== ref) { try { await env.MEDIA.delete(u.avatar_ref); } catch (_) {} }
      sets.push("avatar_ref = ?"); args.push(ref);
    }
    if (!sets.length) return err("没有需要修改的资料");
    args.push(u.id);
    await env.DB.prepare("UPDATE voice_users SET " + sets.join(", ") + " WHERE id = ?").bind(...args).run();
    const fresh = await env.DB.prepare("SELECT * FROM voice_users WHERE id = ?").bind(u.id).first();
    await audit(env, ctx, request, u.username, "profile.update", u.id, { fields: Object.keys(body) });
    return ok({ user: C.publicUser(fresh) });
  }

  /* ── 登录用户：修改密码（当前会话保留） ──────────────────── */
  if (p === "/api/voice/password" && m === "POST") {
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    const token = C.parseCookies(request.headers.get("cookie"))[C.COOKIE_NAME];
    const u = await currentUser(env, request);
    if (!u || u.status !== "active" || !token) return err("请先登录 ZF语音", 401);
    if (!(await guard(env, ["voice:password:" + u.id, "voice:password:ip:" + ip], 8, 60 * 60 * 1000))) {
      return err("修改密码请求过于频繁，请稍后再试", 429);
    }
    const body = await readBody(request);
    if (!body) return err("请求内容无效或过大");
    if (!body.oldPassword || !body.newPassword) return err("请填写旧密码和新密码");
    let valid = false;
    try { valid = await C.verifyPasswordRecord(String(body.oldPassword), JSON.parse(u.password_rec)); }
    catch (_) {}
    if (!valid) return err("旧密码不正确", 403);
    const vp = C.validatePassword(body.newPassword);
    if (!vp.ok) return err(vp.error);
    const hash = await C.sha256Hex(token);
    await env.DB.prepare("UPDATE voice_users SET password_rec = ? WHERE id = ?")
      .bind(JSON.stringify(await C.hashPasswordRecord(vp.value)), u.id).run();
    await env.DB.prepare("DELETE FROM voice_sessions WHERE user_id = ? AND token_hash <> ?")
      .bind(u.id, hash).run();
    await audit(env, ctx, request, u.username, "password.change", u.id, { otherSessionsRevoked: true });
    return ok({});
  }

  /* ── 公开：头像读取（上传的图或自动生成的默认头像）───────── */
  const mAvatar = /^\/api\/voice\/avatars\/([a-z0-9_-]{6,64})$/i.exec(p);
  if (mAvatar && m === "GET") {
    const row = await env.DB.prepare(
      "SELECT id, display_name, avatar_color, avatar_ref, status FROM voice_users WHERE id = ?"
    ).bind(mAvatar[1]).first();
    if (!row) return new Response("Not Found", { status: 404 });
    const headers = { "cache-control": "private, max-age=600" };
    if (row.avatar_ref) {
      let buf = null;
      try { buf = await env.MEDIA.get(row.avatar_ref, "arrayBuffer"); } catch (_) {}
      if (buf && buf.byteLength) {
        const ext = String(row.avatar_ref).split(".").pop().toLowerCase();
        headers["content-type"] = ext === "png" ? "image/png" : ext === "jpg" ? "image/jpeg" : "image/webp";
        return new Response(buf, { status: 200, headers });
      }
    }
    headers["content-type"] = "image/svg+xml; charset=utf-8";
    return new Response(C.defaultAvatarSVG(row.display_name, row.avatar_color),
      { status: 200, headers });
  }

  /* ── 公开：注册 ───────────────────────────────────────────── */
  if (p === "/api/voice/register" && m === "POST") {
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    if (!settings.registrationOpen) return err("当前未开放注册，请联系管理员", 403);
    if (!(await guard(env, ["voice:reg:" + ip], 12, 60 * 60 * 1000))) {
      return err("注册请求过于频繁，请稍后再试", 429);
    }
    const body = await readBody(request);
    if (!body) return err("请求内容无效或过大");

    // 1) 人机验证先做：无论后续成败，这次挑战都已作废，防止重放
    const human = await verifyHuman(env, body, request, settings);
    if (!human.ok) return err(human.error);

    // 2) 字段校验
    const invite = String(body.invite == null ? "" : body.invite).trim();
    if (!invite) return err("请填写邀请码");
    const vu = C.validateUsername(body.username);
    if (!vu.ok) return err(vu.error);
    const vd = C.validateDisplayName(body.displayName);
    if (!vd.ok) return err(vd.error);
    const vp = C.validatePassword(body.password);
    if (!vp.ok) return err(vp.error);
    if (String(body.password2 || "") !== vp.value) return err("两次输入的密码不一致");
    const av = parseAvatar(body.avatar);
    if (!av.ok) return err(av.error);

    // 3) 用户名唯一（参数化查询，杜绝注入）
    const dup = await env.DB.prepare("SELECT id FROM voice_users WHERE username = ?").bind(vu.value).first();
    if (dup) return err("这个用户名已经被使用了");

    // 4) 原子消耗邀请码
    const inv = await consumeInvite(env, invite);
    if (!inv.ok) return err(inv.error);

    // 5) 创建用户
    const id = L.randomHex(16);
    const rec = await C.hashPasswordRecord(vp.value);
    const color = C.avatarColorFor(vu.value);
    let avatarRef = null;
    try {
      await env.DB.prepare(
        "INSERT INTO voice_users " +
        "(id, username, display_name, avatar_ref, avatar_color, password_rec, role, status, created_at, last_login_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,NULL)"
      ).bind(id, vu.value, vd.value, avatarRef, color, JSON.stringify(rec),
        "user", "active", Date.now()).run();

      if (!av.empty) {
        avatarRef = "voice/avatars/" + id + av.ext;
        await env.MEDIA.put(avatarRef, av.buf);
        await env.DB.prepare("UPDATE voice_users SET avatar_ref = ? WHERE id = ?")
          .bind(avatarRef, id).run();
      }
      await env.DB.prepare(
        "INSERT INTO invite_code_uses (id, code_id, user_id, used_at) VALUES (?,?,?,?)"
      ).bind(L.randomHex(12), inv.id, id, Date.now()).run();
    } catch (e) {
      await refundInvite(env, inv.id);
      console.error("[voice] 注册失败，已回滚邀请码计数: %s", e && e.message);
      return err("注册失败（用户名可能刚被占用），请重试", 500);
    }

    const user = await env.DB.prepare("SELECT * FROM voice_users WHERE id = ?").bind(id).first();
    const sess = await issueSession(env, request, user, body.remember);
    await audit(env, ctx, request, vu.value, "register", id,
      { inviteCodeId: inv.id, captchaMode: settings.captchaMode });
    await audit(env, ctx, request, vu.value, "login", id, { reason: "register" });
    return ok({ user: C.publicUser(user), session: sess.session }, 201, sess.cookies);
  }

  /* ── 公开：登录 ───────────────────────────────────────────── */
  if (p === "/api/voice/login" && m === "POST") {
    const body = await readBody(request);
    if (!body) return err("请求内容无效或过大");
    const cu = C.validateUsername(body.username);
    const uname = cu.ok ? cu.value : "invalid";
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    if (!(await guard(env, ["voice:login:ip:" + ip, "voice:login:u:" + uname], 20, 10 * 60 * 1000))) {
      return err("尝试次数过多，请稍后再试", 429);
    }
    const wait = Math.max(
      await cooldownRemaining(env, "u:" + uname),
      await cooldownRemaining(env, "ip:" + ip)
    );
    if (wait > 0) return err("连续失败次数过多，请等待 " + wait + " 秒后再试", 429);

    const human = await verifyHuman(env, body, request, settings);
    if (!human.ok) return err(human.error);
    if (!cu.ok) return err(cu.error);
    if (!body.password) return err("请填写密码");

    const row = await env.DB.prepare("SELECT * FROM voice_users WHERE username = ?").bind(uname).first();
    let good = false;
    if (row && row.password_rec) {
      try { good = await C.verifyPasswordRecord(String(body.password), JSON.parse(row.password_rec)); }
      catch (e) { return err(String(e && e.message || "密码校验失败"), 500); }
    }
    if (!good) {
      await recordFailure(env, "u:" + uname);
      await recordFailure(env, "ip:" + ip);
      await audit(env, ctx, request, uname, "login.fail", "", { reason: "bad-credentials" });
      return err("用户名或密码错误");
    }
    if (row.status !== "active") {
      return err(row.status === "banned" ? "该账号已被封禁" : "该账号已被禁用，请联系管理员", 403);
    }

    await clearFailures(env, "u:" + uname);
    await clearFailures(env, "ip:" + ip);
    await env.DB.prepare("UPDATE voice_users SET last_login_at = ? WHERE id = ?")
      .bind(Date.now(), row.id).run();
    const sess = await issueSession(env, request, row, body.remember);
    await audit(env, ctx, request, uname, "login", row.id,
      { remember: sess.session.remember ? "30d" : "session" });
    return ok({ user: C.publicUser(row), session: sess.session }, 200, sess.cookies);
  }

  /* ── 公开：游客登录（免注册，自动分配昵称）──────────────────
     后台「系统设置」可以随时关掉。游客是 role='guest' 的真实用户行，
     但没有可用密码（写的是随机口令的哈希），所以登不进去也改不了资料。 */
  if (p === "/api/voice/guest" && m === "POST") {
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    if (settings.guestLoginOpen === false) return err("当前未开放游客登录，请使用账号登录", 403);
    if (!(await guard(env, ["voice:guest:" + ip], 12, 60 * 60 * 1000))) {
      return err("游客登录过于频繁，请稍后再试", 429);
    }
    const body = (await readBody(request)) || {};
    const human = await verifyHuman(env, body, request, settings);
    if (!human.ok) return err(human.error);

    // 顺手清掉过期游客及其会话，表不会无限增长（失败不影响本次登录）
    try {
      const old = Date.now() - C.GUEST_TTL;
      await env.DB.prepare(
        "DELETE FROM voice_sessions WHERE user_id IN " +
        "(SELECT id FROM voice_users WHERE role = 'guest' AND created_at < ?)"
      ).bind(old).run();
      await env.DB.prepare("DELETE FROM voice_users WHERE role = 'guest' AND created_at < ?")
        .bind(old).run();
    } catch (_) { /* 老库没有 role 索引也不影响主流程 */ }

    const id = L.randomHex(16);
    const name = C.guestDisplayName();
    const rec = await C.hashPasswordRecord(L.randomHex(24));
    const color = C.avatarColorFor(id);
    let uname = "";
    let created = false;
    for (let i = 0; i < 4 && !created; i++) {
      uname = "guest_" + L.randomHex(6);
      try {
        await env.DB.prepare(
          "INSERT INTO voice_users " +
          "(id, username, display_name, avatar_ref, avatar_color, password_rec, role, status, created_at, last_login_at) " +
          "VALUES (?,?,?,NULL,?,?,?,?,?,?)"
        ).bind(id, uname, name, color, JSON.stringify(rec), "guest", "active",
          Date.now(), Date.now()).run();
        created = true;
      } catch (e) {
        if (i === 3) {
          console.error("[voice] 游客创建失败: %s", e && e.message);
          return err("游客登录失败，请稍后再试", 500);
        }
      }
    }

    const user = await env.DB.prepare("SELECT * FROM voice_users WHERE id = ?").bind(id).first();
    const sess = await issueSession(env, request, user, body.remember !== false);
    await audit(env, ctx, request, uname, "login.guest", id, { displayName: name });
    return ok({ user: C.publicUser(user), session: sess.session, guest: true }, 200, sess.cookies);
  }

  /* ── 登录用户：登出 ───────────────────────────────────────── */
  if (p === "/api/voice/logout" && m === "POST") {
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    // 先取用户再删会话，否则审计里用户名永远是空的
    const u = await currentUser(env, request);
    const token = C.parseCookies(request.headers.get("cookie"))[C.COOKIE_NAME];
    if (token) {
      await env.DB.prepare("DELETE FROM voice_sessions WHERE token_hash = ?")
        .bind(await C.sha256Hex(token)).run();
    }
    await audit(env, ctx, request, u ? u.username : "", "logout", u ? u.id : "", {});
    return ok({}, 200, C.clearSessionCookies(request));
  }

  /* ══ 以下全部是管理接口 ═════════════════════════════════════ */
  if (p.indexOf("/api/voice/admin/") !== 0) return null;

  /* ── 系统设置 ─────────────────────────────────────────────── */
  if (p === "/api/voice/admin/settings") {
    const wr = m !== "GET" ? await requireAdminWrite(env, request) : null;
    if (m === "GET") {
      if (!(await adminContext(env, request))) return err("需要管理员权限", 403);
      return ok({ settings: settings });
    }
    if (wr.error) return wr.error;
    if (m === "PATCH") {
      const body = await readBody(request);
      if (!body) return err("请求内容无效");
      const patch = {};
      if (typeof body.registrationOpen === "boolean") patch.registrationOpen = body.registrationOpen;
      if (typeof body.captchaEnabled === "boolean") patch.captchaEnabled = body.captchaEnabled;
      if (typeof body.guestLoginOpen === "boolean") patch.guestLoginOpen = body.guestLoginOpen;
      if (typeof body.allowUserSelfHosted === "boolean") patch.allowUserSelfHosted = body.allowUserSelfHosted;
      if (typeof body.allowUserPrivateChannels === "boolean") patch.allowUserPrivateChannels = body.allowUserPrivateChannels;
      if (Number.isFinite(Number(body.maxPrivateChannelsPerUser))) {
        patch.maxPrivateChannelsPerUser = Math.max(1, Math.min(100, Number(body.maxPrivateChannelsPerUser)));
      }
      if (body.captchaMode === "image" || body.captchaMode === "turnstile") {
        patch.captchaMode = body.captchaMode;
      }
      if (body.captchaMode === "turnstile" && !env.TURNSTILE_SECRET_KEY) {
        return err("尚未配置 TURNSTILE_SECRET_KEY，不能切换到 Turnstile", 400);
      }
      const next = await saveSettings(env, patch);
      await audit(env, ctx, request, "", "settings.update", "", patch);
      return ok({ settings: next });
    }
    return null;
  }

  /* ── 审计日志 ─────────────────────────────────────────────── */
  if (p === "/api/voice/admin/audit" && m === "GET") {
    if (!(await adminContext(env, request))) return err("需要管理员权限", 403);
    const rows = await env.DB.prepare(
      "SELECT id, ts, actor, action, target, detail, ip FROM audit_logs ORDER BY ts DESC LIMIT 100"
    ).all();
    return ok({ items: rows.results || [] });
  }

  /* ── 邀请码：列表 / 创建 ──────────────────────────────────── */
  if (p === "/api/voice/admin/invites") {
    const wr = m !== "GET" ? await requireAdminWrite(env, request) : null;
    if (m === "GET") {
      if (!(await adminContext(env, request))) return err("需要管理员权限", 403);
      const rows = await env.DB.prepare(
        "SELECT id, code_mask, note, expires_at, max_uses, use_count, created_by, created_at, deleted_at " +
        "FROM invite_codes ORDER BY created_at DESC LIMIT 200"
      ).all();
      return ok({ items: (rows.results || []).map(function (r) {
        return {
          id: r.id, mask: r.code_mask, note: r.note || "",
          expiresAt: r.expires_at ? Number(r.expires_at) : null,
          maxUses: r.max_uses === null ? null : Number(r.max_uses),
          useCount: Number(r.use_count) || 0,
          createdAt: Number(r.created_at) || 0,
          deleted: !!r.deleted_at
        };
      }) });
    }
    if (wr.error) return wr.error;
    if (m === "POST") {
      const body = await readBody(request);
      if (!body) return err("请求内容无效");
      let expiresAt = null;
      if (body.expiresAt !== null && body.expiresAt !== undefined && body.expiresAt !== "") {
        const n = Number(body.expiresAt);
        if (!Number.isFinite(n) || n <= 0) return err("有效期格式不正确");
        expiresAt = Math.floor(n);
      }
      let maxUses = null;
      if (body.maxUses !== null && body.maxUses !== undefined && body.maxUses !== "") {
        const n = Number(body.maxUses);
        if (!Number.isInteger(n) || n < 1 || n > 100000) return err("最大使用次数需为 1~100000 的整数");
        maxUses = n;
      }
      const note = L.clean(body.note, 120);
      const code = C.generateInviteCode();
      const id = L.randomHex(12);
      try {
        await env.DB.prepare(
          "INSERT INTO invite_codes " +
          "(id, code_hash, code_mask, note, expires_at, max_uses, use_count, created_by, created_at, deleted_at) " +
          "VALUES (?,?,?,?,?,?,0,?,?,NULL)"
        ).bind(id, await C.inviteHash(code), C.maskInvite(code), note, expiresAt, maxUses,
          wr.ac.user ? wr.ac.user.username : "admin-token", Date.now()).run();
      } catch (e) {
        return err("邀请码创建失败（随机数碰撞，请重试）", 500);
      }
      await audit(env, ctx, request, "", "invite.create", id, { expiresAt, maxUses, note });
      // 明文只在这一个响应里返回；列表只给掩码
      return ok({ code: code, id: id }, 201);
    }
    return null;
  }

  /* ── 邀请码：使用记录 / 删除 ──────────────────────────────── */
  const mUses = /^\/api\/voice\/admin\/invites\/([a-z0-9_-]{6,64})\/uses$/i.exec(p);
  if (mUses && m === "GET") {
    if (!(await adminContext(env, request))) return err("需要管理员权限", 403);
    const rows = await env.DB.prepare(
      "SELECT x.used_at, u.id AS user_id, u.username, u.display_name " +
      "FROM invite_code_uses x LEFT JOIN voice_users u ON u.id = x.user_id " +
      "WHERE x.code_id = ? ORDER BY x.used_at DESC LIMIT 200"
    ).bind(mUses[1]).all();
    return ok({ items: rows.results || [] });
  }

  const mInvite = /^\/api\/voice\/admin\/invites\/([a-z0-9_-]{6,64})$/i.exec(p);
  if (mInvite && m === "DELETE") {
    const wr = await requireAdminWrite(env, request);
    if (wr.error) return wr.error;
    const r = await env.DB.prepare(
      "UPDATE invite_codes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
    ).bind(Date.now(), mInvite[1]).run();
    if (changesOf(r) !== 1) return err("邀请码不存在或已被删除", 404);
    await audit(env, ctx, request, "", "invite.delete", mInvite[1], {});
    return ok({});
  }

  /* ── 用户：列表 ───────────────────────────────────────────── */
  if (p === "/api/voice/admin/users" && m === "GET") {
    if (!(await adminContext(env, request))) return err("需要管理员权限", 403);
    const q = L.clean(url.searchParams.get("q") || "", 24).toLowerCase();
    let rows;
    if (q) {
      rows = await env.DB.prepare(
        "SELECT * FROM voice_users WHERE username LIKE ? OR display_name LIKE ? " +
        "ORDER BY created_at DESC LIMIT 100"
      ).bind("%" + q + "%", "%" + q + "%").all();
    } else {
      rows = await env.DB.prepare(
        "SELECT * FROM voice_users ORDER BY created_at DESC LIMIT 100"
      ).all();
    }
    return ok({ items: (rows.results || []).map(C.publicUser) });
  }

  /* ── 用户：改角色 / 禁用 / 重置密码 / 删除 ────────────────── */
  const mUser = /^\/api\/voice\/admin\/users\/([a-z0-9_-]{6,64})$/i.exec(p);
  if (mUser) {
    const wr = await requireAdminWrite(env, request);
    if (wr.error) return wr.error;
    const uid = mUser[1];
    const target = await env.DB.prepare("SELECT * FROM voice_users WHERE id = ?").bind(uid).first();
    if (!target) return err("用户不存在", 404);
    // 用语音 Cookie 操作时，禁止把自己降权 / 禁用 / 删除（仍允许改自己的密码）
    const isSelf = wr.ac.via === "voice" && wr.ac.user && wr.ac.user.id === uid;
    if (isSelf && m === "DELETE") return err("不能删除自己", 400);

    if (m === "PATCH") {
      const body = await readBody(request);
      if (!body) return err("请求内容无效");
      if (isSelf && (body.role !== undefined || body.status !== undefined)) {
        return err("不能修改自己的角色或状态", 400);
      }
      const sets = [], args = [];
      if (["user", "admin", "guest"].indexOf(body.role) >= 0) { sets.push("role = ?"); args.push(body.role); }
      if (["active", "disabled", "banned"].indexOf(body.status) >= 0) {
        sets.push("status = ?"); args.push(body.status);
      }
      let reset = false;
      if (body.password !== undefined) {
        const vp = C.validatePassword(body.password);
        if (!vp.ok) return err(vp.error);
        sets.push("password_rec = ?"); args.push(JSON.stringify(await C.hashPasswordRecord(vp.value)));
        reset = true;
      }
      if (!sets.length) return err("没有需要修改的字段");
      args.push(uid);
      const stmt = env.DB.prepare("UPDATE voice_users SET " + sets.join(", ") + " WHERE id = ?");
      await stmt.bind(...args).run();
      if (reset || body.status === "disabled" || body.status === "banned") {
        // 改密 / 停用后强制该用户所有会话下线
        await env.DB.prepare("DELETE FROM voice_sessions WHERE user_id = ?").bind(uid).run();
      }
      await audit(env, ctx, request, target.username, "user.update", uid,
        { role: body.role, status: body.status, resetPassword: reset });
      return ok({});
    }

    if (m === "DELETE") {
      await env.DB.prepare("DELETE FROM voice_sessions WHERE user_id = ?").bind(uid).run();
      await env.DB.prepare("DELETE FROM invite_code_uses WHERE user_id = ?").bind(uid).run();
      await env.DB.prepare("DELETE FROM voice_users WHERE id = ?").bind(uid).run();
      try { await env.MEDIA.delete("voice/avatars/" + uid + ".webp"); } catch (_) {}
      await audit(env, ctx, request, target.username, "user.delete", uid, {});
      return ok({});
    }
    return null;
  }

  return null;   // 未命中：交回主 Worker 返回 404
}
