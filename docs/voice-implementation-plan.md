# ZF语音 · 实施方案

> 版本 v1 · 2026-11-14 · 项目路径 `D:\ZFSNwebsite`
> 状态：阶段 1（勘察 / 方案 / 入口按钮 / 静态页面骨架）
> 本文是后续各阶段的单一事实来源；阶段推进时同步更新「九、阶段交付记录」。

---

## 一、项目勘察结论

### 1.1 技术栈与部署方式

| 项 | 结论 | 依据 |
|---|---|---|
| 架构 | 单个 Cloudflare Worker（`src/index.js`，1323 行，零第三方依赖纯 ESM）+ Workers 静态资源托管 | `wrangler.toml`、`package.json` |
| 前端 | 原生 HTML/CSS/JS，**无 React / Vue / TS / Tailwind / 构建步骤** | `index.html`、`assets/js/*.js` |
| 数据库 | D1（`DB`），现有 2 个迁移：`schema/0001_init.sql`、`0002_analytics.sql` | `wrangler.toml` |
| 媒体存储 | **KV（`MEDIA`）分片**，不是 R2 —— 项目注释明确写了「R2 开通要绑支付方式」，单值上限 25 MiB，>8 MiB 自动分片 | `wrangler.toml`、`src/media.js`、`DEPLOY.md` |
| 已接 Cloudflare 产品 | Workers、Workers Assets、D1、KV、Turnstile（已写 `L.verifyTurnstile`，但 `TURNSTILE_SITE_KEY` 为空＝未启用） | `src/lib.js`、`wrangler.toml` |
| 部署 | 线上域名 `www.zfsnnb.dpdns.org` 绑定名为 `zfsn` 的 Worker；`workers.dev` 域名做 301；推 main 由 Cloudflare Git 集成自动构建 | `wrangler.toml`、`src/index.js` |
| 本地运行 | `npm run dev` = `wrangler dev`；`npm run deploy` = `wrangler deploy` | `package.json` |
| 现有页面 | `index.html`、`admin/index.html`、`minecraft/index.html`、`pvz/pvz-portable.html`（另有浏览器扩展页 `cyberpunk-newtab/newtab.html` 和搜索引擎验证文件） | 全仓 `*.html` 扫描 |

### 1.2 现有账号体系与后台

- **只有单管理员**，没有注册用户体系：管理员密码 PBKDF2-HMAC-SHA512 存 `config` 表，会话存 `sessions` 表。
- **会话用 `X-Admin-Token` 请求头 + `localStorage`**（`admin/index.html` 第 976 行 `zfsn_admin_token`），不是 Cookie。
- **因此**：ZF语音必须新建独立账号体系（`voice_users` / `voice_sessions`），不能改动现有 admin 登录，否则会破坏后台。管理端 API 采用双通道鉴权（见 2.5）。
- 后台 `/admin` 已存在且功能很多（作品、留言、统计、外观等），接入方式选「在现有后台新增一个『ZF语音』标签页」，同时保留 `/voice/admin` 作为仅管理员可访问的独立入口（阶段 4 决定最终形态）。

### 1.3 视觉风格（从现有站点提取，不套 Discord 蓝紫）

| 变量 | 值 | 来源 |
|---|---|---|
| 背景 | `#07070b` | `assets/css/app.css` `:root` |
| 文字 | `#e9e9f2` / 次要 `#78788c` | 同上 |
| 主色（强调） | **`#ff2d4a`（ZF 红）**，柔和版 `#ff6b7f` | 同上 |
| 面板 | `rgba(255,255,255,.035)`，描边 `rgba(255,255,255,.09)` | 同上 |
| 圆角 | `--r: 18px`（卡片），控件 7~11px | 同上 |
| 缓动 | `cubic-bezier(.2,.8,.3,1)` | 同上 |
| 字体 | `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif` | 同上 |
| 后台深色变量 | `#07070b / #0e0e15 / #13131c / #1e1e2a / #ff2d4a / #3fd63f` | `admin/index.html` `:root` |

参考截图（黑盒语音）取的是**布局与交互**：最左窄图标栏、第二栏频道列表＋展开成员、中间主区域（成员网格 / 共享大画面）、右侧在线成员、左下角用户条（麦克风 / 耳机 / 挂断 / 屏幕共享 / 延迟）。配色改用上面的 ZF 红＋近黑底，说话光环用绿色 `#3fd63f`，不引入蓝紫。

### 1.4 项目中已写明、必须避开的坑

1. `wrangler.toml` 的 `run_worker_first` 是**白名单**：新增无扩展名 HTML 页面必须加进去，否则不会被 301 覆盖、也无法做服务端鉴权渲染。
2. `[assets] binding = "ASSETS"` 必须保留；全局 `run_worker_first = true` 会让 `_headers` 整体失效（图片缓存从 30 天退回 0）。**只加路径，不改模式**。
3. `_headers` 要给新页面补 `Content-Type: text/html; charset=utf-8`（静态层默认不带 charset）。
4. `.assetsignore` 排除 `*.bat`、`*.ps1`、`*.py`、`tools/`、`src/`、`schema/`。**自建 SFU 部署包里的 .bat/.ps1 会被排除上线**，需打包成 `.zip` 或加白名单例外。
5. Workers 的 PBKDF2 迭代上限 **100000**（硬限制，超出直接抛错），argon2id/bcrypt 在 Workers 无原生实现 → 复用 `L.hashPassword` / `L.verifyPassword`，不要引入新 KDF。
6. KV 是**最终一致**（最多 60 秒全球可见）→ 一次性验证码**不能放 KV**，改用 D1 原子条件消费。
7. 当前 `git status` 有大量未提交改动（`index.html`、`minecraft/*`、`_headers` 等）→ 只做最小追加，不格式化、不回滚、不提交、不覆盖现有文件。

---

## 二、技术方案

### 2.1 选型结论

| 决策点 | 选择 | 理由 |
|---|---|---|
| 前端框架 | **沿用原生 JS + Worker，独立目录 `voice/`** | 用户要求「不破坏现有网站功能、独立目录和独立路由」；引入 React/Next 会与 Assets 托管、`_headers` 缓存、Git 自动构建冲突，且项目零构建。Expert 默认栈（Next/Tailwind/shadcn）在此**主动放弃** |
| Cloudflare 音视频 | **Realtime SFU**（Connection API） | 官方明确：需要自行管理信令 / 权限 / 会话状态 / track 发现、控制每个端点的发布订阅，用 SFU；RealtimeKit 是「会议应用先选它」的高阶 SDK，会把 track 级控制抽象掉，不满足「DO 管理信令 + RTCRtpSender 调码率 + 观看端选画质」 |
| 频道状态 | **每频道一个 Durable Object（WebSocket Hibernation API）** | 官方 SFU 快速上手示例就是 Worker 信令 + DO 房间状态；Hibernation 空闲不计费、连接不断 |
| TURN | Cloudflare Realtime TURN，服务端用 TURN Key 换短期 iceServers | 官方文档：`POST https://rtc.live.cloudflare.com/v1/turn/keys/{KEY_ID}/credentials/generate-ice-servers`，TURN Key 绝不下发前端 |
| 自建 SFU | **LiveKit Server**（Windows 可执行文件） | 有官方 Windows 包、自带 Simulcast / 屏幕共享 / JWT 鉴权、端口模型清晰（7880 信令 / 7881 TCP / UDP 50000-60000）；mediasoup 需要自己写信令与 Node 服务，Windows 部署体验差 |
| 密码哈希 | PBKDF2-SHA512 / 100000 轮（复用 `src/lib.js`） | Workers 硬上限；argon2id 需 WASM 且占 CPU 配额 |
| 头像存储 | 复用现有 KV `MEDIA` | R2 需绑支付方式；用户允许「项目现有的存储方案」 |

### 2.2 架构图

```mermaid
flowchart TB
  subgraph B[浏览器]
    MAIN[主站页面<br/>左上角入口按钮]
    VOICE[/voice 独立布局<br/>UI 层只依赖 VoiceTransport]
    ADMIN[后台 ZF语音 标签页]
  end
  subgraph W[Cloudflare Worker zfsn]
    AUTH[/api/voice/*<br/>鉴权 / 邀请码 / 验证码 / 配置/]
    SIGNAL[信令与令牌签发<br/>CF session 凭证 或 LiveKit JWT]
    DO[(Durable Object<br/>频道成员 / 设置下发 / 踢人)]
    D1[(D1<br/>用户 / 会话 / 邀请码 / 频道)]
    KV[(KV MEDIA<br/>头像 / 验证码不放这里)]
  end
  subgraph CF[Cloudflare 频道]
    SFU[Realtime SFU<br/>rtc.live.cloudflare.com/v1]
    TURN[Realtime TURN<br/>短期 iceServers]
  end
  subgraph SELF[自建频道]
    LK[LiveKit Server<br/>wss 域名 + UDP/TURN]
  end
  MAIN --> VOICE
  VOICE -->|HTTPS 接口| AUTH
  VOICE -->|WebSocket| DO
  VOICE -->|WebRTC 媒体| SFU
  VOICE -->|WebRTC 媒体| LK
  AUTH --> SIGNAL --> SFU
  AUTH --> SIGNAL --> LK
  AUTH --> D1
  AUTH --> KV
  DO --> D1
  ADMIN --> AUTH
  SFU -.-> TURN
  LK -.-> TURN
```

### 2.3 目录与文件规划（全部新增，不覆盖现有业务文件）

```
voice/index.html            /voice 独立页面（三栏 + 底部用户条 + 登录/注册壳）
voice/voice.css             独立样式，靠 :root 变量与主站对齐
voice/voice.js              页面状态机、组件渲染、事件绑定
voice/js/transport.js       VoiceTransport 接口定义 + 事件总线
voice/js/cloudflare.js      CloudflareTransport（SFU Connection API）
voice/js/self-hosted.js     SelfHostedTransport（LiveKit Client SDK）
voice/js/media.js           getUserMedia / getDisplayMedia / VAD / 设备与音量
voice/js/ui.js              成员卡、共享大画面、右侧栏、抽屉
voice/admin.html            /voice/admin 独立后台（可选）
voice/deploy/               自建 SFU 部署包（zip：说明文档 + .bat/.ps1 + config 模板）
assets/js/voice-entry.js    全局入口按钮注入脚本（各页面只加 1 行 script）
src/voice/*.js              Worker 侧模块（auth / captcha / channels / admin / sfu / turn / livekit）
src/voice/room-do.js        Durable Object 类
schema/0003_voice.sql       新表 + 默认频道 + 索引
docs/voice-implementation-plan.md   本文
docs/voice-deploy.md        中文部署文档（阶段 7）
tests/voice/*.mjs           单元测试（鉴权 / 邀请码 / 验证码）
```

`wrangler.toml` 追加：`run_worker_first` 增加 `/voice`、`/voice/`、`/voice/index.html`、`/voice/admin`；新增 `[[durable_objects.bindings]]` 与 `[[migrations]]`（`new_sqlite_classes`）；新增 vars/secrets 清单。`_headers` 追加 `/voice` 系列 charset 规则。

### 2.4 统一 VoiceTransport 接口（前端，UI 只依赖它）

```js
/**
 * 统一语音传输接口。UI 层不得引用任何具体后端 SDK。
 * 两个实现：CloudflareTransport、SelfHostedTransport。
 */
interface VoiceTransport {
  connect(roomToken, options): Promise<void>;   // options: iceServers / 音质预设 / 上限
  disconnect(): Promise<void>;
  publishAudio(track, opts): Promise<void>;     // 麦克风轨
  unpublishAudio(): Promise<void>;
  publishScreen(track, opts): Promise<void>;    // 屏幕轨，opts 含分辨率/帧率/码率/内容类型
  unpublishScreen(): Promise<void>;
  setScreenQuality(q): Promise<void>;           // 共享中不中断，改 RTCRtpSender 参数
  subscribe(participantId, kind, quality): Promise<MediaStreamTrack>;
  unsubscribe(participantId, kind): Promise<void>;
  setParticipantVolume(participantId, v): void;
  on(event, cb): void;                          // participantJoined/Left/Speaking/TrackPublished/SettingsUpdated/Stats/Reconnecting
  getStats(): Promise<{ rttMs, loss, bitrateKbps, resolution, fps }>;
}
```

### 2.5 关键链路

- **加入频道**：`/api/voice/channels/:id/join` → 校验会话 / 角色 / 人数上限 → Cloudflare 频道由 Worker 用 App Secret 调 `POST /apps/{appId}/sessions/new`（Bearer），自建频道由 Worker 用 LiveKit API Key/Secret 签发短期 JWT → 返回 `roomToken` + 当前设置（音质/共享上限）→ 前端 `transport.connect()` → WebSocket 连 DO 报成员状态。
- **配置实时下发**：后台改频道设置 → 更新 `channel_settings` 并 `revision+1` → Worker 通知该频道 DO → DO 向所有在线 WebSocket 广播 `SettingsUpdated` → 客户端裁剪到新上限（ Opus 码率走重新协商或 `RTCRtpSender.setParameters`，屏幕轨直接改参数不中断共享）。
- **自建频道的 wss 约束**：HTTPS 页面连 `ws://IP` 会被浏览器混合内容拦截，且 IP 难签证书。方案 a) Cloudflare Tunnel 把本机 7880 暴露为 `wss://` 域名（官方 FAQ 明确 Tunnel 完整支持 WebSocket）；b) 域名 + DDNS + Let's Encrypt；c) 仅本机调试用 localhost。**Tunnel 只转发 HTTP/WebSocket**，UDP 媒体端口仍需端口映射或 TURN 中继。添加频道对话框对 `ws://` + 非 localhost 一律给中文报错和上述三条指引。
- **测试连接**：仅对 `wss://` 公网域名由 Worker 服务端发起探测（避免浏览器混合内容）；局域网 IP 不探测，直接给中文指引。不可达时频道标记「离线」，不影响其他频道。
- **双通道管理鉴权**：`/api/voice/admin/*` 同时接受 ① HttpOnly Cookie 的 voice 管理员会话；② 现有后台的 `X-Admin-Token`（`L.checkToken`）。这样接入现有后台不需要把 token 搬进 Cookie，也不改现有登录。

---

## 三、数据模型（`schema/0003_voice.sql`）

```sql
-- 用户。display_name 允许重复，输出时统一转义；password_rec 是 PBKDF2 salt/hash/iter 的 JSON
CREATE TABLE IF NOT EXISTS voice_users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,             -- 登录名：^[a-z0-9_]{3,20}$
  display_name  TEXT NOT NULL,
  avatar_ref    TEXT,                            -- KV 引用，NULL = 自动生成默认头像
  avatar_color  TEXT NOT NULL,                   -- 由用户名哈希决定的稳定底色
  password_rec  TEXT NOT NULL,                   -- {"salt","hash","iter"}
  role          TEXT NOT NULL DEFAULT 'user',    -- user | admin
  status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled | banned
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_vu_status ON voice_users(status);

-- 会话：Cookie 只放随机 token，库里只放 token 的 SHA-256
CREATE TABLE IF NOT EXISTS voice_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  exp        INTEGER NOT NULL,
  ip         TEXT, ua TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vs_user ON voice_sessions(user_id);

CREATE TABLE IF NOT EXISTS invite_codes (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,   -- 明文只在创建时返回一次
  note        TEXT,
  expires_at  INTEGER,                -- NULL = 永不过期
  max_uses    INTEGER,                -- NULL = 不限次数（默认）
  use_count   INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER                 -- 软删除：删除后不可再用，已注册用户不受影响
);
CREATE INDEX IF NOT EXISTS idx_ic_deleted ON invite_codes(deleted_at);

CREATE TABLE IF NOT EXISTS invite_code_uses (
  id       TEXT PRIMARY KEY,
  code_id  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  used_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_icu_code ON invite_code_uses(code_id, used_at);

-- 验证码：D1 而非 KV（KV 最终一致会破坏「一次性」）。答案只存哈希。
CREATE TABLE IF NOT EXISTS captcha_challenges (
  id         TEXT PRIMARY KEY,
  answer_hash TEXT NOT NULL,
  exp        INTEGER NOT NULL,
  consumed   INTEGER NOT NULL DEFAULT 0,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captcha_exp ON captcha_challenges(exp);

CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  descr       TEXT,
  icon        TEXT,
  backend     TEXT NOT NULL DEFAULT 'cloudflare',  -- cloudflare | self_hosted
  server_id   TEXT,                                -- 后端为 self_hosted 时指向 self_hosted_servers
  ord         INTEGER NOT NULL DEFAULT 0,
  join_scope  TEXT NOT NULL DEFAULT 'all',         -- all | roles
  join_roles  TEXT,                                -- JSON 数组
  max_users   INTEGER NOT NULL DEFAULT 20,
  revision    INTEGER NOT NULL DEFAULT 1,          -- 设置变更时 +1，用于实时下发
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_settings (
  channel_id       TEXT PRIMARY KEY,
  audio_json       TEXT NOT NULL,  -- {preset,bitrateKbps,sampleRate,channels,dtx,fec,frameMs}
  screen_json      TEXT NOT NULL,  -- {enabled,maxWidth,maxHeight,maxFps,maxBitrateKbps,maxSharers}
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS self_hosted_servers (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  host         TEXT NOT NULL,       -- IP 或域名
  port         INTEGER NOT NULL DEFAULT 7880,
  tls          INTEGER NOT NULL DEFAULT 1,   -- 1 = wss
  screen_host  TEXT,                         -- 屏幕流可单独指向另一台
  secret_ref   TEXT NOT NULL,                -- Worker secret 名，密钥绝不下发前端
  status       TEXT NOT NULL DEFAULT 'unknown',  -- online | offline | unknown
  created_by   TEXT, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id      TEXT PRIMARY KEY,
  ts      INTEGER NOT NULL,
  actor   TEXT,
  action  TEXT NOT NULL,     -- login/register/invite.create/invite.delete/channel.update/kick/mute...
  target  TEXT,
  detail  TEXT,              -- JSON
  ip      TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_logs(ts DESC);

-- 系统设置复用现有 config 表（k/v），键前缀 voice:，例如
-- voice:registration_open / voice:captcha_mode / voice:allow_user_self_hosted
INSERT OR IGNORE INTO channels
  (id,name,descr,backend,ord,join_scope,max_users,revision,created_at,updated_at)
VALUES ('cf-lobby','开黑频道1','ZF语音默认频道','cloudflare',0,'all',20,1,0,0);
```

`avatars` 不建表：`voice_users.avatar_ref` 直接存 KV key（`voice/avatars/{userId}.webp`）。

---

## 四、路由与 API 清单

### 4.1 页面路由

| 路径 | 说明 | 鉴权 |
|---|---|---|
| `/voice` | 独立布局语音页；未登录只返回登录 / 注册壳 | 服务端检查 Cookie（加入 `run_worker_first` 后由 Worker 渲染），阶段 1 用前端守卫 |
| `/voice/admin` | 独立管理后台（或嵌入现有 `/admin` 标签页） | 管理员 |
| `/admin` | 现有后台，新增「ZF语音」标签页 | 现有 `X-Admin-Token` |
| `/api/voice/ws` | WebSocket 升级到对应频道的 DO | 登录会话 |

### 4.2 公开接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/voice/config` | 注册开关、验证码模式、Turnstile site key |
| GET | `/api/voice/captcha` | 生成 4~5 位数字图（噪点 / 干扰线 / 扭曲 / 轻模糊），返回 `captchaId` + 图片；答案只存 hash，2 分钟过期 |
| POST | `/api/voice/register` | 邀请码 / 用户名 / 显示名 / 头像 / 密码×2 / 验证码（或 Turnstile）；服务端校验全部 |
| POST | `/api/voice/login` | 用户名 + 密码 + 验证码（失败冷却）；成功下发 `HttpOnly; Secure; SameSite=Lax` Cookie |
| POST | `/api/voice/logout` | 删除会话并清 Cookie |
| GET | `/api/voice/me` | 当前用户、角色、头像 |

### 4.3 登录用户接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/voice/channels` | 频道列表 + 在线人数 + 后端类型 + 离线状态 |
| GET | `/api/voice/channels/:id` | 频道详情与当前设置 |
| POST | `/api/voice/channels/:id/join` | 鉴权后签发 CF session 凭证 / LiveKit 短期 JWT |
| POST | `/api/voice/channels/:id/leave` | 释放资源 |
| GET | `/api/voice/turn` | 短期 TURN iceServers（服务端用 TURN Key 换取） |
| POST | `/api/voice/self-hosted/test` | 仅 wss 公网域名的服务端可达性 + 延迟探测 |
| GET | `/api/voice/avatars/:id` | 头像读取（走 KV / 默认头像 SVG 兜底） |

### 4.4 管理接口（双通道鉴权）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PATCH/DELETE | `/api/voice/admin/channels[/:id]` | 频道增删改、排序、描述、图标、最大人数 |
| GET/PATCH | `/api/voice/admin/channels/:id/settings` | 音质预设 / 屏幕共享上限；改完广播到 DO |
| GET/POST/DELETE | `/api/voice/admin/invites[/:id]`、`/:id/uses` | 邀请码创建（有效期 / 上限 / 备注）、列表、复制、删除、使用记录 |
| GET/PATCH/DELETE | `/api/voice/admin/users[/:id]` | 搜索、改角色、禁用、重置密码、删除 |
| GET/PATCH | `/api/voice/admin/settings` | 验证码模式切换（自制 / Turnstile）、开放注册、允许用户加自建频道 |
| GET | `/api/voice/admin/audit` | 审计日志 |
| POST | `/api/voice/admin/kick`、`/mute` | 踢人 / 禁言，经 DO 执行并记审计 |

所有写接口：CSRF（SameSite + Origin 校验 + 管理端 token 双通道）、服务端输入校验、参数化 SQL、IP + 用户名双维度限流（复用 `L.rateAllow`）、审计日志。

---

## 五、分阶段里程碑

| 阶段 | 交付 | 验收 |
|---|---|---|
| 1 | 勘察结论、方案、全局「ZF语音」入口按钮、`/voice` 静态骨架（登录/注册壳 + 三栏 + 底部用户条 + 响应式抽屉），配置改动 | 主站各页左上角有按钮；`/voice` 能打开且为独立布局；`wrangler dev` 下 200 |
| 2 | 账号体系：注册 / 登录 / 邀请码 / 图片验证码 / 头像（上传 + 默认生成）/ 会话 Cookie / 审计；后台邀请码与用户管理；单元测试 | 有效码可多人注册；过期 / 删除 / 超限拒绝；验证码错误 / 过期 / 重放拒绝；无头像自动生成 |
| 3 | Cloudflare 频道语音：SFU Connection API 接入、Worker 令牌签发、DO 成员状态、加入/离开、麦克风/耳机/VAD/设备与音量、重连与连接质量、加入离开提示音 | 两个浏览器账号互相听到、说话指示正确、静音生效 |
| 4 | 后台频道与音质设置、角色权限、设置实时下发、踢人/禁言 | 改音质 / 共享上限后在线客户端即时生效 |
| 5 | 自建频道：`+` 对话框、测试连接、wss 约束检测与中文指引、LiveKit JWT 签发、部署包（文档 / 脚本 / 配置模板 / 端口转发） | 添加自建频道并通话；不可达时明确提示；其他频道不受影响 |
| 6 | 屏幕共享：共享前弹窗（分辨率 / 帧率 / 码率 / 内容类型 / 自动）、`RTCRtpSender` 实时调参、Simulcast 与观看端画质选择、全屏 / 画中画 / 统计、两种后端 | 480p/720p/1080p 可选且不超后台上限；两端都能共享与观看 |
| 7 | 打磨、安全检查、端到端手动测试清单、中文部署文档（Workers/DO/D1/KV/TURN/R2 备选、密钥与环境变量清单、LiveKit 安装与 Tunnel） | 全部验收项逐条过一遍 |

每阶段结束都给出：改动文件清单、本地运行方式、测试步骤、已知限制。

---

## 六、风险点与对策

| # | 风险 | 对策 |
|---|---|---|
| 1 | Realtime SFU 官方示例标注 **experimental**，且示例部署房间要求 Cloudflare Access；App ID/Secret、额度需账号侧开通 | 阶段 3 开始前用真实账号建 App 并跑通官方 `video-room`；`VoiceTransport` 先备 `MockTransport`，密钥缺失时页面仍可浏览、明确提示「未配置」 |
| 2 | 现有后台 token 在 localStorage，新体系要求 HttpOnly Cookie | 管理 API 双通道鉴权；不改动现有 `/api/admin/*` |
| 3 | KV 最终一致会破坏验证码「一次性」 | 验证码放 D1，`UPDATE ... SET consumed=1 WHERE consumed=0` 原子消费 |
| 4 | HTTPS 页面连 `ws://IP` 被混合内容拦截；IP 无证书 | 强制 wss；Tunnel / DDNS+LE / localhost 三方案中文指引；对话框前置校验 |
| 5 | Tunnel 只转发 HTTP/WebSocket，UDP 媒体不能走 | 部署文档写明 UDP 50000-60000 端口映射或走 Cloudflare TURN 中继 |
| 6 | `.assetsignore` 排除 `.bat/.ps1` | 部署包打成 `.zip` 提供下载，或给 `voice/deploy/` 加例外 |
| 7 | 新增无扩展名页面未加入 `run_worker_first` 导致 301 / 服务端鉴权失效 | 阶段 1 同步改 `wrangler.toml` 与 `_headers`；本地 `wrangler dev` 实测 |
| 8 | Workers 无 argon2/bcrypt，PBKDF2 上限 100000 | 复用 `L.hashPassword`；密码强度靠长度与限流补足 |
| 9 | 工作区已有大量未提交改动 | 只做最小追加；每步前备份；不 commit、不 stash、不回滚他人改动 |
| 10 | iOS Safari 无法发起屏幕共享；各浏览器 `getDisplayMedia` / `RTCRtpSender` 差异 | 能力检测 + 中文友好提示；编码器按 VP9→H.264→AV1 回退 |
| 11 | 10~20 人频道的在线状态高频写 D1 会打爆 | 在线状态只在 DO 内存 + `serializeAttachment`；D1 只存持久配置与审计 |
| 12 | 服务端探测内网 IP 无意义且可能被 Workers 出口策略拦 | 只探测公网 `wss://` 域名；内网地址直接返回中文指引 |
| 13 | 头像上传 XSS / 伪装文件类型 | 服务端校验 magic bytes（JPEG/PNG/WebP）、≤2 MB、前端 canvas 裁剪 256×256 并统一转码 |
| 14 | 自建频道令牌泄露 API Secret | LiveKit Key/Secret 只存 Worker secret，签发 5~10 分钟 JWT，前端只见 token |

---

## 七、默认假设清单（不阻塞，按此推进；如需调整随时说）

1. **沿用现有技术栈**（原生 ESM Worker + 静态页面），不引入 Next.js/React/Tailwind/shadcn，理由是零构建、不破坏现有托管与缓存规则。
2. **视觉取主站变量**：`#07070b` 底、`#ff2d4a` 主色、`#3fd63f` 说话指示、18px 圆角、系统字体栈；截图只作为布局与交互模板。
3. **Cloudflare 后端选 Realtime SFU**，RealtimeKit 仅作为后续可选降级（若 SFU 接入成本超预期）。
4. **自建选 LiveKit Server**，默认 7880 / 7881 / UDP 50000-60000。
5. **账号体系独立新建**，与现有单管理员完全隔离；首个管理员用一次性脚本 + 环境变量创建，不写死密码。
6. **会话 Cookie**：`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=7d`，库中只存 token hash。
7. **管理后台接入现有 `/admin`**（新增标签页）并保留 `/voice/admin` 独立入口；管理 API 双通道鉴权。
8. **头像存现有 KV `MEDIA`**，不做 R2；不上传时按用户名哈希生成稳定底色 + 显示名首字的 SVG 默认头像。
9. **验证码默认自制图片**，后台可一键切 Turnstile，两者统一封装为 `verifyHuman()`。
10. **邀请码默认不限次数**，可设到期时间与最大次数，删除为软删除。
11. **阶段 1 静态页未登录只显示登录/注册壳**；为便于验收布局，提供 `?preview=1` 的本地预览模式（mock 数据，不联接口），阶段 2 接入真实鉴权后移除 mock。
12. **主站页面范围**：`index.html`、`admin/index.html`、`minecraft/index.html`、`pvz/pvz-portable.html`（外加后续新增页面）；不含浏览器扩展新标签页和搜索引擎验证文件。
13. **频道在线状态放 DO**，D1 只存持久化配置；单频道默认上限 20 人。
14. **屏幕共享默认同时 1 人**，分辨率 480/720/1080p，码率滑块 500 kbps~8 Mbps + 自动，实际值以后台上限裁剪。
15. **所有 Cloudflare 凭据先留占位**（`REALTIME_SFU_APP_ID` / `REALTIME_SFU_APP_SECRET` / `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`），由你提供后用 `wrangler secret put` 注入；未配置时语音功能降级为只读提示，页面不崩。
16. **不执行 git 提交 / 部署**，本地验证通过后由你决定何时推送；不修改现有接口语义。
17. **手机端只保证语音与观看共享**，不承诺发起屏幕共享（iOS 限制）。

---

## 八、已核对的官方文档（2026-11-14，编码依据）

| 文档 | 关键结论 |
|---|---|
| `developers.cloudflare.com/realtime/sfu/get-started/` | Worker 做信令 + DO 存房间状态，SFU 凭据只在后端；示例 experimental，本地 localhost 身份，示例部署房间需 Access |
| `developers.cloudflare.com/realtime/sfu/api/` | Base `https://rtc.live.cloudflare.com/v1`；`Authorization: Bearer <APP_SECRET>`；`POST /apps/{appId}/sessions/new`、`POST /apps/{appId}/sessions/{sessionId}/tracks/new`、`PUT .../tracks/update`、`PUT .../renegotiate`、`PUT .../tracks/close`、`GET .../sessions/{sessionId}`；另有 DataChannel / WebSocket adapter 操作；完整 OpenAPI YAML 可下载 |
| `developers.cloudflare.com/realtime/sfu/concepts/sessions-tracks/` | 一个 session = 一个 `RTCPeerConnection`；publish/subscribe 可分会话；订阅用「发布者 sessionId + trackName」定位；应用自己维护 publication 发现列表 |
| `developers.cloudflare.com/realtime/sfu/concepts/architecture/` | 应用负责鉴权 / 信令 / 状态 / 权限 / track 发现，CF 只转发媒体；DO 适合保存一个房间的成员关系 |
| `developers.cloudflare.com/realtime/turn/generate-credentials` | `POST https://rtc.live.cloudflare.com/v1/turn/keys/$TURN_KEY_ID/credentials/generate-ice-servers`，body `{"ttl":86400}`；返回 `iceServers`；TURN Key 是长期密钥，必须留服务端 |
| `developers.cloudflare.com/durable-objects/best-practices/websockets/` | Hibernation API：`ctx.acceptWebSocket()` / `getWebSockets()` / `webSocketMessage()` / `serializeAttachment()`（≤16 KiB）；wrangler 需 `[[migrations]] new_sqlite_classes`；空闲休眠不计费 |
| `developers.cloudflare.com/realtime/realtimekit/quickstart/` | 会议型应用官方推荐 RealtimeKit（`@cloudflare/realtimekit-react`），含预置 UI；本项目因需底层控制改选 SFU |
| `developers.cloudflare.com/changelog/post/2026-11-12-realtimekit-auth-token-validity/` | 2026-11-12 新增 RealtimeKit token 自定义有效期与单个吊销 |
| `developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq` | **Tunnel 完整支持 WebSocket**；gRPC 仅私网路由；公开 hostname 的 UDP 不在其列 |
| `developers.cloudflare.com/network/websockets/` | WebSocket 有空闲超时，需客户端心跳；Workers / DO 可作 WS 端点 |
| LiveKit 官方端口与防火墙文档 | 7880 API/WS、7881 ICE/TCP、UDP 50000-60000（或 7882 单端口复用）、TURN 3478/5349；`keys:` 配 API Key/Secret |

> 阶段 3、5、6 编码前会再逐条复核对应 API 页面（SFU Connection API 请求体字段、LiveKit JWT claim、Turnstile 校验、R2/KV 限额），不凭记忆写调用。

---

## 九、阶段交付记录

### 阶段 1（已完成 · 2026-11-14）

**改动文件清单**

新增：

| 文件 | 作用 |
|---|---|
| `docs/voice-implementation-plan.md` | 本文（勘察结论 / 方案 / schema / API / 里程碑 / 风险 / 假设 / 官方文档核对） |
| `voice/index.html` | `/voice` 独立页面：登录注册壳、三栏、主区、右侧成员、底部用户条、三个对话框 |
| `voice/voice.css` | 独立深色主题 + 可选浅色；主站变量；手机端抽屉 |
| `voice/voice.js` | 页面状态机、mock 数据、wss 混合内容中文指引、全部交互骨架 |
| `voice.html` | `/voice` 无扩展名兜底跳转（静态层映射到目录时不生效也无害） |
| `assets/js/voice-entry.js` | 全站左上角入口按钮运行时注入，不改任何现有 DOM 结构 |
| `tests/voice/voice-entry.test.mjs` | 入口注入的 4 组单元测试（无第三方依赖） |

修改（全部是最小追加，未覆盖任何现有逻辑）：

- `index.html`、`admin/index.html`、`minecraft/index.html`、`pvz/pvz-portable.html`：各加 1 行同步 `<script src="/assets/js/voice-entry.js">`（放 body 末尾，避免被主站外部 module 脚本的 defer 队列阻塞）。
- `wrangler.toml`：`run_worker_first` 增加 `/voice`、`/voice/`、`/voice/index.html`、`/voice.html`。
- `_headers`：增加上述路径的 `Content-Type: text/html; charset=utf-8`。

**未改动**：`src/index.js`、`src/lib.js`、`schema/*`、任何现有 `/api/*` 接口、现有 CSS/JS 业务逻辑。

**如何本地运行**

```bash
cd D:\ZFSNwebsite
npm run dev                              # 线上等价行为（wrangler dev）
# 本机快速预览（阶段 1 推荐，见「已知限制」）：
python -m http.server 8788 --bind 127.0.0.1
# 打开 http://127.0.0.1:8788/voice/             → 登录 / 注册界面
# 打开 http://127.0.0.1:8788/voice/index.html?preview=1                 → 欢迎页
# 打开 ...?preview=1&channel=cf-lobby            → 频道内 + 共享大画面布局
```

**如何测试**

| 检查 | 命令 / 结果 |
|---|---|
| 入口注入单元测试 | `node tests/voice/voice-entry.test.mjs` → 4 组断言通过 |
| Worker 构建 | `npx wrangler deploy --dry-run --outdir /tmp/zf-dry-run` → 成功，11286 个 assets，Worker 64.58 KiB / gzip 17.47 KiB |
| TOML / JS 语法 | `tomllib.load(wrangler.toml)`、`node --check voice/voice.js`、`node --check assets/js/voice-entry.js` 均通过 |
| 路由与资源 | curl 实测 `/voice`、`/voice/`、`/voice/index.html`、`/voice.html`、`/voice/voice.css`、`/voice/voice.js`、`/assets/js/voice-entry.js` 与 4 个主站页面全部 200（`/voice` 301 到 `/voice/` 后返回 18539 B 页面） |
| 真实渲染 | 无头 Chrome 截图 3 张：登录壳、欢迎页、频道内「大画面 + 成员条」；深色主题、ZF 红、说话绿色光环、中文文案均正常 |
| 入口按钮落位 | 主站 `chrome --dump-dom` 确认生成 `<a class="zf-voice-entry in-topbar" href="/voice">`，插在 `.topbar .mark` 之后 |

**已知限制**

1. 账号、频道数据、语音、屏幕共享目前都是**界面骨架 + mock**，接口分别在阶段 2 / 3 / 6 接入；`?preview=1`、`?channel=` 仅本地验收用，阶段 2 移除。
2. `wrangler dev` 在本机陷入持续 `Reloading local server...` 循环（`assets.directory = "."` 会监视整个仓库，包含 `.wrangler/state` 的 SQLite 写入），请求无响应；即使 `--live-reload=false` 也一样。故阶段 1 改用静态服务 + `deploy --dry-run` 验证。线上部署不受影响；本地调试建议把 `.wrangler/` 加入监视排除或指定独立 `--persist-to`。
3. 主站首页的无头截图因外部统计脚本与 canvas 动画无法完成，但 DOM 注入已用 `--dump-dom` 验证；视觉落位由 CSS `margin-right:auto` 保证。
4. 未执行 `git commit` / `wrangler deploy`；工作区原有的未提交改动保持原样。
5. 阶段 3 / 5 / 6 的 Cloudflare 与 LiveKit 调用会在编码前再次逐条复核官方文档（本文第八节已记录首轮核对结论）。

---

### 阶段 2（已完成 · 2026-11-14）

账号体系、邀请码、验证码、头像，以及后台的邀请码 / 用户 / 设置 / 审计管理。语音与屏幕共享仍是阶段 3 / 6 的界面骨架。

**改动文件清单**

新增：

| 文件 | 作用 |
|---|---|
| `schema/0003_voice.sql` | 10 张表 + 索引 + 预置 Cloudflare 频道；与现有业务表完全隔离 |
| `src/voice-core.js` | 纯逻辑层：输入校验、PBKDF2 封装、邀请码生成/规范化、验证码 SVG（点阵数字 + 噪点 + 干扰线 + 扭曲 + 轻模糊）、Cookie、默认头像色/SVG、`publicUser` |
| `src/voice-auth.js` | HTTP 层：注册 / 登录 / 登出 / me / 头像、验证码与邀请码的原子消费、限流与失败冷却、邀请码 / 用户 / 设置 / 审计管理接口 |
| `voice/auth.js` | 前端鉴权层：配置、验证码刷新、Turnstile 切换、表单提交、头像前端裁剪压缩、登出 |
| `assets/js/admin-voice.js` | 运行时注入现有后台的「ZF语音」标签页（邀请码 / 用户 / 设置 / 审计） |
| `tools/migrate/voice_init_admin.mjs` | 首个管理员一次性脚本：环境变量提供密码，只产出哈希 SQL，不写死默认密码 |
| `tools/dev/voice-dev-server.mjs` | 本地完整 Worker 运行时（D1 / KV / ASSETS 适配器），绕开 wrangler dev 热重载循环 |
| `tests/voice/voice-auth.test.mjs` | 26 组单元 + 集成测试，用真实 SQLite 执行仓库 schema |

修改（全部为最小追加）：

- `src/index.js`：加 1 行 import + `worker.fetch` 里 4 行 `/api/voice/` 分发；`handleAPI` 所有既有分支零改动。
- `voice/index.html`：验证码按钮改为图片容器、加错误提示区与 Turnstile 容器、设置抽屉加「退出登录」、引入 `auth.js`。
- `voice/voice.css`：验证码样式（`object-fit: fill` 保证 5 位数字不被裁切）、错误提示、Turnstile 容器。
- `voice/voice.js`：删除阶段 1 的占位表单逻辑，接 `VoiceAuth`；新增 `showApp / showAuth / bindLogout`；用户条支持真实头像与显示名。
- `admin/index.html`：末尾加 1 行 `admin-voice.js`。
- `wrangler.toml`：补 ZF语音密钥与首个管理员操作步骤的中文注释（不改任何现有配置值）。
- `package.json`：加 `voice:d1` / `voice:d1:local` / `voice:init-admin` / `voice:dev` / `voice:test` 五个脚本。
- `.assetsignore`：排除 `tests/`；`tools/.gitignore`：排除本地开发数据库、头像目录、凭据文件与管理员初始化 SQL。

**数据库迁移与首个管理员（线上，按顺序）**

```powershell
npm run voice:d1                       # 1. 执行 schema/0003_voice.sql
$env:VOICE_ADMIN_USERNAME = "admin"
$env:VOICE_ADMIN_PASSWORD = "一段强密码"
npm run voice:init-admin               # 2. 生成 tools/migrate/voice_admin_init.sql（只含哈希）
npx wrangler d1 execute zfsn-db --remote --file=./tools/migrate/voice_admin_init.sql
Remove-Item tools/migrate/voice_admin_init.sql   # 3. 用完即删
npx wrangler secret put VOICE_CAPTCHA_SECRET    # 4. 建议配置；不配也能跑
# 后台切 Turnstile 时才需要：
npx wrangler secret put TURNSTILE_SECRET_KEY
```

**如何本地运行（推荐）**

```bash
npm run voice:dev      # node --no-warnings tools/dev/voice-dev-server.mjs → http://127.0.0.1:8790
```

启动时会打印**本次随机生成**的本地管理员密码与一个不限次数的测试邀请码（仅本机、仅 tools/dev 下、已 gitignore）。打开 `http://127.0.0.1:8790/voice/` 注册登录，打开 `http://127.0.0.1:8790/admin/` 用主站后台账号 `ZFSN` + 同一密码登录，即可看到「ZF语音」标签页。这个脚本直接加载 `src/index.js`，等价于一个完整 Worker 运行时，因此现有 API、静态页、`_headers` 语义都一致；**不部署、不对公网开放**。

`wrangler dev` 在本机的无限 reload 循环（阶段 1 已知限制第 2 条）依然存在于官方工具里，但阶段 2 起不再阻塞本地验证。

**如何测试**

| 检查 | 命令 / 结果 |
|---|---|
| 单元 + 集成测试 | `npm run voice:test` → **26 通过 / 0 失败**（真实 SQLite 执行 `0001` + `0003`，覆盖校验、验证码一次性/过期/错误即作废、邀请码过期/删除/上限/多人复用、注册登录 Cookie、失败冷却、CSRF、XSS、头像魔数、管理接口、审计、路由不干扰） |
| 阶段 1 回归 | `node tests/voice/voice-entry.test.mjs` → 4 组断言通过 |
| 语法与配置 | 10 个 JS 文件 `node --check` 全通过；`package.json` / `wrangler.toml` 解析通过 |
| Worker 构建 | `wrangler deploy --dry-run` → 成功，11302 个 assets，Worker 101.98 KiB / gzip 27.04 KiB；bundle 内确认包含 `handleVoiceAPI` |
| 真实 HTTP 端到端 | 通过本地运行时跑完「注册 201 + HttpOnly Cookie → `/me` → logout 失效 → 后台登录取令牌 → 邀请码增查删 → 用户搜索/改角色 → 设置/审计」，15 项全通过 |
| 页面渲染 | 无头 Chrome：登录页验证码 5 位数字完整显示、无错误提示；`?preview=1&channel=cf-lobby` 三栏 + 大画面布局正常；`/admin/` DOM 确认注入 `data-tab="voice"` 与 `pane-voice` |
| 页面 / 资源可达 | `/voice`、`/voice/`、`/voice/index.html`、`/admin`、`/admin/`、`/voice/auth.js`、`/assets/js/admin-voice.js`、`/api/health`、`/api/voice/config` 全部 200 |

**手动验收清单（对应需求第 10 条中阶段 2 相关项）**

1. 用有效邀请码注册；过期 / 已删除 / 超上限的码被拒；同一个码可注册多人。
2. 验证码错误 / 过期 / 重复使用都被拒，刷新后可用；不传头像时显示用户名首字 + 稳定底色的默认头像。
3. 两个浏览器用不同账号登录，各自 `/me` 显示正确身份；登出后会话立即失效。
4. 后台可创建（设有效期与上限）、复制（创建时明文，存 sessionStorage）、删除邀请码，查看使用记录。
5. 后台可搜索用户、改角色、禁用 / 启用、重置密码（改密后旧会话失效）、删除账号；审计日志记录全部关键操作。
6. 后台关闭注册后，注册接口返回「当前未开放注册」；切 Turnstile 但未配密钥时服务端明确拒绝。

**与方案的偏差 / 设计取舍（写清楚，避免后续误判）**

1. **密码用 PBKDF2-SHA512（100000 轮）而非 argon2id / scrypt**：Workers 的 WebCrypto 只提供 PBKDF2，且迭代数有 100000 硬上限；复用 `L.hashPassword` 与主站管理员哈希同构，避免引入不兼容实现。密钥派生结果带 salt 与轮数，可平滑调整。
2. **邀请码库里只存 SHA-256 与掩码，明文只在创建响应里返回一次**；后台「复制」依赖 sessionStorage 缓存本次会话创建的码，历史码只能看使用记录或重新分发。这样数据库泄露也不会直接给出可用邀请码。
3. **验证码是服务端生成的 SVG**（5×7 点阵数字，不是 `<text>`，SVG 源码里不含明文答案），因为 Workers 没有 Canvas / 图像库；答案只存 `SHA-256(id|答案|站点盐)`，D1 原子条件 UPDATE 保证「答错或用过后立即作废」。KV 最终一致会破坏一次性，因此按方案放 D1。
4. **头像由前端 canvas 居中裁正方形并压到 256px（webp，Safari 回退 jpeg）**，服务端独立校验真实文件魔数与 2MB 上限、只存 KV 引用。Workers 无法做服务端图像处理，故采用需求允许的「前端裁剪」路径。
5. **管理接口双通道鉴权**：现有后台的 `X-Admin-Token` 或 ZF语音管理员的 HttpOnly Cookie；带令牌的跨源管理请求放宽 Origin（令牌无法被跨站脚本读取），纯 Cookie 写请求严格同源校验。
6. `?preview=1` 保留为纯布局预览（阶段 3 接真实频道后移除 mock），但**不再代表登录态**；真实流程一律由 `/api/voice/me` 决定显示登录壳还是应用。

**已知限制**

1. 语音通话、频道成员状态、屏幕共享仍是 mock；对应阶段 3 / 4 / 5 / 6。频道列表 `/api/voice/channels` 等接口尚未实现。
2. 「登录后应用视图」的浏览器截图尚未单独验收（无头浏览器不便注入 HttpOnly Cookie）；它与 `?preview=1` 共用 `renderAll()`，差异仅在用户条的真实显示名 / 头像，已由代码与 `/me` 端到端验证覆盖，阶段 3 做完整浏览器验收时一并补上。
3. 后台标签页的数据加载已通过 HTTP 端到端验证，但「带登录态的后台页面截图」未单独截取（需先在后台登录）。
4. 未执行 `git commit` / `wrangler deploy` / 线上 D1 迁移；工作区原有未提交改动保持原样。本地 `tools/dev/.voice-dev.sqlite` 等数据文件已 gitignore。
5. 自建频道、DO 信令、TURN、Cloudflare Realtime SFU、LiveKit 部署包、屏幕共享均按里程碑留到后续阶段，编码前会再次逐条复核官方文档。

---

### 阶段 3 ~ 7（已完成 · 2026-11-14）

> **架构约束修正（用户提供，优先级高于前文所有内容）**：
> 「服务器的后端应该部署在 Cloudflare 的 Worker 里，我的电脑只负责添加私有频道。」
> 因此第 2.1 / 2.2 节里「用户电脑运行自建 SFU 作为常规后端」的描述已作废：
> **生产后端 = 一个 Cloudflare Worker + Durable Object + D1 + KV + Realtime SFU / TURN**；
> 用户电脑只是浏览器客户端。私有频道 = D1 记录 + 可见性 / 加入口令，媒体仍走 Cloudflare SFU。
> `self_hosted_servers` / `LiveKitTransport` 降级为**可选高级模式**，默认关闭。

#### 交付文件清单（阶段 3~7）

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/voice-room.js` | 新增 | `VoiceRoomDO`：WebSocket Hibernation、成员状态、信令中继、踢人 / 禁言、设置实时下发、内部 HTTP 接口 |
| `src/voice-realtime.js` | 新增 | 频道 / 私有频道 / 加入票据 / SFU 代理 / TURN / LiveKit JWT / 测试连接 / 后台频道与服务器管理 |
| `src/voice-core.js` | 重写扩充 | 房间票据 HMAC、音质预设、屏幕上限、`clampShareRequest`、重做 SVG 验证码（网格 / 空心字 / 干扰线 / 旋转 / 波浪 / 噪点） |
| `src/voice-auth.js` | 修改 | 导出 `currentUser` / `audit`；系统设置加 `allowUserPrivateChannels` / `maxPrivateChannelsPerUser` |
| `src/index.js` | 修改 | 导出 `VoiceRoomDO`、WebSocket 房间路由（Worker 侧先验票据）、实时模块优先分发 |
| `wrangler.toml` | 修改 | `VOICE_ROOM` 绑定、`v1` 迁移（`new_sqlite_classes`）、密钥清单注释 |
| `schema/0003_voice.sql` | 重写扩充 | `channels` 增可见性 / 口令 / owner；新增 `voice_sfu_sessions`；预置 3 个 Cloudflare 频道与默认设置 |
| `voice/transport.js` | 新增 | `VoiceRoomClient` + `Base` + `Mesh` + `Cloudflare` + `LiveKit` 四种实现，统一 `VoiceTransport` 接口 |
| `voice/voice.js` | 重写 | 真实 bootstrap / join / leave、房间事件、成员音量、踢人禁言、屏幕共享、PTT、设备枚举、私有频道创建 |
| `voice/index.html` | 重写 | 真实 `<video>` 共享画面、画质 / 音量、私有频道对话框（含混合内容字段）、设备与音频设置 |
| `voice/voice.css` | 扩充 | `[hidden]` 统一修复、媒体容器、私有徽标、成员单独音量、chip 控件 |
| `voice/auth.js` | 修改 | 初始化时预生成两份验证码；切换标签不再重复消耗挑战 |
| `voice/vendor/livekit-client.umd.js` | 新增 | 仅高级模式按需加载的 LiveKit UMD SDK |
| `assets/js/admin-voice.js` | 重写 | 自带 `call()`（不再依赖 IIFE 内的 `window.api`）、频道 CRUD / 排序 / 音质 / 屏幕上限、自建服务器、私有频道开关；每面板独立 catch |
| `tools/dev/voice-dev-server.mjs` | 修改 | 本地 DO + 真实 WebSocket 适配；支持 `VOICE_DEV_DB` / `VOICE_DEV_MEDIA` / `VOICE_DEV_CRED` 隔离 |
| `tools/dev/cdp.mjs` | 修改 | 增加 CDP 事件订阅，收集 JS 异常 / console.error |
| `tools/dev/captcha-reference/` | 新增 | Wikimedia Commons 人机验证样例（设计比对用，不参与运行） |
| `tests/voice/voice-realtime.e2e.mjs` | 新增 | 27 项端到端（隔离端口 / 独立 SQLite / 真实 HTTP + WebSocket） |
| `tests/voice/voice-ui.cdp.mjs` | 新增 | 10 项无头浏览器复验（登录页、验证码、后台面板、主站入口） |
| `docs/voice-deploy.md` | 新增 | 中文部署文档（资源 / 密钥 / 迁移 / SFU / TURN / 私有频道 / 可选 LiveKit / 排障 / 回滚） |
| `docs/voice-manual-test.md` | 新增 | 端到端手动测试清单（A~G 共 60+ 项） |
| `tools/livekit/` | 新增 | 可选高级模式部署包：`livekit.example.yaml`、`start.bat`、`start.ps1`、`.env.example`、中文 `README.md` |
| `package.json` / `tools/.gitignore` | 修改 | 新增 `voice:test:*` 脚本；忽略含密钥的 `livekit.yaml` / `.env` |

#### 新增 API（`src/voice-realtime.js` 拥有）

| 路径 | 方法 | 说明 |
|---|---|---|
| `/api/voice/bootstrap` | GET | 一次性返回用户、可见频道、系统开关、`capabilities` |
| `/api/voice/channels` | GET / POST | 频道列表 / 添加私有频道（用户电脑只做这件事） |
| `/api/voice/channels/:id/join` | POST | 校验可见性 / 口令 / 人数上限，签发 5 分钟房间票据，返回 wsUrl / ICE / 设置 / transport |
| `/api/voice/rtc/ice` | GET | STUN + 可选短期 TURN 凭据 |
| `/api/voice/rtc/session` | POST | 代理 `POST /apps/{appId}/sessions/new`，落 `voice_sfu_sessions` |
| `/api/voice/rtc/tracks` | POST | 代理 `tracks/new` / `update` / `renegotiate` / `close` / `inspect`，先校验 session 归属 |
| `/api/voice/rtc/livekit-token` | POST | 可选高级模式：Worker 签发 1 小时 HS256 JWT |
| `/api/voice/servers/test` | POST | 服务端探测信令地址；先做混合内容 / 纯 IP 证书中文校验 |
| `/api/voice/admin/channels` | GET / POST | 后台频道列表 / 新建 |
| `/api/voice/admin/channels/:id` | PATCH / DELETE | 改设置 → `revision + 1` → DO 广播；删除同时清 `channel_settings` 与 `voice_sfu_sessions` |
| `/api/voice/admin/channels/reorder` | POST | 排序 |
| `/api/voice/admin/servers` | GET / POST / DELETE(:id) | 可选自建服务器配置；删除时频道自动回落 Cloudflare |
| `/api/voice/admin/kick` `/mute` | POST | 通过 DO 下发给在线客户端并写审计 |

#### 媒体链路（官方文档复核结果）

- Connection API base `https://rtc.live.cloudflare.com/v1`，`Authorization: Bearer <APP_SECRET>`
- `POST /apps/{appId}/sessions/new`
- `POST /apps/{appId}/sessions/{sid}/tracks/new`
  发布 `{"sessionDescription":{"type":"offer","sdp":"..."},"tracks":[{"location":"local","mid":"...","trackName":"audio"}]}`；
  订阅 `{"tracks":[{"location":"remote","sessionId":"...","trackName":"..."}]}`
- `PUT .../tracks/update` / `PUT .../renegotiate` / `PUT .../tracks/close` / `GET .../sessions/{sid}`
- TURN：`POST /v1/turn/keys/{keyId}/credentials/generate-ice-servers`，`{"ttl":3600}` → `iceServers`
- DO：`state.acceptWebSocket(ws)`、`ws.serializeAttachment()`、`webSocketMessage/Close/Error`、`state.getWebSockets()`
- `wrangler.toml` 迁移改用官方文档推荐的 `new_sqlite_classes`（2026 版）

#### 本阶段修掉的真实问题

1. `admin/index.html` 主脚本整体包在 IIFE，`function api()` 不挂 `window`；
   旧 `admin-voice.js` 调 `window.api` 导致五个面板永久「加载中…」。
   → 新版自带 `call()`，逐面板 catch 并显示具体错误。CDP 复验 10/10 通过。
2. 后台删频道 SQL 写成 `DELETE FROM channel_settings WHERE id = ?`，
   而该表主键是 `channel_id` → 整条接口 500 且残留孤儿配置。已修并加入回归断言。
3. `signRoomTicket` 用 `n: randomHex` 覆盖了显示名字段 `n` → 改为 `nonce`。
4. `bind.apply(null, args)` → `bind(...args)`。
5. `src/voice-core.js` 重做验证码时多余引号导致 `SyntaxError`，已修。
6. 隐藏的注册页验证码一直「加载中…」→ 初始化预生成两份、切换标签不重复申请。
7. Worker 侧转发 WebSocket 前未校验票据 → 按官方建议先 `verifyRoomTicket`，DO 内再校验一次（纵深防御）。
8. `hidden` 与 `display:grid/flex` 冲突 → CSS 统一 `[hidden]{display:none!important}`。

#### 验证结果

| 检查 | 结果 |
|---|---|
| 阶段 1 回归 | `voice-entry.test.mjs` 4/4 |
| 阶段 2 回归 | `voice-auth.test.mjs` 26/26（真实 SQLite） |
| 阶段 3~7 端到端 | `voice-realtime.e2e.mjs` **27/27**：注册登录、私有频道可见性 / 口令、混合内容中文提示、真实双用户 WebSocket、信令转发、成员状态广播、后台音质实时下发、频道 CRUD / 排序 / 删除无孤儿、踢人禁言、SFU 未配置 503、越权 403、CSRF、审计、屏幕上限夹取 |
| 无头浏览器 | `voice-ui.cdp.mjs` **11/11**：登录壳、主站入口、两份 SVG 验证码、点击刷新、注册字段、**带 HttpOnly Cookie 的登录后三栏应用视图**、后台五面板全部加载完成、无 JS 异常 |
| 截图 | `tools/dev/_shots/voice-login-captcha.png`、`voice-app-view.png`、`admin-voice-panels.png` |
| 语法 / 配置 | 全部新增与修改的 JS `node --check` 通过；`package.json` / `wrangler.toml` 解析通过 |
| Worker 构建 | `wrangler deploy --dry-run` 成功：11323 assets，Worker 154.31 KiB / gzip 39.43 KiB，绑定列出 `env.VOICE_ROOM (VoiceRoomDO)` |

#### 如何本地运行 / 测试

```bash
npm run voice:dev            # http://127.0.0.1:8790，打印本地管理员密码与测试邀请码
npm run voice:test:all       # 4 套测试一次跑完（UI 测试需 dev server 已在 8790 运行）
npx wrangler deploy --dry-run
```

线上部署步骤、密钥清单、私有频道说明、可选 LiveKit 部署包、故障排查与回滚
见 `docs/voice-deploy.md`；人工验收见 `docs/voice-manual-test.md`。

#### 已知限制（阶段 7 收尾时的真实状态）

1. **未执行 `git commit` / `wrangler deploy` / 线上 D1 迁移 / 生产 secrets 注入**，
   工作区原有未提交改动保持原样；所有验证均在本地运行时完成。
2. 本地未配置 SFU / TURN 密钥，多人通话走 `MeshTransport` 本地直连降级；
   **真实音频互通、真实屏幕共享、SFU 转发效果必须在配置生产密钥后按
   `docs/voice-manual-test.md` 的 B / E 组人工验收**。
3. 自制 SVG 验证码抗 OCR 能力有限，生产建议切 Cloudflare Turnstile。
4. iOS Safari 无法发起屏幕共享，界面只做中文提示，无替代方案。
5. 可选 LiveKit 高级模式只提供了 Windows 部署包与文档，未在本机实际起过
   `livekit-server.exe`（默认架构不需要它）。
6. Durable Object 使用 `new_sqlite_classes` 首次迁移；若未来从已部署的
   `new_classes` 版本升级，需要按 Cloudflare 文档另写迁移，不能直接复用 `v1`。
