/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 「保持登录」Cookie 回归测试
 *
 *  覆盖三件以前没测过的事：
 *   1) 登录可签发 30 天长效 Cookie（或关闭浏览器即失效的会话级 Cookie）；
 *   2) /me 与 /bootstrap 会滑动续期，但受 90 天绝对寿命上限约束；
 *   3) 一次响应里的两条 Set-Cookie 经过完整 Worker 包装层后仍然都在。
 *
 *  前半段用真实 SQLite + 直接调 handler（不 mock 数据层），
 *  后半段自起隔离的本地 Worker 运行时，走真实 HTTP 验证响应头，
 *  最后做前端静态断言（head 同步脚本 / CSS 规则 / 请求优化）。
 *
 *  运行：npm run voice:test:session
 * ══════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as C from "../../src/voice-core.js";
import { handleVoiceAPI } from "../../src/voice-auth.js";
import { handleVoiceRealtime } from "../../src/voice-realtime.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* ── 真实 SQLite + D1 适配器（与生产同构）────────────────────── */
const db = new DatabaseSync(":memory:");
db.exec(read("schema/0001_init.sql"));
db.exec(read("schema/0002_analytics.sql"));
db.exec(read("schema/0003_voice.sql"));

function toBind(v) {
  if (v === undefined) return null;
  if (v instanceof Uint8Array || ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  return String(v);
}
const DB = {
  prepare(sql) {
    const stmt = db.prepare(sql);
    function withArgs(args) {
      const b = args.map(toBind);
      return {
        async first() { const r = stmt.get(...b); return r === undefined ? null : r; },
        async all() { return { results: stmt.all(...b) }; },
        async run() { const r = stmt.run(...b); return { success: true, meta: { changes: Number(r.changes) || 0 } }; }
      };
    }
    return Object.assign(withArgs([]), { bind(...args) { return withArgs(args); } });
  }
};
const MEDIA = {
  async put() {}, async get() { return null; }, async delete() {}, async list() { return { keys: [] }; }
};
const env = {
  DB, MEDIA, TZ_OFFSET: "8",
  VOICE_CAPTCHA_SECRET: "session-test-secret",
  TURNSTILE_SITE_KEY: "", VOICE_TURNSTILE_SITE_KEY: ""
};
const CTX = {};   // 不带 waitUntil，审计同步写入便于断言

function call(handler, method, urlPath, body, headers) {
  const h = new Headers(Object.assign({ "content-type": "application/json" }, headers || {}));
  h.set("cf-connecting-ip", "203.0.113.9");
  const r = new Request("https://www.zfsnnb.dpdns.org" + urlPath, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body)
  });
  return handler(r, env, CTX, new URL(r.url));
}
const api = (m, p, b, h) => call(handleVoiceAPI, m, p, b, h);
const realtime = (m, p, b, h) => call(handleVoiceRealtime, m, p, b, h);

function setCookies(res) {
  // Node 22 的 undici 提供 getSetCookie；旧运行时退回单值头
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  return [res.headers.get("set-cookie") || ""].filter(Boolean);
}
function mainCookie(res) {
  const list = setCookies(res);
  const line = list.find(function (c) { return c.indexOf(C.COOKIE_NAME + "=") === 0; }) || "";
  return C.COOKIE_NAME + "=" + encodeURIComponent(
    C.parseCookies(line)[C.COOKIE_NAME] || line.split(";")[0].split("=").slice(1).join("="));
}

/* ── 固定测试用户 + 一次性验证码 ─────────────────────────────── */
const USER = "remember";
const PASSWORD = "ZfVoice2026";
let capSeq = 0;
db.prepare("INSERT INTO voice_users " +
  "(id,username,display_name,avatar_ref,avatar_color,password_rec,role,status,created_at,last_login_at) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run("u_remember", USER, "保持登录测试", null, "#7a1830",
    JSON.stringify(await C.hashPasswordRecord(PASSWORD)), "user", "active", Date.now(), null);

async function newCaptcha() {
  const id = "captest" + (++capSeq) + "0123456789ab";
  const hash = await C.captchaHash(id, "12345", env.VOICE_CAPTCHA_SECRET);
  db.prepare("INSERT INTO captcha_challenges (id,answer_hash,exp,consumed,ip,created_at) VALUES (?,?,?,0,?,?)")
    .run(id, hash, Date.now() + 120000, "", Date.now());
  return { captchaId: id, captcha: "12345" };
}

/** 登录并返回响应、两条 Set-Cookie、令牌与 DB 会话行。 */
async function login(extra) {
  db.exec("DELETE FROM rate");
  const res = await api("POST", "/api/voice/login",
    Object.assign({ username: USER, password: PASSWORD }, await newCaptcha(), extra || {}));
  const d = await res.json();
  assert.equal(d.ok, true, "登录失败：" + (d.error || JSON.stringify(d)));
  const list = setCookies(res);
  const token = C.parseCookies(list[0])[C.COOKIE_NAME];
  const row = db.prepare("SELECT * FROM voice_sessions WHERE token_hash = ?")
    .get(await C.sha256Hex(token));
  return { res, d, list, token, row, cookie: C.COOKIE_NAME + "=" + token };
}

/* ── 测试框架 ───────────────────────────────────────────────── */
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) { console.error("  ✘ " + name + "\n    " + (e && e.stack || e)); fail++; }
}
console.log("\nZF语音「保持登录」Cookie 回归测试\n");

/* ══ 1. 纯逻辑 ══════════════════════════════════════════════ */
await test("会话令牌按首字符分类，旧纯 hex 令牌回落 legacy", function () {
  assert.equal(C.sessionKind(C.newSessionToken(true)), "remember");
  assert.equal(C.sessionKind(C.newSessionToken(false)), "short");
  assert.equal(C.sessionKind("a1b2c3"), "legacy");
  assert.equal(C.sessionKind(""), "legacy");
  assert.equal(C.sessionTTL("remember"), 30 * 24 * 3600 * 1000);
  assert.equal(C.sessionTTL("short"), 12 * 3600 * 1000);
  assert.equal(C.sessionTTL("legacy"), 7 * 24 * 3600 * 1000);
  assert.equal(C.newSessionToken(true).length, 65);
});

await test("长效会话下发主 Cookie + 可读标记，属性各自正确", function () {
  const req = new Request("https://www.zfsnnb.dpdns.org/voice/");
  const list = C.sessionCookies(req, "r" + "a".repeat(64), C.REMEMBER_TTL);
  assert.equal(list.length, 2);
  assert.match(list[0], /^zf_voice_sid=r/);
  assert.match(list[0], /HttpOnly/);
  assert.match(list[0], /SameSite=Lax/);
  assert.match(list[0], /Secure/);
  assert.match(list[0], /Max-Age=2592000/);       // 30 天
  assert.match(list[1], /^zf_voice_si=1/);
  assert.doesNotMatch(list[1], /HttpOnly/, "hint Cookie 必须能被前端读到");
  assert.match(list[1], /SameSite=Lax/);
  assert.match(list[1], /Secure/);
  assert.match(list[1], /Max-Age=2592000/);
});

await test("不勾选保持登录时两个 Cookie 都是会话级（无 Max-Age）", function () {
  const req = new Request("https://www.zfsnnb.dpdns.org/voice/");
  const list = C.sessionCookies(req, "s" + "b".repeat(64), 0);
  assert.equal(list.length, 2);
  list.forEach(function (c) { assert.doesNotMatch(c, /Max-Age/); });
  const local = C.sessionCookies(new Request("http://127.0.0.1:8790/voice/"), "s" + "b".repeat(64), 0);
  local.forEach(function (c) { assert.doesNotMatch(c, /Secure/, "本地 http 不能加 Secure"); });
});

await test("登出成对清除两个 Cookie", function () {
  const req = new Request("https://www.zfsnnb.dpdns.org/voice/");
  const list = C.clearSessionCookies(req);
  assert.equal(list.length, 2);
  assert.match(list[0], /^zf_voice_sid=;/);
  assert.match(list[0], /HttpOnly/);
  assert.match(list[1], /^zf_voice_si=;/);
  list.forEach(function (c) { assert.match(c, /Max-Age=0/); });
  assert.match(C.clearSessionCookie(req), /^zf_voice_sid=;/, "旧单点调用仍兼容");
});

/* ══ 2. 登录 / 注册 ═════════════════════════════════════════ */
await test("登录默认保持登录 30 天，DB 到期时间与 Cookie 一致", async function () {
  const s = await login();
  assert.equal(s.list.length, 2, "应下发两条独立的 Set-Cookie");
  assert.equal(s.d.session.remember, true);
  assert.match(s.list[0], /Max-Age=2592000/);
  assert.match(s.list[1], /Max-Age=2592000/);
  assert.ok(s.row, "会话没有落库");
  assert.ok(Math.abs(s.row.exp - Date.now() - C.REMEMBER_TTL) < 3000,
    "DB exp 应为 now+30d，实际差值：" + (s.row.exp - Date.now() - C.REMEMBER_TTL));
});

await test("remember:false 只给会话级 Cookie，服务端兜底 12 小时", async function () {
  const s = await login({ remember: false });
  assert.equal(s.d.session.remember, false);
  s.list.forEach(function (c) { assert.doesNotMatch(c, /Max-Age/); });
  assert.ok(Math.abs(s.row.exp - Date.now() - C.SHORT_TTL) < 3000);
  const me = await (await api("GET", "/api/voice/me", undefined, { cookie: s.cookie })).json();
  assert.equal(me.user.username, USER, "会话级 Cookie 仍应能正常识别身份");
  assert.equal(me.session.remember, false);
});

await test("注册同样尊重 remember:false", async function () {
  db.exec("DELETE FROM rate");
  const inv = "REMEMBER-INV-2026";
  db.prepare("INSERT INTO invite_codes " +
    "(id,code_hash,code_mask,note,expires_at,max_uses,use_count,created_by,created_at,deleted_at) " +
    "VALUES (?,?,?,?,?,?,0,?,?,?)")
    .run("inv_remember", await C.inviteHash(inv), C.maskInvite(inv), "session test",
      null, null, "test", Date.now(), null);
  const res = await api("POST", "/api/voice/register", Object.assign({
    invite: inv, username: "regremember", displayName: "注册测试",
    password: PASSWORD, password2: PASSWORD, remember: false
  }, await newCaptcha()));
  const d = await res.json();
  assert.equal(d.ok, true, d.error);
  assert.equal(d.session.remember, false);
  setCookies(res).forEach(function (c) { assert.doesNotMatch(c, /Max-Age/); });
});

await test("两条 Set-Cookie 在响应头里各自独立、顺序稳定", async function () {
  const s = await login();
  assert.equal(s.list.length, 2);
  assert.ok(s.list[0].indexOf(C.COOKIE_NAME + "=") === 0, "主 Cookie 必须在前，便于旧客户端解析");
  assert.ok(s.list[1].indexOf(C.HINT_COOKIE_NAME + "=") === 0);
  // 合并且只保留一条的话，浏览器会忽略掉 hint，自动登录就失效了
  assert.ok(s.res.headers.get("set-cookie").indexOf(C.HINT_COOKIE_NAME) >= 0);
});

/* ══ 3. 滑动续期 ════════════════════════════════════════════ */
await test("刚登录的会话不会反复续期、不产生多余响应头", async function () {
  const s = await login();
  const res = await api("GET", "/api/voice/me", undefined, { cookie: s.cookie });
  const d = await res.json();
  assert.equal(d.user.username, USER);
  assert.equal(d.session.renewed, false);
  assert.equal(setCookies(res).length, 0, "剩余寿命充足时不应回写 Cookie");
});

await test("剩余寿命不足 7 天时 /me 自动续回 30 天并回写两个 Cookie", async function () {
  const s = await login();
  const th = await C.sha256Hex(s.token);
  db.prepare("UPDATE voice_sessions SET exp = ? WHERE token_hash = ?")
    .run(Date.now() + 24 * 3600 * 1000, th);
  const res = await api("GET", "/api/voice/me", undefined, { cookie: s.cookie });
  const d = await res.json();
  assert.equal(d.session.renewed, true);
  assert.ok(Math.abs(d.session.expiresAt - Date.now() - C.REMEMBER_TTL) < 3000);
  assert.equal(setCookies(res).length, 2);
  setCookies(res).forEach(function (c) { assert.match(c, /Max-Age=2592000/); });
  const row = db.prepare("SELECT exp FROM voice_sessions WHERE token_hash = ?").get(th);
  assert.equal(row.exp, d.session.expiresAt, "DB 与响应里的到期时间应一致");
});

await test("续期沿用同一个令牌，不会把并发请求顶下线", async function () {
  const s = await login();
  db.prepare("UPDATE voice_sessions SET exp = ? WHERE token_hash = ?")
    .run(Date.now() + 3600 * 1000, await C.sha256Hex(s.token));
  const r = await api("GET", "/api/voice/me", undefined, { cookie: s.cookie });
  assert.equal(C.parseCookies(setCookies(r)[0])[C.COOKIE_NAME], s.token);
  const me2 = await (await api("GET", "/api/voice/me", undefined, { cookie: s.cookie })).json();
  assert.equal(me2.user.username, USER);
});

await test("签发满 90 天后不再续期，必须重新登录", async function () {
  const s = await login();
  const th = await C.sha256Hex(s.token);
  db.prepare("UPDATE voice_sessions SET exp = ?, created_at = ? WHERE token_hash = ?")
    .run(Date.now() + 24 * 3600 * 1000, Date.now() - 100 * 24 * 3600 * 1000, th);
  const res = await api("GET", "/api/voice/me", undefined, { cookie: s.cookie });
  const d = await res.json();
  assert.equal(d.user.username, USER, "未到期前仍可用");
  assert.equal(d.session.renewed, false);
  assert.equal(setCookies(res).length, 0);
});

await test("临时会话与升级前的老令牌都不被悄悄延长", async function () {
  const short = await login({ remember: false });
  const legacyToken = "a".repeat(64);
  db.prepare("INSERT INTO voice_sessions (token_hash,user_id,exp,ip,ua,created_at) VALUES (?,?,?,?,?,?)")
    .run(await C.sha256Hex(legacyToken), "u_remember", Date.now() + 3600 * 1000, "", "legacy", Date.now());
  const legacyCookie = C.COOKIE_NAME + "=" + legacyToken;
  for (const cookie of [short.cookie, legacyCookie]) {
    const res = await api("GET", "/api/voice/me", undefined, { cookie: cookie });
    const d = await res.json();
    assert.equal(d.user.username, USER);
    assert.equal(d.session.remember, false);
    assert.equal(d.session.renewed, false);
    assert.equal(setCookies(res).length, 0);
  }
});

await test("过期会话仍返回未登录，且不会回写 Cookie", async function () {
  const s = await login();
  db.prepare("UPDATE voice_sessions SET exp = ? WHERE token_hash = ?")
    .run(Date.now() - 1000, await C.sha256Hex(s.token));
  const res = await api("GET", "/api/voice/me", undefined, { cookie: s.cookie });
  const d = await res.json();
  assert.equal(d.user, null);
  assert.equal(setCookies(res).length, 0);
});

await test("/api/voice/bootstrap 也会顺手续期并回写 Cookie", async function () {
  const s = await login();
  db.prepare("UPDATE voice_sessions SET exp = ? WHERE token_hash = ?")
    .run(Date.now() + 24 * 3600 * 1000, await C.sha256Hex(s.token));
  const res = await realtime("GET", "/api/voice/bootstrap", undefined, { cookie: s.cookie });
  assert.ok(res, "bootstrap 未命中路由");
  const d = await res.json();
  assert.equal(d.ok, true, d.error);
  assert.equal(d.user.username, USER);
  assert.equal(d.session.renewed, true);
  assert.equal(setCookies(res).length, 2);
});

/* ══ 4. 登出 ════════════════════════════════════════════════ */
await test("登出同时清除主 Cookie 与标记，会话立即失效", async function () {
  const s = await login();
  const res = await api("POST", "/api/voice/logout", {}, { cookie: s.cookie });
  const list = setCookies(res);
  assert.equal(list.length, 2);
  list.forEach(function (c) { assert.match(c, /Max-Age=0/); });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM voice_sessions WHERE token_hash = ?")
    .get(await C.sha256Hex(s.token)).c, 0);
  const after = await (await api("GET", "/api/voice/me", undefined, { cookie: s.cookie })).json();
  assert.equal(after.user, null);
});

/* ══ 5. 前端静态断言 ═════════════════════════════════════════ */
await test("登录页 head 有同步预登录脚本，且带两个「保持登录」勾选", function () {
  const html = read("voice/index.html");
  assert.match(html, /<script>[\s\S]*zf_voice_si=1[\s\S]*<\/script>/);
  assert.match(html, /data-voice-authed/, "需要同步打标记，不能等 defer 脚本");
  assert.match(html, /id="restore-mask"/);
  assert.match(html, /id="login-remember"[^>]*checked/);
  assert.match(html, /id="reg-remember"[^>]*checked/);
  // 缓存版本号：每次改前端脚本都要同步提升，否则老用户仍跑缓存里的旧代码。
  assert.match(html, /auth\.js\?v=20261115i/, "脚本版本号要更新，否则用户仍用缓存旧版");
});

await test("CSS 里预登录视图规则与恢复遮罩齐全", function () {
  const css = read("voice/voice.css");
  assert.match(css, /html\[data-voice-authed="1"\] #auth-view/);
  assert.match(css, /html\[data-voice-authed="1"\] #app-view\[hidden\]/);
  assert.match(css, /html\[data-voice-authed="1"\] \.restore-mask/);
  assert.match(css, /\.restore-mask\{display:none/, "默认不能挡住登录页");
  assert.match(css, /\.auth-remember/);
});

await test("前端并行取 /config 与 /me，已登录时跳过验证码", function () {
  const auth = read("voice/auth.js");
  assert.match(auth, /request\("\/config"\)/);
  assert.match(auth, /request\("\/me"\)/);
  assert.match(auth, /rememberValue\("login"\)/);
  assert.match(auth, /rememberValue\("register"\)/);
  assert.match(auth, /hinted/);
  assert.match(auth, /session:\s*\{/);
  const app = read("voice/voice.js");
  assert.match(app, /VoiceAuth\.session\.hinted\(\)/);
  assert.match(app, /VoiceAuth\.session\.ready\(\)/);
  assert.match(app, /VoiceAuth\.session\.guest\(\)/);
  assert.match(app, /登录状态已过期/);
});

await test("Worker 包装层显式重放多条 Set-Cookie", function () {
  const src = read("src/index.js");
  assert.match(src, /getSetCookie/);
  assert.match(src, /headers\.delete\("Set-Cookie"\)/);
  assert.match(src, /headers\.append\("Set-Cookie", c\)/);
});

/* ══ 6. 真实 HTTP：完整 Worker 链路 ═══════════════════════════
   前面是直接调 handler，这里再起一个隔离的本地 Worker 运行时，
   确认登录响应穿过 src/index.js 的 CORS 包装层后，两条 Cookie 都还在。
   ──────────────────────────────────────────────────────────── */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zfvoice-session-"));
const PORT = 9400 + Math.floor(Math.random() * 200);
const BASE = "http://127.0.0.1:" + PORT;
const DB_FILE = path.join(TMP, "session.sqlite");
let serverOut = "";
const child = spawn(process.execPath, ["--no-warnings", "tools/dev/voice-dev-server.mjs"], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    PORT: String(PORT), VOICE_DEV_DB: DB_FILE,
    VOICE_DEV_MEDIA: path.join(TMP, "media"),
    VOICE_DEV_CRED: path.join(TMP, "cred.txt"),
    VOICE_DEV_ADMIN_PASSWORD: "SessionTest2026Pass",
    VOICE_CAPTCHA_SECRET: "session-test-secret"
  }),
  stdio: ["ignore", "pipe", "pipe"]
});
child.stdout.on("data", function (d) { serverOut += d.toString(); });
child.stderr.on("data", function (d) { serverOut += d.toString(); });

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + "/api/health", { signal: AbortSignal.timeout(600) });
      if (r.ok) return;
    } catch (_) {}
    await new Promise(function (r) { setTimeout(r, 120); });
  }
  throw new Error("本地 Worker 运行时启动超时：\n" + serverOut);
}

try {
  await waitReady();
  await test("真实 HTTP 登录：包装层后仍有两条 Set-Cookie，浏览器可自动登录", async function () {
    const live = new DatabaseSync(DB_FILE);
    const hashRec = JSON.stringify(await C.hashPasswordRecord(PASSWORD));
    live.prepare("INSERT OR REPLACE INTO voice_users " +
      "(id,username,display_name,avatar_ref,avatar_color,password_rec,role,status,created_at,last_login_at) " +
      "VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("u_http", "httpremember", "HTTP 测试", null, "#7a1830", hashRec,
        "user", "active", Date.now(), null);
    const capId = "httpcap0123456789ab";
    live.prepare("INSERT INTO captcha_challenges (id,answer_hash,exp,consumed,ip,created_at) VALUES (?,?,?,0,?,?)")
      // 本地运行时把验证码密钥固定为 zf-voice-dev-only（见 voice-dev-server.mjs）
      .run(capId, await C.captchaHash(capId, "12345", "zf-voice-dev-only"),
        Date.now() + 120000, "", Date.now());
    live.close();

    const res = await fetch(BASE + "/api/voice/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ username: "httpremember", password: PASSWORD,
        captchaId: capId, captcha: "12345", remember: true })
    });
    const d = await res.json();
    assert.equal(d.ok, true, "登录失败：" + JSON.stringify(d));
    const list = setCookies(res);
    assert.equal(list.length, 2, "包装层吞掉了 Set-Cookie：" + JSON.stringify(list));
    assert.match(list[0], /zf_voice_sid=/);
    assert.match(list[1], /zf_voice_si=1/);
    assert.match(list[0], /Max-Age=2592000/);

    const cookie = mainCookie({ headers: res.headers });
    const me = await (await fetch(BASE + "/api/voice/me", { headers: { cookie: cookie } })).json();
    assert.equal(me.user.username, "httpremember");
    assert.equal(me.session.remember, true);
  });
} catch (e) {
  console.error("  ✘ 本地 Worker 运行时：" + (e && e.stack || e));
  fail++;
} finally {
  child.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
if (fail) process.exit(1);
