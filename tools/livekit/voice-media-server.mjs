/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 本机语音媒体后端（Windows / Node 22+，零第三方 npm 依赖）
 *
 *  职责边界（用户 2026-11-14 明确要求）：
 *    · 你的电脑：只跑语音 / 屏幕共享的媒体转发（LiveKit SFU）。
 *    · Cloudflare Worker：仍然是账号、登录、邀请码、频道、私有频道、
 *      房间信令与审计的唯一后端。本机不碰任何用户数据。
 *
 *  这个程序做四件事：
 *    setup  生成 API Key/Secret 与 livekit.yaml，自动下载 LiveKit Server
 *           与 cloudflared 两个官方二进制（只在第一次需要联网）。
 *    run    一键启动 LiveKit + Cloudflare Tunnel，自动抓取 wss 域名，
 *           打印后台「自建 SFU 服务器」该填什么、Worker 该注入哪些密钥。
 *    doctor 自检：二进制 / 配置 / 端口 / 隧道 / 公网出口 / UDP 限制。
 *    print  打印当前密钥与后台填写值（密钥只在本机显示，绝不进仓库）。
 *
 *  用法：node tools/livekit/voice-media-server.mjs <setup|run|doctor|print|stop>
 *        或直接双击 tools/livekit/start.bat（等价于 run）
 *
 *  安全：livekit.yaml / server.json / *.exe 含真实密钥或可执行文件，
 *        全部由 .gitignore 排除。关掉窗口或 Ctrl+C 会同时停掉两个进程。
 * ══════════════════════════════════════════════════════════════ */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const STATE_FILE = path.join(HERE, "server.json");
const YAML_FILE = path.join(HERE, "livekit.yaml");
const TEMPLATE = path.join(HERE, "livekit.example.yaml");
const SECRETS_FILE = path.join(HERE, "worker-secrets.txt");
const LK_EXE = path.join(HERE, "livekit-server.exe");
const CF_EXE = path.join(HERE, "cloudflared.exe");
/* 语音隧道专用配置：cloudflared 默认会读 ~/.cloudflared/config.yml，
 * 那个文件若是给别的命名隧道用的（本项目就是：api.zfsnnb.dpdns.org →
 * 3000，兜底 http_status:404），quick tunnel 的流量会全部命中 404 → 404，
 * 浏览器侧表现为加入失败 / Failed to fetch。所以必须显式 --config 隔离。 */
const CF_QUICK_CFG = path.join(HERE, "quick-tunnel.yml");
const PORT = 7880;
const GITHUB_LK = "https://api.github.com/repos/livekit/livekit/releases/latest";
const GITHUB_CF = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";

const C = {
  ok: (s) => console.log("  \x1b[32m✔\x1b[0m " + s),
  warn: (s) => console.log("  \x1b[33m!\x1b[0m " + s),
  err: (s) => console.log("  \x1b[31m✘\x1b[0m " + s),
  info: (s) => console.log("    " + s),
  title: (s) => console.log("\n\x1b[36m" + s + "\x1b[0m")
};

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (_) { return null; }
}
function writeState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n", "utf8");
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

/* cloudflared 必须直连 Cloudflare 边缘，不能被 HTTP(S) 代理劫持——
 * 否则控制连接/转发都走本地代理，隧道注册了 URL 却根本不转发（现象：
 * 本地 7880 正常，但 wss 域名返回 404 / Failed to fetch）。启动前清掉代理变量。 */
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
  "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
function cleanEnv() {
  const e = Object.assign({}, process.env);
  PROXY_KEYS.forEach(function (k) { delete e[k]; });
  return e;
}

/* 确保语音隧道有一份只指向 7880 的独立 ingress 配置，绕开全局 config.yml。 */
function ensureQuickCfg() {
  const body =
    "# 仅供 ZF语音「自建服务器」quick tunnel 使用，自动生成，请勿手改。\n" +
    "# 隔离目的是不读取 ~/.cloudflared/config.yml（那是给留言板命名隧道的，\n" +
    "# 兜底规则 http_status:404，会让语音隧道全部 404 → 浏览器 Failed to fetch）。\n" +
    "ingress:\n" +
    "  - service: http://127.0.0.1:" + PORT + "\n";
  try {
    if (!fs.existsSync(CF_QUICK_CFG) ||
        fs.readFileSync(CF_QUICK_CFG, "utf8").trim() !== body.trim()) {
      fs.writeFileSync(CF_QUICK_CFG, body, "utf8");
    }
  } catch (_) { /* 写不了就退回默认行为，run 里会打印告警 */ }
}

/* 隧道域名打印得很快，但在 Cloudflare 边缘真正可达通常要十几秒。
 * 先轮询到 http 200 再写 D1，避免后台记录指向一个「尚未就绪」的域名。 */
async function syncD1WhenReady(host, url) {
  C.title("等待隧道在 Cloudflare 边缘就绪（通常 10~30 秒）…");
  let ok = false;
  for (let i = 0; i < 30; i++) {
    if (await httpUp(url + "/", 5000)) { ok = true; break; }
    await sleep(2000);
  }
  if (ok) C.ok("隧道已在边缘可达。");
  else C.warn("隧道暂时还没在边缘生效；域名先同步过去，网页稍后刷新即可。");
  syncD1(host);
  if (ok) return;
  /* 边缘生效比 cloudflared 打印域名更慢，这里继续盯一会儿再给个明确结论，
     免得用户看到「未就绪」就以为失败了。 */
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    if (await httpUp(url + "/", 5000)) {
      C.ok("隧道已在边缘可达，网页现在可以进自建频道了。");
      return;
    }
  }
  C.warn("隧道 2 分钟仍未生效：检查本机网络 / 代理设置后重开一次。");
}

/* 可选：隧道就绪后，把新域名自动写回 Cloudflare 后台（D1）。
 * 由环境变量开关控制，普通 `node ... run` 不受影响：
 *   ZF_SYNC_D1=1      开启自动同步
 *   ZF_D1_ID=...      要更新的 self_hosted_servers.id
 *   ZF_D1_DB=zfsn-db  （可选）D1 库名
 * 临时隧道域名每次重启都会变，自动同步可免去手动改后台。 */
function syncD1(host) {
  const id = process.env.ZF_D1_ID;
  if (!id) { C.warn("已开启自动同步但没设置 ZF_D1_ID，跳过。"); return; }
  const db = process.env.ZF_D1_DB || "zfsn-db";
  const sql = "UPDATE self_hosted_servers SET host='" + host +
    "', port=443, tls=1, status='reachable' WHERE id='" + id + "';";
  C.title("自动同步新域名到 Cloudflare 后台（D1: " + db + "）");
  let out = "";
  // 直接用 node 执行 wrangler 的 JS 入口（args 数组），绕开 cmd/shell 的引号问题
  // —— SQL 含空格，走 shell 会被拆坏（wrangler 收到空 --command）。
  const wranglerJs = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!fs.existsSync(wranglerJs)) {
    C.warn("找不到 wrangler（node_modules/wrangler/bin/wrangler.js）。请先在 " + ROOT + " 执行 npm install。");
    C.info("手动把后台「自建 SFU 服务器」域名改为：" + host);
    return;
  }
  let cp;
  try {
    cp = spawn(process.execPath, [wranglerJs, "d1", "execute", db, "--remote",
      "--command", sql],
      { cwd: ROOT, windowsHide: true, env: process.env });
  } catch (e) {
    C.warn("启动 wrangler 失败：" + (e && e.message)); return;
  }
  cp.stdout.setEncoding("utf8"); cp.stdout.on("data", function (d) { out += d; });
  cp.stderr.setEncoding("utf8"); cp.stderr.on("data", function (d) { out += d; });
  cp.on("error", function (e) { C.warn("启动 wrangler 失败：" + (e && e.message)); });
  cp.on("close", function (code) {
    if (code === 0 && /"success"\s*:\s*true/.test(out)) {
      C.ok("已同步：后台服务器 host = " + host + "（网页可直接加入自建频道）");
    } else {
      C.warn("自动同步失败——请在后台把「自建 SFU 服务器」的域名手动改为：" + host);
      const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-3).join("  ");
      if (tail) C.info(tail);
    }
  });
}

/* ── 下载：curl 断点续传（GitHub 大文件在部分网络下只有几十 KB/s） ──
   单条连接超时/被代理掐断是常态，所以每轮都从 .part 的尾部继续，
   已下载的字节绝不重来。Windows 10+ 自带 curl.exe；没有 curl 时回退
   Node 内置 fetch。total 由 GitHub API 的 asset.size 提供。       */
function curlOnce(url, tmp) {
  return new Promise(function (resolve) {
    execFile("curl.exe", ["-L", "--fail", "--silent", "--show-error",
      "--connect-timeout", "20", "--max-time", "180", "-C", "-", "-o", tmp, url],
      { windowsHide: true, timeout: 190000 }, function (err, _out, stderr) {
        resolve({ err: err, stderr: String(stderr || "") });
      });
  });
}

async function fetchFallback(url, dest) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30 * 60 * 1000) });
  if (!res.ok || !res.body) throw new Error("HTTP " + res.status + "：" + url);
  const out = fs.createWriteStream(dest + ".part");
  for await (const chunk of res.body) {
    if (!out.write(chunk)) await new Promise(function (r) { out.once("drain", r); });
  }
  await new Promise(function (r) { out.end(r); });
  fs.renameSync(dest + ".part", dest);
}

async function downloadFile(url, dest, total) {
  const tmp = dest + ".part";
  if (fs.existsSync(dest)) return;
  let curlOK = true;
  for (let i = 0; i < 30; i++) {
    const have = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (total && have >= total) { fs.renameSync(tmp, dest); return; }
    if (i === 0 || i % 3 === 0) {
      C.info("下载中：已有 " + (have / 1048576).toFixed(1) + " MB" +
        (total ? " / " + (total / 1048576).toFixed(1) + " MB" : "") + "（断线会自动续传）");
    }
    let r;
    try { r = await curlOnce(url, tmp); }
    catch (e) { curlOK = false; break; }
    if (!r.err) { fs.renameSync(tmp, dest); return; }
    const now = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (total && now >= total) { fs.renameSync(tmp, dest); return; }
    if (/416|range/i.test(r.stderr)) { fs.renameSync(tmp, dest); return; }
    // curl 明确失败（404 / 证书 / DNS）不必重试 30 次
    if (/404|403|could not resolve|SSL|certificate/i.test(r.stderr)) {
      throw new Error("下载被拒绝：" + r.stderr.trim().slice(0, 200));
    }
  }
  if (!curlOK) { await fetchFallback(url, dest); return; }
  throw new Error("下载多次中断；已保留 .part，重跑 setup 会从断点继续");
}

/** Windows 自带 PowerShell 的 Expand-Archive，避免为解压引入 npm 依赖。 */
function unzip(zipPath, outDir) {
  return new Promise(function (resolve, reject) {
    fs.mkdirSync(outDir, { recursive: true });
    const cmd = "Expand-Archive -LiteralPath '" + zipPath.replace(/'/g, "''") +
      "' -DestinationPath '" + outDir.replace(/'/g, "''") + "' -Force";
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
      { windowsHide: true, timeout: 120000 }, function (err, _stdout, stderr) {
        if (err) reject(new Error("解压失败：" + (stderr || err.message)));
        else resolve();
      });
  });
}

function findFile(dir, filename) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.toLowerCase() === filename.toLowerCase()) return p;
    }
  }
  return null;
}

async function githubLatest(api, matcher) {
  const r = await fetch(api, { signal: AbortSignal.timeout(20000),
    headers: { "user-agent": "zfvoice-selfhost-setup" } });
  if (!r.ok) throw new Error("查询版本失败 HTTP " + r.status);
  const j = await r.json();
  const a = (j.assets || []).find(function (x) { return matcher.test(x.name); });
  if (!a) throw new Error("没有找到 Windows amd64 发布包：" + j.tag_name);
  return { tag: j.tag_name, url: a.browser_download_url, name: a.name, size: a.size };
}

async function ensureLiveKit() {
  if (fs.existsSync(LK_EXE)) return true;
  C.title("下载 LiveKit Server（官方 GitHub Release，约 19 MB）");
  try {
    const rel = await githubLatest(GITHUB_LK, /windows_amd64\.zip$/i);
    C.info("版本 " + rel.tag + " / " + rel.name);
    const zip = path.join(HERE, rel.name);
    await downloadFile(rel.url, zip, rel.size);
    const dir = path.join(HERE, "_unpack");
    await unzip(zip, dir);
    const exe = findFile(dir, "livekit-server.exe");
    if (!exe) throw new Error("压缩包里没有 livekit-server.exe");
    fs.copyFileSync(exe, LK_EXE);
    fs.rmSync(zip, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    C.ok("LiveKit Server 已就绪：" + LK_EXE);
    return true;
  } catch (e) {
    C.err("自动下载失败：" + e.message);
    C.info("请手动到 https://github.com/livekit/livekit/releases 下载 windows_amd64.zip，");
    C.info("把里面的 livekit-server.exe 放到 " + HERE + "，再重跑 setup。");
    return false;
  }
}

async function ensureCloudflared() {
  if (fs.existsSync(CF_EXE)) return true;
  C.title("下载 cloudflared（Cloudflare Tunnel 客户端，约 53 MB）");
  try {
    const rel = await githubLatest(GITHUB_CF, /^cloudflared-windows-amd64\.exe$/i);
    C.info("版本 " + rel.tag);
    await downloadFile(rel.url, CF_EXE, rel.size);
    C.ok("cloudflared 已就绪：" + CF_EXE);
    return true;
  } catch (e) {
    C.err("自动下载失败：" + e.message);
    C.info("请手动下载 https://github.com/cloudflare/cloudflared/releases/latest");
    C.info("把 cloudflared-windows-amd64.exe 改名为 cloudflared.exe 放到 " + HERE);
    return false;
  }
}

/* ── setup：密钥 + 配置 ──────────────────────────────────────── */
async function setup(opts) {
  C.title("ZF语音 · 本机语音媒体后端初始化");
  C.info("账号 / 登录 / 频道数据仍由 Cloudflare Worker 管理，本机只转发语音与屏幕共享。\n");

  let st = readState();
  if (st && st.apiKey && st.apiSecret) {
    C.ok("沿用已有密钥（如需强制重置，先删除 server.json）");
  } else {
    st = {
      createdAt: new Date().toISOString(),
      apiKey: crypto.randomBytes(12).toString("hex"),
      apiSecret: crypto.randomBytes(32).toString("base64url"),
      listenPort: PORT,
      publicHost: null,
      publicPort: 443,
      tunnelUrl: null,
      livekitVersion: null
    };
    C.ok("已生成一对新的 API Key / Secret（只存在本机）");
  }

  const yaml = fs.readFileSync(TEMPLATE, "utf8")
    .replace(/REPLACE_WITH_API_KEY/g, st.apiKey)
    .replace(/REPLACE_WITH_API_SECRET/g, st.apiSecret);
  fs.writeFileSync(YAML_FILE, yaml, "utf8");
  C.ok("已生成 " + YAML_FILE);

  fs.writeFileSync(SECRETS_FILE,
    "# 本机生成，含真实密钥，已 gitignore，不要外发、不要提交\n" +
    "LIVEKIT_API_KEY=" + st.apiKey + "\n" +
    "LIVEKIT_API_SECRET=" + st.apiSecret + "\n", "utf8");
  C.ok("已生成 " + SECRETS_FILE + "（供注入 Worker 时复制）");
  writeState(st);

  const lkOK = await ensureLiveKit();
  const cfOK = opts && opts.noTunnel ? true : await ensureCloudflared();
  if (!lkOK) return false;
  if (!cfOK) C.warn("没有 cloudflared：仍可在局域网用 ws:// 调试，但 HTTPS 站点需要 wss 域名。");

  C.title("初始化完成");
  C.ok("下一步：双击 start.bat，或运行 node tools/livekit/voice-media-server.mjs run");
  return true;
}

/* ── 端口 / 进程 ────────────────────────────────────────────── */
async function httpUp(url, ms) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms || 1200), redirect: "manual" });
    return r.status > 0;
  } catch (_) { return false; }
}

function killByPort(port) {
  return new Promise(function (resolve) {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue | " +
      "Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { " +
      "Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"],
      { windowsHide: true }, function () { resolve(); });
  });
}

function printBackendValues(st) {
  C.title("后台「自建 SFU 服务器」请这样填（截图里那条 unknown 记录要改）");
  console.log("    名称      ：家里电脑");
  console.log("    域名      ：" + (st.publicHost || "<启动隧道后自动生成>") + "   ← 不要带 https://");
  console.log("    端口      ：" + st.publicPort + "   ← 隧道是 443，不是 7880");
  console.log("    使用 TLS  ：勾选（wss）");
  C.title("Cloudflare Worker 需要注入的密钥（另开终端，在 D:\\ZFSNwebsite 执行）");
  console.log("    npx wrangler secret put LIVEKIT_API_KEY      → " + st.apiKey);
  console.log("    npx wrangler secret put LIVEKIT_API_SECRET   → " + st.apiSecret);
  C.warn("这两个值必须和本机 livekit.yaml 完全一致，否则 Worker 签发的令牌会被 LiveKit 拒绝。");
}

/* Windows 防火墙默认会丢掉入站包：媒体走 UDP 50000-50100（TCP 7881 是回退），
 * 没放行时典型表现是「能进频道，但听不到声音 / 共享黑屏」，很容易被误判成
 * 后端没起来。这里做一次幂等放行；不是管理员时只提示，不阻塞启动。 */
function ensureFirewall() {
  if (process.platform !== "win32") return;
  const rules = [
    ["ZFVoice LiveKit UDP", "udp", "50000-50100"],
    ["ZFVoice LiveKit TCP", "tcp", "7880-7881"]
  ];
  rules.forEach(function (r) {
    execFile("netsh.exe", ["advfirewall", "firewall", "show", "rule", "name=" + r[0]],
      { windowsHide: true }, function (err) {
        if (!err) return; // 已放行过
        execFile("netsh.exe", ["advfirewall", "firewall", "add", "rule",
          "name=" + r[0], "dir=in", "action=allow", "protocol=" + r[1],
          "localport=" + r[2], "profile=any", "enable=yes"],
          { windowsHide: true }, function (e2) {
            if (e2) {
              C.warn("未能自动放行防火墙 " + r[2] + "/" + r[1] +
                "（需要管理员权限）：右键 start-selfhost.bat → 以管理员身份运行一次即可。");
            } else {
              C.ok("已放行防火墙入站 " + r[1].toUpperCase() + " " + r[2]);
            }
          });
      });
  });
}

/* ── run：LiveKit + Tunnel 一起跑 ────────────────────────────── */
async function run() {
  let st = readState();
  if (!st || !fs.existsSync(LK_EXE) || !fs.existsSync(YAML_FILE)) {
    if (!await setup({ noTunnel: false })) return;
    st = readState();
  }
  if (!fs.existsSync(LK_EXE)) { C.err("缺少 livekit-server.exe，请先跑 setup"); return; }

  if (await httpUp("http://127.0.0.1:" + PORT + "/")) {
    C.warn("端口 " + PORT + " 已被占用（可能已经有一个后端在跑）。先停掉旧的再启动。");
    await killByPort(PORT);
    await sleep(800);
  }

  C.title("启动 LiveKit Server（媒体转发）");
  ensureFirewall();
  const lk = spawn(LK_EXE, ["--config", YAML_FILE], {
    cwd: HERE, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: cleanEnv()
  });
  let lkAlive = true;
  lk.on("exit", function () { lkAlive = false; });
  /* LiveKit 习惯用 ERROR / WARN 级别打环境探测告警（比如「CPU 监控不支持」
     「外网 IP 校验被取消」），实例其实已经正常跑起来了。全标成红叉会让人
     以为启动失败，所以只有 FATAL / panic 才算真错，其余降级为黄色提示。 */
  let hinted = false;
  ["stdout", "stderr"].forEach(function (ch) {
    lk[ch].setEncoding("utf8");
    lk[ch].on("data", function (d) {
      String(d).split(/\r?\n/).filter(Boolean).forEach(function (line) {
        const t = line.trim();
        if (/FATAL|panic|failed to start|no such host|permission denied|address already in use/i.test(t)) {
          C.err("[媒体] " + t);
        } else if (/error|warn/i.test(t)) {
          C.warn("[媒体] " + t);
          if (!hinted) {
            hinted = true;
            C.info("（上面这类 WARN/ERROR 是 LiveKit 对环境探测的常规告警，不影响语音与共享）");
          }
        } else if (process.env.ZF_VERBOSE) C.info("[媒体] " + t);
      });
    });
  });

  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (await httpUp("http://127.0.0.1:" + PORT + "/")) { ready = true; break; }
    if (!lkAlive) break;
    await sleep(400);
  }
  if (!ready) {
    C.err("LiveKit 没能在 16 秒内监听 " + PORT + "，请检查上面的错误日志。");
    try { lk.kill(); } catch (_) {}
    return;
  }
  C.ok("媒体服务已监听 ws://127.0.0.1:" + PORT + "（UDP 50000-50100 / TCP 7881）");

  let cf = null;
  if (fs.existsSync(CF_EXE)) {
    C.title("启动 Cloudflare Tunnel（给 HTTPS 站点一个可信的 wss 域名）");
    ensureQuickCfg();
    cf = spawn(CF_EXE, ["tunnel", "--no-autoupdate",
      "--config", CF_QUICK_CFG,
      "--url", "http://127.0.0.1:" + PORT],
      { cwd: HERE, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: cleanEnv() });
    const onData = function (d) {
      const m = String(d).match(/https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i);
      if (m && st.publicHost !== m[1]) {
        st.publicHost = m[1];
        st.tunnelUrl = "https://" + m[1];
        st.publicPort = 443;
        writeState(st);
        C.ok("wss 域名：" + st.tunnelUrl + "（已写入 server.json）");
        printBackendValues(st);
        C.title("现在可以用了（关掉窗口或 Ctrl+C 会同时停掉两个服务）");
        C.ok("窗口里出现过的红色 ✘ 如果是「CPU monitoring unsupported」「could not validate external IP」，都只是告警，不影响使用。");
        C.info("接下来：刷新网页 → 点「家里电脑」频道 → 允许麦克风即可语音 / 共享屏幕。");
        C.info("别人听不到你：先确认本机防火墙放行了 UDP 50000-50100（本脚本会自动尝试）。");
        C.info("局域网调试地址：ws://" + localIP() + ":" + PORT);
        if (process.env.ZF_SYNC_D1) {
          syncD1WhenReady(st.publicHost, st.tunnelUrl);
        } else {
          C.warn("注意：临时隧道域名每次重启都会变，变了就要回后台更新那条服务器记录。");
        }
      }
    };
    cf.stdout.setEncoding("utf8"); cf.stdout.on("data", onData);
    cf.stderr.setEncoding("utf8"); cf.stderr.on("data", onData);
    cf.on("exit", function () { C.warn("Tunnel 进程已退出"); });
  } else {
    C.warn("没有 cloudflared，跳过隧道。只能局域网内用 ws:// 调试（HTTPS 页面会被混合内容拦截）。");
    printBackendValues(st);
  }

  let stopping = false;
  const shutdown = function () {
    if (stopping) return; stopping = true;
    C.title("正在停止本机语音媒体后端…");
    try { if (cf) cf.kill(); } catch (_) {}
    try { lk.kill(); } catch (_) {}
    setTimeout(function () { process.exit(0); }, 500);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", function () {
    try { if (cf) cf.kill(); } catch (_) {}
    try { lk.kill(); } catch (_) {}
  });
  // 前台保持：任何一边退出都关掉另一边，避免留下半死不活的后端
  lk.on("exit", function () {
    if (!stopping) { C.err("LiveKit 意外退出，一并停止 Tunnel"); shutdown(); }
  });
  await new Promise(function () {});
}

/* ── 本机网络信息 ───────────────────────────────────────────── */
function localIP() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out[0] || "127.0.0.1";
}
function hasIPv6() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv6" && !n.internal && !/^fe80/i.test(n.address)) return n.address;
    }
  }
  return null;
}

/* ── doctor：连通性自检 ─────────────────────────────────────── */
async function doctor() {
  C.title("ZF语音 · 本机语音媒体后端自检");
  const st = readState();
  const check = function (label, ok, hint) {
    if (ok) C.ok(label); else { C.err(label); if (hint) C.info(hint); }
  };
  check("LiveKit 二进制", fs.existsSync(LK_EXE), "先跑 setup");
  check("cloudflared 二进制", fs.existsSync(CF_EXE), "HTTPS 站点必须有 wss 域名");
  check("livekit.yaml 与密钥", fs.existsSync(YAML_FILE) && !!(st && st.apiKey),
    "先跑 setup");
  const running = await httpUp("http://127.0.0.1:" + PORT + "/");
  check("本机 7880 媒体服务正在运行", running, "双击 start.bat 启动");

  C.title("网络环境");
  C.info("局域网 IPv4：" + localIP() + "（同 WiFi 的设备可用 ws://" + localIP() + ":" + PORT + " 调试）");
  const v6 = hasIPv6();
  C.info("公网 IPv6：" + (v6 || "无（若双方都有 IPv6，媒体可直连，不需要端口转发）"));
  try {
    const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(4000) });
    C.info("出口公网 IPv4：" + (await r.json()).ip);
  } catch (_) { C.info("出口公网 IP：探测失败（不影响局域网使用）"); }

  if (st && st.publicHost) {
    const tunnelOK = await httpUp(st.tunnelUrl + "/", 5000);
    check("wss 隧道域名 " + st.publicHost + " 可达", tunnelOK,
      "隧道域名是临时的，重启后端会变；请重新运行 start.bat 并更新后台记录");
    C.info("后台应填：域名 " + st.publicHost + " / 端口 " + st.publicPort + " / 勾选 TLS");
  } else {
    C.warn("还没有 wss 域名：运行 start.bat 会自动生成");
  }

  C.title("媒体通道的现实限制（重要）");
  C.info("· 信令（WebSocket）走 Cloudflare Tunnel 的 443 端口，一定可达。");
  C.info("· 语音 / 屏幕共享的媒体是 WebRTC over UDP 50000-50100（TCP 7881 回退）。");
  C.info("· 如果家里宽带是运营商大内网（CGNAT，出口 IP 与路由器 WAN 不一致），");
  C.info("  外网朋友的媒体包到不了这台电脑，需要在路由器转发 UDP 端口，或用");
  C.info("  Tailscale / ZeroTier 与朋友组虚拟局域网；同一 WiFi 下完全不受影响。");
  C.info("· 在后台点「测试连接」只能验证 HTTP 信令端口，不能验证 UDP 媒体。");

  C.title("Worker 侧对齐检查");
  C.info("本机密钥：" + (st ? st.apiKey : "<未生成>"));
  C.info("执行 npx wrangler secret list 确认 LIVEKIT_API_KEY / LIVEKIT_API_SECRET 已注入；");
  C.info("两边不一致时，join 会返回令牌但 LiveKit 会拒绝连接（401）。");
}

/* ── print / stop ───────────────────────────────────────────── */
function print() {
  const st = readState();
  if (!st) { C.err("还没初始化，先跑 setup 或 start.bat"); return; }
  printBackendValues(st);
  console.log("\n  本机地址：ws://" + localIP() + ":" + PORT);
  console.log("  配置文件：" + YAML_FILE);
}

async function stop() {
  C.title("停止本机语音媒体后端");
  await killByPort(PORT);
  await sleep(500);
  C.ok(await httpUp("http://127.0.0.1:" + PORT + "/")
    ? "端口 7880 仍被占用，请手动结束 livekit-server.exe"
    : "已停止");
}

/* ── 入口 ───────────────────────────────────────────────────── */
const cmd = (process.argv[2] || "run").toLowerCase();
console.log("\n  ZF语音 · 本机语音媒体后端（账号数据仍在 Cloudflare Worker）");
try {
  if (cmd === "setup") { if (!await setup({ noTunnel: false })) process.exitCode = 1; }
  else if (cmd === "run") await run();
  else if (cmd === "doctor") await doctor();
  else if (cmd === "print") print();
  else if (cmd === "stop") await stop();
  else {
    C.err("未知命令：" + cmd);
    C.info("可用：setup / run / doctor / print / stop");
    process.exitCode = 1;
  }
} catch (e) {
  C.err("执行失败：" + (e && e.stack || e));
  process.exitCode = 1;
}
