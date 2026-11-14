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

  /* ── 请求封装 ──────────────────────────────────────────────── */
  function api(path, method, body) {
    var opt = { method: method || "GET", credentials: "same-origin",
      headers: { "Content-Type": "application/json" } };
    if (body !== undefined) opt.body = JSON.stringify(body);
    return fetch(path, opt).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || ("HTTP " + r.status));
        return d;
      });
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
    membersCollapsed: false, drawer: "", watching: true, sounds: true,
    room: null, transport: null, join: null, channelSettings: null,
    stats: { rttMs: null, lossPct: 0 }, statsTimer: null,
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

  /** 加入 / 离开提示音：WebAudio 生成短促双音，不依赖外部音频文件。 */
  var audioCtxForChime = null;
  function chime(join) {
    if (!state.sounds) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtxForChime) audioCtxForChime = new AC();
      var ctx = audioCtxForChime;
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
    } catch (_) {}
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
    var head = '<span class="avatar ' + esc(cls || "") + '" style="background:' + esc(m.color || "#7a1830");
    if (m.avatarUrl) {
      return head + ";background-image:url(" + esc(m.avatarUrl) +
        ");background-size:cover;background-position:center\" aria-hidden=\"true\"></span>";
    }
    return head + '" aria-hidden="true">' + esc(String(m.name || "Z").slice(0, 1)) + "</span>";
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
        Math.round(q.rttMs) + " ms · 丢包 " + (Number(q.lossPct) || 0).toFixed(1) + "%");

    $("#member-grid").innerHTML = list.map(function (m) {
      return '<div class="member-card' + (m.speaking ? " speaking" : "") + (m.sharing ? " sharing" : "") + '">' +
        avatarHTML(m) + '<span class="name">' + esc(m.name) + "</span>" +
        '<span class="tags">' + (m.id === me().id ? "我" : "成员") +
        (m.speaking ? " · 说话中" : "") + "</span>" + statusIcons(m) + "</div>";
    }).join("");

    var sharer = list.filter(function (m) { return m.sharing; })[0];
    state.sharerId = sharer ? sharer.id : null;
    var showScreen = !!(sharer && state.watching);
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
    if (video) {
      var hasStream = !!(video.srcObject && video.srcObject.getVideoTracks().length);
      ph.hidden = hasStream && state.watching;
      video.style.opacity = (hasStream && state.watching) ? "1" : "0";
    }
    $("#btn-stop-share").hidden = !state.sharing;
    $("#btn-stop-watch").textContent = state.watching ? "不观看" : "重新观看";
  }

  function renderUserbar() {
    var m = me();
    $("#me-name").textContent = m.name;
    var av = $("#me-avatar");
    av.textContent = m.avatarUrl ? "" : m.name.slice(0, 1);
    av.style.background = m.color;
    av.style.backgroundImage = m.avatarUrl ? "url(" + m.avatarUrl + ")" : "";
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
      : "延迟 " + Math.round(q.rttMs) + " ms · 丢包 " + (Number(q.lossPct) || 0).toFixed(1) + "%";
  }

  function renderAll() {
    renderChannels(); renderMemberList(); renderRoom(); renderUserbar();
    $("#v-layout").classList.toggle("no-members", state.membersCollapsed);
    $("#v-layout").classList.toggle("drawer-channels", state.drawer === "channels");
    $("#v-layout").classList.toggle("drawer-members", state.drawer === "members");
    $("#btn-menu").setAttribute("aria-expanded", String(state.drawer === "channels"));
  }

  /* ── 视图切换 ──────────────────────────────────────────────── */
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
    renderAll();
  }
  function showAuth() {
    leaveChannel(true).catch(function () {});
    state.user = null;
    state.channels = [];
    state.current = null;
    clearInterval(state.demoTimer);
    $("#app-view").hidden = true;
    $("#auth-view").hidden = false;
    VoiceAuth.switchTab("login");
    VoiceAuth.renderAvatarPreview();
  }

  /* ── 真实房间 ──────────────────────────────────────────────── */
  function applyMic() {
    var enabled = state.ptt ? state.pttDown : state.mic;
    if (state.transport) state.transport.setMic(enabled);
    renderUserbar();
    renderMemberList();
  }

  function startStats() {
    clearInterval(state.statsTimer);
    state.statsTimer = setInterval(async function () {
      if (!state.transport) return;
      try {
        var s = await state.transport.getStats();
        state.stats = s;
        renderUserbar(); renderRoom();
        if (state.shareParams) {
          $("#screen-stat").textContent = state.shareParams.width + "×" + state.shareParams.height +
            " · " + state.shareParams.fps + "fps · " + state.shareParams.bitrateKbps + " kbps · " +
            (s.rttMs == null ? "—" : Math.round(s.rttMs) + " ms");
        }
      } catch (_) {}
    }, 2000);
  }

  async function joinChannel(id) {
    var ch = channelById(id);
    if (!ch) return;
    if (state.current === id) return;
    if (ch.offline) { toast("该自建频道当前离线，不影响其他频道"); return; }
    if (state.preview) { previewJoin(id); return; }
    await leaveChannel(true);

    var password = "";
    if (ch.hasPassword) {
      password = window.prompt("这是私有频道，请输入加入口令：", "") || "";
      if (!password) return;
    }
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
      state.join = join;
      if (join.notice) toast(join.notice);
      var room = new VoiceTransport.VoiceRoomClient(join);
      state.room = room;
      room.on("hello", function (m) {
        state.members = m.members || [];
        if (m.settings) { state.channelSettings = m.settings; if (state.transport) state.transport.applySettings(m.settings); }
        renderAll();
      });
      room.on("members", function (m) { state.members = m.members || []; renderAll(); });
      room.on("settings", function (m) {
        state.channelSettings = m.settings || state.channelSettings;
        if (state.transport) state.transport.applySettings(m.settings);
        var c = channelById(id);
        if (c) { c.settings = m.settings; c.revision = m.revision; }
        toast("管理员更新了频道音质 / 共享上限，已实时生效");
        renderAll();
      });
      room.on("notice", function (m) { if (m.text) toast(m.text); });
      room.on("kicked", function (m) { toast(m.reason || "你已被移出频道"); leaveChannel(true); });
      room.on("forcedMute", function (m) {
        state.mic = false;
        applyMic();
        toast((m.by || "管理员") + " 将你禁言了");
      });
      room.on("error", function (e) { toast(e.message || "房间连接异常"); });
      room.on("close", function () { $("#conn-text").textContent = "重连中…"; });
      room.on("open", function () { $("#conn-text").textContent = "已连接"; });
      await room.connect();

      var transport = VoiceTransport.create(room, {
        join: join, me: state.user,
        deviceId: localStorage.getItem("zf_voice_mic") || "",
        noise: localStorage.getItem("zf_voice_noise") !== "0",
        echo: localStorage.getItem("zf_voice_echo") !== "0",
        agc: localStorage.getItem("zf_voice_agc") !== "0"
      });
      state.transport = transport;
      transport.on("speaking", function (on) {
        var now = Date.now();
        if (on || now - state.lastSpeakSent > 700) {
          state.lastSpeakSent = now;
          room.setState({ speaking: !!on });
        }
        var m = state.members.filter(function (x) { return x.id === state.user.id; })[0];
        if (m) m.speaking = !!on;
        renderMemberList(); renderRoom();
      });
      transport.on("stats", function (s) { state.stats = s; });
      transport.on("screenEnded", function () { onShareEnded(); });
      transport.on("error", function (e) { toast(e.message || "媒体连接异常"); });
      transport.on("notice", function (m) { if (m.text) toast(m.text); });
      await transport.connect();
      await transport.publishAudio();
      transport.setInputVolume(Number(localStorage.getItem("zf_voice_vol") || 100));
      transport.setDeaf(state.deaf);
      applyMic();
      startStats();
      chime(true);
      renderAll();
      toast("已加入「" + ch.name + "」");
    } catch (e) {
      toast("加入失败：" + (e && e.message || "未知错误"));
      await leaveChannel(true);
    }
  }

  async function leaveChannel(silent) {
    clearInterval(state.statsTimer); state.statsTimer = null;
    var room = state.room, transport = state.transport;
    state.room = null; state.transport = null; state.join = null;
    state.members = []; state.sharing = false; state.shareParams = null; state.sharerId = null;
    state.current = null; state.watching = true; state.stats = { rttMs: null, lossPct: 0 };
    if (transport) { try { await transport.disconnect(); } catch (_) {} }
    if (room) room.close();
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
      // auth.js 已经拿到用户对象，再取一次引导数据保证频道列表最新
      bootstrap(user);
    });
  }
  function bindLogout() {
    var btn = $("#btn-logout");
    if (!btn) return;
    btn.addEventListener("click", async function () {
      closeDlg("dlg-settings");
      await VoiceAuth.logout();
      showAuth();
      toast("已退出登录");
    });
  }

  async function bootstrap(presetUser) {
    try {
      var d = await api("/api/voice/bootstrap");
      var user = presetUser || d.user;
      if (!user) { showAuth(); return; }
      state.capabilities = d.capabilities || {};
      state.settings = d.settings || {};
      state.channels = d.channels || [];
      state.user = user;
      showApp(user, state.capabilities.sfu ? "Cloudflare SFU" : "本地直连降级 · 未配置 SFU");
    } catch (e) {
      toast("无法读取频道配置：" + (e.message || "网络错误"));
      showAuth();
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
    try {
      await state.transport.refreshAudio({
        deviceId: localStorage.getItem("zf_voice_mic") || "",
        noise: localStorage.getItem("zf_voice_noise") !== "0",
        echo: localStorage.getItem("zf_voice_echo") !== "0",
        agc: localStorage.getItem("zf_voice_agc") !== "0"
      });
      applyMic();
      toast("麦克风设置已更新");
    } catch (e) { toast("更新麦克风失败：" + (e.message || "权限被拒绝")); }
  }

  function setSinkId(deviceId) {
    var els = [$("#screen-video")].concat($$("#media-sink audio, #media-sink video"));
    els.forEach(function (el) {
      if (el && typeof el.setSinkId === "function") el.setSinkId(deviceId || "").catch(function () {});
    });
  }

  /* ── 私有频道对话框 ────────────────────────────────────────── */
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

    $("#channel-list").addEventListener("click", function (e) {
      var row = e.target.closest(".channel-row");
      if (!row) return;
      joinChannel(row.getAttribute("data-channel"));
    });

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
    $("#screen-quality").addEventListener("change", function (e) {
      var v = e.target.value;
      if (state.room && state.sharerId) state.room.sendSignal(state.sharerId, { kind: "quality", value: v });
      if (state.transport && typeof state.transport.setScreenQuality === "function") state.transport.setScreenQuality(v);
      toast("观看画质：" + e.target.options[e.target.selectedIndex].text);
    });
    $("#screen-volume").addEventListener("input", function (e) {
      var v = Number(e.target.value);
      var video = $("#screen-video");
      if (video) video.volume = v / 100;
      if (state.transport && state.sharerId) state.transport.setMemberVolume(state.sharerId, v);
    });
    $("#btn-fullscreen").addEventListener("click", function () {
      var el = $("#screen-stage").hidden ? $("#voice-main") : $("#screen-stage");
      if (el.requestFullscreen) el.requestFullscreen().catch(function () { toast("浏览器拒绝了全屏请求"); });
      else toast("当前浏览器不支持全屏");
    });

    /* 设置抽屉 */
    $("#btn-settings").addEventListener("click", function () { refreshDevices(); openDlg("dlg-settings"); });
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
    $("#set-ptt").addEventListener("change", function (e) {
      state.ptt = e.target.checked;
      localStorage.setItem("zf_voice_ptt", state.ptt ? "1" : "0");
      applyMic();
      toast(state.ptt ? "已开启按键说话：按住设定的快捷键才会开麦" : "已关闭按键说话");
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
      if (!state.ptt || !state.pttKey || e.repeat) return;
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if ((e.code || e.key) === state.pttKey && !state.pttDown) { state.pttDown = true; applyMic(); }
    });
    document.addEventListener("keyup", function (e) {
      if (!state.ptt || !state.pttKey) return;
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
        if (f && id === "dlg-add") f.reset();
        closeDlg(id);
      });
    });
  }

  /* ── 初始化 ────────────────────────────────────────────────── */
  function init() {
    try {
      var saved = localStorage.getItem("zf_voice_theme");
      if (saved === "light" || saved === "dark") document.documentElement.setAttribute("data-theme", saved);
      state.sounds = localStorage.getItem("zf_voice_sounds") !== "0";
      state.ptt = localStorage.getItem("zf_voice_ptt") === "1";
      state.pttKey = localStorage.getItem("zf_voice_ptt_key") || "";
      $("#set-ptt").checked = state.ptt;
      $("#set-sounds").checked = state.sounds;
      $("#set-key").value = state.pttKey ? (state.pttKey === "Space" ? "空格" : state.pttKey.replace(/^Key/, "")) : "未设置";
      $("#set-vol").value = localStorage.getItem("zf_voice_vol") || "100";
      $("#vol-label").textContent = $("#set-vol").value + "%";
      ["noise", "echo", "agc"].forEach(function (k) {
        $("#set-" + k).checked = localStorage.getItem("zf_voice_" + k) !== "0";
      });
    } catch (_) {}

    bindAuth(); bindApp(); bindLogout();

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
    $("#auth-view").hidden = false;
    $("#app-view").hidden = true;
    VoiceAuth.bootstrap().then(function (user) {
      if (user) bootstrap(user);
      else VoiceAuth.renderAvatarPreview();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
