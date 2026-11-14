/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— VoiceTransport 统一抽象 + 房间信令客户端
 *
 *  UI 层只依赖 VoiceTransport 接口，不关心底层媒体后端：
 *    connect / disconnect / publishAudio / publishScreen / stopScreen /
 *    setMic / setDeaf / setInputVolume / setMemberVolume / applySettings /
 *    getStats / on(event, cb)
 *
 *  三个实现：
 *    CloudflareTransport —— Cloudflare Realtime SFU（生产默认）
 *                          官方文档 2026-11-14 核对，见 src/voice-realtime.js
 *    MeshTransport       —— 本地直连降级（未配置 SFU 凭据时自动启用，
 *                          适合本地开发 / 极少数人临时通话；不是生产方案）
 *    LiveKitTransport    —— 可选高级模式：用户自愿在后台配置自建 SFU 时启用。
 *                          默认完全不使用；用户电脑不需要跑任何服务。
 *
 *  房间成员状态、踢人禁言、设置实时下发、信令中继一律走 Cloudflare
 *  Worker 的 Durable Object（VoiceRoomClient），与媒体后端解耦。
 * ══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var API = "/api/voice";

  function post(path, body) {
    return fetch(API + path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok || d.ok === false) throw new Error(d.error || ("HTTP " + r.status));
        return d;
      });
    });
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** 等 ICE 收集完成（最多 2.5 秒），把 candidate 直接带在 SDP 里发，省去 trickle 复杂度。 */
  function waitICE(pc) {
    if (!pc || pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(finish, 2500);
      function finish() {
        if (done) return;
        done = true;
        pc.removeEventListener("icegatheringstatechange", check);
        clearTimeout(timer);
        resolve();
      }
      function check() { if (pc.iceGatheringState === "complete") finish(); }
      pc.addEventListener("icegatheringstatechange", check);
    });
  }

  /* ══ 房间信令客户端 ═════════════════════════════════════════ */
  function VoiceRoomClient(join, opts) {
    this.join = join;
    this.opts = opts || {};
    this.handlers = {};
    this.ws = null;
    this.retries = 0;
    this.closed = false;
    this.rtt = null;
    this.pingTimer = null;
    this.self = null;
  }
  VoiceRoomClient.prototype.on = function (name, cb) {
    (this.handlers[name] = this.handlers[name] || []).push(cb);
    return this;
  };
  VoiceRoomClient.prototype.emit = function (name, data) {
    (this.handlers[name] || []).forEach(function (cb) {
      try { cb(data); } catch (e) { console.warn("[voice] 事件处理异常", name, e); }
    });
  };
  VoiceRoomClient.prototype.connect = function () {
    var self = this;
    this.closed = false;
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(self.join.wsUrl); }
      catch (e) { reject(new Error("无法建立房间连接：" + e.message)); return; }
      self.ws = ws;
      var settled = false;
      ws.onopen = function () {
        self.retries = 0;
        self.startPing();
        if (!settled) { settled = true; resolve(); }
        self.emit("open");
      };
      ws.onmessage = function (ev) {
        var m;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.t === "hello") { self.self = m.self; self.emit("hello", m); }
        else if (m.t === "pong") {
          self.rtt = Date.now() - Number(m.ts || Date.now());
          self.emit("pong", self.rtt);
        } else if (m.t === "settings") self.emit("settings", m);
        else if (m.t === "members") self.emit("members", m);
        else if (m.t === "signal") self.emit("signal", m);
        else if (m.t === "kicked") self.emit("kicked", m);
        else if (m.t === "forcedMute") self.emit("forcedMute", m);
        else if (m.t === "notice") self.emit("notice", m);
        else if (m.t === "error") self.emit("error", new Error(m.text || "房间错误"));
        else self.emit(m.t, m);
      };
      ws.onclose = function (ev) {
        self.stopPing();
        self.emit("close", ev);
        if (self.closed) return;
        if (!settled) { settled = true; reject(new Error("房间连接被拒绝（" + ev.code + "）")); return; }
        // 断线自动重连：票据 5 分钟有效，过期后请上层重新调用 join 接口
        if (self.retries < 6) {
          var delay = Math.min(6000, 600 * Math.pow(1.6, self.retries++));
          self.emit("notice", { text: "连接断开，" + Math.round(delay / 1000) + " 秒后自动重连…" });
          setTimeout(function () { if (!self.closed) self.connect().catch(function () {}); }, delay);
        } else {
          self.emit("error", new Error("重连失败，请退出频道后重新进入"));
        }
      };
      ws.onerror = function () { self.emit("error", new Error("房间连接异常")); };
    });
  };
  VoiceRoomClient.prototype.startPing = function () {
    var self = this;
    this.stopPing();
    this.pingTimer = setInterval(function () {
      if (self.ws && self.ws.readyState === 1) self.send({ t: "ping", ts: Date.now() });
    }, 4000);
  };
  VoiceRoomClient.prototype.stopPing = function () { clearInterval(this.pingTimer); this.pingTimer = null; };
  VoiceRoomClient.prototype.send = function (obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  };
  VoiceRoomClient.prototype.setState = function (patch) {
    var o = { t: "state" };
    for (var k in patch) o[k] = patch[k];
    this.send(o);
  };
  VoiceRoomClient.prototype.sendSignal = function (to, data) { this.send({ t: "signal", to: to, data: data }); };
  VoiceRoomClient.prototype.announce = function (tracks) { this.send({ t: "pub", tracks: tracks || [] }); };
  VoiceRoomClient.prototype.kick = function (userId) { this.send({ t: "kick", userId: userId }); };
  VoiceRoomClient.prototype.mute = function (userId) { this.send({ t: "mute", userId: userId }); };
  VoiceRoomClient.prototype.close = function () {
    this.closed = true;
    this.stopPing();
    try { if (this.ws) this.ws.close(1000, "leave"); } catch (_) {}
    this.ws = null;
  };

  /* ══ 传输基类：本地音频图 / 播放元素 / VAD / 统计 ═══════════ */
  function VoiceTransportBase(room, opts) {
    this.room = room;
    this.opts = opts || {};
    this.handlers = {};
    this.micStream = null;
    this.processedStream = null;
    this.screenStream = null;
    this.audioCtx = null;
    this.gain = null;
    this.analyser = null;
    this.vadTimer = null;
    this.micOn = true;
    this.deaf = false;
    this.inputVolume = 1;
    this.memberVolumes = {};
    this.elements = {};       // memberId -> { audio, video }
    this.settings = (this.opts.join && this.opts.join.settings) || { audio: {}, screen: {} };
    this.stats = { rttMs: null, lossPct: 0, bytesSent: 0, bytesRecv: 0 };
    this.shareParams = null;
    this.sink = document.getElementById("media-sink");
  }
  VoiceTransportBase.prototype.on = function (n, cb) {
    (this.handlers[n] = this.handlers[n] || []).push(cb); return this;
  };
  VoiceTransportBase.prototype.emit = function (n, d) {
    (this.handlers[n] || []).forEach(function (cb) { try { cb(d); } catch (e) { console.warn(e); } });
  };

  VoiceTransportBase.prototype.audioConstraints = function () {
    var a = this.settings.audio || {};
    var c = {
      echoCancellation: this.opts.echo !== false,
      noiseSuppression: this.opts.noise !== false,
      autoGainControl: this.opts.agc !== false,
      channelCount: a.channels || 1
    };
    if (a.sampleRate) c.sampleRate = a.sampleRate;
    if (this.opts.deviceId) c.deviceId = { exact: this.opts.deviceId };
    return c;
  };

  /** 取得麦克风并建立「增益 + VAD」音频图；失败时给出中文权限指引。 */
  VoiceTransportBase.prototype.publishAudio = async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风采集，请使用最新版 Chrome / Edge");
    }
    if (this.micStream) return this.localAudioTrack();
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(), video: false });
    } catch (e) {
      var n = e && e.name || "";
      if (n === "NotAllowedError" || n === "PermissionDeniedError") {
        throw new Error("麦克风权限被拒绝：请点地址栏左侧的锁形图标，把「麦克风」改为允许后重试。");
      }
      if (n === "NotFoundError" || n === "DevicesNotFoundError") {
        throw new Error("没有找到麦克风设备，请插入麦克风或在系统声音设置里启用。");
      }
      throw new Error("无法打开麦克风：" + (e && e.message || n || "未知错误"));
    }
    this.buildAudioGraph();
    this.startVAD();
    return this.localAudioTrack();
  };

  VoiceTransportBase.prototype.buildAudioGraph = function () {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !this.micStream) return;
      this.audioCtx = new AC();
      var src = this.audioCtx.createMediaStreamSource(this.micStream);
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = this.inputVolume;
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      var dest = this.audioCtx.createMediaStreamDestination();
      src.connect(this.gain);
      this.gain.connect(this.analyser);
      this.gain.connect(dest);
      this.processedStream = dest.stream;
      if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(function () {});
    } catch (e) {
      console.warn("[voice] 音频处理不可用，回退原始麦克风", e);
      this.processedStream = null;
    }
  };

  VoiceTransportBase.prototype.localAudioTrack = function () {
    var s = this.processedStream || this.micStream;
    return s ? s.getAudioTracks()[0] : null;
  };

  VoiceTransportBase.prototype.startVAD = function () {
    var self = this;
    clearInterval(this.vadTimer);
    if (!this.analyser) return;
    var buf = new Uint8Array(this.analyser.fftSize);
    var speaking = false, quiet = 0;
    this.vadTimer = setInterval(function () {
      if (!self.analyser || !self.micOn) {
        if (speaking) { speaking = false; self.emit("speaking", false); }
        return;
      }
      self.analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
      var rms = Math.sqrt(sum / buf.length);
      if (rms > 0.025) { quiet = 0; if (!speaking) { speaking = true; self.emit("speaking", true); } }
      else if (++quiet > 6 && speaking) { speaking = false; self.emit("speaking", false); }
    }, 90);
  };

  /** 屏幕共享。实际参数由服务端 clampShareRequest 的同一套规则再夹一次。 */
  VoiceTransportBase.prototype.publishScreen = async function (req, limits) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error("当前浏览器不支持屏幕共享（iOS / iPadOS Safari 只能观看他人共享）");
    }
    var s = limits || (this.settings.screen || {});
    var width = Math.min(Number(req.width) || 1280, Number(s.maxWidth) || 1920);
    var height = Math.min(Number(req.height) || 720, Number(s.maxHeight) || 1080);
    var fps = Math.min(Number(req.fps) || 30, Number(s.maxFps) || 30);
    var bitrate = Math.min(Number(req.bitrateKbps) || Number(s.maxBitrateKbps) || 4000,
      Number(s.maxBitrateKbps) || 4000);
    var opts = {
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } },
      audio: !!req.audio
    };
    try {
      this.screenStream = await navigator.mediaDevices.getDisplayMedia(opts);
    } catch (e) {
      var n = e && e.name || "";
      if (n === "NotAllowedError") throw new Error("屏幕共享权限被拒绝或已取消：请在浏览器弹窗里选择屏幕 / 窗口后点「共享」。");
      throw new Error("无法开始屏幕共享：" + (e && e.message || n));
    }
    var track = this.screenStream.getVideoTracks()[0];
    if (!track) throw new Error("没有获取到画面轨道");
    if ("contentHint" in track) track.contentHint = req.contentHint === "motion" ? "motion" : "detail";
    this.shareParams = { width: width, height: height, fps: fps, bitrateKbps: bitrate, contentHint: req.contentHint };
    var self = this;
    track.addEventListener("ended", function () { self.stopScreen().catch(function () {}); self.emit("screenEnded"); });
    try { await this.onScreenTrack(track, this.shareParams); }
    catch (e) { this.stopScreen().catch(function () {}); throw e; }
    return this.shareParams;
  };

  VoiceTransportBase.prototype.stopScreen = async function () {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
      this.screenStream = null;
    }
    this.shareParams = null;
    await this.onScreenStopped();
    this.emit("screenStopped");
  };

  VoiceTransportBase.prototype.setMic = function (on) {
    this.micOn = !!on;
    if (this.micStream) this.micStream.getAudioTracks().forEach(function (t) { t.enabled = !!on; });
    if (this.processedStream) this.processedStream.getAudioTracks().forEach(function (t) { t.enabled = !!on; });
    this.room.setState({ mic: this.micOn });
  };
  VoiceTransportBase.prototype.setDeaf = function (on) {
    this.deaf = !!on;
    var self = this;
    Object.keys(this.elements).forEach(function (id) {
      var e = self.elements[id];
      if (e.audio) e.audio.muted = self.deaf;
      if (e.video) e.video.muted = self.deaf;
    });
    var sv = document.getElementById("screen-video");
    if (sv) sv.muted = this.deaf;
    this.room.setState({ deaf: this.deaf });
  };
  VoiceTransportBase.prototype.setInputVolume = function (v) {
    this.inputVolume = Math.max(0, Math.min(2, Number(v) / 100));
    if (this.gain) this.gain.gain.value = this.inputVolume;
  };
  VoiceTransportBase.prototype.setMemberVolume = function (id, v) {
    this.memberVolumes[id] = Math.max(0, Math.min(2, Number(v) / 100));
    var e = this.elements[id];
    if (e && e.audio) e.audio.volume = this.memberVolumes[id];
    if (e && e.video) e.video.volume = this.memberVolumes[id];
  };
  VoiceTransportBase.prototype.attach = function (memberId, kind, track, label) {
    var key = memberId;
    var box = this.elements[key] || {};
    var el = box[kind];
    if (!el) {
      el = document.createElement(kind === "video" ? "video" : "audio");
      el.autoplay = true;
      el.playsInline = true;
      el.setAttribute("data-member", memberId);
      if (kind === "audio") { el.volume = this.memberVolumes[memberId] == null ? 1 : this.memberVolumes[memberId]; el.muted = this.deaf; }
      else {
        el.className = "remote-screen";
        el.muted = this.deaf;
        el.volume = this.memberVolumes[memberId] == null ? 1 : this.memberVolumes[memberId];
      }
      if (this.sink) this.sink.appendChild(el);
      box[kind] = el;
      this.elements[key] = box;
    }
    var stream = el.srcObject;
    if (stream && stream.getTracks().indexOf(track) < 0) stream.addTrack(track);
    else if (!stream) el.srcObject = new MediaStream([track]);
    el.play().catch(function () {});
    this.emit("track", { memberId: memberId, kind: kind, track: track, label: label || "" });
    return el;
  };
  VoiceTransportBase.prototype.detach = function (memberId) {
    var box = this.elements[memberId];
    if (!box) return;
    var self = this;
    ["audio", "video"].forEach(function (k) {
      if (box[k]) { try { box[k].srcObject = null; box[k].remove(); } catch (_) {} }
    });
    delete this.elements[memberId];
  };
  VoiceTransportBase.prototype.applySettings = function (settings) {
    if (!settings) return;
    this.settings = {
      audio: Object.assign({}, this.settings.audio, settings.audio || {}),
      screen: Object.assign({}, this.settings.screen, settings.screen || {})
    };
    try { this.onSettingsChanged(this.settings); } catch (e) { console.warn("[voice] 应用新设置失败", e); }
    this.emit("settings", this.settings);
  };
  VoiceTransportBase.prototype.roomRtt = function () { return this.room.rtt; };

  /** 汇总所有 PeerConnection 的 WebRTC 统计。 */
  VoiceTransportBase.prototype.collectStats = async function (pcs) {
    var agg = { rttMs: this.roomRtt(), lossPct: 0, bytesSent: 0, bytesRecv: 0, jitterMs: null };
    var pairs = 0;
    for (var i = 0; i < (pcs || []).length; i++) {
      var pc = pcs[i];
      if (!pc || typeof pc.getStats !== "function") continue;
      try {
        var rep = await pc.getStats();
        rep.forEach(function (s) {
          if (s.type === "candidate-pair" && s.state === "succeeded" && s.currentRoundTripTime != null) {
            agg.rttMs = agg.rttMs == null ? s.currentRoundTripTime * 1000
              : (agg.rttMs + s.currentRoundTripTime * 1000) / 2;
          }
          if (s.type === "inbound-rtp" && !s.isRemote) {
            agg.bytesRecv += Number(s.bytesReceived) || 0;
            if (s.jitter != null) agg.jitterMs = s.jitter * 1000;
            var lost = Number(s.packetsLost) || 0, recv = Number(s.packetsReceived) || 0;
            if (lost + recv > 0) { agg.lossPct += lost / (lost + recv) * 100; pairs++; }
          }
          if (s.type === "outbound-rtp" && !s.isRemote) agg.bytesSent += Number(s.bytesSent) || 0;
        });
      } catch (_) {}
    }
    if (pairs) agg.lossPct = agg.lossPct / pairs;
    this.stats = agg;
    this.emit("stats", agg);
    return agg;
  };

  /** 给 sender 设置码率 / 帧率 / 缩放；浏览器不支持的字段会被忽略。 */
  function tuneSender(sender, params) {
    if (!sender || typeof sender.getParameters !== "function") return Promise.resolve();
    try {
      var p = sender.getParameters();
      p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
      p.encodings.forEach(function (enc) {
        if (params.maxBitrate) enc.maxBitrate = params.maxBitrate;
        if (params.maxFramerate) enc.maxFramerate = params.maxFramerate;
        if (params.scale) enc.scaleResolutionDownBy = params.scale;
        if (params.priority) enc.priority = params.priority;
      });
      if (params.degradationPreference) p.degradationPreference = params.degradationPreference;
      return sender.setParameters(p).catch(function () {});
    } catch (_) { return Promise.resolve(); }
  }

  /** 优先 VP9 / AV1 / H.264，按浏览器实际能力回退。 */
  function preferCodecs(transceiver, kind) {
    try {
      if (!transceiver || !transceiver.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
      var caps = RTCRtpReceiver.getCapabilities(kind);
      if (!caps || !caps.codecs) return;
      var order = kind === "video" ? ["video/AV1", "video/VP9", "video/H264"] : ["audio/opus"];
      var sorted = caps.codecs.slice().sort(function (a, b) {
        function rank(c) { for (var i = 0; i < order.length; i++) if ((c.mimeType || "").indexOf(order[i]) === 0) return i; return 99; }
        return rank(a) - rank(b);
      });
      transceiver.setCodecPreferences(sorted);
    } catch (_) {}
  }

  /* ══ 本地直连降级（Mesh）═══════════════════════════════════ */
  function MeshTransport(room, opts) {
    VoiceTransportBase.call(this, room, opts);
    this.peers = {};       // memberId -> { pc, polite, makingOffer, ignoreOffer, pending }
    this.myId = (opts && opts.me && opts.me.id) || "me";
    this.iceServers = (opts.join && opts.join.iceServers) || [];
    var self = this;
    room.on("signal", function (m) { self.onSignal(m); });
    room.on("members", function (m) { self.syncMembers(m.members || []); });
    room.on("close", function () { self.closeAllPeers(); });
  }
  MeshTransport.prototype = Object.create(VoiceTransportBase.prototype);
  MeshTransport.prototype.constructor = MeshTransport;
  MeshTransport.prototype.kind = "mesh";

  MeshTransport.prototype.connect = async function () {
    this.emit("connected", { mode: "mesh" });
  };
  MeshTransport.prototype.pcs = function () {
    var out = [], self = this;
    Object.keys(this.peers).forEach(function (id) { if (self.peers[id].pc) out.push(self.peers[id].pc); });
    return out;
  };
  MeshTransport.prototype.addLocalTracks = function (pc) {
    var audio = this.localAudioTrack();
    if (audio) {
      var has = pc.getSenders().some(function (s) { return s.track === audio; });
      if (!has) {
        var t = pc.addTransceiver(audio, { direction: "sendonly" });
        preferCodecs(t, "audio");
        tuneSender(t.sender, { maxBitrate: (this.settings.audio.bitrateKbps || 48) * 1000, priority: "high" });
      }
    }
    if (this.screenStream) {
      var vt = this.screenStream.getVideoTracks()[0];
      if (vt && !pc.getSenders().some(function (s) { return s.track === vt; })) {
        var tv = pc.addTransceiver(vt, { direction: "sendonly", sendEncodings: [
          { rid: "h", scaleResolutionDownBy: 1 },
          { rid: "m", scaleResolutionDownBy: 2 },
          { rid: "l", scaleResolutionDownBy: 4 }
        ] });
        preferCodecs(tv, "video");
        tuneSender(tv.sender, {
          maxBitrate: (this.shareParams && this.shareParams.bitrateKbps || 4000) * 1000,
          maxFramerate: this.shareParams && this.shareParams.fps || 30,
          degradationPreference: this.shareParams && this.shareParams.contentHint === "detail"
            ? "maintain-resolution" : "maintain-framerate"
        });
      }
    }
  };
  MeshTransport.prototype.makePeer = function (peerId) {
    if (this.peers[peerId]) return this.peers[peerId];
    var self = this;
    var pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: "max-bundle" });
    var st = { pc: pc, polite: this.myId > peerId, makingOffer: false, ignoreOffer: false, pending: false };
    this.peers[peerId] = st;
    pc.ontrack = function (ev) {
      var kind = ev.track.kind === "video" ? "video" : "audio";
      var el = self.attach(peerId, kind, ev.track, ev.streams && ev.streams[0] ? ev.streams[0].id : "");
      if (kind === "video") {
        var stage = document.getElementById("screen-video");
        if (stage) { stage.srcObject = new MediaStream([ev.track]); stage.play().catch(function () {}); }
      }
      void el;
    };
    pc.onconnectionstatechange = function () {
      if (pc.connectionState === "failed") {
        self.emit("notice", { text: "与某位成员的连接中断，正在尝试重连" });
        pc.restartIce && pc.restartIce();
      }
      self.emit("connectionState", { peerId: peerId, state: pc.connectionState });
    };
    pc.onnegotiationneeded = async function () {
      try {
        st.makingOffer = true;
        await pc.setLocalDescription();
        await waitICE(pc);
        self.room.sendSignal(peerId, { kind: "description", description: pc.localDescription });
        self.emit("signaling", { to: peerId, type: "offer" });
      } catch (e) { console.warn("[mesh] 协商失败", e); }
      finally { st.makingOffer = false; }
    };
    this.addLocalTracks(pc);
    return st;
  };
  MeshTransport.prototype.onSignal = async function (m) {
    var peerId = m.from;
    var data = m.data || {};
    if (!peerId) return;
    var st = this.makePeer(peerId);
    var pc = st.pc;
    try {
      if (data.description) {
        var ready = !st.makingOffer && (pc.signalingState === "stable" || st.pending);
        var collision = data.description.type === "offer" && !ready;
        st.ignoreOffer = !st.polite && collision;
        if (st.ignoreOffer) return;
        st.pending = data.description.type === "answer";
        await pc.setRemoteDescription(data.description);
        st.pending = false;
        if (data.description.type === "offer") {
          this.addLocalTracks(pc);
          await pc.setLocalDescription();
          await waitICE(pc);
          this.room.sendSignal(peerId, { kind: "description", description: pc.localDescription });
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); }
        catch (e) { if (!st.ignoreOffer) throw e; }
      } else if (data.kind === "quality") {
        // 观看端通过 Worker 的 DO 中继请求画质；由共享者本地调整编码层
        this.setScreenQuality(data.value);
      } else if (data.kind === "bye") {
        this.closePeer(peerId);
      }
    } catch (e) { console.warn("[mesh] 处理信令失败", e); }
  };
  MeshTransport.prototype.syncMembers = function (members) {
    var alive = {}, self = this;
    members.forEach(function (m) {
      if (m.id === self.myId) return;
      alive[m.id] = true;
      self.makePeer(m.id);
    });
    Object.keys(this.peers).forEach(function (id) {
      if (!alive[id]) self.closePeer(id);
    });
  };
  MeshTransport.prototype.closePeer = function (id) {
    var st = this.peers[id];
    if (!st) return;
    try { st.pc.close(); } catch (_) {}
    delete this.peers[id];
    this.detach(id);
  };
  MeshTransport.prototype.closeAllPeers = function () {
    var self = this;
    Object.keys(this.peers).forEach(function (id) { self.closePeer(id); });
  };
  MeshTransport.prototype.onScreenTrack = async function () {
    var self = this;
    Object.keys(this.peers).forEach(function (id) { self.addLocalTracks(self.peers[id].pc); });
    this.emit("screenStarted", this.shareParams);
  };
  MeshTransport.prototype.onScreenStopped = async function () {
    // 移除视频 transceiver 会触发再次协商；为保持简单，先保留 stopped 轨道，
    // 由下一次成员同步时统一重建连接。
    var self = this;
    Object.keys(this.peers).forEach(function (id) {
      var pc = self.peers[id].pc;
      pc.getSenders().forEach(function (s) {
        if (s.track && s.track.kind === "video" && s.track.readyState === "ended") {
          try { pc.removeTrack(s); } catch (_) {}
        }
      });
    });
  };
  MeshTransport.prototype.onSettingsChanged = function (settings) {
    var bitrate = (settings.audio.bitrateKbps || 48) * 1000;
    var self = this;
    Object.keys(this.peers).forEach(function (id) {
      self.peers[id].pc.getSenders().forEach(function (s) {
        if (s.track && s.track.kind === "audio") tuneSender(s, { maxBitrate: bitrate, priority: "high" });
        if (s.track && s.track.kind === "video") {
          tuneSender(s, {
            maxBitrate: Math.min((self.shareParams && self.shareParams.bitrateKbps || 4000) * 1000,
              (settings.screen.maxBitrateKbps || 4000) * 1000),
            maxFramerate: Math.min(self.shareParams && self.shareParams.fps || 30, settings.screen.maxFps || 30)
          });
        }
      });
    });
  };
  MeshTransport.prototype.getStats = function () { return this.collectStats(this.pcs()); };
  MeshTransport.prototype.disconnect = async function () {
    var self = this;
    Object.keys(this.peers).forEach(function (id) { self.room.sendSignal(id, { kind: "bye" }); });
    this.closeAllPeers();
    await VoiceTransportBase.prototype.disposeAudio.call(this);
  };

  /* ══ Cloudflare Realtime SFU ════════════════════════════════ */
  function CloudflareTransport(room, opts) {
    VoiceTransportBase.call(this, room, opts);
    this.iceServers = opts.join.iceServers || [];
    this.channelId = opts.join.channel.id;
    this.pubSessionId = null;
    this.subSessionId = null;
    this.pcPub = null;
    this.pcSub = null;
    this.publications = [];     // 自己发布的 track
    this.remoteMap = {};        // mid -> {memberId, kind}
    this.chain = Promise.resolve();
    this.knownPubs = {};
    var self = this;
    room.on("members", function (m) { self.syncPublications(m.members || []); });
  }
  CloudflareTransport.prototype = Object.create(VoiceTransportBase.prototype);
  CloudflareTransport.prototype.constructor = CloudflareTransport;
  CloudflareTransport.prototype.kind = "cloudflare";

  CloudflareTransport.prototype.sfu = function (path, body) {
    return post("/rtc/tracks", Object.assign({ channelId: this.channelId }, body));
  };
  CloudflareTransport.prototype.queue = function (fn) {
    var self = this;
    this.chain = this.chain.then(fn).catch(function (e) {
      console.warn("[sfu] 操作失败", e);
      self.emit("error", e);
    });
    return this.chain;
  };
  CloudflareTransport.prototype.connect = async function () {
    // 订阅会话先建好（收到 SFU offer 时再协商）
    var sub = await post("/rtc/session", { channelId: this.channelId, kind: "subscribe" });
    this.subSessionId = sub.sessionId;
    this.pcSub = new RTCPeerConnection({ iceServers: this.iceServers });
    var self = this;
    this.pcSub.ontrack = function (ev) {
      var mid = ev.transceiver && ev.transceiver.mid;
      var info = self.remoteMap[mid] || { memberId: "sfu-" + mid, kind: ev.track.kind };
      var kind = ev.track.kind === "video" ? "video" : "audio";
      self.attach(info.memberId, kind, ev.track, info.trackName || "");
      if (kind === "video") {
        var stage = document.getElementById("screen-video");
        if (stage) { stage.srcObject = new MediaStream([ev.track]); stage.play().catch(function () {}); }
      }
    };
    this.emit("connected", { mode: "cloudflare" });
  };
  CloudflareTransport.prototype.publishAudio = async function () {
    var track = await VoiceTransportBase.prototype.publishAudio.call(this);
    if (!track) throw new Error("没有可用的麦克风轨道");
    this.pcPub = new RTCPeerConnection({ iceServers: this.iceServers });
    var tr = this.pcPub.addTransceiver(track, { direction: "sendonly" });
    preferCodecs(tr, "audio");
    await tuneSender(tr.sender, { maxBitrate: (this.settings.audio.bitrateKbps || 48) * 1000, priority: "high" });
    await this.pcPub.setLocalDescription(await this.pcPub.createOffer());
    await waitICE(this.pcPub);
    var mid = tr.mid;
    var created = await post("/rtc/session", { channelId: this.channelId, kind: "publish" });
    this.pubSessionId = created.sessionId;
    var r = await this.sfu("/rtc/tracks", {
      sessionId: this.pubSessionId, op: "new",
      payload: {
        sessionDescription: { type: "offer", sdp: this.pcPub.localDescription.sdp },
        tracks: [{ location: "local", mid: mid, trackName: "audio" }]
      }
    });
    var answer = r.data && r.data.sessionDescription;
    if (!answer || !answer.sdp) throw new Error("SFU 未返回 answer SDP");
    await this.pcPub.setRemoteDescription(answer);
    this.publications = [{ sessionId: this.pubSessionId, trackName: "audio", kind: "audio", mid: mid }];
    this.room.announce(this.publications);
    return track;
  };
  /** 成员 publications 变化时订阅新轨道（同一订阅会话里批量请求）。 */
  CloudflareTransport.prototype.syncPublications = function (members) {
    var self = this, wanted = [];
    members.forEach(function (m) {
      if (m.id === (self.opts.me && self.opts.me.id)) return;
      (m.publications || []).forEach(function (p) {
        var key = p.sessionId + "|" + p.trackName;
        if (self.knownPubs[key]) return;
        wanted.push({ key: key, memberId: m.id, sessionId: p.sessionId, trackName: p.trackName, kind: p.kind });
      });
    });
    Object.keys(this.knownPubs).forEach(function (key) {
      var still = members.some(function (m) {
        return (m.publications || []).some(function (p) { return p.sessionId + "|" + p.trackName === key; });
      });
      if (!still) delete self.knownPubs[key];
    });
    if (!wanted.length || !this.subSessionId) return;
    this.queue(async function () {
      var r = await self.sfu("/rtc/tracks", {
        sessionId: self.subSessionId, op: "new",
        payload: { tracks: wanted.map(function (w) {
          return { location: "remote", sessionId: w.sessionId, trackName: w.trackName };
        }) }
      });
      var d = r.data || {};
      var results = d.tracks || d.results || [];
      results.forEach(function (res, i) {
        if (res.errorCode || res.errorDescription) return;
        var mid = res.mid != null ? String(res.mid) : String(i);
        var w = wanted[i] || wanted[0];
        self.remoteMap[mid] = { memberId: w.memberId, kind: w.kind, trackName: w.trackName };
        self.knownPubs[w.key] = true;
      });
      var offer = d.sessionDescription;
      if (!offer || !offer.sdp) return;
      await self.pcSub.setRemoteDescription(offer);
      await self.pcSub.setLocalDescription(await self.pcSub.createAnswer());
      await waitICE(self.pcSub);
      await self.sfu("/rtc/tracks", {
        sessionId: self.subSessionId, op: "renegotiate",
        payload: { sessionDescription: { type: "answer", sdp: self.pcSub.localDescription.sdp } }
      });
    });
  };
  CloudflareTransport.prototype.onScreenTrack = async function (track) {
    if (!this.pcPub) throw new Error("尚未建立 SFU 发布会话");
    var tr = this.pcPub.addTransceiver(track, { direction: "sendonly", sendEncodings: [
      { rid: "h", scaleResolutionDownBy: 1 },
      { rid: "m", scaleResolutionDownBy: 2 },
      { rid: "l", scaleResolutionDownBy: 4 }
    ] });
    preferCodecs(tr, "video");
    await tuneSender(tr.sender, {
      maxBitrate: (this.shareParams.bitrateKbps || 4000) * 1000,
      maxFramerate: this.shareParams.fps || 30,
      degradationPreference: this.shareParams.contentHint === "detail" ? "maintain-resolution" : "maintain-framerate"
    });
    await this.pcPub.setLocalDescription(await this.pcPub.createOffer());
    await waitICE(this.pcPub);
    var r = await this.sfu("/rtc/tracks", {
      sessionId: this.pubSessionId, op: "new",
      payload: {
        sessionDescription: { type: "offer", sdp: this.pcPub.localDescription.sdp },
        tracks: [{ location: "local", mid: tr.mid, trackName: "screen" }]
      }
    });
    var answer = r.data && r.data.sessionDescription;
    if (answer && answer.sdp) await this.pcPub.setRemoteDescription(answer);
    this.publications.push({ sessionId: this.pubSessionId, trackName: "screen", kind: "video", mid: tr.mid });
    this.room.announce(this.publications);
    this.emit("screenStarted", this.shareParams);
  };
  CloudflareTransport.prototype.onScreenStopped = async function () {
    if (!this.publications.length) return;
    this.publications = this.publications.filter(function (p) { return p.kind !== "video"; });
    this.room.announce(this.publications);
    // tracks/close 需要重新协商；失败不影响本地 UI 状态清理
    var pub = this.publications[this.publications.length - 1];
    void pub;
  };
  CloudflareTransport.prototype.onSettingsChanged = function (settings) {
    var self = this;
    if (this.pcPub) this.pcPub.getSenders().forEach(function (s) {
      if (!s.track) return;
      if (s.track.kind === "audio") tuneSender(s, { maxBitrate: (settings.audio.bitrateKbps || 48) * 1000 });
      else tuneSender(s, {
        maxBitrate: Math.min((self.shareParams && self.shareParams.bitrateKbps || 4000) * 1000,
          (settings.screen.maxBitrateKbps || 4000) * 1000),
        maxFramerate: Math.min(self.shareParams && self.shareParams.fps || 30, settings.screen.maxFps || 30)
      });
    });
  };
  CloudflareTransport.prototype.getStats = function () {
    return this.collectStats([this.pcPub, this.pcSub].filter(Boolean));
  };
  CloudflareTransport.prototype.disconnect = async function () {
    if (this.pcPub) { try { this.pcPub.close(); } catch (_) {} }
    if (this.pcSub) { try { this.pcSub.close(); } catch (_) {} }
    this.room.announce([]);
    await VoiceTransportBase.prototype.disposeAudio.call(this);
  };

  /* ══ 可选高级模式：LiveKit（默认不使用）════════════════════ */
  function LiveKitTransport(room, opts) {
    VoiceTransportBase.call(this, room, opts);
    this.join = opts.join;
    this.lk = null;
    this.lkRoom = null;
  }
  LiveKitTransport.prototype = Object.create(VoiceTransportBase.prototype);
  LiveKitTransport.prototype.constructor = LiveKitTransport;
  LiveKitTransport.prototype.kind = "livekit";

  LiveKitTransport.prototype.loadSDK = function () {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/voice/vendor/livekit-client.umd.js";
      s.onload = function () { window.LivekitClient ? resolve(window.LivekitClient) : reject(new Error("自建频道组件加载失败")); };
      s.onerror = function () { reject(new Error("自建频道组件加载失败，请检查 voice/vendor/livekit-client.umd.js")); };
      document.head.appendChild(s);
    });
  };
  LiveKitTransport.prototype.connect = async function () {
    if (!this.join.selfHosted) throw new Error("该频道没有配置自建服务器");
    var SDK = await this.loadSDK();
    if (!SDK.Room) throw new Error("LiveKit 组件版本不兼容");
    var self = this;
    this.lk = SDK;
    var room = new SDK.Room({ adaptiveStream: true, dynacast: true });
    this.lkRoom = room;
    if (SDK.RoomEvent) {
      room.on(SDK.RoomEvent.TrackSubscribed, function (track, pub, participant) {
        var kind = track.kind === "video" ? "video" : "audio";
        if (!track.attach) return;
        var el = track.attach();
        el.autoplay = true; el.playsInline = true; el.muted = self.deaf;
        if (kind === "video") {
          var stage = document.getElementById("screen-video");
          if (stage) { stage.srcObject = el.srcObject; stage.play().catch(function () {}); }
        } else if (self.sink) self.sink.appendChild(el);
        self.emit("track", { memberId: participant && participant.identity, kind: kind });
      });
      room.on(SDK.RoomEvent.Disconnected, function () { self.emit("disconnected"); });
    }
    try {
      await room.connect(this.join.selfHosted.url, this.join.selfHosted.token, { autoSubscribe: true });
    } catch (e) {
      throw new Error("无法连接自建服务器：请确认 LiveKit 已启动、wss 域名证书有效、令牌由 Worker 正确签发。" + (e && e.message ? "（" + e.message + "）" : ""));
    }
    this.emit("connected", { mode: "livekit" });
  };
  LiveKitTransport.prototype.publishAudio = async function () {
    // LiveKit 自己管理麦克风；这里仍建立本地音频图用于 VAD 与输入音量
    await VoiceTransportBase.prototype.publishAudio.call(this);
    if (this.lkRoom && this.lkRoom.localParticipant && this.lkRoom.localParticipant.setMicrophoneEnabled) {
      await this.lkRoom.localParticipant.setMicrophoneEnabled(this.micOn);
    }
    return this.localAudioTrack();
  };
  LiveKitTransport.prototype.setMic = function (on) {
    VoiceTransportBase.prototype.setMic.call(this, on);
    if (this.lkRoom && this.lkRoom.localParticipant && this.lkRoom.localParticipant.setMicrophoneEnabled) {
      this.lkRoom.localParticipant.setMicrophoneEnabled(!!on).catch(function () {});
    }
  };
  LiveKitTransport.prototype.onScreenTrack = async function (track) {
    if (!this.lkRoom || !this.lkRoom.localParticipant || !this.lkRoom.localParticipant.setScreenShareEnabled) {
      throw new Error("当前 LiveKit 组件不支持屏幕共享");
    }
    await this.lkRoom.localParticipant.setScreenShareEnabled(true, {
      audio: !!(this.screenStream && this.screenStream.getAudioTracks().length),
      resolution: { width: this.shareParams.width, height: this.shareParams.height },
      frameRate: this.shareParams.fps,
      contentHint: this.shareParams.contentHint
    });
    this.emit("screenStarted", this.shareParams);
    void track;
  };
  LiveKitTransport.prototype.onScreenStopped = async function () {
    if (this.lkRoom && this.lkRoom.localParticipant && this.lkRoom.localParticipant.setScreenShareEnabled) {
      try { await this.lkRoom.localParticipant.setScreenShareEnabled(false); } catch (_) {}
    }
  };
  LiveKitTransport.prototype.onSettingsChanged = function (settings) {
    try {
      if (this.lkRoom && this.lkRoom.localParticipant && this.lkRoom.localParticipant.setAudioBitrate) {
        this.lkRoom.localParticipant.setAudioBitrate((settings.audio.bitrateKbps || 48) * 1000);
      }
    } catch (_) {}
  };
  LiveKitTransport.prototype.getStats = function () {
    var rtt = this.roomRtt();
    return Promise.resolve({ rttMs: rtt, lossPct: 0, bytesSent: 0, bytesRecv: 0, jitterMs: null });
  };
  LiveKitTransport.prototype.disconnect = async function () {
    if (this.lkRoom) { try { await this.lkRoom.disconnect(); } catch (_) {} }
    await VoiceTransportBase.prototype.disposeAudio.call(this);
  };

  /* ── 运行时更换麦克风 / 音频处理（设置抽屉实时生效） ───────── */
  VoiceTransportBase.prototype.refreshAudio = async function (opts) {
    if (opts) for (var k in opts) this.opts[k] = opts[k];
    var old = this.localAudioTrack();
    clearInterval(this.vadTimer);
    if (this.micStream) this.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
    this.micStream = null; this.processedStream = null;
    this.analyser = null; this.gain = null;
    if (this.audioCtx) { try { await this.audioCtx.close(); } catch (_) {} this.audioCtx = null; }
    var fresh = await this.publishAudio();
    try { await this.onAudioTrackReplaced(old, fresh); } catch (e) { console.warn("[voice] 替换音轨失败", e); }
    return fresh;
  };
  VoiceTransportBase.prototype.onAudioTrackReplaced = function () { return Promise.resolve(); };
  VoiceTransportBase.prototype.setScreenQuality = function (value) {
    var map = { auto: 1, "1080": 1, "720": 2, "360": 4 };
    var scale = map[String(value)] || 1;
    var self = this;
    Object.keys(this.elements).forEach(function () { /* 占位：画质由发送端调整 */ });
    this.emit("screenQuality", { value: value, scale: scale });
    void self;
    return scale;
  };

  MeshTransport.prototype.onAudioTrackReplaced = async function (oldTrack, newTrack) {
    var self = this, jobs = [];
    Object.keys(this.peers).forEach(function (id) {
      self.peers[id].pc.getSenders().forEach(function (s) {
        if (s.track === oldTrack || (s.track && s.track.kind === "audio")) {
          jobs.push(s.replaceTrack(newTrack).catch(function () {}));
        }
      });
    });
    await Promise.all(jobs);
  };
  MeshTransport.prototype.setScreenQuality = function (value) {
    var scale = VoiceTransportBase.prototype.setScreenQuality.call(this, value);
    var self = this;
    Object.keys(this.peers).forEach(function (id) {
      self.peers[id].pc.getSenders().forEach(function (s) {
        if (s.track && s.track.kind === "video") {
          tuneSender(s, { scale: scale, maxFramerate: self.shareParams && self.shareParams.fps || 30 });
        }
      });
    });
    return scale;
  };

  CloudflareTransport.prototype.onAudioTrackReplaced = async function (oldTrack, newTrack) {
    if (!this.pcPub) return;
    var jobs = [];
    this.pcPub.getSenders().forEach(function (s) {
      if (s.track === oldTrack || (s.track && s.track.kind === "audio")) {
        jobs.push(s.replaceTrack(newTrack).catch(function () {}));
      }
    });
    await Promise.all(jobs);
  };
  CloudflareTransport.prototype.setScreenQuality = function (value) {
    var scale = VoiceTransportBase.prototype.setScreenQuality.call(this, value);
    var self = this;
    if (this.pcPub) this.pcPub.getSenders().forEach(function (s) {
      if (s.track && s.track.kind === "video") tuneSender(s, { scale: scale });
    });
    return scale;
  };
  LiveKitTransport.prototype.onAudioTrackReplaced = function () { return Promise.resolve(); };

  /* ── 基类通用清理 ───────────────────────────────────────────── */
  VoiceTransportBase.prototype.disposeAudio = async function () {
    clearInterval(this.vadTimer);
    if (this.micStream) this.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
    if (this.screenStream) this.screenStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
    this.micStream = null; this.screenStream = null; this.processedStream = null;
    var self = this;
    Object.keys(this.elements).forEach(function (id) { self.detach(id); });
    if (this.audioCtx) { try { await this.audioCtx.close(); } catch (_) {} }
    this.audioCtx = null;
  };

  /* ── 工厂 ──────────────────────────────────────────────────── */
  function createTransport(room, opts) {
    var mode = (opts.join && opts.join.transport) || "mesh";
    if (mode === "cloudflare") return new CloudflareTransport(room, opts);
    if (mode === "livekit") return new LiveKitTransport(room, opts);
    return new MeshTransport(room, opts);
  }

  window.VoiceTransport = {
    VoiceRoomClient: VoiceRoomClient,
    Base: VoiceTransportBase,
    Mesh: MeshTransport,
    Cloudflare: CloudflareTransport,
    LiveKit: LiveKitTransport,
    create: createTransport,
    waitICE: waitICE,
    post: post
  };
})();
