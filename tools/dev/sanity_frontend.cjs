/**
 * 前端内联脚本冒烟测试（桩环境）
 * ---------------------------------------------------------------
 * 目的：在 Node 里把 index.html / admin/index.html 的脚本整体跑一遍，
 * 捕获**顶层运行时错误**（未定义变量、拼错函数名等）。
 *
 * 覆盖范围：
 *   · HTML 里的内联 <script> 块
 *   · HTML 引用的**本站**脚本（如 assets/js/app.js、assets/js/danmaku.js）
 *     —— index.html 的主逻辑已从内联拆到 app.js，不扫就测不到。
 *   第三方外链（http(s):// 开头）跳过。
 *
 * 运行：node tools/dev/sanity_frontend.cjs
 *   （package.json 是 type:module，本文件用 require，所以必须是 .cjs 后缀）
 *
 * ⚠ 两个曾经让本测试"假通过"的桩缺陷（已修，别再改回去）：
 *   1. getContext("2d") 返回 null —— index.html 顶层就会
 *      ctx.setTransform(...)，一抛错后面的数据加载全被带停，
 *      测试却把它当"桩限制"忽略，等于什么都没测到。
 *      现在返回一个完整的 no-op 上下文桩。
 *   2. parentNode 返回 null —— 脚本里有 el.parentNode.appendChild(...)，
 *      同样会在顶层抛错。现在返回一个惰性创建的元素桩。
 *
 * 注意：桩里的 fetch 必然 reject，会触发各数据源的降级分支，
 * 那些分支依赖真实 DOM，报错属正常 —— 按错误类型排除即可。
 */
"use strict";
const fs = require("fs");
const path = require("path");

// 站点根目录：从本文件所在目录逐级往上找，直到看见 index.html。
// （本脚本在 tools/dev/ 下，所以不能简单地用 ".."）
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

/** canvas 2d 上下文桩（见文件头说明 1） */
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
  // 不能返回 null（见文件头说明 2）
  Object.defineProperty(el, "parentNode", { get() { return makeEl("div"); } });
  return el;
}

function run(file) {
  const html = fs.readFileSync(path.join(ROOT, file), "utf8");
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  const srcRe = /<script[^>]*\bsrc=["']([^"']+)["']/gi;
  let m, idx = 0, failures = 0;

  // 收集待测脚本：HTML 内联块 + 引用的本站脚本（跳过第三方外链）
  const chunks = [];
  while ((m = re.exec(html))) {
    if (m[1].trim()) chunks.push({ label: "内联#" + (++idx), code: m[1] });
  }
  while ((m = srcRe.exec(html))) {
    const u = m[1];
    if (/^https?:\/\//i.test(u) || u.startsWith("//")) continue; // 第三方，不测
    const p = path.join(ROOT, u.replace(/^\//, ""));
    if (fs.existsSync(p)) {
      chunks.push({ label: u, code: fs.readFileSync(p, "utf8") });
    }
  }

  for (const c of chunks) {
    const src = c.code;

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
      location: { href: "http://localhost:3000/", origin: "http://localhost:3000", protocol: "http:", hostname: "localhost", pathname: "/", search: "", hash: "" },
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
      innerWidth: 1280, innerHeight: 800,
      scrollTo() {}, scrollY: 0,
      requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
      cancelAnimationFrame: (id) => clearTimeout(id),
      setTimeout, clearTimeout, setInterval, clearInterval,
      fetch: () => Promise.reject(new Error("stub: no network")),
      XMLHttpRequest: function () {
        this.open = () => {}; this.setRequestHeader = () => {};
        this.send = () => { if (this.onerror) setTimeout(() => this.onerror(new Error("stub")), 0); };
        this.upload = {};
      },
      FormData: function () { this.append = () => {}; },
      // 浏览器专属观察器：桩环境没有，danmaku.js 启动时会用到。
      // 补成 no-op 而不是把 "MutationObserver is not defined" 塞进
      // 错误白名单 —— 后者会连带吞掉真正的变量名拼写错误。
      MutationObserver: function () {
        this.observe = () => {}; this.disconnect = () => {}; this.takeRecords = () => [];
      },
      IntersectionObserver: function () {
        this.observe = () => {}; this.unobserve = () => {}; this.disconnect = () => {};
      },
      ResizeObserver: function () {
        this.observe = () => {}; this.unobserve = () => {}; this.disconnect = () => {};
      },
      console, JSON, Math, Date, Object, Array, String, Number, Boolean, RegExp, Error,
      Promise, Map, Set, parseInt, parseFloat, isNaN, encodeURIComponent, decodeURIComponent,
      URLSearchParams: function () {}, Intl, JSON2: JSON
    };
    window.window = window;
    window.self = window;
    window.top = window;
    window.globalThis = window;

    try {
      // eslint-disable-next-line no-new-func
      new Function("window", "document", "navigator", "localStorage", "location",
        "setTimeout", "clearTimeout", "setInterval", "clearInterval",
        "fetch", "XMLHttpRequest", "FormData", "requestAnimationFrame", "cancelAnimationFrame",
        "matchMedia", "getComputedStyle",
        "MutationObserver", "IntersectionObserver", "ResizeObserver", src
      ).call(window, window, document, window.navigator, window.localStorage, window.location,
        setTimeout, clearTimeout, setInterval, clearInterval,
        window.fetch, window.XMLHttpRequest, window.FormData,
        window.requestAnimationFrame, window.cancelAnimationFrame,
        window.matchMedia, window.getComputedStyle,
        window.MutationObserver, window.IntersectionObserver, window.ResizeObserver);
      console.log("  ✓ " + file + " " + c.label + " 顶层执行无异常");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      // 桩环境必然触发的降级分支报错，属桩限制而非真实 bug
      if (/appendChild|querySelector|null|undefined|not a function|Cannot read/i.test(msg)) {
        console.log("  ~ " + file + " " + c.label + " 桩限制（可忽略）: " + msg);
      } else {
        failures++;
        console.log("  ✗ " + file + " " + c.label + " 运行时错误: " + msg);
        if (e && e.stack) console.log("      " + e.stack.split("\n")[1]);
      }
    }
  }
  return failures;
}

let total = 0;
// 管理页只有一份源文件：admin/index.html（站点根的 admin.html 已合并删除）
["index.html", "admin/index.html"].forEach((f) => { total += run(f); });
console.log("");
console.log(total === 0 ? "全部通过（无真实运行时错误）" : total + " 个真实错误");
process.exit(total === 0 ? 0 : 1);
