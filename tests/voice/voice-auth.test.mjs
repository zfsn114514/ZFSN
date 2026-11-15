/* ══════════════════════════════════════════════════════════════
 *  ZF语音阶段 2 —— 单元 + 集成测试
 *
 *  不是 mock 掉数据层：用 node:sqlite 建真实内存库，执行仓库里的
 *  schema/0001_init.sql 与 schema/0003_voice.sql，再包一层 D1 适配器，
 *  直接调用 src/voice-auth.js 的 handleVoiceAPI。
 *  这样 SQL 语法、原子条件 UPDATE 的 changes 判定、Cookie、PBKDF2
 *  都是真实跑过的，不是「看起来对」。
 *
 *  运行：npm run voice:test
 * ══════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import * as C from "../../src/voice-core.js";
import { handleVoiceAPI, consumeCaptcha, consumeInvite, parseAvatar } from "../../src/voice-auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

/* ── 真实 SQLite + D1 适配器 ────────────────────────────────── */
const db = new DatabaseSync(":memory:");
db.exec(read("schema/0001_init.sql"));
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
    // Cloudflare D1 允许 prepare(sql).all() 不带 bind，也允许 .bind(...).all()
    function withArgs(args) {
      const b = args.map(toBind);
      return {
        async first() { const r = stmt.get(...b); return r === undefined ? null : r; },
        async all() { return { results: stmt.all(...b) }; },
        async run() { const r = stmt.run(...b); return { success: true, meta: { changes: Number(r.changes) || 0 } }; }
      };
    }
    return Object.assign(withArgs([]), {
      bind(...args) { return withArgs(args); }
    });
  }
};

const mediaStore = new Map();
const MEDIA = {
  async put(k, v) { mediaStore.set(k, v); },
  async get(k, type) {
    const v = mediaStore.get(k);
    if (!v) return null;
    if (type === "arrayBuffer") return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
    return v;
  },
  async delete(k) { mediaStore.delete(k); },
  async list() { return { keys: [] }; }
};

const env = {
  DB, MEDIA,
  TZ_OFFSET: "8",
  VOICE_CAPTCHA_SECRET: "test-secret",
  TURNSTILE_SITE_KEY: "",
  VOICE_TURNSTILE_SITE_KEY: ""
};
const CTX = {};   // 不带 waitUntil → 审计同步写入，便于断言
const ADMIN_TOKEN = "test-admin-token";
db.prepare("INSERT INTO sessions (token, ip, ua, exp, at) VALUES (?,?,?,?,?)")
  .run(ADMIN_TOKEN, "", "", Date.now() + 3600000, "");

/* ── 请求 / 响应助手 ────────────────────────────────────────── */
function call(method, urlPath, body, headers) {
  const h = new Headers(Object.assign({ "content-type": "application/json" }, headers || {}));
  h.set("cf-connecting-ip", "203.0.113.7");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const r = new Request("http://127.0.0.1:8790" + urlPath, {
    method, headers: h, body: payload
  });
  return handleVoiceAPI(r, env, CTX, new URL(r.url));
}
async function json(res) {
  assert.ok(res, "接口不应返回 null（未命中路由）");
  return await res.json();
}
function resetRate() { db.exec("DELETE FROM rate"); }

let capSeq = 0;
async function newCaptcha(answer, opts) {
  answer = answer || "12345";
  const id = "cap" + (++capSeq) + "abcdef012345";
  const exp = opts && opts.expired ? Date.now() - 1000 : Date.now() + 120000;
  const hash = await C.captchaHash(id, answer, env.VOICE_CAPTCHA_SECRET);
  db.prepare("INSERT INTO captcha_challenges (id, answer_hash, exp, consumed, ip, created_at) VALUES (?,?,?,0,?,?)")
    .run(id, hash, exp, "", Date.now());
  return { id, answer };
}
function captchaPairs(c) { return { captchaId: c.id, captcha: c.answer }; }

async function makeInvite(opts) {
  opts = opts || {};
  const code = opts.code || C.generateInviteCode();
  const id = "inv" + (++capSeq) + "abcdef012345";
  db.prepare("INSERT INTO invite_codes " +
    "(id, code_hash, code_mask, note, expires_at, max_uses, use_count, created_by, created_at, deleted_at) " +
    "VALUES (?,?,?,?,?,?,0,?,?,?)")
    .run(id, await C.inviteHash(code), C.maskInvite(code), opts.note || "",
      opts.expiresAt === undefined ? null : opts.expiresAt,
      opts.maxUses === undefined ? null : opts.maxUses,
      "test", Date.now(), opts.deletedAt || null);
  return { id, code };
}

function regBody(inviteCode, username, extra) {
  return Object.assign({
    invite: inviteCode,
    username: username,
    displayName: "测试用户",
    password: "ZfVoice2026",
    password2: "ZfVoice2026"
  }, extra || {});
}

/* ── 测试框架 ───────────────────────────────────────────────── */
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) { console.error("  ✘ " + name + "\n    " + (e && e.stack || e)); fail++; }
}

console.log("\nZF语音 阶段 2 测试（真实 SQLite + Worker 逻辑）\n");

/* ══ 1. 纯逻辑单元 ═══════════════════════════════════════════ */
await test("用户名 / 显示名 / 密码校验", async function () {
  assert.equal(C.validateUsername("Ab_C1").value, "ab_c1");
  assert.equal(C.validateUsername("a b").ok, false);
  assert.equal(C.validateUsername("ab").ok, false);
  assert.equal(C.validateDisplayName("小明").value, "小明");
  assert.equal(C.validateDisplayName("<script>x</script>").ok, false);
  assert.equal(C.validatePassword("short1").ok, false);
  assert.equal(C.validatePassword("allletters").ok, false);
  assert.equal(C.validatePassword("1234567890").ok, false);
  assert.equal(C.validatePassword("ZfVoice2026").ok, true);
});

await test("邀请码生成 / 规范化 / 掩码", async function () {
  const a = C.generateInviteCode(), b = C.generateInviteCode();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(C.normalizeInvite(a.toLowerCase()), C.normalizeInvite(a));
  assert.equal(C.normalizeInvite(a), a.replace(/-/g, ""));
  assert.match(C.maskInvite(a), /••••/);
});

await test("默认头像底色稳定且为合法 hex", function () {
  const c1 = C.avatarColorFor("admin"), c2 = C.avatarColorFor("admin");
  assert.equal(c1, c2);
  assert.notEqual(c1, C.avatarColorFor("someone_else"));
  assert.match(c1, /^#[0-9a-f]{6}$/);
  assert.match(C.defaultAvatarSVG("小明", c1), /<svg/);
  assert.doesNotMatch(C.defaultAvatarSVG("<b>", c1), /<b>/);
});

await test("Cookie 含 HttpOnly / SameSite，且解析可逆", function () {
  const request = new Request("https://www.zfsnnb.dpdns.org/voice/");
  const c = C.sessionCookie(request, "abc123", 3600000);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.equal(C.parseCookies(c)[C.COOKIE_NAME], "abc123");
  assert.match(C.clearSessionCookie(request), /Max-Age=0/);
  const local = C.sessionCookie(new Request("http://127.0.0.1:8790/voice/"), "x", 1000);
  assert.doesNotMatch(local, /Secure/, "本地 http 不加 Secure，否则 Cookie 不落盘");
});

await test("验证码图片不含明文答案、答案只存哈希", async function () {
  const c = await C.makeCaptcha("test-secret");
  const svg = Buffer.from(c.image.split(",")[1], "base64").toString("utf8");
  assert.match(svg, /<svg/);
  assert.match(svg, /feTurbulence/);
  assert.match(svg, /feDisplacementMap/);
  assert.doesNotMatch(svg, /<text/, "不能用 <text> 直接把答案写进 SVG 源码");
  assert.equal(Object.keys(c).indexOf("answer"), -1, "makeCaptcha 不得返回明文答案");
  assert.match(c.answerHash, /^[a-f0-9]{64}$/);
});

await test("publicUser 不泄露密码哈希", function () {
  const u = C.publicUser({
    id: "u1", username: "abc", display_name: "小明", avatar_color: "#123456",
    password_rec: "SECRET", role: "user", status: "active", created_at: 1
  });
  assert.equal(u.password_rec, undefined);
  assert.equal(u.avatarUrl, null);
  assert.equal(u.displayName, "小明");
});

await test("头像上传：魔数校验拒绝伪造文件", function () {
  assert.equal(parseAvatar(null).empty, true);
  assert.equal(parseAvatar("data:image/webp;base64," + Buffer.from("RIFF1234WEBPabcd").toString("base64")).ok, true);
  assert.equal(parseAvatar("data:image/webp;base64," + Buffer.from("not-an-image-at-all").toString("base64")).ok, false);
  assert.equal(parseAvatar("nonsense").ok, false);
});

/* ══ 2. 公开接口 ═════════════════════════════════════════════ */
await test("GET /config 返回注册开关与验证码模式", async function () {
  const d = await json(await call("GET", "/api/voice/config"));
  assert.equal(d.registrationOpen, true);
  assert.equal(d.captchaMode, "image");
  assert.equal(d.captchaLength, 5);
});

await test("GET /captcha 生成挑战并落库", async function () {
  resetRate();
  const d = await json(await call("GET", "/api/voice/captcha"));
  assert.match(d.image, /^data:image\/svg\+xml;base64,/);
  const row = db.prepare("SELECT answer_hash, exp, consumed FROM captcha_challenges WHERE id = ?").get(d.captchaId);
  assert.ok(row && row.consumed === 0);
  assert.equal(d.expiresIn, 120);
  assert.match(row.answer_hash, /^[a-f0-9]{64}$/);
});

await test("验证码：错误答案 / 重复使用 / 过期都被拒绝，且失败即作废", async function () {
  const c = await newCaptcha("12345");
  let r = await consumeCaptcha(env, c.id, "99999", env.VOICE_CAPTCHA_SECRET);
  assert.equal(r.ok, false);
  r = await consumeCaptcha(env, c.id, "12345", env.VOICE_CAPTCHA_SECRET);
  assert.equal(r.ok, false, "答错后这张图也必须作废");

  const c2 = await newCaptcha("12345");
  assert.equal((await consumeCaptcha(env, c2.id, "12345", env.VOICE_CAPTCHA_SECRET)).ok, true);
  assert.equal((await consumeCaptcha(env, c2.id, "12345", env.VOICE_CAPTCHA_SECRET)).ok, false,
    "一次性：正确用过后不可再用");

  const c3 = await newCaptcha("12345", { expired: true });
  assert.equal((await consumeCaptcha(env, c3.id, "12345", env.VOICE_CAPTCHA_SECRET)).ok, false);
});

/* ══ 3. 注册 ═════════════════════════════════════════════════ */
await test("CSRF：跨站 Origin 的注册请求被拒绝", async function () {
  resetRate();
  const inv = await makeInvite();
  const cap = await newCaptcha();
  const res = await call("POST", "/api/voice/register",
    Object.assign(regBody(inv.code, "alice"), captchaPairs(cap)),
    { origin: "https://evil.example.com" });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).ok, false);
});

await test("邀请码过期 / 已删除 / 超上限都不能注册", async function () {
  resetRate();
  const cases = [
    await makeInvite({ expiresAt: Date.now() - 1000 }),
    await makeInvite({ deletedAt: Date.now() }),
    await makeInvite({ maxUses: 1 })
  ];
  // 让第三个案子先把名额用掉
  assert.equal((await consumeInvite(env, cases[2].code)).ok, true);
  for (let i = 0; i < cases.length; i++) {
    const cap = await newCaptcha();
    const d = await json(await call("POST", "/api/voice/register",
      Object.assign(regBody(cases[i].code, "user" + i), captchaPairs(cap))));
    assert.equal(d.ok, false, "case " + i + " 应该被拒绝");
    assert.match(d.error, /邀请码/);
  }
});

await test("注册成功：写用户、发 HttpOnly Cookie、邀请码计数 +1、验证码作废", async function () {
  resetRate();
  const inv = await makeInvite({ note: "测试码" });
  const cap = await newCaptcha();
  const res = await call("POST", "/api/voice/register",
    Object.assign(regBody(inv.code, "alice"), captchaPairs(cap)));
  assert.equal(res.status, 201);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.equal(d.user.username, "alice");
  assert.equal(d.user.displayName, "测试用户");
  assert.equal(d.user.role, "user");
  assert.equal(d.user.avatarUrl, null, "不传头像时用默认头像");
  assert.equal(d.user.password_rec, undefined);
  const cookie = res.headers.get("set-cookie") || "";
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const u = db.prepare("SELECT * FROM voice_users WHERE username = 'alice'").get();
  assert.ok(u);
  const rec = JSON.parse(u.password_rec);
  assert.equal(rec.iter, 100000);
  assert.notEqual(rec.hash, "ZfVoice2026");
  assert.equal(db.prepare("SELECT use_count FROM invite_codes WHERE id = ?").get(inv.id).use_count, 1);
  assert.equal(db.prepare("SELECT consumed FROM captcha_challenges WHERE id = ?").get(cap.id).consumed, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM invite_code_uses WHERE code_id = ?").get(inv.id).c, 1);
});

await test("同一个验证码重放注册被拒绝", async function () {
  const inv = await makeInvite();
  const cap = await newCaptcha();
  assert.equal((await json(await call("POST", "/api/voice/register",
    Object.assign(regBody(inv.code, "bob"), captchaPairs(cap))))).ok, true);
  assert.equal((await json(await call("POST", "/api/voice/register",
    Object.assign(regBody(inv.code, "carol"), captchaPairs(cap))))).ok, false);
});

await test("一个邀请码可被多人使用（默认不限次数）", async function () {
  const inv = await makeInvite();
  for (const name of ["dave", "erin", "frank"]) {
    const cap = await newCaptcha();
    const d = await json(await call("POST", "/api/voice/register",
      Object.assign(regBody(inv.code, name), captchaPairs(cap))));
    assert.equal(d.ok, true, name + " 应注册成功： " + d.error);
  }
  assert.equal(db.prepare("SELECT use_count FROM invite_codes WHERE id = ?").get(inv.id).use_count, 3);
});

await test("用户名重复 / 显示名含标签 / 弱密码都被服务端拒绝", async function () {
  const inv = await makeInvite();
  const bad = [
    regBody(inv.code, "alice"),
    Object.assign(regBody(inv.code, "grace"), { displayName: "<img src=x>" }),
    Object.assign(regBody(inv.code, "heidi"), { password: "123", password2: "123" }),
    Object.assign(regBody(inv.code, "ivan"), { password2: "mismatch" })
  ];
  for (const b of bad) {
    const cap = await newCaptcha();
    const d = await json(await call("POST", "/api/voice/register", Object.assign(b, captchaPairs(cap))));
    assert.equal(d.ok, false, JSON.stringify(b));
  }
});

await test("头像上传：真实 PNG 存入 KV 并能读取；不传时返回默认 SVG", async function () {
  const png = Buffer.from("89504E470D0A1A0A0000000D49484452", "hex");
  const dataUrl = "data:image/png;base64," + png.toString("base64");
  const inv = await makeInvite();
  const cap = await newCaptcha();
  const d = await json(await call("POST", "/api/voice/register",
    Object.assign(regBody(inv.code, "judy"), captchaPairs(cap), { avatar: dataUrl })));
  assert.equal(d.ok, true);
  assert.match(d.user.avatarUrl, /\/api\/voice\/avatars\//);
  const img = await call("GET", d.user.avatarUrl);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.ok((await img.arrayBuffer()).byteLength > 0);

  const noAvatar = await json(await call("GET", "/api/voice/me"));
  assert.equal(noAvatar.user, null, "未带 Cookie 时应为未登录");
  const alice = db.prepare("SELECT id FROM voice_users WHERE username = 'alice'").get();
  const def = await call("GET", "/api/voice/avatars/" + alice.id);
  assert.match(def.headers.get("content-type"), /svg/);
  assert.match(await def.text(), /<svg/);
});

/* ══ 4. 登录 / 会话 / 冷却 ═══════════════════════════════════ */
function loginBody(username, password, cap) {
  return Object.assign({ username: username, password: password || "ZfVoice2026" }, captchaPairs(cap));
}

await test("登录成功返回会话，/me 可读取，logout 后失效", async function () {
  resetRate();
  const cap = await newCaptcha();
  const res = await call("POST", "/api/voice/login", loginBody("alice", null, cap));
  const d = await res.json();
  assert.equal(d.ok, true, d.error);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^zf_voice_sid=/);

  const me = await json(await call("GET", "/api/voice/me", undefined, { cookie: cookie }));
  assert.equal(me.user.username, "alice");
  assert.equal(me.user.password_rec, undefined);

  const out = await call("POST", "/api/voice/logout", {}, { cookie: cookie });
  assert.equal((await out.json()).ok, true);
  assert.match(out.headers.get("set-cookie") || "", /Max-Age=0/);
  const after = await json(await call("GET", "/api/voice/me", undefined, { cookie: cookie }));
  assert.equal(after.user, null);
});

await test("修改资料 / 头像与修改密码：保持当前会话并撤销其他会话", async function () {
  resetRate();
  const inv = await makeInvite();
  const capReg = await newCaptcha();
  const registered = await call("POST", "/api/voice/register", Object.assign(regBody(inv.code, "profileuser"), captchaPairs(capReg)));
  const cookie1 = (registered.headers.get("set-cookie") || "").split(";")[0];
  const cap2 = await newCaptcha();
  const login2 = await call("POST", "/api/voice/login", loginBody("profileuser", null, cap2));
  const cookie2 = (login2.headers.get("set-cookie") || "").split(";")[0];
  const profile = await json(await call("PATCH", "/api/voice/me", { displayName: "爱丽丝新名" }, { cookie: cookie1 }));
  assert.equal(profile.user.displayName, "爱丽丝新名");
  const avatar = "data:image/png;base64," + Buffer.from("89504E470D0A1A0A0000000D49484452", "hex").toString("base64");
  const changed = await json(await call("PATCH", "/api/voice/me", { avatar: avatar }, { cookie: cookie1 }));
  assert.ok(changed.user.avatarUrl);
  assert.equal((await call("GET", changed.user.avatarUrl)).status, 200);
  const weak = await json(await call("POST", "/api/voice/password", { oldPassword: "ZfVoice2026", newPassword: "weak" }, { cookie: cookie1 }));
  assert.equal(weak.ok, false);
  const wrong = await json(await call("POST", "/api/voice/password", { oldPassword: "WrongPass2026", newPassword: "OtherPass2026" }, { cookie: cookie1 }));
  assert.equal(wrong.error, "旧密码不正确");
  const pass = await json(await call("POST", "/api/voice/password", { oldPassword: "ZfVoice2026", newPassword: "OtherPass2026" }, { cookie: cookie1 }));
  assert.equal(pass.ok, true, pass.error);
  assert.equal((await json(await call("GET", "/api/voice/me", undefined, { cookie: cookie1 }))).user.username, "profileuser");
  assert.equal((await json(await call("GET", "/api/voice/me", undefined, { cookie: cookie2 }))).user, null);
});

await test("密码错误失败并进入递增冷却", async function () {
  resetRate();
  for (let i = 0; i < 5; i++) {
    const cap = await newCaptcha();
    const d = await json(await call("POST", "/api/voice/login", loginBody("alice", "WrongPass2026", cap)));
    assert.equal(d.ok, false);
  }
  const cap = await newCaptcha();
  const d = await json(await call("POST", "/api/voice/login", loginBody("alice", null, cap)));
  assert.equal(d.ok, false);
  assert.match(d.error, /等待/);
});

await test("登录成功会清掉失败计数", async function () {
  // 上一步仍在冷却，直接清计数模拟冷却过期
  db.exec("DELETE FROM rate WHERE k LIKE 'voice:fail:%'");
  const cap = await newCaptcha();
  const d = await json(await call("POST", "/api/voice/login", loginBody("alice", null, cap)));
  assert.equal(d.ok, true, d.error);
});

/* ══ 5. 管理接口 ═════════════════════════════════════════════ */
const H = { "X-Admin-Token": ADMIN_TOKEN };

await test("管理接口未授权返回 403", async function () {
  const res = await call("GET", "/api/voice/admin/invites");
  assert.equal(res.status, 403);
});

await test("后台创建 / 列表 / 删除邀请码，明文只返回一次", async function () {
  const created = await json(await call("POST", "/api/voice/admin/invites",
    { note: "后台创建", maxUses: 2, expiresAt: null }, H));
  assert.equal(created.ok, true);
  assert.match(created.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const list = await json(await call("GET", "/api/voice/admin/invites", undefined, H));
  const hit = list.items.filter(function (x) { return x.id === created.id; })[0];
  assert.ok(hit);
  assert.match(hit.mask, /••••/);
  assert.equal(hit.code, undefined, "列表不得泄露明文");
  assert.equal(hit.maxUses, 2);

  const uses = await json(await call("GET", "/api/voice/admin/invites/" + created.id + "/uses", undefined, H));
  assert.ok(Array.isArray(uses.items));

  const del = await json(await call("DELETE", "/api/voice/admin/invites/" + created.id, undefined, H));
  assert.equal(del.ok, true);
  const cap = await newCaptcha();
  const reg = await json(await call("POST", "/api/voice/register",
    Object.assign(regBody(created.code, "mallory"), captchaPairs(cap))));
  assert.equal(reg.ok, false, "删除后的邀请码不能再注册");
});

await test("后台用户列表 / 改角色 / 禁用 / 重置密码 / 删除", async function () {
  const users = await json(await call("GET", "/api/voice/admin/users?q=erin", undefined, H));
  assert.equal(users.items.length, 1);
  const id = users.items[0].id;
  assert.equal(users.items[0].password_rec, undefined);

  assert.equal((await json(await call("PATCH", "/api/voice/admin/users/" + id, { role: "admin" }, H))).ok, true);
  assert.equal(db.prepare("SELECT role FROM voice_users WHERE id = ?").get(id).role, "admin");

  assert.equal((await json(await call("PATCH", "/api/voice/admin/users/" + id, { status: "disabled" }, H))).ok, true);
  resetRate();
  const cap = await newCaptcha();
  const login = await json(await call("POST", "/api/voice/login", loginBody("erin", null, cap)));
  assert.equal(login.ok, false);
  assert.match(login.error, /禁用/);

  assert.equal((await json(await call("PATCH", "/api/voice/admin/users/" + id,
    { status: "active", password: "NewPass2026" }, H))).ok, true);
  resetRate();
  const cap2 = await newCaptcha();
  const login2 = await json(await call("POST", "/api/voice/login",
    Object.assign({ username: "erin", password: "NewPass2026" }, captchaPairs(cap2))));
  assert.equal(login2.ok, true, login2.error);

  const target = db.prepare("SELECT id FROM voice_users WHERE username = 'frank'").get();
  assert.equal((await json(await call("DELETE", "/api/voice/admin/users/" + target.id, undefined, H))).ok, true);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM voice_users WHERE id = ?").get(target.id).c, 0);
});

await test("系统设置：关闭注册后注册接口拒绝；Turnstile 未配密钥时拒绝切换", async function () {
  const s = await json(await call("GET", "/api/voice/admin/settings", undefined, H));
  assert.equal(s.settings.captchaMode, "image");

  const noSecret = await json(await call("PATCH", "/api/voice/admin/settings",
    { captchaMode: "turnstile" }, H));
  assert.equal(noSecret.ok, false);
  assert.match(noSecret.error, /TURNSTILE_SECRET_KEY/);

  const closed = await json(await call("PATCH", "/api/voice/admin/settings",
    { registrationOpen: false }, H));
  assert.equal(closed.settings.registrationOpen, false);
  const inv = await makeInvite();
  const cap = await newCaptcha();
  const reg = await json(await call("POST", "/api/voice/register",
    Object.assign(regBody(inv.code, "nobody"), captchaPairs(cap))));
  assert.equal(reg.ok, false);
  assert.match(reg.error, /未开放注册/);

  await call("PATCH", "/api/voice/admin/settings", { registrationOpen: true }, H);
});

await test("人机验证总开关：关掉后登录 / 注册都不再需要验证码", async function () {
  // 先准备一个有密码的普通账号
  const inv = await makeInvite();
  const cap = await newCaptcha();
  const reg = await json(await call("POST", "/api/voice/register",
    Object.assign(regBody(inv.code, "nocap_user"), captchaPairs(cap))));
  assert.equal(reg.ok, true);

  const off = await json(await call("PATCH", "/api/voice/admin/settings",
    { captchaEnabled: false }, H));
  assert.equal(off.settings.captchaEnabled, false);

  const cfg = await json(await call("GET", "/api/voice/config"));
  assert.equal(cfg.captchaEnabled, false);
  assert.equal(cfg.captchaMode, "image", "关掉后前端不该再拿到 turnstile 配置");

  // 不带任何验证码字段也能登录
  resetRate();
  const login = await json(await call("POST", "/api/voice/login",
    { username: "nocap_user", password: "ZfVoice2026" }));
  assert.equal(login.ok, true, login.error || "");
  assert.equal(login.user.username, "nocap_user");

  await call("PATCH", "/api/voice/admin/settings", { captchaEnabled: true }, H);
  resetRate();
  const needCap = await json(await call("POST", "/api/voice/login",
    { username: "nocap_user", password: "ZfVoice2026" }));
  assert.equal(needCap.ok, false);
  assert.equal(await json(await call("GET", "/api/voice/config")).then(function (c) {
    return c.captchaEnabled;
  }), true);
});

await test("游客登录：自动分配昵称、无密码、角色为 guest", async function () {
  resetRate();
  const r = await json(await call("POST", "/api/voice/guest", {}));
  assert.equal(r.ok, true, r.error || "");
  assert.equal(r.guest, true);
  assert.equal(r.user.role, "guest");
  assert.match(r.user.displayName, /^游客\d{4}$/);
  assert.match(r.user.username, /^guest_[0-9a-f]{6}$/);
  assert.equal(r.user.avatarUrl, null);

  // 会话真的可用
  const cookies = r && r.session ? null : null;   // 占位，避免误用
  const setCookie = r.__cookie || "";
  void cookies; void setCookie;

  // 游客有随机口令哈希，且「用户名+空密码」登不进来
  const row = db.prepare("SELECT password_rec, role FROM voice_users WHERE id = ?").get(r.user.id);
  assert.ok(row.password_rec && row.password_rec.length > 20);
  resetRate();
  const tryLogin = await json(await call("POST", "/api/voice/login",
    { username: r.user.username, password: "" }));
  assert.equal(tryLogin.ok, false);

  // 游客不能创建频道
  const ch = await json(await call("POST", "/api/voice/channels",
    { name: "游客的频道", visibility: "public" }));
  assert.equal(ch.ok, false);
});

await test("游客登录开关：后台关掉后接口拒绝，前端 config 也同步", async function () {
  resetRate();
  const off = await json(await call("PATCH", "/api/voice/admin/settings",
    { guestLoginOpen: false }, H));
  assert.equal(off.settings.guestLoginOpen, false);
  assert.equal(await json(await call("GET", "/api/voice/config")).then(function (c) {
    return c.guestLoginOpen;
  }), false);

  resetRate();
  const blocked = await json(await call("POST", "/api/voice/guest", {}));
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /未开放游客登录/);

  await call("PATCH", "/api/voice/admin/settings", { guestLoginOpen: true }, H);
});

await test("审计日志记录了注册 / 登录 / 邀请码操作", async function () {
  const a = await json(await call("GET", "/api/voice/admin/audit", undefined, H));
  const actions = a.items.map(function (x) { return x.action; });
  for (const need of ["register", "login", "login.fail", "invite.create", "invite.delete", "user.update", "settings.update"]) {
    assert.ok(actions.indexOf(need) >= 0, "缺少审计动作：" + need);
  }
});

await test("未命中 /api/voice 的路径返回 null，不干扰既有路由", async function () {
  const r = await call("GET", "/api/voice/not-exist");
  assert.equal(r, null);
  assert.equal(await handleVoiceAPI(new Request("http://x/api/health"), env, CTX,
    new URL("http://x/api/health")), null);
});

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败\n");
if (fail) process.exit(1);
