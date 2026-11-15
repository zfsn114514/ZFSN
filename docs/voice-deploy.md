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
- 创建 SFU App / TURN Key 的账号 API — <https://developers.cloudflare.com/api/resources/calls/subresources/sfu/methods/create/>

---

## 15. 实际上线记录（2026-11-14，北京时间）

| 项目 | 结果 |
|---|---|
| Worker | `zfsn` 已部署，最终版本 `2eb19ec6-7e28-40cc-85cd-7625c644226d`，154.38 KiB / gzip 39.46 KiB |
| D1 | `zfsn-db` 远程执行 `schema/0003_voice.sql`，共 20 张表；首个管理员 `admin` 已创建 |
| Durable Object | `env.VOICE_ROOM (VoiceRoomDO)` 绑定生效，`new_sqlite_classes` 迁移 `v1` 已应用 |
| Secrets | `VOICE_ROOM_SECRET`、`VOICE_CAPTCHA_SECRET` 已注入（明文不落仓库） |
| 页面 | `/voice`、`/voice/` 200；主站 `/`、`/admin/`、`/api/health`、`/pvz/pvz-portable` 均 200，主站未受影响 |
| 接口 | `/api/voice/config` 200；线上管理员登录、bootstrap（3 个预置频道）、join 票据签发全部通过 |
| WebSocket | `wss://www.zfsnnb.dpdns.org/api/voice/room/:id/ws` 返回 **101 Switching Protocols** |

线上验证用的临时验证码挑战与测试会话已删除；`tools/migrate/voice_admin_init.sql`
（含密码哈希）执行后已删除。

### 15.1 上线时修掉的真实缺陷

`src/index.js` 的 default export 有一层统一 CORS 包装，会把 `worker.fetch` 的结果用
`new Response(response.body, { status: response.status, ... })` 重建。Cloudflare Workers
运行时**不允许构造 `status: 101`**（只允许 200~599），于是 Durable Object 的 WebSocket
升级响应被重建时抛 `RangeError`，客户端拿到 500（`error code: 1101`）。

修复：包装层遇到 101 / 带 `webSocket` 的响应直接原样返回：

```js
if (response.status === 101 || response.webSocket) return response;
```

本地 `tools/dev/voice-dev-server.mjs` 用自己的 upgrade handler，不走这层包装，
所以这个缺陷只有在线上验证时才暴露——**新增 WebSocket 路由后必须做一次线上升级验证**。

### 15.2 仍需账号持有人处理（可选，不影响当前可用）

Cloudflare Realtime（Serverless SFU / TURN）要求先在控制台
**Activate Cloudflare Realtime** 并绑定支付方式 / 账单信息（基础费 $0/月，按量计费）。
这一步涉及个人支付信息，只能由账号持有人本人完成。

**未激活不影响当前使用**：`join` 返回 `transport: mesh`，2~3 人语音和屏幕共享走浏览器
点对点直连；十几人同频道或严格 NAT 环境才真正需要 SFU 转发。

激活后补齐（API 需要带 `Calls Write` 权限的 **API Token**，Wrangler 的 OAuth token
直接调用 `api.cloudflare.com` 会返回 10000 认证错误，建议用控制台创建）：

1. 控制台 Realtime 创建 SFU App，或 `POST /accounts/{account_id}/calls/apps` 拿 `uid` 与 `secret`
2. `printf '%s' "$APP_ID" | npx wrangler secret put REALTIME_SFU_APP_ID`
3. `printf '%s' "$APP_SECRET" | npx wrangler secret put REALTIME_SFU_APP_SECRET`
4. 可选 TURN：`POST /accounts/{account_id}/calls/turn_keys` → `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`
5. 重新进入频道，`join` 应返回 `transport: cloudflare`

## 16. 线上缺陷修复：来回切换频道出现重复管理员（2026-11-14 晚）

**现象**：在 `/voice` 里来回点两个频道后，成员列表里堆出一堆同名管理员，
旧频道里的自己没有正常退出。

### 16.1 根因（两层叠加）

1. **前端异步竞态**。`joinChannel()` 依次是 `await leaveChannel()` →
   `await api(.../join)` → `new VoiceRoomClient()`。快速切换时，第二次
   `leaveChannel()` 执行时 `state.room` 还是 `null`（第一次的连接尚未建立），
   没有东西可关；而第一次的 `/join` 请求随后返回，照样建立 WebSocket，
   成为无人管理的「幽灵连接」，反复切换就不断累积。
   第一版代号修复还踩过一个坑：在 `await leaveChannel()` **之后**才读
   `joinSeq`，连续点击时所有流程会读到同一个值，全部被误判为有效。
2. **后端没有去重**。`VoiceRoomDO.attach()` 不限制同一账号的连接数，
   `members()` 直接遍历 `state.getWebSockets()`，同一 `user_id` 的每条连接
   都算一个成员；客户端收到 4402 关闭后还会自动重连，与 DO 互相踢，
   形成连接风暴（实测一次快速切换创建了 23 条 WebSocket）。

### 16.2 修复

- `voice/voice.js`：新增 `joinSeq` 加入代号，**进入函数时同步 `++state.joinSeq`**；
  每个异步节点都校验代号，失效时立刻 `dispose()` 关闭自己建立的房间 / 传输；
  `leaveChannel(silent, seq)` 由调用方传代号，独立的挂断 / 被踢才自增；
  离开时先同步 `room.close()` 再做媒体清理。
- `voice/transport.js`：`onopen` 检查 `self.closed`（CONNECTING 阶段被取消也会关掉）；
  `4401 / 4402 / 4403 / 4404` 关闭码一律**不自动重连**。
- `src/voice-room.js`：`attach()` 先踢掉同 `user_id` 的旧连接（4402）；
  `members()` 按 id 去重、`find()` 优先最新连接；
  `onClose()` 在同账号仍有连接时不误报「离开了频道」。

### 16.3 回归测试与验证

- `tests/voice/voice-realtime.e2e.mjs` 新增「同一账号重复连接」用例：
  旧连接收到 4402、成员广播无重复 id。
- `tests/voice/voice-ui.cdp.mjs` 新增「连续点击 5 次来回切换」用例：
  包裹原生 WebSocket 统计创建数 / 存活数，断言成员列表里自己只出现一次。
- `npm run voice:test:all` **70 项全通过**（入口 4 + 鉴权 26 + 端到端 28 + 浏览器 12）；
  `wrangler deploy --dry-run` 为 155.18 KiB / gzip 39.70 KiB。
- 已重新部署到 `zfsn`，线上 `/voice/voice.js`、`/voice/transport.js`
  与 Worker 脚本均确认包含新逻辑；`/`、`/api/health`、`/voice/`、`/admin/` 全部 200。

### 16.4 顺手加固

`.assetsignore` 补上 `docs/`：中文部署文档含账号名、密钥清单与上线细节，
不应作为静态资源公开发行。线上 `/docs/voice-deploy.md` 现返回 404，
站点功能不受影响（代码里对 `docs/` 的引用只是注释文字，没有真实链接）。

**复测方式**：在 `/voice` 按 `Ctrl+F5` 强制刷新，然后连续来回点两个频道，
成员列表里自己应始终只有一条。

---

## 17. 保持登录：Cookie 自动登录（2026-11-14 晚，增量需求）

用户反馈「每次都要从登录页面重新进去，有点慢」。原来的实现虽然已有
HttpOnly 会话 Cookie，但有三个体验问题：固定 7 天且**不会续期**、页面每次
都先渲染登录表单再异步切界面（弱网下明显闪屏）、已登录时仍会请求两张
用不上的验证码图。本次一并解决。

### 17.1 两个 Cookie

登录 / 注册 / 续期会**一次下发两条独立的 `Set-Cookie`**，登出时成对清除：

| 名称 | HttpOnly | 值 | 作用 |
|---|---|---|---|
| `zf_voice_sid` | 是 | 随机令牌 | 真正的身份凭据，库里只存 SHA-256 |
| `zf_voice_si` | 否 | 恒为 `1` | 只标记「这台浏览器可能还登录着」，供 `<head>` 同步读，不含任何身份信息 |

两者都是 `Path=/; SameSite=Lax`，HTTPS 下加 `Secure`（本地 `http://127.0.0.1`
不加，否则浏览器不落盘）。**伪造 `zf_voice_si` 不能登录**：它最多让页面多显示
一秒「正在恢复登录态…」，`/api/voice/me` 随即用 HttpOnly Cookie 判定未登录并
退回登录页。

### 17.2 有效期规则

- 登录框新增「保持登录 30 天」，**默认勾选**；注册页同样有该选项。
- 勾选：`Max-Age=2592000`（30 天）。每次打开页面走 `/me` 或 `/bootstrap`
  时**滑动续期**：剩余寿命不足 7 天才回写，续回 30 天，且沿用同一令牌
  （不轮换，避免并发请求互相顶掉）。从签发日起累计最多 **90 天**，之后
  必须重新登录，防止被盗令牌无限续命。
- 不勾选：两个 Cookie 都**不带 `Max-Age`**（浏览器关闭即失效），数据库里
  仍留 12 小时兜底，避免残留孤儿会话。
- 令牌首字符标记类型：`r` = 保持登录、`s` = 临时；升级前签发的纯 hex 令牌
  一律按旧规则 7 天处理，**老用户不会掉线**，但也不会被悄悄延长，重新登录
  一次即切到 30 天。这样不必对线上 D1 表加列、也不必跑新迁移。
- `/me` 与 `/bootstrap` 的响应里多了 `session: { remember, expiresAt, renewed }`，
  便于排查；它不改变 `user` 字段结构，旧前端照常工作。

### 17.3 前端为什么变快了

1. `voice/index.html` 的 `<head>` 里有一段**同步、非 defer** 的脚本，读到
   `zf_voice_si=1` 就给 `<html>` 打上 `data-voice-authed="1"`；CSS 直接据此
   隐藏登录页、显示应用壳，并盖一层「正在恢复登录态…」。JS 还没下载完，
   登录表单就已经不会出现了。
2. `voice/auth.js` 把 `/config` 与 `/me` 改成**并行**请求；已登录时完全不申请
   验证码、不加载 Turnstile 外链脚本（原来固定 2 次 `/captcha`）。打开页面
   从 5 个请求降到 2 个。
3. 公开资料（昵称 / 头像 / 底色）缓存在 `localStorage`，恢复期间先把用户栏
   填上；`/api/voice/bootstrap` 回来后 `showApp()` 撤掉遮罩并把标记改成
   `ready`。缓存不参与任何鉴权。
4. 会话失效（过期、被禁用、被管理员删除）时自动清标记并退回登录页，
   同时提示「登录状态已过期，请重新登录」。

### 17.4 一条容易踩的坑：多条 `Set-Cookie`

`src/index.js` 的全局 CORS 包装层会 `new Headers(response.headers)` 重建响应，
不同运行时对多值头的折叠行为不一致，因此那里显式用 `getSetCookie()` /
`getAll("Set-Cookie")` 拆开重放。本地 `tools/dev/voice-dev-server.mjs` 也有
同样的坑：Node 的 `Headers.forEach` 会为每条 `set-cookie` 单独回调，而
`res.setHeader` 同名覆盖，实测登录只剩第二条、主 Cookie 直接丢失；现已改成
收集成数组一次性写出。`tests/voice/voice-session.test.mjs` 里有一条**真实
HTTP** 用例专门守着这件事，别删。

### 17.5 运维

```bash
# 强制所有人重新登录（例如怀疑令牌泄露）
npx wrangler d1 execute zfsn-db --remote --command="DELETE FROM voice_sessions"

# 只踢某个人：先查 id，再按 user_id 删
npx wrangler d1 execute zfsn-db --remote --command="DELETE FROM voice_sessions WHERE user_id='<用户ID>'"
```

浏览器清掉两个 Cookie 后也会立即回到登录页。管理员在后台「禁用 / 删除」
用户时会同时删掉该用户的会话（原逻辑已有），前端刷新后不会停留在频道里。

### 17.6 本次改动与验证

- 服务端：`src/voice-core.js`（常量 / 两条 Cookie / 令牌类型）、
  `src/voice-auth.js`（`issueSession` / `touchSession` / 四个路由）、
  `src/voice-realtime.js`（bootstrap 续期）、`src/index.js`（多值头重放）。
- 前端：`voice/index.html`（head 脚本 / 恢复遮罩 / 两个勾选 / 脚本版本号
  `?v=20261114c`）、`voice/auth.js`、`voice/voice.js`、`voice/voice.css`。
- 工具与测试：`tools/dev/voice-dev-server.mjs`、`tests/voice/voice-session.test.mjs`
  （21 项）、`tests/voice/voice-ui.cdp.mjs`（新增浏览器用例）、`package.json`
  新增 `voice:test:session` 并纳入 `voice:test:all`。
- `npm run voice:test:all` **92 项全通过**（入口 4 + 鉴权 26 + Cookie 21 +
  端到端 28 + 浏览器 13）。浏览器用例在 `DOMContentLoaded` 埋点断言登录页
  `display:none`，即「一次都不闪」。
- 部署后请按 `Ctrl+F5` 强刷一次 `/voice/`，否则旧缓存的 `auth.js` /
  `voice.js` 不会加载新逻辑。

