/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 纯逻辑层（无 D1 / KV / Request 依赖）
 *
 *  这一层只做「输入校验、密码、随机串、Cookie、验证码图片、颜色、
 *  房间票据签名、频道音质参数归一化」，因此可以在 Node 里直接 import
 *  做单元测试，也能被 tools/migrate/voice_init_admin.mjs 复用
 *  （保证管理员哈希与登录校验同构）。所有数据库操作都在 voice-auth.js /
 *  voice-realtime.js 里。
 *
 *  2026-11-14：参考 Wikimedia Commons 与公开资料里真实图片验证码的
 *  视觉特征（空心字符、贯穿干扰线、逐字旋转、波浪形变、网格底纹、
 *  多色墨迹），重做自制 SVG 验证码；答案仍只以哈希落库。
 * ══════════════════════════════════════════════════════════════ */

import * as L from "./lib.js";

/* ── 常量 ────────────────────────────────────────────────────── */
export const COOKIE_NAME = "zf_voice_sid";
/**
 * 只标记「这个浏览器可能还登录着」的可读 Cookie，值恒为 1，不含任何身份信息。
 * 前端靠它在 <head> 里同步判断要不要跳过登录页，避免每次都先闪一下登录表单。
 * 真正决定身份的仍然是 HttpOnly 的 COOKIE_NAME，两个 Cookie 同时下发/清除。
 */
export const HINT_COOKIE_NAME = "zf_voice_si";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;      // 旧版会话（升级前签发的纯 hex 令牌）
export const REMEMBER_TTL = 30 * 24 * 60 * 60 * 1000;    // 勾选「保持登录」：30 天
export const SHORT_TTL = 12 * 60 * 60 * 1000;            // 不勾选：会话级 Cookie，服务端兜底 12 小时
export const MAX_SESSION_LIFE = 90 * 24 * 60 * 60 * 1000;// 滑动续期的绝对上限，避免无限延期
export const RENEW_BELOW = 7 * 24 * 60 * 60 * 1000;      // 剩余寿命不足 7 天时才回写 Cookie
export const CAPTCHA_TTL = 2 * 60 * 1000;                 // 2 分钟
export const ROOM_TICKET_TTL = 5 * 60 * 1000;             // 房间票据 5 分钟
export const AVATAR_LIMIT = 2 * 1024 * 1024;              // 2 MB
export const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export const DEFAULT_SETTINGS = Object.freeze({
  registrationOpen: true,           // 是否开放注册
  captchaMode: "image",             // image | turnstile
  allowUserSelfHosted: false,       // 普通用户能否添加「自建 SFU」频道（可选高级模式）
  allowUserPrivateChannels: true,   // 普通用户能否添加私有频道（默认允许）
  maxPrivateChannelsPerUser: 10
});

/* ── 随机 / 哈希 ─────────────────────────────────────────────── */

export function randomHexString(bytes) {
  return L.randomHex(bytes);
}

/** SHA-256 十六进制。Workers 与 Node 都用 WebCrypto，行为一致。 */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return L.bytesToHex(new Uint8Array(buf));
}

/** 与 lib.js 的 PBKDF2-SHA512 完全同构， Workers 硬上限 100000 轮。 */
export async function hashPasswordRecord(password, saltHex, iterations) {
  return await L.hashPassword(password, saltHex, iterations || L.PBKDF2_DEFAULT_ITERATIONS);
}

export async function verifyPasswordRecord(password, rec) {
  return await L.verifyPassword(password, rec);
}

function toB64Url(bytes) {
  let s = "";
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64Url(s) {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 房间签名密钥：必须用 wrangler secret put VOICE_ROOM_SECRET 配置。 */
export function roomSecret(env) {
  return (env && (env.VOICE_ROOM_SECRET || env.VOICE_CAPTCHA_SECRET)) ||
    "zf-voice-dev-only-room-secret";
}

async function hmacKey(env) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(roomSecret(env)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * 签发短期房间票据（WebSocket 建连时由 Durable Object 校验）。
 * 票据里只放必要的身份信息，不放任何媒体密钥。
 */
export async function signRoomTicket(env, payload) {
  const body = Object.assign({}, payload, {
    exp: Date.now() + ROOM_TICKET_TTL,
    nonce: L.randomHex(8)   // 注意：不要占用 n（显示名）字段
  });
  const text = toB64Url(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env),
    new TextEncoder().encode(text));
  return text + "." + toB64Url(sig);
}

export async function verifyRoomTicket(env, ticket, channelId) {
  try {
    const parts = String(ticket || "").split(".");
    if (parts.length !== 2) return null;
    const okSig = await crypto.subtle.verify("HMAC", await hmacKey(env),
      fromB64Url(parts[1]), new TextEncoder().encode(parts[0]));
    if (!okSig) return null;
    const body = JSON.parse(new TextDecoder().decode(fromB64Url(parts[0])));
    if (!body || !body.u || !body.c || !Number.isFinite(body.exp)) return null;
    if (body.exp < Date.now()) return null;
    if (channelId && body.c !== channelId) return null;
    return body;
  } catch (_) { return null; }
}

/* ── 输入校验 ────────────────────────────────────────────────── */

export function validateUsername(raw) {
  const v = String(raw == null ? "" : raw).trim().toLowerCase();
  if (!v) return { ok: false, error: "请填写用户名" };
  if (!USERNAME_RE.test(v)) return { ok: false, error: "用户名只能是 3~20 位小写字母、数字或下划线" };
  return { ok: true, value: v };
}

export function validateDisplayName(raw) {
  const v = L.clean(raw, 24);
  if (!v) return { ok: false, error: "请填写显示名称" };
  if (v.length > 24) return { ok: false, error: "显示名称不能超过 24 个字符" };
  // 显示名是纯文本，服务端不做 HTML 转义（避免二次转义），
  // 但禁止尖括号，从源头减少「误当 HTML 渲染」的风险；前端仍一律 esc()。
  if (/[<>]/.test(v)) return { ok: false, error: "显示名称不能包含 < 或 >" };
  return { ok: true, value: v };
}

const WEAK_PASSWORDS = [
  "1234567890", "12345678901", "password123", "admin12345",
  "qwerty1234", "1111111111", "0000000000", "abcdefghij"
];

export function validatePassword(raw) {
  const v = String(raw == null ? "" : raw);
  if (v.length < 10 || v.length > 128) {
    return { ok: false, error: "密码长度需为 10~128 位" };
  }
  if (!/[a-zA-Z]/.test(v) || !/[0-9]/.test(v)) {
    return { ok: false, error: "密码需同时包含字母和数字" };
  }
  if (/\s/.test(v)) return { ok: false, error: "密码不能包含空格" };
  if (WEAK_PASSWORDS.indexOf(v.toLowerCase()) >= 0) {
    return { ok: false, error: "这个密码太常见了，换一个吧" };
  }
  return { ok: true, value: v };
}

export function validateChannelName(raw) {
  const v = L.clean(raw, 24);
  if (!v) return { ok: false, error: "请填写频道名称" };
  if (/[<>]/.test(v)) return { ok: false, error: "频道名称不能包含 < 或 >" };
  return { ok: true, value: v };
}

/* ── 频道音质 / 屏幕共享上限 ─────────────────────────────────── */

export const AUDIO_PRESETS = Object.freeze({
  low:      Object.freeze({ preset: "low",      bitrateKbps: 24, sampleRate: 48000, channels: 1, dtx: true,  fec: true,  frameMs: 20 }),
  standard: Object.freeze({ preset: "standard", bitrateKbps: 48, sampleRate: 48000, channels: 1, dtx: true,  fec: true,  frameMs: 20 }),
  high:     Object.freeze({ preset: "high",     bitrateKbps: 96, sampleRate: 48000, channels: 2, dtx: false, fec: true,  frameMs: 20 }),
  custom:   Object.freeze({ preset: "custom",   bitrateKbps: 64, sampleRate: 48000, channels: 1, dtx: true,  fec: true,  frameMs: 20 })
});

export const DEFAULT_SCREEN = Object.freeze({
  enabled: true, maxWidth: 1920, maxHeight: 1080,
  maxFps: 30, maxBitrateKbps: 4000, maxSharers: 2
});

function intClamp(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 所有来自后台的值都在这里夹到合法区间，前端拿到的永远是可直接使用的数字。 */
export function normalizeAudioSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const name = Object.prototype.hasOwnProperty.call(AUDIO_PRESETS, r.preset) ? r.preset : "standard";
  const base = AUDIO_PRESETS[name];
  return {
    preset: name,
    bitrateKbps: intClamp(r.bitrateKbps, 16, 128, base.bitrateKbps),
    sampleRate: [16000, 24000, 48000].indexOf(Number(r.sampleRate)) >= 0 ? Number(r.sampleRate) : 48000,
    channels: Number(r.channels) === 2 ? 2 : 1,
    dtx: r.dtx === undefined ? base.dtx : !!r.dtx,
    fec: r.fec === undefined ? base.fec : !!r.fec,
    frameMs: [10, 20, 40, 60].indexOf(Number(r.frameMs)) >= 0 ? Number(r.frameMs) : 20
  };
}

export function normalizeScreenSettings(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: r.enabled === undefined ? true : !!r.enabled,
    maxWidth: intClamp(r.maxWidth, 640, 3840, DEFAULT_SCREEN.maxWidth),
    maxHeight: intClamp(r.maxHeight, 360, 2160, DEFAULT_SCREEN.maxHeight),
    maxFps: intClamp(r.maxFps, 5, 60, DEFAULT_SCREEN.maxFps),
    maxBitrateKbps: intClamp(r.maxBitrateKbps, 500, 12000, DEFAULT_SCREEN.maxBitrateKbps),
    maxSharers: intClamp(r.maxSharers, 1, 4, DEFAULT_SCREEN.maxSharers)
  };
}

/** 把用户选的共享参数压到频道上限内，返回实际生效值。 */
export function clampShareRequest(req, limits) {
  const s = normalizeScreenSettings(limits);
  const presets = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
  const p = presets[Number(req && req.res)] || presets[720];
  return {
    width: Math.min(p[0], s.maxWidth),
    height: Math.min(p[1], s.maxHeight),
    fps: Math.min(intClamp(req && req.fps, 5, 60, 30), s.maxFps),
    bitrateKbps: Math.min(intClamp(req && req.bitrateKbps, 0, 12000, 0) || s.maxBitrateKbps, s.maxBitrateKbps),
    contentHint: req && req.contentHint === "motion" ? "motion" : "detail",
    audio: !!(req && req.audio)
  };
}

/* ── 邀请码 ──────────────────────────────────────────────────── */

// 去掉了容易看错的 I / O / 0 / 1
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 生成 12 位随机码，按 XXXX-XXXX-XXXX 分组方便口述与复制。 */
export function generateInviteCode() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return s.slice(0, 4) + "-" + s.slice(4, 8) + "-" + s.slice(8, 12);
}

/** 用户输入容错：忽略大小写、连字符与空格。 */
export function normalizeInvite(raw) {
  return String(raw == null ? "" : raw).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function maskInvite(code) {
  const s = normalizeInvite(code);
  if (s.length < 8) return "••••••••";
  return s.slice(0, 4) + "••••" + s.slice(-2);
}

export async function inviteHash(raw) {
  return await sha256Hex("zfv1|invite|" + normalizeInvite(raw));
}

/* ── 验证码 ──────────────────────────────────────────────────── */

/** 答案哈希绑定 id + 站点密钥，数据库泄露也无法反推答案。 */
export async function captchaHash(id, answer, secret) {
  return await sha256Hex("zfv1|captcha|" + id + "|" + String(answer || "") + "|" + String(secret || ""));
}

// 5×7 点阵数字。用点阵而不是 <text>：SVG 源码里不含明文答案，
// 直接查看图片源码无法绕过验证，也比纯文本更难被简单 OCR 命中。
const DIGIT_5X7 = [
  ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], // 0
  ["00100", "01100", "00100", "00100", "00100", "00100", "01110"], // 1
  ["01110", "10001", "00001", "00010", "00100", "01000", "11111"], // 2
  ["11111", "00010", "00100", "00010", "00001", "10001", "01110"], // 3
  ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], // 4
  ["11111", "10000", "11110", "00001", "00001", "10001", "01110"], // 5
  ["00110", "01000", "10000", "11110", "10001", "10001", "01110"], // 6
  ["11111", "00001", "00010", "00100", "01000", "01000", "01000"], // 7
  ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], // 8
  ["01110", "10001", "10001", "01111", "00001", "00010", "01100"]  // 9
];

const INK_COLORS = ["#ffffff", "#ff8ea0", "#ffd08a", "#9ce8bd", "#b9c6ff", "#e2b3ff"];

function rndInt(min, max) {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return min + (b[0] % (max - min + 1));
}

function pick(arr) { return arr[rndInt(0, arr.length - 1)]; }

/**
 * 生成 5 位数字验证码 SVG（220×70）。
 * 参考真实验证码图片的四个特征：
 *  ① 网格底纹 + 渐变背景；② 字符独立旋转/倾斜/错位、逐字变色；
 *  ③ 1~2 条贯穿整幅图的干扰线（模拟删除线）与波浪形变；
 *  ④ 部分字符用空心描边，配合噪点与轻模糊，抬高 OCR 分割成本。
 * 答案只用于查点阵，SVG 源码里没有任何可搜索的明文数字。
 */
function captchaSVG(answer) {
  const W = 220, H = 70;
  const seed = rndInt(1, 9999);
  const freq = (rndInt(28, 48) / 1000).toFixed(3);
  const scale = rndInt(3, 6);
  let g = "";

  // ① 背景：深色渐变 + 细网格（参考 phpBB / reCAPTCHA 早期样式）
  g += '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#201f2b"/><stop offset="0.55" stop-color="#171821"/>' +
    '<stop offset="1" stop-color="#262031"/></linearGradient></defs>';
  g += '<rect width="' + W + '" height="' + H + '" fill="url(#bg)"/>';
  for (let x = 0; x <= W; x += 22) {
    g += '<path d="M' + x + ' 0V' + H + '" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1"/>';
  }
  for (let y = 0; y <= H; y += 14) {
    g += '<path d="M0 ' + y + 'H' + W + '" stroke="#ffffff" stroke-opacity="0.045" stroke-width="1"/>';
  }
  // 低对比色块，破坏纯色阈值分割
  for (let i = 0; i < 5; i++) {
    g += '<ellipse cx="' + rndInt(0, W) + '" cy="' + rndInt(0, H) + '" rx="' + rndInt(18, 46) +
      '" ry="' + rndInt(8, 22) + '" fill="' + pick(["#ff2d4a", "#4d7cff", "#3ad29f", "#ffb648"]) +
      '" fill-opacity="0.07"/>';
  }

  // 短弧线干扰（在数字下层）
  for (let i = 0; i < 7; i++) {
    const x1 = rndInt(-10, W), y1 = rndInt(0, H), x2 = rndInt(-10, W), y2 = rndInt(0, H);
    g += '<path d="M' + x1 + ' ' + y1 + ' Q' + rndInt(0, W) + ' ' + rndInt(-10, H + 10) +
      ' ' + x2 + ' ' + y2 + '" fill="none" stroke="' + pick(INK_COLORS) +
      '" stroke-opacity="' + (rndInt(12, 30) / 100).toFixed(2) + '" stroke-width="' +
      (rndInt(8, 18) / 10).toFixed(1) + '"/>';
  }

  // ② 数字：每位独立旋转 / 位移 / 缩放 / 颜色，空心与实心交替
  const step = 41, startX = 9, startY = 12;
  for (let i = 0; i < answer.length; i++) {
    const d = DIGIT_5X7[Number(answer[i])];
    const rot = rndInt(-14, 14);
    const dy = rndInt(-3, 3);
    const sc = (rndInt(96, 112) / 100).toFixed(2);
    const color = pick(INK_COLORS);
    const hollow = rndInt(0, 3) === 0;
    let dots = "";
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 5; x++) {
        if (d[y][x] !== "1") continue;
        const jx = rndInt(-1, 1), jy = rndInt(-1, 1);
        dots += '<rect x="' + (x * 4.2 + jx) + '" y="' + (y * 4.2 + jy) +
          '" width="3.5" height="3.5" rx="0.9"' +
          (hollow ? ' fill="none" stroke="' + color + '" stroke-width="1.15"' : ' fill="' + color + '"') +
          "/>";
      }
    }
    g += '<g transform="translate(' + (startX + i * step) + ' ' + (startY + dy) +
      ') rotate(' + rot + ' 14 21) skewX(' + rndInt(-6, 6) + ') scale(' + sc + ')">' + dots + "</g>";
  }

  // ③ 贯穿干扰线（画在数字上层，模拟经典验证码的删除线）
  for (let i = 0; i < 2; i++) {
    const y = rndInt(18, H - 16);
    g += '<path d="M-5 ' + y + ' Q' + (W / 2) + ' ' + (y + rndInt(-12, 12)) + ' ' +
      (W + 5) + ' ' + (y + rndInt(-8, 8)) + '" fill="none" stroke="' + pick(INK_COLORS) +
      '" stroke-opacity="' + (rndInt(30, 55) / 100).toFixed(2) + '" stroke-width="' +
      (rndInt(9, 16) / 10).toFixed(1) + '"/>';
  }

  // ④ 噪点
  let noise = "";
  for (let i = 0; i < 95; i++) {
    noise += '<circle cx="' + rndInt(0, W) + '" cy="' + rndInt(0, H) + '" r="' +
      (rndInt(4, 14) / 10).toFixed(1) + '" fill="' + pick(["#ffffff", "#ff6b7f", "#6b6b7a", "#0b0b10"]) +
      '" fill-opacity="' + (rndInt(18, 58) / 100).toFixed(2) + '"/>';
  }

  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
    '" viewBox="0 0 ' + W + ' ' + H + '">' +
    '<defs><filter id="w" x="-12%" y="-12%" width="124%" height="124%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="' + freq +
    '" numOctaves="2" seed="' + seed + '" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="' + scale +
    '" xChannelSelector="R" yChannelSelector="G" result="d"/>' +
    '<feGaussianBlur in="d" stdDeviation="0.3"/></filter></defs>' +
    '<g filter="url(#w)">' + g + noise + "</g>" +
    '<rect x="0.5" y="0.5" width="' + (W - 1) + '" height="' + (H - 1) +
    '" fill="none" stroke="#30303f" stroke-width="1"/></svg>';
}

/** 返回挑战数据；answer 只用于生成哈希，绝不随响应下发。 */
export async function makeCaptcha(secret) {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  let answer = "";
  for (let i = 0; i < b.length; i++) answer += String(b[i] % 10);
  const id = L.randomHex(16);
  const exp = Date.now() + CAPTCHA_TTL;
  const svg = captchaSVG(answer);
  // SVG 全部是 ASCII，btoa 在 Workers 与 Node 里都可用
  const image = "data:image/svg+xml;base64," + btoa(svg);
  return {
    id, exp, image,
    answerHash: await captchaHash(id, answer, secret)
  };
}

/* ── 同站判断（Origin / CSRF 校验的统一口径）───────────────────
 *
 *  ⚠ 不能只做 host 全等比较。
 *
 *  本地 IIS 镜像从 https://zfsnnb.dpdns.org:8443 发起请求，经 ARR 反代后
 *  Worker 看到的 URL 是 https://www.zfsnnb.dpdns.org/api/voice/…，
 *  于是 Origin 的 host（带 :8443）和 request.url 的 host（www，无端口）
 *  永远不相等 —— 所有写接口（登录/注册/加入频道/发消息）直接 403，
 *  而读接口不校验 Origin，表现就是"页面能开、登不上"。
 *
 *  放行范围严格限定为「同一主域的 apex / www 互换」，且协议必须一致。
 *  第三方站点、同域的其它子域（evil.zfsnnb.dpdns.org）仍然被拒，
 *  CSRF 防护的语义没有放宽：同域不同端口并不构成"跨站"。
 *
 *  线上（直接访问 www）走第一分支，行为与之前完全一致。
 * ══════════════════════════════════════════════════════════════ */

export const SITE_APEX = "zfsnnb.dpdns.org";

function sameSiteHost(hostname) {
  return hostname === SITE_APEX || hostname === "www." + SITE_APEX;
}

export function originOK(request) {
  const o = request.headers.get("origin");
  if (!o) return true;   // 同源表单 / curl；SameSite=Lax 兜底
  try {
    const a = new URL(o);
    const b = new URL(request.url);
    if (a.host === b.host) return true;
    return a.protocol === b.protocol &&
      sameSiteHost(a.hostname) && sameSiteHost(b.hostname);
  } catch (_) { return false; }
}

/* ── Cookie ──────────────────────────────────────────────────── */

export function parseCookies(header) {
  const out = {};
  String(header || "").split(";").forEach(function (part) {
    const i = part.indexOf("=");
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) return;
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  });
  return out;
}

function secureFlag(request) {
  try { return new URL(request.url).protocol === "https:" ? "; Secure" : ""; }
  catch (_) { return "; Secure"; }
}

/** 令牌首字符标记会话类型，避免为了记一个布尔值去改线上 D1 表结构。
 *  r = 保持登录（30 天，可滑动续期）；s = 临时（关闭浏览器失效）；
 *  其余 = 升级前签发的纯 hex 令牌，按旧规则 7 天处理，保证老用户不掉线。
 * 首字符只是类型标签，随机部分仍有 32 字节熵，不影响令牌不可预测性。 */
export function sessionKind(token) {
  const c = String(token || "").charAt(0);
  if (c === "r") return "remember";
  if (c === "s") return "short";
  return "legacy";
}

export function sessionTTL(kind) {
  return kind === "remember" ? REMEMBER_TTL : kind === "short" ? SHORT_TTL : SESSION_TTL;
}

export function newSessionToken(remember) {
  return (remember === false ? "s" : "r") + L.randomHex(32);
}

/** ttlMs === 0 表示会话级 Cookie：不带 Max-Age，浏览器关闭即失效。 */
function cookieTail(request, ttlMs) {
  const age = ttlMs === 0 ? null : Math.floor((ttlMs || SESSION_TTL) / 1000);
  return "; Path=/; SameSite=Lax" + (age === null ? "" : "; Max-Age=" + age) + secureFlag(request);
}

/**
 * HttpOnly + SameSite=Lax + Secure（HTTPS 下）。
 * 本地 http://127.0.0.1 调试时不加 Secure，否则浏览器根本不会保存 Cookie。
 */
export function sessionCookie(request, token, ttlMs) {
  return COOKIE_NAME + "=" + encodeURIComponent(token) + "; HttpOnly" + cookieTail(request, ttlMs);
}

/** 前端可读的同生命周期标记；不是凭据，被伪造也不会让 /me 通过。 */
export function hintCookie(request, ttlMs) {
  return HINT_COOKIE_NAME + "=1" + cookieTail(request, ttlMs);
}

/** 一次登录/续期要下发的两个 Cookie，顺序固定：主 Cookie 在前，便于旧测试解析。 */
export function sessionCookies(request, token, ttlMs) {
  return [sessionCookie(request, token, ttlMs), hintCookie(request, ttlMs)];
}

export function clearSessionCookies(request) {
  const tail = "; Path=/; SameSite=Lax; Max-Age=0" + secureFlag(request);
  return [COOKIE_NAME + "=; HttpOnly" + tail, HINT_COOKIE_NAME + "=" + tail];
}

/** 兼容旧调用点：只要主 Cookie 的清除语句。 */
export function clearSessionCookie(request) {
  return clearSessionCookies(request)[0];
}

/* ── 默认头像 ────────────────────────────────────────────────── */

/** FNV-1a 同步哈希：只需稳定，不需要密码学强度。前后端同一算法。 */
function fnv1a(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = function (n) { return (n + h / 30) % 12; };
  const a = s * Math.min(l, 1 - l);
  const f = function (n) {
    return l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  };
  const hex = function (x) {
    return Math.round(255 * x).toString(16).padStart(2, "0");
  };
  return "#" + hex(f(0)) + hex(f(8)) + hex(f(4));
}

/** 用户名 → 稳定底色。深色底 + 白字，和站点深色主题一致。 */
export function avatarColorFor(username) {
  const h = fnv1a(String(username || "").toLowerCase());
  const hue = h % 360;
  const sat = 36 + (h >>> 9) % 18;      // 36~53
  const light = 28 + (h >>> 17) % 10;   // 28~37
  return hslToHex(hue, sat, light);
}

export function svgEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** 生成默认头像 SVG（圆形底 + 显示名首字）。 */
export function defaultAvatarSVG(displayName, color) {
  const ch = Array.from(String(displayName || "Z"))[0] || "Z";
  return '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">' +
    '<rect width="128" height="128" rx="64" fill="' + svgEscape(color) + '"/>' +
    '<text x="64" y="64" text-anchor="middle" dominant-baseline="central" ' +
    'font-family="system-ui, PingFang SC, Microsoft YaHei, sans-serif" ' +
    'font-size="58" font-weight="600" fill="#ffffff">' + svgEscape(ch) + "</text></svg>";
}

/* ── 对外用户对象 ────────────────────────────────────────────── */

/** 绝不要把 password_rec / token_hash 等字段返回前端。 */
export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role || "user",
    status: row.status || "active",
    avatarColor: row.avatar_color || avatarColorFor(row.username),
    avatarUrl: row.avatar_ref ? "/api/voice/avatars/" + encodeURIComponent(row.id) : null,
    createdAt: Number(row.created_at) || 0,
    lastLoginAt: row.last_login_at ? Number(row.last_login_at) : null
  };
}
