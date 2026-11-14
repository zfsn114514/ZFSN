# ZF语音 部署与运维说明（中文）

> 适用版本：阶段 1~7 全部完成后（2026-11-14）。
> 相关文档：[实施方案](./voice-implementation-plan.md) · [端到端手动测试清单](./voice-manual-test.md)
> 代码位置：`src/voice-*.js`、`voice/`、`assets/js/admin-voice.js`、`schema/0003_voice.sql`

---

## 0. 先读这一节：架构约束

**生产环境的服务器后端全部运行在 Cloudflare 的 Worker 里**，具体是：

| 组件 | 用途 | 是否跑在你的电脑上 |
|---|---|---|
| Cloudflare Worker（`src/index.js`） | 全部 HTTP API、鉴权、页面分发 | ❌ |
| Durable Object `VoiceRoomDO` | 房间成员状态、信令中继、设置实时下发、踢人禁言 | ❌ |
| D1 `DB` | 用户 / 会话 / 邀请码 / 验证码 / 频道 / 设置 / 审计 | ❌ |
| KV `MEDIA` | 头像文件（项目现有存储，未额外开 R2） | ❌ |
| Cloudflare Realtime SFU | 多人音频与屏幕流转发 | ❌ |
| Cloudflare TURN | 对称 NAT / 防火墙下的媒体中继 | ❌ |
| **你的电脑** | **只是浏览器客户端，用来「添加私有频道」** | ✅ |

「私有频道」不是一台放在家里的服务器，而是 **D1 里的一条频道记录 + 可见性 / 加入口令**；
媒体依旧走 Cloudflare SFU。所以电脑关机、换网络、重装系统都不影响别人进频道。

`self_hosted_servers` 表与 `LiveKitTransport` 是**可选高级模式**：只有管理员在后台显式打开
「允许普通用户添加自建 SFU 频道」并填了 wss 域名才会用到，默认完全不启用。
需要它时才看第 9 节。

---

## 1. 前置条件

- Node.js ≥ 20（本项目用 `node:sqlite` 跑本地测试，实测 Node 22.22 通过）
- Wrangler ≥ 4（`npx wrangler --version`，实测 4.147.0）
- 一个 Cloudflare 账号，且已绑定自定义域名 `www.zfsnnb.dpdns.org`
- 已按站点既有文档完成 `npx wrangler d1 create zfsn-db` 与 KV 命名空间创建
- 本地能执行 `npx wrangler deploy`（或仓库已接 GitHub 自动构建，推 `main` 后约 1 分钟上线）

> ⚠ `wrangler.toml` 里 `name = "zfsn"` **不能改**。线上域名绑的就是这个 Worker，
> 改成别的名字会部署出一个旁支 Worker，线上看起来「改了代码没反应」。

---

## 2. 资源清单

| 资源 | 绑定名 / 名称 | 状态 | 说明 |
|---|---|---|---|
| Worker | `zfsn` | 已有 | `main = "src/index.js"` |
| Workers Assets | `ASSETS` | 已有 | `directory = "."`，靠 `.assetsignore` 排除源码 |
| D1 | `DB` / `zfsn-db` | 已有 | 只需执行新迁移 `0003_voice.sql` |
| KV | `MEDIA` / `zfsn-media` | 已有 | 头像存 `voice/avatars/<uid>.webp`，单值 ≤ 2 MB |
| Durable Object | `VOICE_ROOM` / `VoiceRoomDO` | **新增** | 迁移 tag `v1` |
| Realtime SFU App | App ID + App Secret | **新增** | 控制台 Realtime → Serverless SFU |
| TURN Key | Key ID + API Token | 可选 | 控制台 Realtime → TURN |
| Turnstile Widget | Site Key + Secret Key | 可选 | 后台可一键切换人机验证 |
| R2 | — | 不需要 | 本项目用免费版 KV，见 `wrangler.toml` 注释 |

**没有新增 Cloudflare Pages 站点，也没有新增第二个 Worker。**

---

## 3. 首次上线（按顺序执行，不要跳步）

### 3.1 建表

```bash
npm run voice:d1
# 等价于：npx wrangler d1 execute zfsn-db --remote --file=./schema/0003_voice.sql
```

脚本是 `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE`，重复执行安全。
它会建 9 张表并预置 3 个 Cloudflare 频道（`cf-lobby` / `cf-2` / `cf-3`）与默认音质 / 屏幕上限。
所有表都不碰 `messages` / `works` / `sessions` / `config` 的既有列。

### 3.2 应用 Durable Object 迁移

`wrangler.toml` 里已经写好：

```toml
[[durable_objects.bindings]]
name = "VOICE_ROOM"
class_name = "VoiceRoomDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["VoiceRoomDO"]
```

`wrangler deploy` 会自动应用这条迁移。**迁移没生效时** `env.VOICE_ROOM` 为空：
页面仍能看到频道列表，但 WebSocket 房间会返回 503「房间状态服务尚未部署」，
后台改音质也不会实时下发。上线后务必按第 3.6 节验证一次。

> 采用 `new_sqlite_classes` 是 Cloudflare 2026 官方文档对新建 DO 的推荐写法；
> 本模块从未上线过，不存在从 `new_classes` 迁移的历史包袱。

### 3.3 注入密钥

**所有保密值都用 `wrangler secret put`，绝不写进 `wrangler.toml`、不进 git、不下发浏览器。**

```bash
npx wrangler secret put VOICE_ROOM_SECRET
npx wrangler secret put VOICE_CAPTCHA_SECRET
npx wrangler secret put REALTIME_SFU_APP_ID
npx wrangler secret put REALTIME_SFU_APP_SECRET
# 可选：
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put LIVEKIT_API_KEY
npx wrangler secret put LIVEKIT_API_SECRET
```

| Secret | 必需 | 用途 | 不配置的后果 |
|---|---|---|---|
| `VOICE_ROOM_SECRET` | **强烈建议** | 房间 WebSocket 票据 HMAC 密钥 | 回落到内置常量，票据可被伪造 |
| `VOICE_CAPTCHA_SECRET` | 建议 | 验证码答案哈希的站点盐 | 回落到内置常量，抗撞库能力下降 |
| `REALTIME_SFU_APP_ID` | **线上必需** | SFU App ID | 语音降级为「本地直连（mesh）」，多人不可用 |
| `REALTIME_SFU_APP_SECRET` | **线上必需** | SFU Bearer 令牌 | 同上；页面会显示中文降级提示 |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | 可选 | 生成 1 小时短期 TURN 凭据 | 只用 `stun:stun.cloudflare.com:3478`，严格 NAT 下可能连不上 |
| `TURNSTILE_SECRET_KEY` | 可选 | 后台把人机验证切到 Turnstile | 后台切换时服务端明确拒绝，继续用自制验证码 |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | 可选 | 高级模式自建 SFU 的 JWT 签发 | 自建频道加入时报「未配置 API Key / Secret」 |

`VOICE_TURNSTILE_SITE_KEY` / `TURNSTILE_SITE_KEY` 是**公开值**，可以放 `[vars]`，前端需要它渲染组件。

生成随机密钥：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### 3.4 创建首个 ZF语音管理员

**代码里没有任何写死的默认密码。**用一次性脚本生成只含密码哈希的 SQL：

```powershell
$env:VOICE_ADMIN_USERNAME="admin"
$env:VOICE_ADMIN_PASSWORD="换成一个足够长的强密码"
npm run voice:init-admin
npx wrangler d1 execute zfsn-db --remote --file=./tools/migrate/voice_admin_init.sql
Remove-Item ./tools/migrate/voice_admin_init.sql
Remove-Item Env:VOICE_ADMIN_USERNAME, Env:VOICE_ADMIN_PASSWORD
```

`tools/migrate/voice_admin_init.sql` 已被 `.gitignore` 排除，执行完请删掉。
这个管理员既能在 `/voice` 里踢人 / 禁言，也能用 HttpOnly Cookie 调管理 API；
现有后台令牌 `X-Admin-Token` 同样被接受（双通道鉴权）。

### 3.5 部署

```bash
npx wrangler deploy --dry-run     # 先本地校验，不上传
npx wrangler deploy
```

`--dry-run` 应列出 `env.VOICE_ROOM (VoiceRoomDO) Durable Object` 绑定。
实测：Worker 154.31 KiB / gzip 39.43 KiB，静态资源约 11323 个文件。

### 3.6 上线后自检（照着跑一遍）

```bash
curl -i https://www.zfsnnb.dpdns.org/api/health
curl -i https://www.zfsnnb.dpdns.org/api/voice/config
curl -i https://www.zfsnnb.dpdns.org/api/voice/bootstrap
curl -i https://www.zfsnnb.dpdns.org/voice
```

- `/api/health` → 200
- `/api/voice/config` → 200，`captchaMode: "image"`
- `/api/voice/bootstrap` → 200，`capabilities.worker = true`、`durableObject = true`、
  配置了 SFU 后 `sfu = true`
- `/voice` → 200，`Content-Type: text/html; charset=utf-8`（无扩展名页面必须带 charset，否则中文乱码）

再打开 `/admin/` → 「ZF语音」标签页，五个面板都应显示真实数据而不是「加载中…」。

---

## 4. Cloudflare Realtime SFU（线上多人通话）

### 4.1 创建 App

1. Cloudflare Dashboard → **Realtime → Serverless SFU（Calls SFU）** → Create App
2. 复制 **App ID** 与 **App Secret**
3. 分别执行 `wrangler secret put REALTIME_SFU_APP_ID` / `REALTIME_SFU_APP_SECRET`

### 4.2 代码里的调用链（已按官方文档核对）

Base URL `https://rtc.live.cloudflare.com/v1`，统一带
`Authorization: Bearer <APP_SECRET>` 与 `Content-Type: application/json`。
密钥只在 Worker 里，浏览器拿到的是 Worker 代理后的结果。

| 操作 | 方法与路径 | 本项目入口 |
|---|---|---|
| 创建会话 | `POST /apps/{appId}/sessions/new` | `POST /api/voice/rtc/session` |
| 发布 / 订阅轨道 | `POST /apps/{appId}/sessions/{sid}/tracks/new` | `POST /api/voice/rtc/tracks`（`op=new`） |
| 更新轨道 | `PUT /apps/{appId}/sessions/{sid}/tracks/update` | `op=update` |
| 提交 renegotiation answer | `PUT /apps/{appId}/sessions/{sid}/renegotiate` | `op=renegotiate` |
| 关闭轨道 | `PUT /apps/{appId}/sessions/{sid}/tracks/close` | `op=close` |
| 查询会话 | `GET /apps/{appId}/sessions/{sid}` | `op=inspect` |

发布请求体：

```json
{
  "sessionDescription": { "type": "offer", "sdp": "<本地 SDP>" },
  "tracks": [{ "location": "local", "mid": "<transceiver.mid>", "trackName": "audio" }]
}
```

订阅请求体：

```json
{
  "tracks": [{ "location": "remote", "sessionId": "<发布者 sessionId>", "trackName": "audio" }]
}
```

`voice_sfu_sessions` 表记录 sessionId 归属，`tracks/*` 接口先查这张表，
防止有人拿别人的 `sessionId` 越权关闭轨道（端到端测试有覆盖）。

### 4.3 TURN

Dashboard → Realtime → TURN → Create Key，把 **Key ID** 和 **API Token** 写入 secrets。
Worker 在 `/api/voice/rtc/ice` 与加入频道时调用：

```
POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers
Authorization: Bearer <TURN_KEY_API_TOKEN>
{"ttl": 3600}
```

响应里的 `iceServers`（含短期 `username` / `credential`）直接下发给浏览器；
**长期 TURN Key 永不下发**。未配置时只返回 `stun:stun.cloudflare.com:3478`。

> 官方提示：若不使用 trickle ICE，建议过滤掉 53 端口的 TURN URL，否则会等待超时。

---

## 5. 路由与静态资源白名单（很容易踩坑）

`wrangler.toml` 的 `run_worker_first` 是**路径白名单**，不是全局开关。
新增无扩展名 HTML 页面必须同时加进去，否则请求不经过 Worker：

```toml
run_worker_first = [
  ...,
  "/voice", "/voice/", "/voice/index.html", "/voice.html"
]
```

`_headers` 里也必须为这几个路径写 `Content-Type: text/html; charset=utf-8`。

**不要改成全局 `run_worker_first = true`**：本项目实测全局开启会让 `_headers`
的图片长缓存规则失效，图片退回 `max-age=0, must-revalidate`。

`assets.directory = "."` 意味着整个仓库都会被当静态资源上传，
所以 `.assetsignore` 已排除 `src/`、`schema/`、`tools/`、`tests/`、`*.bat`、`*.ps1`。
新增部署脚本放 `tools/livekit/` 下是安全的。

---

## 6. 私有频道：用户电脑到底做什么

在 `/voice` 左栏点「+」→ 填频道名称、简介、可见范围、加入口令 → 保存。
浏览器只发一个 `POST /api/voice/channels`，Worker 在 D1 里写一条记录：

- `visibility = private`，`owner_id = 当前用户`，`allowed_users = [当前用户]`
- `password_hash` 为 `SHA-256("zfch|频道id|口令")`，不存明文
- `backend = cloudflare` —— **仍然是 Cloudflare SFU**
- 自动建一条默认 `channel_settings`

其他用户看不到这个频道，也 join 不了；管理员在后台能看到并改设置。
系统设置里「允许普通用户创建私有频道」「每人私有频道上限（默认 10）」可随时调整。

> 「测试连接」按钮只对**可选的自建后端**有意义；默认 Cloudflare 频道没有需要探测的地址。

---

## 7. 人机验证：自制验证码 ↔ Turnstile

- 默认：服务端生成 5 位 SVG 图片验证码（网格底纹、空心字符、贯穿干扰线、
  逐字旋转、波浪形变、噪点、轻模糊）。答案只存
  `SHA-256(id|答案|站点盐)`；D1 原子条件 `UPDATE` 保证「一次性、2 分钟过期、答错即作废」。
- 切换：后台「ZF语音」→ 验证方式选 `Cloudflare Turnstile` → 保存。
  未配置 `TURNSTILE_SECRET_KEY` 时服务端会拒绝切换并给出中文提示。
- 两种方式对前端是同一套接口（`voice/auth.js` 的 `humanPayload()`），
  注册与登录都走同一条校验路径。
- 注册 / 登录都有 IP + 用户名双维度限流与递增冷却。

SVG 参考图收集在 `tools/dev/captcha-reference/`（Wikimedia Commons 样例），
仅用于设计比对，不参与运行。

---

## 8. 安全清单

| 项 | 实现 |
|---|---|
| 会话 | HttpOnly + Secure + SameSite=Lax Cookie；库里只存 token 的 SHA-256 |
| 密码 | PBKDF2-SHA512 **100000 轮**（Workers WebCrypto 硬上限，超过会抛错） |
| CSRF | 所有写接口校验 `Origin` 同源；带 `X-Admin-Token` 的跨源管理请求才放宽 |
| XSS | 显示名 / 频道名服务端拒绝 `< >`，前端一律 `esc()` 后插入 DOM |
| SQL 注入 | 全部参数化 `prepare().bind()`，无字符串拼接用户输入 |
| 上传 | 头像前端裁 256px，服务端独立校验真实魔数（jpg/png/webp）与 2 MB |
| 房间票据 | HMAC 签名 + 5 分钟过期 + 频道绑定；**Worker 与 DO 双重校验** |
| SFU 越权 | `voice_sfu_sessions` 校验 sessionId 归属 |
| 密钥 | 全部 `wrangler secret put`，前端永远拿不到长期密钥 |
| 审计 | 注册 / 登录 / 邀请码 / 频道配置 / 踢人 / 禁言 / 设置变更均写 `audit_logs` |
| 限流 | 注册、登录、验证码、加频道、加房间、SFU 操作各有独立窗口 |

---

## 9. 可选高级模式：自建 LiveKit SFU

> **默认不需要。**只有当你要把媒体服务器放在自己电脑上时才读这一节。
> 后台默认关闭「允许普通用户添加自建 SFU 频道」。

### 9.1 为什么必须用 wss 域名

HTTPS 页面里的浏览器会**直接拦截 `ws://`**（混合内容），而纯 IP 地址几乎申请不到
受信任的 TLS 证书。所以添加频道对话框里对 `ws://IP`、纯 IP + TLS、
带 `http://` 前缀等输入，都会返回明确中文错误，并给出三条可行路径：

1. **Cloudflare Tunnel**（推荐）：把本机 7880 映射成 `wss://voice.example.com`，
   不用公网 IP、不用端口转发、证书由 Cloudflare 管。
2. 域名 + DDNS + Let's Encrypt 证书，路由器转发 443 / 7880。
3. 仅本机调试用 `localhost`（浏览器对 localhost 放行混合内容限制）。

### 9.2 端口与防火墙

| 用途 | 协议 / 端口 | 说明 |
|---|---|---|
| 信令 | TCP **7880**（HTTP/WebSocket），TLS 时常用 **7443** 或由 Tunnel 终结 | Tunnel 方案只需本机监听 7880 |
| HTTP 健康检查 | TCP 7880 | `/api/voice/servers/test` 探测的就是它 |
| TCP 回退（TURN/TLS） | TCP **443** / **5349** | 严格防火墙下媒体走 TLS |
| 媒体 | UDP **50000–60000**（可缩小到 50000–50100） | 必须在路由器做端口转发；Tunnel 方案改用 Cloudflare TURN |
| ICE/STUN | UDP **3478** | 可用 Cloudflare TURN 替代 |

路由器：把上表端口转发到运行 LiveKit 的机器内网 IP；Windows 防火墙入站规则放行
`livekit-server.exe` 或对应端口。UDP 不通的典型症状是「能进频道但互相听不到」。

### 9.3 部署包

目录 `tools/livekit/`：

| 文件 | 作用 |
|---|---|
| `livekit.example.yaml` | 配置模板，含开发密钥占位、端口范围、日志级别 |
| `start.bat` | 双击启动（CMD），读 `.env` 里的 API Key / Secret |
| `start.ps1` | PowerShell 版，参数与 `.bat` 一致 |
| `README.md` | 中文安装、Tunnel、端口转发、防火墙分步说明 |

**密钥分工**：LiveKit 自己的 API Key/Secret 填在部署包里；
Worker 侧另外用 `wrangler secret put LIVEKIT_API_KEY` /
`LIVEKIT_API_SECRET` 配一份**相同的值**，Worker 用它签发 1 小时短期 JWT。
浏览器只拿 JWT，永远拿不到 API Secret。

### 9.4 在后台启用

1. `wrangler secret put LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`
2. 后台「ZF语音」→ 系统设置 → 打开「允许普通用户添加自建 SFU 频道」
3. 在「自建服务器」面板添加域名（必须是 `wss` 可用域名，不能是纯 IP）
4. 添加频道时后端选「自建 SFU」，点「测试连接」看延迟与中文提示
5. 自建服务不可达时频道显示「离线」，**不影响其他 Cloudflare 频道**

---

## 10. 性能、兼容与无障碍

- 设计容量：单频道 10~20 人同时在线；屏幕共享观看者靠 SFU 转发，不点对点
- 音质：后台可设 Opus 码率 16~128 kbps、采样率、单/双声道、DTX、FEC、帧时长；
  屏幕共享上限为分辨率 / 帧率 / 码率 / 同时共享人数，前端 `clampShareRequest()`
  会把用户选择夹到上限内
- 修改设置后 `channels.revision + 1`，Worker 通过 DO 向在线客户端广播 `settings`
- 兼容：最新版 Chrome / Edge / Firefox / Safari 桌面；手机浏览器可语音 + 观看共享
- **iOS Safari 无法发起屏幕共享**，界面会给出中文提示；`getDisplayMedia` 被拒绝时同理
- 关键按钮都有 `aria-label`，抽屉 / 对话框支持键盘操作，
  `prefers-reduced-motion` 下关闭动效
- 断线自动重连，界面显示连接状态、延迟与丢包

---

## 11. 本地开发与测试

`wrangler dev` 在本机会因 `assets.directory = "."` 监视整个仓库、
加上 `.wrangler/state` 的 SQLite 写入，形成「写库 → reload → 再写库」的无限热重载。
因此项目自带一个直接加载 `src/index.js` 的完整 Worker 运行时：

```bash
npm run voice:dev                  # http://127.0.0.1:8790
```

启动时会打印**本次随机生成**的本地管理员密码与不限次数测试邀请码（仅本机、`tools/dev/` 下、已 gitignore）。
它用 `node:sqlite` 做 D1 适配器、本地目录做 KV、并复用线上同一个 `VoiceRoomDO` 类，
所以 SQL、Cookie、WebSocket 房间逻辑都与线上一致。

| 命令 | 覆盖 |
|---|---|
| `npm run voice:test` | 阶段 2 账号 / 邀请码 / 验证码，26 项（真实 SQLite） |
| `npm run voice:test:e2e` | 阶段 3~7 端到端，27 项（独立端口 + 独立库 + 真实 WebSocket） |
| `npm run voice:test:ui` | 无头 Chrome 复验登录页 / 验证码 / 登录后应用视图 / 后台面板，11 项 |
| `npm run voice:test:all` | 上面四项一次跑完 |
| `npx wrangler deploy --dry-run` | Worker 构建与绑定校验 |

`voice:test:ui` 需要本机装有 Chrome / Edge，且 `npm run voice:dev` 已在 8790 运行。

---

## 12. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| `/voice` 404 或返回目录列表 | 没加进 `run_worker_first` 白名单 | 按第 5 节补 `wrangler.toml` |
| `/voice` 中文乱码 | `_headers` 缺 charset | 补 `Content-Type: text/html; charset=utf-8` |
| 后台「ZF语音」面板一直「加载中…」 | 旧版脚本依赖 `window.api`（主脚本是 IIFE，`api` 不挂 window） | 已修：新版 `admin-voice.js` 自带 `call()`，每个面板独立 catch 并显示错误 |
| 加入频道提示「房间状态服务尚未部署」 | DO 迁移 `v1` 未生效 | 重新 `wrangler deploy`，在 Dashboard 确认 `VOICE_ROOM` 绑定 |
| 页面显示「本地直连降级模式」 | 未配 `REALTIME_SFU_APP_ID` / `REALTIME_SFU_APP_SECRET` | `wrangler secret put` 后重新部署 |
| 能进频道但互相听不到 | TURN / UDP 不通，或浏览器拒绝麦克风权限 | 配 TURN Key；检查 HTTPS 与权限；看页面连接质量 |
| 登录报「密码校验配置异常」 | PBKDF2 迭代数 > 100000 | `wrangler.toml` 里保持 `PBKDF2_ITERATIONS = 100000` |
| 后台切 Turnstile 被拒 | 缺 `TURNSTILE_SECRET_KEY` | 注入后再切 |
| 自建频道加不进去 | `ws://` 混合内容 / 纯 IP 无证书 | 按第 9 节改 Cloudflare Tunnel + wss 域名 |
| 改了音质在线客户端没变 | DO 迁移未生效或 WS 断开 | 看 `bootstrap.capabilities.durableObject`；刷新页面重连 |

---

## 13. 回滚

ZF语音是**独立目录 + 独立路由 + 独立表**，不影响主站：

1. 从 `wrangler.toml` 移除 `VOICE_ROOM` 绑定与迁移（或回滚到旧版 Worker）
2. 删除 `run_worker_first` 里的 4 个 voice 路径、`_headers` 对应规则
3. 从各页面 body 末尾删掉 `<script src="/assets/js/voice-entry.js"></script>`
4. D1 里的 `voice_*` / `channels` / `channel_settings` / `invite_*` / `captcha_*` /
   `audit_logs` 表可保留（不影响现有业务），确认无用后再手动删

---

## 14. 官方参考（编码前逐条核对，2026-11-14 复核）

- Realtime SFU Connection API — <https://developers.cloudflare.com/realtime/sfu/api/>
- 浏览器 / 后端连接 recipe — <https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/>
- TURN 短期凭据 — <https://developers.cloudflare.com/realtime/turn/generate-credentials/>
- Durable Objects WebSocket Hibernation — <https://developers.cloudflare.com/durable-objects/best-practices/websockets/>
- Workers Assets / `run_worker_first` — <https://developers.cloudflare.com/workers/static-assets/>
- `wrangler secret put` — <https://developers.cloudflare.com/workers/wrangler/commands/#secret>
- D1 迁移 — <https://developers.cloudflare.com/d1/wrangler-commands/>
- Turnstile — <https://developers.cloudflare.com/turnstile/get-started/>
- LiveKit Server（可选高级模式） — <https://docs.livekit.io/home/self-hosting/local/>
