/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 实时语音 / 频道 / 私有频道 / 管理 API（阶段 3~6）
 *
 *  ★ 架构约束（2026-11-14 用户追加，优先级高于早期方案）：
 *    生产后端**只有 Cloudflare Worker**（+ Durable Object + D1 + KV
 *    + Cloudflare Realtime SFU / TURN）。用户的电脑只是浏览器客户端，
 *    用来「添加私有频道」，不跑任何常驻服务。
 *    私有频道 = D1 里的一条频道记录 + 可见性与加入口令，媒体仍走
 *    Cloudflare SFU；self_hosted_servers 只是可选高级模式的配置。
 *
 *  官方文档（2026-11-14 逐条核对，编码前复核）：
 *   · Connection API base: https://rtc.live.cloudflare.com/v1
 *     POST /apps/{appId}/sessions/new（无请求体，返回 sessionId）
 *     POST /apps/{appId}/sessions/{sid}/tracks/new
 *       {"sessionDescription":{"type":"offer","sdp":"..."},
 *        "tracks":[{"location":"local","mid":"0","trackName":"audio"}]}
 *     订阅：{"tracks":[{"location":"remote","sessionId":"...","trackName":"..."}]}
 *     PUT  /apps/{appId}/sessions/{sid}/renegotiate
 *       {"sessionDescription":{"type":"answer","sdp":"..."}}
 *     PUT  /apps/{appId}/sessions/{sid}/tracks/close
 *     GET  /apps/{appId}/sessions/{sid}
 *     认证：Authorization: Bearer <APP_SECRET>（只放 Worker）
 *     https://developers.cloudflare.com/realtime/sfu/api/
 *     https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/
 *   · TURN 短期凭据：
 *     POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers
 *     {"ttl":3600} -> {"iceServers":[...]}
 *     https://developers.cloudflare.com/realtime/turn/generate-credentials/
 *   · Durable Objects WebSocket Hibernation：state.acceptWebSocket(ws)、
 *     ws.serializeAttachment()、webSocketMessage/Close 回调。
 *     https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 * ══════════════════════════════════════════════════════════════ */

import * as L from "./lib.js";
import * as C from "./voice-core.js";
import { currentUser, touchSession, adminContext, getSettings, saveSettings, audit } from "./voice-auth.js";

const PREFIX = "/api/voice/";
const OWNED = [
  /^\/api\/voice\/bootstrap$/,
  /^\/api\/voice\/channels(?:\/.*)?$/,
  /^\/api\/voice\/rtc\/.*$/,
  /^\/api\/voice\/servers(?:\/.*)?$/,
  /^\/api\/voice\/admin\/(?:channels|servers|kick|mute|room)(?:\/.*)?$/
];

function err(msg, status) { return L.fail(msg, status || 400); }
function ok(data, status, cookies) {
  const res = L.json(Object.assign({ ok: true }, data || {}), status || 200);
  (cookies || []).forEach(function (c) { res.headers.append("Set-Cookie", c); });
  return res;
}

/** 统一口径见 voice-core.js 的 originOK（含本地 IIS 镜像的说明）。 */
function originOK(request) { return C.originOK(request); }

async function readBody(request) {
  try { return await L.readJSON(request, 256 * 1024); }
  catch (_) { return null; }
}

async function requireUser(env, request) {
  const u = await currentUser(env, request);
  if (!u) return { error: err("请先登录 ZF语音", 401) };
  if (u.status !== "active") return { error: err("账号已被禁用或封禁", 403) };
  return { user: u };
}

async function requireAdmin(env, request) {
  const ac = await adminContext(env, request);
  if (!ac) return { error: err("需要管理员权限", 403) };
  if (ac.via === "voice" && !originOK(request)) {
    return { error: err("请求来源不合法（跨站请求已被拒绝）", 403) };
  }
  return { ac: ac, actor: ac.user ? ac.user.username : "admin" };
}

/* ── Durable Object 访问封装 ─────────────────────────────────── */

function roomStub(env, channelId) {
  if (!env || !env.VOICE_ROOM || !env.VOICE_ROOM.idFromName) return null;
  const id = env.VOICE_ROOM.idFromName("zf-voice:" + channelId);
  return env.VOICE_ROOM.get(id);
}

async function roomCall(env, channelId, tail, method, body) {
  const stub = roomStub(env, channelId);
  if (!stub) return { ok: false, unavailable: true };
  const url = "https://voice-room.internal/rooms/" + encodeURIComponent(channelId) + tail;
  try {
    const r = await stub.fetch(new Request(url, {
      method: method || "GET",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    }));
    return await r.json();
  } catch (e) {
    return { ok: false, error: "房间状态服务暂时不可用" };
  }
}

async function roomState(env, channelId) {
  const r = await roomCall(env, channelId, "/state", "GET");
  return { members: Array.isArray(r.members) ? r.members : [], count: Number(r.count) || 0, unavailable: !!r.unavailable };
}

/* ── 频道数据 ───────────────────────────────────────────────── */

function parseJSON(raw, fallback) {
  try { return JSON.parse(raw || "null") || fallback; } catch (_) { return fallback; }
}

async function settingsFor(env, channelId) {
  try {
    const row = await env.DB.prepare(
      "SELECT audio_json, screen_json FROM channel_settings WHERE channel_id = ?"
    ).bind(channelId).first();
    return {
      audio: C.normalizeAudioSettings(parseJSON(row && row.audio_json, {})),
      screen: C.normalizeScreenSettings(parseJSON(row && row.screen_json, {}))
    };
  } catch (_) {
    return { audio: C.normalizeAudioSettings({}), screen: C.normalizeScreenSettings({}) };
  }
}

function canSee(row, user) {
  if (row.visibility !== "private") return true;
  if (!user) return false;
  if (user.role === "admin" || row.owner_id === user.id) return true;
  const allowed = parseJSON(row.allowed_users, []);
  return Array.isArray(allowed) && allowed.indexOf(user.id) >= 0;
}

function canJoin(row, user) {
  if (!canSee(row, user)) return { ok: false, error: "这个私有频道没有对你开放" };
  if (row.join_scope === "roles") {
    const roles = parseJSON(row.join_roles, ["admin"]);
    if (roles.indexOf(user.role) < 0) return { ok: false, error: "该频道仅限指定角色加入" };
  }
  return { ok: true };
}

function publicChannel(row, user, st, members) {
  const isSelf = row.backend === "self_hosted";
  return {
    id: row.id,
    name: row.name,
    descr: row.descr || "",
    icon: row.icon || "",
    backend: isSelf ? "self" : "cloudflare",
    backendLabel: isSelf ? "自建" : "云",
    visibility: row.visibility || "public",
    private: row.visibility === "private",
    hasPassword: !!row.password_hash,
    ownerId: row.owner_id || null,
    joinScope: row.join_scope || "all",
    joinRoles: parseJSON(row.join_roles, []),
    maxUsers: Number(row.max_users) || 20,
    ord: Number(row.ord) || 0,
    revision: Number(row.revision) || 1,
    serverId: row.server_id || null,
    settings: st || { audio: C.normalizeAudioSettings({}), screen: C.normalizeScreenSettings({}) },
    offline: isSelf && !row.server_id,   // 自建服务器未配置时标离线，不影响其他频道
    online: members ? members.count : 0,
    members: members ? members.members : []
  };
}

function wsUrl(request, channelId, ticket) {
  const u = new URL(request.url);
  const scheme = u.protocol === "https:" ? "wss" : "ws";
  return scheme + "://" + u.host + "/api/voice/room/" + encodeURIComponent(channelId) +
    "/ws?ticket=" + encodeURIComponent(ticket);
}

/* ── Cloudflare Realtime SFU ────────────────────────────────── */

function sfuConfig(env) {
  return {
    appId: env.REALTIME_SFU_APP_ID || "",
    secret: env.REALTIME_SFU_APP_SECRET || env.REALTIME_SFU_BEARER_TOKEN || ""
  };
}

async function sfuCall(env, path, method, body) {
  const cfg = sfuConfig(env);
  if (!cfg.appId || !cfg.secret) {
    return { configured: false, error: "尚未配置 Cloudflare Realtime SFU 凭据" };
  }
  const url = "https://rtc.live.cloudflare.com/v1/apps/" + encodeURIComponent(cfg.appId) + path;
  try {
    const r = await fetch(url, {
      method: method || "POST",
      headers: { "Authorization": "Bearer " + cfg.secret, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await r.json().catch(function () { return {}; });
    return { configured: true, ok: r.ok, status: r.status, data: data };
  } catch (e) {
    return { configured: true, ok: false, status: 502, error: "连接 Cloudflare SFU 失败：" + (e && e.message) };
  }
}

/** 默认 STUN + 可选 Cloudflare TURN 短期凭据（永不下发长期密钥）。 */
async function iceServers(env) {
  const list = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
  const keyId = env.TURN_KEY_ID || "";
  const token = env.TURN_KEY_API_TOKEN || "";
  if (!keyId || !token) return { iceServers: list, turn: false };
  try {
    const r = await fetch(
      "https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(keyId) +
      "/credentials/generate-ice-servers",
      {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ ttl: 3600 }),
        signal: AbortSignal.timeout(2500)
      }
    );
    if (!r.ok) return { iceServers: list, turn: false };
    const d = await r.json();
    if (Array.isArray(d.iceServers) && d.iceServers.length) {
      return { iceServers: d.iceServers, turn: true };
    }
  } catch (_) {}
  return { iceServers: list, turn: false };
}

/* ── 可选高级模式：LiveKit 短期令牌（JWT HS256） ────────────── */

/** 显示名可以是中文，而 btoa() 只接受 Latin1 字符；先显式 UTF-8 编码，
 *  再逐字节转成二进制串，否则自建频道遇到中文昵称会直接 500。 */
function b64url(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function livekitToken(env, server, user, channelId) {
  const apiKey = env[server.api_key_ref || "LIVEKIT_API_KEY"] || env.LIVEKIT_API_KEY || "";
  const secret = env[server.secret_ref || "LIVEKIT_API_SECRET"] || env.LIVEKIT_API_SECRET || "";
  if (!apiKey || !secret) return { error: "未配置自建服务的 API Key / Secret（Worker 密钥）" };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: apiKey, sub: user.id, nbf: now - 10, exp: now + 3600,
    name: user.display_name,
    video: { roomJoin: true, room: channelId, canPublish: true, canSubscribe: true,
      canPublishData: true, canUpdateOwnMetadata: true },
    metadata: JSON.stringify({ role: user.role })
  }));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(header + "." + payload));
  // ⚠ 签名是**原始随机字节**，绝不能再用 b64url()——那个函数内部会做
  //   TextEncoder（UTF-8）编码，把每个 ≥0x80 的字节扩成两字节，签名直接损坏，
  //   LiveKit 侧表现为 "token signature is invalid" → 401（浏览器 Failed to fetch）。
  //   这里必须对原始字节直接 base64url 编码。
  const sigBytes = new Uint8Array(sig);
  let bin = "";
  for (let i = 0; i < sigBytes.length; i++) bin += String.fromCharCode(sigBytes[i]);
  const sigB64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { token: header + "." + payload + "." + sigB64 };
}

/* ── 连接地址校验（HTTPS 混合内容 / 纯 IP 证书） ────────────── */

const LOOPBACK = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function checkHost(host, tls) {
  const h = String(host || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!h || /[\s@]/.test(h)) return "请填写正确的服务器域名或 IP（不要带 http:// 或路径）";
  if (!tls && !LOOPBACK.test(h)) {
    return "当前站点是 HTTPS，浏览器会拦截 ws:// 连接（混合内容）。" +
      (IPV4.test(h) ? "而且纯 IP 通常申请不到受信任的 TLS 证书。" : "") +
      " 请改用：① Cloudflare Tunnel 把本机信令端口暴露成 wss 域名；② 域名 + DDNS + Let's Encrypt 证书；③ 仅本机调试用 localhost。";
  }
  if (IPV4.test(h) && tls) {
    return "纯 IP 一般签不到受信任的 TLS 证书，wss 握手会失败。建议用 Cloudflare Tunnel 绑定一个域名后填写域名。";
  }
  return "";
}

/* ══════════════════════════════════════════════════════════════
   HTTP 分发（只处理本模块拥有的路径，其余返回 null 交回 voice-auth）
   ══════════════════════════════════════════════════════════════ */
export async function handleVoiceRealtime(request, env, ctx, url) {
  const p = url.pathname;
  if (p.indexOf(PREFIX) !== 0) return null;
  if (!OWNED.some(function (re) { return re.test(p); })) return null;
  const m = request.method.toUpperCase();
  const settings = await getSettings(env);
  const sfu = sfuConfig(env);

  /* ── 前端一次性引导 ───────────────────────────────────────── */
  if (p === "/api/voice/bootstrap" && m === "GET") {
    // 打开页面必走的入口：顺便做滑动续期，常来的用户永远不用重新登录
    const t = await touchSession(env, request);
    const u = t.user;
    const user = u && u.status === "active" ? C.publicUser(u) : null;
    const channels = user ? await listChannels(env, u) : [];
    return ok({
      user: user,
      session: t.session,
      channels: channels,
      settings: {
        allowUserPrivateChannels: settings.allowUserPrivateChannels !== false,
        allowUserSelfHosted: !!settings.allowUserSelfHosted
      },
      capabilities: {
        worker: true,                 // 后端只在 Cloudflare Worker
        durableObject: !!env.VOICE_ROOM,
        sfu: !!(sfu.appId && sfu.secret),
        turn: !!(env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN),
        livekit: !!env.LIVEKIT_API_KEY,
        screenShare: true
      }
    }, 200, t.cookies);
  }

  /* ── 频道列表 ─────────────────────────────────────────────── */
  if (p === "/api/voice/channels" && m === "GET") {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    return ok({ items: await listChannels(env, wr.user) });
  }

  /* ── 添加私有频道（用户电脑只做这件事） ───────────────────── */
  if (p === "/api/voice/channels" && m === "POST") {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    if (!await L.rateAllow(env, "voice:addch:" + wr.user.id, 10, 60000)) {
      return err("操作太频繁，请稍后再试", 429);
    }
    const b = await readBody(request);
    if (!b) return err("请求内容无效");
    const nv = C.validateChannelName(b.name);
    if (!nv.ok) return err(nv.error);
    const isSelf = b.backend === "self_hosted" || b.backend === "self";
    if (isSelf && !settings.allowUserSelfHosted && wr.user.role !== "admin") {
      return err("只有管理员能添加自建服务器频道；默认请选「Cloudflare 频道」", 403);
    }
    if (isSelf) {
      const bad = checkHost(b.host, b.tls !== false);
      if (bad) return err(bad);
    }
    const visibility = b.visibility === "private" ? "private" : "public";
    if (visibility === "private" && settings.allowUserPrivateChannels === false && wr.user.role !== "admin") {
      return err("管理员已关闭普通用户创建私有频道", 403);
    }
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS c FROM channels WHERE owner_id = ? AND visibility = 'private'"
    ).bind(wr.user.id).first();
    const max = Number(settings.maxPrivateChannelsPerUser) || 10;
    if (Number(count && count.c) >= max) return err("私有频道数量已达上限（" + max + " 个）");

    const id = "ch-" + L.randomHex(8);
    const now = Date.now();
    let serverId = null;
    if (isSelf) {
      serverId = "srv-" + L.randomHex(8);
      await env.DB.prepare(
        "INSERT INTO self_hosted_servers (id,name,host,port,tls,screen_host,secret_ref,status,created_by,created_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).bind(serverId, nv.value, String(b.host).trim().slice(0, 120),
        Number(b.port) || 7880, b.tls === false ? 0 : 1, b.screenHost || null,
        "LIVEKIT_API_SECRET", "unknown", wr.user.id, now).run();
    }
    const pwdHash = visibility === "private" && b.password
      ? await C.sha256Hex("zfch|" + id + "|" + String(b.password)) : null;
    await env.DB.prepare(
      "INSERT INTO channels (id,name,descr,icon,backend,server_id,visibility,password_hash,allowed_users,owner_id," +
      "ord,join_scope,join_roles,max_users,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, nv.value, L.clean(b.descr, 120), L.clean(b.icon, 40),
      isSelf ? "self_hosted" : "cloudflare", serverId, visibility, pwdHash,
      JSON.stringify(visibility === "private" ? [wr.user.id] : []), wr.user.id,
      1000 + now % 1000, "all", "[]", 20, 1, now, now).run();
    await env.DB.prepare(
      "INSERT INTO channel_settings (channel_id,audio_json,screen_json,updated_at) VALUES (?,?,?,?)"
    ).bind(id, JSON.stringify(C.normalizeAudioSettings({})),
      JSON.stringify(C.normalizeScreenSettings({})), now).run();
    await audit(env, ctx, request, wr.user.username, "channel.create", id,
      { name: nv.value, visibility: visibility, backend: isSelf ? "self_hosted" : "cloudflare" });
    return ok({ channel: (await listChannels(env, wr.user)).filter(function (c) { return c.id === id; })[0] }, 201);
  }

  /* ── 频道所有者修改 / 删除 ───────────────────────────────── */
  const ownedChannelMatch = p.match(/^\/api\/voice\/channels\/([^/]+)$/);
  if (ownedChannelMatch && (m === "PATCH" || m === "DELETE")) {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    if (!await L.rateAllow(env, "voice:channel-edit:" + wr.user.id, 20, 60000)) return err("操作太频繁，请稍后再试", 429);
    const id = decodeURIComponent(ownedChannelMatch[1]);
    const row = await env.DB.prepare("SELECT * FROM channels WHERE id = ?").bind(id).first();
    if (!row) return err("频道不存在或已被删除", 404);
    if (row.owner_id !== wr.user.id && wr.user.role !== "admin") return err("只有频道创建者或管理员可以操作", 403);
    if (m === "DELETE") {
      const rs = await roomState(env, id);
      if (rs.count > 0) return err("频道内还有 " + rs.count + " 人，请先让成员离开", 409);
      await env.DB.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM channel_settings WHERE channel_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM voice_sfu_sessions WHERE channel_id = ?").bind(id).run();
      if (row.server_id) await env.DB.prepare("DELETE FROM self_hosted_servers WHERE id = ? AND created_by = ?")
        .bind(row.server_id, row.owner_id).run();
      await roomCall(env, id, "/close", "POST", {});
      await audit(env, ctx, request, wr.user.username, "channel.delete", id, { ownerId: row.owner_id });
      return ok({});
    }
    const b = await readBody(request);
    if (!b) return err("请求内容无效");
    const sets = [], args = [];
    if (b.name !== undefined) {
      const nv = C.validateChannelName(b.name);
      if (!nv.ok) return err(nv.error);
      sets.push("name = ?"); args.push(nv.value);
    }
    if (b.descr !== undefined) { sets.push("descr = ?"); args.push(L.clean(b.descr, 120)); }
    if (b.visibility !== undefined) {
      if (["private", "public"].indexOf(b.visibility) < 0) return err("频道可见范围无效");
      sets.push("visibility = ?"); args.push(b.visibility);
    }
    if (b.password !== undefined) {
      if (String(b.password).length > 64) return err("频道口令不能超过 64 个字符");
      sets.push("password_hash = ?");
      args.push(b.password ? await C.sha256Hex("zfch|" + id + "|" + String(b.password)) : null);
    }
    if (b.max_users !== undefined || b.maxUsers !== undefined) {
      const max = Math.max(1, Math.min(wr.user.role === "admin" ? 200 : Number(settings.maxUsersPerChannel) || 20,
        Number(b.max_users === undefined ? b.maxUsers : b.max_users) || 20));
      sets.push("max_users = ?"); args.push(max);
    }
    if (!sets.length) return err("没有需要修改的字段");
    sets.push("revision = revision + 1", "updated_at = ?"); args.push(Date.now(), id);
    await env.DB.prepare("UPDATE channels SET " + sets.join(", ") + " WHERE id = ?").bind(...args).run();
    const fresh = await env.DB.prepare("SELECT * FROM channels WHERE id = ?").bind(id).first();
    const st = await settingsFor(env, id);
    const rs = await roomState(env, id);
    await roomCall(env, id, "/channel", "POST", { name: fresh.name });
    const visible = await listChannels(env, wr.user);
    const updated = visible.filter(function (c) { return c.id === id; })[0] || publicChannel(fresh, wr.user, st, rs);
    await audit(env, ctx, request, wr.user.username, "channel.update", id, { fields: Object.keys(b) });
    return ok({ channel: updated });
  }

  /* ── 加入频道：鉴权 / 上限 / 房间票据 / ICE / 令牌 ─────────── */
  const joinMatch = p.match(/^\/api\/voice\/channels\/([^/]+)\/join$/);
  if (joinMatch && m === "POST") {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    if (!originOK(request)) return err("请求来源不合法（跨站请求已被拒绝）", 403);
    if (!await L.rateAllow(env, "voice:join:" + wr.user.id, 20, 60000)) {
      return err("加入太频繁，请稍后再试", 429);
    }
    const channelId = decodeURIComponent(joinMatch[1]);
    const row = await env.DB.prepare("SELECT * FROM channels WHERE id = ?").bind(channelId).first();
    if (!row) return err("频道不存在或已被删除", 404);
    const cj = canJoin(row, wr.user);
    if (!cj.ok) return err(cj.error, 403);
    if (row.password_hash) {
      const b = await readBody(request);
      const got = await C.sha256Hex("zfch|" + channelId + "|" + String(b && b.password || ""));
      if (!L.safeEqual(got, row.password_hash)) return err("私有频道口令不正确", 403);
    }
    const st = await settingsFor(env, channelId);
    const rs = await roomState(env, channelId);
    if (rs.count >= (Number(row.max_users) || 20) &&
      !rs.members.some(function (x) { return x.id === wr.user.id; })) {
      return err("频道已满（最多 " + (Number(row.max_users) || 20) + " 人）", 409);
    }
    const ticket = await C.signRoomTicket(env, {
      u: wr.user.id, c: channelId, n: wr.user.display_name,
      color: wr.user.avatar_color, r: wr.user.role,
      avatarUrl: wr.user.avatar_ref ? "/api/voice/avatars/" + encodeURIComponent(wr.user.id) : null
    });
    const ice = await iceServers(env);
    let selfHosted = null;
    if (row.backend === "self_hosted") {
      const srv = await env.DB.prepare("SELECT * FROM self_hosted_servers WHERE id = ?")
        .bind(row.server_id || "").first();
      if (!srv) return err("该自建频道没有配置服务器，请联系管理员", 409);
      const tk = await livekitToken(env, srv, wr.user, channelId);
      if (tk.error) return err(tk.error, 503);
      selfHosted = {
        url: (srv.tls ? "wss://" : "ws://") + srv.host + ":" + srv.port,
        token: tk.token,
        screenUrl: srv.screen_host || null
      };
    }
    return ok({
      channel: publicChannel(row, wr.user, st, rs),
      ticket: ticket,
      wsUrl: wsUrl(request, channelId, ticket),
      iceServers: ice.iceServers,
      settings: st,
      sfu: { configured: !!(sfu.appId && sfu.secret) },
      selfHosted: selfHosted,
      transport: selfHosted ? "livekit" : (sfu.appId && sfu.secret ? "cloudflare" : "mesh"),
      notice: selfHosted ? "" : (sfu.appId && sfu.secret ? "" :
        "尚未配置 Cloudflare Realtime SFU 凭据，当前使用本地直连降级模式；线上请在 Worker 配置密钥后启用 SFU")
    });
  }

  /* ── ICE / TURN 短期凭据 ───────────────────────────────────── */
  if (p === "/api/voice/rtc/ice" && m === "GET") {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    return ok(await iceServers(env));
  }

  /* ── 创建 SFU session（密钥只在 Worker） ───────────────────── */
  if (p === "/api/voice/rtc/session" && m === "POST") {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    if (!originOK(request)) return err("请求来源不合法", 403);
    if (!await L.rateAllow(env, "voice:rtc:" + wr.user.id, 60, 60000)) return err("操作太频繁", 429);
    const b = await readBody(request);
    const channelId = String(b && b.channelId || "");
    const row = await env.DB.prepare("SELECT * FROM channels WHERE id = ?").bind(channelId).first();
    if (!row) return err("频道不存在", 404);
    const cj = canJoin(row, wr.user);
    if (!cj.ok) return err(cj.error, 403);
    const r = await sfuCall(env, "/sessions/new", "POST");
    if (!r.configured) return err(r.error + "（Worker 需配置 REALTIME_SFU_APP_ID / REALTIME_SFU_APP_SECRET）", 503);
    if (!r.ok) return err("创建 SFU 会话失败（HTTP " + r.status + "）", 502);
    const sessionId = r.data && (r.data.sessionId || r.data.session_id || (r.data.session && r.data.session.sessionId));
    if (!sessionId) return err("SFU 未返回 sessionId", 502);
    await env.DB.prepare(
      "INSERT INTO voice_sfu_sessions (session_id,user_id,channel_id,kind,created_at) VALUES (?,?,?,?,?)"
    ).bind(sessionId, wr.user.id, channelId, String(b && b.kind || "publish"), Date.now()).run();
    return ok({ sessionId: sessionId, raw: r.data }, 201);
  }

  /* ── SFU tracks/new / renegotiate / close / inspect ─────────── */
  if (p === "/api/voice/rtc/tracks" && m === "POST") {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    if (!originOK(request)) return err("请求来源不合法", 403);
    const b = await readBody(request);
    const sid = String(b && b.sessionId || "");
    const op = String(b && b.op || "new");
    const rec = await env.DB.prepare("SELECT * FROM voice_sfu_sessions WHERE session_id = ?")
      .bind(sid).first();
    if (!rec || rec.user_id !== wr.user.id) return err("会话不存在或无权操作", 403);
    const payload = (b && b.payload && typeof b.payload === "object") ? b.payload : {};
    // 服务端兜住上限：订阅 / 发布条目里不允许塞别人的 sessionId 之外的字段
    let tail, method;
    if (op === "new") { tail = "/tracks/new"; method = "POST"; }
    else if (op === "renegotiate") { tail = "/renegotiate"; method = "PUT"; }
    else if (op === "close") { tail = "/tracks/close"; method = "PUT"; }
    else if (op === "update") { tail = "/tracks/update"; method = "PUT"; }
    else if (op === "inspect") { tail = ""; method = "GET"; }
    else return err("不支持的 SFU 操作");
    const r = await sfuCall(env, "/sessions/" + encodeURIComponent(sid) + tail, method,
      op === "inspect" ? undefined : payload);
    if (!r.configured) return err(r.error, 503);
    if (!r.ok) return err("SFU 操作失败（HTTP " + r.status + "）：" +
      JSON.stringify(r.data && (r.data.errorDescription || r.data.errorCode || r.data.error) || "").slice(0, 200), 502);
    return ok({ data: r.data });
  }

  /* ── 可选：LiveKit 自建频道令牌（由 Worker 签发） ──────────── */
  if (p === "/api/voice/rtc/livekit-token" && m === "POST") {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    const b = await readBody(request);
    const srv = await env.DB.prepare("SELECT * FROM self_hosted_servers WHERE id = ?")
      .bind(String(b && b.serverId || "")).first();
    if (!srv) return err("自建服务器配置不存在", 404);
    const tk = await livekitToken(env, srv, wr.user, String(b && b.channelId || ""));
    if (tk.error) return err(tk.error, 503);
    return ok({ token: tk.token, url: (srv.tls ? "wss://" : "ws://") + srv.host + ":" + srv.port });
  }

  /* ── 测试连接（服务端探测，混合内容先给中文指引） ─────────── */
  if (p === "/api/voice/servers/test" && m === "POST") {
    const wr = await requireUser(env, request);
    if (wr.error) return wr.error;
    const b = await readBody(request);
    const tls = b && b.tls !== false;
    const bad = checkHost(b && b.host, tls);
    if (bad) return ok({ reachable: false, latencyMs: null, message: bad });
    const host = String(b.host).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const port = Number(b.port) || 7880;
    const target = (tls ? "https://" : "http://") + host + ":" + port + "/";
    const t0 = Date.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(function () { ctl.abort(); }, 2600);
      const r = await fetch(target, { method: "GET", signal: ctl.signal, redirect: "manual" });
      clearTimeout(timer);
      return ok({ reachable: true, latencyMs: Date.now() - t0,
        message: "信令地址可达（HTTP " + r.status + "）。注意：这只能验证 HTTP 端口，UDP 媒体端口与证书仍需按部署文档检查。" });
    } catch (e) {
      return ok({ reachable: false, latencyMs: null,
        message: "无法连接 " + target + "：请确认服务已启动、端口已转发、域名证书有效。若用 Cloudflare Tunnel，请确认 Tunnel 的 ingress 指向本机 7880。" });
    }
  }

  /* ══ 管理接口 ══════════════════════════════════════════════ */

  if (p.indexOf("/api/voice/admin/") === 0) {
    const adm = await requireAdmin(env, request);
    if (adm.error) return adm.error;

    /* 频道列表（含私有频道与设置） */
    if (p === "/api/voice/admin/channels" && m === "GET") {
      const rows = await env.DB.prepare("SELECT * FROM channels ORDER BY ord, created_at").all();
      const out = [];
      for (const row of (rows.results || [])) {
        const st = await settingsFor(env, row.id);
        const rs = await roomState(env, row.id);
        const full = publicChannel(row, null, st, rs);
        full.server = null;
        if (row.server_id) {
          const s = await env.DB.prepare("SELECT id,name,host,port,tls,screen_host,status FROM self_hosted_servers WHERE id = ?")
            .bind(row.server_id).first();
          if (s) full.server = { id: s.id, name: s.name, host: s.host, port: s.port, tls: !!s.tls, status: s.status };
        }
        out.push(full);
      }
      return ok({ items: out });
    }

    /* 新建频道（管理员可建任意后端频道） */
    if (p === "/api/voice/admin/channels" && m === "POST") {
      const b = await readBody(request);
      return await createChannel(env, ctx, request, b, adm.actor, true);
    }

    /* 修改频道 / 音质 / 屏幕上限 -> revision + 实时下发 */
    const chMatch = p.match(/^\/api\/voice\/admin\/channels\/([^/]+)$/);
    if (chMatch && (m === "PATCH" || m === "DELETE")) {
      const id = decodeURIComponent(chMatch[1]);
      const row = await env.DB.prepare("SELECT * FROM channels WHERE id = ?").bind(id).first();
      if (!row) return err("频道不存在", 404);
      if (m === "DELETE") {
        // channel_settings 的主键是 channel_id（不是 id），写错会导致整条删除接口 500
        // 且残留孤儿配置；voice_sfu_sessions 一并清理，避免越权复用旧 sessionId。
        await env.DB.prepare("DELETE FROM channels WHERE id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM channel_settings WHERE channel_id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM voice_sfu_sessions WHERE channel_id = ?").bind(id).run();
        await roomCall(env, id, "/close", "POST", {});
        await audit(env, ctx, request, adm.actor, "channel.delete", id, {});
        return ok({});
      }
      const b = await readBody(request);
      if (!b) return err("请求内容无效");
      const sets = [], args = [];
      const strFields = { name: 24, descr: 120, icon: 40 };
      Object.keys(strFields).forEach(function (k) {
        if (b[k] !== undefined) { sets.push(k + " = ?"); args.push(L.clean(b[k], strFields[k])); }
      });
      if (b.backend !== undefined) {
        const backend = b.backend === "self_hosted" || b.backend === "self" ? "self_hosted" : "cloudflare";
        sets.push("backend = ?"); args.push(backend);
      }
      if (b.visibility !== undefined) {
        sets.push("visibility = ?"); args.push(b.visibility === "private" ? "private" : "public");
      }
      if (b.maxUsers !== undefined) { sets.push("max_users = ?"); args.push(Math.max(1, Math.min(200, Number(b.maxUsers) || 20))); }
      if (b.ord !== undefined) { sets.push("ord = ?"); args.push(Number(b.ord) || 0); }
      if (b.joinScope !== undefined) {
        sets.push("join_scope = ?"); args.push(b.joinScope === "roles" ? "roles" : "all");
      }
      if (b.joinRoles !== undefined) { sets.push("join_roles = ?"); args.push(JSON.stringify(Array.isArray(b.joinRoles) ? b.joinRoles : [])); }
      if (b.serverId !== undefined) { sets.push("server_id = ?"); args.push(b.serverId || null); }
      if (b.password !== undefined) {
        sets.push("password_hash = ?");
        args.push(b.password ? await C.sha256Hex("zfch|" + id + "|" + String(b.password)) : null);
      }
      sets.push("revision = revision + 1", "updated_at = ?"); args.push(Date.now());
      const sql = "UPDATE channels SET " + sets.join(", ") + " WHERE id = ?";
      args.push(id);
      await env.DB.prepare(sql).bind(...args).run();

      if (b.audio || b.screen) {
        const cur = await settingsFor(env, id);
        const audio = b.audio ? C.normalizeAudioSettings(Object.assign({}, cur.audio, b.audio)) : cur.audio;
        const screen = b.screen ? C.normalizeScreenSettings(Object.assign({}, cur.screen, b.screen)) : cur.screen;
        await env.DB.prepare(
          "INSERT INTO channel_settings (channel_id,audio_json,screen_json,updated_at) VALUES (?,?,?,?) " +
          "ON CONFLICT(channel_id) DO UPDATE SET audio_json = excluded.audio_json, " +
          "screen_json = excluded.screen_json, updated_at = excluded.updated_at"
        ).bind(id, JSON.stringify(audio), JSON.stringify(screen), Date.now()).run();
      }
      const st = await settingsFor(env, id);
      const fresh = await env.DB.prepare("SELECT revision FROM channels WHERE id = ?").bind(id).first();
      await roomCall(env, id, "/settings", "POST", {
        settings: st, revision: Number(fresh && fresh.revision) || 1
      });
      await audit(env, ctx, request, adm.actor, "channel.update", id,
        { audio: st.audio, screen: st.screen, fields: Object.keys(b) });
      return ok({ revision: Number(fresh && fresh.revision) || 1, settings: st });
    }

    /* 排序 */
    if (p === "/api/voice/admin/channels/reorder" && m === "POST") {
      const b = await readBody(request);
      if (!b || !Array.isArray(b.ids)) return err("请提交频道 id 列表");
      let i = 0;
      for (const id of b.ids.slice(0, 100)) {
        await env.DB.prepare("UPDATE channels SET ord = ? WHERE id = ?").bind(i++, String(id)).run();
      }
      await audit(env, ctx, request, adm.actor, "channel.reorder", "", { ids: b.ids });
      return ok({});
    }

    /* 自建服务器配置（可选高级模式，密钥只存 Worker secret 名） */
    if (p === "/api/voice/admin/servers" && m === "GET") {
      const rows = await env.DB.prepare(
        "SELECT id,name,host,port,tls,screen_host,secret_ref,status,created_by,created_at FROM self_hosted_servers ORDER BY created_at DESC"
      ).all();
      return ok({ items: rows.results || [] });
    }
    if (p === "/api/voice/admin/servers" && m === "POST") {
      const b = await readBody(request);
      const bad = checkHost(b && b.host, b && b.tls !== false);
      if (bad) return err(bad);
      const id = "srv-" + L.randomHex(8);
      await env.DB.prepare(
        "INSERT INTO self_hosted_servers (id,name,host,port,tls,screen_host,secret_ref,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).bind(id, L.clean(b.name, 40), String(b.host).trim().slice(0, 120),
        Number(b.port) || 7880, b.tls === false ? 0 : 1, b.screenHost || null,
        L.clean(b.secretRef || "LIVEKIT_API_SECRET", 60), "unknown", adm.actor, Date.now()).run();
      await audit(env, ctx, request, adm.actor, "server.create", id, { host: b.host, port: b.port });
      return ok({ id: id }, 201);
    }
    const srvMatch = p.match(/^\/api\/voice\/admin\/servers\/([^/]+)$/);
    if (srvMatch && m === "DELETE") {
      const id = decodeURIComponent(srvMatch[1]);
      await env.DB.prepare("UPDATE channels SET backend = 'cloudflare', server_id = NULL WHERE server_id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM self_hosted_servers WHERE id = ?").bind(id).run();
      await audit(env, ctx, request, adm.actor, "server.delete", id, {});
      return ok({});
    }

    /* 踢人 / 禁言：通过 DO 下发给在线客户端 */
    if ((p === "/api/voice/admin/kick" || p === "/api/voice/admin/mute") && m === "POST") {
      const b = await readBody(request);
      const channelId = String(b && b.channelId || "");
      const userId = String(b && b.userId || "");
      if (!channelId || !userId) return err("缺少频道或成员信息");
      const tail = p.endsWith("kick") ? "/kick" : "/mute";
      const r = await roomCall(env, channelId, tail, "POST", {
        userId: userId, reason: b.reason || "管理员将你移出了频道"
      });
      await audit(env, ctx, request, adm.actor, p.endsWith("kick") ? "kick" : "mute",
        userId, { channelId: channelId });
      if (r.unavailable) return err("房间状态服务未启用（请部署 Durable Object 迁移）", 503);
      return ok({ ok: !!r.ok });
    }

    /* 系统设置复用阶段 2 的实现，这里只扩展键 */
    return null;
  }

  return null;
}

/* ── 管理员建频道 ───────────────────────────────────────────── */
async function createChannel(env, ctx, request, b, actor, isAdmin) {
  if (!b) return err("请求内容无效");
  const nv = C.validateChannelName(b.name);
  if (!nv.ok) return err(nv.error);
  const backend = b.backend === "self_hosted" || b.backend === "self" ? "self_hosted" : "cloudflare";
  let serverId = b.serverId || null;
  if (backend === "self_hosted" && !serverId) {
    if (!b.host) return err("自建频道需要填写服务器地址，或选择一个已保存的服务器");
    const bad = checkHost(b.host, b.tls !== false);
    if (bad) return err(bad);
    serverId = "srv-" + L.randomHex(8);
    await env.DB.prepare(
      "INSERT INTO self_hosted_servers (id,name,host,port,tls,screen_host,secret_ref,status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(serverId, nv.value, String(b.host).trim().slice(0, 120),
      Number(b.port) || 7880, b.tls === false ? 0 : 1, b.screenHost || null,
      L.clean(b.secretRef || "LIVEKIT_API_SECRET", 60), "unknown", actor, Date.now()).run();
  }
  const id = "ch-" + L.randomHex(8);
  const now = Date.now();
  const visibility = b.visibility === "private" ? "private" : "public";
  const pwdHash = b.password ? await C.sha256Hex("zfch|" + id + "|" + String(b.password)) : null;
  await env.DB.prepare(
    "INSERT INTO channels (id,name,descr,icon,backend,server_id,visibility,password_hash,allowed_users,owner_id," +
    "ord,join_scope,join_roles,max_users,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(id, nv.value, L.clean(b.descr, 120), L.clean(b.icon, 40), backend, serverId,
    visibility, pwdHash, JSON.stringify(b.allowedUsers || []), b.ownerId || null,
    Number(b.ord) || 0, b.joinScope === "roles" ? "roles" : "all",
    JSON.stringify(b.joinRoles || []), Math.max(1, Math.min(200, Number(b.maxUsers) || 20)),
    1, now, now).run();
  const audio = C.normalizeAudioSettings(b.audio || {});
  const screen = C.normalizeScreenSettings(b.screen || {});
  await env.DB.prepare(
    "INSERT INTO channel_settings (channel_id,audio_json,screen_json,updated_at) VALUES (?,?,?,?)"
  ).bind(id, JSON.stringify(audio), JSON.stringify(screen), now).run();
  await audit(env, ctx, request, actor, "channel.create", id, { name: nv.value, backend: backend });
  return ok({ id: id, settings: { audio: audio, screen: screen } }, 201);
}

/* ── 频道列表（含在线成员） ─────────────────────────────────── */
async function listChannels(env, user) {
  let rows;
  try {
    rows = await env.DB.prepare(
      "SELECT * FROM channels WHERE visibility = 'public' OR owner_id = ? OR allowed_users LIKE ? " +
      (user.role === "admin" ? "OR 1 = 1 " : "") + "ORDER BY ord, created_at"
    ).bind(user.id, "%" + user.id + "%").all();
  } catch (_) {
    rows = await env.DB.prepare("SELECT * FROM channels ORDER BY ord, created_at").all();
  }
  const out = [];
  for (const row of (rows.results || [])) {
    if (!canSee(row, user)) continue;
    const st = await settingsFor(env, row.id);
    const rs = await roomState(env, row.id);
    out.push(publicChannel(row, user, st, rs));
  }
  return out;
}
