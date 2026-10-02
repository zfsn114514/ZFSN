/**
 * 后端地址「探测结果」契约检查（桩环境，不需要真实网络）
 * ---------------------------------------------------------------
 * 为什么需要它：
 *   check_api_candidates.js 只验证**候选列表的顺序**，证明不了"最终真的选中了隧道"。
 *   而线上最关键的一件事恰恰是：
 *     在 https://www.zfsnnb.dpdns.org/ 这种 CF 静态托管页上，
 *     本地 localhost 是**不可达**的（访客不在你的局域网），
 *     探测必须落到 https://api.zfsnnb.dpdns.org（Cloudflare 隧道）。
 *
 *   但开发机上 localhost:3000 永远是通的，浏览器一跑就会回落到本机兜底 ——
 *   于是"线上修好了没有"这件事在本地怎么测都测不出来。
 *   所以这里用桩 fetch 人为制造"只有隧道可用"的环境，把结论钉死。
 *
 * 做法：
 *   把 index.html 的内联脚本整段跑起来，fetch 换成记录型桩：
 *     · 只有 TUNNEL/api/health 返回 ok
 *     · 其余一律 reject（模拟访客那边 localhost / :3443 全都不通）
 *   然后断言：
 *     ① 隧道 health 被请求过
 *     ② 后续业务请求（/api/messages 等）也打在隧道域名上
 *        —— 这一条才真正证明 API_BASE 被判成了隧道
 *     ③ 没有去请求 https://www.zfsnnb.dpdns.org:3443
 *        —— CF 不代理 3443，这个候选必须被跳过（否则白挂到超时）
 *
 * 用法：node tools/dev/check_api_detect.js
 * ───────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");

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

const PAGE = "https://www.zfsnnb.dpdns.org/";
const TUNNEL = (fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .match(/var TUNNEL_API = "([^"]+)"/) || [])[1];
if (!TUNNEL) { console.log("\u2717 index.html 里找不到 TUNNEL_API"); process.exit(1); }

/* ── DOM 桩（与 sanity_frontend.js 同源，够跑通顶层脚本即可） ── */
/* canvas 2d 上下文桩：index.html 在顶层就会 getContext("2d").setTransform(...)，
   如果返回 null 会直接抛错、把后面的数据加载全带停（sanity_frontend 就被这个坑到过）。 */
function makeCtx() {
  const noop = function () { return makeCtx(); };
  const ctx = {
    canvas: { width: 0, height: 0 },
    globalAlpha: 1, fillStyle: "", strokeStyle: "", lineWidth: 1,
    font: "", textAlign: "", textBaseline: "", globalCompositeOperation: "",
    shadowBlur: 0, shadowColor: "",
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    getImageData: () => ({ data: [] }),
    putImageData() {}, createPattern: () => null
  };
  ["setTransform", "clearRect", "fillRect", "strokeRect", "beginPath", "closePath",
   "moveTo", "lineTo", "arc", "arcTo", "bezierCurveTo", "quadraticCurveTo", "rect",
   "fill", "stroke", "clip", "save", "restore", "translate", "scale", "rotate",
   "drawImage", "fillText", "strokeText", "setLineDash", "ellipse"
  ].forEach((k) => { ctx[k] = noop; });
  return ctx;
}

function makeEl(tag) {
  const el = {
    tagName: (tag || "div").toUpperCase(),
    style: {}, dataset: {}, classList: {
      _s: new Set(),
      add() { for (const a of arguments) this._s.add(a); },
      remove() { for (const a of arguments) this._s.delete(a); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); return this._s.has(c); },
      contains(c) { return this._s.has(c); }
    },
    children: [], childNodes: [],
    innerHTML: "", textContent: "", value: "", src: "", href: "",
    width: 430, height: 900,
    scrollHeight: 100, clientHeight: 100, offsetWidth: 100, offsetHeight: 100,
    disabled: false, hidden: false, files: null,
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    querySelector() { return makeEl("div"); },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {}, blur() {}, click() {}, scrollIntoView() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 100, bottom: 100, right: 100 }; },
    getContext() { return makeCtx(); },
    toDataURL() { return ""; }
  };
  // 注意：不能返回 null —— 脚本里有 el.parentNode.appendChild(...) 的写法，
  // 返回 null 会抛错并把顶层执行带停（sanity_frontend 就是被这个坑到过）。
  Object.defineProperty(el, "parentNode", { get() { return makeEl("div"); } });
  return el;
}

let bad = 0;
const ok = (c, m) => { console.log((c ? "  OK " : "  \u2717 ") + m); if (!c) bad++; };

function run() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const calls = [];          // { url, ok }

  while ((m = re.exec(html))) {
    const src = m[1];
    if (!src.trim() || src.indexOf("apiCandidates") < 0) continue;   // 只跑主脚本

    const document = {
      body: makeEl("body"),
      documentElement: makeEl("html"),
      createElement: (t) => makeEl(t),
      createDocumentFragment: () => makeEl("fragment"),
      querySelector: () => makeEl("div"),
      querySelectorAll: () => [],
      getElementById: () => makeEl("div"),
      addEventListener() {}, removeEventListener() {},
      cookie: "", readyState: "complete"
    };
    const store = {};
    const window = {
      document,
      location: {
        href: PAGE, origin: PAGE.replace(/\/$/, ""), protocol: "https:",
        hostname: "www.zfsnnb.dpdns.org", pathname: "/", search: "", hash: "", port: ""
      },
      navigator: { userAgent: "stub", language: "zh-CN", clipboard: null },
      localStorage: {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; }
      },
      sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      addEventListener() {}, removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
      getComputedStyle: () => ({ getPropertyValue: () => "" }),
      devicePixelRatio: 1,
      innerWidth: 430, innerHeight: 900,
      scrollTo() {}, scrollY: 0,
      requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
      cancelAnimationFrame: (id) => clearTimeout(id),
      setTimeout, clearTimeout, setInterval, clearInterval,
      /* ★ 核心：只有隧道的 /api/health 通，其余一律失败 */
      fetch: function (url) {
        const u = String(url);
        const isTunnelHealth = u === TUNNEL + "/api/health";
        const isTunnelApi = u.indexOf(TUNNEL + "/api/") === 0;
        if (!isTunnelApi) {
          calls.push({ url: u, ok: false });
          return Promise.reject(new Error("stub: unreachable"));
        }
        calls.push({ url: u, ok: true });
        if (isTunnelHealth) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ ok: true, service: "ZFSN site backend" })
          });
        }
        // 业务接口返回空数据，让页面渲染降级分支
        const empty = /\/api\/(messages|works)/.test(u)
          ? { ok: true, count: 0, items: [] } : { ok: true };
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(empty) });
      },
      XMLHttpRequest: function () {
        this.open = () => {}; this.setRequestHeader = () => {};
        this.send = () => { if (this.onerror) setTimeout(() => this.onerror(new Error("stub")), 0); };
        this.upload = {};
      },
      FormData: function () { this.append = () => {}; },
      console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
      Promise, Map, Set, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
      URLSearchParams: function () {}, Intl
    };
    window.window = window; window.self = window; window.top = window; window.globalThis = window;

    try {
      // eslint-disable-next-line no-new-func
      new Function("window", "document", "navigator", "localStorage", "location",
        "setTimeout", "clearTimeout", "setInterval", "clearInterval",
        "fetch", "XMLHttpRequest", "FormData", "requestAnimationFrame", "cancelAnimationFrame",
        "matchMedia", "getComputedStyle", src
      ).call(window, window, document, window.navigator, window.localStorage, window.location,
        setTimeout, clearTimeout, setInterval, clearInterval,
        window.fetch, window.XMLHttpRequest, window.FormData,
        window.requestAnimationFrame, window.cancelAnimationFrame,
        window.matchMedia, window.getComputedStyle);
    } catch (e) {
      console.log("  ~ 桩限制（可忽略）: " + (e && e.message));
    }
    return calls;
  }
  throw new Error("index.html 里找不到主脚本");
}

const calls = run();

// 等所有 Promise 微任务 / 定时器跑完
setTimeout(function () {
  const okUrls = calls.filter((c) => c.ok).map((c) => c.url);
  const badUrls = calls.filter((c) => !c.ok).map((c) => c.url);
  const hit = (p) => okUrls.some((u) => u.indexOf(p) === 0);
  const tried = (p) => calls.some((c) => c.url.indexOf(p) === 0);

  console.log("\n[探测结果]");
  ok(hit(TUNNEL + "/api/health"), "隧道的 /api/health 被成功请求：" + TUNNEL + "/api/health");
  ok(hit(TUNNEL + "/api/messages"), "★ 业务请求打在隧道上（证明 API_BASE 判成了隧道）");
  ok(!tried("https://www.zfsnnb.dpdns.org:3443"),
     "没有去请求 :3443（CF 不代理该端口，必须跳过）");
  ok(!okUrls.some((u) => /^https?:\/\/(localhost|127\.0\.0\.1)/.test(u)),
     "本机兜底地址没有被采信（模拟的是外网访客）");

  console.log("\n  成功: " + (okUrls.length ? okUrls.join("\n        ") : "（无）"));
  console.log("  失败: " + (badUrls.length ? badUrls.slice(0, 6).join("\n        ") : "（无）"));
  console.log(bad ? "\n" + bad + " 项未通过" : "\n全部通过");
  process.exit(bad ? 1 : 0);
}, 300);
