/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 页面状态机（阶段 3~6，真实链路）
 *
 *  · 登录态：HttpOnly Cookie，由 voice/auth.js 维护；未登录只显示登录 / 注册。
 *  · 频道 / 成员 / 设置：Cloudflare Worker + Durable Object（唯一生产后端）。
 *  · 媒体：VoiceTransport 统一抽象（Cloudflare SFU / 本地直连 / 可选 LiveKit）。
 *  · ?preview=1 仅用于无后端时的布局验收，明确标「预览模式」，不连任何服务。
 *  · 所有动态文本统一走 esc()，防 XSS。
 * ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* esc() 只负责 HTML 实体，挡不住 CSS 注入：style="...url(XXX)..." 里的
     XXX 被浏览器当作 CSS 解析，`x);background:url(//外部域名)` 这类值即使
     引号已转义，仍能闭合 url() 后追加任意 CSS（外链请求、覆盖整页等）。
     所以凡是拼进 style 的值都必须走白名单，而不是 esc()。 */
  function safeColor(c) {
    var s = String(c == null ? "" : c).trim();
    return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s : "#7a1830";
  }
  function safeCssUrl(u) {
    var s = String(u == null ? "" : u).trim();
    if (!s) return "";
    // 本站头像：/api/voice/avatars/<32位hex>（用户 id 为 randomHex(16)）
    if (/^\/api\/voice\/avatars\/[A-Za-z0-9._%~-]{1,80}$/.test(s)) return s;
    // 内联图片：只允许位图 + base64（data:image/svg 可执行脚本，一律拒绝）。
    // 长度上限放到 4MB base64，兼容「2MB 图片上限」的本地预览。
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]{1,4000000}$/.test(s)) return s;
    return "";
  }

  /* ── 请求封装 ──────────────────────────────────────────────── */
  /** 后端没给出 error 字段时，按状态码翻译成可读中文（并带上接口路径便于排查）。 */
  function httpMessage(status, path) {
    if (status === 401) return "登录状态已失效，请刷新页面重新登录";
    if (status === 403) return "没有权限执行该操作（" + path + "）";
    if (status === 404) return "接口不存在（" + path + "），可能是服务端版本过旧";
    if (status === 409) return "操作冲突，请刷新后重试";
    if (status === 413) return "上传内容过大";
    if (status === 429) return "操作过于频繁，请稍后再试";
    if (status >= 500) return "服务器暂时不可用（" + status + "），请稍后重试";
    return "请求失败（HTTP " + status + "，" + path + "）";
  }
  function api(path, method, body) {
    var opt = { method: method || "GET", credentials: "same-origin",
      headers: { "Content-Type": "application/json" } };
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 12000) : null;
    if (controller) opt.signal = controller.signal;
    if (body !== undefined) opt.body = JSON.stringify(body);
    return fetch(path, opt).then(function (r) {
      // 用 text() 再手动解析：错误响应可能是 HTML（网关 502 页），
      // 直接 r.json() 失败会退化成空对象，最终只剩一句没用的 "HTTP 502"。
      return r.text().then(function (raw) {
        var d = {};
        if (raw) { try { d = JSON.parse(raw); } catch (_) { d = {}; } }
        if (r.ok && (!d || d.ok !== false)) return d;
        throw new Error((d && d.error) || httpMessage(r.status, path));
      });
    }).catch(function (e) {
      if (e && e.name === "AbortError") throw new Error("连接服务器超时（" + path + "），请检查网络后重试");
      // fetch 自身失败（断网 / DNS / 被拦截 / CORS）抛的是 TypeError，
      // 原文 "Failed to fetch" 对用户没有意义，这里统一翻译。
      if (e && e.name === "TypeError") {
        throw new Error("无法连接服务器（" + path + "）：网络中断或被浏览器拦截，请检查网络后重试");
      }
      throw e;
    }).then(function (d) {
      if (timer) clearTimeout(timer);
      return d;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }

  /* ── 预览用的 mock（不连任何服务） ─────────────────────────── */
  function member(id, name, color, extra) {
    var m = { id: id, name: name, color: color, speaking: false, mic: true, deaf: false, sharing: false };
    if (extra) for (var k in extra) m[k] = extra[k];
    return m;
  }
  var MOCK_CHANNELS = [
    { id: "cf-lobby", name: "开黑频道1", backend: "cloudflare", visibility: "public", private: false,
      maxUsers: 20, online: 2, offline: false, descr: "ZF语音默认频道", revision: 1,
      settings: { audio: { bitrateKbps: 48 }, screen: { enabled: true, maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrateKbps: 4000, maxSharers: 2 } },
      members: [member("u1", "艺", "#5a3b7a"), member("u2", "JumpSH", "#2c6a5a", { sharing: true })] },
    { id: "cf-2", name: "开黑频道2", backend: "cloudflare", visibility: "public", private: false,
      maxUsers: 20, online: 0, offline: false, descr: "第二语音房", revision: 1,
      settings: { audio: { bitrateKbps: 48 }, screen: { enabled: true, maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrateKbps: 4000, maxSharers: 2 } }, members: [] },
    { id: "self-1", name: "自建示例（离线）", backend: "self", visibility: "private", private: true,
      maxUsers: 20, online: 0, offline: true, descr: "可选高级模式", revision: 1,
      settings: { audio: { bitrateKbps: 48 }, screen: { enabled: true, maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrateKbps: 4000, maxSharers: 2 } }, members: [] }
  ];

  var state = {
    user: null, channels: [], capabilities: {}, settings: {},
    preview: false, group: "all", current: null, expanded: {},
    members: [], mic: true, deaf: false, ptt: false, pttKey: "", pttDown: false,
    // 说话方式：voice = 语音激活（靠激活阈值自动开麦），ptt = 按键说话
    talkMode: "voice", threshold: 30,
    membersCollapsed: false, drawer: "", watching: true, sounds: true,
    chatMessages: [], chatUnread: 0, chatOpen: window.matchMedia("(max-width:760px)").matches ? false : true, chatPinned: true,
    room: null, transport: null, join: null, channelSettings: null,
    // 加入流程代号：每次切换 / 离开都自增，让还在网络请求中的旧加入流程立即作废，
    // 避免「来回切频道」时旧频道的 WebSocket 变成没人关闭的幽灵成员。
    joinSeq: 0,
    stats: { rttMs: null, lossPct: 0 }, statsTimer: null, statsSeq: 0,
    speakingTimer: null, demoTimer: null, lastSpeakSent: 0,
    sharing: false, shareParams: null, sharerId: null
  };

  /* ── 小工具 ────────────────────────────────────────────────── */
  var toastTimer;
  function toast(text) {
    var el = $("#toast");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }
  function openDlg(id) {
    var d = document.getElementById(id);
    if (!d) return;
    if (typeof d.showModal === "function") { if (!d.open) d.showModal(); }
    else d.setAttribute("open", "");
  }
  function closeDlg(id) {
    var d = document.getElementById(id);
    if (!d) return;
    if (typeof d.close === "function" && d.open) d.close();
    else d.removeAttribute("open");
  }

  /** 加入 / 离开提示音：WebAudio 生成短促双音，不依赖外部音频文件。
      每次用完立刻 close()：浏览器对同时存活的 AudioContext 有上限（约 6 个），
      长期复用同一个又从不关闭，会在反复进出频道后让后续音频功能静默失效。 */
  function chime(join) {
    if (!state.sounds) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    var ctx;
    try { ctx = new AC(); } catch (_) { return; }
    var released = false;
    function release() {
      if (released) return;
      released = true;
      try { var p = ctx.close(); if (p && p.catch) p.catch(function () {}); } catch (_) {}
    }
    try {
      if (ctx.state === "suspended") ctx.resume().catch(function () {});
      var t = ctx.currentTime;
      [0, 0.12].forEach(function (off, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = join ? (i ? 660 : 523) : (i ? 392 : 494);
        g.gain.setValueAtTime(0.0001, t + off);
        g.gain.exponentialRampToValueAtTime(0.09, t + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + off + 0.16);
        o.connect(g); g.connect(ctx.destination);
        o.start(t + off); o.stop(t + off + 0.18);
      });
      // 声音最长 0.30s，留足余量后释放；页面被隐藏时也要释放。
      setTimeout(release, 600);
      window.addEventListener("pagehide", release, { once: true });
    } catch (_) {
      release();
    }
  }

  function me() {
    return {
      id: state.user ? state.user.id : "me",
      name: state.user ? state.user.displayName : "ZFSN114514",
      color: state.user ? state.user.avatarColor : "#7a1830",
      avatarUrl: state.user ? state.user.avatarUrl : null,
      mic: state.mic, deaf: state.deaf, speaking: false, sharing: state.sharing
    };
  }
  function channelById(id) {
    for (var i = 0; i < state.channels.length; i++) if (state.channels[i].id === id) return state.channels[i];
    return null;
  }
  function visibleChannels() {
    return state.channels.filter(function (c) {
      if (state.group === "all") return true;
      if (state.group === "cloudflare") return c.backend === "cloudflare";
      return c.backend === "self";
    });
  }
  function roomMembers() {
    if (state.preview) {
      var ch = channelById(state.current);
      return ch ? [me()].concat(ch.members) : [];
    }
    if (!state.current) return [];
    // 房间成员里已包含自己（DO 广播），没有时补一个占位
    var list = state.members.slice();
    if (!list.some(function (m) { return m.id === me().id; })) list = [me()].concat(list);
    list.forEach(function (m) {
      if (m.id === me().id) { m.mic = state.mic; m.deaf = state.deaf; m.sharing = state.sharing; }
    });
    return list;
  }
  function avatarHTML(m, cls) {
    var color = safeColor(m && m.color);
    var url = safeCssUrl(m && m.avatarUrl);
    var head = '<span class="avatar ' + esc(cls || "") + '" style="background:' + color;
    if (url) {
      return head + ";background-image:url(&quot;" + esc(url) +
        "&quot;);background-size:cover;background-position:center\" aria-hidden=\"true\"></span>";
    }
    return head + '" aria-hidden="true">' + esc(String((m && m.name) || "Z").slice(0, 1)) + "</span>";
  }
  function statusIcons(m) {
    var out = "";
    if (!m.mic) out += '<span class="muted-icon" title="已静音">静音</span>';
    if (m.deaf) out += '<span class="muted-icon" title="耳机关闭">耳机关</span>';
    if (m.sharing) out += '<span class="badge self" title="正在共享屏幕">共享中</span>';
    return out;
  }
  function isAdmin() { return !!(state.user && state.user.role === "admin"); }

  /* ── 渲染 ──────────────────────────────────────────────────── */
  function renderChannels() {
    var list = visibleChannels();
    $("#channel-count").textContent = String(list.length);
    var html = "";
    list.forEach(function (ch) {
      var active = state.current === ch.id;
      var expanded = active || !!state.expanded[ch.id];
      var n = Number(ch.online) || 0;
      var badge = ch.offline ? '<span class="badge offline">离线</span>'
        : '<span class="badge ' + (ch.backend === "cloudflare" ? "cloud" : "self") + '">' +
          (ch.backend === "cloudflare" ? "云" : "自建") + "</span>";
      if (ch.private) badge += '<span class="badge private" title="私有频道">私</span>';
      html += '<li class="channel-item">' +
        '<button type="button" class="channel-row' + (active ? " active" : "") +
        '" data-channel="' + esc(ch.id) + '" aria-expanded="' + expanded + '">' +
        '<span class="ch-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg></span>' +
        '<span class="ch-name">' + esc(ch.name) + "</span>" + badge +
        '<span class="ch-n">' + (ch.offline ? "—" : n + "/" + (ch.maxUsers || 20)) + "</span>" +
        "</button>";
      if (ch.ownerId === me().id || isAdmin()) html += '<button type="button" class="channel-more" data-channel-menu="' + esc(ch.id) + '" aria-label="编辑或删除频道">⋯</button>';
      var ms = expanded && !ch.offline ? (active ? roomMembers() : (ch.members || [])) : [];
      if (ms.length) {
        html += '<ul class="ch-members">';
        ms.forEach(function (m) {
          html += '<li class="' + (m.speaking ? "speaking" : "") + '"><span class="dot"></span>' +
            "<span>" + esc(m.name) + "</span>" +
            (!m.mic ? '<span class="mini-tag">静音</span>' : "") +
            (m.sharing ? '<span class="mini-tag">共享中</span>' : "") + "</li>";
        });
        html += "</ul>";
      }
      html += "</li>";
    });
    $("#channel-list").innerHTML = html || '<li class="empty-list">还没有频道，点左下「+」添加一个私有频道</li>';
  }

  function renderMemberList() {
    var ch = channelById(state.current);
    var list = roomMembers();
    $("#member-count").textContent = String(list.length);
    $("#members-foot").textContent = ch ? (ch.name + " · " + (ch.descr || "")) : "选择频道查看成员";
    $("#member-list").innerHTML = list.map(function (m) {
      var mine = m.id === me().id;
      var vol = Math.round((state.transport && state.transport.memberVolumes[m.id] != null
        ? state.transport.memberVolumes[m.id] : 1) * 100);
      return '<li class="' + (m.speaking ? "speaking" : "") + '" data-member="' + esc(m.id) + '">' +
        avatarHTML(m) + '<span class="m-text"><strong>' + esc(m.name) + "</strong><small>" +
        (m.sharing ? "正在共享屏幕" : (m.speaking ? "正在说话" : (m.deaf ? "耳机已关闭" : "在线"))) +
        "</small></span>" + statusIcons(m) +
        '<div class="m-controls">' +
        (mine ? "" : '<label class="vol-mini" title="单独音量"><input type="range" min="0" max="200" value="' + vol +
          '" data-vol="' + esc(m.id) + '" aria-label="调整 ' + esc(m.name) + ' 的音量"></label>') +
        (isAdmin() && !mine && !state.preview ? '<button class="mini-btn" data-act="mute" data-id="' + esc(m.id) + '" aria-label="禁言 ' + esc(m.name) + '">禁言</button>' +
          '<button class="mini-btn danger" data-act="kick" data-id="' + esc(m.id) + '" aria-label="踢出 ' + esc(m.name) + '">踢出</button>' : "") +
        "</div></li>";
    }).join("");
  }

  function renderRoom() {
    var ch = channelById(state.current);
    if (!ch) return;
    $("#room-name").textContent = ch.name;
    $("#room-backend").textContent = ch.offline ? "离线" : (ch.backend === "cloudflare" ? "云 · Cloudflare Worker" : "自建 · LiveKit");
    $("#room-backend").className = "badge " + (ch.offline ? "offline" : (ch.backend === "cloudflare" ? "cloud" : "self"));
    var list = roomMembers();
    $("#room-online").textContent = list.length + " / " + (ch.maxUsers || 20) + " 人在线";
    var q = state.stats;
    $("#room-quality").textContent = "连接质量：" +
     (q.rttMs == null ? (state.join ? "连接中…" : "—") :
       Math.round(q.rttMs) + " ms · 丢包 " + (q.lossPct == null ? "—" : Number(q.lossPct).toFixed(1) + "%"));

    $("#member-grid").innerHTML = list.map(function (m) {
      return '<div class="member-card' + (m.speaking ? " speaking" : "") + (m.sharing ? " sharing" : "") + '">' +
        avatarHTML(m) + '<span class="name">' + esc(m.name) + "</span>" +
        '<span class="tags">' + (m.id === me().id ? "我" : "成员") +
        (m.speaking ? " · 说话中" : "") + "</span>" + statusIcons(m) + "</div>";
    }).join("");

    var sharer = list.filter(function (m) { return m.sharing; })[0];
    state.sharerId = sharer ? sharer.id : null;
    var showScreen = !!sharer;
    var stage = $("#screen-stage");
    stage.hidden = !showScreen;
    $("#member-grid").hidden = showScreen;
    if (sharer) {
      $("#screen-owner").textContent = sharer.name + " 正在共享屏幕";
      $("#screen-strip").innerHTML = list.map(function (m) {
        return '<div class="strip-item">' + avatarHTML(m) + "<span>" + esc(m.name) + "</span></div>";
      }).join("");
    }
    var video = $("#screen-video");
    var ph = $("#screen-placeholder");
    var sub = $("#screen-sub");
    if (video) {
      var hasStream = !!(video.srcObject && video.srcObject.getVideoTracks().length);
      var readyFrame = !!(video.videoWidth && video.videoHeight && video.readyState >= 2);
      ph.hidden = hasStream && state.watching && readyFrame;
      video.style.opacity = (hasStream && state.watching) ? "1" : "0";
      if (sub) {
        if (!state.watching) sub.textContent = "已停止观看，点击「重新观看」恢复";
        else if (state.sharing && state.sharerId === me().id) sub.textContent = "你正在共享屏幕";
        else if (!hasStream) sub.textContent = sharer ? "正在连接对方画面…" : "等待画面…";
        else if (!readyFrame) sub.textContent = "等待首帧…";
        else sub.textContent = video.videoWidth + "×" + video.videoHeight;
      }
    }
    $("#btn-stop-share").hidden = !state.sharing;
    $("#btn-stop-watch").textContent = state.watching ? "不观看" : "重新观看";
  }

  function renderChat() {
    var list = $("#chat-messages"), html = "";
    state.chatMessages.forEach(function (m) {
      var own = m.memberId === me().id;
      var time = new Date(Number(m.ts) || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      html += '<article class="chat-message' + (own ? " own" : "") + '">' +
        avatarHTML({ name: m.name, color: m.color, avatarUrl: m.avatarUrl }, "chat-avatar") +
        '<div class="chat-content"><div class="chat-meta"><strong>' + esc(m.name) + "</strong><time>" + esc(time) +
        '</time></div><p></p></div></article>';
    });
    list.innerHTML = html;
    var texts = list.querySelectorAll(".chat-content p");
    state.chatMessages.forEach(function (m, i) { if (texts[i]) texts[i].textContent = m.text; });
    $("#chat-unread").hidden = state.chatUnread < 1 || state.chatOpen;
    $("#chat-unread").textContent = state.chatUnread ? String(state.chatUnread) : "";
    $("#chat-mobile-unread").hidden = state.chatUnread < 1;
    $("#chat-mobile-unread").textContent = state.chatUnread ? String(state.chatUnread) : "";
    $("#chat-panel").classList.toggle("collapsed", !state.chatOpen);
    $("#btn-chat-toggle").textContent = state.chatOpen ? "收起" : "展开";
    $("#btn-chat-toggle").setAttribute("aria-expanded", String(state.chatOpen));
  }
  function renderUserbar() {
    var m = me();
    var avatarUrl = safeCssUrl(m.avatarUrl);
    $("#me-name").textContent = m.name;
    var av = $("#me-avatar");
    av.textContent = avatarUrl ? "" : m.name.slice(0, 1);
    av.style.background = safeColor(m.color);
    av.style.backgroundImage = avatarUrl ? 'url("' + avatarUrl + '")' : "";
    av.style.backgroundSize = "cover";
    av.style.backgroundPosition = "center";
    var mic = $("#btn-mic"), deaf = $("#btn-deaf");
    mic.setAttribute("aria-pressed", String(state.mic));
    mic.setAttribute("aria-label", state.mic ? "关闭麦克风" : "打开麦克风");
    mic.classList.toggle("off", !state.mic);
    deaf.setAttribute("aria-pressed", String(state.deaf));
    deaf.setAttribute("aria-label", state.deaf ? "恢复收听" : "静音全部");
    deaf.classList.toggle("off", state.deaf);
    $("#me-status").textContent = state.deaf ? "耳机已关闭" : (state.ptt ? "按键说话" : "在线");
    $("#call-info").hidden = !state.current;
    $("#conn-text").textContent = state.current ? (state.transport ? "已连接" : "连接中") : "未连接";
    var q = state.stats;
    $("#rtt-text").textContent = q.rttMs == null ? "延迟 — ms"
      : "延迟 " + Math.round(q.rttMs) + " ms · 丢包 " + (q.lossPct == null ? "—" : Number(q.lossPct).toFixed(1) + "%");
  }

  function renderAll() {
    renderChannels(); renderMemberList(); renderRoom(); renderChat(); renderUserbar();
    $("#v-layout").classList.toggle("no-members", state.membersCollapsed);
    $("#v-layout").classList.toggle("drawer-channels", state.drawer === "channels");
    $("#v-layout").classList.toggle("drawer-members", state.drawer === "members");
    $("#btn-menu").setAttribute("aria-expanded", String(state.drawer === "channels"));
  }

  /* ── 视图切换 ──────────────────────────────────────────────── */

  /** 当前是不是独立登录页 /voice/login（Worker 把同一份 HTML 也映射到那里）。 */
  function onLoginPage() {
    return /^\/voice\/login\/?$/.test(location.pathname);
  }

  /** 登录页与应用页互斥：切视图前必须把弹窗收干净，
      否则 modal 会留在顶层挡住登录表单，看起来就像「关不掉、卡在登录页」。 */
  function closeAllDialogs() {
    $$("dialog[open]").forEach(function (d) {
      try { d.close(); } catch (_) { d.removeAttribute("open"); }
    });
  }

  function showApp(user, badge) {
    if (user) {
      state.user = user;
      state.preview = false;
    }
    state.current = null;
    $("#auth-view").hidden = true;
    $("#app-view").hidden = false;
    $("#env-badge").hidden = false;
    $("#env-badge").textContent = badge || (state.capabilities.sfu ? "Cloudflare SFU" : "本地直连降级");
    $("#welcome").hidden = false;
    $("#room").hidden = true;
    $("#screen-stage").hidden = true;
    // 频道数据已就绪，撤掉「正在恢复登录态」遮罩，把视图交回 hidden 属性控制
    VoiceAuth.session.ready();
    renderAll();
  }
  function showAuth(reason) {
    closeAllDialogs();
    leaveChannel(true).catch(function () {});
    state.user = null;
    state.channels = [];
    state.current = null;
    clearInterval(state.demoTimer);
    // 清掉预登录标记与用户资料缓存，并按需初始化验证码 / Turnstile
    VoiceAuth.session.guest();
    // 登录页有独立地址：从应用视图掉线时直接跳过去（整页重载），
    // 比在 /voice 里就地换成登录壳更干净 —— 刷新 /voice 也不会再看到登录页。
    if (!onLoginPage()) {
      location.replace("/voice/login" + (reason ? "?reason=" + encodeURIComponent(reason) : ""));
      return;
    }
    $("#app-view").hidden = true;
    $("#auth-view").hidden = false;
    VoiceAuth.session.prepareGuest();
  }

  /* ── 真实房间 ──────────────────────────────────────────────── */
  function applyMic() {
    var enabled = state.talkMode === "ptt" ? state.pttDown : state.mic;
    if (state.transport) state.transport.setMic(enabled);
    renderUserbar();
    renderMemberList();
  }

  /* 阈值滑块的 0~100 → 传输层用的 RMS 线性值。
     0.025 是旧版写死的「说话」判定线，对应滑块 20，所以默认给 30 略高一点，
     刚好能滤掉键盘声和空调底噪。 */
  function thresholdToRms(v) {
    var n = Math.max(0, Math.min(100, Number(v) || 0));
    return 0.005 + n * 0.001;
  }
  /** 把当前说话方式 / 阈值推给传输层（未进频道时什么都不做）。 */
  function syncVoiceGate() {
    if (!state.transport || !state.transport.setVoiceGate) return;
    state.transport.setVoiceGate({
      enabled: state.talkMode === "voice",
      threshold: thresholdToRms(state.threshold)
    });
  }

  /* ── 设置弹窗：分类切换 + 说话方式 + 电平表 ─────────────────── */
  var setPane = "devices";
  function showPane(name) {
    setPane = name || "devices";
    $$(".set-tab").forEach(function (b) {
      var on = b.getAttribute("data-pane") === setPane;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    $$(".set-pane").forEach(function (p) {
      p.hidden = p.getAttribute("data-pane") !== setPane;
    });
  }

  function thresholdMarkPct(v) {
    return Math.max(0, Math.min(100, Math.round(thresholdToRms(v) / 0.11 * 100)));
  }

  /** 统一设置 UI（打开弹窗和启动时都用它，避免两处状态对不上）。 */
  function renderTalkUI() {
    var voice = state.talkMode !== "ptt";
    $("#seg-voice").classList.toggle("on", voice);
    $("#seg-ptt").classList.toggle("on", !voice);
    $("#set-mode-voice").checked = voice;
    $("#set-mode-ptt").checked = !voice;
    $("#set-threshold").value = String(state.threshold);
    $("#set-threshold").disabled = !voice;
    $("#threshold-label").textContent = "阈值 " + state.threshold;
    $("#set-meter-mark").style.left = thresholdMarkPct(state.threshold) + "%";
    $("#set-key-hint").textContent = voice ? "仅按键说话时使用" : "点「设置」后按一下要用的键";
  }

  function setTalkMode(mode, persist) {
    state.talkMode = mode === "ptt" ? "ptt" : "voice";
    state.ptt = state.talkMode === "ptt";
    if (persist) {
      localStorage.setItem("zf_voice_mode", state.talkMode);
      // 旧版只认这个键，留着同步一下，降级回老页面时行为不至于突变
      localStorage.setItem("zf_voice_ptt", state.ptt ? "1" : "0");
      toast(state.ptt ? "已切换为按键说话：按住快捷键才会开麦" : "已切换为语音激活：超过阈值自动开麦");
    }
    renderTalkUI();
    syncVoiceGate();
    applyMic();
    paintMeter();
  }

  var meterTimer = null;
  /** 电平条 + 门限状态文字。只在弹窗打开时轮询，关掉就停，别白烧 CPU。 */
  function paintMeter() {
    var fill = $("#set-meter-fill"), meter = $("#set-meter"), label = $("#set-gate-state");
    if (!fill) return;
    var t = state.transport;
    var pct = t ? Math.round((t.level || 0) * 100) : 0;
    fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    if (meter) meter.classList.toggle("gated", !!t && t.gateEnabled && !t.gateOpen);
    if (!label) return;
    if (!t) label.textContent = "进频道后显示电平";
    else if (!t.micOn) label.textContent = "麦克风已关闭";
    else if (state.talkMode !== "voice") label.textContent = "按键说话模式，阈值不生效";
    else label.textContent = t.gateOpen ? "说话中 · 正在发送" : "静音中 · 未到阈值";
  }
  function startMeter() {
    clearInterval(meterTimer);
    paintMeter();
    meterTimer = setInterval(paintMeter, 120);
  }
  function stopMeter() {
    clearInterval(meterTimer);
    meterTimer = null;
  }

  function startStats() {
    clearInterval(state.statsTimer);
    // 统计轮询的回调是 async：clearInterval 只能阻止「下一次」触发，
    // 已经在途的 getStats() 仍会在离开频道后才 resolve，把旧频道的码率写进新房间。
    // 用自增代号作废在途结果，避免串数据。
    var statSeq = ++state.statsSeq;
    state.statsTimer = setInterval(async function () {
      var transport = state.transport;
      if (!transport) return;
      try {
        var s = await transport.getStats();
        if (statSeq !== state.statsSeq || state.transport !== transport) return;
        state.stats = s;
        renderUserbar(); renderRoom();
        if (state.current && state.sharerId) {
          var video = $("#screen-video");
          var dims = state.sharing && state.sharerId === me().id && state.shareParams
            ? state.shareParams.width + "×" + state.shareParams.height
            : (video && video.videoWidth ? video.videoWidth + "×" + video.videoHeight : "—");
          var actualFps = state.sharing && state.sharerId === me().id ? s.sendFps : s.recvFps;
          var fps = actualFps == null ? "—fps" : Math.round(actualFps) + "fps";
          var actualKbps = state.sharing && state.sharerId === me().id ? s.videoSendKbps : s.videoRecvKbps;
          var bitrate = actualKbps == null ? "— kbps" : Math.round(actualKbps) + " kbps";
          $("#screen-stat").textContent = dims + " · " + fps + " · " + bitrate + " · " +
            (s.rttMs == null ? "—" : Math.round(s.rttMs) + " ms");
        } else $("#screen-stat").textContent = "—";
      } catch (_) {}
    }, 2000);
  }

  async function joinChannel(id) {
    var ch = channelById(id);
    if (!ch) return;
    if (state.current === id) return;
    if (ch.offline) { toast("该自建频道当前离线，不影响其他频道"); return; }
    if (state.preview) { previewJoin(id); return; }

    // 同步占用本次加入的代号。连续点击时每次调用立刻拿到不同值；
    // 不能等 await leaveChannel() 之后再读 —— 那时所有点击的 leaveChannel
    // 都已执行完，会读到同一个值，旧流程就会被误判成「仍然有效」而各建一条
    // WebSocket，正是「频道里堆出一堆管理员」的根因。
    var seq = ++state.joinSeq;
    var room = null, transport = null;
    function cancelled() { return seq !== state.joinSeq; }
    function dispose() {
      if (room) room.close();
      if (transport) { try { transport.disconnect().catch(function () {}); } catch (_) {} }
      if (state.room === room) state.room = null;
      if (state.transport === transport) state.transport = null;
    }

    // 传入 seq：由 joinChannel 自己作废上一次流程，leaveChannel 不再重复自增
    await leaveChannel(true, seq);
    if (cancelled()) return;   // 已被更晚的切换取代，连 UI 都不要碰

    var password = "";
    if (ch.hasPassword) {
      password = window.prompt("这是私有频道，请输入加入口令：", "") || "";
      if (!password) return;
    }
    // 口令输入框是阻塞的，期间可能已有别的流程（被踢 / 管理员删频道 / 另一次点击）
    // 作废了本次加入；进频道前必须再确认一次，否则会把 UI 切到一个已作废的房间。
    if (cancelled()) return;
    state.current = id;
    state.expanded[id] = true;
    state.drawer = "";
    state.watching = true;
    state.members = [];
    state.channelSettings = ch.settings;
    $("#welcome").hidden = true;
    $("#room").hidden = false;
    $("#screen-stage").hidden = true;
    renderAll();

    try {
      var join = await api("/api/voice/channels/" + encodeURIComponent(id) + "/join", "POST", { password: password });
      // 网络往返期间用户可能已经切到别的频道；此时绝不能再建立 WebSocket。
      if (cancelled()) return;
      state.join = join;
      if (join.notice) toast(join.notice);
      room = new VoiceTransport.VoiceRoomClient(join);
      state.room = room;
      room.on("hello", function (m) {
        if (cancelled()) return;
        state.members = m.members || [];
        state.chatMessages = Array.isArray(m.chat) ? m.chat.slice(-50) : [];
        state.chatUnread = 0;
        renderChat();
        $("#chat-messages").scrollTop = $("#chat-messages").scrollHeight;
        if (m.settings) { state.channelSettings = m.settings; if (state.transport) state.transport.applySettings(m.settings); }
        renderAll();
      });
      room.on("members", function (m) { if (cancelled()) return; state.members = m.members || []; renderAll(); });
      room.on("chat", function (m) {
        if (cancelled() || !m || !m.id || state.chatMessages.some(function (x) { return x.id === m.id; })) return;
        state.chatMessages.push(m);
        if (state.chatMessages.length > 100) state.chatMessages.shift();
        if (!state.chatOpen) state.chatUnread++;
        var box = $("#chat-messages");
        var nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        renderChat();
        if (state.chatPinned || nearBottom) box.scrollTop = box.scrollHeight;
        else $("#chat-new").hidden = false;
      });
      room.on("channel", function (m) {
        if (cancelled()) return;
        var currentChannel = channelById(id);
        if (currentChannel && m.name) currentChannel.name = m.name;
        if (m.name) $("#room-name").textContent = m.name;
        renderChannels(); renderRoom();
      });
      room.on("settings", function (m) {
        if (cancelled()) return;
        state.channelSettings = m.settings || state.channelSettings;
        if (state.transport) state.transport.applySettings(m.settings);
        var c = channelById(id);
        if (c) { c.settings = m.settings; c.revision = m.revision; }
        toast("管理员更新了频道音质 / 共享上限，已实时生效");
        renderAll();
      });
      room.on("notice", function (m) { if (!cancelled() && m.text) toast(m.text); });
      room.on("kicked", function (m) {
        if (cancelled()) return;
        toast(m.reason || "你已被移出频道"); leaveChannel(true);
      });
      room.on("forcedMute", function (m) {
        if (cancelled()) return;
        state.mic = false;
        applyMic();
        toast((m.by || "管理员") + " 将你禁言了");
      });
      room.on("error", function (e) { if (!cancelled()) toast(e.message || "房间连接异常"); });
      // 主动离开时 room.closed 为 true，不要再显示「重连中…」
      room.on("close", function () {
        if (!cancelled() && !room.closed) $("#conn-text").textContent = "重连中…";
      });
      room.on("open", function () { if (!cancelled()) $("#conn-text").textContent = "已连接"; });
      transport = VoiceTransport.create(room, {
        join: join, me: state.user,
        deviceId: localStorage.getItem("zf_voice_mic") || "",
        noise: localStorage.getItem("zf_voice_noise") !== "0",
        echo: localStorage.getItem("zf_voice_echo") !== "0",
        agc: localStorage.getItem("zf_voice_agc") !== "0"
      });
      state.transport = transport;
      // 先把说话方式 / 激活阈值交给传输层，再等它采集麦克风，
      // 否则进频道最初那几秒会无视阈值一直发声音。
      syncVoiceGate();
      transport.on("speaking", function (on) {
        if (cancelled()) return;
        var now = Date.now();
        if (on || now - state.lastSpeakSent > 700) {
          state.lastSpeakSent = now;
          room.setState({ speaking: !!on });
        }
        var m = state.members.filter(function (x) { return x.id === state.user.id; })[0];
        if (m) m.speaking = !!on;
        renderMemberList(); renderRoom();
      });
      transport.on("stats", function (s) { if (!cancelled()) state.stats = s; });
      transport.on("screenEnded", function () { if (!cancelled()) onShareEnded(); });
      transport.on("micFallback", function () {
        if (!cancelled()) {
          localStorage.setItem("zf_voice_mic", "");
          if ($("#set-in")) $("#set-in").value = "";
          toast("原麦克风已断开，已切回系统默认");
        }
      });
      transport.on("error", function (e) { if (!cancelled()) toast(e.message || "媒体连接异常"); });
      transport.on("notice", function (m) { if (!cancelled() && m.text) toast(m.text); });
      transport.on("reconnecting", function () { if (!cancelled()) { $("#conn-text").textContent = "媒体重连中…"; toast("媒体连接中断，正在自动恢复"); } });
      transport.on("reconnected", function () { if (!cancelled()) { $("#conn-text").textContent = "已连接"; toast("媒体连接已恢复"); } });
      transport.on("disconnected", function () { if (!cancelled()) { $("#conn-text").textContent = "媒体已断开"; toast("媒体连接已断开，请重新加入频道"); } });
      var roomReady = room.connect();
      var mediaReady = transport.connect();
      var ready = await Promise.all([roomReady, mediaReady]);
      void ready;
      if (cancelled()) { dispose(); return; }
      transport.setInputVolume(Number(localStorage.getItem("zf_voice_vol") || 100));
      transport.setDeaf(state.deaf);
      applyMic();
      startStats();
      chime(true);
      renderAll();
      toast("已加入「" + ch.name + "」，正在连接麦克风…");
      transport.publishAudio().then(function () {
        if (cancelled()) return;
        transport.setInputVolume(Number(localStorage.getItem("zf_voice_vol") || 100));
        applyMic();
        toast("麦克风已连接");
      }).catch(function (micError) {
        if (cancelled()) return;
        state.mic = false;
        transport.setMic(false);
        applyMic();
        toast("已进入频道，但麦克风暂不可用：" + (micError.message || "请检查权限后在设置中重试"));
      });
    } catch (e) {
      // 已被更新的切换作废：只清理自己建立的连接，不弹旧频道的错误、不重置新频道 UI
      if (cancelled()) { dispose(); return; }
      toast("加入失败：" + (e && e.message || "未知错误"));
      await leaveChannel(true);
    }
  }

  async function leaveChannel(silent, seq) {
    // 独立的离开（挂断 / 被踢 / 频道删除）才让所有在途加入流程立即失效；
    // 由 joinChannel 调用的离开已经自带代号，不要重复自增把它自己也作废。
    if (seq === undefined) state.joinSeq++;
    var leaveSeq = state.joinSeq;
    // 作废在途的统计回调，并清掉所有与房间相关的定时器（含预览用的说话演示）。
    state.statsSeq++;
    clearInterval(state.statsTimer); state.statsTimer = null;
    clearInterval(state.demoTimer); state.demoTimer = null;
    clearInterval(state.speakingTimer); state.speakingTimer = null;
    var room = state.room, transport = state.transport;
    state.room = null; state.transport = null; state.join = null;
    state.members = []; state.sharing = false; state.shareParams = null; state.sharerId = null;
    state.current = null; state.watching = true; state.stats = { rttMs: null, lossPct: 0 };
    // 先同步关掉 WebSocket：这是「从旧频道退出」最关键的一步，不能等
    // 媒体清理（可能要等音频设备 / SFU 请求）完成后才执行。
    if (room) room.close();
    if (transport) { try { await transport.disconnect(); } catch (_) {} }
    if (leaveSeq !== state.joinSeq) return;
    var video = $("#screen-video");
    if (video) { video.srcObject = null; video.style.opacity = "0"; }
    $("#screen-placeholder").hidden = false;
    $("#btn-stop-share").hidden = true;
    $("#room").hidden = true;
    $("#welcome").hidden = false;
    $("#screen-stage").hidden = true;
    if (!silent) chime(false);
    renderAll();
  }

  function onShareEnded() {
    state.sharing = false;
    state.shareParams = null;
    var video = $("#screen-video");
    if (video && !state.watching) { video.srcObject = null; }
    if (state.room) state.room.setState({ sharing: false });
    renderAll();
  }

  /* ── 预览模式（仅布局验收） ───────────────────────────────── */
  function previewJoin(id) {
    state.current = id;
    state.expanded[id] = true;
    $("#welcome").hidden = true;
    $("#room").hidden = false;
    renderAll();
    var ch = channelById(id);
    if (ch && ch.offline) toast("该自建频道当前离线，不影响其他频道");
  }
  function startSpeakingDemo() {
    clearInterval(state.demoTimer);
    state.demoTimer = setInterval(function () {
      var ch = channelById(state.current);
      if (!ch) return;
      var all = roomMembers();
      all.forEach(function (m) { m.speaking = false; });
      if (all.length > 1 && Math.random() > 0.35) all[Math.floor(Math.random() * all.length)].speaking = true;
      renderChannels(); renderMemberList(); renderRoom();
    }, 2600);
  }

  /* ── 身份验证 ──────────────────────────────────────────────── */
  function bindAuth() {
    VoiceAuth.bindForms();
    VoiceAuth.on("message", function (t) { toast(t); });
    VoiceAuth.on("authed", function (user) {
      // 登录页登录成功后回到应用页（/voice/login → /voice），刷新、后退都不会
      // 再落到登录页；已在应用页时只补一次引导数据。
      if (onLoginPage()) { location.replace("/voice/"); return; }
      // auth.js 已经拿到用户对象，再取一次引导数据保证频道列表最新
      bootstrap(user);
    });
  }
  async function saveProfile(patch) {
    try {
      var result = await api("/api/voice/me", "PATCH", patch);
      state.user = result.user;
      var avatar = result.user.avatarUrl;
      if (avatar) result.user.avatarUrl = avatar + "?v=" + Date.now();
      VoiceAuth.session.cache(result.user);
      if (state.room) state.room.send({ t: "profile", name: result.user.displayName, avatarUrl: result.user.avatarUrl || "" });
      renderUserbar(); renderMemberList(); renderRoom();
      $("#profile-name").value = result.user.displayName;
      toast("个人资料已更新");
      return result.user;
    } catch (e) {
      toast("保存资料失败：" + (e.message || "请求失败"));
      throw e;
    }
  }
  function bindLogout() {
    var btn = $("#btn-logout");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      closeDlg("dlg-settings");
      closeAllDialogs();
      try { await VoiceAuth.logout(); } catch (_) { /* 网络失败也照常回登录页 */ }
      // 退出后直接回登录页地址：/voice 里不留任何登录壳，刷新也不会倒退
      location.replace("/voice/login");
    });
  }

  async function bootstrap(presetUser, prefetched) {
    try {
      // 「恢复登录态」路径下，/bootstrap 已经和 /me 并行发出了，这里直接复用，
      // 少一次串行往返——这是「刷新后要等很久才进大厅」的主要等待来源。
      var d = prefetched ? await prefetched : await api("/api/voice/bootstrap");
      if (d && d.__error) throw d.__error;
      var user = presetUser || (d && d.user);
      if (!user) { showAuth("expired"); return; }
      state.capabilities = d.capabilities || {};
      state.settings = d.settings || {};
      state.channels = d.channels || [];
      state.user = user;
      showApp(user, state.capabilities.sfu ? "Cloudflare SFU" : "本地直连降级 · 未配置 SFU");
    } catch (e) {
      toast("无法读取频道配置：" + (e.message || "网络错误"));
      showAuth("error");
    }
  }

  /* ── 设备枚举 ──────────────────────────────────────────────── */
  async function refreshDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      var list = await navigator.mediaDevices.enumerateDevices();
      var ins = list.filter(function (d) { return d.kind === "audioinput"; });
      var outs = list.filter(function (d) { return d.kind === "audiooutput"; });
      var selIn = $("#set-in"), selOut = $("#set-out");
      var keepIn = localStorage.getItem("zf_voice_mic") || "";
      var keepOut = localStorage.getItem("zf_voice_spk") || "";
      if (keepIn && !ins.some(function (d) { return d.deviceId === keepIn; })) {
        keepIn = "";
        localStorage.setItem("zf_voice_mic", "");
      }
      selIn.innerHTML = '<option value="">系统默认麦克风</option>' + ins.map(function (d, i) {
        return '<option value="' + esc(d.deviceId) + '">' + esc(d.label || ("麦克风 " + (i + 1))) + "</option>";
      }).join("");
      selOut.innerHTML = '<option value="">系统默认扬声器</option>' + outs.map(function (d, i) {
        return '<option value="' + esc(d.deviceId) + '">' + esc(d.label || ("扬声器 " + (i + 1))) + "</option>";
      }).join("");
      selIn.value = keepIn; selOut.value = keepOut;
    } catch (_) {}
  }

  async function reacquireMic() {
    if (!state.transport || typeof state.transport.refreshAudio !== "function") return;
    var requestedMic = localStorage.getItem("zf_voice_mic") || "";
    try {
      await state.transport.refreshAudio({
        deviceId: requestedMic,
        noise: localStorage.getItem("zf_voice_noise") !== "0",
        echo: localStorage.getItem("zf_voice_echo") !== "0",
        agc: localStorage.getItem("zf_voice_agc") !== "0"
      });
      applyMic();
      if (!state.transport.opts.deviceId && requestedMic) {
        localStorage.setItem("zf_voice_mic", "");
        if ($("#set-in")) $("#set-in").value = "";
        if (state.transport.kind !== "livekit") toast("麦克风已切回系统默认");
        else toast("麦克风设置已更新");
      } else toast("麦克风设置已更新");
    } catch (e) { toast("更新麦克风失败：" + (e.message || "权限被拒绝")); }
  }

  function setSinkId(deviceId) {
    var els = [$("#screen-video")].concat($$("#media-sink audio, #media-sink video"));
    els.forEach(function (el) {
      if (el && typeof el.setSinkId === "function") el.setSinkId(deviceId || "").catch(function () {});
    });
  }

  /* ── 私有频道对话框 ────────────────────────────────────────── */
  var editingChannel = null;
  var actionChannel = null;
  function openChannelActions(ch) {
    actionChannel = ch;
    $("#channel-action-name").textContent = ch.name;
    openDlg("dlg-channel-actions");
  }
  function openEditChannel(ch) {
    editingChannel = ch;
    $("#dlg-add-title").textContent = "编辑频道";
    $("#add-name").value = ch.name || "";
    $("#add-descr").value = ch.descr || "";
    $("#add-visibility").value = ch.visibility || "private";
    $("#add-password").value = "";
    $("#add-password").placeholder = "留空表示不修改";
    $("#add-backend-group").hidden = true;
    $("#add-self-fields").hidden = true;
    $("#btn-test-conn").hidden = true;
    $("#add-alert").hidden = true;
    openDlg("dlg-add");
  }
  function resetAddDialog() {
    editingChannel = null;
    $("#dlg-add-title").textContent = "添加私有频道";
    $("#add-password").placeholder = "留空则不需要口令";
    $("#add-backend-group").hidden = false;
    $("#add-self-fields").hidden = false;
  }
  async function deleteChannel(ch) {
    try {
      await api("/api/voice/channels/" + encodeURIComponent(ch.id), "DELETE");
      if (state.current === ch.id) await leaveChannel(true);
      state.channels = state.channels.filter(function (x) { return x.id !== ch.id; });
      renderAll(); toast("频道已删除");
    } catch (e) { toast("删除失败：" + (e.message || "网络错误")); }
  }
  function hostFromInput() { return $("#add-host").value.trim(); }
  function tlsChecked() { return $("#add-tls").checked; }
  function validateAdd(showAlert) {
    var alert = $("#add-alert");
    var backend = $("#add-backend").value;
    if (backend !== "self_hosted") { alert.hidden = true; return ""; }
    var host = hostFromInput();
    if (!host) return "请填写服务器域名（不要带 http:// 或路径）";
    if (!tlsChecked() && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(host)) {
      var msg = "当前站点是 HTTPS，浏览器会拦截 ws:// 连接（混合内容）。" +
        (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? "而且纯 IP 通常申请不到 TLS 证书。" : "") +
        " 请改用：① Cloudflare Tunnel 暴露成 wss 域名；② 域名 + DDNS + Let's Encrypt；③ 本机调试用 localhost。";
      if (showAlert) { alert.textContent = msg; alert.hidden = false; }
      return msg;
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && tlsChecked()) {
      var m2 = "纯 IP 一般签不到受信任的 TLS 证书，wss 握手会失败；建议用 Cloudflare Tunnel 绑定域名。";
      if (showAlert) { alert.textContent = m2; alert.hidden = false; }
      return m2;
    }
    alert.hidden = true;
    return "";
  }

  /* ── 应用内交互 ────────────────────────────────────────────── */
  function bindApp() {
    $("#screen-video").addEventListener("loadedmetadata", function () { renderRoom(); });
    $("#screen-video").addEventListener("playing", function () { renderRoom(); });
    $("#btn-theme").addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("zf_voice_theme", next); } catch (_) {}
      toast(next === "light" ? "已切换浅色主题" : "已切换深色主题");
    });

    $$(".rail-btn[data-group]").forEach(function (b) {
      b.addEventListener("click", function () {
        state.group = b.getAttribute("data-group");
        $$(".rail-btn[data-group]").forEach(function (x) {
          var on = x === b;
          x.classList.toggle("active", on);
          x.setAttribute("aria-pressed", String(on));
        });
        renderChannels();
      });
    });

    $("#btn-channel-edit").addEventListener("click", function () {
      if (!actionChannel) return;
      closeDlg("dlg-channel-actions");
      openEditChannel(actionChannel);
    });
    $("#btn-channel-delete").addEventListener("click", function () {
      if (!actionChannel) return;
      if (!window.confirm("确定删除频道「" + actionChannel.name + "」？此操作不可撤销。")) return;
      var ch = actionChannel;
      closeDlg("dlg-channel-actions");
      deleteChannel(ch);
    });
    $("#channel-list").addEventListener("click", function (e) {
      var menu = e.target.closest("[data-channel-menu]");
      if (menu) {
        var channel = channelById(menu.getAttribute("data-channel-menu"));
        if (!channel) return;
        openChannelActions(channel);
        return;
      }
      var row = e.target.closest(".channel-row");
      if (!row) return;
      joinChannel(row.getAttribute("data-channel"));
    });

    $("#chat-messages").addEventListener("scroll", function (e) {
      var box = e.target;
      state.chatPinned = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (state.chatPinned) $("#chat-new").hidden = true;
    });
    $("#chat-new").addEventListener("click", function () {
      var box = $("#chat-messages"); box.scrollTop = box.scrollHeight;
      state.chatPinned = true; $("#chat-new").hidden = true;
    });
    $("#chat-input").addEventListener("input", function (e) {
      $("#chat-remaining").textContent = String(500 - e.target.value.length);
    });
    $("#chat-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chat-form").requestSubmit(); }
    });
    $("#chat-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var text = $("#chat-input").value.trim();
      if (!text) { toast("请输入消息"); return; }
      if (text.length > 500) { toast("消息不能超过 500 个字符"); return; }
      if (!state.room) { toast("请先加入频道"); return; }
      state.room.send({ t: "chat", text: text });
      $("#chat-input").value = ""; $("#chat-remaining").textContent = "500";
    });
    function toggleChat() {
      state.chatOpen = !state.chatOpen;
      if (window.matchMedia("(max-width:760px)").matches) $("#chat-panel").classList.toggle("chat-drawer-open", state.chatOpen);
      if (state.chatOpen) state.chatUnread = 0;
      renderChat();
    }
    $("#btn-chat-toggle").addEventListener("click", toggleChat);
    $("#btn-chat-mobile").addEventListener("click", toggleChat);
    $("#btn-hangup").addEventListener("click", function () { leaveChannel(false); });
    $("#btn-mic").addEventListener("click", function () {
      state.mic = !state.mic;
      toast(state.mic ? "麦克风已打开" : "麦克风已关闭");
      applyMic();
    });
    $("#btn-deaf").addEventListener("click", function () {
      state.deaf = !state.deaf;
      if (state.transport) state.transport.setDeaf(state.deaf);
      toast(state.deaf ? "已静音全部声音" : "已恢复收听");
      renderUserbar(); renderMemberList();
    });

    $("#btn-chat-toggle").addEventListener("click", function () {
      if (window.matchMedia("(max-width:760px)").matches) {
        state.chatOpen = !state.chatOpen;
        $("#chat-panel").classList.toggle("chat-drawer-open", state.chatOpen);
      } else {
        state.chatOpen = !state.chatOpen;
        renderChat();
      }
      if (state.chatOpen) state.chatUnread = 0;
      renderChat();
    });
    $("#btn-members").addEventListener("click", function () {
      if (window.matchMedia("(max-width:760px)").matches) state.drawer = state.drawer === "members" ? "" : "members";
      else {
        state.membersCollapsed = !state.membersCollapsed;
        $("#btn-members").setAttribute("aria-pressed", String(state.membersCollapsed));
      }
      renderAll();
    });
    $("#btn-menu").addEventListener("click", function () {
      state.drawer = state.drawer === "channels" ? "" : "channels"; renderAll();
    });
    $("#voice-main").addEventListener("click", function () {
      if (state.drawer) { state.drawer = ""; renderAll(); }
    });

    /* 成员栏：单独音量 / 管理员踢人禁言 */
    $("#member-list").addEventListener("input", function (e) {
      var t = e.target;
      if (!t.matches("[data-vol]")) return;
      if (state.transport) state.transport.setMemberVolume(t.getAttribute("data-vol"), Number(t.value));
    });
    $("#member-list").addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b || !state.room) return;
      var id = b.getAttribute("data-id");
      if (b.getAttribute("data-act") === "kick") {
        if (!window.confirm("确定把该成员移出频道？")) return;
        state.room.kick(id); toast("已发送踢出指令");
      } else { state.room.mute(id); toast("已禁言该成员"); }
    });

    /* 屏幕共享 */
    $("#btn-share").addEventListener("click", function () {
      var ch = channelById(state.current);
      if (!ch) { toast("请先进入一个频道"); return; }
      var s = (state.channelSettings || ch.settings || {}).screen || {};
      if (s.enabled === false) { toast("管理员已关闭该频道的屏幕共享"); return; }
      var sharers = roomMembers().filter(function (m) { return m.sharing; }).length;
      if (!state.sharing && sharers >= (s.maxSharers || 2)) {
        toast("同时共享人数已达上限（" + (s.maxSharers || 2) + " 人）"); return;
      }
      var maxRes = Math.min(Number(s.maxHeight) || 1080, 2160);
      $("#share-limit").textContent = "最高 " + maxRes + "p / " + (s.maxFps || 30) + "fps / " +
        (s.maxBitrateKbps || 4000) + " kbps / 同时 " + (s.maxSharers || 2) + " 人";
      $$("#share-res option").forEach(function (o) { o.disabled = Number(o.value) > maxRes; });
      $$("#share-fps option").forEach(function (o) { o.disabled = Number(o.value) > (s.maxFps || 30); });
      $("#share-bitrate").max = String(Math.min(12000, (s.maxBitrateKbps || 4000) * 2));
      openDlg("dlg-share");
    });
    $("#share-bitrate").addEventListener("input", function (e) {
      var v = Number(e.target.value);
      $("#bitrate-label").textContent = v === 0 ? "自动" : (v >= 1000 ? (v / 1000).toFixed(2) + " Mbps" : v + " kbps");
    });
    $("#form-share").addEventListener("submit", async function (e) {
      e.preventDefault();
      if (state.preview || !state.transport) { toast("预览模式不能真正共享屏幕，请先登录并加入频道"); closeDlg("dlg-share"); return; }
      var res = Number($("#share-res").value);
      var presets = { 480: [854, 480], 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440], 2160: [3840, 2160] };
      var p = presets[res] || presets[720];
      var req = {
        width: p[0], height: p[1], fps: Number($("#share-fps").value),
        bitrateKbps: Number($("#share-bitrate").value) || undefined,
        contentHint: $("#share-hint").value, audio: $("#share-audio").checked,
        res: res
      };
      try {
        var effective = await state.transport.publishScreen(req, (state.channelSettings || {}).screen);
        state.shareParams = effective;
        state.sharing = true;
        state.watching = true;
        if (state.room) state.room.setState({ sharing: true });
        closeDlg("dlg-share");
        $("#screen-stat").textContent = effective.width + "×" + effective.height + " · " +
          effective.fps + "fps · " + effective.bitrateKbps + " kbps";
        renderAll();
        toast("开始共享屏幕：" + effective.width + "×" + effective.height + " / " + effective.fps + "fps");
      } catch (err) {
        toast(err.message || "共享失败");
      }
    });
    $("#btn-stop-share").addEventListener("click", async function () {
      if (state.transport) await state.transport.stopScreen();
      onShareEnded();
      toast("已停止共享");
    });
    $("#btn-pip").addEventListener("click", function () {
      var el = $("#screen-video");
      if (document.pictureInPictureEnabled && el && el.requestPictureInPicture && el.srcObject) {
        el.requestPictureInPicture().catch(function () { toast("画中画被浏览器拒绝，请先点击画面"); });
      } else toast("当前浏览器不支持画中画，或还没有可播放的画面");
    });
    $("#btn-stop-watch").addEventListener("click", function () {
      state.watching = !state.watching;
      var video = $("#screen-video");
      if (!state.watching) { if (video) video.style.opacity = "0"; toast("已停止观看该共享，节省带宽"); }
      else { if (video) video.style.opacity = "1"; toast("已恢复观看"); }
      $("#screen-placeholder").hidden = state.watching && !!(video && video.srcObject);
      renderRoom();
    });
    $("#screen-quality").addEventListener("change", async function (e) {
      var v = e.target.value;
      if (!state.transport || !state.sharerId) { toast("当前没有可调整的共享画面"); return; }
      if (state.sharerId === me().id) {
        state.transport.setScreenQuality(v);
        toast("共享画质已调整：" + e.target.options[e.target.selectedIndex].text);
        return;
      }
      if (state.transport.kind === "livekit") {
        state.transport.sharerIdentity = state.sharerId;
        var ok = await state.transport.requestScreenQuality(v);
        toast(ok ? "观看画质已调整：" + e.target.options[e.target.selectedIndex].text : "画质切换失败：对方客户端不支持");
        return;
      }
      if (state.room) state.room.sendSignal(state.sharerId, { kind: "quality", value: v });
      toast("观看画质请求已发送：" + e.target.options[e.target.selectedIndex].text);
    });
    $("#screen-volume").addEventListener("input", function (e) {
      var v = Number(e.target.value);
      if (!isFinite(v)) v = 100;
      var video = $("#screen-video");
      // volume 只吃 0~1，直接把 1.03 赋上去会抛 IndexSizeError；
      // 超过 100% 的放大由传输层用 WebAudio 增益补上（setMemberVolume）。
      if (video) video.volume = Math.max(0, Math.min(1, v / 100));
      if (state.transport && state.sharerId) state.transport.setMemberVolume(state.sharerId, v);
    });
    /* 全屏查看：共享画面本身、双击画面、顶部全屏按钮共用同一个入口 */
    function toggleScreenFullscreen() {
      var doc = document;
      var fsEl = doc.fullscreenElement || doc.webkitFullscreenElement;
      if (fsEl) {
        var exit = doc.exitFullscreen || doc.webkitExitFullscreen;
        if (exit) { try { var ep = exit.call(doc); if (ep && ep.catch) ep.catch(function () {}); } catch (_) {} }
        return;
      }
      var stage = $("#screen-stage");
      var sharing = stage && !stage.hidden;
      // 有共享时放大的应该是「画面」而不是整个语音区（整个区还有成员条、
      // 聊天栏，全屏后画面并不会变大，这正是之前「放大没反应」的原因）。
      var target = sharing ? ($("#screen-main") || stage) : $("#voice-main");
      if (!target) return;
      var req = target.requestFullscreen || target.webkitRequestFullscreen;
      if (!req) { toast("当前浏览器不支持全屏，可按 F11 全屏浏览器"); return; }
      try {
        var p = req.call(target);
        if (p && p.catch) p.catch(function () { toast("全屏被浏览器拒绝：请先点击一下页面再试"); });
      } catch (_) { toast("无法进入全屏，可按 F11 全屏浏览器"); }
    }
    $("#btn-fs-screen").addEventListener("click", toggleScreenFullscreen);
    $("#screen-video").addEventListener("dblclick", toggleScreenFullscreen);
    $("#btn-fullscreen").addEventListener("click", toggleScreenFullscreen);

    /* 设置弹窗 */
    $("#btn-settings").addEventListener("click", function () {
      refreshDevices();
      $("#profile-name").value = state.user ? state.user.displayName : "";
      var preview = $("#profile-avatar-preview");
      var previewUrl = safeCssUrl(state.user && state.user.avatarUrl);
      preview.textContent = previewUrl ? "" : (state.user ? state.user.displayName.slice(0, 1) : "Z");
      preview.style.backgroundImage = previewUrl ? 'url("' + previewUrl + "?v=" + Date.now() + '")' : "";
      renderTalkUI();
      showPane(setPane || "devices");
      openDlg("dlg-settings");
      startMeter();
    });
    $("#dlg-settings").addEventListener("close", stopMeter);
    $$(".set-tab").forEach(function (b) {
      b.addEventListener("click", function () { showPane(b.getAttribute("data-pane")); });
    });
    $$('input[name="set-talkmode"]').forEach(function (r) {
      r.addEventListener("change", function () { if (r.checked) setTalkMode(r.value, true); });
    });
    $("#set-threshold").addEventListener("input", function (e) {
      state.threshold = Number(e.target.value) || 0;
      localStorage.setItem("zf_voice_threshold", String(state.threshold));
      $("#threshold-label").textContent = "阈值 " + state.threshold;
      $("#set-meter-mark").style.left = thresholdMarkPct(state.threshold) + "%";
      syncVoiceGate();
      paintMeter();
    });
    /**
     * 头像压缩：浏览器端先裁成正方形、缩到 256px 再转 JPEG。
     * 以前是把原图直接 base64 上传，手机照片动辄 3~8 MB，会被前端的
     * 2 MB 限制或服务端 AVATAR_LIMIT 直接拒掉——用户看到的就是
     * 「头像改不了」。压缩后通常只有 20~40 KB，任何图片都能传上去。
     */
    function compressAvatar(file) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            var side = Math.min(w, h);
            if (!side) { URL.revokeObjectURL(url); reject(new Error("图片尺寸无效")); return; }
            var size = Math.min(256, side);
            var cv = document.createElement("canvas");
            cv.width = size; cv.height = size;
            var cx = cv.getContext("2d");
            if (!cx) { URL.revokeObjectURL(url); reject(new Error("浏览器不支持图片处理")); return; }
            cx.imageSmoothingEnabled = true;
            cx.imageSmoothingQuality = "high";
            cx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
            var out = cv.toDataURL("image/jpeg", 0.86);
            URL.revokeObjectURL(url);
            resolve(out);
          } catch (err) { URL.revokeObjectURL(url); reject(err); }
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("无法解析这张图片，请换一张试试")); };
        img.src = url;
      });
    }

    $("#profile-name").addEventListener("change", function () { saveProfile({ displayName: $("#profile-name").value.trim() }); });
    $("#btn-profile-save").addEventListener("click", function () {
      var name = $("#profile-name").value.trim();
      if (!name) { toast("请先填写显示名称"); $("#profile-name").focus(); return; }
      saveProfile({ displayName: name }).catch(function () {});
    });
    $("#profile-avatar").addEventListener("change", function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) { toast("头像仅支持 jpg / png / webp 图片"); e.target.value = ""; return; }
      if (file.size > 20 * 1024 * 1024) { toast("图片太大了（超过 20 MB），请换一张"); e.target.value = ""; return; }
      var hint = $("#profile-hint");
      if (hint) hint.textContent = "正在处理头像…";
      compressAvatar(file).then(function (dataUrl) {
        return saveProfile({ avatar: dataUrl }).then(function () {
          var shown = safeCssUrl(dataUrl);
          $("#profile-avatar-preview").style.backgroundImage = shown ? 'url("' + shown + '")' : "";
          $("#profile-avatar-preview").textContent = shown ? "" : $("#profile-name").value.slice(0, 1);
          if (hint) hint.textContent = "头像已更新（约 " + Math.round(dataUrl.length / 1024) + " KB）。";
        });
      }).catch(function (err) {
        // saveProfile 已经弹过错误提示，这里只补充上下文，避免连弹两个 toast
        if (hint) hint.textContent = "头像更新失败：" + (err && err.message || "未知错误");
      }).then(function () { e.target.value = ""; });
    });
    $("#btn-password").addEventListener("click", function () { openDlg("dlg-password"); });
    $("#form-password").addEventListener("submit", async function (e) {
      e.preventDefault();
      var oldPassword = $("#password-old").value;
      var newPassword = $("#password-new").value;
      if (newPassword.length < 10 || !/[a-z]/i.test(newPassword) || !/[0-9]/.test(newPassword)) { toast("新密码至少 10 位，且需同时包含字母和数字"); return; }
      if (newPassword !== $("#password-confirm").value) { toast("两次输入的新密码不一致"); return; }
      try {
        await api("/api/voice/password", "POST", { oldPassword: oldPassword, newPassword: newPassword });
        $("#form-password").reset(); closeDlg("dlg-password"); toast("密码已修改，其他登录会话已退出");
      } catch (err) { toast("修改密码失败：" + (err.message || "请求失败")); }
    });
    $("#set-vol").addEventListener("input", function (e) {
      $("#vol-label").textContent = e.target.value + "%";
      localStorage.setItem("zf_voice_vol", e.target.value);
      if (state.transport) state.transport.setInputVolume(Number(e.target.value));
    });
    ["noise", "echo", "agc"].forEach(function (k) {
      $("#set-" + k).addEventListener("change", function (e) {
        localStorage.setItem("zf_voice_" + k, e.target.checked ? "1" : "0");
        reacquireMic();
      });
    });
    $("#set-in").addEventListener("change", function (e) {
      localStorage.setItem("zf_voice_mic", e.target.value || ""); reacquireMic();
    });
    $("#set-out").addEventListener("change", function (e) {
      localStorage.setItem("zf_voice_spk", e.target.value || ""); setSinkId(e.target.value || "");
      toast("输出设备已切换");
    });
    $("#btn-set-key").addEventListener("click", function () {
      toast("请按下要用的快捷键（例如 V 或 空格），按 Esc 取消");
      var handler = function (ev) {
        ev.preventDefault();
        document.removeEventListener("keydown", handler, true);
        if (ev.key === "Escape") { toast("已取消设置"); return; }
        state.pttKey = ev.code || ev.key;
        localStorage.setItem("zf_voice_ptt_key", state.pttKey);
        $("#set-key").value = ev.key === " " ? "空格" : ev.key;
        toast("快捷键已设为 " + (ev.key === " " ? "空格" : ev.key));
      };
      document.addEventListener("keydown", handler, true);
    });
    $("#set-sounds").addEventListener("change", function (e) {
      state.sounds = e.target.checked;
      localStorage.setItem("zf_voice_sounds", state.sounds ? "1" : "0");
    });
    $("#form-settings").addEventListener("submit", function (e) { e.preventDefault(); });

    document.addEventListener("keydown", function (e) {
      if (state.talkMode !== "ptt" || !state.pttKey || e.repeat) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if ((e.code || e.key) === state.pttKey && !state.pttDown) { state.pttDown = true; applyMic(); }
    });
    document.addEventListener("keyup", function (e) {
      if (state.talkMode !== "ptt" || !state.pttKey) return;
      if ((e.code || e.key) === state.pttKey && state.pttDown) { state.pttDown = false; applyMic(); }
    });

    /* 添加私有频道 */
    function openAdd() {
      $("#add-alert").hidden = true;
      var allowSelf = !!(state.settings && state.settings.allowUserSelfHosted) || isAdmin();
      var sel = $("#add-backend");
      sel.options[1].disabled = !allowSelf;
      if (!allowSelf && sel.value === "self_hosted") sel.value = "cloudflare";
      syncAddBackend();
      openDlg("dlg-add");
    }
    function syncAddBackend() {
      var isSelf = $("#add-backend").value === "self_hosted";
      $("#add-self-fields").hidden = !isSelf;
      $("#btn-test-conn").hidden = !isSelf;
      $("#add-alert").hidden = true;
    }
    $("#btn-add").addEventListener("click", openAdd);
    $("#btn-add-2").addEventListener("click", openAdd);
    $("#add-backend").addEventListener("change", syncAddBackend);
    $("#add-host").addEventListener("input", function () { $("#add-alert").hidden = true; });
    $("#add-tls").addEventListener("change", function () { $("#add-alert").hidden = true; });
    $("#btn-test-conn").addEventListener("click", async function () {
      var bad = validateAdd(true);
      if (bad) { toast("连接被拦下，请看下方中文指引"); return; }
      toast("正在从 Cloudflare Worker 探测…");
      try {
        var d = await api("/api/voice/servers/test", "POST", {
          host: hostFromInput(), port: Number($("#add-port").value) || 7880, tls: tlsChecked()
        });
        var alert = $("#add-alert");
        alert.textContent = (d.reachable ? "✓ 可达，延迟 " + d.latencyMs + " ms。" : "✗ 不可达。") + " " + d.message;
        alert.hidden = false;
      } catch (err) { toast("探测失败：" + err.message); }
    });
    $("#form-add").addEventListener("submit", async function (e) {
      e.preventDefault();
      var name = $("#add-name").value.trim();
      if (!name) { toast("请填写频道名称"); return; }
      if (editingChannel) {
        try {
          var patch = { name: name, descr: $("#add-descr").value.trim(), visibility: $("#add-visibility").value };
          if ($("#add-password").value) patch.password = $("#add-password").value;
          var updated = await api("/api/voice/channels/" + encodeURIComponent(editingChannel.id), "PATCH", patch);
          var at = state.channels.findIndex(function (x) { return x.id === editingChannel.id; });
          if (at >= 0) state.channels[at] = updated.channel;
          closeDlg("dlg-add"); $("#form-add").reset(); resetAddDialog(); renderAll();
          toast("频道设置已保存");
        } catch (err) { toast("保存失败：" + (err.message || "网络错误")); }
        return;
      }
      var bad = validateAdd(true);
      if (bad) { toast("请先修正连接地址"); return; }
      if (state.preview) {
        state.channels.push({
          id: "preview-" + Date.now(), name: name, descr: $("#add-descr").value.trim(),
          backend: $("#add-backend").value === "self_hosted" ? "self" : "cloudflare",
          visibility: $("#add-visibility").value, private: $("#add-visibility").value === "private",
          hasPassword: !!$("#add-password").value, maxUsers: 20, online: 0,
          offline: $("#add-backend").value === "self_hosted", revision: 1,
          settings: { audio: { bitrateKbps: 48 }, screen: { enabled: true, maxWidth: 1920, maxHeight: 1080, maxFps: 30, maxBitrateKbps: 4000, maxSharers: 2 } },
          members: []
        });
        closeDlg("dlg-add"); $("#form-add").reset(); syncAddBackend(); renderAll();
        toast("预览模式：仅添加到本地列表"); return;
      }
      var body = {
        name: name, descr: $("#add-descr").value.trim(),
        visibility: $("#add-visibility").value, password: $("#add-password").value,
        backend: $("#add-backend").value
      };
      if (body.backend === "self_hosted") {
        body.host = hostFromInput(); body.port = Number($("#add-port").value) || 7880; body.tls = tlsChecked();
      }
      try {
        var d = await api("/api/voice/channels", "POST", body);
        state.channels.push(d.channel);
        closeDlg("dlg-add");
        $("#form-add").reset(); syncAddBackend(); renderAll();
        toast("私有频道已创建，配置保存在 Cloudflare Worker");
      } catch (err) { toast("创建失败：" + err.message); }
    });

    /* 对话框关闭 */
    $$("[data-close]").forEach(function (b) {
      b.addEventListener("click", function () {
        var id = b.getAttribute("data-close");
        var f = b.closest("form");
        if (f && id === "dlg-add") { f.reset(); resetAddDialog(); syncAddBackend(); }
        closeDlg(id);
      });
    });
    /* 点遮罩也能关：<dialog> 原生只支持 ESC，点外面那片空白什么都不发生，
       很容易被当成「这个弹窗关不掉」。
       判据：事件 target 是 dialog 本身（内容区点击会命中子元素），
       且坐标落在 dialog 盒子外面（盒子内部还有 padding）。 */
    $$("dialog.dlg").forEach(function (d) {
      d.addEventListener("click", function (e) {
        if (e.target !== d || !d.open) return;
        var r = d.getBoundingClientRect();
        var outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        if (outside) closeDlg(d.id);
      });
    });
  }

  /* ── 初始化 ────────────────────────────────────────────────── */
  function init() {
    try {
      var saved = localStorage.getItem("zf_voice_theme");
      if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
      state.sounds = localStorage.getItem("zf_voice_sounds") !== "0";
      // 说话方式：新键 zf_voice_mode 优先，老用户只有 zf_voice_ptt（0/1）
      var savedMode = localStorage.getItem("zf_voice_mode");
      if (savedMode !== "voice" && savedMode !== "ptt") {
        savedMode = localStorage.getItem("zf_voice_ptt") === "1" ? "ptt" : "voice";
      }
      state.talkMode = savedMode;
      state.ptt = state.talkMode === "ptt";
      state.pttKey = localStorage.getItem("zf_voice_ptt_key") || "";
      var savedTh = localStorage.getItem("zf_voice_threshold");
      var thNum = Number(savedTh);
      state.threshold = savedTh !== null && isFinite(thNum)
        ? Math.max(0, Math.min(100, thNum)) : 30;
      $("#set-sounds").checked = state.sounds;
      $("#set-key").value = state.pttKey ? (state.pttKey === "Space" ? "空格" : state.pttKey.replace(/^Key/, "")) : "未设置";
      $("#set-vol").value = localStorage.getItem("zf_voice_vol") || "100";
      $("#vol-label").textContent = $("#set-vol").value + "%";
      ["noise", "echo", "agc"].forEach(function (k) {
        $("#set-" + k).checked = localStorage.getItem("zf_voice_" + k) !== "0";
      });
      renderTalkUI();
    } catch (_) {}

    bindAuth(); bindApp();
    renderTalkUI(); bindLogout();

    var params = new URLSearchParams(location.search);
    if (params.get("preview") === "1") {
      state.preview = true;
      state.channels = MOCK_CHANNELS.map(function (c) { return JSON.parse(JSON.stringify(c)); });
      showApp(null, "预览模式 · 不连后端");
      var preset = params.get("channel");
      if (preset && channelById(preset)) previewJoin(preset);
      startSpeakingDemo();
      return;
    }
    if (onLoginPage()) {
      /* 独立登录页 /voice/login：这里只负责登录。
         如果这台设备其实还登录着（直接访问或书签），判定后自动回 /voice，
         避免「已登录却停在登录页」。 */
      $("#auth-view").hidden = false;
      $("#app-view").hidden = true;
      var reason = params.get("reason");
      VoiceAuth.bootstrap().then(function (user) {
        if (user) { location.replace("/voice/"); return; }
        VoiceAuth.renderAvatarPreview();
        if (reason === "expired") toast("登录状态已过期，请重新登录");
        else if (reason === "error") toast("无法读取频道配置，请检查网络后重试");
      });
      return;
    }
    if (VoiceAuth.session.hinted()) {
      // <head> 里的同步脚本已经把视图切成「预登录」，登录页一次都不会闪。
      // 先用本地缓存把用户栏填上，恢复动画盖住还没加载完的频道列表。
      var cached = VoiceAuth.session.cached();
      if (cached) { state.user = cached; renderUserbar(); }
      $("#auth-view").hidden = true;
      $("#app-view").hidden = false;
      // 关键提速：先把 /api/voice/bootstrap 发出去，和 VoiceAuth 内部的 /me
      // 并行跑。以前是 /me 回来 → showApp 之前再等 /bootstrap，两个 RTT 串着，
      // 刷新页面就明显卡一下。
      var prefetch = api("/api/voice/bootstrap").catch(function (e) { return { __error: e }; });
      VoiceAuth.bootstrap().then(function (user) {
        if (user) bootstrap(user, prefetch);
        // Cookie 标记还在但服务端会话已失效（过期 / 被管理员踢下线）：
        // showAuth 会整页跳到 /voice/login，不会在应用壳里留一个登录页
        else showAuth("expired");
      });
    } else {
      // /voice 是应用页，登录壳只住在 /voice/login。没有任何登录痕迹时
      // 直接过去，省掉「先渲染登录页再跳」的那一下闪动。
      location.replace("/voice/login");
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
