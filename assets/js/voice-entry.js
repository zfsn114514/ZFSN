/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 全站左上角入口按钮
 *
 *  设计取舍：
 *  · 运行时注入，不修改任何现有 HTML 结构 / CSS / JS 逻辑。
 *    各页面只需在 </body> 前加一行同步 <script src="..."></script>。
 *    （原本用 defer，但主站外部统计脚本在无外网时会卡住 defer 队列，
 *      导致入口迟迟不出现，故改为 body 末尾同步加载。）
 *  · 主站有 .topbar（flex, space-between）：插到 .mark 之后，
 *    用 margin-right:auto 吸收剩余空间，保证按钮紧贴左上角 logo，
 *    不会把 .terminal-tag 挤到中间。
 *  · 其它页面没有 .topbar：退化为 position:fixed 固定左上角。
 *  · /voice 自身是独立布局，不注入，避免出现「进入语音」的入口套娃。
 * ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // /voice 独立布局不显示入口按钮
  if (location.pathname === "/voice" || location.pathname.indexOf("/voice/") === 0) return;
  // 防止重复注入（某些页面会重复加载脚本）
  if (document.querySelector("[data-voice-entry]")) return;

  var MIC =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="2" width="6" height="12" rx="3"/>' +
    '<path d="M5 10v2a7 7 0 0 0 14 0v-2"/>' +
    '<path d="M12 19v3"/><path d="M8 22h8"/></svg>';

  var css =
    ".zf-voice-entry{" +
    "display:inline-flex;align-items:center;gap:8px;" +
    "padding:7px 12px;border-radius:10px;" +
    "background:rgba(255,45,74,.10);border:1px solid rgba(255,45,74,.42);" +
    "color:#ff8a9b;text-decoration:none;white-space:nowrap;" +
    "font:600 11.5px/1 system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
    "letter-spacing:.06em;transition:background .2s,border-color .2s,color .2s;" +
    "cursor:pointer;user-select:none;}" +
    ".zf-voice-entry:hover,.zf-voice-entry:focus-visible{" +
    "background:rgba(255,45,74,.20);border-color:#ff2d4a;color:#ffd7dd;outline:none;}" +
    ".zf-voice-entry svg{flex:none}" +
    ".zf-voice-entry.in-topbar{margin-left:16px;margin-right:auto;letter-spacing:.04em;text-transform:none}" +
    ".zf-voice-entry.is-fixed{position:fixed;left:16px;top:14px;z-index:9999;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.35)}" +
    "@media(max-width:700px){" +
    ".zf-voice-entry span{display:none}" +
    ".zf-voice-entry{padding:9px}" +
    ".zf-voice-entry.in-topbar{margin-left:10px}" +
    ".zf-voice-entry.is-fixed{left:12px;top:10px}}" +
    "@media(prefers-reduced-motion:reduce){.zf-voice-entry{transition:none}}";

  var style = document.createElement("style");
  style.setAttribute("data-voice-entry-style", "");
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  var a = document.createElement("a");
  a.className = "zf-voice-entry";
  a.href = "/voice";
  a.setAttribute("data-voice-entry", "");
  a.setAttribute("aria-label", "进入 ZF语音");
  a.title = "进入 ZF语音";
  a.innerHTML = MIC + "<span>ZF语音</span>";

  var topbar = document.querySelector(".topbar");
  var mark = topbar && topbar.querySelector(".mark");
  if (topbar && mark) {
    a.classList.add("in-topbar");
    mark.insertAdjacentElement("afterend", a);
  } else {
    a.classList.add("is-fixed");
    (document.body || document.documentElement).appendChild(a);
  }
})();
