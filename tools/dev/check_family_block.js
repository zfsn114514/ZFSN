"use strict";
/* 前端契约检查：用真实 steam_family.json 跑一遍 index.html 里的
   「Steam 家庭共享」渲染逻辑，验证数据字段与前端读取方式是否对得上。

   为什么需要它：
     steam_family.json 由 tools/build_steam_family.py 生成，
     index.html 里手写 JS 消费它。两边任何一边改了字段名
     （games / hours / playtime / cover / store / count / total_hours），
     页面会静默不显示 —— 肉眼很难发现。这个脚本能立刻报出来。

   用法：node tools/dev/check_family_block.js
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
const famPath = path.join(ROOT, "steam_family.json");
if (!fs.existsSync(famPath)) {
  console.log("  跳过：steam_family.json 不存在（先跑 tools/build_steam_family.py）");
  process.exit(0);
}
const fam = JSON.parse(fs.readFileSync(famPath, "utf8"));

const start = html.indexOf("/* \u2550\u2550\u2550 Steam \u5bb6\u5ead\u5171\u4eab \u2550\u2550\u2550");
const end = html.indexOf("/* \u2550\u2550\u2550 B\u7ad9\u6570\u636e \u2550\u2550\u2550");
if (start < 0 || end < 0 || end < start) {
  console.log("  \u2717 index.html 里找不到「Steam 家庭共享」代码段");
  process.exit(1);
}
// 把静默 catch 换成打印，避免错误被吞掉
let seg = html.slice(start, end)
  .replace(/\.catch\(function\(\)\{[\s\S]*?\}\);\s*$/, ".catch(function(e){ console.log('CATCH:', e && e.message); });");

/* ── 极简 DOM 桩 ── */
function el(tag) {
  return {
    tagName: tag, style: {}, className: "", innerHTML: "", textContent: "",
    children: [], handlers: {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute() {}, getAttribute() { return null; },
    addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); },
    querySelector() { return el("div"); },
    click() { (this.handlers.click || []).forEach((f) => f.call(this, {})); }
  };
}
const NODES = {};
["fgrid", "family-block", "family-note", "steam-count",
 "family-more", "family-morebtn", "family-moretxt"].forEach((k) => { NODES[k] = el("div"); });
NODES["family-block"].style.display = "none";
NODES["family-more"].style.display = "none";

const prelude = [
  'var $ = function(s){ var k = s.replace(/^#/,""); return NODES[k] || (NODES[k] = el("div")); };',
  'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/\'/g,"&#39;");}',
  'function coverUrl(a){return "https://cdn.cloudflare.steamstatic.com/steam/apps/"+a+"/header.jpg";}',
  'function byHours(a,b){var d=(b.hours||0)-(a.hours||0);if(d!==0)return d;return String(a.name).localeCompare(String(b.name));}',
  'var scount = NODES["steam-count"];',
  'scount.textContent = "\u5171 165 \u6b3e\u6e38\u620f \u00b7 2,308 \u5c0f\u65f6\u603b\u65f6\u957f";'
].join("\n");

const docStub = { createDocumentFragment: () => el("fragment"), createElement: (t) => el(t) };
const fakeFetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fam) });

const fn = new Function("NODES", "el", "document", "fetch",
  prelude + "\n" + seg + "\nreturn { fgrid: NODES.fgrid, fblock: NODES['family-block']," +
  " fnote: NODES['family-note'], scount: scount, more: NODES['family-more']," +
  " morebtn: NODES['family-morebtn'], moretxt: NODES['family-moretxt'] };");
const api = fn(NODES, el, docStub, fakeFetch);

const cards = () => {
  // 卡片可能分散在多个 fragment 里（分批渲染）
  const out = [];
  api.fgrid.children.forEach((f) => { out.push.apply(out, f.children || []); });
  return out;
};
const escH = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

setTimeout(function () {
  let bad = 0;
  const ok = (c, m) => { console.log((c ? "  OK " : "  \u2717 ") + m); if (!c) bad++; };

  ok(api.fblock.style.display === "block", "区块已显示");
  ok(api.more.style.display === "block", "展开按钮容器已显示");
  ok(cards().length === 12, "首屏渲染 12 张（实际 " + cards().length + "）");
  ok(api.morebtn.style.display !== "none", "还有剩余时按钮可见");
  ok(api.morebtn.textContent.indexOf(String(fam.count)) >= 0,
     "按钮文案含总数：" + api.morebtn.textContent);

  const first = cards()[0];
  ok(!!first && first.className === "sgame famcard", "卡片 class = " + (first && first.className));
  ok(!!first && first.innerHTML.indexOf('class="fam"') >= 0, "卡片含「家庭」角标");
  ok(!!first && first.innerHTML.indexOf('loading="lazy"') >= 0, "封面懒加载");
  ok(!!first && first.href.indexOf("store.steampowered.com/app/") >= 0, "卡片链接指向商店");

  const sorted = fam.games.slice().sort((a, b) => (b.hours || 0) - (a.hours || 0));
  ok(!!first && first.innerHTML.indexOf(escH(sorted[0].name)) >= 0, "首张为时长最高：" + sorted[0].name);
  ok(api.fnote.innerHTML.indexOf(String(fam.count)) >= 0, "说明含总数 " + fam.count);
  ok(api.fnote.innerHTML.indexOf(String(Math.round(fam.total_hours))) >= 0,
     "说明含总时长 " + Math.round(fam.total_hours));
  ok(api.scount.textContent.indexOf("家庭共享 " + fam.count + " 款") >= 0,
     "头部概要已追加：" + api.scount.textContent);

  // 点「展开全部」→ 补齐剩余
  api.morebtn.click();
  ok(cards().length === fam.games.length,
     "展开后共 " + cards().length + " 张 / 数据 " + fam.games.length);
  ok(api.morebtn.style.display === "none", "全部展开后按钮隐藏");
  ok(api.moretxt.textContent.indexOf("全部") >= 0, "底部文案：" + api.moretxt.textContent);

  const m = first.innerHTML.match(/width:(\d+)%/);
  ok(!!m && +m[1] >= 3 && +m[1] <= 100, "时长条宽度 " + (m && m[1]) + "%");
  ok(cards().every((c) => c.innerHTML.indexOf("undefined") < 0), "没有 undefined 泄漏");
  ok(cards().every((c) => c.innerHTML.indexOf('src="undefined') < 0), "没有空封面");

  console.log(bad ? "\n" + bad + " 项未通过" : "\n全部通过");
  process.exit(bad ? 1 : 0);
}, 80);
