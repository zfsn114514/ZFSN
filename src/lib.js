/* ══════════════════════════════════════════════════════════════
   基础库：时间 / 字符串 / 响应 / 限流 / 密码 / 会话 / 归属地
   对应旧后端 server.js 里散落在各处的工具函数。
   ══════════════════════════════════════════════════════════════ */

/* ── 时间 ────────────────────────────────────────────────────── */

export function now() {
  return Date.now();
}

/** 格式化成 "YYYY-MM-DD HH:MM:SS"。
 *  Workers 跑在 UTC，而旧后端显示的是北京时间，
 *  不补偿 8 小时的话留言时间会整体早 8 小时。 */
export function stamp(ts, tzOffset) {
  const off = Number(tzOffset === undefined ? 8 : tzOffset);
  const d = new Date((ts || Date.now()) + off * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
    " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds())
  );
}

/* ── 字符串 ──────────────────────────────────────────────────── */

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

export function clean(v, max) {
  let s = String(v === null || v === undefined ? "" : v);
  s = s.replace(/\r\n?/g, "\n").replace(CTRL, "").trim();
  if (max && s.length > max) s = s.slice(0, max);
  return s;
}

/* ── 响应 ────────────────────────────────────────────────────── */

export function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      headers || {}
    )
  });
}

export function ok(data, status) {
  return json(Object.assign({ ok: true }, data || {}), status || 200);
}

export function fail(msg, status) {
  return json({ ok: false, error: msg }, status || 400);
}

/** 读 JSON 请求体。超限直接抛，交给调用方转 413。 */
export async function readJSON(request, limit) {
  const len = Number(request.headers.get("content-length") || 0);
  if (limit && len > limit) {
    const e = new Error("payload too large");
    e.tooBig = true;
    throw e;
  }
  try {
    return await request.json();
  } catch (_) {
    const e = new Error("bad json");
    throw e;
  }
}

/* ── 随机 / 十六进制 ─────────────────────────────────────────── */

export function randomHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function hexToBytes(hex) {
  const s = String(hex || "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, "0");
  return s;
}

/* ── 客户端 IP ───────────────────────────────────────────────── */

/** Cloudflare 在边缘写入的 cf-connecting-ip 是可信的，
 *  不像 X-Forwarded-For 那样能被客户端伪造。 */
export function clientIP(request) {
  return (request.headers.get("cf-connecting-ip") || "").trim();
}

export function isPrivateIP(ip) {
  if (!ip) return true;
  if (ip === "::1" || ip === "::" ) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 || a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/* ── 限流 ──────────────────────────────────────────────────────
 *  Workers 没有跨请求共享内存，旧后端那个内存 Map 用不了，
 *  改成在 D1 里记时间戳：窗口内计数达到上限就拒绝。
 *  ──────────────────────────────────────────────────────────── */

export async function rateAllow(env, key, limit, windowMs) {
  const ts = now();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM rate WHERE k = ? AND ts > ?"
  ).bind(key, ts - windowMs).first();
  if ((row && row.c ? row.c : 0) >= limit) return false;
  await env.DB.prepare("INSERT INTO rate (k, ts) VALUES (?, ?)").bind(key, ts).run();
  return true;
}

/** 清掉一小时前的计数行，避免表无限增长。用 waitUntil 异步跑，不挡响应。 */
export async function rateClean(env) {
  await env.DB.prepare("DELETE FROM rate WHERE ts < ?").bind(now() - 3600 * 1000).run();
}

/* ── 密码 ──────────────────────────────────────────────────────
 *  与旧后端完全同构：PBKDF2-HMAC-SHA512，salt 16 字节 hex，
 *  输出 64 字节 hex。所以 data/config.json 里的哈希可以原样搬过来，
 *  老密码不用重置。
 *
 *  ⚠ CPU 提示：免费版 Worker 单请求 CPU 上限 10ms，120000 轮
 *    PBKDF2 有可能打满。登录接口报超时的话，见 DEPLOY.md。
 *  ──────────────────────────────────────────────────────────── */

const enc = new TextEncoder();

/* ⚠ Workers 运行时对 PBKDF2 迭代数有**硬上限 100000**：
 *   超过就直接抛 "Pbkdf2 failed: iteration counts above 100000 are not supported"。
 *   这是 workerd 的保护机制（怕有人拿它做 DoS），不是套餐限制 ——
 *   升级付费版也不放宽。所以轮数只能 ≤ 100000。
 *
 *   好消息：PBKDF2 在原生加密层跑，不吃那 10ms CPU 配额，
 *   10 万轮实测约 75ms 但不会触发 CPU 超时。
 *
 *   从旧后端平移来的哈希是 **120000 轮**，在 Workers 上根本无法校验，
 *   必须用 `npm run password` 重设（轮数 ≤ 100000）。 */
export const PBKDF2_MAX_ITERATIONS = 100000;
export const PBKDF2_DEFAULT_ITERATIONS = 100000;

function clampIterations(n) {
  const v = Math.floor(Number(n) || PBKDF2_DEFAULT_ITERATIONS);
  if (v > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError(
      "PBKDF2 迭代数 " + v + " 超过 Workers 上限 " + PBKDF2_MAX_ITERATIONS +
      "，该哈希在 Workers 上无法校验，需重设密码"
    );
  }
  return Math.max(1, v);
}

export async function hashPassword(password, saltHex, iterations) {
  const salt = saltHex || randomHex(16);
  const iter = clampIterations(iterations);
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]
  );
  /* ⚠ salt 必须按 **UTF-8 字符串** 编码，不能 hexToBytes 解码成字节。
   *
   * 旧后端是 crypto.pbkdf2Sync(password, s, …)，Node 在 salt 传字符串时
   * 按 UTF-8 取字节 —— 也就是说这里参与运算的是 32 个 ASCII 字符，
   * 而不是它们表示的 16 个字节。
   *
   * 两边必须完全一致，否则 data/config.json 里现有的哈希会全部校验失败，
   * 迁移完管理员就登录不上了。这条注释别删，踩过。 */
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: iter, hash: "SHA-512" },
    key,
    512
  );
  // iter 存进记录里：以后调整轮数时，旧哈希仍能按它自己的轮数校验
  return { salt, hash: bytesToHex(new Uint8Array(bits)), iter };
}

/** 定长比较，避免用 === 提前退出造成的时间差侧信道。 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/**
 * 校验密码。
 * rec 里存了轮数就优先用它（这样调整默认轮数不会把旧密码全废掉）；
 * 没存轮数的是从 data/config.json 平移来的老记录，用 fallback 兜底。
 * 超过 Workers 上限的哈希**无法校验**，这里抛错而不是返回 false ——
 * 否则用户只会看到"密码错误"，完全不知道要重设密码。
 */
export async function verifyPassword(password, rec, iterations) {
  if (!rec || !rec.salt || !rec.hash) return false;
  const iter = Number(rec.iter) || Number(iterations) || PBKDF2_DEFAULT_ITERATIONS;
  if (iter > PBKDF2_MAX_ITERATIONS) {
    throw new RangeError(
      "已存密码哈希是 " + iter + " 轮，超过 Workers 上限 " +
      PBKDF2_MAX_ITERATIONS + " 轮，无法校验。请用 npm run password 重设密码"
    );
  }
  const { hash } = await hashPassword(password, rec.salt, iter);
  return safeEqual(hash, rec.hash);
}

/* ── 配置（密码哈希） ────────────────────────────────────────── */

export async function getPasswordRecord(env) {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'password'").first();
  if (!row) return null;
  try { return JSON.parse(row.v); } catch (_) { return null; }
}

export async function setPasswordRecord(env, rec) {
  await env.DB.prepare(
    "INSERT INTO config (k, v) VALUES ('password', ?) " +
    "ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  ).bind(JSON.stringify(rec)).run();
}

/* ── 管理员会话 ──────────────────────────────────────────────── */

export const TOKEN_TTL = 12 * 60 * 60 * 1000;

export async function issueToken(env, ip, ua, tzOffset) {
  const token = randomHex(32);
  const exp = now() + TOKEN_TTL;
  await env.DB.prepare(
    "INSERT INTO sessions (token, ip, ua, exp, at) VALUES (?, ?, ?, ?, ?)"
  ).bind(token, ip || "", clean(ua, 120), exp, stamp(now(), tzOffset)).run();
  return { token, expiresIn: TOKEN_TTL };
}

export async function checkToken(env, token) {
  if (!token) return false;
  const row = await env.DB.prepare("SELECT exp FROM sessions WHERE token = ?").bind(token).first();
  if (!row) return false;
  if (Number(row.exp) < now()) {
    await revokeToken(env, token);
    return false;
  }
  return true;
}

export async function revokeToken(env, token) {
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

/** 改密码后要强制所有设备下线 —— 直接清空会话表。 */
export async function revokeAllTokens(env) {
  await env.DB.prepare("DELETE FROM sessions").run();
}

export function adminTokenOf(request) {
  return request.headers.get("x-admin-token") || "";
}

/* ── 归属地 ────────────────────────────────────────────────────
 *  旧后端是拿 IP 去问 ip-api.com / ipwho.is， Workers 上这招有两个坑：
 *  出口 IP 是 Cloudflare 数据中心的，多家站点共享，很容易撞上
 *  ip-api 的 45 次/分钟限流；而且每次留言都多一次外部往返。
 *
 *  Workers 自带 request.cf（country / region / city / colo …），
 *  由边缘直接注入，零延迟、零依赖、无限流，所以默认改用它。
 *  ──────────────────────────────────────────────────────────── */

const COUNTRY_CN = {
  CN: "中国", HK: "中国香港", MO: "中国澳门", TW: "中国台湾",
  US: "美国", JP: "日本", KR: "韩国", GB: "英国", DE: "德国",
  FR: "法国", CA: "加拿大", AU: "澳大利亚", NZ: "新西兰",
  SG: "新加坡", MY: "马来西亚", TH: "泰国", VN: "越南", ID: "印度尼西亚",
  IN: "印度", RU: "俄罗斯", BR: "巴西", MX: "墨西哥", IT: "意大利",
  ES: "西班牙", NL: "荷兰", SE: "瑞典", NO: "挪威", CH: "瑞士",
  PL: "波兰", TR: "土耳其", AE: "阿联酋", SA: "沙特阿拉伯", ZA: "南非",
  PH: "菲律宾", PK: "巴基斯坦", UA: "乌克兰", AR: "阿根廷", CL: "智利",
  BE: "比利时", AT: "奥地利", DK: "丹麦", FI: "芬兰", IE: "爱尔兰",
  IL: "以色列", EG: "埃及", NG: "尼日利亚", KE: "肯尼亚", PT: "葡萄牙",
};

const EMPTY_GEO = { region: "", country: "", province: "", city: "", isp: "" };

export async function lookupGeo(request, env) {
  const ip = clientIP(request);

  if (isPrivateIP(ip)) {
    return Object.assign({}, EMPTY_GEO, {
      ok: true, ip, local: true, region: "本地网络", source: "local"
    });
  }

  const cf = request.cf || {};
  const cc = String(cf.country || "");
  const country = COUNTRY_CN[cc] || cc || "";
  const province = String(cf.region || "");
  const city = String(cf.city || "");

  // 显示策略沿用旧后端：中国显示「省 · 市」，其他国家只显示国家
  const region = cc === "CN"
    ? ([province, city].filter(Boolean).join(" · ") || "中国")
    : (country || "未知");

  const base = {
    ok: true, ip, region, country, province, city, isp: "", source: "cf"
  };

  // 可选回落：cf 拿不到国家、且显式配置了 ipapi 时，才去问外部接口
  if (!cc && env.GEO_SOURCE === "ipapi") {
    try {
      const r = await fetch(
        "http://ip-api.com/json/" + encodeURIComponent(ip) +
        "?lang=zh-CN&fields=status,country,regionName,city,isp,query",
        { cf: { cacheTtl: 3600 } }
      );
      const d = await r.json();
      if (d && d.status === "success") {
        const cn = d.country === "中国";
        return Object.assign({}, base, {
          region: cn ? [d.regionName, d.city].filter(Boolean).join(" · ") : (d.country || "未知"),
          country: d.country || "",
          province: d.regionName || "",
          city: d.city || "",
          isp: d.isp || "",
          source: "ip-api"
        });
      }
    } catch (_) { /* 外部接口挂了就用 cf 的结果，不拖垮主流程 */ }
  }

  return base;
}

/** 只保留留言/评论里要落库的字段，避免把多余字段写进去 */
export function geoFields(geo) {
  return {
    region: geo.region, country: geo.country,
    province: geo.province, city: geo.city, isp: geo.isp
  };
}

/* ── 杂项 ────────────────────────────────────────────────────── */

export function humanSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  if (b < 1073741824) return (b / 1048576).toFixed(1) + " MB";
  return (b / 1073741824).toFixed(2) + " GB";
}
