/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 本机媒体后端（self_hosted / LiveKit）回归测试
 *
 *  这条路径以前从未真正启用：直到把 LiveKit 跑起来、让线上 join 走到
 *  self_hosted 分支，才发现中文显示名会让 btoa() 抛错、整个 join 500。
 *  这里把令牌签发单独拎出来测，顺便守住程序与文档的交付内容。
 *
 *  运行：npm run voice:test:selfhost
 * ══════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { livekitToken } from "../../src/voice-realtime.js";
import vm from "node:vm";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

const env = {
  LIVEKIT_API_KEY: "testkey1234567890",
  LIVEKIT_API_SECRET: "test-secret-for-jwt-signing-0123456789"
};
const server = { secret_ref: "LIVEKIT_API_SECRET" };
const user = { id: "8b63c3994418faa4e9b6b3dd", display_name: "中文管理员", role: "admin" };

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) { console.error("  ✘ " + name + "\n    " + (e && e.stack || e)); fail++; }
}
console.log("\nZF语音 本机媒体后端（LiveKit 令牌）回归测试\n");

function decodePayload(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "JWT 应该是三段");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

await test("中文显示名也能签发令牌（旧实现 btoa 会 500）", async function () {
  const t = await livekitToken(env, server, user, "selfhost-test");
  assert.ok(!t.error, t.error);
  assert.ok(t.token, "没有返回令牌");
  const p = decodePayload(t.token);
  assert.equal(p.name, "中文管理员", "中文昵称被破坏：" + JSON.stringify(p));
});

await test("JWT 内容与权限符合 LiveKit 要求", async function () {
  const t = await livekitToken(env, server, user, "cf-lobby");
  const p = decodePayload(t.token);
  assert.equal(p.iss, env.LIVEKIT_API_KEY);
  assert.equal(p.sub, user.id);
  assert.equal(p.video.roomJoin, true);
  assert.equal(p.video.room, "cf-lobby");
  assert.equal(p.video.canPublish, true);
  assert.equal(p.video.canSubscribe, true);
  assert.ok(p.exp > Math.floor(Date.now() / 1000));
  assert.ok(p.exp <= Math.floor(Date.now() / 1000) + 3600);
  assert.match(t.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
    "必须是 URL-safe base64，不能出现 + / =");
});

await test("WebRTC stats 不重复统计丢包并单独计算屏幕视频码率", async function () {
  const context = { window: {}, document: { getElementById: function () { return null; } },
    console: console, Promise: Promise, Date: Date, Math: Math, Number: Number, Object: Object,
    Array: Array, Uint8Array: Uint8Array, setTimeout: setTimeout, clearTimeout: clearTimeout };
  vm.runInNewContext(read("voice/transport.js"), context);
  const Base = context.window.VoiceTransport.Base;
  const transport = Object.create(Base.prototype);
  transport.room = { rtt: 30 };
  transport.statsHistory = { rttMs: [], lossPct: [], jitterMs: [], sendKbps: [], recvKbps: [], videoSendKbps: [], videoRecvKbps: [], sendFps: [], recvFps: [] };
  transport.statsPrevious = { at: Date.now() - 2000, bytesSent: 1000, bytesRecv: 1000, videoBytesSent: 500, videoBytesRecv: 500,
    videoFramesSent: 20, videoFramesRecv: 18 };
  transport.handlers = {};
  transport.emit = function () {};
  const reports = [
    { type: "inbound-rtp", kind: "video", bytesReceived: 9000, packetsReceived: 90, packetsLost: 10, jitter: 0.02, framesDecoded: 48 },
    { type: "remote-inbound-rtp", packetsReceived: 180, packetsLost: 20, roundTripTime: 0.04 },
    { type: "outbound-rtp", kind: "video", bytesSent: 9000, framesEncoded: 50 },
    { type: "candidate-pair", state: "succeeded", currentRoundTripTime: 0.05 }
  ];
  const pc = { getStats: async function () { return { forEach: function (fn) { reports.forEach(fn); } }; } };
  const stats = await transport.collectStats([pc]);
  assert.equal(stats.lossPct, 10, "必须使用 remote-inbound 数据，而不是重复累加 inbound");
  // 码率按「字节差 / 实际经过时间」计算，而 statsPrevious.at 与 collectStats 执行时刻
  // 之间存在几毫秒误差（实测约 2000.1~2000.9ms），所以这里不能断言精确整数 34。
  // 用 ±0.5 kbps 的容差，既能抓住「少乘 8」「用错字段」这类量级错误，又不依赖时钟精度。
  assert.ok(Math.abs(stats.videoSendKbps - 34) < 0.5,
    "视频发送码率应约为 34 kbps，实际 " + stats.videoSendKbps);
  assert.ok(Math.abs(stats.videoRecvKbps - 34) < 0.5,
    "视频接收码率应约为 34 kbps，实际 " + stats.videoRecvKbps);
  assert.equal(Math.round(stats.sendFps), 15, "发送帧率应约为 15fps，实际 " + stats.sendFps);
  assert.equal(Math.round(stats.recvFps), 15, "接收帧率应约为 15fps，实际 " + stats.recvFps);
  // RTT 现在只取 candidate-pair（浏览器 ↔ 媒体服务器的真实往返），不再被
  // 信令 WebSocket 的 rtt 或 RTCP 上报的 roundTripTime 污染——那两个都会
  // 把本地服务器的延迟也算成上百毫秒。这里 candidate-pair 报 0.05s。
  assert.equal(stats.rttMs, 50, "RTT 应取 candidate-pair 的 currentRoundTripTime");
});

await test("未配置密钥时给出中文错误，不会签发空令牌", async function () {
  const t = await livekitToken({}, server, user, "x");
  assert.match(t.error, /未配置自建服务的 API Key/);
  assert.equal(t.token, undefined);
});

await test("server.secret_ref 指向的密钥名可被正确解析", async function () {
  const t = await livekitToken(
    { LIVEKIT_API_KEY: "k", CUSTOM_SECRET: "s" },
    { secret_ref: "CUSTOM_SECRET" }, user, "x");
  assert.ok(t.token, "应能从自定义 secret 名取到密钥");
  assert.equal(decodePayload(t.token).iss, "k");
});

await test("本机媒体后端主程序与一键脚本齐全", function () {
  const main = read("tools/livekit/voice-media-server.mjs");
  ["setup", "run", "doctor", "print", "stop"].forEach(function (cmd) {
    assert.match(main, new RegExp("cmd === \"" + cmd + "\""), "缺少子命令 " + cmd);
  });
  assert.match(main, /curl\.exe/, "下载应走可续传的 curl");
  assert.match(main, /trycloudflare/, "需要自动抓取 wss 域名");
  assert.match(main, /LIVEKIT_API_KEY/, "需要提示注入 Worker 密钥");
  const bat = read("tools/livekit/start.bat");
  assert.match(bat, /voice-media-server\.mjs run/);
  assert.doesNotMatch(bat, /[^\x00-\x7F]/, "bat 必须纯 ASCII，避免 OEM 编码乱码");
});

await test("中文文档覆盖职责边界、端口与 UDP 限制", function () {
  const doc = read("tools/livekit/README.md");
  assert.match(doc, /Cloudflare Worker/);
  assert.match(doc, /账号|登录/);
  assert.match(doc, /443/);
  assert.match(doc, /UDP/);
  assert.match(doc, /unknown/);
});

await test("真实密钥与二进制已被 gitignore 排除", function () {
  const gi = read(".gitignore");
  ["livekit.yaml", "server.json", "worker-secrets.txt", "*.exe", "*.zip"].forEach(function (p) {
    assert.ok(gi.indexOf("tools/livekit/" + p) >= 0, "缺少排除规则：" + p);
  });
});

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
if (fail) process.exit(1);
