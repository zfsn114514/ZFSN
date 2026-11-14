/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 前端鉴权层（阶段 2）
 *
 *  只负责：配置读取、验证码图片 / Turnstile、登录注册表单、头像压缩、
 *  当前会话、登出。语音页面布局与交互仍由 voice.js 管。
 *  所有凭据都靠 HttpOnly Cookie（credentials: same-origin），
 *  页面里不保存任何长期令牌，localStorage 只存主题偏好。
 * ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var BASE = "/api/voice";
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  var state = {
    config: { registrationOpen: true, captchaMode: "image", turnstileSiteKey: "", captchaLength: 5 },
    user: null,
    captchaId: { login: "", register: "" },
    avatar: null,           // 压缩后的 data URL
    avatarPreviewUrl: "",   // 仅用于预览
    turnstileToken: "",
    turnstileLoaded: false,
    tab: "login"
  };
  var handlers = {};

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function on(name, fn) {
    (handlers[name] = handlers[name] || []).push(fn);
  }
  function emit(name, data) {
    (handlers[name] || []).forEach(function (fn) {
      try { fn(data); } catch (e) { console.warn("[voice/auth] 回调异常", e); }
    });
  }

  async function request(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || "GET",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" }
    };
    if (opts.body) init.body = JSON.stringify(opts.body);
    var r = await fetch(BASE + path, init);
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok || d.ok === false) {
      var e = new Error(d.error || ("服务返回异常 (HTTP " + r.status + ")"));
      e.status = r.status;
      throw e;
    }
    return d;
  }

  /* ── 界面提示 ─────────────────────────────────────────────── */
  function showError(msg) {
    var el = $("#auth-error");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
  }
  function busy(form, on_, text) {
    var b = form.querySelector('button[type="submit"]');
    if (!b) return;
    b.disabled = !!on_;
    if (b.dataset.label === undefined) b.dataset.label = b.textContent;
    b.textContent = on_ ? (text || "请稍候…") : b.dataset.label;
  }
  function notify(msg) { emit("message", msg); }

  /* ── 验证码（自制图片）───────────────────────────────────── */
  async function refreshCaptcha(which) {
    which = which || state.tab;
    var btn = $("#captcha-" + which);
    if (!btn) return;
    btn.innerHTML = '<span class="captcha-loading">加载中…</span>';
    try {
      var d = await request("/captcha");
      state.captchaId[which] = d.captchaId;
      btn.innerHTML = '<img src="' + esc(d.image) + '" alt="点击刷新验证码">' +
        '<span class="captcha-refresh">点击刷新</span>';
    } catch (e) {
      state.captchaId[which] = "";
      btn.innerHTML = '<span class="captcha-loading">加载失败<br>点击重试</span>';
      showError(e.message);
    }
  }

  /* ── Turnstile（管理员可在后台一键切换）───────────────────── */
  function loadTurnstileScript() {
    if (state.turnstileLoaded) return Promise.resolve(true);
    return new Promise(function (resolve) {
      var s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true; s.defer = true;
      s.onload = function () { state.turnstileLoaded = true; resolve(true); };
      s.onerror = function () { resolve(false); };
      document.head.appendChild(s);
    });
  }

  function resetTurnstile() {
    state.turnstileToken = "";
    try {
      if (window.turnstile && $("#turnstile-slot")) window.turnstile.reset("#turnstile-slot");
    } catch (_) {}
  }

  async function setupTurnstile() {
    var slot = $("#turnstile-slot");
    if (!slot) return;
    if (state.config.captchaMode !== "turnstile") {
      slot.hidden = true;
      $$(".captcha-row").forEach(function (r) { r.hidden = false; });
      return;
    }
    $$(".captcha-row").forEach(function (r) { r.hidden = true; });
    slot.hidden = false;
    if (!state.config.turnstileSiteKey) {
      slot.innerHTML = '<p class="auth-error-inline">管理员尚未配置 Turnstile Site Key，请改回图片验证码或联系管理员。</p>';
      return;
    }
    var okScript = await loadTurnstileScript();
    if (!okScript) {
      slot.innerHTML = '<p class="auth-error-inline">人机验证组件加载失败（网络不可达）。请检查网络或让管理员切回图片验证码。</p>';
      return;
    }
    slot.innerHTML = "";
    try {
      window.turnstile.render(slot, {
        sitekey: state.config.turnstileSiteKey,
        theme: "dark",
        callback: function (token) { state.turnstileToken = token; },
        "expired-callback": function () { state.turnstileToken = ""; },
        "error-callback": function () { state.turnstileToken = ""; }
      });
    } catch (e) {
      slot.innerHTML = '<p class="auth-error-inline">人机验证初始化失败：' + esc(e.message) + "</p>";
    }
  }

  /* ── 头像：前端居中裁正方形 + 压到 256px ─────────────────── */
  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      if (window.createImageBitmap) {
        createImageBitmap(file).then(resolve, function () { fallback(); });
      } else { fallback(); }
      function fallback() {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("图片读取失败")); };
        img.src = url;
      }
    });
  }

  async function compressAvatar(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      throw new Error("头像仅支持 jpg / png / webp");
    }
    if (file.size > 2 * 1024 * 1024) throw new Error("头像不能超过 2 MB");
    var img = await loadImage(file);
    var w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    if (!w || !h) throw new Error("无法读取图片尺寸");
    var side = Math.min(w, h);
    var canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 256, 256);
    if (img.close) img.close();
    var url = canvas.toDataURL("image/webp", 0.86);
    // Safari 老版本不支持 webp 编码时 toDataURL 会退回 png，服务端也接受 png
    if (url.indexOf("data:image/webp") !== 0) url = canvas.toDataURL("image/jpeg", 0.86);
    return url;
  }

  function renderAvatarPreview() {
    var box = $("#avatar-preview");
    if (!box) return;
    if (state.avatarPreviewUrl) {
      box.textContent = "";
      box.style.backgroundImage = 'url("' + state.avatarPreviewUrl + '")';
      box.style.backgroundSize = "cover";
      box.style.backgroundPosition = "center";
    } else {
      var name = ($("#reg-name") && $("#reg-name").value.trim()) || "Z";
      box.style.backgroundImage = "";
      box.textContent = Array.from(name)[0] || "Z";
    }
  }

  /* ── 当前登录态 ───────────────────────────────────────────── */
  async function bootstrap() {
    try {
      var cfg = await request("/config");
      state.config = {
        registrationOpen: !!cfg.registrationOpen,
        captchaMode: cfg.captchaMode === "turnstile" ? "turnstile" : "image",
        turnstileSiteKey: cfg.turnstileSiteKey || "",
        captchaLength: cfg.captchaLength || 5
      };
    } catch (e) {
      showError("无法读取站点配置：" + e.message + "（请确认后端已启动并执行了 0003 迁移）");
      await setupTurnstileFallback();
      await refreshCaptcha("login");
      return null;
    }
    applyConfig();
    try {
      var d = await request("/me");
      state.user = d.user || null;
    } catch (_) { state.user = null; }
    return state.user;
  }

  async function setupTurnstileFallback() {
    // 配置读不到时按图片验证码显示，避免表单完全不可用
    try { await setupTurnstile(); } catch (_) {}
  }

  function applyConfig() {
    var tab = $("#tab-register");
    if (tab) {
      tab.hidden = !state.config.registrationOpen;
      if (!state.config.registrationOpen) switchTab("login");
    }
    var hint = $("#auth-hint");
    if (hint) hint.textContent = state.config.registrationOpen
      ? "小圈子私有站点 · 注册需要管理员发放的邀请码"
      : "当前未开放注册，已有账号可直接登录";
    setupTurnstile();
    // 初始化时把登录 / 注册两份验证码都备好：否则隐藏的注册页会一直显示
    // 「加载中…」，用户点开瞬间才去请求，弱网下容易误以为坏了。
    if (state.config.captchaMode === "image") {
      refreshCaptcha("login");
      if (state.config.registrationOpen) refreshCaptcha("register");
    }
  }

  /* ── Tab / 表单 ───────────────────────────────────────────── */
  function switchTab(which) {
    state.tab = which === "register" ? "register" : "login";
    var login = state.tab === "login";
    $("#tab-login").setAttribute("aria-selected", String(login));
    $("#tab-register").setAttribute("aria-selected", String(!login));
    $("#form-login").hidden = !login;
    $("#form-register").hidden = login;
    showError("");
    // 已有可用挑战就不重复申请，避免每次切换标签都消耗一次验证码挑战
    if (state.config.captchaMode === "image") {
      if (!state.captchaId[state.tab]) refreshCaptcha(state.tab);
    } else resetTurnstile();
  }

  function humanPayload(which) {
    if (state.config.captchaMode === "turnstile") {
      return { turnstileToken: state.turnstileToken };
    }
    return { captchaId: state.captchaId[which], captcha: $("#" + which + "-captcha").value.trim() };
  }

  function afterHumanFail(which) {
    if (state.config.captchaMode === "image") refreshCaptcha(which);
    else resetTurnstile();
  }

  function bindForms() {
    $$(".auth-tabs [data-tab]").forEach(function (b) {
      b.addEventListener("click", function () { switchTab(b.getAttribute("data-tab")); });
    });

    ["#captcha-login", "#captcha-register"].forEach(function (sel) {
      var btn = $(sel);
      if (btn) btn.addEventListener("click", function () { refreshCaptcha(sel.indexOf("login") >= 0 ? "login" : "register"); });
    });

    $("#form-login").addEventListener("submit", async function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      showError("");
      var username = $("#login-user").value.trim();
      var password = $("#login-pwd").value;
      if (!username || !password) { showError("请填写用户名和密码"); return; }
      if (state.config.captchaMode === "image" && !$("#login-captcha").value.trim()) {
        showError("请填写图中的数字"); return;
      }
      busy(form, true, "登录中…");
      try {
        var d = await request("/login", {
          method: "POST",
          body: Object.assign({ username: username, password: password }, humanPayload("login"))
        });
        state.user = d.user;
        $("#login-pwd").value = "";
        emit("authed", d.user);
      } catch (ex) {
        showError(ex.message);
        afterHumanFail("login");
      } finally { busy(form, false); }
    });

    $("#form-register").addEventListener("submit", async function (e) {
      e.preventDefault();
      var form = e.currentTarget;
      showError("");
      var p1 = $("#reg-pwd").value, p2 = $("#reg-pwd2").value;
      if (p1 !== p2) { showError("两次输入的密码不一致"); return; }
      if (state.config.captchaMode === "image" && !$("#reg-captcha").value.trim()) {
        showError("请填写图中的数字"); return;
      }
      busy(form, true, "创建中…");
      try {
        var d = await request("/register", {
          method: "POST",
          body: Object.assign({
            invite: $("#reg-invite").value.trim(),
            username: $("#reg-user").value.trim(),
            displayName: $("#reg-name").value.trim(),
            password: p1,
            password2: p2,
            avatar: state.avatar
          }, humanPayload("register"))
        });
        state.user = d.user;
        form.reset();
        state.avatar = null; state.avatarPreviewUrl = "";
        renderAvatarPreview();
        emit("authed", d.user);
      } catch (ex) {
        showError(ex.message);
        afterHumanFail("register");
      } finally { busy(form, false); }
    });

    $("#reg-name").addEventListener("input", function () {
      if (!state.avatarPreviewUrl) renderAvatarPreview();
    });

    $("#reg-avatar").addEventListener("change", async function (e) {
      var f = e.target.files && e.target.files[0];
      state.avatar = null;
      state.avatarPreviewUrl = "";
      if (!f) { renderAvatarPreview(); return; }
      try {
        state.avatar = await compressAvatar(f);
        state.avatarPreviewUrl = state.avatar;
        renderAvatarPreview();
        notify("头像已裁剪为正方形并压缩，注册后生效");
      } catch (ex) {
        e.target.value = "";
        showError(ex.message);
        renderAvatarPreview();
      }
    });
  }

  /* ── 对外 API ─────────────────────────────────────────────── */
  window.VoiceAuth = {
    on: on,
    bindForms: bindForms,
    bootstrap: bootstrap,
    esc: esc,
    current: function () { return state.user; },
    config: function () { return state.config; },
    switchTab: switchTab,
    renderAvatarPreview: renderAvatarPreview,
    logout: async function () {
      try { await request("/logout", { method: "POST" }); } catch (_) {}
      state.user = null;
      emit("logout", null);
      return null;
    },
    /** 生成头像 HTML。user 来自 /api/voice/me，字段都已由服务端过滤。 */
    avatarHTML: function (user, cls) {
      if (!user) return "";
      var c = esc(user.avatarColor || "#7a1830");
      var ch = esc(Array.from(String(user.displayName || "Z"))[0] || "Z");
      if (user.avatarUrl) {
        return '<span class="avatar ' + esc(cls || "") + '" style="background:' + c +
          ';background-image:url(' + esc(user.avatarUrl) + ');background-size:cover;' +
          'background-position:center" aria-hidden="true"></span>';
      }
      return '<span class="avatar ' + esc(cls || "") + '" style="background:' + c +
        '" aria-hidden="true">' + ch + "</span>";
    }
  };
})();
