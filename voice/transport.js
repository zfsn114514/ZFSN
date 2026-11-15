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

  /* ── 媒体音量（0~200%）─────────────────────────────────────────
     HTMLMediaElement.volume 按规范只接受 0~1，超出会直接抛
     IndexSizeError（用户拖音量条时的报错就来自这里）。界面上的
     音量条是 0~200%，所以超过 100% 的那部分用 WebAudio 的 GainNode
     放大：元素自身音量固定在 1，增益全由 gain 节点给。
     100% 以内仍只用元素音量，不额外挂音频图（挂了也只是多一路空转）。 */
  var volCtx = null;
  var volNodes = [];
  var resumeArmed = false;

  /* 自动播放策略下 AudioContext 可能是 suspended，此时把元素接进音频图会
     变成静音。首次真实交互（点击 / 按键）时补一次 resume。 */
  function armResume() {
    if (resumeArmed || !volCtx) return;
    resumeArmed = true;
    function kick() {
      try { if (volCtx && volCtx.state !== "running") volCtx.resume(); } catch (_) {}
      if (volCtx && volCtx.state === "running") {
        document.removeEventListener("pointerdown", kick, true);
        document.removeEventListener("keydown", kick, true);
        resumeArmed = false;
      }
    }
    document.addEventListener("pointerdown", kick, true);
    document.addEventListener("keydown", kick, true);
  }

  function volNodeOf(el) {
    for (var i = 0; i < volNodes.length; i++) if (volNodes[i].el === el) return volNodes[i];
    return null;
  }

  function ensureVolNode(el) {
    var node = volNodeOf(el);
    if (node) return node;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!volCtx) volCtx = new AC();
      var src = volCtx.createMediaElementSource(el);
      var gain = volCtx.createGain();
      src.connect(gain);
      gain.connect(volCtx.destination);
      node = { el: el, src: src, gain: gain };
      volNodes.push(node);
      armResume();
      return node;
    } catch (_) { return null; }
  }

  /** 设置某个媒体元素的播放音量，gainValue 为倍数（1 = 原音量）。 */
  function setElementVolume(el, gainValue) {
    if (!el) return;
    var g = Number(gainValue);
    if (!isFinite(g) || g < 0) g = 0;
    if (g > 2) g = 2;
    var node = volNodeOf(el);
    if (!node && g <= 1) {
      // 常规范围：交给元素自己
      try { el.volume = g; } catch (_) {}
      return;
    }
    if (!node) node = ensureVolNode(el);
    if (!node) {
      // 没有 WebAudio（或被浏览器拒绝）：至少保证不抛错
      try { el.volume = Math.min(1, g); } catch (_) {}
      return;
    }
    try { el.volume = 1; } catch (_) {}
    try { node.gain.gain.value = g; } catch (_) {}
    if (volCtx && volCtx.state === "suspended" && volCtx.resume) {
      var p = volCtx.resume();
      if (p && p.catch) p.catch(function () {});
    }
  }

  function dropElementVolume(el) {
    for (var i = volNodes.length - 1; i >= 0; i--) {
      if (volNodes[i].el !== el) continue;
      try { volNodes[i].src.disconnect(); volNodes[i].gain.disconnect(); } catch (_) {}
      volNodes.splice(i, 1);
    }
  }

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
    this.reconnectTimer = null;
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
    // 上一轮 onclose 排下的重连任务必须作废，否则「先断开再重连」会让
    // 老定时器在稍后再建一条连接，把 self.ws 覆盖掉，留下无人管理的幽灵连接。
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    // 同一次会话里重复 connect()：先彻底摘掉旧 socket 的事件回调再关，
    // 这样旧连接的 onclose 不会触发 emit("close") / 再次排重连。
    if (this.ws) {
      var stale = this.ws;
      this.ws = null;
      stale.onopen = stale.onmessage = stale.onclose = stale.onerror = null;
      try { stale.close(1000, "superseded"); } catch (_) {}
    }
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(self.join.wsUrl); }
      catch (e) { reject(new Error("无法建立房间连接：" + e.message)); return; }
      self.ws = ws;
      var settled = false;
      var connectTimer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (_) {}
        reject(new Error("房间连接超时，请切换网络后重试"));
      }, 10000);
      ws.onopen = function () {
        // 已被新连接取代：立刻关掉自己，且不要 resolve/reject 调用方。
        if (self.ws !== ws) { try { ws.close(1000, "superseded"); } catch (_) {} return; }
        // close() 可能在 CONNECTING 阶段就被调用（快速切换频道时很常见），
        // 此时连接仍会打开；必须立刻关掉，否则会变成没人管理的幽灵连接。
        if (self.closed) {
          try { ws.close(1000, "leave"); } catch (_) {}
          if (!settled) { settled = true; clearTimeout(connectTimer); reject(new Error("加入流程已取消")); }
          return;
        }
        self.retries = 0;
        self.startPing();
        if (!settled) { settled = true; clearTimeout(connectTimer); resolve(); }
        self.emit("open");
      };
      ws.onmessage = function (ev) {
        if (self.ws !== ws) return;
        var m;
        try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.t === "hello") { self.self = m.self; self.emit("hello", m); }
        else if (m.t === "pong") {
          self.rtt = Date.now() - Number(m.ts || Date.now());
          self.emit("pong", self.rtt);
        } else if (m.t === "settings") self.emit("settings", m);
        else if (m.t === "members") self.emit("members", m);
        else if (m.t === "signal") self.emit("signal", m);
        else if (m.t === "chat") self.emit("chat", m);
        else if (m.t === "channel") self.emit("channel", m);
        else if (m.t === "kicked") self.emit("kicked", m);
        else if (m.t === "forcedMute") self.emit("forcedMute", m);
        else if (m.t === "notice") self.emit("notice", m);
        else if (m.t === "error") self.emit("error", new Error(m.text || "房间错误"));
        else self.emit(m.t, m);
      };
      ws.onclose = function (ev) {
        // 已被新连接取代的旧 socket：直接忽略，不广播 close、不排重连。
        if (self.ws !== ws) return;
        self.stopPing();
        clearTimeout(connectTimer);
        self.emit("close", ev);
        if (self.closed) return;
        // 服务端主动终结的连接一律不重连：票据无效(4401)、同一账号已在别处
        // 连接(4402)、被踢(4403)、频道删除(4404)。否则客户端会不断重连、
        // 与 DO 的「单账号单连接」互相踢，形成连接风暴和一堆重复成员。
        if ([4401, 4402, 4403, 4404].indexOf(ev.code) >= 0) {
          if (!settled) { settled = true; clearTimeout(connectTimer); reject(new Error("房间连接被拒绝（" + ev.code + "）")); }
          self.emit("notice", { text: ev.code === 4402
            ? "该账号已在其他频道或窗口连接，本地连接已结束"
            : (ev.reason || "房间连接已结束") });
          return;
        }
        if (!settled) { settled = true; clearTimeout(connectTimer); reject(new Error("房间连接被拒绝（" + ev.code + "）")); return; }
        // 断线自动重连：票据 5 分钟有效，过期后请上层重新调用 join 接口
        if (self.retries < 6) {
          var delay = Math.min(6000, 600 * Math.pow(1.6, self.retries++));
          self.emit("notice", { text: "连接断开，" + Math.round(delay / 1000) + " 秒后自动重连…" });
          // 句柄留档：close() / 新的 connect() 能取消它，避免重复建连。
          clearTimeout(self.reconnectTimer);
          self.reconnectTimer = setTimeout(function () {
            self.reconnectTimer = null;
            if (!self.closed) self.connect().catch(function () {});
          }, delay);
        } else {
          self.emit("error", new Error("重连失败，请退出频道后重新进入"));
        }
      };
      ws.onerror = function () {
        if (self.ws !== ws) return;
        self.emit("error", new Error("房间连接异常"));
      };
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
    // 取消尚未触发的重连，避免「关掉房间后 6 秒又自己连回来」。
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    var ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(1000, "leave"); } catch (_) {}
    }
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
    this.gateGain = null;
    this.hpf = null;
    this.analyser = null;
    this.vadTimer = null;
    this.micOn = true;
    this.deaf = false;
    this.inputVolume = 1;
    /* 语音激活（麦克风激活阈值）：rms 低于阈值时把本地这一路增益压到 0，
       等于一个软门限——麦克风一直在采集，只是不发出去。 */
    this.gateEnabled = false;
    this.gateThreshold = 0.025;
    this.gateOpen = true;
    this.gateHold = 0;
    this.silentMs = 0;        // 连续没有输入信号的时长，用来提示「麦克风没声音」
    this.level = 0;           // 0~1 的输入电平，给设置面板画电平条
    this.memberVolumes = {};
    this.elements = {};       // memberId -> { audio, video }
    this.settings = (this.opts.join && this.opts.join.settings) || { audio: {}, screen: {} };
    this.stats = { rttMs: null, lossPct: null, bytesSent: null, bytesRecv: null, jitterMs: null, sendKbps: null, recvKbps: null };
    this.statsHistory = { rttMs: [], lossPct: [], jitterMs: [], sendKbps: [], recvKbps: [], videoSendKbps: [], videoRecvKbps: [], sendFps: [], recvFps: [] };
    this.statsPrevious = null;
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
    var echo = this.opts.echo !== false;
    var noise = this.opts.noise !== false;
    var agc = this.opts.agc !== false;
    var c = {
      echoCancellation: echo,
      noiseSuppression: noise,
      autoGainControl: agc,
      channelCount: a.channels || 1
    };
    if (a.sampleRate) c.sampleRate = a.sampleRate;
    if (this.opts.deviceId) c.deviceId = { exact: this.opts.deviceId };
    /* Chrome 的实现级开关：标准三项只是「开/关」，这几项才会打开更激进的
       回声消除（尤其是外放时的那一层非线性抑制）与噪声抑制子功能。
       不支持的浏览器会忽略未知约束，不会报错。 */
    var adv = {};
    if (echo) {
      adv.googEchoCancellation = true;
      adv.googExperimentalEchoCancellation = true;
      adv.googAudioMirroring = false;
    }
    if (noise) {
      adv.googNoiseSuppression = true;
      adv.googHighpassFilter = true;
      adv.googTypingNoiseDetection = true;
    }
    if (agc) {
      adv.googAutoGainControl = true;
      adv.googAutoGainControl2 = true;
    }
    if (Object.keys(adv).length) c.advanced = [adv];
    return c;
  };

  /** 取得麦克风并建立「增益 + VAD」音频图；失败时给出中文权限指引。 */
  VoiceTransportBase.prototype.publishAudio = async function () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error("当前浏览器不支持麦克风采集，请使用最新版 Chrome / Edge");
    }
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
    // 新麦克风一到就重新按门限判定一次：换设备后 audioCtx / 增益都是新的，
    // 不补这一次就会出现「门限还开着、声音却一直往里发」或反过来卡死。
    this.gateOpen = true;
    this.gateHold = 0;
    this.silentMs = 0;
    this.applyGate(true);
    return this.localAudioTrack();
  };

  /**
   * 本地音频图：mic → 输入音量 → 门限增益 → 推流；另从 mic 分一支给分析器。
   *
   * 为什么门限要单独一个 GainNode，而不是直接关 track.enabled：
   *   track.enabled=false 是「静音」语义，LiveKit 的 mute()/unmute()、换设备后的
   *   replaceTrack 都会读写这个属性。门限也去改它，两个状态互相覆盖，一旦卡在
   *   false 就再也开不回来——表现就是「阈值调到最低也说不了话」。
   *   增益归零只影响这一路音频的样本，SDK 完全看不见，谁也不会覆盖谁。
   *
   * 分析器接在门限**之前**：门限关掉时麦克风照样在被分析，否则电平永远是 0，
   * 门限再也不会打开（自锁死）。输入音量也放在门限之前，所以音量调到 0 不会
   * 让门限失效，只是发出去的是静音。
   */
  VoiceTransportBase.prototype.buildAudioGraph = function () {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !this.micStream) return;
      this.audioCtx = new AC();
      var src = this.audioCtx.createMediaStreamSource(this.micStream);
      /* 高通滤波：切掉 90Hz 以下的低频（空调轰鸣、桌面震动、手持噪声、
         近讲效应造成的浑浊）。人声基频最低约 85Hz，切在这里不会伤到语音，
         但能明显减轻对方听到的「嗡嗡」底噪，也顺带减轻回声能量。 */
      this.hpf = this.audioCtx.createBiquadFilter();
      this.hpf.type = "highpass";
      this.hpf.frequency.value = 90;
      this.hpf.Q.value = 0.7;
      this.gain = this.audioCtx.createGain();
      this.gain.gain.value = this.inputVolume;
      this.gateGain = this.audioCtx.createGain();
      this.gateGain.gain.value = this.gateTarget();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      var dest = this.audioCtx.createMediaStreamDestination();
      src.connect(this.hpf);
      this.hpf.connect(this.gain);
      this.gain.connect(this.gateGain);
      this.gateGain.connect(dest);
      src.connect(this.analyser);   // 门限之前取样，永远能听到真实麦克风
      this.processedStream = dest.stream;
      if (this.audioCtx.state === "suspended") this.audioCtx.resume().catch(function () {});
    } catch (e) {
      console.warn("[voice] 音频处理不可用，回退原始麦克风", e);
      this.processedStream = null;
      this.gateGain = null;
      this.hpf = null;
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
    var speaking = false, quiet = 0, lastGate = null;
    this.vadTimer = setInterval(function () {
      if (!self.analyser) return;
      self.analyser.getByteTimeDomainData(buf);
      var sum = 0;
      for (var i = 0; i < buf.length; i++) { var v = (buf[i] - 128) / 128; sum += v * v; }
      var rms = Math.sqrt(sum / buf.length);
      /* 0~0.11 的 RMS 映射成 0~1，设置面板的电平条直接用这个值。
         上限取 0.11 是因为人声正常说话在 0.02~0.09 之间，留一点余量。 */
      self.level = Math.max(0, Math.min(1, rms / 0.11));
      self.emit("level", self.level);
      /* 连续没有输入信号 → 提示「麦克风没声音」。0.004 大约是数字静音 + 一点点
         底噪，正常麦克风就算不说话也会比这个高。 */
      if (rms < 0.004) self.silentMs += 90; else self.silentMs = 0;
      if (!self.micOn) {
        if (speaking) { speaking = false; self.emit("speaking", false); }
        if (self.gateOpen) self.applyGate(false);
        return;
      }
      var over = rms > self.gateThreshold;
      if (self.gateEnabled) {
        // 留 3 个采样周期（约 270ms）尾音：刚低于阈值就掐会把字尾吃掉
        if (over) { self.gateHold = 3; self.applyGate(true); }
        else if (self.gateHold > 0) self.gateHold--;
        else self.applyGate(false);
        if (lastGate !== self.gateOpen) { lastGate = self.gateOpen; self.emit("gate", self.gateOpen); }
      } else if (!self.gateOpen) {
        self.applyGate(true);
        if (lastGate !== self.gateOpen) { lastGate = self.gateOpen; self.emit("gate", self.gateOpen); }
      }
      var active = self.gateEnabled ? self.gateOpen : over;
      if (active) { quiet = 0; if (!speaking) { speaking = true; self.emit("speaking", true); } }
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
    // 「自动」码率按分辨率给基准值。以前一律回退到 4000 kbps，720p 用不完、
    // 1080p 又不够，band 窄时编码器只能丢帧，表现就是「画面几乎不动」。
    var autoKbps = height >= 2000 ? 9000
      : height >= 1400 ? 6000
      : height >= 1000 ? 4000
      : height >= 700 ? 2500 : 1200;
    var bitrate = Math.min(Number(req.bitrateKbps) || autoKbps,
      Number(s.maxBitrateKbps) || 8000);
    var opts = {
      video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps, max: fps } },
      audio: req.audio ? { suppressLocalAudioPlayback: true } : false
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
    this.shareParams = { width: width, height: height, fps: fps,
      bitrateKbps: bitrate, contentHint: req.contentHint, audio: !!req.audio, selectedResolution: Number(req.res) || Math.round(height) };
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
    /* track.enabled 只跟「静音按钮」走；门限静音交给 gateGain，两者互不覆盖。
       （以前门限也改 enabled，结果是按一次静音、或换一次设备就会卡在 false） */
    if (this.micStream) this.micStream.getAudioTracks().forEach(function (t) { t.enabled = this.micOn; }, this);
    if (this.processedStream) this.processedStream.getAudioTracks().forEach(function (t) { t.enabled = this.micOn; }, this);
    this.applyGate(this.gateEnabled ? this.gateOpen : true);
    this.room.setState({ mic: this.micOn });
  };

  /** 麦克风激活阈值。threshold 是 RMS 线性值（0.002~0.2）。 */
  VoiceTransportBase.prototype.setVoiceGate = function (cfg) {
    cfg = cfg || {};
    if (cfg.enabled !== undefined) this.gateEnabled = !!cfg.enabled;
    if (cfg.threshold !== undefined) {
      var t = Number(cfg.threshold);
      if (isFinite(t) && t > 0) this.gateThreshold = Math.max(0.002, Math.min(0.2, t));
    }
    if (!this.gateEnabled) this.applyGate(true);
    else this.applyGate(this.gateOpen);
  };

  /** 门限的目标增益：1 = 放行，0 = 静音。取消麦克风时一律 0。 */
  VoiceTransportBase.prototype.gateTarget = function () {
    if (!this.micOn) return 0;
    if (!this.gateEnabled) return 1;
    return this.gateOpen ? 1 : 0;
  };

  /** 把门限状态应用到音频图（没有 WebAudio 时退回 track.enabled）。 */
  VoiceTransportBase.prototype.applyGate = function (open) {
    open = !!open;
    this.gateOpen = open;
    var target = this.gateTarget();
    if (this.gateGain && this.audioCtx) {
      /* 自动播放策略可能把 AudioContext 挂在 suspended：这时推流是彻底静音的，
         看上去和「阈值卡住」一模一样。每次判定顺手唤醒一次，成本可忽略。 */
      if (this.audioCtx.state !== "running" && this.audioCtx.resume) {
        this.audioCtx.resume().catch(function () {});
      }
      try {
        var now = this.audioCtx.currentTime;
        var p = this.gateGain.gain;
        if (p.cancelScheduledValues) p.cancelScheduledValues(now);
        /* 30ms 斜坡：直接 0/1 跳变会在每个字头尾留「咔」声，坡太慢又会吃掉
           开头的音节，30ms 在听感上几乎无感。 */
        if (p.setTargetAtTime) {
          p.setTargetAtTime(target, now, 0.01);
          // setTargetAtTime 是渐近的，永远不会真的等于目标值；80ms 后钉死，
          // 免得关门时留一路 -40dB 的残余在传。
          if (p.setValueAtTime) p.setValueAtTime(target, now + 0.08);
        } else p.value = target;
      } catch (_) { this.gateGain.gain.value = target; }
      return;
    }
    // 没有音频图（WebAudio 不可用）时只能退回 enabled，此时门限与静音共用属性
    var live = target > 0;
    if (this.processedStream) this.processedStream.getAudioTracks().forEach(function (t) { t.enabled = live; });
    else if (this.micStream) this.micStream.getAudioTracks().forEach(function (t) { t.enabled = live; });
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
    var g = Number(v) / 100;
    if (!isFinite(g)) g = 1;
    this.memberVolumes[id] = Math.max(0, Math.min(2, g));
    var vol = this.memberVolumes[id];
    var e = this.elements[id];
    if (e && e.audio) setElementVolume(e.audio, vol);
    if (e && e.video) {
      setElementVolume(e.video, vol);
      var stage = document.getElementById("screen-video");
      if (stage && stage.srcObject === e.video.srcObject) setElementVolume(stage, vol);
    }
    // LiveKit 路径下共享画面挂在舞台元素上（box.screenEl），不是临时 video
    if (e && e.screenEl) setElementVolume(e.screenEl, vol);
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
      if (kind === "audio") { setElementVolume(el, this.memberVolumes[memberId] == null ? 1 : this.memberVolumes[memberId]); el.muted = this.deaf; }
      else {
        el.className = "remote-screen";
        el.muted = this.deaf;
        setElementVolume(el, this.memberVolumes[memberId] == null ? 1 : this.memberVolumes[memberId]);
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
      if (box[k]) { try { box[k].srcObject = null; dropElementVolume(box[k]); box[k].remove(); } catch (_) {} }
    });
    if (box.screenEl && box.screenEl.id !== "screen-video") dropElementVolume(box.screenEl);
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

  /** 汇总 PeerConnection 统计，并按采样差值计算实际码率。 */
  VoiceTransportBase.prototype.collectStats = async function (pcs) {
    // rttMs 不从信令 WebSocket 的 rtt 起算：那是「浏览器 → Worker」的控制通道，
    // 和媒体链路（浏览器 → 媒体服务器）完全是两回事，混用会把本地服务器的
    // 延迟也算成上百毫秒。下面只统计真正承载音视频的 PeerConnection。
    var agg = { rttMs: null, lossPct: null, bytesSent: 0, bytesRecv: 0,
      videoBytesSent: 0, videoBytesRecv: 0, jitterMs: null, sendKbps: null, recvKbps: null,
      videoSendKbps: null, videoRecvKbps: null, sendFps: null, recvFps: null };
    var received = 0, lost = 0, remoteReceived = 0, remoteLost = 0, remoteRtt = null;
    var videoFramesSent = 0, videoFramesRecv = 0, now = Date.now();
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
            if (s.kind === "video" || s.mediaType === "video") {
              agg.videoBytesRecv += Number(s.bytesReceived) || 0;
              videoFramesRecv += Number(s.framesDecoded) || 0;
            }
            if (s.type !== "remote-inbound-rtp") {
              received += Number(s.packetsReceived) || 0;
              lost += Number(s.packetsLost) || 0;
            }
            if (s.jitter != null) agg.jitterMs = agg.jitterMs == null ? s.jitter * 1000 : (agg.jitterMs + s.jitter * 1000) / 2;
          }
          if (s.type === "remote-inbound-rtp" && !s.isRemote) {
            remoteReceived += Number(s.packetsReceived) || 0;
            remoteLost += Number(s.packetsLost) || 0;
            if (s.roundTripTime != null) remoteRtt = s.roundTripTime * 1000;
          }
          if (s.type === "outbound-rtp" && !s.isRemote) {
            agg.bytesSent += Number(s.bytesSent) || 0;
            if (s.kind === "video" || s.mediaType === "video") {
              agg.videoBytesSent += Number(s.bytesSent) || 0;
              videoFramesSent += Number(s.framesEncoded) || 0;
            }
          }
        });
      } catch (_) {}
    }
    // RTT 取「浏览器 ↔ 媒体服务器」这条 candidate-pair 的真实往返，
    // 这才是用户体感上的延迟。remote-inbound-rtp 的 roundTripTime 是
    // 由对端统计、经 SFU 转发回来的，同一个值会偏大约一倍——以前优先用它，
    // 于是本地服务器也显示 100ms。现在只在拿不到 candidate-pair 时才回退。
    if (agg.rttMs == null && remoteRtt != null) agg.rttMs = remoteRtt;
    if (remoteReceived + remoteLost > 0) agg.lossPct = remoteLost / (remoteReceived + remoteLost) * 100;
    else if (received + lost > 0) agg.lossPct = lost / (received + lost) * 100;
    if (this.statsPrevious) {
      var seconds = (now - this.statsPrevious.at) / 1000;
      if (seconds > 0) {
        agg.sendKbps = Math.max(0, agg.bytesSent - this.statsPrevious.bytesSent) * 8 / seconds / 1000;
        agg.recvKbps = Math.max(0, agg.bytesRecv - this.statsPrevious.bytesRecv) * 8 / seconds / 1000;
        agg.videoSendKbps = Math.max(0, agg.videoBytesSent - this.statsPrevious.videoBytesSent) * 8 / seconds / 1000;
        agg.videoRecvKbps = Math.max(0, agg.videoBytesRecv - this.statsPrevious.videoBytesRecv) * 8 / seconds / 1000;
        if (this.statsPrevious.videoFramesSent != null && videoFramesSent >= this.statsPrevious.videoFramesSent) {
          agg.sendFps = (videoFramesSent - this.statsPrevious.videoFramesSent) / seconds;
        }
        if (this.statsPrevious.videoFramesRecv != null && videoFramesRecv >= this.statsPrevious.videoFramesRecv) {
          agg.recvFps = (videoFramesRecv - this.statsPrevious.videoFramesRecv) / seconds;
        }
      }
    }
    this.statsPrevious = { at: now, bytesSent: agg.bytesSent, bytesRecv: agg.bytesRecv,
      videoBytesSent: agg.videoBytesSent, videoBytesRecv: agg.videoBytesRecv,
      videoFramesSent: videoFramesSent, videoFramesRecv: videoFramesRecv };
    var self = this;
    Object.keys(this.statsHistory).forEach(function (key) {
      if (agg[key] == null || !Number.isFinite(agg[key])) return;
      var history = self.statsHistory[key];
      history.push(agg[key]);
      if (history.length > 3) history.shift();
      var sorted = history.slice().sort(function (a, b) { return a - b; });
      agg[key] = sorted[Math.floor(sorted.length / 2)];
    });
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
  function tuneSenderStrict(sender, params) {
    if (!sender || typeof sender.getParameters !== "function") return Promise.reject(new Error("发送端不支持画质调整"));
    var p = sender.getParameters();
    p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings.forEach(function (enc) {
      if (params.maxBitrate) enc.maxBitrate = params.maxBitrate;
      if (params.maxFramerate) enc.maxFramerate = params.maxFramerate;
      if (params.scale) enc.scaleResolutionDownBy = params.scale;
    });
    return sender.setParameters(p).then(function () {
      var actual = sender.getParameters().encodings || [];
      if (actual.length && params.scale && actual.some(function (enc) { return enc.scaleResolutionDownBy !== params.scale; })) {
        throw new Error("浏览器未应用画质参数");
      }
    });
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
    room.on("signal", function (m) {
      var data = m.data || {};
      if (data.kind === "quality") self.setScreenQuality(data.value);
    });
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
    this.micPublication = null;
    this.screenPublications = [];
    this.localScreenTrack = null;
    this.qualityPending = {};
    this.deviceChangeHandler = null;
  }
  LiveKitTransport.prototype = Object.create(VoiceTransportBase.prototype);
  LiveKitTransport.prototype.constructor = LiveKitTransport;
  LiveKitTransport.prototype.kind = "livekit";

  LiveKitTransport.prototype.loadSDK = function () {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = "/voice/vendor/livekit-client.umd.js?v=20261115a";
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
        var id = participant && participant.identity;
        var kind = track.kind === "video" ? "video" : "audio";
        if (!id || !track.attach) return;
        var box = self.elements[id] || {};
        if (kind === "video") {
          // 屏幕共享：直接把画面挂到页面上可见的舞台元素上。
          // 以前是先 track.attach() 造一个从未插入 DOM 的 <video>（0×0），
          // 再把 srcObject 复制给舞台。LiveKit 的 adaptiveStream 只按
          // 「真正渲染在页面上的元素尺寸」挑订阅档位，0×0 会被判定为不可见，
          // 订阅质量长期停在最低档甚至暂停接收——这正是「画面几乎不动」的根因。
          var stage = document.getElementById("screen-video");
          if (stage) {
            try { track.attach(stage); }
            catch (_) { stage.srcObject = new MediaStream([track.mediaStreamTrack]); }
            stage.muted = self.deaf;
            setElementVolume(stage, self.memberVolumes[id] == null ? 1 : self.memberVolumes[id]);
            stage.play().catch(function () {});
            box.screenEl = stage;
            box.screenTrack = track;
            self.elements[id] = box;
          }
          self.emit("track", { memberId: id, kind: kind });
          return;
        }
        var el = box.audio;
        if (!el) {
          el = track.attach();
          el.autoplay = true; el.playsInline = true;
          el.setAttribute("data-member", id);
          el.muted = self.deaf;
          setElementVolume(el, self.memberVolumes[id] == null ? 1 : self.memberVolumes[id]);
          if (self.sink) self.sink.appendChild(el);
          box.audio = el;
          self.elements[id] = box;
        } else {
          var stream = el.srcObject;
          if (stream && track.mediaStreamTrack && stream.getTracks().indexOf(track.mediaStreamTrack) < 0) stream.addTrack(track.mediaStreamTrack);
          else if (!stream) track.attach(el);
        }
        el.play().catch(function () {});
        self.emit("track", { memberId: id, kind: kind });
      });
      room.on(SDK.RoomEvent.TrackUnsubscribed, function (track, pub, participant) {
        var id = participant && participant.identity;
        var box = id && self.elements[id];
        if (!box) return;
        if (track.kind === "video") {
          if (box.screenTrack !== track) return;
          try { if (track.detach && box.screenEl) track.detach(box.screenEl); } catch (_) {}
          if (box.screenEl) { try { box.screenEl.srcObject = null; } catch (_) {} }
          delete box.screenTrack;
          delete box.screenEl;
          if (!box.audio) delete self.elements[id];
          return;
        }
        var el = box.audio;
        if (!el) return;
        try { if (track.detach) track.detach(el); } catch (_) {}
        try { el.srcObject = null; el.remove(); } catch (_) {}
        delete box.audio;
        if (!box.screenTrack) delete self.elements[id];
      });
      room.on(SDK.RoomEvent.ParticipantDisconnected, function (participant) {
        var id = participant && participant.identity;
        var box = id && self.elements[id];
        var stage = document.getElementById("screen-video");
        if (box && box.screenTrack) {
          try { if (box.screenTrack.detach && stage) box.screenTrack.detach(stage); } catch (_) {}
          if (stage) { try { stage.srcObject = null; } catch (_) {} }
        }
        self.detach(id);
      });
      room.on(SDK.RoomEvent.DataReceived, function (payload, participant) {
        var message;
        try { message = JSON.parse(new TextDecoder().decode(payload)); } catch (_) { return; }
        if (!message || !message.requestId) return;
        if (message.kind === "quality-result") {
          var pending = self.qualityPending[message.requestId];
          if (!pending) return;
          clearTimeout(pending.timer);
          delete self.qualityPending[message.requestId];
          pending.resolve(!!message.ok);
          return;
        }
        if (message.kind !== "quality") return;
        var scale = { auto: 1, "1080": 1, "720": 2, "360": 4 }[String(message.value)];
        var senders = self.getSendersBySource(SDK.Track && SDK.Track.Source && SDK.Track.Source.ScreenShare);
        if (scale == null || !senders.length) {
          self.sendQualityResult(participant, message.requestId, false);
          return;
        }
        Promise.all(senders.map(function (sender) {
          return tuneSenderStrict(sender, { scale: scale, maxBitrate: (self.shareParams && self.shareParams.bitrateKbps || 4000) * 1000,
            maxFramerate: self.shareParams && self.shareParams.fps || 30 });
        })).then(function () { self.sendQualityResult(participant, message.requestId, true); }, function () {
          self.sendQualityResult(participant, message.requestId, false);
        });
      });
      room.on(SDK.RoomEvent.Reconnecting, function () { self.emit("reconnecting"); });
      room.on(SDK.RoomEvent.Reconnected, function () { self.emit("reconnected"); });
      room.on(SDK.RoomEvent.Disconnected, function () { self.emit("disconnected"); });
    }
    try {
      await room.connect(this.join.selfHosted.url, this.join.selfHosted.token, { autoSubscribe: true });
    } catch (e) {
      throw new Error("无法连接自建服务器：请确认 LiveKit 已启动、wss 域名证书有效、令牌由 Worker 正确签发。" + (e && e.message ? "（" + e.message + "）" : ""));
    }
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      this.deviceChangeHandler = function () {
        if (!self.opts.deviceId || !navigator.mediaDevices.enumerateDevices) return;
        navigator.mediaDevices.enumerateDevices().then(function (devices) {
          var exists = devices.some(function (d) { return d.kind === "audioinput" && d.deviceId === self.opts.deviceId; });
          if (!exists && self.lkRoom) self.refreshAudio({ deviceId: "" }).catch(function (e) {
            self.emit("error", new Error("麦克风断开，切回系统默认失败：" + (e.message || "未知错误")));
          });
        }).catch(function () {});
      };
      navigator.mediaDevices.addEventListener("devicechange", this.deviceChangeHandler);
    }
    this.emit("connected", { mode: "livekit" });
  };
  LiveKitTransport.prototype.publishAudio = async function () {
    var track = await VoiceTransportBase.prototype.publishAudio.call(this);
    if (!track || !this.lkRoom || !this.lkRoom.localParticipant) return track;
    var source = this.lk && this.lk.Track && this.lk.Track.Source && this.lk.Track.Source.Microphone;
    if (!source) throw new Error("LiveKit 组件不支持麦克风轨道发布");
    var published = await this.lkRoom.localParticipant.publishTrack(track, {
      source: source, name: "microphone", stopLocalTrackOnUnpublish: false,
      audioPreset: { maxBitrate: (this.settings.audio.bitrateKbps || 48) * 1000 }
    });
    this.micPublication = { track: track, published: published };
    if (!this.micOn && published.mute) await published.mute();
    return track;
  };
  LiveKitTransport.prototype.setMic = function (on) {
    VoiceTransportBase.prototype.setMic.call(this, on);
    var pub = this.micPublication && this.micPublication.published;
    if (pub) {
      var p = on ? (pub.unmute && pub.unmute()) : (pub.mute && pub.mute());
      if (p && p.catch) p.catch(function () {});
      /* SDK 的 unmute() 会把 mediaStreamTrack.enabled 改回 true，
         这会把刚才关上的门限重新打开（表现为「安静时也一直发声音」）。
         等 unmute 落地后再按门限状态补一次。 */
      var self = this;
      var settle = function () { self.applyGate(self.gateEnabled ? self.gateOpen : true); };
      if (p && p.then) p.then(settle, settle); else settle();
    }
  };
  /**
   * 覆写基类 detach：LiveKit 的屏幕共享画面直接挂在页面里真实的
   * #screen-video 上，它不是本 transport 自己创建的临时元素，绝不能
   * remove()——否则整个共享舞台会从 DOM 中消失，之后谁也放不了共享。
   */
  LiveKitTransport.prototype.detach = function (memberId) {
    var box = this.elements[memberId];
    if (!box) return;
    if (box.screenTrack && box.screenEl) {
      try { if (box.screenTrack.detach) box.screenTrack.detach(box.screenEl); } catch (_) {}
      try { box.screenEl.srcObject = null; } catch (_) {}
    }
    if (box.audio) {
      try { box.audio.srcObject = null; box.audio.remove(); } catch (_) {}
    }
    delete this.elements[memberId];
  };
  LiveKitTransport.prototype.getSendersBySource = function (source) {
    var out = [], room = this.lkRoom;
    if (!room || !room.engine || !room.engine.pcManager || !room.engine.pcManager.publisher || !source) return out;
    var participant = room.localParticipant;
    if (!participant || !participant.trackPublications) return out;
    participant.trackPublications.forEach(function (pub) {
      if (pub.source === source && pub.track && pub.track.sender) out.push(pub.track.sender);
    });
    return out;
  };
  LiveKitTransport.prototype.sendQualityResult = function (participant, requestId, ok) {
    var sender = this.lkRoom && this.lkRoom.localParticipant;
    if (!sender || !sender.publishData) return;
    var data = new TextEncoder().encode(JSON.stringify({ kind: "quality-result", requestId: requestId, ok: !!ok }));
    sender.publishData(data, { reliable: true, destinationIdentities: participant ? [participant.identity] : [] }).catch(function () {});
  };
  LiveKitTransport.prototype.onScreenTrack = async function (track) {
    var participant = this.lkRoom && this.lkRoom.localParticipant;
    var source = this.lk && this.lk.Track && this.lk.Track.Source;
    if (!participant || !participant.publishTrack || !source || !source.ScreenShare) {
      throw new Error("当前 LiveKit 组件不支持屏幕共享");
    }
    // 注意：不要在这里再对 display track 调 applyConstraints()。
    // getDisplayMedia() 拿到的轨道对「再次改分辨率」非常敏感，Chrome 会
    // 重新协商采集参数，轻则掉到 1~2 fps，重则整条轨道冻住——这正是
    // 「屏幕共享几乎不动」的主要诱因。尺寸/帧率已在采集时用 constraints
    // 指定，这里只读取真实值回填，供 UI 显示。
    var settingsNow = track.getSettings ? track.getSettings() : {};
    var initialScale = { auto: 1, "1080": 1, "720": 2, "360": 4 }[String(this.currentScreenQuality || "auto")];
    // degradationPreference 决定「带宽不够时先牺牲谁」：
    //  · motion（游戏 / 视频）→ 保帧率，画面宁可糊也要动；
    //  · detail（代码 / 文档）→ balanced，让浏览器自己权衡。
    // 以前 detail 用 maintain-resolution，带宽一紧就疯狂丢帧，
    // 屏幕上就是「一帧能停好几秒」，这是卡顿感的主要来源。
    var degradation = this.shareParams.contentHint === "detail" ? "balanced" : "maintain-framerate";
    var encoding = {
      maxBitrate: (this.shareParams.bitrateKbps || 2500) * 1000,
      maxFramerate: this.shareParams.fps || 30
    };
    var params = {
      source: source.ScreenShare, name: "screen", stopLocalTrackOnUnpublish: false,
      // 新版 SDK 认 videoEncoding，老版认 screenShareEncoding，两个都给，兼容任意版本。
      videoEncoding: encoding, screenShareEncoding: encoding,
      // 屏幕共享不开 simulcast：多档只会让上行更紧张，观众端也用不上。
      simulcast: false,
      degradationPreference: degradation
    };
    var published = await participant.publishTrack(track, params);
    this.localScreenTrack = track;
    this.screenPublications = [{ track: track, published: published }];
    try {
      var audioTracks = this.screenStream ? this.screenStream.getAudioTracks() : [];
      if (this.shareParams.audio && audioTracks.length && source.ScreenShareAudio) {
        var audioPub = await participant.publishTrack(audioTracks[0], {
          source: source.ScreenShareAudio, name: "screen-audio", stopLocalTrackOnUnpublish: false
        });
        this.screenPublications.push({ track: audioTracks[0], published: audioPub });
      }
      var sender = published && published.track && published.track.sender;
      await tuneSender(sender, { maxBitrate: encoding.maxBitrate,
        maxFramerate: encoding.maxFramerate, scale: initialScale,
        degradationPreference: degradation });
      var actual = settingsNow || {};
      this.shareParams.width = actual.width || this.shareParams.width;
      this.shareParams.height = actual.height || this.shareParams.height;
      this.shareParams.fps = actual.frameRate || this.shareParams.fps;
      if (sender && sender.getParameters) {
        var encoding = sender.getParameters().encodings && sender.getParameters().encodings[0];
        if (encoding && encoding.maxBitrate) this.shareParams.bitrateKbps = Math.round(encoding.maxBitrate / 1000);
        if (encoding && encoding.maxFramerate) this.shareParams.fps = encoding.maxFramerate;
      }
      this.emit("screenStarted", this.shareParams);
    } catch (e) {
      for (var i = this.screenPublications.length - 1; i >= 0; i--) {
        try { await participant.unpublishTrack(this.screenPublications[i].track, false); } catch (_) {}
      }
      this.screenPublications = [];
      this.localScreenTrack = null;
      throw e;
    }
  };
  LiveKitTransport.prototype.onScreenStopped = async function () {
    var participant = this.lkRoom && this.lkRoom.localParticipant;
    var publications = this.screenPublications.slice();
    this.screenPublications = [];
    this.localScreenTrack = null;
    if (participant && participant.unpublishTrack) {
      for (var i = 0; i < publications.length; i++) {
        try { await participant.unpublishTrack(publications[i].track, false); } catch (_) {}
      }
    }
  };
  LiveKitTransport.prototype.setScreenQuality = function (value) {
    var scale = VoiceTransportBase.prototype.setScreenQuality.call(this, value);
    var self = this;
    this.currentScreenQuality = String(value);
    this.currentScreenScale = scale;
    this.screenPublications.forEach(function (pub) {
      if (pub.track && pub.track.kind === "video") tuneSender(pub.published && pub.published.track && pub.published.track.sender, {
        scale: scale, maxFramerate: self.shareParams && self.shareParams.fps || 30,
        maxBitrate: (self.shareParams && self.shareParams.bitrateKbps || 4000) * 1000
      });
    });
    return scale;
  };
  LiveKitTransport.prototype.requestScreenQuality = function (value) {
    var self = this, sender = this.lkRoom && this.lkRoom.localParticipant;
    if (!sender || !sender.publishData || !this.sharerIdentity || this.sharerIdentity === (this.opts.me && this.opts.me.id)) {
      return Promise.resolve(false);
    }
    var requestId = String(Date.now()) + "-" + Math.random().toString(36).slice(2);
    return new Promise(function (resolve) {
      var timer = setTimeout(function () { delete self.qualityPending[requestId]; resolve(false); }, 3000);
      self.qualityPending[requestId] = { resolve: resolve, timer: timer };
      var data = new TextEncoder().encode(JSON.stringify({ kind: "quality", requestId: requestId, value: String(value) }));
      sender.publishData(data, { reliable: true, destinationIdentities: [self.sharerIdentity] }).catch(function () {
        clearTimeout(timer); delete self.qualityPending[requestId]; resolve(false);
      });
    });
  };
  LiveKitTransport.prototype.onAudioTrackReplaced = async function (oldTrack, newTrack) {
    var participant = this.lkRoom && this.lkRoom.localParticipant;
    var oldPub = this.micPublication && this.micPublication.published;
    if (!participant || !participant.publishTrack || !newTrack) return;
    var source = this.lk && this.lk.Track && this.lk.Track.Source && this.lk.Track.Source.Microphone;
    var oldLocalTrack = oldPub && oldPub.track;
    if (oldLocalTrack && participant.unpublishTrack) await participant.unpublishTrack(oldLocalTrack, false);
    try {
      var published = await participant.publishTrack(newTrack, {
        source: source, name: "microphone", stopLocalTrackOnUnpublish: false,
        audioPreset: { maxBitrate: (this.settings.audio.bitrateKbps || 48) * 1000 }
      });
      this.micPublication = { track: newTrack, published: published };
      if (!this.micOn && published.mute) await published.mute();
    } catch (e) {
      if (oldLocalTrack) {
        try {
          var restored = await participant.publishTrack(oldLocalTrack, {
            source: source, name: "microphone", stopLocalTrackOnUnpublish: false,
            audioPreset: { maxBitrate: (this.settings.audio.bitrateKbps || 48) * 1000 }
          });
          this.micPublication = { track: oldTrack, published: restored };
          if (!this.micOn && restored.mute) await restored.mute();
        } catch (restoreError) { console.warn("[voice] 恢复旧麦克风轨道失败", restoreError); }
      }
      throw e;
    }
  };
  LiveKitTransport.prototype.refreshAudio = async function (opts) {
    var requestedDevice = opts && Object.prototype.hasOwnProperty.call(opts, "deviceId") ? opts.deviceId : this.opts.deviceId;
    if (opts) for (var k in opts) this.opts[k] = opts[k];
    var stream, micFallback = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(), video: false });
    } catch (e) {
      if (!(e && (e.name === "OverconstrainedError" || e.name === "NotFoundError" || e.name === "DevicesNotFoundError") && this.opts.deviceId)) throw e;
      this.opts.deviceId = "";
      stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(), video: false });
      micFallback = !!requestedDevice;
    }
    var old = {
      micStream: this.micStream, processedStream: this.processedStream, audioCtx: this.audioCtx,
      gain: this.gain, gateGain: this.gateGain, hpf: this.hpf, analyser: this.analyser, micPublication: this.micPublication
    };
    clearInterval(this.vadTimer);
    this.micStream = stream; this.processedStream = null; this.audioCtx = null;
    this.gain = null; this.gateGain = null; this.hpf = null; this.analyser = null;
    this.gateOpen = true; this.gateHold = 0; this.silentMs = 0;
    this.buildAudioGraph();
    this.setInputVolume(this.inputVolume * 100);
    var fresh = this.localAudioTrack();
    try {
      await this.onAudioTrackReplaced(old.micStream && old.micStream.getAudioTracks()[0], fresh);
    } catch (e) {
      stream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
      if (this.audioCtx) { try { await this.audioCtx.close(); } catch (_) {} }
      this.micStream = old.micStream; this.processedStream = old.processedStream;
      this.audioCtx = old.audioCtx; this.gain = old.gain; this.analyser = old.analyser;
      this.micPublication = old.micPublication;
      this.opts.deviceId = requestedDevice || "";
      this.startVAD();
      throw e;
    }
    if (old.micStream) old.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
    if (old.processedStream && old.processedStream !== old.micStream) old.processedStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
    if (old.audioCtx) { try { await old.audioCtx.close(); } catch (_) {} }
    this.startVAD();
    this.applyGate(true);
    if (micFallback) this.emit("micFallback");
    return fresh;
  };
  LiveKitTransport.prototype.onSettingsChanged = function (settings) {
    var self = this;
    try {
      if (this.lkRoom && this.lkRoom.localParticipant && this.lkRoom.localParticipant.setAudioBitrate) {
        this.lkRoom.localParticipant.setAudioBitrate((settings.audio.bitrateKbps || 48) * 1000);
      }
    } catch (_) {}
    if (this.micPublication && this.micPublication.published && this.micPublication.published.track) {
      tuneSender(this.micPublication.published.track.sender, { maxBitrate: (settings.audio.bitrateKbps || 48) * 1000 });
    }
    this.screenPublications.forEach(function (pub) {
      if (pub.track && pub.track.kind === "video") tuneSender(pub.published && pub.published.track && pub.published.track.sender, {
        maxBitrate: Math.min((self.shareParams && self.shareParams.bitrateKbps || 4000) * 1000,
          (settings.screen.maxBitrateKbps || 4000) * 1000),
        maxFramerate: Math.min(self.shareParams && self.shareParams.fps || 30, settings.screen.maxFps || 30)
      });
    });
  };
  LiveKitTransport.prototype.getStats = function () {
    var room = this.lkRoom, pcManager = room && room.engine && room.engine.pcManager;
    var pcs = [];
    if (pcManager) {
      [pcManager.publisher && pcManager.publisher.pc, pcManager.subscriber && pcManager.subscriber.pc,
        pcManager.publisher, pcManager.subscriber].forEach(function (pc) {
        if (pc && typeof pc.getStats === "function" && pcs.indexOf(pc) < 0) pcs.push(pc);
      });
    }
    if (!pcs.length) return Promise.resolve({ rttMs: this.roomRtt(), lossPct: null, bytesSent: null, bytesRecv: null, jitterMs: null });
    return this.collectStats(pcs);
  };
  LiveKitTransport.prototype.disconnect = async function () {
    Object.keys(this.qualityPending).forEach(function (id) {
      clearTimeout(this.qualityPending[id].timer);
      this.qualityPending[id].resolve(false);
    }, this);
    this.qualityPending = {};
    if (this.deviceChangeHandler && navigator.mediaDevices && navigator.mediaDevices.removeEventListener) {
      navigator.mediaDevices.removeEventListener("devicechange", this.deviceChangeHandler);
      this.deviceChangeHandler = null;
    }
    if (this.lkRoom) { try { await this.lkRoom.disconnect(); } catch (_) {} }
    this.micPublication = null;
    this.screenPublications = [];
    this.localScreenTrack = null;
    await VoiceTransportBase.prototype.disposeAudio.call(this);
  };

  /* ── 运行时更换麦克风 / 音频处理（设置抽屉实时生效） ───────── */
  VoiceTransportBase.prototype.refreshAudio = async function (opts) {
    if (opts) for (var k in opts) this.opts[k] = opts[k];
    var old = this.localAudioTrack();
    clearInterval(this.vadTimer);
    if (this.micStream) this.micStream.getTracks().forEach(function (t) { try { t.stop(); } catch (_) {} });
    this.micStream = null; this.processedStream = null;
    this.analyser = null; this.gain = null; this.gateGain = null; this.hpf = null;
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
    this.gain = null;
    this.gateGain = null;
    this.hpf = null;
    this.analyser = null;
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
