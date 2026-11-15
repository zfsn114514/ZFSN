/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 现有管理后台的「ZF语音」标签页（阶段 2~5）
 *
 *  运行时注入：不改后台任何 HTML 结构与 JS 逻辑，只追加一个 .tabs
 *  按钮和一个 .pane。请求**自带封装**：后台主脚本整体包在 IIFE 里，
 *  它的 api() / API_BASE 都不是 window 上的全局（2026-11-14 实测，
 *  这正是三个面板一直显示「加载中…」的原因），所以不能复用。
 *
 *  所有后端接口都在 Cloudflare Worker；用户电脑只负责添加私有频道。
 * ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var $ = function (s, root) { return (root || document).querySelector(s); };
  var $$ = function (s, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(s));
  };
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  var PLAIN_KEY = "zfsn_voice_invite_plain";
  var TOKEN_KEY = "zfsn_admin_token";
  var REMOTE_BASE = "https://www.zfsnnb.dpdns.org";
  var apiBase = "";            // "" = 同源；本地静态预览时回落线上 Worker
  var apiBaseReady = null;
  var lastError = "";

  function plainMap() {
    try { return JSON.parse(sessionStorage.getItem(PLAIN_KEY) || "{}"); }
    catch (_) { return {}; }
  }
  function rememberPlain(id, code) {
    try {
      var m = plainMap(); m[id] = code;
      sessionStorage.setItem(PLAIN_KEY, JSON.stringify(m));
    } catch (_) {}
  }

  /* ── 自带请求封装（不依赖后台 IIFE 里的 api()） ───────────── */
  function isLocal() {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname || "");
  }
  function pickBase() {
    if (apiBaseReady) return apiBaseReady;
    apiBaseReady = (async function () {
      try {
        var r = await fetch("/api/health?_=" + Date.now(), { cache: "no-store" });
        if (r.ok) { var d = await r.json().catch(function () { return null; }); if (d && d.ok) { apiBase = ""; return ""; } }
      } catch (_) {}
      if (isLocal()) apiBase = REMOTE_BASE;
      return apiBase;
    })();
    return apiBaseReady;
  }
  async function call(path, opts) {
    opts = opts || {};
    var base = await pickBase();
    var headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
    var tok = "";
    try { tok = localStorage.getItem(TOKEN_KEY) || ""; } catch (_) {}
    if (tok) headers["X-Admin-Token"] = tok;
    var r;
    try {
      r = await fetch(base + path, Object.assign({}, opts, { headers: headers, credentials: "same-origin" }));
    } catch (e) {
      // 本地同源探测过但服务后来停了，再试一次线上
      if (isLocal() && !base) {
        apiBase = REMOTE_BASE; apiBaseReady = Promise.resolve(REMOTE_BASE);
        r = await fetch(REMOTE_BASE + path, Object.assign({}, opts, { headers: headers }));
      } else throw new Error("无法连接 Cloudflare Worker，请检查网络或本地运行时");
    }
    var d = await r.json().catch(function () {
      throw new Error("服务返回异常 (HTTP " + r.status + ")：" + (r.status === 404 ? "接口不存在，请确认 Worker 已部署且已执行 0003 迁移" : "响应不是 JSON"));
    });
    if (!r.ok || d.ok === false) {
      var msg = d.error || ("HTTP " + r.status);
      if (r.status === 403 || /管理员|登录|令牌/.test(msg)) msg += "（请先用管理员账号登录本后台）";
      throw new Error(msg);
    }
    return d;
  }

  function injectStyle() {
    if ($("#zfv-style")) return;
    var st = document.createElement("style");
    st.id = "zfv-style";
    st.textContent = [
      ".zfv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:18px}",
      ".zfv-card{background:var(--card,rgba(255,255,255,.025));border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:18px}",
      ".zfv-card.wide{grid-column:1/-1}",
      ".zfv-card h3{font-size:13.5px;font-weight:600;letter-spacing:.06em;color:var(--red-soft);margin:0 0 14px}",
      ".zfv-card h4{font-size:11.5px;color:var(--muted);margin:16px 0 8px;font-weight:500;letter-spacing:.06em}",
      ".zfv-form{display:grid;gap:10px;margin-bottom:16px}",
      ".zfv-form.tight{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 12px}",
      ".zfv-form label{font-size:11px;color:var(--muted);display:grid;gap:5px}",
      ".zfv-form input,.zfv-form select,.zfv-search input{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:8px;background:var(--bg-soft,rgba(0,0,0,.25));color:var(--text);outline:none;font-size:12px;box-sizing:border-box}",
      ".zfv-form input[type=checkbox]{width:auto;display:inline-block;margin-right:6px}",
      ".zfv-search{display:flex;gap:8px;margin-bottom:12px}",
      ".zfv-search input{flex:1}",
      ".zfv-table{width:100%;border-collapse:collapse;font-size:11.5px}",
      ".zfv-table th,.zfv-table td{text-align:left;padding:9px 7px;border-bottom:1px solid var(--line);vertical-align:middle}",
      ".zfv-table th{color:var(--muted);font-weight:500;letter-spacing:.06em;font-size:10.5px}",
      ".zfv-table td{color:var(--text)}",
      ".zfv-table .mono{font-family:ui-monospace,Consolas,monospace;letter-spacing:.06em}",
      ".zfv-table select{padding:5px 7px;border:1px solid var(--line);border-radius:7px;background:var(--bg-soft,rgba(0,0,0,.25));color:var(--text);font-size:11px}",
      ".zfv-tag{display:inline-block;padding:2px 7px;border-radius:6px;font-size:10px;border:1px solid var(--line);color:var(--muted)}",
      ".zfv-tag.on{color:var(--green);border-color:rgba(80,220,140,.35)}",
      ".zfv-tag.off{color:var(--red-soft);border-color:rgba(255,45,74,.35)}",
      ".zfv-ops{display:flex;gap:5px;flex-wrap:wrap}",
      ".zfv-mini{padding:4px 8px;font-size:10.5px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--muted);cursor:pointer}",
      ".zfv-mini:hover{color:var(--text);background:rgba(255,255,255,.06)}",
      ".zfv-mini.danger:hover{color:#ff8a9c;border-color:rgba(255,45,74,.4)}",
      ".zfv-newcode{margin:0 0 14px;padding:12px;border:1px dashed rgba(255,45,74,.45);border-radius:10px;background:rgba(255,45,74,.07);font-size:12px;line-height:1.8}",
      ".zfv-newcode code{font-size:15px;letter-spacing:.14em;color:#fff;font-family:ui-monospace,Consolas,monospace}",
      ".zfv-msg{font-size:11.5px;min-height:16px;margin-top:8px;color:var(--muted)}",
      ".zfv-msg.ok{color:var(--green)}.zfv-msg.bad{color:var(--red-soft)}",
      ".zfv-audit{max-height:280px;overflow:auto;font-size:11px;line-height:1.9;color:var(--muted)}",
      ".zfv-audit .mono{font-family:ui-monospace,Consolas,monospace}",
      ".zfv-uses{margin:6px 0 2px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.03);font-size:11px;color:var(--muted)}",
      ".zfv-err{color:var(--red-soft);font-size:11px;padding:10px 4px;line-height:1.6}",
      ".zfv-edit{margin-top:14px;padding:14px;border:1px dashed var(--line2);border-radius:10px;background:rgba(255,255,255,.02)}",
      "@media(max-width:760px){.zfv-grid{grid-template-columns:1fr}}"
    ].join("\n");
    document.head.appendChild(st);
  }

  var AUDIO_PRESET_HTML = '<option value="low">低（24 kbps）</option>' +
    '<option value="standard">标准（48 kbps）</option>' +
    '<option value="high">高（96 kbps / 立体声）</option>' +
    '<option value="custom">自定义</option>';

  var HTML = [
    '<div class="ph"><div><h2>ZF语音</h2>',
    '<div class="desc">邀请码 / 用户 / 频道音质 / 验证方式 / 审计 · 复用当前后台的管理员令牌 · 后端全在 Cloudflare Worker</div></div>',
    '<button class="btn" id="zfv-refresh" type="button">刷新</button></div>',
    '<div class="zfv-grid">',

    '  <section class="zfv-card">',
    '    <h3>邀请码管理</h3>',
    '    <form class="zfv-form" id="zfv-invite-form">',
    '      <label>有效期（留空 = 永不过期）<input type="datetime-local" id="zfv-exp"></label>',
    '      <label>最大使用次数（留空 = 不限次数）<input type="number" id="zfv-max" min="1" max="100000" placeholder="不限次数"></label>',
    '      <label>备注<input type="text" id="zfv-note" maxlength="120" placeholder="例如：给朋友们的"></label>',
    '      <div><button class="btn primary" type="submit">创建邀请码</button></div>',
    '    </form>',
    '    <div class="zfv-newcode" id="zfv-newcode" hidden></div>',
    '    <div class="zfv-msg" id="zfv-invite-msg"></div>',
    '    <table class="zfv-table"><thead><tr><th>邀请码</th><th>备注</th><th>使用</th><th>有效期</th><th>操作</th></tr></thead>',
    '      <tbody id="zfv-invite-list"><tr><td colspan="5">加载中…</td></tr></tbody></table>',
    '  </section>',

    '  <section class="zfv-card">',
    '    <h3>用户管理</h3>',
    '    <div class="zfv-search"><input id="zfv-user-q" type="text" placeholder="搜索用户名 / 显示名"><button class="btn" type="button" id="zfv-user-search">搜索</button></div>',
    '    <div class="zfv-msg" id="zfv-user-msg"></div>',
    '    <table class="zfv-table"><thead><tr><th>用户</th><th>角色</th><th>状态</th><th>注册时间</th><th>操作</th></tr></thead>',
    '      <tbody id="zfv-user-list"><tr><td colspan="5">加载中…</td></tr></tbody></table>',
    '  </section>',

    '  <section class="zfv-card">',
    '    <h3>系统设置</h3>',
    '    <form class="zfv-form" id="zfv-settings-form">',
    '      <label><span><input type="checkbox" id="zfv-reg-open" style="width:auto;margin-right:6px">开放注册</span></label>',
    '      <label><span><input type="checkbox" id="zfv-captcha-on" style="width:auto;margin-right:6px">启用人机验证（登录 / 注册 / 游客登录）</span></label>',
    '      <label>人机验证方式<select id="zfv-captcha-mode"><option value="image">自制图片验证码</option><option value="turnstile">Cloudflare Turnstile</option></select></label>',
    '      <label><span><input type="checkbox" id="zfv-guest-open" style="width:auto;margin-right:6px">允许游客登录（免注册，自动分配「游客xxxx」昵称）</span></label>',
    '      <label><span><input type="checkbox" id="zfv-allow-private" style="width:auto;margin-right:6px">允许普通用户创建私有频道</span></label>',
    '      <label>每人私有频道上限<input type="number" id="zfv-max-private" min="1" max="100" value="10"></label>',
    '      <label><span><input type="checkbox" id="zfv-allow-self" style="width:auto;margin-right:6px">允许普通用户添加自建 SFU 频道（可选高级模式）</span></label>',
    '      <div><button class="btn primary" type="submit">保存设置</button></div>',
    '      <div class="zfv-msg" id="zfv-settings-msg"></div>',
    '    </form>',
    '    <p class="zfv-msg">关掉「启用人机验证」后，登录 / 注册 / 游客登录都不再校验，验证方式选择也不生效。切到 Turnstile 前需先配置 TURNSTILE_SECRET_KEY 与 Site Key，否则服务端会拒绝切换。</p>',
    '  </section>',

    '  <section class="zfv-card">',
    '    <h3>审计日志（最近 100 条）</h3>',
    '    <div class="zfv-audit" id="zfv-audit">加载中…</div>',
    '  </section>',

    /* 阶段 4：频道与音质设置 */
    '  <section class="zfv-card wide">',
    '    <h3>频道管理 · 音质 / 屏幕共享上限（修改后实时下发给在线客户端）</h3>',
    '    <div class="zfv-msg" id="zfv-channel-msg"></div>',
    '    <table class="zfv-table"><thead><tr><th>频道</th><th>后端</th><th>可见</th><th>人数</th><th>音质</th><th>共享上限</th><th>操作</th></tr></thead>',
    '      <tbody id="zfv-channel-list"><tr><td colspan="7">加载中…</td></tr></tbody></table>',
    '    <div class="zfv-edit" id="zfv-channel-edit">',
    '      <h4 id="zfv-edit-title">新建频道 / 编辑频道</h4>',
    '      <form class="zfv-form tight" id="zfv-channel-form">',
    '        <input type="hidden" id="zfv-ch-id">',
    '        <label>名称<input id="zfv-ch-name" maxlength="24" placeholder="频道名称"></label>',
    '        <label>简介<input id="zfv-ch-descr" maxlength="120"></label>',
    '        <label>图标（emoji / 短文本）<input id="zfv-ch-icon" maxlength="40"></label>',
    '        <label>排序值<input id="zfv-ch-ord" type="number" min="0" max="9999" value="0"></label>',
    '        <label>最大在线人数<input id="zfv-ch-max" type="number" min="1" max="200" value="20"></label>',
    '        <label>后端<select id="zfv-ch-backend"><option value="cloudflare">Cloudflare SFU（默认）</option><option value="self_hosted">自建 SFU（可选）</option></select></label>',
    '        <label>可见范围<select id="zfv-ch-vis"><option value="public">公开</option><option value="private">私有</option></select></label>',
    '        <label>谁能加入<select id="zfv-ch-scope"><option value="all">所有注册用户</option><option value="roles">仅管理员</option></select></label>',
    '        <label>加入口令（留空不设）<input id="zfv-ch-pwd" type="password" autocomplete="new-password"></label>',
    '        <label>音质预设<select id="zfv-ch-audio-preset">' + AUDIO_PRESET_HTML + "</select></label>",
    '        <label>Opus 码率 kbps<input id="zfv-ch-bitrate" type="number" min="16" max="128" value="48"></label>',
    '        <label>采样率<select id="zfv-ch-rate"><option value="16000">16 kHz</option><option value="24000">24 kHz</option><option value="48000">48 kHz</option></select></label>',
    '        <label>声道<select id="zfv-ch-channels"><option value="1">单声道</option><option value="2">立体声</option></select></label>',
    '        <label>帧时长<select id="zfv-ch-frame"><option value="10">10 ms</option><option value="20">20 ms</option><option value="40">40 ms</option><option value="60">60 ms</option></select></label>',
    '        <label><span><input type="checkbox" id="zfv-ch-dtx" checked> DTX 静音抑制</span></label>',
    '        <label><span><input type="checkbox" id="zfv-ch-fec" checked> FEC 前向纠错</span></label>',
    '        <label><span><input type="checkbox" id="zfv-ch-screen" checked> 允许屏幕共享</span></label>',
    '        <label>最高分辨率<select id="zfv-ch-res"><option value="720">720p</option><option value="1080">1080p</option><option value="1440">1440p</option><option value="2160">4K</option></select></label>',
    '        <label>最高帧率<input id="zfv-ch-fps" type="number" min="5" max="60" value="30"></label>',
    '        <label>最高码率 kbps<input id="zfv-ch-maxbr" type="number" min="500" max="12000" value="4000"></label>',
    '        <label>同时共享人数<input id="zfv-ch-sharers" type="number" min="1" max="4" value="2"></label>',
    '        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">',
    '          <button class="btn primary" type="submit">保存频道</button>',
    '          <button class="btn" type="button" id="zfv-ch-new">新建</button>',
    '          <span class="zfv-msg" id="zfv-ch-hint">选择上方「编辑」可修改已有频道</span>',
    '        </div>',
    '      </form>',
    '    </div>',
    '  </section>',

    /* 阶段 5：可选自建服务器 */
    '  <section class="zfv-card wide">',
    '    <h3>自建 SFU 服务器（可选高级模式 · 默认不需要）</h3>',
    '    <p class="zfv-msg">用户的电脑默认只用于「添加私有频道」，媒体与信令全部在 Cloudflare Worker。只有你主动填写下面的服务器并让频道选择「自建」时，才需要在自己的电脑上运行 LiveKit。HTTPS 页面必须使用 wss 域名。</p>',
    '    <form class="zfv-form tight" id="zfv-server-form">',
    '      <label>名称<input id="zfv-srv-name" maxlength="40" placeholder="家里电脑"></label>',
    '      <label>域名（不要带 http://）<input id="zfv-srv-host" placeholder="voice.example.com"></label>',
    '      <label>端口<input id="zfv-srv-port" type="number" value="7880" min="1" max="65535"></label>',
    '      <label><span><input type="checkbox" id="zfv-srv-tls" checked> 使用 TLS（wss）</span></label>',
    '      <div><button class="btn primary" type="submit">添加服务器</button></div>',
    '    </form>',
    '    <div class="zfv-msg" id="zfv-server-msg"></div>',
    '    <table class="zfv-table"><thead><tr><th>名称</th><th>地址</th><th>状态</th><th>操作</th></tr></thead>',
    '      <tbody id="zfv-server-list"><tr><td colspan="4">加载中…</td></tr></tbody></table>',
    '  </section>',
    '</div>'
  ].join("\n");

  function msg(id, text, kind) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.className = "zfv-msg" + (kind ? " " + kind : "");
  }
  function tableError(sel, colspan, text) {
    var el = $(sel);
    if (el) el.innerHTML = '<tr><td colspan="' + colspan + '" class="zfv-err">' + esc(text) + "</td></tr>";
  }
  function fmt(ts) {
    if (!ts) return "永不";
    var d = new Date(Number(ts));
    return isNaN(d.getTime()) ? "—" : d.toLocaleString("zh-CN", { hour12: false });
  }

  /* ── 邀请码 ───────────────────────────────────────────────── */
  function loadInvites() {
    return call("/api/voice/admin/invites").then(function (d) {
      var tb = $("#zfv-invite-list");
      var items = d.items || [];
      if (!items.length) { tb.innerHTML = '<tr><td colspan="5">还没有邀请码</td></tr>'; return; }
      tb.innerHTML = items.map(function (it) {
        var dead = it.deleted || (it.expiresAt && it.expiresAt < Date.now()) ||
          (it.maxUses !== null && it.useCount >= it.maxUses);
        var tag = it.deleted ? '<span class="zfv-tag off">已删除</span>'
          : dead ? '<span class="zfv-tag off">已失效</span>'
            : '<span class="zfv-tag on">有效</span>';
        return '<tr data-id="' + esc(it.id) + '">' +
          '<td class="mono">' + esc(it.mask) + " " + tag + "</td>" +
          "<td>" + esc(it.note || "—") + "</td>" +
          "<td>" + esc(it.useCount) + " / " + (it.maxUses === null ? "不限" : esc(it.maxUses)) + "</td>" +
          "<td>" + esc(fmt(it.expiresAt)) + "</td>" +
          '<td><div class="zfv-ops">' +
          '<button class="zfv-mini" data-act="copy">复制</button>' +
          '<button class="zfv-mini" data-act="uses">使用记录</button>' +
          (it.deleted ? "" : '<button class="zfv-mini danger" data-act="del">删除</button>') +
          "</div></td></tr>";
      }).join("");
    }).catch(function (e) { tableError("#zfv-invite-list", 5, e.message); });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("浏览器不支持剪贴板，请手动选中复制"));
  }

  function onInviteTable(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var tr = btn.closest("tr");
    var id = tr.getAttribute("data-id");
    var act = btn.getAttribute("data-act");
    if (act === "copy") {
      var code = plainMap()[id];
      if (!code) {
        msg("#zfv-invite-msg", "明文仅在创建时显示一次；该码是之前会话创建的，请创建一个新码用于分发。", "bad");
        return;
      }
      copyText(code).then(function () { msg("#zfv-invite-msg", "已复制邀请码", "ok"); })
        .catch(function (ex) { msg("#zfv-invite-msg", ex.message, "bad"); });
    } else if (act === "del") {
      if (!window.confirm("删除后该邀请码立即不能再用于注册（已注册用户不受影响）。确认删除？")) return;
      call("/api/voice/admin/invites/" + encodeURIComponent(id), { method: "DELETE" })
        .then(function () { msg("#zfv-invite-msg", "已删除", "ok"); return loadInvites(); })
        .catch(function (ex) { msg("#zfv-invite-msg", ex.message, "bad"); });
    } else if (act === "uses") {
      var old = tr.nextElementSibling;
      if (old && old.classList.contains("zfv-uses-row")) { old.remove(); return; }
      call("/api/voice/admin/invites/" + encodeURIComponent(id) + "/uses").then(function (d) {
        var row = document.createElement("tr");
        row.className = "zfv-uses-row";
        var list = (d.items || []).map(function (u) {
          return esc(u.username || "已删除用户") + "（" + esc(u.display_name || "—") + "） · " + esc(fmt(u.used_at));
        });
        row.innerHTML = '<td colspan="5" class="zfv-uses">' +
          (list.length ? list.join("<br>") : "还没有人使用这个邀请码") + "</td>";
        tr.parentNode.insertBefore(row, tr.nextSibling);
      }).catch(function (ex) { msg("#zfv-invite-msg", ex.message, "bad"); });
    }
  }

  function onCreateInvite(e) {
    e.preventDefault();
    var exp = $("#zfv-exp").value, max = $("#zfv-max").value, note = $("#zfv-note").value;
    var body = { note: note };
    body.expiresAt = exp ? new Date(exp).getTime() : null;
    body.maxUses = max ? Number(max) : null;
    if (body.expiresAt !== null && !Number.isFinite(body.expiresAt)) {
      msg("#zfv-invite-msg", "有效期格式不正确", "bad"); return;
    }
    call("/api/voice/admin/invites", { method: "POST", body: JSON.stringify(body) })
      .then(function (d) {
        rememberPlain(d.id, d.code);
        var box = $("#zfv-newcode");
        box.hidden = false;
        box.innerHTML = '新邀请码：<code>' + esc(d.code) + "</code><br>" +
          '<span style="color:var(--muted)">明文只显示这一次，请立即复制保存。列表里只保留掩码。</span> ' +
          '<button class="zfv-mini" type="button" id="zfv-copy-new">复制</button>';
        $("#zfv-copy-new").addEventListener("click", function () {
          copyText(d.code).then(function () { msg("#zfv-invite-msg", "已复制", "ok"); })
            .catch(function (ex) { msg("#zfv-invite-msg", ex.message, "bad"); });
        });
        $("#zfv-invite-form").reset();
        msg("#zfv-invite-msg", "创建成功", "ok");
        return loadInvites();
      })
      .catch(function (ex) { msg("#zfv-invite-msg", ex.message, "bad"); });
  }

  /* ── 用户 ─────────────────────────────────────────────────── */
  function loadUsers(q) {
    return call("/api/voice/admin/users" + (q ? "?q=" + encodeURIComponent(q) : ""))
      .then(function (d) {
        var tb = $("#zfv-user-list");
        var items = d.items || [];
        if (!items.length) { tb.innerHTML = '<tr><td colspan="5">没有匹配的用户</td></tr>'; return; }
        tb.innerHTML = items.map(function (u) {
          var st = u.status === "active" ? '<span class="zfv-tag on">正常</span>'
            : '<span class="zfv-tag off">' + (u.status === "banned" ? "封禁" : "禁用") + "</span>";
          return '<tr data-id="' + esc(u.id) + '">' +
            '<td><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:' +
            esc(u.avatarColor) + ';margin-right:6px"></span>' +
            esc(u.displayName) + '<br><span class="mono" style="color:var(--muted);font-size:10px">' + esc(u.username) + "</span></td>" +
            '<td><select data-role><option value="user"' + (u.role === "user" ? " selected" : "") + '>普通用户</option>' +
            '<option value="guest"' + (u.role === "guest" ? " selected" : "") + '>游客</option>' +
            '<option value="admin"' + (u.role === "admin" ? " selected" : "") + ">管理员</option></select></td>" +
            "<td>" + st + "</td><td>" + esc(fmt(u.createdAt)) + "</td>" +
            '<td><div class="zfv-ops">' +
            '<button class="zfv-mini" data-act="status">' + (u.status === "active" ? "禁用" : "启用") + "</button>" +
            '<button class="zfv-mini" data-act="pwd">重置密码</button>' +
            '<button class="zfv-mini danger" data-act="del">删除</button>' +
            "</div></td></tr>";
        }).join("");
      }).catch(function (e) { tableError("#zfv-user-list", 5, e.message); });
  }

  function patchUser(id, patch, text) {
    return call("/api/voice/admin/users/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(patch) })
      .then(function () { msg("#zfv-user-msg", text, "ok"); return loadUsers($("#zfv-user-q").value.trim()); })
      .catch(function (ex) { msg("#zfv-user-msg", ex.message, "bad"); });
  }
  function onUserTable(e) {
    var t = e.target, tr = t.closest("tr[data-id]");
    if (!tr) return;
    var id = tr.getAttribute("data-id");
    if (e.type === "change" && t.matches("[data-role]")) { patchUser(id, { role: t.value }, "角色已更新"); return; }
    var btn = t.closest("[data-act]");
    if (!btn) return;
    var act = btn.getAttribute("data-act");
    if (act === "status") patchUser(id, { status: btn.textContent.trim() === "禁用" ? "disabled" : "active" }, "状态已更新");
    else if (act === "pwd") {
      var p = window.prompt("输入新密码（10~128 位，含字母和数字）。修改后该用户所有会话立即失效：");
      if (!p) return;
      patchUser(id, { password: p }, "密码已重置，该用户需重新登录");
    } else if (act === "del") {
      if (!window.confirm("删除账号会同时清除其会话、邀请码使用记录和头像。确认删除？")) return;
      call("/api/voice/admin/users/" + encodeURIComponent(id), { method: "DELETE" })
        .then(function () { msg("#zfv-user-msg", "账号已删除", "ok"); return loadUsers(""); })
        .catch(function (ex) { msg("#zfv-user-msg", ex.message, "bad"); });
    }
  }

  /* ── 设置 / 审计 ──────────────────────────────────────────── */
  function loadSettings() {
    return call("/api/voice/admin/settings").then(function (d) {
      var s = d.settings || {};
      $("#zfv-reg-open").checked = !!s.registrationOpen;
      $("#zfv-captcha-on").checked = s.captchaEnabled !== false;
      $("#zfv-captcha-mode").value = s.captchaMode === "turnstile" ? "turnstile" : "image";
      $("#zfv-captcha-mode").disabled = s.captchaEnabled === false;
      $("#zfv-guest-open").checked = s.guestLoginOpen !== false;
      $("#zfv-allow-self").checked = !!s.allowUserSelfHosted;
      $("#zfv-allow-private").checked = s.allowUserPrivateChannels !== false;
      $("#zfv-max-private").value = s.maxPrivateChannelsPerUser || 10;
    }).catch(function (e) { msg("#zfv-settings-msg", e.message, "bad"); });
  }
  function onSaveSettings(e) {
    e.preventDefault();
    call("/api/voice/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        registrationOpen: $("#zfv-reg-open").checked,
        captchaEnabled: $("#zfv-captcha-on").checked,
        captchaMode: $("#zfv-captcha-mode").value,
        guestLoginOpen: $("#zfv-guest-open").checked,
        allowUserSelfHosted: $("#zfv-allow-self").checked,
        allowUserPrivateChannels: $("#zfv-allow-private").checked,
        maxPrivateChannelsPerUser: Number($("#zfv-max-private").value) || 10
      })
    }).then(function () { msg("#zfv-settings-msg", "设置已保存，客户端下次加载配置时生效", "ok"); })
      .catch(function (ex) { msg("#zfv-settings-msg", ex.message, "bad"); });
  }
  function loadAudit() {
    return call("/api/voice/admin/audit").then(function (d) {
      var items = d.items || [], box = $("#zfv-audit");
      if (!items.length) { box.textContent = "暂无记录"; return; }
      box.innerHTML = items.slice(0, 40).map(function (a) {
        return '<div><span class="mono">' + esc(fmt(a.ts)) + "</span> · " +
          esc(a.actor || "—") + " · <strong>" + esc(a.action) + "</strong> · " +
          esc(a.target || "—") + " · " + esc(a.ip || "—") + "</div>";
      }).join("");
    }).catch(function (e) { $("#zfv-audit").innerHTML = '<div class="zfv-err">' + esc(e.message) + "</div>"; });
  }

  /* ── 频道管理（阶段 4） ───────────────────────────────────── */
  var channelsCache = [];
  function loadChannels() {
    return call("/api/voice/admin/channels").then(function (d) {
      channelsCache = d.items || [];
      var tb = $("#zfv-channel-list");
      if (!channelsCache.length) { tb.innerHTML = '<tr><td colspan="7">还没有频道</td></tr>'; return; }
      tb.innerHTML = channelsCache.map(function (c) {
        var audio = c.settings && c.settings.audio || {};
        var screen = c.settings && c.settings.screen || {};
        return '<tr data-id="' + esc(c.id) + '">' +
          '<td><strong>' + esc(c.name) + '</strong><br><span class="mono" style="color:var(--muted);font-size:10px">' + esc(c.id) + "</span></td>" +
          '<td><span class="zfv-tag ' + (c.offline ? "off" : "on") + '">' + esc(c.backendLabel) + (c.offline ? " · 离线" : "") + "</span></td>" +
          '<td>' + (c.private ? '<span class="zfv-tag off">私有</span>' : '<span class="zfv-tag on">公开</span>') + "</td>" +
          "<td>" + esc(c.online) + " / " + esc(c.maxUsers) + "</td>" +
          "<td>" + esc(audio.preset || "standard") + " · " + esc(audio.bitrateKbps || 48) + " kbps · rev " + esc(c.revision) + "</td>" +
          "<td>" + (screen.enabled === false ? "关闭" : esc(screen.maxHeight) + "p/" + esc(screen.maxFps) + "fps/" + esc(screen.maxBitrateKbps) + "k") + "</td>" +
          '<td><div class="zfv-ops">' +
          '<button class="zfv-mini" data-act="edit">编辑</button>' +
          '<button class="zfv-mini" data-act="up">上移</button>' +
          '<button class="zfv-mini" data-act="down">下移</button>' +
          '<button class="zfv-mini danger" data-act="del">删除</button>' +
          "</div></td></tr>";
      }).join("");
    }).catch(function (e) { tableError("#zfv-channel-list", 7, e.message); });
  }

  function fillChannelForm(c) {
    c = c || {};
    var a = c.settings && c.settings.audio || {};
    var s = c.settings && c.settings.screen || {};
    $("#zfv-ch-id").value = c.id || "";
    $("#zfv-ch-name").value = c.name || "";
    $("#zfv-ch-descr").value = c.descr || "";
    $("#zfv-ch-icon").value = c.icon || "";
    $("#zfv-ch-ord").value = c.ord || 0;
    $("#zfv-ch-max").value = c.maxUsers || 20;
    $("#zfv-ch-backend").value = c.backend === "self" ? "self_hosted" : "cloudflare";
    $("#zfv-ch-vis").value = c.private ? "private" : "public";
    $("#zfv-ch-scope").value = c.joinScope || "all";
    $("#zfv-ch-pwd").value = "";
    $("#zfv-ch-audio-preset").value = a.preset || "standard";
    $("#zfv-ch-bitrate").value = a.bitrateKbps || 48;
    $("#zfv-ch-rate").value = a.sampleRate || 48000;
    $("#zfv-ch-channels").value = a.channels || 1;
    $("#zfv-ch-frame").value = a.frameMs || 20;
    $("#zfv-ch-dtx").checked = a.dtx !== false;
    $("#zfv-ch-fec").checked = a.fec !== false;
    $("#zfv-ch-screen").checked = s.enabled !== false;
    var h = Number(s.maxHeight) || 1080;
    $("#zfv-ch-res").value = h >= 2160 ? "2160" : h >= 1440 ? "1440" : h >= 1080 ? "1080" : "720";
    $("#zfv-ch-fps").value = s.maxFps || 30;
    $("#zfv-ch-maxbr").value = s.maxBitrateKbps || 4000;
    $("#zfv-ch-sharers").value = s.maxSharers || 2;
    $("#zfv-edit-title").textContent = c.id ? ("编辑频道：" + c.name) : "新建频道";
    $("#zfv-ch-hint").textContent = c.id ? "保存后会把 revision +1 并实时推给在线客户端" : "填写后点「保存频道」创建";
  }

  function channelPayload() {
    var h = Number($("#zfv-ch-res").value) || 1080;
    var w = h >= 2160 ? 3840 : h >= 1440 ? 2560 : h >= 1080 ? 1920 : 1280;
    var body = {
      name: $("#zfv-ch-name").value.trim(),
      descr: $("#zfv-ch-descr").value.trim(),
      icon: $("#zfv-ch-icon").value.trim(),
      ord: Number($("#zfv-ch-ord").value) || 0,
      maxUsers: Number($("#zfv-ch-max").value) || 20,
      backend: $("#zfv-ch-backend").value,
      visibility: $("#zfv-ch-vis").value,
      joinScope: $("#zfv-ch-scope").value,
      joinRoles: $("#zfv-ch-scope").value === "roles" ? ["admin"] : [],
      audio: {
        preset: $("#zfv-ch-audio-preset").value,
        bitrateKbps: Number($("#zfv-ch-bitrate").value) || 48,
        sampleRate: Number($("#zfv-ch-rate").value),
        channels: Number($("#zfv-ch-channels").value),
        frameMs: Number($("#zfv-ch-frame").value),
        dtx: $("#zfv-ch-dtx").checked,
        fec: $("#zfv-ch-fec").checked
      },
      screen: {
        enabled: $("#zfv-ch-screen").checked,
        maxWidth: w, maxHeight: h,
        maxFps: Number($("#zfv-ch-fps").value) || 30,
        maxBitrateKbps: Number($("#zfv-ch-maxbr").value) || 4000,
        maxSharers: Number($("#zfv-ch-sharers").value) || 2
      }
    };
    if ($("#zfv-ch-pwd").value) body.password = $("#zfv-ch-pwd").value;
    return body;
  }

  function onChannelForm(e) {
    e.preventDefault();
    var id = $("#zfv-ch-id").value;
    var body = channelPayload();
    if (!body.name) { msg("#zfv-channel-msg", "请填写频道名称", "bad"); return; }
    var p = id
      ? call("/api/voice/admin/channels/" + encodeURIComponent(id), { method: "PATCH", body: JSON.stringify(body) })
      : call("/api/voice/admin/channels", { method: "POST", body: JSON.stringify(body) });
    p.then(function (d) {
      msg("#zfv-channel-msg", id ? ("已保存，revision " + (d.revision || "?") + "，在线客户端已实时生效") : "频道已创建", "ok");
      if (!id && d.id) $("#zfv-ch-id").value = d.id;
      return loadChannels();
    }).catch(function (ex) { msg("#zfv-channel-msg", ex.message, "bad"); });
  }

  function onChannelTable(e) {
    var btn = e.target.closest("[data-act]");
    if (!btn) return;
    var tr = btn.closest("tr[data-id]");
    var id = tr && tr.getAttribute("data-id");
    var act = btn.getAttribute("data-act");
    var c = channelsCache.filter(function (x) { return x.id === id; })[0];
    if (act === "edit") { fillChannelForm(c); $("#zfv-channel-edit").scrollIntoView({ behavior: "smooth", block: "nearest" }); return; }
    if (act === "del") {
      if (!window.confirm("删除频道会把在线成员全部踢出，确认删除？")) return;
      call("/api/voice/admin/channels/" + encodeURIComponent(id), { method: "DELETE" })
        .then(function () { msg("#zfv-channel-msg", "频道已删除", "ok"); fillChannelForm(null); return loadChannels(); })
        .catch(function (ex) { msg("#zfv-channel-msg", ex.message, "bad"); });
      return;
    }
    if (act === "up" || act === "down") {
      var ids = channelsCache.map(function (x) { return x.id; });
      var i = ids.indexOf(id);
      var j = act === "up" ? i - 1 : i + 1;
      if (j < 0 || j >= ids.length) return;
      var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
      call("/api/voice/admin/channels/reorder", { method: "POST", body: JSON.stringify({ ids: ids }) })
        .then(loadChannels).catch(function (ex) { msg("#zfv-channel-msg", ex.message, "bad"); });
    }
  }

  /* ── 可选自建服务器（阶段 5） ─────────────────────────────── */
  function loadServers() {
    return call("/api/voice/admin/servers").then(function (d) {
      var items = d.items || [], tb = $("#zfv-server-list");
      if (!items.length) { tb.innerHTML = '<tr><td colspan="4">未配置（默认不需要，媒体全部走 Cloudflare SFU）</td></tr>'; return; }
      tb.innerHTML = items.map(function (s) {
        return '<tr data-id="' + esc(s.id) + '"><td>' + esc(s.name) + "</td>" +
          '<td class="mono">' + esc(s.tls ? "wss://" : "ws://") + esc(s.host) + ":" + esc(s.port) + "</td>" +
          "<td>" + esc(s.status || "unknown") + "</td>" +
          '<td><button class="zfv-mini danger" data-act="del">删除</button></td></tr>';
      }).join("");
    }).catch(function (e) { tableError("#zfv-server-list", 4, e.message); });
  }
  function onServerForm(e) {
    e.preventDefault();
    var body = {
      name: $("#zfv-srv-name").value.trim() || "自建服务器",
      host: $("#zfv-srv-host").value.trim(),
      port: Number($("#zfv-srv-port").value) || 7880,
      tls: $("#zfv-srv-tls").checked
    };
    if (!body.host) { msg("#zfv-server-msg", "请填写域名", "bad"); return; }
    call("/api/voice/admin/servers", { method: "POST", body: JSON.stringify(body) })
      .then(function () { msg("#zfv-server-msg", "已保存，密钥只存在 Worker 的环境变量里", "ok"); $("#zfv-server-form").reset(); return loadServers(); })
      .catch(function (ex) { msg("#zfv-server-msg", ex.message, "bad"); });
  }
  function onServerTable(e) {
    var b = e.target.closest('[data-act="del"]');
    if (!b) return;
    var id = b.closest("tr[data-id]").getAttribute("data-id");
    if (!window.confirm("删除该服务器配置？引用它的频道会自动回落到 Cloudflare 后端。")) return;
    call("/api/voice/admin/servers/" + encodeURIComponent(id), { method: "DELETE" })
      .then(loadServers).catch(function (ex) { msg("#zfv-server-msg", ex.message, "bad"); });
  }

  /* ── 汇总加载：每个面板独立报错，绝不永久停在「加载中…」 ─── */
  var loaded = false;
  function loadAll() {
    lastError = "";
    return Promise.all([
      loadInvites(), loadUsers(""), loadSettings(), loadAudit(), loadChannels(), loadServers()
    ]).then(function () { loaded = true; }).catch(function (e) {
      lastError = e.message;
    });
  }

  /* ── 注入 ─────────────────────────────────────────────────── */
  function init() {
    var tabs = $(".tabs");
    if (!tabs || $("#pane-voice")) return;
    injectStyle();

    var btn = document.createElement("button");
    btn.setAttribute("data-tab", "voice");
    btn.textContent = "ZF语音";
    tabs.appendChild(btn);

    var pane = document.createElement("div");
    pane.className = "pane";
    pane.id = "pane-voice";
    pane.innerHTML = HTML;
    tabs.parentNode.appendChild(pane);

    function showVoicePane() {
      $$(".tabs button").forEach(function (x) { x.classList.toggle("on", x === btn); });
      $$(".pane").forEach(function (p) { p.classList.toggle("on", p.id === "pane-voice"); });
      loadAll();
    }
    btn.addEventListener("click", showVoicePane);
    // 后台原有的标签绑定是在脚本加载时一次性遍历 .tabs button 完成的，
    // 这里注入的按钮不在那批里；用事件委托兜住任何形式的切换。
    tabs.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest(".tabs button");
      if (b && b.dataset && b.dataset.tab === "voice" && !$("#pane-voice").classList.contains("on")) showVoicePane();
    });

    $("#zfv-refresh").addEventListener("click", loadAll);
    $("#zfv-invite-form").addEventListener("submit", onCreateInvite);
    $("#zfv-invite-list").addEventListener("click", onInviteTable);
    $("#zfv-user-list").addEventListener("click", onUserTable);
    $("#zfv-user-list").addEventListener("change", onUserTable);
    $("#zfv-user-search").addEventListener("click", function () { loadUsers($("#zfv-user-q").value.trim()); });
    $("#zfv-user-q").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); loadUsers(this.value.trim()); }
    });
    $("#zfv-settings-form").addEventListener("submit", onSaveSettings);
    $("#zfv-captcha-on").addEventListener("change", function () {
      $("#zfv-captcha-mode").disabled = !this.checked;
    });
    $("#zfv-channel-form").addEventListener("submit", onChannelForm);
    $("#zfv-channel-list").addEventListener("click", onChannelTable);
    $("#zfv-ch-new").addEventListener("click", function () { fillChannelForm(null); });
    $("#zfv-server-form").addEventListener("submit", onServerForm);
    $("#zfv-server-list").addEventListener("click", onServerTable);
    fillChannelForm(null);

    // 如果标签页当前就是可见的（浏览器记住了滚动/切换状态），立刻加载；
    // 否则等用户点击。另外登录后令牌才出现时自动重试一次。
    if ($("#pane-voice").classList.contains("on")) loadAll();
    var tries = 0;
    var retry = setInterval(function () {
      if (loaded || ++tries > 30) { clearInterval(retry); return; }
      var tok = "";
      try { tok = localStorage.getItem(TOKEN_KEY) || ""; } catch (_) {}
      if (tok && $("#pane-voice").classList.contains("on")) { clearInterval(retry); loadAll(); }
    }, 2000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
