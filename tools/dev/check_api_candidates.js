"use strict";
/* 前端契约检查：apiCandidates() 的候选地址在各种访问方式下是否正确。

   为什么需要它：
     浏览器对「混合内容」是硬拦截 —— https 页面请求 http 接口时，
     请求根本发不出去，控制台只留一行被拦掉的记录，表现为
     "作品墙空着 / 留言发不出"，而且后端日志里什么都没有，极难排查。
     这个脚本把不同访问方式下的候选列表钉死，避免以后改坏。

   用法：node tools/dev/check_api_candidates.js
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

/** 从 html 里抠出 apiCandidates 函数体（含它依赖的两个端口常量） */
function extract(html, file) {
  const i = html.indexOf("function apiCandidates()");
  if (i < 0) throw new Error(file + " 里找不到 apiCandidates()");
  // 从函数开头做花括号配对
  const open = html.indexOf("{", i);
  let depth = 0, j = open;
  for (; j < html.length; j++) {
    if (html[j] === "{") depth++;
    else if (html[j] === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  const body = html.slice(i, j);
  const consts = html.match(/var (HTTP_API_PORT|HTTPS_API_PORT) = \d+;/g);
  if (!consts || consts.length < 2) throw new Error(file + " 里找不到端口常量");
  const portOf = html.slice(html.indexOf("function portOf(loc)"),
    html.indexOf("}", html.indexOf("function portOf(loc)")) + 1);
  return consts.join("\n") + "\n" + portOf + "\n" + body + "\nreturn apiCandidates();";
}

/** 造一个假的 location */
function loc(href) {
  const u = new URL(href);
  return {
    href: u.href,
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    host: u.host
  };
}

const CASES = [
  { url: "https://zfsnnb.dpdns.org:3443/", expect: [
      "", "https://localhost:3443", "https://127.0.0.1:3443",
      "http://localhost:3000", "http://127.0.0.1:3000" ],
    why: "HTTPS 同源（后端自己提供页面）" },
  { url: "https://zfsnnb.dpdns.org/", expect: [
      "", "https://zfsnnb.dpdns.org:3443",
      "https://localhost:3443", "https://127.0.0.1:3443",
      "http://localhost:3000", "http://127.0.0.1:3000" ],
    why: "HTTPS 走 443（CDN/反代终止 TLS），需跨到 3443" },
  { url: "https://localhost:88/", expect: [
      "", "https://localhost:3443", "https://127.0.0.1:3443",
      "http://localhost:3000", "http://127.0.0.1:3000" ],
    why: "HTTPS 在 IIS 88 端口" },
  { url: "http://zfsnnb.dpdns.org:3000/", expect: [
      "", "http://localhost:3000", "http://127.0.0.1:3000" ],
    why: "HTTP 同源（当前公网方案）" },
  { url: "http://zfsnnb.dpdns.org:38472/", expect: [
      "", "http://zfsnnb.dpdns.org:3000",
      "http://localhost:3000", "http://127.0.0.1:3000" ],
    why: "外部端口映射成非常规值，需回落到 3000" },
  { url: "http://localhost:88/", expect: [
      "", "http://localhost:3000", "http://127.0.0.1:3000" ],
    why: "HTTP 在 IIS 88 端口" },
  { url: "file:///D:/ZFSNwebsite/index.html", expect: [
      "http://localhost:3000", "http://127.0.0.1:3000" ],
    why: "双击本地文件打开" }
];

let bad = 0;
const ok = (c, m) => { console.log((c ? "  OK " : "  \u2717 ") + m); if (!c) bad++; };

["index.html", "admin.html"].forEach(function (file) {
  console.log("\n[" + file + "]");
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  let src;
  try { src = extract(html, file); }
  catch (e) { ok(false, e.message); return; }
  const build = new Function("location", src);

  CASES.forEach(function (c) {
    const got = build(loc(c.url));
    const same = JSON.stringify(got) === JSON.stringify(c.expect);
    ok(same, c.why + "  " + c.url);
    if (!same) {
      console.log("      期望: " + JSON.stringify(c.expect));
      console.log("      实际: " + JSON.stringify(got));
    }
    // 核心不变量：https 页面下不得出现指向非 localhost 的 http 候选
    if (c.url.startsWith("https:")) {
      const bad2 = got.filter((u) =>
        u.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(u));
      ok(bad2.length === 0, "  └ 无混合内容候选" + (bad2.length ? "：" + bad2.join(", ") : ""));
    }
  });
});

console.log(bad ? "\n" + bad + " 项未通过" : "\n全部通过");
process.exit(bad ? 1 : 0);
