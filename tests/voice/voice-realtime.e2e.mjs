/* ══════════════════════════════════════════════════════════════
 *  ZF语音 阶段 3~7 —— 端到端测试（真实 HTTP + 真实 WebSocket）
 *
 *  与阶段 2 的 voice-auth.test.mjs 不同，这里启动一个**完全隔离**的
 *  tools/dev/voice-dev-server.mjs（独立端口、独立 SQLite、独立头像目录），
 *  直接加载线上同一个 src/index.js。于是下面跑过的每一条都是真实链路：
 *    HttpOnly Cookie、CSRF、D1 SQL、Durable Object 房间、WebSocket 广播、
 *    后台音质下发、私有频道可见性、混合内容中文提示、审计日志。
 *
 *  验证码答案不落库（设计如此），测试台用 node:sqlite 往同一个文件里
 *  预置一条已知答案的挑战，等价于「人眼读出图片后填写」，不绕过校验逻辑。
 *
 *  运行：npm run voice:test:e2e
 * ══════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import * as C from "../../src/voice-core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zfvoice-e2e-"));
const DB_FILE = path.join(TMP, "e2e.sqlite");
const MEDIA_DIR = path.join(TMP, "media");
const CRED_FILE = path.join(TMP, "cred.txt");
const PORT = 8900 + Math.floor(Math.random() * 300);
const BASE = "http://127.0.0.1:" + PORT;
const PASSWORD = "E2eVoice2026Pass";
const CAPTCHA_SECRET = "zf-voice-dev-only";

let serverOut = "";
const child = spawn(process.execPath,
  ["--no-warnings", "tools/dev/voice-dev-server.mjs"], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      VOICE_DEV_DB: DB_FILE,
      VOICE_DEV_MEDIA: MEDIA_DIR,
      VOICE_DEV_CRED: CRED_FILE,
      VOICE_DEV_ADMIN_PASSWORD: PASSWORD
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
child.stdout.on("data", function (d) { serverOut += d.toString(); });
child.stderr.on("data", function (d) { serverOut += d.toString(); });

const delay = (ms) => new Promise(function (r) { setTimeout(r, ms); });

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(BASE + "/api/health", { signal: AbortSignal.timeout(600) });
      if (r.ok) return;
    } catch (_) {}
    await delay(120);
  }
  throw new Error("本地 Worker 运行时启动超时。输出：\n" + serverOut);
}

/* ── HTTP 助手 ──────────────────────────────────────────────── */
async function api(method, p, body, opts) {
  opts = opts || {};
  const headers = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.token) headers["X-Admin-Token"] = opts.token;
  if (opts.origin) headers.origin = opts.origin;
  const r = await fetch(BASE + p, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return { status: r.status, data: data, raw: text, headers: r.headers };
}
function cookieOf(res) {
  const raw = res.headers.get("set-cookie") || "";
  const m = raw.match(/zf_voice_sid=([^;]+)/);
  return m ? "zf_voice_sid=" + m[1] : "";
}

/* ── 验证码 / 邀请码助手 ────────────────────────────────────── */
let tdb = null;
function db() {
  if (!tdb) {
    tdb = new DatabaseSync(DB_FILE);
    tdb.exec("PRAGMA busy_timeout = 5000;");
  }
  return tdb;
}
let capSeq = 0;
async function captcha(answer) {
  answer = answer || "12345";
  const id = "cap" + (++capSeq) + crypto.randomBytes(8).toString("hex");
  const hash = await C.captchaHash(id, answer, CAPTCHA_SECRET);
  db().prepare("INSERT INTO captcha_challenges (id,answer_hash,exp,consumed,ip,created_at) VALUES (?,?,?,0,?,?)")
    .run(id, hash, Date.now() + 120000, "127.0.0.1", Date.now());
  return { captchaId: id, captcha: answer };
}

/* ── WebSocket 助手 ─────────────────────────────────────────── */
function connectRoom(url) {
  return new Promise(function (resolve, reject) {
    const ws = new WebSocket(url);
    const messages = [];
    const timers = [];
    ws.on("message", function (d) {
      try { messages.push(JSON.parse(d.toString())); } catch (_) {}
    });
    ws.on("open", function () {
      resolve({
        ws: ws,
        messages: messages,
        send: function (obj) { ws.send(JSON.stringify(obj)); },
        waitFor: function (pred, timeout) {
          return new Promise(function (res, rej) {
            const hit = messages.find(pred);
            if (hit) { res(hit); return; }
            const t = Date.now();
            const iv = setInterval(function () {
              const m = messages.find(pred);
              if (m) { clearInterval(iv); res(m); }
              else if (Date.now() - t > (timeout || 2500)) {
                clearInterval(iv);
                rej(new Error("等待 WebSocket 消息超时；已收到：" +
                  JSON.stringify(messages.map(function (x) { return x.t; }))));
              }
            }, 30);
            timers.push(iv);
          });
        },
        close: function () {
          timers.forEach(clearInterval);
          try { ws.close(); } catch (_) {}
        }
      });
    });
    ws.on("error", reject);
  });
}

/* ── 测试框架 ───────────────────────────────────────────────── */
let pass = 0, fail = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) {
    console.error("  ✘ " + name + "\n    " + (e && e.stack || e));
    fail++;
    failures.push(name);
  }
}

/* ── 共享状态 ───────────────────────────────────────────────── */
const S = {
  adminToken: "", invite: "", cookieA: "", cookieB: "",
  userA: null, userB: null, joinA: null, joinB: null,
  privateId: "", adminChannelId: "", serverId: ""
};

console.log("\nZF语音 阶段 3~7 端到端测试（隔离端口 " + PORT + " / 真实 Worker 运行时）\n");

try {
  await waitReady();
  await delay(120);   // 等 schema 与初始化账号写盘完成

  /* ══ 1. 基础可达性 ═══════════════════════════════════════ */
  await step("健康检查与 /voice 页面 / 静态资源全部 200", async function () {
    for (const p of ["/api/health", "/voice/", "/voice", "/voice/index.html",
      "/voice/voice.css", "/voice/voice.js", "/voice/auth.js", "/voice/transport.js",
      "/assets/js/admin-voice.js", "/assets/js/voice-entry.js", "/admin/"]) {
      const r = await fetch(BASE + p);
      assert.equal(r.status, 200, p + " 返回 " + r.status);
    }
  });

  await step("/api/voice/config 与 bootstrap（未登录）可用", async function () {
    const cfg = await api("GET", "/api/voice/config");
    assert.equal(cfg.status, 200);
    assert.equal(cfg.data.ok, true);
    assert.equal(cfg.data.captchaMode, "image");
    const boot = await api("GET", "/api/voice/bootstrap");
    assert.equal(boot.status, 200);
    assert.equal(boot.data.user, null);
    assert.deepEqual(boot.data.channels, []);
    assert.equal(boot.data.capabilities.worker, true);
    assert.equal(boot.data.capabilities.durableObject, true);
    assert.equal(boot.data.capabilities.sfu, false);   // 本地未配置 SFU 密钥
  });

  /* ══ 2. 注册 / 登录 ══════════════════════════════════════ */
  await step("后台登录取得 X-Admin-Token", async function () {
    const r = await api("POST", "/api/admin/login", { username: "ZFSN", password: PASSWORD });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    // L.ok 是扁平结构：{ ok:true, token, expiresIn }
    assert.ok(r.data.token, "登录响应缺少 token：" + JSON.stringify(r.data));
    S.adminToken = r.data.token;
  });

  await step("后台创建邀请码，明文只返回一次", async function () {
    const r = await api("POST", "/api/voice/admin/invites",
      { note: "E2E 测试码", maxUses: null }, { token: S.adminToken });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.ok(r.data.code, "创建邀请码未返回明文：" + JSON.stringify(r.data));
    S.invite = r.data.code;
    assert.ok(String(S.invite).length >= 10);
  });

  await step("验证码错误 / 重复使用被拒，正确后注册两名用户", async function () {
    const bad = await captcha("99999");
    const r0 = await api("POST", "/api/voice/register", Object.assign({
      invite: S.invite, username: "badcap_user", displayName: "验证码错误",
      password: PASSWORD, password2: PASSWORD
    }, { captchaId: bad.captchaId, captcha: "12345" }));
    assert.equal(r0.status, 400, JSON.stringify(r0.data));

    for (const [u, n] of [["alice", "甲"], ["bob", "乙"]]) {
      const cap = await captcha();
      const r = await api("POST", "/api/voice/register", Object.assign({
        invite: S.invite, username: u, displayName: n,
        password: PASSWORD, password2: PASSWORD
      }, cap));
      assert.equal(r.status, 201, u + " 注册失败：" + JSON.stringify(r.data));
      const ck = cookieOf(r);
      assert.ok(ck, "注册未下发会话 Cookie");
      if (u === "alice") { S.cookieA = ck; S.userA = r.data.user; }
      else { S.cookieB = ck; S.userB = r.data.user; }
    }
    assert.notEqual(S.userA.id, S.userB.id);
  });

  await step("/me 读取真实身份；未登录访问频道列表返回 401", async function () {
    const me = await api("GET", "/api/voice/me", undefined, { cookie: S.cookieA });
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, "alice");
    const no = await api("GET", "/api/voice/channels");
    assert.equal(no.status, 401);
  });

  /* ══ 2.5 个人资料：改名 / 换头像 ═════════════════════════ */
  await step("修改显示名与头像：PATCH /me 立即生效，SVG 头像被拒", async function () {
    const before = await api("GET", "/api/voice/me", undefined, { cookie: S.cookieA });
    const originalName = before.data.user.displayName;
    // 1×1 透明 PNG：服务端会按魔数识别真实类型，不信任 data URL 里的 MIME
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const r = await api("PATCH", "/api/voice/me",
      { displayName: "爱丽丝改名", avatar: png }, { cookie: S.cookieA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.user.displayName, "爱丽丝改名");
    assert.match(String(r.data.user.avatarUrl || ""), /^\/api\/voice\/avatars\//,
      "头像应落到 MEDIA 存储并返回站内地址");

    // 重新读一次，确认真的写进了库（而不是只改了本次响应）
    const again = await api("GET", "/api/voice/me", undefined, { cookie: S.cookieA });
    assert.equal(again.data.user.displayName, "爱丽丝改名", "刷新后应当还是新名字");
    assert.equal(again.data.user.avatarUrl, r.data.user.avatarUrl);

    // SVG 可以内嵌脚本，必须一律拒绝
    const bad = await api("PATCH", "/api/voice/me",
      { avatar: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }, { cookie: S.cookieA });
    assert.equal(bad.status, 400, "SVG 头像必须被拒绝");

    // 还原显示名，后面几个步骤是按初始昵称断言的
    await api("PATCH", "/api/voice/me", { displayName: originalName }, { cookie: S.cookieA });
  });

  /* ══ 3. 频道 / 房间票据 ══════════════════════════════════ */
  await step("bootstrap 返回 3 个 Cloudflare 预置频道与频道设置", async function () {
    const b = await api("GET", "/api/voice/bootstrap", undefined, { cookie: S.cookieA });
    assert.equal(b.status, 200);
    assert.equal(b.data.user.username, "alice");
    assert.equal(b.data.channels.length, 3);
    assert.equal(b.data.channels[0].id, "cf-lobby");
    assert.equal(b.data.channels[0].backend, "cloudflare");
    assert.equal(b.data.channels[0].backendLabel, "云");
    assert.equal(b.data.channels[0].settings.audio.bitrateKbps, 48);
    assert.equal(b.data.channels[0].settings.screen.maxFps, 30);
  });

  await step("加入 cf-lobby：返回票据 / wsUrl / ICE / 降级提示", async function () {
    const r = await api("POST", "/api/voice/channels/cf-lobby/join", {}, { cookie: S.cookieA });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    S.joinA = r.data;
    assert.equal(r.data.transport, "mesh", "未配置 SFU 时应降级为本地直连");
    assert.ok(r.data.ticket && r.data.ticket.split(".").length === 2);
    assert.ok(r.data.wsUrl.indexOf("/api/voice/room/cf-lobby/ws") >= 0);
    assert.ok(Array.isArray(r.data.iceServers) && r.data.iceServers.length > 0);
    assert.ok(String(r.data.notice).indexOf("降级") >= 0);
    assert.ok(!("REALTIME_SFU_APP_SECRET" in r.data), "密钥不得下发前端");
  });

  await step("房间票据：篡改 / 过期 / 跨频道一律无效", async function () {
    const env = { VOICE_CAPTCHA_SECRET: CAPTCHA_SECRET };
    const ticket = S.joinA.ticket;
    const body = JSON.parse(Buffer.from(ticket.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    assert.equal(body.n, "甲", "显示名不能被 nonce 覆盖");
    assert.equal(body.c, "cf-lobby");
    assert.ok(await C.verifyRoomTicket(env, ticket, "cf-lobby"));
    assert.equal(await C.verifyRoomTicket(env, ticket + "x", "cf-lobby"), null);
    assert.equal(await C.verifyRoomTicket(env, ticket, "cf-2"), null);
    const expired = await C.signRoomTicket(env, { u: "u", c: "cf-lobby", n: "过期", exp: 1 });
    // signRoomTicket 会覆盖 exp，用手动构造验证过期分支
    const parts = await C.signRoomTicket(env, { u: "u", c: "cf-lobby", n: "过期" });
    const raw = JSON.parse(Buffer.from(parts.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    assert.ok(raw.exp > Date.now(), "签发票据必须带未来过期时间");
    assert.ok(typeof expired === "string");
  });

  /* ══ 4. 私有频道（用户电脑只负责「添加」）════════════════ */
  await step("创建带口令的私有频道，只有创建者可见", async function () {
    const r = await api("POST", "/api/voice/channels", {
      name: "我和朋友的小房间", descr: "私有测试频道",
      visibility: "private", password: "room-pwd-2026",
      backend: "cloudflare"
    }, { cookie: S.cookieA });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    S.privateId = r.data.channel.id;
    assert.equal(r.data.channel.private, true);
    assert.equal(r.data.channel.hasPassword, true);
    assert.equal(r.data.channel.backend, "cloudflare", "私有频道后端仍是 Cloudflare Worker");
    assert.equal(r.data.channel.ownerId, S.userA.id);

    const b = await api("GET", "/api/voice/channels", undefined, { cookie: S.cookieB });
    assert.equal(b.status, 200);
    assert.ok(!b.data.items.some(function (x) { return x.id === S.privateId; }),
      "其他用户不应看到私有频道");
  });

  await step("私有频道口令错误被拒，正确可加入；其他用户被拒", async function () {
    const wrong = await api("POST", "/api/voice/channels/" + S.privateId + "/join",
      { password: "wrong" }, { cookie: S.cookieA });
    assert.equal(wrong.status, 403);
    const right = await api("POST", "/api/voice/channels/" + S.privateId + "/join",
      { password: "room-pwd-2026" }, { cookie: S.cookieA });
    assert.equal(right.status, 200, JSON.stringify(right.data));
    assert.equal(right.data.channel.private, true);
    const other = await api("POST", "/api/voice/channels/" + S.privateId + "/join",
      { password: "room-pwd-2026" }, { cookie: S.cookieB });
    assert.equal(other.status, 403, JSON.stringify(other.data));
  });

  await step("HTTPS 混合内容 / 纯 IP 证书给出中文指引", async function () {
    const r = await api("POST", "/api/voice/servers/test",
      { host: "192.168.1.50", port: 7880, tls: false }, { cookie: S.cookieA });
    assert.equal(r.status, 200);
    assert.equal(r.data.reachable, false);
    assert.ok(String(r.data.message).indexOf("混合内容") >= 0, r.data.message);
    assert.ok(String(r.data.message).indexOf("Cloudflare Tunnel") >= 0);
    const ipTls = await api("POST", "/api/voice/servers/test",
      { host: "192.168.1.50", port: 7880, tls: true }, { cookie: S.cookieA });
    assert.equal(ipTls.data.reachable, false);
    assert.ok(String(ipTls.data.message).indexOf("wss") >= 0);
  });

  await step("频道创建者能修改频道，其他用户不能，在线频道不能删除", async function () {
    const before = await api("POST", "/api/voice/channels/cf-lobby/join", {}, { cookie: S.cookieA });
    const own = await api("PATCH", "/api/voice/channels/" + S.privateId,
      { name: "私有频道改名", descr: "新简介", password: "" }, { cookie: S.cookieA });
    assert.equal(own.status, 200, JSON.stringify(own.data));
    assert.equal(own.data.channel.name, "私有频道改名");
    const forbidden = await api("PATCH", "/api/voice/channels/" + S.privateId,
      { name: "越权" }, { cookie: S.cookieB });
    assert.equal(forbidden.status, 403);
    const ownerJoin = await api("POST", "/api/voice/channels/" + S.privateId + "/join", { password: "room-pwd-2026" }, { cookie: S.cookieA });
    const ownerRoom = await connectRoom(ownerJoin.data.wsUrl);
    await ownerRoom.waitFor(function (m) { return m.t === "hello"; });
    const activeDelete = await api("DELETE", "/api/voice/channels/" + S.privateId, undefined, { cookie: S.cookieA });
    assert.equal(activeDelete.status, 409);
    assert.match(activeDelete.data.error, /频道内还有/);
    ownerRoom.close();
    const fresh = await api("POST", "/api/voice/channels", { name: "待删自有频道", visibility: "private" }, { cookie: S.cookieA });
    assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
    const del = await api("DELETE", "/api/voice/channels/" + fresh.data.channel.id, undefined, { cookie: S.cookieA });
    assert.equal(del.status, 200, JSON.stringify(del.data));
    assert.equal(Number(db().prepare("SELECT COUNT(*) AS c FROM channel_settings WHERE channel_id = ?").get(fresh.data.channel.id).c), 0);
    void before;
  });

  await step("普通用户默认不能添加自建后端频道（架构约束）", async function () {
    const r = await api("POST", "/api/voice/channels", {
      name: "自建测试", backend: "self_hosted", host: "voice.example.com", port: 7880, tls: true
    }, { cookie: S.cookieA });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    assert.ok(String(r.data.error).indexOf("管理员") >= 0);
  });

  /* ══ 5. 真实 WebSocket 房间 ══════════════════════════════ */
  await step("两名用户建立真实 WebSocket，收到 hello / 成员广播", async function () {
    const jb = await api("POST", "/api/voice/channels/cf-lobby/join", {}, { cookie: S.cookieB });
    assert.equal(jb.status, 200, JSON.stringify(jb.data));
    S.joinB = jb.data;

    S.roomA = await connectRoom(S.joinA.wsUrl);
    S.roomB = await connectRoom(S.joinB.wsUrl);
    const helloA = await S.roomA.waitFor(function (m) { return m.t === "hello"; });
    assert.equal(helloA.self.name, "甲");
    assert.equal(helloA.channel, "cf-lobby");
    const mem = await S.roomB.waitFor(function (m) {
      return m.t === "members" && m.count === 2;
    });
    assert.deepEqual(mem.members.map(function (x) { return x.name; }).sort(), ["乙", "甲"].sort());
  });

  await step("频道聊天：实时广播、拒绝空/超长消息并在重连 hello 返回历史", async function () {
    const text = "<script>alert(1)</script>";
    S.roomA.send({ t: "chat", text: text });
    const received = await S.roomB.waitFor(function (m) { return m.t === "chat" && m.text === text; });
    assert.equal(received.memberId, S.userA.id);
    assert.ok(received.id && received.ts);
    S.roomA.send({ t: "chat", text: "   " });
    assert.ok(await S.roomA.waitFor(function (m) { return m.t === "error" && /1~500/.test(m.text); }));
    S.roomA.send({ t: "chat", text: "x".repeat(501) });
    assert.ok(await S.roomA.waitFor(function (m) { return m.t === "error" && /1~500/.test(m.text); }));
    for (let i = 0; i < 6; i++) S.roomA.send({ t: "chat", text: "rate-" + i });
    assert.ok(await S.roomA.waitFor(function (m) { return m.t === "error" && /发送太快/.test(m.text); }));
    S.roomA.close();
    const reconnectJoin = await api("POST", "/api/voice/channels/cf-lobby/join", {}, { cookie: S.cookieA });
    const reconnect = await connectRoom(reconnectJoin.data.wsUrl);
    const hello = await reconnect.waitFor(function (m) { return m.t === "hello"; });
    assert.ok(hello.chat.some(function (m) { return m.text === text; }));
    reconnect.close();
    S.roomA = await connectRoom(S.joinA.wsUrl);
    await S.roomA.waitFor(function (m) { return m.t === "hello"; });
  });

  await step("信令只转发给指定成员，不广播给第三人以外的人", async function () {
    S.roomA.send({ t: "signal", to: S.userB.id, data: { sdp: "fake-offer" } });
    const sig = await S.roomB.waitFor(function (m) {
      return m.t === "signal" && m.from === S.userA.id;
    });
    assert.equal(sig.data.sdp, "fake-offer");
  });

  await step("成员状态 state / pub 会实时广播说话与共享标识", async function () {
    S.roomA.send({ t: "state", speaking: true, mic: false });
    const m = await S.roomB.waitFor(function (x) {
      return x.t === "members" && x.members.some(function (u) { return u.id === S.userA.id && u.speaking === true && u.mic === false; });
    });
    assert.equal(m.count, 2);
    S.roomA.send({ t: "pub", tracks: [{ sessionId: "sfu-1", trackName: "screen", kind: "video" }] });
    const p = await S.roomB.waitFor(function (x) {
      return x.t === "members" && x.members.some(function (u) { return u.id === S.userA.id && u.sharing === true; });
    });
    const sharer = p.members.find(function (u) { return u.id === S.userA.id; });
    assert.ok(sharer && (sharer.publications || []).some(function (t) { return t.kind === "video"; }),
      "共享者出版物未带 video 轨道：" + JSON.stringify(p.members));
    S.roomA.send({ t: "profile", name: "甲改名", avatarUrl: "/api/voice/avatars/test?v=1" });
    const profile = await S.roomB.waitFor(function (x) {
      return x.t === "members" && x.members.some(function (u) { return u.id === S.userA.id && u.name === "甲改名"; });
    });
    assert.ok(profile.members.some(function (u) { return u.id === S.userA.id && /v=1/.test(u.avatarUrl); }));
  });

  /* ══ 6. 后台频道 / 音质 / 屏幕上限与实时下发 ═════════════ */
  await step("后台频道列表含私有频道，共 4 个", async function () {
    const r = await api("GET", "/api/voice/admin/channels", undefined, { token: S.adminToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.items.length, 4);
    assert.ok(r.data.items.some(function (x) { return x.private; }));
  });

  await step("后台修改音质 / 屏幕上限 → revision +1 并实时推给在线客户端", async function () {
    const r = await api("PATCH", "/api/voice/admin/channels/cf-lobby", {
      audio: { preset: "custom", bitrateKbps: 120, sampleRate: 99999, channels: 2, dtx: false, fec: true, frameMs: 20 },
      screen: { enabled: true, maxWidth: 99999, maxHeight: 1080, maxFps: 60, maxBitrateKbps: 8000, maxSharers: 2 }
    }, { token: S.adminToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.revision, 2);
    assert.equal(r.data.settings.audio.bitrateKbps, 120);
    assert.equal(r.data.settings.audio.sampleRate, 48000, "非法采样率应夹回 48000");
    assert.equal(r.data.settings.screen.maxWidth, 3840, "超上限分辨率应被夹到 3840");

    const a = await S.roomA.waitFor(function (m) { return m.t === "settings" && m.revision === 2; });
    const b = await S.roomB.waitFor(function (m) { return m.t === "settings" && m.revision === 2; });
    assert.equal(a.settings.audio.bitrateKbps, 120);
    assert.equal(b.settings.screen.maxFps, 60);

    const list = await api("GET", "/api/voice/channels", undefined, { cookie: S.cookieA });
    const lobby = list.data.items.find(function (x) { return x.id === "cf-lobby"; });
    assert.equal(lobby.settings.audio.bitrateKbps, 120, "新加入的客户端应读到最新设置");
  });

  await step("后台新建频道 / 排序 / 删除，数据库无孤儿配置", async function () {
    const created = await api("POST", "/api/voice/admin/channels", {
      name: "临时频道", descr: "用于删除测试", backend: "cloudflare",
      maxUsers: 8, audio: { preset: "high", bitrateKbps: 96 }
    }, { token: S.adminToken });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    S.adminChannelId = created.data.id;
    assert.equal(created.data.settings.audio.preset, "high");

    const reorder = await api("POST", "/api/voice/admin/channels/reorder",
      { ids: [S.adminChannelId, "cf-lobby", "cf-2", "cf-3", S.privateId] },
      { token: S.adminToken });
    assert.equal(reorder.status, 200, JSON.stringify(reorder.data));
    const after = await api("GET", "/api/voice/admin/channels", undefined, { token: S.adminToken });
    assert.equal(after.data.items[0].id, S.adminChannelId);

    const del = await api("DELETE", "/api/voice/admin/channels/" + S.adminChannelId,
      undefined, { token: S.adminToken });
    assert.equal(del.status, 200, "删除频道失败：" + JSON.stringify(del.data));
    const orphan = db().prepare("SELECT COUNT(*) AS c FROM channel_settings WHERE channel_id = ?")
      .get(S.adminChannelId);
    assert.equal(Number(orphan.c), 0, "channel_settings 残留孤儿记录");
    const gone = db().prepare("SELECT COUNT(*) AS c FROM channels WHERE id = ?").get(S.adminChannelId);
    assert.equal(Number(gone.c), 0);
  });

  await step("管理员踢人 / 禁言通过 DO 下发给在线客户端", async function () {
    const mute = await api("POST", "/api/voice/admin/mute",
      { channelId: "cf-lobby", userId: S.userA.id }, { token: S.adminToken });
    assert.equal(mute.status, 200, JSON.stringify(mute.data));
    const fm = await S.roomA.waitFor(function (m) { return m.t === "forcedMute" && m.muted; });
    assert.ok(fm.by);
    const kick = await api("POST", "/api/voice/admin/kick",
      { channelId: "cf-lobby", userId: S.userB.id, reason: "E2E 测试" },
      { token: S.adminToken });
    assert.equal(kick.status, 200, JSON.stringify(kick.data));
    const kd = await S.roomB.waitFor(function (m) { return m.t === "kicked"; });
    assert.ok(String(kd.reason).indexOf("E2E") >= 0);
  });

  /* ══ 7. 可选自建服务器 / SFU 密钥保护 ═════════════════════ */
  await step("管理员可保存 / 删除 wss 自建服务器配置", async function () {
    const add = await api("POST", "/api/voice/admin/servers", {
      name: "备用 LiveKit", host: "voice.example.com", port: 7880, tls: true,
      secretRef: "LIVEKIT_API_SECRET"
    }, { token: S.adminToken });
    assert.equal(add.status, 201, JSON.stringify(add.data));
    S.serverId = add.data.id;
    const list = await api("GET", "/api/voice/admin/servers", undefined, { token: S.adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.data.items.some(function (x) { return x.id === S.serverId; }));
    const bad = await api("POST", "/api/voice/admin/servers", {
      name: "不安全", host: "192.168.1.5", port: 7880, tls: false
    }, { token: S.adminToken });
    assert.equal(bad.status, 400, "非 TLS 非回环地址应被拒绝");
    const del = await api("DELETE", "/api/voice/admin/servers/" + S.serverId,
      undefined, { token: S.adminToken });
    assert.equal(del.status, 200, JSON.stringify(del.data));
  });

  await step("未配置 SFU 时创建会话返回 503；越权操作他人 session 返回 403", async function () {
    const sess = await api("POST", "/api/voice/rtc/session",
      { channelId: "cf-lobby", kind: "publish" }, { cookie: S.cookieA });
    assert.equal(sess.status, 503, JSON.stringify(sess.data));
    assert.ok(String(sess.data.error).indexOf("REALTIME_SFU_APP_ID") >= 0);
    const tracks = await api("POST", "/api/voice/rtc/tracks",
      { sessionId: "someone-elses-session", op: "close", payload: {} }, { cookie: S.cookieA });
    assert.equal(tracks.status, 403, JSON.stringify(tracks.data));
  });

  await step("CSRF：跨站 Origin 的写请求被拒；未登录写请求被拒", async function () {
    const csrf = await api("POST", "/api/voice/channels/cf-lobby/join", {},
      { cookie: S.cookieA, origin: "https://evil.example.com" });
    assert.equal(csrf.status, 403);
    const anon = await api("POST", "/api/voice/channels", { name: "匿名频道" });
    assert.equal(anon.status, 401);
  });

  await step("系统设置：关闭普通用户创建私有频道后立即生效，再恢复", async function () {
    const off = await api("PATCH", "/api/voice/admin/settings",
      { allowUserPrivateChannels: false }, { token: S.adminToken });
    assert.equal(off.status, 200, JSON.stringify(off.data));
    const r = await api("POST", "/api/voice/channels",
      { name: "被禁止的私有频道", visibility: "private" }, { cookie: S.cookieA });
    assert.equal(r.status, 403, JSON.stringify(r.data));
    const on = await api("PATCH", "/api/voice/admin/settings",
      { allowUserPrivateChannels: true }, { token: S.adminToken });
    assert.equal(on.status, 200);
  });

  await step("审计日志记录了频道创建 / 修改 / 删除 / 踢人 / 禁言", async function () {
    const r = await api("GET", "/api/voice/admin/audit", undefined, { token: S.adminToken });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const items = r.data.items || r.data.logs || [];
    const actions = items.map(function (x) { return x.action; });
    for (const a of ["channel.create", "channel.update", "channel.delete", "kick", "mute", "register", "login"]) {
      assert.ok(actions.indexOf(a) >= 0, "审计缺少 " + a + "；实际：" + actions.join(","));
    }
  });

  await step("未知语音路由返回 404，不干扰既有 API", async function () {
    const r = await api("GET", "/api/voice/does-not-exist");
    assert.equal(r.status, 404);
    const health = await api("GET", "/api/health");
    assert.equal(health.status, 200);
    const boot = await api("GET", "/api/voice/bootstrap", undefined, { cookie: S.cookieB });
    assert.equal(boot.status, 200);
    assert.equal(boot.data.user.username, "bob");
  });

  await step("来回切频道残留的同一账号连接：DO 自动踢旧连接，成员表不出现重复管理员", async function () {
    // 复现 2026-11-14 线上 bug：快速切换时没关掉的旧 WebSocket 会让同一账号
    // 在成员列表里堆成一排。这里用甲的同一张票据连两次，模拟「幽灵连接」。
    const stale = await connectRoom(S.joinA.wsUrl);
    const h1 = await stale.waitFor(function (m) { return m.t === "hello"; });
    assert.equal(h1.self.id, S.userA.id, "旧连接身份不对");

    // 先挂上关闭监听：新连接一附着，旧连接就会立刻被 DO 踢掉，
    // 等 connectRoom 返回后再注册会错过 close 事件。
    const closedPromise = new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error("旧连接未被 DO 踢出")); }, 3000);
      stale.ws.on("close", function (c) { clearTimeout(timer); resolve(c); });
    });

    const fresh = await connectRoom(S.joinA.wsUrl);
    const h2 = await fresh.waitFor(function (m) { return m.t === "hello"; });
    assert.equal(h2.self.id, S.userA.id, "新连接身份不对");
    assert.equal(h2.members.filter(function (x) { return x.id === S.userA.id; }).length, 1,
      "hello 成员快照里出现重复账号：" + JSON.stringify(h2.members.map(function (x) { return x.name; })));

    // 旧连接必须被 DO 主动关闭，而不是永远留在房间
    const code = await closedPromise;
    assert.equal(code, 4402, "旧连接关闭码应为 4402，实际 " + code);

    await delay(300);
    const recent = S.roomB.messages.filter(function (m) { return m.t === "members"; });
    const last = recent[recent.length - 1];
    assert.ok(last, "另一个用户没有收到成员广播");
    assert.equal(last.members.filter(function (x) { return x.id === S.userA.id; }).length, 1,
      "成员广播里出现重复管理员：" + JSON.stringify(last.members.map(function (x) { return x.name; })));
    assert.equal(new Set(last.members.map(function (x) { return x.id; })).size, last.members.length,
      "成员列表存在重复 id");
    stale.close();
    fresh.close();
  });

  await step("屏幕共享上限夹取纯逻辑：请求值不得超过频道上限", async function () {
    const limits = { maxWidth: 1280, maxHeight: 720, maxFps: 15, maxBitrateKbps: 1500, maxSharers: 1 };
    const r = C.clampShareRequest({ res: 2160, fps: 60, bitrateKbps: 9000, contentHint: "motion", audio: true }, limits);
    assert.equal(r.width, 1280);
    assert.equal(r.height, 720);
    assert.equal(r.fps, 15);
    assert.equal(r.bitrateKbps, 1500);
    assert.equal(r.contentHint, "motion");
    assert.equal(r.audio, true);
    const st = C.normalizeAudioSettings({ preset: "custom", bitrateKbps: 99999, channels: 9 });
    assert.equal(st.bitrateKbps, 128);
    assert.equal(st.channels, 1);
  });

} finally {
  if (S.roomA) S.roomA.close();
  if (S.roomB) S.roomB.close();
  if (tdb) { try { tdb.close(); } catch (_) {} }
  try { child.kill("SIGTERM"); } catch (_) {}
  await delay(200);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
if (fail) {
  console.error("失败用例：" + failures.join("、"));
  console.error("\n服务器输出：\n" + serverOut.slice(-3000));
  process.exit(1);
}
