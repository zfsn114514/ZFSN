"use strict";
/* 前端契约检查：Steam「自己拥有 + 家庭共享」的合并逻辑。

   为什么需要它：
     steam_games.json（自己拥有）和 steam_family.json（家庭共享）由两个
     Python 脚本生成，index.html 里手写 JS 消费并合并它们。
     任何一边改了字段名（appid / games / hours / playtime / cover / store /
     count / total_hours），页面会**静默不显示**，肉眼很难发现。
     这个脚本把合并 + 渲染函数抠出来，喂真实数据断言。

   用法：node tools/dev/check_steam_merge.js
   ───────────────────────────────────────────────────────────── */
const fs = require("fs"), path = require("path");

const ROOT = (function () {
  let d = __dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(d, "index.html"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(__dirname, "..", "..");
})();

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");

/** 按名字抠出一个函数（花括号配对，能正确处理嵌套） */
function extractFn(name) {
  const i = html.indexOf("function " + name + "(");
  if (i < 0) throw new Error("index.html 里找不到 " + name + "()");
  const open = html.indexOf("{", i);
  let depth = 0, j = open;
  for (; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return html.slice(i, j);
}

/* ── 数据 ── */
const ownedPath = path.join(ROOT, "steam_games.json");
const famPath = path.join(ROOT, "steam_family.json");
if (!fs.existsSync(ownedPath)) {
  console.log("  跳过：steam_games.json 不存在");
  process.exit(0);
}
const ownedDoc = JSON.parse(fs.readFileSync(ownedPath, "utf8"));
const famDoc = fs.existsSync(famPath) ? JSON.parse(fs.readFileSync(famPath, "utf8")) : null;

/* ── DOM / 依赖桩 ── */
function el(tag) {
  return {
    tagName: tag, style: {}, className: "", innerHTML: "", textContent: "", href: "",
    target: "", rel: "", children: [],
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, getAttribute() { return null; }, addEventListener() {}
  };
}
const NODES = {};
const $ = (s) => {
  const k = s.replace(/^#/, "");
  return NODES[k] || (NODES[k] = el("div"));
};

const calls = { renderGames: [], renderStats: [], renderRecent: [] };

const prelude = [
  'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;")' +
    '.replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\'/g,"&#39;");}',
  'function coverUrl(a){return "https://cdn.cloudflare.steamstatic.com/steam/apps/"+a+"/header.jpg";}',
  'var ALL_GAMES = [], maxHours = 1;',
  'var scount = $("#steam-count");',
  'function renderGames(list){ CALLS.renderGames.push(list); ALL_GAMES = list.slice().sort(byHours);' +
    ' maxHours = 1; ALL_GAMES.forEach(function(g){ if (g.hours > maxHours) maxHours = g.hours; }); }',
  'function byHours(a,b){ var d=(b.hours||0)-(a.hours||0); if(d!==0) return d;' +
    ' return String(a.name).localeCompare(String(b.name)); }',
  'function renderStats(d){ CALLS.renderStats.push(d); }',
  'function renderRecent(l){ CALLS.renderRecent.push(l); }'
].join("\n");

const src = [
  prelude,
  extractFn("mergeFamily"),
  extractFn("sumHours"),
  extractFn("makeCard"),
  extractFn("applySteam"),
  "return { mergeFamily: mergeFamily, sumHours: sumHours, makeCard: makeCard, applySteam: applySteam," +
  " renderGames: renderGames," +   // ← 定义在 prelude 桩里，必须显式导出才能断言
  " ALL_GAMES: function(){ return ALL_GAMES; }, maxHours: function(){ return maxHours; } };"
].join("\n");

const docStub = {
  createElement: (t) => el(t),
  createDocumentFragment: () => el("fragment")
};

let api;
try {
  api = new Function("$", "document", "CALLS", src)($, docStub, calls);
} catch (e) {
  console.log("  \u2717 提取/执行失败: " + e.message);
  process.exit(1);
}

/* ── 断言 ── */
let bad = 0;
const ok = (c, m) => { console.log((c ? "  OK " : "  \u2717 ") + m); if (!c) bad++; };
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

console.log("[合并逻辑]");
const owned = ownedDoc.games || [];
const fam = (famDoc && famDoc.games) || [];
console.log("  数据: 自己拥有 " + owned.length + " 款 · 家庭共享 " + fam.length + " 款");

const m = api.mergeFamily(owned, famDoc);
ok(m.games.length === owned.length + fam.length,
   "合并后总数 = " + m.games.length + "（期望 " + (owned.length + fam.length) + "）");
ok(m.familyCount === fam.length, "familyCount = " + m.familyCount);

const famInMerged = m.games.filter((g) => g.family === true);
ok(famInMerged.length === fam.length, "标记 family:true 的有 " + famInMerged.length + " 款");
ok(m.games.every((g) => g.appid), "每条都有 appid");
ok(new Set(m.games.map((g) => g.appid)).size === m.games.length, "appid 无重复");

// 去重：把自己拥有的一款塞进 family，不应重复计入
if (owned.length && fam.length) {
  const dup = { games: fam.concat([owned[0]]) };
  const m2 = api.mergeFamily(owned, dup);
  ok(m2.games.length === owned.length + fam.length,
     "重复 appid 被去重（" + m2.games.length + "）");
  ok(m2.familyCount === fam.length, "重复项不计入 familyCount");
}
// 空/缺失的家庭数据不应报错
ok(api.mergeFamily(owned, null).games.length === owned.length, "家庭数据缺失时退化为只有自己拥有的");
ok(api.mergeFamily([], null).games.length === 0, "两边都空也不报错");

console.log("\n[卡片渲染]");
api.renderGames(m.games);
const first = api.ALL_GAMES()[0];
const famCard = api.makeCard(famInMerged[0]);
const ownCard = api.makeCard(owned[0]);

ok(famCard.className === "sgame famcard", "家庭卡片 class = " + famCard.className);
ok(ownCard.className === "sgame", "自有卡片 class = " + ownCard.className);
ok(famCard.innerHTML.indexOf('class="fam"') >= 0, "家庭卡片有「家庭」角标");
ok(famCard.innerHTML.indexOf("家庭共享") >= 0, "角标带 title 说明");
ok(ownCard.innerHTML.indexOf('class="fam"') < 0, "自有卡片没有家庭角标");
ok(famCard.innerHTML.indexOf('class="rank"') >= 0, "家庭卡片仍带排名角标（合并后共用一个网格）");
ok(famCard.innerHTML.indexOf('loading="lazy"') >= 0, "封面懒加载");
ok(famCard.href.indexOf("store.steampowered.com/app/") >= 0, "链接指向商店");
ok(famCard.innerHTML.indexOf("undefined") < 0, "无 undefined 泄漏");
ok(famCard.innerHTML.indexOf('src="undefined') < 0, "无空封面");
const pw = famCard.innerHTML.match(/width:(\d+)%/);
ok(!!pw && +pw[1] >= 3 && +pw[1] <= 100, "时长条宽度 " + (pw && pw[1]) + "%");

// 最高时长那款的名次应该是 #1
ok(first && api.makeCard(first).innerHTML.indexOf("#1") >= 0,
   "时长最高的是 #1：" + (first && first.name));

console.log("\n[整体渲染 applySteam]");
api.applySteam(ownedDoc, famDoc);
const passed = calls.renderGames[calls.renderGames.length - 1];
ok(passed && passed.length === m.games.length,
   "renderGames 收到 " + (passed && passed.length) + " 款");
const st = calls.renderStats[calls.renderStats.length - 1];
ok(st && st.count === m.games.length, "统计条 count = " + (st && st.count));
ok(st && st.games.length === m.games.length, "统计条 games 与列表一致");
ok(st && st.player === ownedDoc.player, "玩家信息透传");

const expectedHours = Math.round(m.games.reduce((s, g) => s + (g.hours || 0), 0) * 10) / 10;
ok(st && st.total_hours === expectedHours,
   "总时长 = " + (st && st.total_hours) + "（期望 " + expectedHours + "）");

const hero = NODES["steam-count"].textContent;
ok(hero.indexOf(String(m.games.length) + " 款") >= 0, "头部概要含总数：" + hero);
if (fam.length) ok(hero.indexOf("家庭共享") >= 0, "头部概要说明家庭共享占比");
ok(NODES["hs-steam-v"] && NODES["hs-steam-v"].textContent === m.games.length + " 款游戏",
   "首页概览卡： " + (NODES["hs-steam-v"] && NODES["hs-steam-v"].textContent));

// 家庭数据缺失时不应崩，也不应把 family 角标弄出来
api.applySteam(ownedDoc, null);
const st2 = calls.renderStats[calls.renderStats.length - 1];
ok(st2 && st2.count === owned.length, "无家庭数据时 count = " + (st2 && st2.count));

console.log(bad ? "\n" + bad + " 项未通过" : "\n全部通过");
process.exit(bad ? 1 : 0);
