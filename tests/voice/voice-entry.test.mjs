/* ZF语音入口按钮注入逻辑的单元测试。
 * 运行：node tests/voice/voice-entry.test.mjs
 * 用极简 DOM 模拟，避免为一段注入脚本引入 jsdom 之类的依赖。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../../assets/js/voice-entry.js", import.meta.url), "utf8");

function makeEl(tag) {
  const node = {
    tag, className: "", href: "", title: "", innerHTML: "", textContent: "",
    attrs: {}, children: [], parent: null,
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    insertAdjacentElement(_pos, child) {
      const holder = this.parent || { children: [] };
      holder.children.push(child); child.parent = holder;
      return child;
    },
  };
  node.classList = {
    add(...names) { node.className = [node.className, ...names].filter(Boolean).join(" "); },
    contains(name) { return node.className.split(" ").includes(name); },
  };
  return node;
}

/* 在指定路径下执行注入脚本，返回创建出的元素与容器 */
function run(pathname, withTopbar) {
  const head = makeEl("head");
  const body = makeEl("body");
  const created = [];
  const mark = makeEl("div");
  mark.className = "mark";
  const topbar = makeEl("div");
  topbar.className = "topbar";
  mark.parent = topbar;
  topbar.querySelector = (sel) => (withTopbar && sel === ".mark" ? mark : null);

  const document = {
    head, body, documentElement: makeEl("html"),
    createElement(tag) { const n = makeEl(tag); created.push(n); return n; },
    querySelector(sel) {
      if (sel === ".topbar") return withTopbar ? topbar : null;
      return null; // [data-voice-entry] 防重复：首次执行时不存在
    },
  };
  vm.runInNewContext(source, { document, location: { pathname }, console });
  return {
    link: created.find((n) => n.tag === "a"),
    style: created.find((n) => n.tag === "style"),
    head, body, topbar, created,
  };
}

/* 1. /voice 独立布局不注入，避免入口套娃 */
const skip = run("/voice", true);
assert.equal(skip.link, undefined, "/voice 不应出现入口按钮");
assert.equal(skip.created.length, 0, "/voice 不应创建任何元素");

/* 2. 主站（有 .topbar）应紧贴 logo 插入，且带无障碍标签 */
const home = run("/", true);
assert.ok(home.link, "主站必须创建入口按钮");
assert.equal(home.link.href, "/voice");
assert.equal(home.link.attrs["aria-label"], "进入 ZF语音");
assert.ok(home.link.classList.contains("in-topbar"), "应插入 topbar 而非 fixed 覆盖 logo");
assert.ok(home.topbar.children.includes(home.link), "按钮应插在 .mark 之后");
assert.ok(home.style && home.head.children.includes(home.style), "应注入样式");

/* 3. 没有 .topbar 的页面退化为固定左上角 */
const game = run("/minecraft/", false);
assert.ok(game.link, "子页面必须创建入口按钮");
assert.ok(game.link.classList.contains("is-fixed"), "无 topbar 时应 fixed");
assert.ok(game.body.children.includes(game.link), "应挂到 body");

/* 4. 窄屏仅图标：样式里有媒体查询隐藏文字 */
assert.match(home.style.textContent, /@media\(max-width:700px\)/);
assert.match(home.style.textContent, /\.zf-voice-entry span\{display:none\}/);

console.log("voice-entry.test.mjs: 4 组断言全部通过");
