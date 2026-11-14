/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— Durable Object：房间信令 / 成员状态 / 设置实时下发
 *
 *  架构约束（2026-11-14 用户追加）：
 *    生产后端只有 Cloudflare Worker。本 DO 就是 Worker 的一部分，
 *    用户电脑不需要跑任何常驻服务；浏览器只连 wss 到这个 DO。
 *
 *  用 WebSocket Hibernation API：
 *    state.acceptWebSocket(ws) + ws.serializeAttachment(member)
 *    成员状态挂在连接附件上，DO 被休眠唤醒后无需重建内存表也能恢复。
 *
 *  同一个类同时被本地开发测试台（tools/dev/voice-dev-server.mjs）复用：
 *    那里用 ws 包包一层 NodeWebSocket 提供同名方法，
 *    于是本地与线上跑的是完全相同的房间逻辑。
 * ══════════════════════════════════════════════════════════════ */

import * as C from "./voice-core.js";

const STATE_FIELDS = ["mic", "deaf", "speaking", "sharing", "quality", "ptt"];

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function channelOf(request) {
  const u = new URL(request.url);
  const m = u.pathname.match(/\/rooms\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : (u.searchParams.get("channel") || "");
}

export class VoiceRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /* ── Cloudflare 入口：WebSocket 升级 / 内部 HTTP ─────────────── */
  async fetch(request) {
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      // Hibernation：必须先 accept，之后的 async 校验不会让连接断掉
      this.state.acceptWebSocket(server);
      const url = new URL(request.url);
      const channel = url.searchParams.get("channel") || channelOf(request);
      const ticket = await C.verifyRoomTicket(this.env, url.searchParams.get("ticket"), channel);
      if (!ticket) {
        try { server.close(4401, "房间票据无效或已过期"); } catch (_) {}
        return new Response(null, { status: 401 });
      }
      this.attach(server, ticket, channel);
      return new Response(null, { status: 101, webSocket: client });
    }
    return await this.http(request);
  }

  /* ── 连接附着（线上 / 本地共用） ───────────────────────────── */
  attach(ws, ticket, channel) {
    const member = {
      id: ticket.u,
      name: ticket.n || "成员",
      color: ticket.color || C.avatarColorFor(ticket.u),
      avatarUrl: ticket.avatarUrl || null,
      role: ticket.r || "user",
      mic: true, deaf: false, speaking: false, sharing: false,
      quality: "", publications: [],
      channel: channel,
      joinedAt: Date.now()
    };
    ws.serializeAttachment(member);
    this.send(ws, {
      t: "hello", self: member, members: this.members(),
      settings: this.settings, revision: this.revision || 1,
      channel: channel, serverTime: Date.now()
    });
    this.broadcastMembers();
    this.broadcast({ t: "notice", text: member.name + " 加入了频道" }, ws);
  }

  /* ── WebSocket Hibernation 回调 ────────────────────────────── */
  async webSocketMessage(ws, message) { this.onMessage(ws, String(message || "")); }
  async webSocketClose(ws) { this.onClose(ws); }
  async webSocketError(ws) { this.onClose(ws); }

  /** 本地测试台也会直接调用这个方法（ws 包没有 Hibernation 回调）。 */
  onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg.t !== "string") return;
    const me = this.attachment(ws);
    if (!me) return;

    switch (msg.t) {
      case "state": {
        const patch = {};
        STATE_FIELDS.forEach(function (k) {
          if (msg[k] !== undefined) patch[k] = !!msg[k];
        });
        if (msg.quality !== undefined) patch.quality = String(msg.quality).slice(0, 40);
        Object.assign(me, patch);
        ws.serializeAttachment(me);
        this.broadcastMembers();
        return;
      }
      case "pub": {
        const list = Array.isArray(msg.tracks) ? msg.tracks.slice(0, 8) : [];
        me.publications = list.map(function (x) {
          return {
            sessionId: String(x.sessionId || "").slice(0, 80),
            trackName: String(x.trackName || "").slice(0, 40),
            kind: x.kind === "video" ? "video" : "audio"
          };
        }).filter(function (x) { return x.sessionId && x.trackName; });
        me.sharing = me.publications.some(function (x) { return x.kind === "video"; });
        ws.serializeAttachment(me);
        this.broadcastMembers();
        return;
      }
      case "signal": {
        // 本地 Mesh 传输的 SDP / ICE 中继：只转发给指定成员，不广播
        const target = this.find(String(msg.to || ""));
        if (target) this.send(target, { t: "signal", from: me.id, data: msg.data });
        return;
      }
      case "ping":
        this.send(ws, { t: "pong", ts: msg.ts || 0, serverTime: Date.now() });
        return;
      case "kick": {
        if (me.role !== "admin") { this.send(ws, { t: "error", text: "只有管理员可以踢出成员" }); return; }
        this.kick(String(msg.userId || ""), "管理员将你移出了频道", ws);
        return;
      }
      case "mute": {
        if (me.role !== "admin") { this.send(ws, { t: "error", text: "只有管理员可以禁言成员" }); return; }
        const t = this.find(String(msg.userId || ""));
        if (!t) return;
        const tm = this.attachment(t);
        tm.mic = false;
        t.serializeAttachment(tm);
        this.send(t, { t: "forcedMute", muted: true, by: me.name });
        this.broadcastMembers();
        return;
      }
      default:
        return;
    }
  }

  onClose(ws) {
    const me = this.attachment(ws);
    try { ws.serializeAttachment(null); } catch (_) {}
    if (!me) return;
    this.broadcast({ t: "notice", text: me.name + " 离开了频道" });
    this.broadcastMembers();
  }

  /* ── 成员 / 广播 ───────────────────────────────────────────── */
  attachment(ws) {
    try { return ws.deserializeAttachment() || null; } catch (_) { return null; }
  }
  sockets() {
    try { return this.state.getWebSockets() || []; } catch (_) { return []; }
  }
  members() {
    const out = [];
    const self = this;
    this.sockets().forEach(function (ws) {
      const m = self.attachment(ws);
      if (m && m.id) {
        out.push({
          id: m.id, name: m.name, color: m.color, avatarUrl: m.avatarUrl,
          role: m.role, mic: m.mic, deaf: m.deaf, speaking: m.speaking,
          sharing: m.sharing, quality: m.quality,
          publications: m.publications || [], joinedAt: m.joinedAt
        });
      }
    });
    // 稳定排序，避免每次广播顺序跳动导致前端重复渲染
    out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return out;
  }
  find(userId) {
    const list = this.sockets();
    for (let i = 0; i < list.length; i++) {
      const m = this.attachment(list[i]);
      if (m && m.id === userId) return list[i];
    }
    return null;
  }
  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
  broadcast(obj, except) {
    const text = JSON.stringify(obj);
    this.sockets().forEach(function (ws) {
      if (ws === except) return;
      try { ws.send(text); } catch (_) {}
    });
  }
  broadcastMembers() {
    const members = this.members();
    this.broadcast({ t: "members", members: members, count: members.length, serverTime: Date.now() });
  }
  kick(userId, reason, byWs) {
    const target = this.find(userId);
    if (!target) return false;
    this.send(target, { t: "kicked", reason: reason || "你已被移出频道" });
    try { target.close(4403, reason || "kicked"); } catch (_) {}
    this.onClose(target);
    if (byWs) this.send(byWs, { t: "notice", text: "已移出该成员" });
    return true;
  }

  /* ── 内部 HTTP（只由 Worker 通过 DO binding 调用） ─────────── */
  async http(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const p = url.pathname.replace(/\/+$/, "");

    if (p.endsWith("/state") && method === "GET") {
      return json({
        ok: true, channel: channelOf(request),
        members: this.members(), count: this.members().length,
        settings: this.settings || null, revision: this.revision || 1
      });
    }
    if (p.endsWith("/settings") && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      this.settings = body.settings || null;
      this.revision = Number(body.revision) || (this.revision || 1) + 1;
      this.broadcast({ t: "settings", settings: this.settings, revision: this.revision, serverTime: Date.now() });
      return json({ ok: true, revision: this.revision });
    }
    if (p.endsWith("/kick") && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      return json({ ok: this.kick(String(body.userId || ""), body.reason || "管理员将你移出了频道") });
    }
    if (p.endsWith("/mute") && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      const target = this.find(String(body.userId || ""));
      if (target) {
        const m = this.attachment(target);
        m.mic = false;
        target.serializeAttachment(m);
        this.send(target, { t: "forcedMute", muted: true, by: "管理员" });
        this.broadcastMembers();
      }
      return json({ ok: !!target });
    }
    if (p.endsWith("/notice") && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (_) {}
      this.broadcast({ t: "notice", text: String(body.text || "").slice(0, 200) });
      return json({ ok: true });
    }
    if (p.endsWith("/close") && method === "POST") {
      this.broadcast({ t: "kicked", reason: "该频道已被删除" });
      this.sockets().forEach(function (ws) {
        try { ws.close(4404, "channel deleted"); } catch (_) {}
      });
      return json({ ok: true });
    }
    return json({ ok: false, error: "DO 内部接口不存在" }, 404);
  }
}
