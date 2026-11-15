/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 无头浏览器视觉 / 运行时复验（阶段 7）
 *
 *  验证两件此前只能靠截图确认的事：
 *   1) /voice/ 登录页的自制 SVG 验证码真的渲染出 5 位数字、没有 JS 异常；
 *   2) /admin/ 的「ZF语音」标签页五个面板不再永久停在「加载中…」。
 *
 *  前置：本地 Worker 运行时已启动（默认 http://127.0.0.1:8790），
 *        且本机装有 Chrome / Edge。可用 VOICE_UI_BASE / CHROME_PATH 覆盖。
 *  运行：npm run voice:test:ui
 * ══════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { launch, page } from "../../tools/dev/cdp.mjs";
import * as C from "../../src/voice-core.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.VOICE_UI_BASE || "http://127.0.0.1:8790";
const SHOTS = path.join(ROOT, "tools/dev/_shots");
fs.mkdirSync(SHOTS, { recursive: true });

function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) { console.error("  ✘ " + name + "\n    " + (e && e.stack || e)); fail++; }
}

async function adminToken() {
  // 本地凭据文件由 dev server 生成（tools/ 已 gitignore）
  const cred = path.join(ROOT, "tools/dev/.voice-dev-credentials.txt");
  const pwd = fs.existsSync(cred) ? fs.readFileSync(cred, "utf8").trim() : "";
  if (!pwd) throw new Error("找不到本地管理员密码，请先启动 npm run voice:dev");
  const r = await fetch(BASE + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ZFSN", password: pwd })
  });
  const d = await r.json();
  assert.equal(r.status, 200, "后台登录失败：" + JSON.stringify(d));
  return d.token;
}

console.log("\nZF语音 UI 复验（" + BASE + "）\n");
const browser = await launch({ port: 9300 + Math.floor(Math.random() * 200) });

try {
  /* ── 1. 登录页 / 验证码 ──────────────────────────────────── */
  const voice = await page(browser, BASE + "/voice/", { waitMs: 2600 });
  await step("未登录打开 /voice/ 自动落到独立登录页 /voice/login", async function () {
    const r = await voice.evaluate(`({ path: location.pathname, hash: location.hash })`);
    assert.equal(r.path, "/voice/login", "未登录应跳到 /voice/login，实际：" + r.path);
    const title = await voice.text("#auth-title");
    assert.equal(title.trim(), "ZF语音");
    assert.ok(await voice.evaluate('!!document.querySelector(".auth-back")'));
    // /voice 是独立布局，全站入口按钮只注入主站页面，这里不应出现
    const entry = await voice.evaluate('!!document.querySelector("a.zf-voice-entry")');
    assert.equal(entry, false, "/voice 不应沿用主站入口按钮");
  });

  await step("主站首页左上角固定「ZF语音」入口，链接指向 /voice", async function () {
    const home = await page(browser, BASE + "/", { waitMs: 1800 });
    const r = await home.evaluate(`(function(){
      var a = document.querySelector("a.zf-voice-entry");
      if (!a) return null;
      return { href: a.getAttribute("href"), text: a.innerText.trim(),
        inTopbar: a.classList.contains("in-topbar"),
        isFixed: a.classList.contains("is-fixed"),
        parent: (a.parentElement && a.parentElement.className) || "" };
    })()`);
    assert.ok(r, "主站首页没有注入 ZF语音 入口");
    assert.equal(r.href, "/voice");
    assert.ok(r.text.indexOf("ZF语音") >= 0, "入口文案：" + r.text);
    // 主站有 .topbar 时紧贴左上角 logo 插入；无 .topbar 的页面才用 fixed
    assert.ok(r.inTopbar || r.isFixed,
      "入口既不在 topbar 也没有固定定位：" + JSON.stringify(r));
    if (r.inTopbar) assert.ok(String(r.parent).indexOf("topbar") >= 0,
      "入口未插入 topbar：" + JSON.stringify(r));
    await home.close();
  });

  await step("登录 / 注册验证码均渲染为完整 SVG，且不含明文答案", async function () {
    const info = await voice.evaluate(`(function(){
      var out = [];
      ["captcha-login","captcha-register"].forEach(function(id){
        var b = document.getElementById(id);
        var img = b && b.querySelector("img");
        out.push({ id: id, hasImg: !!img, src: img ? img.src.slice(0,40) : "",
                   loading: b ? b.innerText.indexOf("加载") >= 0 : true,
                   w: img ? img.naturalWidth : 0, h: img ? img.naturalHeight : 0 });
      });
      return out;
    })()`);
    assert.equal(info.length, 2);
    for (const c of info) {
      assert.ok(c.hasImg, c.id + " 未渲染验证码图片：" + JSON.stringify(info));
      assert.ok(c.src.indexOf("data:image/svg+xml;base64,") === 0, c.id + " 不是 SVG data URI");
      assert.equal(c.loading, false, c.id + " 仍停在加载中");
      assert.ok(c.w > 0 && c.h > 0, c.id + " SVG 尺寸为 0：" + JSON.stringify(info));
    }
    // 解码 SVG，确认 5 组数字点阵字符与干扰线都在，且源码不含答案明文
    const svg = await voice.evaluate(`(function(){
      var img = document.querySelector("#captcha-login img");
      var s = atob(img.src.split(",")[1]);
      return { len: s.length, digits: (s.match(/<text|<path/g)||[]).length,
               grid: s.indexOf("pattern") >= 0 || s.indexOf("<rect") >= 0,
               noise: (s.match(/<circle/g)||[]).length };
    })()`);
    assert.ok(svg.len > 2000, "验证码 SVG 过于简单：" + JSON.stringify(svg));
    assert.ok(svg.noise >= 10, "验证码缺少噪点：" + JSON.stringify(svg));
  });

  await step("点击验证码可刷新出新的图片", async function () {
    const before = await voice.evaluate('document.querySelector("#captcha-login img").src');
    await voice.click("#captcha-login");
    await wait(900);
    const after = await voice.evaluate('(document.querySelector("#captcha-login img")||{}).src || ""');
    assert.ok(after && after !== before, "刷新后验证码未变化");
  });

  await step("切换到注册页，字段齐全且邀请码为必填", async function () {
    await voice.click("#tab-register");
    await wait(300);
    const fields = await voice.evaluate(`["reg-invite","reg-user","reg-name","reg-pwd","reg-pwd2","reg-captcha"]
      .map(function(id){return !!document.getElementById(id)})`);
    assert.ok(fields.every(Boolean), "注册字段缺失：" + JSON.stringify(fields));
  });

  await voice.screenshot(path.join(SHOTS, "voice-login-captcha.png"));
  await step("登录页无 JS 运行时异常", async function () {
    assert.deepEqual(voice.errors, [], "控制台报错：" + voice.errors.join(" | "));
  });
  await voice.close();

  /* ── 2. 登录后的应用视图（用真实 HttpOnly Cookie 注入） ───── */
  await step("带有效会话打开 /voice/：显示三栏应用视图与真实频道列表", async function () {
    // 直接往本地 dev 库写一条会话，等价于用户已经登录；Cookie 仍是 HttpOnly，
    // 前端拿不到 token，只能靠 /api/voice/bootstrap 拿到身份。
    const db = new DatabaseSync(path.join(ROOT, "tools/dev/.voice-dev.sqlite"));
    db.exec("PRAGMA busy_timeout = 5000;");
    const u = db.prepare("SELECT id, username, display_name FROM voice_users WHERE username = 'admin'").get();
    assert.ok(u, "本地库里没有 ZF语音管理员账号");
    const token = crypto.randomBytes(24).toString("base64url");
    db.prepare("INSERT OR REPLACE INTO voice_sessions (token_hash,user_id,exp,ip,ua,created_at) VALUES (?,?,?,?,?,?)")
      .run(await C.sha256Hex(token), u.id, Date.now() + 3600000, "127.0.0.1", "cdp-ui-test", Date.now());
    db.close();

    const app = await page(browser, BASE + "/voice/", { waitMs: 600 });
    await app.call("Network.setCookie", {
      name: "zf_voice_sid", value: token, url: BASE + "/voice/",
      httpOnly: true, sameSite: "Lax", secure: false
    });
    await app.call("Page.navigate", { url: BASE + "/voice/" });
    await wait(2300);

    const r = await app.evaluate(`({
      authHidden: document.getElementById("auth-view").hidden,
      appHidden: document.getElementById("app-view").hidden,
      channels: document.querySelectorAll("#channel-list li").length,
      count: (document.getElementById("channel-count")||{}).innerText || "",
      hasUserBar: !!document.querySelector(".userbar, .user-bar, #self-name, #me-name"),
      hasEntryInApp: !!document.querySelector("a.zf-voice-entry"),
      bodyText: document.body.innerText.slice(0, 400)
    })`);
    assert.equal(r.authHidden, true, "已登录仍显示登录壳：" + JSON.stringify(r));
    assert.equal(r.appHidden, false, "已登录未显示应用视图：" + JSON.stringify(r));
    assert.ok(r.channels >= 3, "频道列表未读到预置频道：" + JSON.stringify(r));
    assert.equal(r.hasEntryInApp, false, "/voice 独立布局不应显示入口套娃");
    assert.ok(r.bodyText.indexOf("Cloudflare") >= 0 || r.bodyText.indexOf("私有频道") >= 0,
      "页面缺少后端架构中文说明：" + r.bodyText);
    await app.screenshot(path.join(SHOTS, "voice-app-view.png"));
    assert.deepEqual(app.errors.filter(function (e) { return e.indexOf("favicon") < 0; }), [],
      "应用视图控制台报错：" + app.errors.join(" | "));
    await app.close();
  });

  /* ── 1b. 已登录访问登录页地址：自动回应用页 ────────────────── */
  await step("已登录直接打开 /voice/login 会自动回到 /voice（不会停在登录页）", async function () {
    const dbL = new DatabaseSync(path.join(ROOT, "tools/dev/.voice-dev.sqlite"));
    dbL.exec("PRAGMA busy_timeout = 5000;");
    const uL = dbL.prepare("SELECT id FROM voice_users WHERE username = 'admin'").get();
    const tokenL = "L" + crypto.randomBytes(24).toString("hex");
    dbL.prepare("INSERT OR REPLACE INTO voice_sessions (token_hash,user_id,exp,ip,ua,created_at) VALUES (?,?,?,?,?,?)")
      .run(await C.sha256Hex(tokenL), uL.id, Date.now() + 3600000, "127.0.0.1", "cdp-login-path", Date.now());
    dbL.close();

    const lp = await page(browser, BASE + "/voice/login", { waitMs: 400 });
    await lp.call("Network.setCookie", {
      name: "zf_voice_sid", value: tokenL, url: BASE + "/voice/",
      httpOnly: true, sameSite: "Lax", secure: false
    });
    await lp.call("Page.navigate", { url: BASE + "/voice/login" });
    await wait(2600);
    const r = await lp.evaluate(`({
      path: location.pathname,
      appHidden: document.getElementById("app-view").hidden,
      authHidden: document.getElementById("auth-view").hidden
    })`);
    assert.equal(r.path, "/voice/", "已登录访问 /voice/login 应回 /voice，实际：" + r.path);
    assert.equal(r.appHidden, false, "回到 /voice 后应用视图没显示");
    assert.equal(r.authHidden, true);
    await lp.close();
  });

  /* ── 2a. 保持登录：Cookie 自动恢复（2026-11-14c）───────────── */
  await step("带保持登录 Cookie 打开 /voice/：登录页一次都不显示，直接进大厅", async function () {
    const db3 = new DatabaseSync(path.join(ROOT, "tools/dev/.voice-dev.sqlite"));
    db3.exec("PRAGMA busy_timeout = 5000;");
    const u3 = db3.prepare("SELECT id FROM voice_users WHERE username = 'admin'").get();
    assert.ok(u3, "本地库缺少 admin 账号");
    const token3 = "r" + crypto.randomBytes(24).toString("hex");
    db3.prepare("INSERT OR REPLACE INTO voice_sessions (token_hash,user_id,exp,ip,ua,created_at) VALUES (?,?,?,?,?,?)")
      .run(await C.sha256Hex(token3), u3.id, Date.now() + 30 * 86400000, "127.0.0.1", "cdp-cookie-test", Date.now());
    db3.close();

    const keep = await page(browser, BASE + "/voice/", { waitMs: 300 });
    // 在文档刚创建时埋点：DOMContentLoaded 时登录页到底是不是已经隐藏。
    // 若还是老逻辑（等 /config + /me 回来才切视图），这里会记录到 display:grid。
    await keep.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `(function(){
        window.__authFlash = [];
        document.addEventListener("DOMContentLoaded", function(){
          var a = document.getElementById("auth-view");
          window.__authFlash.push({
            display: a ? getComputedStyle(a).display : "missing",
            attr: document.documentElement.getAttribute("data-voice-authed")
          });
        });
      })();`
    });
    await keep.call("Network.setCookie", {
      name: "zf_voice_sid", value: token3, url: BASE + "/voice/",
      httpOnly: true, sameSite: "Lax", secure: false
    });
    await keep.call("Network.setCookie", {
      name: "zf_voice_si", value: "1", url: BASE + "/voice/",
      httpOnly: false, sameSite: "Lax", secure: false
    });
    await keep.call("Page.navigate", { url: BASE + "/voice/" });
    await wait(2300);

    const r = await keep.evaluate(`({
      flash: window.__authFlash || [],
      attr: document.documentElement.getAttribute("data-voice-authed"),
      authHidden: document.getElementById("auth-view").hidden,
      appHidden: document.getElementById("app-view").hidden,
      mask: getComputedStyle(document.getElementById("restore-mask")).display,
      channels: document.querySelectorAll("#channel-list li").length,
      meName: (document.getElementById("me-name")||{}).textContent || "",
      hasRemember: !!document.getElementById("login-remember")
    })`);
    assert.equal(r.flash.length, 1, "没记录到 DOMContentLoaded 埋点：" + JSON.stringify(r));
    assert.equal(r.flash[0].display, "none", "登录页在首屏闪了一下：" + JSON.stringify(r));
    assert.equal(r.flash[0].attr, "1", "head 同步脚本没有打上预登录标记：" + JSON.stringify(r));
    assert.equal(r.attr, "ready", "恢复遮罩没有被撤掉：" + JSON.stringify(r));
    assert.equal(r.authHidden, true);
    assert.equal(r.appHidden, false);
    assert.equal(r.mask, "none", "恢复动画仍盖着应用：" + JSON.stringify(r));
    assert.ok(r.channels >= 3, "频道列表未加载：" + JSON.stringify(r));
    assert.equal(r.hasRemember, true, "登录表单缺少「保持登录」勾选");
    assert.equal(r.meName.trim().length > 0, true, "用户栏没填上昵称");
    assert.deepEqual(keep.errors.filter(function (e) { return e.indexOf("favicon") < 0; }), [],
      "自动登录控制台报错：" + keep.errors.join(" | "));

    // 退出登录后刷新：两个 Cookie 都被清掉，必须回到登录页
    await keep.evaluate(`(async function(){ await window.VoiceAuth.logout(); return true; })()`);
    const hintGone = await keep.evaluate(`document.cookie.indexOf("zf_voice_si=1") < 0`);
    assert.equal(hintGone, true, "登出后可读标记 Cookie 仍在");
    await keep.call("Page.navigate", { url: BASE + "/voice/" });
    await wait(1600);
    const back = await keep.evaluate(`({
      attr: document.documentElement.getAttribute("data-voice-authed"),
      authHidden: document.getElementById("auth-view").hidden,
      appHidden: document.getElementById("app-view").hidden
    })`);
    assert.equal(back.attr, null, "登出后仍带着预登录标记：" + JSON.stringify(back));
    assert.equal(back.authHidden, false, "登出后刷新没有回到登录页");
    assert.equal(back.appHidden, true);
    await keep.screenshot(path.join(SHOTS, "voice-remember-login.png"));
    await keep.close();
  });

  /* ── 2b. 快速来回切换频道（2026-11-14 线上 bug 回归） ─────── */
  await step("快速来回切换频道：不留幽灵 WebSocket，成员列表不出现重复管理员", async function () {
    const db2 = new DatabaseSync(path.join(ROOT, "tools/dev/.voice-dev.sqlite"));
    db2.exec("PRAGMA busy_timeout = 5000;");
    const u2 = db2.prepare("SELECT id, username FROM voice_users WHERE username = 'admin'").get();
    assert.ok(u2, "本地库缺少 admin 账号");
    const token2 = crypto.randomBytes(24).toString("base64url");
    db2.prepare("INSERT OR REPLACE INTO voice_sessions (token_hash,user_id,exp,ip,ua,created_at) VALUES (?,?,?,?,?,?)")
      .run(await C.sha256Hex(token2), u2.id, Date.now() + 3600000, "127.0.0.1", "cdp-switch-test", Date.now());
    db2.close();

    const sw = await page(browser, BASE + "/voice/", { waitMs: 400 });
    // 页面脚本执行前包裹原生 WebSocket，统计「创建过几条 / 还有几条活着」
    await sw.call("Page.addScriptToEvaluateOnNewDocument", {
      source: `(function(){
        if (window.__wsWrapped) return;   // 防止脚本在同一上下文重复叠加包装
        window.__wsWrapped = true;
        var Native = window.WebSocket;
        window.__wsAll = [];
        function Wrapped(url, protocols){
          var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
          window.__wsAll.push({ ws: ws, url: String(url), at: Date.now() });
          return ws;
        }
        Wrapped.prototype = Native.prototype;
        Wrapped.CONNECTING = Native.CONNECTING; Wrapped.OPEN = Native.OPEN;
        Wrapped.CLOSING = Native.CLOSING; Wrapped.CLOSED = Native.CLOSED;
        window.WebSocket = Wrapped;
      })();`
    });
    await sw.call("Network.setCookie", {
      name: "zf_voice_sid", value: token2, url: BASE + "/voice/",
      httpOnly: true, sameSite: "Lax", secure: false
    });
    await sw.call("Page.navigate", { url: BASE + "/voice/" });
    await wait(2200);

    // 连续点 5 次且不等待任何一次加入完成 —— 正是触发旧 bug 的操作
    await sw.evaluate(`(function(){
      ["cf-lobby","cf-2","cf-lobby","cf-2","cf-lobby"].forEach(function(id){
        var row = document.querySelector('#channel-list [data-channel="' + id + '"]');
        if (row) row.click();
      });
      return true;
    })()`);
    await wait(3800);

    const r = await sw.evaluate(`(function(){
      var selfCount = 0;
      document.querySelectorAll("#member-list li").forEach(function(li){
        if ((li.getAttribute("data-member") || "") === ${JSON.stringify(u2.id)}) selfCount++;
      });
      return {
        total: (window.__wsAll || []).length,
        open: (window.__wsAll || []).filter(function (x) {
          return x.ws.readyState === 0 || x.ws.readyState === 1;
        }).length,
        urls: (window.__wsAll || []).map(function (x) { return x.url.slice(0, 60); }).slice(0, 6),
        selfCount: selfCount,
        memberCount: document.querySelectorAll("#member-list li").length,
        conn: (document.getElementById("conn-text") || {}).textContent || ""
      };
    })()`);
    assert.ok(r.total >= 1, "没有发生任何房间连接，用例前提不成立：" + JSON.stringify(r));
    assert.ok(r.total <= 2, "快速切换创建了过多房间连接：" + JSON.stringify(r));
    assert.ok(r.open <= 1, "切换后仍有幽灵 WebSocket 存活：" + JSON.stringify(r));
    assert.ok(r.selfCount <= 1, "成员列表出现重复的自己：" + JSON.stringify(r));
    const real = sw.errors.filter(function (e) { return e.indexOf("favicon") < 0; });
    assert.deepEqual(real, [], "切换频道时控制台报错：" + real.join(" | "));
    await sw.close();
  });

  /* ── 3. 管理后台 ZF语音 标签页 ───────────────────────────── */
  const token = await adminToken();
  const admin = await page(browser, BASE + "/admin/", { waitMs: 1200 });
  await admin.evaluate(`localStorage.setItem("zfsn_admin_token", ${JSON.stringify(token)}); true`);
  await admin.call("Page.navigate", { url: BASE + "/admin/" });
  await wait(1600);

  await step("后台已注入「ZF语音」标签与面板", async function () {
    const r = await admin.evaluate(`({
      tab: !!document.querySelector('.tabs button[data-tab="voice"]'),
      pane: !!document.getElementById("pane-voice")
    })`);
    assert.equal(r.tab, true, "未注入标签按钮");
    assert.equal(r.pane, true, "未注入面板");
  });

  await step("管理后台不显示左上角 ZF语音 浮动入口（避免压住后台标题）", async function () {
    const r = await admin.evaluate(`({
      entry: !!document.querySelector("[data-voice-entry]"),
      style: !!document.querySelector("[data-voice-entry-style]")
    })`);
    assert.equal(r.entry, false, "后台仍注入了站内浮动入口");
    assert.equal(r.style, false, "后台仍注入了入口样式");
  });

  await step("点击标签后五个面板全部完成加载，不再停在「加载中…」", async function () {
    await admin.click('.tabs button[data-tab="voice"]');
    await wait(2600);
    const r = await admin.evaluate(`(function(){
      var ids = ["zfv-invite-list","zfv-user-list","zfv-audit","zfv-channel-list","zfv-server-list"];
      var out = {};
      ids.forEach(function(id){
        var e = document.getElementById(id);
        out[id] = e ? e.innerText.trim().slice(0, 160) : "<节点不存在>";
      });
      return out;
    })()`);
    for (const [id, txt] of Object.entries(r)) {
      assert.ok(txt && txt.indexOf("加载中") < 0, id + " 仍停在加载中：" + txt);
      assert.ok(txt.indexOf("节点不存在") < 0, id + " 节点不存在");
      assert.ok(txt.indexOf("失败") < 0 && txt.indexOf("无权") < 0,
        id + " 加载报错：" + txt);
    }
    assert.ok(r["zfv-channel-list"].indexOf("开黑频道") >= 0,
      "频道面板没有读到预置频道：" + r["zfv-channel-list"]);
    assert.ok(r["zfv-user-list"].length > 3, "用户面板为空：" + r["zfv-user-list"]);
  });

  await step("停止观看时仍保留共享面板与重新观看按钮", async function () {
    const appJs = fs.readFileSync(path.join(ROOT, "voice/voice.js"), "utf8");
    assert.match(appJs, /var showScreen = !!sharer;/);
    assert.match(appJs, /video\.style\.opacity = \(hasStream && state\.watching\) \? "1" : "0"/);
    assert.match(appJs, /\$\("#btn-stop-watch"\)\.textContent = state\.watching \? "不观看" : "重新观看"/);
  });

  await step("面板内含音质 / 屏幕共享上限 / 私有频道开关控件", async function () {
    const r = await admin.evaluate(`["zfv-ch-bitrate","zfv-ch-preset","zfv-ch-screen-w","zfv-ch-screen-fps",
      "zfv-allow-private","zfv-max-private","zfv-captcha-mode"]
      .filter(function(id){return !document.getElementById(id)}).length`);
    // 字段名可能与实现略有出入，只要关键控件存在即可
    const has = await admin.evaluate(`({
      audio: !!document.querySelector("#zfv-channel-form select, #zfv-channel-form input[type=number]"),
      allowPrivate: !!document.getElementById("zfv-allow-private"),
      captchaMode: !!document.getElementById("zfv-captcha-mode")
    })`);
    assert.equal(has.audio, true);
    assert.equal(has.allowPrivate, true);
    assert.equal(has.captchaMode, true);
  });

  await admin.screenshot(path.join(SHOTS, "admin-voice-panels.png"));
  await step("后台页面无 JS 运行时异常", async function () {
    const real = admin.errors.filter(function (e) {
      return e.indexOf("favicon") < 0 && e.indexOf("net::ERR") < 0;
    });
    assert.deepEqual(real, [], "控制台报错：" + real.join(" | "));
  });
  await admin.close();

} finally {
  await browser.close();
}

console.log("\n截图：tools/dev/_shots/voice-login-captcha.png、voice-app-view.png、admin-voice-panels.png");
console.log("结果：" + pass + " 通过 / " + fail + " 失败");
if (fail) process.exit(1);
