/* 截图检查：成员卡片横排 + 聊天拉伸到底 */
import fs from "node:fs";
import path from "node:path";
import { launch, page } from "./cdp.mjs";

const BASE = process.env.VOICE_UI_BASE || "http://127.0.0.1:8790";
const SHOTS = path.join(process.cwd(), "tools/dev/_shots");
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await launch({ port: 9900 + Math.floor(Math.random() * 60) });
const p = await page(browser, BASE + "/voice/?preview=1", { waitMs: 2500 });
try {
  // 进第一个频道（预览模式会造几个假成员）
  const pick = Number(process.argv[2] || 0);
  await p.evaluate("window.__pickIdx = " + pick);
  await p.evaluate(`(function(){
    var list = document.querySelectorAll('#channel-list button[data-channel]');
    var idx = Number(window.__pickIdx || 0);
    var li = list[idx] || list[0];
    if (li) li.click();
    return !!li;
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  const layout = await p.evaluate(`(function(){
    var room = document.getElementById("room");
    var panel = document.getElementById("chat-panel");
    var msgs = document.getElementById("chat-messages");
    var card = document.querySelector(".member-card");
    var stage = document.querySelector(".stage");
    function box(el){ if(!el) return null; var r = el.getBoundingClientRect(); return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }; }
    return {
      room: box(room), chat: box(panel), messages: box(msgs), stage: box(stage),
      card: box(card),
      cardDir: card ? getComputedStyle(card).flexDirection : null,
      avatarLeft: (function(){
        if (!card) return null;
        var a = card.querySelector(".avatar"), n = card.querySelector(".name");
        if (!a || !n) return null;
        var ra = a.getBoundingClientRect(), rn = n.getBoundingClientRect();
        return { avatarRight: Math.round(ra.right), nameLeft: Math.round(rn.left), avatarTop: Math.round(ra.top), nameTop: Math.round(rn.top) };
      })()
    };
  })()`);
  console.log(JSON.stringify(layout, null, 1));
  const shot = path.join(SHOTS, "room-layout-" + pick + ".png");
  await p.screenshot(shot);
  console.log("shot: " + shot);
} finally {
  await p.close();
  await browser.close();
}
