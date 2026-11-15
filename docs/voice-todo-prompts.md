# ZF语音 · 未完成功能开发提示词集

> 生成时间：2026-11-15 01:05
> **复核时间：2026-11-15 02:15**（`voice/transport.js`、`voice/voice.js` 在 02:05 / 02:11 被大幅改写过，
> 下表「状态」列已按**当前磁盘代码**重新校准。任务 1~7、9~12 均已实现并从待办中划掉，仅任务 8 仍未完成。）
> 依据：对 `voice/`、`src/` 逐文件核对后得出的**代码级事实**（不是推测），每条都标注了文件:行号。
> 用法：把「## 任务 N」下面的整段提示词复制给 AI 编码助手即可，每条都是自包含的。

---

## 总览

| # | 功能 | 状态（02:15 复核） | 影响面 | 优先级 |
|---|---|---|---|---|
| 1 | 「静音全部 / 戴耳机」在自建频道 | ✅ 已实现（`TrackSubscribed` 登记 `this.elements`，transport.js:922-940） | 自建频道 | P0 |
| 2 | 成员单独音量在自建频道 | ✅ 已实现（同上登记 + 订阅时按 `memberVolumes` 初始化） | 自建频道 | P0 |
| 3 | 输入音量 / 降噪 / 回声 / 增益在自建频道 | ✅ 已实现（改为自行 `publishTrack` 发布 processedStream，transport.js:1018-1030） | 自建频道 | P0 |
| 4 | 切换麦克风设备在自建频道 | ✅ 已实现（`refreshAudio` 重采 + `onAudioTrackReplaced` 换轨，含设备拔出回退） | 自建频道 | P0 |
| 5 | 「观看画质」切换 | ✅ 已实现（DataChannel `quality` / `quality-result` 双向确认，transport.js:971-996） | 全链路 | P0 |
| 6 | 屏幕共享弹两次选择框 | ✅ 已实现（不再调 `setScreenShareEnabled`，改 `publishTrack`） | 自建频道 | P0 |
| 7 | 连接质量真实统计 | ✅ 已实现（`lossPct` 由 `remote-inbound-rtp` 计算，transport.js:417-445） | 自建频道 | P1 |
| 8 | **断线不会自动重连** | ❌ **仍未实现**——全文无 `RoomEvent.Reconnecting` / `Reconnected` 处理 | 全链路 | P1 |
| 9 | 频道内文字聊天 | ✅ 已实现（`state.chatMessages` + 渲染，voice.js:71/290-296） | 全站语音 | P1 |
| 10 | 私有频道编辑 / 删除 | ✅ 已实现（`PATCH/DELETE` owned channel，voice-realtime.js:399-414） | 全站语音 | P1 |
| 11 | 修改密码 / 资料 / 头像 | ✅ 已实现（`PATCH /api/voice/me`、`POST /api/voice/password`） | 账号 | P2 |
| 12 | 共享占位文案「等待画面…」 | ✅ 已实现（voice.js:271 起按状态更新 `#screen-sub`） | UI 细节 | P2 |

> 结论：**当前只剩任务 8（LiveKit 断线自动重连）未做。** 其余各节的提示词保留作历史记录与回归参考，
> 不要重复开发；如需验证，请按各节「验收标准」逐条走。

---

## 通用约束（每个任务都适用，可随提示词一起粘贴）

```
项目：D:\ZFSNwebsite（Cloudflare Worker + Workers Assets + D1 + Durable Object 的语音站）
涉及目录：voice/（前端，原生 JS 无构建）、src/（Worker 与 DO）、tools/livekit/（本机 LiveKit 媒体服务）

硬性要求：
1. 纯原生 JS，不要引入打包工具、不要加 npm 前端依赖（LiveKit SDK 已 vendored 在 voice/vendor/）。
2. 不破坏现有三种链路：mesh（本地直连）、cloudflare（SFU）、livekit（自建）。任何改动必须在 MeshTransport
   和 CloudflareTransport 上不回归；LiveKit 是新增/修复重点。
3. 改完 voice/*.js 或 voice/*.css 必须同步提升 voice/index.html 里对应的 ?v=YYYYMMDDx 版本号，
   否则浏览器缓存会导致「改了没生效」。
4. 修改后必须执行：node --check <改动的每个 js>，以及 npm run voice:test:all（6 套，应全绿）。
5. 中文注释与中文提示语，风格与现有代码一致（var/function 为主，不用可选链与箭头函数以免破坏老浏览器兼容）。
6. 只改必要文件，不要顺手重构、不要格式化整个文件、不要动 tools/livekit 的进程管理逻辑。
```

---

## 任务 1 · 修复「静音全部」在自建频道失效

**P0 · `voice/transport.js`**

```
背景（已核实的代码事实）：
- 基类 VoiceTransportBase 用 this.elements[memberId] = {audio, video} 记录每个远端成员的媒体元素，
  静音全部 setDeaf() 的实现（transport.js:332-343）是遍历 this.elements 把 audio/video 置 muted。
- 但 LiveKit 链路不使用基类 attach()：LiveKitTransport.connect() 里的 TrackSubscribed
  （transport.js:852-861）直接 var el = track.attach()，然后 el.muted = self.deaf，再 appendChild 到
  this.sink —— 从来没有写进 this.elements。
- 后果：自建频道里点「静音全部（耳机）」按钮，已经在播的远端音频元素不会被 mute（只有 screen-video 被 mute），
  按钮看起来点了、实际没静音。这就是本次要修的 bug。

目标：
让「静音全部 / 取消静音」在 livekit 链路与 mesh / cloudflare 表现一致，并且后加入的成员也要继承当前 deaf 状态。

实现要求：
1. LiveKitTransport 在 TrackSubscribed 里把创建的 audio/video 元素登记进 this.elements[identity]
   （结构 {audio, video}），不要重复创建；同一成员的多条轨道要合并到同一个 box。
2. 视频轨道（屏幕共享）要继续走 #screen-video 的 srcObject 逻辑，同时也要登记，避免两套逻辑打架。
3. 覆盖 setDeaf：LiveKitTransport 需要让 this.elements 里的元素与 #screen-video 一起 muted；
   若基类实现已按 this.elements 遍历，则只需保证登记完整，不要重复写一份逻辑。
4. 成员离开时（RoomEvent.ParticipantDisconnected）要清理 this.elements 对应项并 remove 元素，
   避免元素泄漏导致「静音全部」作用于已离开的人。

验收标准：
- 自建频道里 A 说话，B 点「静音全部」→ B 立刻听不到 A；再点一次恢复。
- B 处于「静音全部」状态时，C 后加入并说话 → B 仍听不到（新成员继承 deaf）。
- A 离开频道后，B 的 #media-sink 里不残留 A 的 <audio> 元素。
- mesh 与 cloudflare 链路的静音行为不变；npm run voice:test:all 全绿。
```

---

## 任务 2 · 修复「成员单独音量」在自建频道失效

**P0 · `voice/transport.js`**

```
背景（已核实的代码事实）：
- 成员列表每行有一个音量滑块（voice/voice.js:215-216，data-vol=成员id），
  input 时调用 transport.setMemberVolume(id, 0~200)。
- 基类 setMemberVolume（transport.js:348-353）靠 this.elements[id].audio/video 改 volume。
- LiveKit 链路没有把元素登记到 this.elements（见任务 1），所以该滑块在自建频道是完全无效的，
  但 UI 仍会显示 0~200% 的相对值，属于「假控件」。

目标：
自建频道里拖动某个成员的音量滑块，能真实改变该成员的声音大小，并且刷新后按 localStorage 或
内存状态保持（不要跨会话持久化，与原设计一致）。

实现要求：
1. 依赖任务 1 的元素登记；若无登记则先补齐（同一 box 结构）。
2. 确保 setMemberVolume 对 LiveKit 的 audio 元素生效，并且对后续新订阅的轨道生效
   （订阅时用 memberVolumes[id] ?? 1 初始化，这一点基类 attach 已有先例，LiveKit 分支要照做）。
3. 滑块没动过的成员，音量必须是 1，不要因为 undefined 变成 0 或 NaN。

验收标准：
- 自建频道两人通话，把自己的音量滑块拖到 0 → 对方声音消失；拖到 200 → 明显变响。
- 该成员的画面（屏幕共享）音量也同步变化（现有 UI 两个都用同一个 setMemberVolume）。
- 新加入的成员默认 100%，不受上一个成员滑块残留影响。
```

---

## 任务 3 · 让「输入音量 / 降噪 / 回声消除 / 自动增益」在自建频道真正生效

**P0 · `voice/transport.js`**

```
背景（已核实的代码事实）：
- 基类 publishAudio（transport.js:214-234）用 getUserMedia 拿麦克风，然后 buildAudioGraph()
  （236-256）建了一条 AudioContext 处理链：micStream → gain → analyser → MediaStreamDestination，
  产出 this.processedStream；localAudioTrack() 返回 processedStream 的音轨。
- mesh 与 cloudflare 发布的就是这条 processedStream 的音轨，所以「输入音量增益」对它们是有效的。
- LiveKitTransport.publishAudio（transport.js:872-879）虽然调用了基类 publishAudio 建立处理链，
  但紧接着调的是 this.lkRoom.localParticipant.setMicrophoneEnabled(micOn) ——
  这会让 LiveKit SDK 自己再 getUserMedia 一次并使用它自己的音轨，
  也就是 our processedStream 根本没被发布出去。

后果（用户可感知）：
1. 设置里「输入音量」滑块在自建频道拖动无效（听感不变）。
2. 设置里「降噪 / 回声消除 / 自动增益」三个开关，虽然会触发 reacquireMic → refreshAudio 重新采集，
   但重新采集出的处理链同样没发布，所以对自建频道也是无效的。
（注意：浏览器原生 echoCancellation/noiseSuppression 约束对 LiveKit 自采的那路是生效的，
  但「切换开关」这个动作在自建频道不会真正改变已被 LiveKit 持有的那路音轨。）

目标：
自建频道里，输入音量与三项音频处理开关必须和 mesh 一致地真实生效；切换后无需重连频道。

实现要求：
1. 改为「自己采集 + 自己发布」：用 VoiceTransportBase 的 processedStream 音轨，
   通过 localParticipant.publishTrack(track, { source: Track.Source.Microphone, ... }) 发布，
   而不是 setMicrophoneEnabled(true) 让 SDK 再采一次。
   注意 LiveKit 要求同一个 mic 源只有一条轨，切换时要先 unpublishTrack 旧的再发布新的。
2. 保留 setMicrophoneEnabled(false) 或 track.mute() 语义用于静音（setMic 已有调用，别让它和
   publishTrack 版本打架；建议统一用「发布一条 track + 用 track.mute()/unmute() 控制」）。
3. refreshAudio（transport.js:921-932）在 LiveKit 下必须真正替换远端听到的音轨：
   实现 LiveKitTransport.onAudioTrackReplaced（当前是 transport.js:986 的空函数 Promise.resolve()），
   用 unpublishTrack(old) + publishTrack(new) 完成替换，失败时回滚并把旧轨恢复发布。
4. 音频处理链的 gain 要在 buildAudioGraph 时用当前 inputVolume 初始化（已有），
   refreshAudio 之后要重新应用 setInputVolume 的当前值，避免「切一次设备音量回 100%」。
5. 如果浏览器不支持 AudioContext，必须优雅降级为原始 micStream（现有 buildAudioGraph 已有 try/catch，
   保持这个降级路径可用）。

验收标准：
- 自建频道里把输入音量从 100% 调到 20%，对方听到的声音明显变小；调到 200% 明显变大，无需重连。
- 关掉「降噪」，对方能听到环境噪声；开回来噪声明显减少（用同一麦克风对比）。
- 切换麦克风设备（另一个物理麦克风）后，对方立刻听到新设备的声音，且不需要重新加入频道。
- 静音按钮仍然有效（静音后对方完全听不到，且成员列表显示「静音」）。
- mesh / cloudflare 链路的采集行为不变。
```

---

## 任务 4 · 修复「切换麦克风设备」在自建频道失效

**P0 · `voice/transport.js`**

```
背景（已核实的代码事实）：
- 设置抽屉里「输入设备」下拉（voice/index.html:368，id=set-in）change 时写 localStorage 并调用
  reacquireMic()（voice/voice.js:808-810）。
- reacquireMic → transport.refreshAudio({ deviceId })（voice.js:592-604）。
- refreshAudio 会重新 getUserMedia（audioConstraints 里带 deviceId:{exact}，见 transport.js:209），
  但 LiveKit 侧的音轨是 SDK 自己采的（见任务 3），所以换设备对自建频道毫无效果。

目标：
自建频道里换麦克风设备后，对方立刻听到新设备。

实现要求：
1. 与任务 3 合并实现：先让自建频道发布我们自己采集的音轨（processedStream），
   这样 deviceId 通过 getUserMedia 的约束自然生效，refreshAudio 再走 onAudioTrackReplaced 替换即可。
2. 若设备 deviceId 失效（设备被拔掉），getUserMedia 会抛 OverconstrainedError：
   捕获后自动回退到 default 设备并在 toast 里提示「原麦克风已断开，已切回系统默认」。
3. localStorage 里 zf_voice_mic 记录失效设备时，打开设置抽屉要把下拉框重置为「系统默认」。

验收标准：
- 自建频道中，两人通话，A 在设置里从内置麦克风切到耳机麦克风 → B 立刻听到新设备声音。
- 拔掉正在使用的 USB 麦克风 → 自动回退系统默认，有中文提示，不崩、不掉线。
- 下拉框显示的选中项与实际采集设备一致。
```

---

## 任务 5 · 让「观看画质」真正生效

**P0 · `voice/transport.js` + `voice/voice.js`**

```
背景（已核实的代码事实）：
- 观看端有一个下拉 #screen-quality（auto/360/720/1080），change 时
  （voice/voice.js:777-782）做两件事：给共享者发信令 {kind:"quality", value}，
  再调 state.transport.setScreenQuality(v)。
- setScreenQuality 的基类实现（transport.js:934-942）里有一句
  Object.keys(this.elements).forEach(function () { /* 占位：画质由发送端调整 */ });
  —— 这是明确的空实现，整个函数只 emit 了一个事件，没有产生任何效果。
- 信令接收侧：只有 MeshTransport.onSignal 处理 data.kind === "quality"（transport.js:572），
  LiveKitTransport 与 CloudflareTransport 都没有接收方；而信令走的是 Durable Object 的 WebSocket，
  共享者只有在 mesh 模式下才会收到。
- 结论：自建频道（livekit）里「观看画质」是完全无效的假控件。

目标：
1) 自建频道下，观看端能把画质要求真正传达给共享端；
2) 共享端据此下调发送分辨率/码率，实现真实省带宽；
3) 若无法下发，至少不要显示成已生效（不允许假成功 toast）。

实现要求：
- 方案 A（推荐，改动小、实时性好）：用 LiveKit DataChannel 发控制消息。
  共享端在 LiveKitTransport.connect 后监听 RoomEvent.DataReceived，
  收到 {kind:"quality", value} 时对本地的屏幕共享 track 做限制：
  调用 localParticipant 的屏幕共享 track 的 setPublishingQuality / 或对 RTCRtpSender 做
  setParameters({encodings:[{scaleResolutionDownBy, maxBitrate, maxFramerate}]})。
  scale 映射沿用现有 map：auto/1080 → 1，720 → 2，360 → 4。
- 方案 B（兜底）：同时保留现有 DO 信令路径，并在 LiveKit 端也实现一个 onSignal 处理，
  用 state.room.sendSignal 发到共享者，共享者无论 mesh 还是 livekit 都统一按同一个 handler 处理。
- UI 侧要求：toast 不能无条件报「观看画质：xxx」；应在真正下发成功后提示，
  下发失败（例如共享端不是我们的客户端）提示「画质切换失败：对方客户端不支持」。
- 观看端还应在本地做保守处理：把 #screen-video 的播放质量期望体现在
  （可选）video 元素的 requestVideoFrameCallback 统计上，不作为必须项。

验收标准：
- 自建频道 A 共享屏幕，B 把画质从 1080 切到 360：
  A 端 WebRTC 发送参数中 scaleResolutionDownBy 变为 4（可在 chrome://webrtc-internals 验证），
  B 看到的画面明显变糊，A 的上行码率明显下降。
- 切回「自动画质」后恢复原始分辨率/码率。
- 共享端非本客户端（例如其它 LiveKit 客户端）时，B 侧给出「不支持」提示而不是假成功。
- mesh 链路的画质切换行为不回归。
```

---

## 任务 6 · 修复屏幕共享「弹两次选择框」并尊重对话框参数

**P0 · `voice/transport.js`**

```
背景（已核实的代码事实）：
- 基类 publishScreen（transport.js:284-314）先自己调用 navigator.mediaDevices.getDisplayMedia(opts)
  拿到 this.screenStream（用户此时已经选过一次屏幕/窗口），
  然后调用 this.onScreenTrack(track, shareParams)。
- LiveKitTransport.onScreenTrack（transport.js:886-898）却调用了
  localParticipant.setScreenShareEnabled(true, {...})。
  我核对过 vendored SDK（voice/vendor/livekit-client.umd.js）：
  setScreenShareEnabled → setTrackEnabled → createScreenTracks → 内部又会调用
  navigator.mediaDevices.getDisplayMedia(...)。
- 后果：
  1. 用户会看到两次「选择要共享的内容」弹窗（第一次的流被丢弃，白白浪费一次授权）。
  2. 对话框里选的 分辨率 / 帧率 / 码率 / contentHint 基本没生效，
     因为 SDK 用的是它自己的 resolution 映射；而 #screen-stat 里显示的是对话框参数，
     显示值与实际画面不一致（欺骗性 UI）。

目标：
自建频道共享屏幕只弹一次选择框，且对话框里的画质参数真实生效。

实现要求：
1. 不再让 SDK 采集。改为：
   - 基类已经拿到了 screenStream（含可选系统音轨）；
   - 用 localParticipant.publishTrack(videoTrack, { source: Track.Source.ScreenShare,
     videoEncoding: { maxBitrate, maxFramerate } }) 发布；
   - 若 req.audio 为 true 且存在音轨，再用 publishTrack(audioTrack,
     { source: Track.Source.ScreenShareAudio }) 发布。
2. 码率/帧率/缩放按对话框参数设置：优先用 RTCRtpSender.setParameters 调整
   maxBitrate / maxFramerate / scaleResolutionDownBy（可复用 transport.js 里已有的 tuneSender 工具）。
3. 停止共享时 unpublishTrack 两条轨并 stop 掉 MediaStreamTrack（基类 stopScreen 已 stop，注意不要重复）。
4. 共享端 #screen-stat 文案必须显示**实际生效值**（从 sender.getParameters() 读回），
   不要直接回显对话框输入。
5. 若浏览器不支持 getDisplayMedia（iOS/iPadOS Safari），沿用现有中文报错，不要改成英文。

验收标准：
- 自建频道点「共享屏幕」→ 只出现一次选择框。
- 选 720p/30fps/2000kbps 后，chrome://webrtc-internals 里该视频 sender 的
  maxBitrate=2000000、maxFramerate=30，实际采集分辨率不超过 1280×720。
- 勾选「同时共享系统音频」后，对方能听到共享的音频；不勾时没有。
- 点「停止共享」后对方画面消失、两端都不再占用摄像头/屏幕采集（系统托盘麦克风/共享指示消失）。
```

---

## 任务 7 · 把「连接质量」从假数据改成真实统计

**P1 · `voice/transport.js`**

```
背景（已核实的代码事实）：
- 房间头部显示「连接质量：xx ms · 丢包 y%」（voice/voice.js:231-234），数据来自 state.stats。
- LiveKitTransport.getStats（transport.js:911-914）返回的是：
  { rttMs: this.roomRtt(), lossPct: 0, bytesSent: 0, bytesRecv: 0, jitterMs: null }
  —— 丢包恒为 0、字节数恒为 0、抖动为 null，等于这个面板在自建频道是装饰品。

目标：
自建频道的连接质量显示真实 RTT、丢包率、抖动与收发码率。

实现要求：
1. 在 LiveKitTransport 里启动一个 2 秒轮询（复用基类已有的 stats 定时器模式，
   注意 disconnect 时要 clearInterval，现有 disconnect 已调 disposeAudio，别遗漏）。
2. 数据来源优先级：
   - 首选 this.lkRoom.engine.pcManager 里的 RTCPeerConnection（SDK 内部字段，取不到时降级）；
   - 降级方案：遍历 this.lkRoom.localParticipant / remoteParticipants 的 track，
     用 track.getRTCStatsReport?.() 或 track.attachedElements 关联的 pc 做 getStats；
   - 兜底：this.lkRoom.rtt + 只报 RTT，其它字段填 null，UI 要能显示「—」而不是 0。
3. 计算规则：
   - RTT：candidate-pair 的 currentRoundTripTime * 1000；
   - 丢包：remote-inbound-rtp（音频/视频）的 packetsLost / (packetsLost + packetsReceived) * 100；
   - 抖动：jitter * 1000（毫秒）；
   - 码率：inbound-rtp 的 bytesReceived 差值 / 时间差。
4. voice/voice.js 渲染要能处理 null：lossPct 为 null 时显示「丢包 —」，不要显示 0.0%。
5. 数值做平滑（最近 3 次取中位数），避免数字乱跳。

验收标准：
- 自建频道正常通话时，面板每秒级更新，RTT 与 chrome://webrtc-internals 一致（误差 < 20ms）。
- 人为限速/丢包（Chrome DevTools Network throttling 或 tc）后，丢包率明显上升。
- 断开后停止轮询，无 console 报错、无定时器泄漏。
```

---

## 任务 8 · 断线自动重连（含 UI 状态）

**P1 · `voice/transport.js` + `voice/voice.js`**

```
背景（已核实的代码事实）：
- DO WebSocket 层已有断线重连（transport.js:132-136，退避 + 5 分钟票据）。
- 但 LiveKit 层只监听 RoomEvent.Disconnected 并直接 emit("disconnected")（transport.js:863），
  voice.js 收到后弹 toast 但没有重连逻辑；LiveKit SDK 的 Reconnecting / Reconnected /
  ConnectionQualityChanged 事件都没被使用。
- 后果：网络抖动导致 LiveKit 断开后，用户必须手动退出再重新进频道。

目标：
网络短暂中断能自动恢复；真断开时给出明确中文提示并支持一键重连。

实现要求：
1. 监听 RoomEvent.Reconnecting → UI 显示「网络中断，正在重连…」（复用 #conn-text，加一个 pending 样式）。
2. 监听 RoomEvent.Reconnected → 恢复「已连接」，并重新应用当前 mic/共享状态
   （重连后本地发布的轨可能已断，需要重新发布；屏幕共享按当前 state.sharing 决定是否续传）。
3. 监听 RoomEvent.Disconnected：
   - 若 reason 属于可重试（网络类），用指数退避（1s/2s/4s/8s，最多 5 次）调用已有的 join 接口
     重新取 token 并重连（因为票据可能过期）。
   - 5 次仍失败 → 显示「连接已断开」并提供「重新连接」按钮，点击走一次全新 join。
4. 重连过程中不要重复叠加 toast；不要丢失当前频道选择（state.current 保持）。
5. 重连成功后不要重复渲染整页，只更新状态位。

验收标准：
- 通话中禁用网卡 5 秒再恢复 → 无需手动操作自动恢复通话，UI 依次显示「重连中 → 已连接」。
- 断网 30 秒以上 → 提示断开 + 出现「重新连接」按钮，点击后回到频道。
- 重连过程中麦克风静音状态保持（静音的人重连后仍然是静音）。
- mesh / cloudflare 链路不受影响。
```

---

## 任务 9 · 频道内文字聊天

**P1 · 全栈（`voice/` + `src/voice-room.js` + `src/index.js`）**

```
背景：
语音页目前完全没有文字聊天（voice/index.html 里只有语音/屏幕共享相关的 DOM）。
但底层已经有可用的基础设施：
- Durable Object 每个频道一个实例，已有 WebSocket 广播（src/voice-room.js，STATE_FIELDS 里含 mic/deaf/
  speaking/sharing/quality/ptt 等成员状态）；
- 前端已有 VoiceRoomClient（voice/transport.js:101-160），支持 send() 与事件订阅。
也就是说：加聊天不需要新表、不需要新 Durable Object，只要在既有 WS 上多一种消息类型。

目标：
频道内文字聊天：可发送、实时到达同频道所有人、显示发送者与时间、刷新页面能看到最近 50 条。

实现要求：
后端（src/voice-room.js）：
1. 新增 WS 消息类型 { t: "chat", text, clientId }，校验：
   - 已加入该频道；text 为字符串、trim 后长度 1~500；同一连接 3 秒内最多 5 条（简单限流）。
2. 保留最近 100 条在 DO 内存里（环形缓冲），新成员 join 时随 hello 一起下发最近 50 条。
   不做 D1 持久化（DO 内存足够，且重启丢失可接受；如要持久化请用 DO storage，不要用 D1 每次写入）。
3. 广播格式 { t: "chat", id, memberId, name, color, text, ts }。
4. XSS 一律在**前端**转义（后端不要做 HTML 转义，保持原文）。

前端（voice/）：
1. 在右侧成员栏下方或房间区底部加一个可折叠「聊天」面板（不要破坏现有三栏布局；
   窄屏（<900px）用抽屉形式，通过一个小按钮打开）。
2. 输入框支持 Enter 发送、Shift+Enter 换行、500 字上限并显示剩余字数。
3. 消息列表自动滚到底部，但用户手动上滚时不要强制拉回，改为显示「有新消息 ↓」按钮。
4. 自己的消息靠右、他人靠左，显示头像（复用 avatarHTML）、名字、时间（HH:mm）。
5. 收到消息时若面板未打开，面板标题上显示未读数；进入频道时清零。
6. 所有文本用 textContent 或现有 esc() 转义，禁止 innerHTML 拼接未转义内容。

验收标准：
- 两个账号在同频道互发消息，延迟 < 1s 到达。
- 发送 <script>alert(1)</script> 显示为纯文本，不执行。
- 新成员进入频道能看到最近 50 条。
- 空消息、超长消息、超频消息被拦下并给出中文提示。
- npm run voice:test:e2e 不回归（如需新增断言，请一并加在 tests/voice/ 下）。
```

---

## 任务 10 · 允许创建者编辑 / 删除自己的私有频道

**P1 · 全栈（`src/voice-realtime.js` + `voice/`）**

```
背景（已核实的代码事实）：
- 前端有「添加私有频道」对话框（voice/index.html:306-343，POST /api/voice/channels），
  创建时可选名称、描述、可见性（private/public）、口令、backend、自建服务器 host/port/tls。
- 但没有任何「编辑」「删除」入口：voice/voice.js 里搜不到 编辑频道 / 删除频道 / 重命名。
- 后端也只有管理员侧的 /api/voice/admin/channels（含 reorder），用户自己的频道没有 PATCH/DELETE。

目标：
频道创建者能修改自己私有频道的名称/描述/口令/可见性，并删除自己的频道（有二次确认）。
管理员对所有频道都能操作（复用 admin 接口即可）。

实现要求：
后端（src/voice-realtime.js）：
1. 新增 PATCH /api/voice/channels/:id 与 DELETE /api/voice/channels/:id。
2. 鉴权：仅 owner_id === 当前用户，或 role === admin；否则 403（中文提示）。
3. PATCH 允许字段：name(<=24)、descr(<=120)、visibility(private|public)、password(可空,<=64)、
   max_users(受管理员设置上限夹取)。backend/server_id 不允许改（避免迁移语义混乱）。
4. DELETE：若频道当前有人在线（DO 有成员），拒绝并返回「频道内还有 N 人，请先让成员离开」；
   删除时清理关联记录，不留孤儿（参考现有 admin 删除逻辑的实现方式，保持一致）。
5. 两者都要写审计日志（现有 audit 机制）。

前端（voice/）：
1. 频道行在 hover/长按（移动端）时显示「⋯」菜单，仅对自己创建的频道可见：
   菜单项 = 重命名 / 编辑设置 / 删除。
2. 复用 dlg-add 的表单做成「编辑模式」：标题改「编辑频道」，隐藏 backend/服务器字段，
   密码字段显示「留空表示不修改」。
3. 删除必须二次确认（输入频道名或用原生 confirm 中文文案均可），成功后若当前正在该频道则先离开。
4. 操作成功后局部刷新频道列表，不要整页 reload。

验收标准：
- 用户能改自己频道的名称，列表与房间头同步更新，其他人在线时也能看到新名字。
- 别人（非创建者非管理员）看不到「⋯」菜单；直接调用接口返回 403。
- 删除有人的频道被拒绝，提示人数正确；空频道删除后列表消失、D1 无孤儿记录。
- 管理员对任意频道都可编辑/删除。
```

---

## 任务 11 · 修改密码 / 修改资料 / 更换头像

**P2 · 全栈（`src/voice-auth.js` + `voice/auth.js` + `voice/index.html`）**

```
背景（已核实的代码事实）：
- 注册时可上传头像（voice/index.html:129-132，POST /api/voice/register），
  但注册之后没有任何修改入口：设置抽屉（dlg-settings）只有「退出登录」。
- Worker 侧路由清单里有 /api/voice/{login,logout,me,register,captcha,bootstrap,config,...}，
  没有 change-password / profile 类接口。

目标：
登录用户能在设置里改显示名、换头像、改密码。

实现要求：
后端（src/voice-auth.js）：
1. PATCH /api/voice/me：改 display_name(<=24)、avatar（复用现有上传校验：jpeg/png/webp、大小上限、
   走 R2/KV 存储与 /api/voice/avatars/ 读取路径）。返回更新后的用户对象。
2. POST /api/voice/password：body { oldPassword, newPassword }。
   - 校验旧密码；新密码沿用注册时的强度规则（>=10 位且含字母与数字）。
   - 成功后**吊销其它会话**（保持当前会话有效），并写审计。
3. 两个接口都要 CSRF 校验（沿用现有 voice 接口的校验方式）与频率限制。

前端（voice/）：
1. 设置抽屉底部「退出登录」上方加：显示名输入框（失焦保存）、头像上传（带预览）、「修改密码」按钮。
2. 修改密码用小对话框：旧密码 / 新密码 / 确认新密码，前端先做一致性与强度校验，再提交。
3. 保存成功后更新左上角用户条（名字/头像立即变化），并 toast 中文提示。
4. 头像上传失败（格式/大小）给出具体中文原因，不要只弹「失败」。

验收标准：
- 改显示名后，频道内其他成员看到的名字在 5 秒内更新（依赖 members 广播）。
- 换头像后自己与他人列表都显示新头像（注意 ?v= 缓存参数，需在 URL 上带版本戳）。
- 改密码后：当前会话仍可用；另一个浏览器的旧会话被踢回登录页。
- 弱密码 / 旧密码错误 / 两次不一致 都有明确中文提示。
```

---

## 任务 12 · 修掉共享占位文案「等待画面…」永不更新

**P2 · `voice/voice.js`**

```
背景（已核实的代码事实）：
- voice/index.html:250 有 <span id="screen-sub">等待画面…</span>。
- 我在 voice/voice.js 与 transport.js 里全量搜索，**没有任何地方引用 screen-sub**，
  所以「等待画面…」会一直显示，即使画面已经在播。
- 同区域的 #screen-stat（voice/index.html:260）只在开始共享时写一次
  （voice.js:750-751），之后不再更新，所以「延迟」永远是初始值。

目标：
让共享区的副标题与实时统计反映真实状态。

实现要求：
1. screen-sub 状态机：
   - 有人共享但本端还没收到轨道 → 「正在连接对方画面…」
   - 收到轨道但视频还没首帧渲染 → 「等待首帧…」
   - 正常播放 → 「1280×720 · 30fps」这类实际参数（从 video.videoWidth/videoHeight 读）
   - 自己正在共享 → 「你正在共享屏幕」
   - 不观看状态 → 「已停止观看，点击「重新观看」恢复」
2. screen-stat：接上真实数据（码率/帧率/延迟），可复用任务 7 的 stats 通道；
   若拿不到数据，显示「—」而不是保留旧值。
3. 所有更新走同一处 renderRoom 或在 video 的 loadedmetadata / resize 事件里更新，避免定时器轰炸。
4. 不要把「等待画面…」删掉，保留为初始文案。

验收标准：
- 进入有共享的频道，文案按上述状态依次变化，不再卡在「等待画面…」。
- 自己开始共享后显示实际分辨率与帧率。
- 停止观看/恢复观看时文案正确切换。
- 无画面（对方刚开共享）时不会显示假的 1280×720。
```

---

## 附：本次核对中确认「已实现、无需再做」的项（避免重复开发）

| 功能 | 证据 |
|---|---|
| 登录/注册/邀请码/图片或 Turnstile 验证码 | voice/auth.js + src/voice-auth.js |
| 频道列表/在线人数/私有频道口令 | src/index.js + voice-room.js |
| 麦克风开关、按键说话（PTT）、提示音开关 | voice.js:666-670 / 815-848 |
| 全屏、画中画、停止观看、共享音量 | voice.js:763-793 |
| 输出设备切换（setSinkId） | voice.js:606-611 |
| 管理员禁言/踢人（房间内按钮 + 后台接口） | voice.js:217-218 + /api/voice/admin/kick\|mute |
| 自建服务器连通性测试按钮 | voice.js:871+ /api/voice/servers/test |
| DO 层 WebSocket 断线重连（非 LiveKit 层） | transport.js:132-136 |

---

## 已知与本任务无关但值得记录的环境问题

- 临时隧道（trycloudflare）域名每次重启都会变，必须在启动后同步回 D1 `self_hosted_servers.host`，
  否则前端会拿旧域名报 `Failed to fetch`。桌面启动器 `ZF语音-自建语音后端.bat` 已带自动同步。
  长期方案：改用 Named Tunnel（固定域名 `voice.zfsnnb.dpdns.org`）。
- `cloudflared` 会读取全局 `C:\Users\<你>\.cloudflared\config.yml`（留言板的命名隧道配置，
  兜底 `http_status:404`），必须用 `--config tools/livekit/quick-tunnel.yml` 隔离，
  脚本 `voice-media-server.mjs` 已固化此行为。
