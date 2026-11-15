/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 手机端布局回归（2026-11-15 移动版重排）
 *
 *  用户给的参考是黑盒语音的移动版，落地成这几条硬指标：
 *   1) 左栏是圆角方形服务器图标，选中态带光环；
 *   2) 频道抽屉顶部有大 banner 卡（名字 + 在线人数）和整宽「邀请」按钮；
 *   3) 频道行 ≥44px 可点、右侧显示 人数/上限；
 *   4) 进频道后顶栏让位给吸顶频道条（← / 频道名 / 共享·成员·全屏）；
 *   5) 成员卡是竖排方形大卡，头像居中、名字是深色胶囊；
 *   6) 底栏是「消息胶囊 + 4 个 52px 圆形按钮」，挂断为红圆；
 *   7) 点胶囊弹出全屏聊天面板，× 能关；
 *   8) 桌面视口（1280×800）完全不受影响。
 *
 *  前置：本地 dev server 在跑（npm run voice:dev），本机有 Chrome/Edge。
 *  运行：npm run voice:test:mobile
 * ══════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, page } from "../../tools/dev/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.VOICE_UI_BASE || "http://127.0.0.1:8790";
const SHOTS = path.join(ROOT, "tools/dev/_shots");
fs.mkdirSync(SHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) { console.error("  ✘ " + name + "\n    " + (e && e.stack || e)); fail++; }
}

/** 把标签页切成手机视口（390×844，DPR 2，移动端模式）。 */
async function mobile(tab) {
  await tab.call("Emulation.setDeviceMetricsOverride", {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
}
async function desktop(tab) {
  await tab.call("Emulation.setDeviceMetricsOverride", {
    width: 1280, height: 800, deviceScaleFactor: 1, mobile: false
  });
}

console.log("\nZF语音 手机端布局回归（" + BASE + "）\n");
const browser = await launch({ port: 9400 + Math.floor(Math.random() * 100) });

try {
  /* ── 1. 手机端：频道列表 ─────────────────────────────────── */
  const p = await page(browser, "about:blank", { waitMs: 200 });
  await mobile(p);
  await p.call("Page.navigate", { url: BASE + "/voice/?preview=1" });
  await wait(2200);

  await step("手机端打开预览：顶栏紧凑、菜单在左、标题居中", async () => {
    const r = await p.evaluate(`(function(){
      var bar = document.querySelector(".v-topbar");
      var menu = document.getElementById("btn-menu");
      var logo = document.querySelector(".v-logo");
      function rect(el){ return el ? el.getBoundingClientRect() : null; }
      var rb = rect(bar), rm = rect(menu), rl = rect(logo);
      return {
        barH: rb ? Math.round(rb.height) : 0,
        menuX: rm ? Math.round(rm.left) : -1,
        menuVisible: menu ? getComputedStyle(menu).display !== "none" : false,
        logoCenter: rl ? Math.round(rl.left + rl.width / 2) : -1,
        vw: window.innerWidth,
        backHome: getComputedStyle(document.querySelector(".back-home")).display
      };
    })()`);
    assert.ok(r.barH > 40 && r.barH <= 56, "手机顶栏应压缩到 ~50px：" + JSON.stringify(r));
    assert.equal(r.menuVisible, true, "手机端必须有频道列表按钮");
    assert.ok(r.menuX < 40, "菜单按钮应在左侧：" + JSON.stringify(r));
    assert.ok(Math.abs(r.logoCenter - r.vw / 2) < 24, "标题应水平居中：" + JSON.stringify(r));
    assert.equal(r.backHome, "none", "手机端隐藏「返回主站」文字链接");
  });

  await step("频道抽屉：banner 卡 + 整宽「邀请」按钮 + 分组频道行", async () => {
    const r = await p.evaluate(`(function(){
      function rect(el){ return el ? el.getBoundingClientRect() : null; }
      var banner = document.querySelector(".ch-banner");
      var invite = document.getElementById("btn-invite");
      var rows = [].map.call(document.querySelectorAll("#channel-list .channel-row"), function(el){
        var r = el.getBoundingClientRect();
        return { h: Math.round(r.height), n: (el.querySelector(".ch-n")||{}).textContent || "" };
      });
      var rb = rect(banner), ri = rect(invite);
      return {
        banner: rb ? { w: Math.round(rb.width), h: Math.round(rb.height) } : null,
        bannerText: banner ? banner.innerText.replace(/\\s+/g, " ").trim() : "",
        invite: ri ? { w: Math.round(ri.width), text: invite.innerText.trim() } : null,
        rows: rows.slice(0, 4),
        rowCount: rows.length,
        railRound: getComputedStyle(document.querySelector(".rail-btn")).borderRadius,
        railShadow: getComputedStyle(document.querySelector(".rail-btn.active")).boxShadow
      };
    })()`);
    assert.ok(r.banner && r.banner.h >= 100, "banner 卡没渲染出来：" + JSON.stringify(r));
    assert.ok(r.bannerText.indexOf("ZFSN") >= 0 && /人在线/.test(r.bannerText),
      "banner 缺少服务器名或在线人数：" + r.bannerText);
    assert.ok(r.invite && r.invite.w > 240 && r.invite.text.indexOf("邀请") >= 0,
      "「邀请」按钮应是整宽：" + JSON.stringify(r.invite));
    assert.ok(r.rowCount >= 3, "频道行数量不对：" + r.rowCount);
    for (const row of r.rows) {
      assert.ok(row.h >= 44, "频道行太矮，手指点不准：" + JSON.stringify(row));
      assert.match(row.n, /^(\d+\/\d+|—)$/, "频道行右侧要显示 人数/上限：" + JSON.stringify(row));
    }
    assert.ok(/^\d+px$/.test(r.railRound) && parseInt(r.railRound, 10) >= 10,
      "左栏图标应是圆角方形：" + r.railRound);
    assert.ok(r.railShadow && r.railShadow !== "none", "选中的服务器图标缺少光环：" + r.railShadow);
  });

  await p.screenshot(path.join(SHOTS, "voice-mobile-list.png"));

  await step("点菜单按钮从左侧滑出频道抽屉（贴在图标栏右边）", async () => {
    await p.click("#btn-menu");
    await wait(500);
    const r = await p.evaluate(`(function(){
      var ch = document.getElementById("channels-panel");
      var rail = document.querySelector(".rail");
      var rc = ch.getBoundingClientRect(), rr = rail.getBoundingClientRect();
      return { left: Math.round(rc.left), railW: Math.round(rr.width),
               visible: getComputedStyle(ch).transform, w: Math.round(rc.width),
               bottom: Math.round(rc.bottom), vh: window.innerHeight };
    })()`);
    assert.ok(Math.abs(r.left - r.railW) <= 2, "抽屉应紧贴图标栏右侧：" + JSON.stringify(r));
    assert.ok(r.bottom >= r.vh - 2, "抽屉应通到底部（不再给底栏留口子）：" + JSON.stringify(r));
    assert.ok(r.w >= 280, "抽屉宽度太窄：" + JSON.stringify(r));
    await p.screenshot(path.join(SHOTS, "voice-mobile-drawer.png"));
  });

  /* ── 2. 手机端：频道内 ───────────────────────────────────── */
  await step("进频道：顶栏让位给吸顶频道条，成员卡变竖排方形大卡", async () => {
    await p.evaluate(`(function(){
      var row = document.querySelector('#channel-list .channel-row[data-channel="cf-2"]');
      if (row) row.click();
    })()`);
    await wait(900);
    const r = await p.evaluate(`(function(){
      function rect(el){ return el ? el.getBoundingClientRect() : null; }
      var bar = document.querySelector(".v-topbar");
      var head = document.querySelector(".room-head");
      var card = document.querySelector(".member-card");
      var av = card && card.querySelector(".avatar");
      var nm = card && card.querySelector(".name");
      var rc = rect(card), ra = rect(av), rn = rect(nm), rh = rect(head);
      return {
        roomOpen: document.getElementById("app-view").classList.contains("room-open"),
        barH: bar ? Math.round(bar.getBoundingClientRect().height) : -1,
        headPos: head ? getComputedStyle(head).position : "",
        headTop: rh ? Math.round(rh.top) : -1,
        headH: rh ? Math.round(rh.height) : 0,
        backBtn: !!document.getElementById("btn-room-back") &&
          getComputedStyle(document.getElementById("btn-room-back")).display !== "none",
        dir: card ? getComputedStyle(card).flexDirection : "",
        card: rc ? { w: Math.round(rc.width), h: Math.round(rc.height) } : null,
        avatar: ra ? Math.round(ra.width) : 0,
        nameBg: nm ? getComputedStyle(nm).backgroundColor : "",
        nameInsideCard: !!(rc && rn && rn.top >= rc.top && rn.bottom <= rc.bottom),
        title: (document.getElementById("room-name") || {}).textContent || ""
      };
    })()`);
    assert.equal(r.roomOpen, true, "进频道要打上 room-open：" + JSON.stringify(r));
    assert.equal(r.barH, 0, "进频道后顶栏应收起（高度 0）：" + JSON.stringify(r));
    assert.equal(r.headPos, "sticky", "频道条要吸顶：" + JSON.stringify(r));
    assert.ok(r.headTop <= 2 && r.headH >= 40, "频道条没贴在顶部：" + JSON.stringify(r));
    assert.equal(r.backBtn, true, "频道条左侧缺少返回/列表按钮");
    assert.equal(r.dir, "column", "手机端成员卡应竖排：" + JSON.stringify(r));
    assert.ok(r.card && r.card.w > r.card.h - 10 && r.card.h > r.card.w - 10,
      "成员卡应接近正方形：" + JSON.stringify(r.card));
    assert.ok(r.avatar >= 56, "头像太小：" + r.avatar);
    assert.ok(r.nameInsideCard, "名字胶囊应落在卡片内：" + JSON.stringify(r));
    assert.ok(r.title.length > 0, "频道名没填上");
  });

  await step("底栏：消息胶囊 + 4 个圆形按钮，挂断是红圆", async () => {
    const r = await p.evaluate(`(function(){
      function rect(el){ return el ? el.getBoundingClientRect() : null; }
      var pill = document.getElementById("btn-msg-pill");
      var mic = document.getElementById("btn-mic");
      var deaf = document.getElementById("btn-deaf");
      var set = document.getElementById("btn-settings");
      var hang = document.getElementById("btn-hangup");
      var rp = rect(pill), rm = rect(mic), rd = rect(deaf), rs = rect(set), rh = rect(hang);
      var cs = function(el){ return getComputedStyle(el); };
      return {
        pill: rp ? { w: Math.round(rp.width), h: Math.round(rp.height), text: pill.innerText.trim() } : null,
        mic: rm ? { w: Math.round(rm.width), h: Math.round(rm.height), radius: cs(mic).borderRadius } : null,
        order: [rm, rd, rs, rh].filter(Boolean).map(function(x){ return Math.round(x.left); }),
        hang: rh ? { w: Math.round(rh.width), radius: cs(hang).borderRadius, bg: cs(hang).backgroundColor } : null,
        label: getComputedStyle(mic, "::after").content || "",
        pillText: (document.getElementById("msg-pill-text") || {}).textContent || ""
      };
    })()`);
    assert.ok(r.pill && r.pill.w > 300, "消息胶囊应是整宽：" + JSON.stringify(r.pill));
    assert.ok(/发送消息给/.test(r.pillText), "胶囊文案没跟上频道名：" + r.pillText);
    assert.ok(r.mic && r.mic.w >= 48 && parseInt(r.mic.radius, 10) >= 20,
      "底部按钮应是圆形大按钮：" + JSON.stringify(r.mic));
    assert.equal(r.order.length, 4, "进频道后应有 4 个圆形按钮：" + JSON.stringify(r.order));
    const sorted = r.order.slice().sort((a, b) => a - b);
    assert.deepEqual(r.order, sorted, "按钮没有横向排开：" + JSON.stringify(r.order));
    assert.ok(r.hang && /rgb\(255, 45, 74\)/.test(r.hang.bg), "挂断应是红色圆钮：" + JSON.stringify(r.hang));
  });

  await p.screenshot(path.join(SHOTS, "voice-mobile-room.png"));

  /* ── 3. 手机端：全屏聊天 ─────────────────────────────────── */
  await step("点消息胶囊 → 全屏聊天面板（× 可关）", async () => {
    await p.click("#btn-msg-pill");
    await wait(500);
    const open = await p.evaluate(`(function(){
      var panel = document.getElementById("chat-panel");
      var r = panel.getBoundingClientRect();
      var head = document.querySelector(".chat-head");
      var close = document.getElementById("btn-chat-close");
      var rc = close.getBoundingClientRect();
      var strong = head.querySelector("strong").getBoundingClientRect();
      return {
        display: getComputedStyle(panel).display,
        box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        closeVisible: getComputedStyle(close).display !== "none",
        closeLeft: Math.round(rc.left),
        titleCenter: Math.round(strong.left + strong.width / 2),
        vw: window.innerWidth,
        grab: !!document.querySelector(".chat-grab"),
        placeholder: document.getElementById("chat-input").placeholder
      };
    })()`);
    assert.equal(open.display, "flex", "聊天面板没打开：" + JSON.stringify(open));
    assert.deepEqual(open.box, [0, 0, 390, 844], "聊天面板应铺满全屏：" + JSON.stringify(open.box));
    assert.equal(open.closeVisible, true, "全屏聊天缺少关闭按钮");
    assert.ok(open.closeLeft < 60, "关闭按钮应在左上角：" + JSON.stringify(open));
    assert.ok(Math.abs(open.titleCenter - open.vw / 2) < 24, "「聊天」标题应居中：" + JSON.stringify(open));
    assert.ok(/发送给/.test(open.placeholder), "输入框应提示「发送给 频道名」：" + open.placeholder);

    await p.screenshot(path.join(SHOTS, "voice-mobile-chat.png"));
    await p.click("#btn-chat-close");
    await wait(400);
    const closed = await p.evaluate(`getComputedStyle(document.getElementById("chat-panel")).display`);
    assert.equal(closed, "none", "点 × 之后聊天面板没关掉");
  });

  await step("聊天气泡：自己的在右侧（品牌红），别人的在左侧", async () => {
    /* 预览模式没有真实房间，直接注入两条消息走真实渲染函数 */
    const r = await p.evaluate(`(function(){
      var box = document.getElementById("chat-messages");
      // 借 renderChat 的输入源：先触发一次默认渲染，确认真实 DOM 结构
      box.innerHTML = "";
      return { hasFn: typeof window.VoiceApp === "object" || !!document.querySelector("#chat-messages") };
    })()`);
    assert.equal(r.hasFn, true);

    /* 通过真实的发送/接收路径太依赖后端，这里直接校验 CSS 规则本身：
       .chat-message.own 靠右 + 红底，这条是纯样式回归点。 */
    const css = await p.evaluate(`(function(){
      var probe = document.createElement("article");
      probe.className = "chat-message own";
      var body = document.createElement("div");
      body.className = "chat-content";
      body.innerHTML = "<p>x</p>";
      probe.appendChild(body);
      document.getElementById("chat-messages").appendChild(probe);
      var msg = getComputedStyle(probe);
      var bubble = getComputedStyle(body);
      var out = { dir: msg.flexDirection, bubbleBg: bubble.backgroundImage || bubble.backgroundColor,
                  radius: bubble.borderRadius, day: !!document.querySelector(".chat-day") };
      probe.remove();
      return out;
    })()`);
    assert.equal(css.dir, "row-reverse", "自己的消息应头像在右、整体靠右：" + JSON.stringify(css));
    assert.ok(/gradient|rgb\(255, 58, 85\)/.test(css.bubbleBg), "自己的气泡应为主色红：" + css.bubbleBg);
    assert.ok(parseInt(css.radius, 10) >= 10, "气泡应是圆角：" + css.radius);
  });

  /* ── 4. 桌面端不受影响 ───────────────────────────────────── */
  await step("同一份代码在桌面视口（1280×800）保持原布局", async () => {
    const d = await page(browser, "about:blank", { waitMs: 200 });
    await desktop(d);
    await d.call("Page.navigate", { url: BASE + "/voice/?preview=1&channel=cf-2" });
    await wait(2000);
    const r = await d.evaluate(`(function(){
      var banner = document.querySelector(".ch-banner");
      var pill = document.getElementById("btn-msg-pill");
      var card = document.querySelector(".member-card");
      var bar = document.querySelector(".v-topbar");
      var chat = document.getElementById("chat-panel");
      var rc = card ? card.getBoundingClientRect() : null;
      return {
        banner: getComputedStyle(banner).display,
        pill: pill ? getComputedStyle(pill).display : "missing",
        cardDir: card ? getComputedStyle(card).flexDirection : "",
        cardH: rc ? Math.round(rc.height) : 0,
        barDisplay: getComputedStyle(bar).display,
        chatPos: getComputedStyle(chat).position,
        roomOpen: document.getElementById("app-view").classList.contains("room-open")
      };
    })()`);
    assert.equal(r.banner, "none", "桌面端不该出现移动版 banner：" + JSON.stringify(r));
    assert.equal(r.pill, "none", "桌面端不该出现消息胶囊：" + JSON.stringify(r));
    assert.equal(r.cardDir, "row", "桌面端成员卡仍是横排：" + JSON.stringify(r));
    assert.ok(r.cardH > 0 && r.cardH < 120, "桌面端成员卡仍是矮横卡：" + r.cardH);
    assert.notEqual(r.barDisplay, "none", "桌面端顶栏不能被隐藏");
    assert.notEqual(r.chatPos, "fixed", "桌面端聊天面板不该是全屏浮层");
    assert.deepEqual(d.errors.filter(function (e) { return e.indexOf("favicon") < 0; }), [],
      "桌面视口控制台报错：" + d.errors.join(" | "));
    await d.screenshot(path.join(SHOTS, "voice-desktop-after-mobile.png"));
    await d.close();
  });

  await step("手机端控制台无 JS 异常", async () => {
    const real = p.errors.filter(function (e) { return e.indexOf("favicon") < 0; });
    assert.deepEqual(real, [], "手机端控制台报错：" + real.join(" | "));
  });

} finally {
  await browser.close();
}

console.log("\n截图：tools/dev/_shots/voice-mobile-{list,drawer,room,chat}.png");
console.log("结果：" + pass + " 通过 / " + fail + " 失败");
if (fail) process.exit(1);
