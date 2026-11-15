# ZF语音 · 本机语音媒体后端（中文说明）

> **职责边界（按你的要求固定下来）**
> 你的电脑**只负责语音频道和屏幕共享的媒体转发**（LiveKit SFU）。
> 网页上的账号、登录、邀请码、频道列表、私有频道、房间信令和审计日志，
> **依旧全部以 Cloudflare Worker 为后端**，本机不保存也不接触任何用户数据。
> Worker 签发短期令牌，浏览器拿令牌直连你电脑上的媒体服务。

---

## 1. 三步跑起来

### 第 1 步：双击 `tools/livekit/start.bat`

第一次启动会自动完成（需要联网，约 72 MB，只下一次）：

- 从 LiveKit 官方 GitHub Release 下载 `livekit-server.exe`
- 从 Cloudflare 官方 Release 下载 `cloudflared.exe`
- 随机生成一对 API Key / Secret，写出 `livekit.yaml`
- 启动 LiveKit，监听本机 `7880`
- 启动 Cloudflare Tunnel，自动拿到一个可信的 `https://xxx.trycloudflare.com` 域名

窗口里会打印出**后台该填的值**和**要注入 Worker 的两个密钥**。
**这个窗口不要关**，关掉或按 `Ctrl+C` 会同时停掉媒体服务和隧道。

自检随时可跑：

```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1 -Command doctor
```

### 第 2 步：把密钥注入 Cloudflare Worker

在项目根目录 `D:\ZFSNwebsite` 另开一个终端，用窗口里打印的值：

```bash
npx wrangler secret put LIVEKIT_API_KEY
npx wrangler secret put LIVEKIT_API_SECRET
```

也可以直接复制 `tools/livekit/worker-secrets.txt` 里的两行值。
**两边必须完全一致**：Worker 用它签 JWT，LiveKit 用同一对密钥验签，
不一致的表现是「能拿到令牌但连不上服务器（401）」。

### 第 3 步：在后台改那条服务器记录

`/admin/` → 「ZF语音」→「自建 SFU 服务器」面板，把截图里那条
`ZFSN / wss://zfsnb.dpdns.org:7880 / unknown` 改成窗口打印的值：

| 字段 | 填什么 |
|---|---|
| 名称 | `家里电脑`（随意） |
| 域名 | `xxxx.trycloudflare.com` ← **不要带 `https://`** |
| 端口 | `443` ← **不是 7880**，Worker 会拼成 `wss://域名:443` |
| 使用 TLS (wss) | 勾选 |

保存后点「测试连接」，状态应从 `unknown` 变成可达。

> 为什么原来那条不通：LiveKit 自己只提供 `ws://`，**不终止 TLS**；
> `zfsnb.dpdns.org` 也没有解析到你家宽的公网 IP。Tunnel 把本机 7880
> 包装成一个带可信证书的 HTTPS/WSS 域名，这一步就解决了。
>
> ⚠ 临时隧道域名**每次重启都会变**。重启 `start.bat` 后要回后台把域名改成新的。
> 想要固定域名，按第 6 节配 Named Tunnel。

---

## 2. 把语音频道切到本机后端

后台「系统设置」里打开「允许普通用户添加自建 SFU 频道」，然后：

1. `/voice` 左栏点「+」→ 后端选「自建 SFU」→ 选刚加的服务器 → 点「测试连接」
2. 保存后频道带「自建」标识，加入时 Worker 返回 `transport: livekit` +
   短期令牌，前端 `LiveKitTransport` 连你电脑上的 LiveKit
3. **不要动现有的 3 个 Cloudflare 频道**：本机没开机时，自建频道会显示「离线」，
   其它频道照常走 Worker + 浏览器直连降级，互不影响

房间上限 20 人（与站点设计容量一致），单节点 LiveKit 不需要 Redis。

---

## 3. 命令速查

| 命令 | 作用 |
|---|---|
| `start.bat` / `.\start.ps1` | 一键启动（= `run`），保持窗口打开 |
| `.\start.ps1 -Command setup` | 只初始化：生成密钥、配置、下载两个二进制 |
| `.\start.ps1 -Command doctor` | 自检：二进制 / 端口 / 隧道 / 公网 IP / UDP 限制 |
| `.\start.ps1 -Command print` | 重新打印后台填写值与 Worker 密钥 |
| `.\start.ps1 -Command stop` | 停止占用 7880 的媒体服务 |

等价写法：`node tools/livekit/voice-media-server.mjs <setup|run|doctor|print|stop>`

---

## 4. 端口与防火墙

| 用途 | 协议 / 端口 | 说明 |
|---|---|---|
| 信令 / 健康检查 | TCP 7880 → Tunnel 443 | `wss` 由 Cloudflare 终结，本机不用证书 |
| TCP 媒体回退 | TCP 7881 | 外网建议路由器转发（手机蜂窝网络常封 UDP，全靠它兜底） |
| UDP 媒体 | UDP 50000（或 50000–50100） | **媒体主要走这里**，见下节 |
| 房间上限 / 超时 | 20 人 / 空房 300 秒 | `livekit.example.yaml` 里可调 |

**路由器只能做单端口映射时**（很多家用路由器不支持端口范围）：把
`livekit.yaml` 里的范围收成 `port_range_start: 50000` + `port_range_end: 50001`，
然后只在路由器上转发 UDP **50000** 一个端口就行。

- `port_range_end` 是**开区间上界**，`50000-50001` 实际只会用到 50000；
- 千万**不能**把 start 和 end 写成同一个值，LiveKit 内部是
  `start + rand.Intn(end-start)`，`Intn(0)` 会直接 `panic: invalid argument to Intn`；
- 单端口下所有会话复用这一个 UDP 端口，20 人以内完全够用。

Windows 防火墙**不会**因为后台启动而弹窗询问（`livekit-server.exe` 是被脚本拉起的，
没有交互桌面），所以 `start-selfhost.bat` 会自动幂等地添加两条入站放行规则
（`ZFVoice LiveKit UDP` 跟随 `livekit.yaml` 的实际端口 / `ZFVoice LiveKit TCP` 7880-7881）。
添加规则需要管理员权限：如果窗口里出现「未能自动放行防火墙」，右键该 bat →
**以管理员身份运行一次**即可，规则是持久的，之后普通双击就行。
手动确认：

```powershell
Get-NetFirewallRule -DisplayName 'ZFVoice*' | Select DisplayName,Enabled,Action
```

---

## 5. 必须知道的网络限制

**信令一定通，媒体不一定通** —— 这是 WebRTC 的本质，不是程序 bug。

- WebSocket 信令走 Cloudflare Tunnel 的 443，HTTPS 页面不会拦，`wss` 证书由
  Cloudflare 托管，所以「测试连接」会成功。
- 语音和屏幕共享的媒体包是 **WebRTC over UDP 50000–50100**（TCP 7881 回退）。
  Cloudflare Tunnel 只转发 HTTP/WebSocket，**不转发 UDP**。
- 如果家宽有公网 IPv4：在路由器转发 UDP 50000 + TCP 7881 即可（单端口映射的做法
  见上一节），LiveKit 的 `use_external_ip: true` 会通过 STUN 把公网地址通告给客户端。
- **判断端口映射有没有生效**：看启动日志里有没有
  `WARN rtcconfig/ip.go could not validate external IP`。
  - 没有这条 → 入站 UDP 打回来了，映射生效，外地用户能连；
  - 有这条 → 本机自测正常、外地一定失败（`could not establish pc connection`），
    多半是路由器没映射，或映射的端口和 `livekit.yaml` 的 `port_range` 不一致。
- 如果家宽是运营商大内网（CGNAT，出口 IP 与路由器 WAN 地址不一致）：
  外网朋友的媒体包到不了这台电脑，典型症状是**能进频道、成员列表正常、
  互相听不到声音**。可选解法：
  1. 与朋友用 Tailscale / ZeroTier 组虚拟局域网（最省事）；
  2. 双方都有公网 IPv6 时，LiveKit 可通过 IPv6 直连；
  3. 向运营商申请公网 IPv4 后做端口转发。
- **同一 WiFi / 局域网内不受影响**：可直接用 `ws://<本机IP>:7880` 调试。

后台的「测试连接」只发一次 HTTP 探测，**只能验证信令端口**，
不能验证 UDP 媒体和证书链；`doctor` 命令会帮你把这些信息一次列全。

---

## 6. 想要固定域名（可选，进阶）

临时 `trycloudflare.com` 域名重启会变。要固定域名，用 Named Tunnel
（需要你的 Cloudflare 账号里已托管一个域名，例如站点用的 `zfsnnb.dpdns.org`）：

```powershell
.\cloudflared.exe tunnel login          # 浏览器授权，选域名
.\cloudflared.exe tunnel create zf-voice
.\cloudflared.exe tunnel route dns zf-voice voice.zfsnnb.dpdns.org
```

写 `config.yml`：

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: C:\path\to\<TUNNEL-UUID>.json
ingress:
  - hostname: voice.zfsnnb.dpdns.org
    service: http://127.0.0.1:7880
  - service: http_status:404
```

启动 `cloudflared.exe tunnel --config config.yml run zf-voice`，
后台固定填 `voice.zfsnnb.dpdns.org` + 端口 `443` + 勾选 TLS，以后就不用改了。

---

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 后台状态一直 `unknown` | 没跑 `start.bat`，或域名/端口填错 | 端口必须是 443、域名不带 `https://` |
| 提示「浏览器会拦截 ws:// 连接」 | 填了非 localhost 的明文地址 | 用 Tunnel 的 wss 域名 |
| 提示「纯 IP 一般签不到 TLS 证书」 | 填了 IP 又勾了 TLS | 换成 Tunnel 域名 |
| 加入时报「未配置 API Key / Secret」 | Worker secrets 没注入 | 按第 1 步第 2 节注入并重部署 |
| 拿到令牌却连不上（401） | 本机与 Worker 的密钥不一致 | `print` 查本机值，重新 `wrangler secret put` |
| 能进频道、听不到声音 | UDP 媒体不通 | 见第 5 节；先确认两台设备在同一 WiFi 能不能通 |
| 重启后连不上 | 临时隧道域名变了 | 重新看启动窗口，回后台更新域名 |
| `测试连接` 成功但仍没声音 | 它只测 HTTP 信令 | 属正常，按第 5 节排查 UDP |

---

## 8. 文件与安全

| 文件 | 说明 |
|---|---|
| `voice-media-server.mjs` | 主程序：下载 / 生成密钥 / 启动 / 隧道 / 自检，零第三方 npm 依赖 |
| `start.bat` / `start.ps1` | 一键启动（内容刻意保持 ASCII，避免 Windows 编码乱码） |
| `livekit.example.yaml` | 配置模板，可改 UDP 范围与房间上限 |
| `livekit.yaml` | **自动生成的真实配置，含密钥** |
| `server.json` | 运行时状态（密钥、隧道域名），**含密钥** |
| `worker-secrets.txt` | 供复制注入 Worker 的密钥，**含密钥** |
| `livekit-server.exe` / `cloudflared.exe` | 自动下载的官方二进制 |

后四类文件已全部加入 `.gitignore`，`tools/` 也被 `.assetsignore` 排除，
不会进仓库、不会被部署成可下载文件。**不要把密钥贴到聊天、截图或提交记录里**。

用完不想跑了：关掉窗口即可；后台把频道切回 Cloudflare、关掉
「允许普通用户添加自建 SFU 频道」，站点就完全回到纯 Cloudflare 架构。

官方参考：<https://docs.livekit.io/home/self-hosting/local/> ·
<https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>
