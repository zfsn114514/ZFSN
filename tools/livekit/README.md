# 自建 LiveKit SFU 部署包（可选高级模式 · 中文说明）

> **默认不需要看这份文档。**
> ZF语音的生产后端**全部在 Cloudflare Worker 里**，你的电脑只是浏览器客户端，
> 用来「添加私有频道」。私有频道是 D1 里的一条记录，媒体仍走 Cloudflare SFU。
>
> 只有当你明确想把媒体服务器放到自己电脑上时才用这个部署包。
> 使用前还需要在管理后台打开「允许普通用户添加自建 SFU 频道」。

---

## 1. 文件说明

| 文件 | 作用 |
|---|---|
| `livekit.example.yaml` | 配置模板，含端口、UDP 范围、房间上限、API Key / Secret 占位 |
| `start.bat` | 双击启动（CMD） |
| `start.ps1` | PowerShell 启动，可用 `-Config` / `-Binary` 覆盖 |
| `.env.example` | 复制成 `.env`，只用来指定 `livekit-server.exe` 的路径 |
| `README.md` | 本说明 |

`livekit.yaml` 与 `.env` 含真实密钥，已被 `.gitignore` 排除，**不要提交**。
这两个脚本刻意只写 ASCII 字符，避免 Windows 批处理 / PowerShell 5.1 的中文编码乱码。

---

## 2. 安装 LiveKit Server（Windows）

1. 到 LiveKit 官方发布页下载 Windows 版 `livekit-server.exe`
   （<https://github.com/livekit/livekit/releases>），放到本目录，
   或把绝对路径写进 `.env` 的 `LIVEKIT_BIN`。
2. 生成一对 API Key / Secret（只含字母数字，长度建议 ≥ 32）：

   ```powershell
   node -e "const c=require('crypto');console.log('KEY='+c.randomBytes(12).toString('hex'));console.log('SECRET='+c.randomBytes(32).toString('base64url'))"
   ```

3. 复制模板并替换占位：

   ```powershell
   Copy-Item livekit.example.yaml livekit.yaml
   # 把 keys: 下的 REPLACE_WITH_API_KEY / REPLACE_WITH_API_SECRET 换成第 2 步的值
   ```

4. 启动：

   ```powershell
   .\start.bat
   # 或
   powershell -ExecutionPolicy Bypass -File .\start.ps1
   ```

5. 本机自检：浏览器打开 `http://127.0.0.1:7880`，能看到 LiveKit 的响应即正常。

> LiveKit 单节点不需要 Redis；模板里 Redis 段是注释掉的。
> 房间上限设了 20 人，与 ZF语音的设计容量一致。

---

## 3. 让 HTTPS 页面能连上：三种方案

ZF语音页面是 HTTPS。浏览器会**直接拦截 `ws://` 明文连接**（混合内容），
而纯 IP 地址基本申请不到受信任的 TLS 证书。所以添加频道时填 `ws://192.168.x.x:7880`
会被前端和 Worker 双重拒绝，并给出中文指引。

### 方案 A：Cloudflare Tunnel（推荐）

不用公网 IP、不用路由器端口转发、证书由 Cloudflare 托管。

```powershell
# 1) 安装 cloudflared 并登录
cloudflared login

# 2) 创建隧道
cloudflared tunnel create zf-voice

# 3) 写 config.yml（路径按 cloudflared 安装位置调整）
@'
tunnel: <TUNNEL-UUID>
credentials-file: C:\cloudflared\<TUNNEL-UUID>.json
ingress:
  - hostname: voice.example.com
    service: http://127.0.0.1:7880
  - service: http_status:404
'@ | Set-Content -Encoding utf8 C:\cloudflared\config.yml

# 4) 绑定域名并启动
cloudflared tunnel route dns zf-voice voice.example.com
cloudflared tunnel --config C:\cloudflared\config.yml run zf-voice
```

之后在 ZF语音添加频道时填 **域名 `voice.example.com` + 端口 443 + 开启 TLS**，
实际得到 `wss://voice.example.com`。
媒体 UDP 走 Cloudflare TURN（Worker 已配 `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`），
这种情况下可以把 `livekit.yaml` 的 `rtc.use_external_ip` 设为 `false`。

### 方案 B：域名 + DDNS + Let's Encrypt

1. 用 DDNS 把 `voice.example.com` 指向家宽公网 IP
2. 路由器转发 TCP 443 / 7880、UDP 50000–50100
3. 用反向代理（Caddy / nginx）为 7880 终结 TLS，证书走 Let's Encrypt
4. Windows 防火墙放行上述端口

### 方案 C：仅本机调试

填 `localhost` 且不勾 TLS，浏览器对 localhost 放行混合内容限制。
**只适合自己一台机器测试，别人连不上。**

---

## 4. 端口与防火墙速查

| 用途 | 协议 / 端口 | 路由器转发 | Windows 防火墙 |
|---|---|---|---|
| 信令 / 健康检查 | TCP 7880（TLS 时常 7443 或由 Tunnel 终结） | Tunnel 方案不需要 | 放行 `livekit-server.exe` |
| TCP 媒体回退 | TCP 7881 | 建议 | 放行 |
| UDP 媒体 | UDP 50000–50100 | **非 Tunnel 方案必须** | 放行 |
| TURN / TLS | TCP 443 / 5349 | 视方案 | 放行 |
| STUN | UDP 3478 | 视方案 | 放行 |

UDP 不通的典型症状：**能进频道、成员列表正常，但互相听不到声音**。

---

## 5. Worker 侧配置

浏览器永远拿不到 API Secret；短期 JWT 由 Cloudflare Worker 签发。

```bash
npx wrangler secret put LIVEKIT_API_KEY       # 与 livekit.yaml 里同一个 Key
npx wrangler secret put LIVEKIT_API_SECRET    # 与 livekit.yaml 里同一个 Secret
npx wrangler secret put TURN_KEY_ID           # 建议，媒体中继
npx wrangler secret put TURN_KEY_API_TOKEN
npx wrangler deploy
```

JWT 内容：`iss = API Key`、`sub = 用户 id`、`exp = now + 3600`，
带 `video.roomJoin / canPublish / canSubscribe`，HS256 签名。

---

## 6. 在 ZF语音里启用

1. `/admin/` → 「ZF语音」→ 系统设置 → 打开「允许普通用户添加自建 SFU 频道」
2. 「自建服务器」面板添加一条：名称、域名、端口、勾选 TLS
   （纯 IP + 非 TLS 会被 `checkHost()` 直接拒绝，并给出中文原因）
3. `/voice` 左栏「+」→ 后端选「自建 SFU」→ 填地址 → 点「测试连接」
4. 测试连接会由 Worker 发 HTTP 探测并显示延迟；注意它**只能验证 HTTP 端口**，
   UDP 媒体端口和证书仍需按第 4 节自行确认
5. 保存后频道带「自建」标识；服务不可达时显示「离线」，**不影响其他 Cloudflare 频道**

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 提示「浏览器会拦截 ws:// 连接（混合内容）」 | 填了 `ws://` + 非 localhost | 用方案 A / B 换 wss 域名 |
| 提示「纯 IP 一般签不到受信任的 TLS 证书」 | 填了 IP 但勾了 TLS | 绑定域名后填域名 |
| 测试连接超时 | 服务没起 / Tunnel ingress 不对 / 防火墙 | 先本机 `http://127.0.0.1:7880` 自检 |
| 能进频道听不到声音 | UDP 端口未转发或 TURN 未配 | 转发 UDP 50000–50100 或配置 Cloudflare TURN |
| 加入时报「未配置自建服务的 API Key / Secret」 | Worker secrets 缺失 | 按第 5 节注入并重新部署 |
| 后台删除服务器后频道异常 | 频道仍指向已删的 server_id | 代码会自动把频道回落到 `cloudflare` 后端 |

---

## 8. 安全提醒

- `livekit.yaml`、`.env` 含明文密钥，绝不提交、绝不放到静态资源目录
- `tools/` 已在 `.assetsignore` 中排除，不会被部署成可下载文件
- 不要把 LiveKit 的 7880 直接暴露到公网裸奔；优先用 Tunnel 或 TLS 反代
- 用完记得在后台关掉「允许普通用户添加自建 SFU 频道」，回到默认纯 Cloudflare 架构

官方参考：<https://docs.livekit.io/home/self-hosting/local/> ·
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
