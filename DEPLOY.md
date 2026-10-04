# 迁移到 Cloudflare：让网站不再依赖家里那台电脑

## 这次改了什么

| | 迁移前 | 迁移后 |
|---|---|---|
| 页面 | Cloudflare Workers 静态托管 | 同一个 Worker，静态资源照发 |
| 接口 | 家里电脑 `node server.js` + cloudflared 隧道 | 同一个 Worker 提供 `/api/*` |
| 留言 / 作品 / 互动 | `data/*.json` | D1 数据库 |
| 图片 / 视频 / 下载文件 | `data/media/` + `assets/works/` | KV 存储（大文件自动分片） |
| 管理员密码 / 会话 | `data/config.json`、`tokens.json` | D1 表 |
| 限流 | Node 进程内存里的 Map | D1 计数表 |
| 上传后自动 git push | 每分钟扫一次 `assets/` | **删掉** —— 上传直接进 KV |

家里电脑关机、断电、断网，网站所有功能照常。

新增文件：

```
wrangler.toml                 Worker 配置（D1 / KV 绑定）
src/index.js                  入口 + 22 个接口
src/lib.js                    时间 / 限流 / 密码 / 会话 / 归属地
src/media.js                  文件校验 + KV 读写（分片）+ Range
schema/0001_init.sql          D1 建表
tools/migrate/export_seed.mjs json → seed.sql
tools/migrate/upload_media.mjs  media → KV
tools/migrate/set_password.mjs  重设密码
```

改动文件：`index.html`、`admin/index.html` 的后端地址探测（同源提到最前，隧道降为回退）、`.assetsignore`（排除 Worker 源码）。

Worker 代码**零第三方依赖**，纯 ESM，部署时不需要打包。

---

## 一、准备

```bash
cd D:\ZFSNwebsite
npm install          # 只装 wrangler，用于部署
npx wrangler login   # 浏览器里授权 Cloudflare 账号
```

## 二、建 D1 数据库

```bash
npm run d1:create
```

终端会输出一段配置，把其中的 `database_id` 填进 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "zfsn-db"
database_id = "把这里换成真实 id"     # ← 就是这一行
```

然后建表：

```bash
npm run d1:init
```

## 三、建 KV 命名空间（媒体存储）

```bash
npm run kv:create
```

把输出的 `id` 填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "MEDIA"
id = "把这里换成真实 id"     # ← 就是这一行
```

> **为什么不是 R2**：R2 更合适（单对象 5 TB、不用分片），但开通它要绑支付方式。
> 免费版 KV 单值上限 25 MiB，所以 `src/media.js` 对超过 8 MiB 的文件自动分片
> （38 MB 那个作品视频切成 5 片）。以后若能开通 R2，只需换掉 `src/media.js`
> 里 `putObject` / `serveObject` / `listMedia` / `deleteMedia` 四个函数。
>
> KV 免费额度：1 GB 存储 / 每天 10 万次读 / **1 千次写**。
> 现在 41 MB 媒体、一次完整迁移 12 次写入，离上限很远。
> 唯一要留意的：KV 是**最终一致**的，新上传的文件最多 60 秒才在所有节点可见，
> 刚传完立刻刷新可能暂时看不到 —— 等一下就好，不会丢。

## 四、灌数据

```bash
npm run migrate:sql      # 读 D:\ZFSN-server\data\*.json，生成 tools/migrate/seed.sql
npm run migrate:seed     # 灌进 D1
npm run migrate:media    # 把留言图片、作品视频（38M）传到 KV
```

`migrate:media` 会先切好片再调用 wrangler 逐个上传，38MB 那个视频慢一点正常。可以先加 `--dry-run` 看看要传什么：

```bash
node tools/migrate/upload_media.mjs --dry-run
```

⚠ 如果运行时报 `spawnSync EBUSY`（某些受限环境或杀软禁止 node 起子进程），脚本会自动降级：
把分片留在临时目录、生成 `tools/migrate/.kv-plan.tsv`，并打印出可直接在 shell 里执行的命令，照着跑即可。

管理员密码不用单独处理 —— `seed.sql` 里已经带着原来的哈希，**老密码原样可用**（已实测：现有哈希 + 原密码校验通过）。

⚠ `seed.sql` 里有真实数据：访客 IP、UA、归属地，以及管理员密码哈希。已加进 `.gitignore`，不会进公开仓库 —— 但**迁移完成后建议直接删掉这个文件**。

## 五、部署

```bash
npm run deploy
```

部署完 wrangler 会给一个 `https://zfsn-site.<你的子域>.workers.dev`。先验证它：

```bash
curl https://zfsn-site.<你的子域>.workers.dev/api/health
curl https://zfsn-site.<你的子域>.workers.dev/api/works
```

第一个应返回 `{"ok":true,...,"runtime":"cloudflare-workers"}`。

## 六、把域名指过去

在你 Cloudflare 面板的 Worker → Settings → Domains & Routes 里，把之前静态托管用的主机名（`www.zfsnnb.dpdns.org`）绑成 Custom Domain。绑好后：

- `https://www.zfsnnb.dpdns.org` → 页面
- `https://www.zfsnnb.dpdns.org/api/*` → 接口（同源，无跨域）

验证：

```bash
curl https://www.zfsnnb.dpdns.org/api/health
```

**DNS 注意**：`zfsnnb.dpdns.org`（apex）现在指向家里 IP 做 DDNS，迁移后已经不需要了。可以把它也绑到 Worker，或者在 Cloudflare 上改指 —— 但改动前先确认没有其他服务在用（比如 IIS 的 88 端口）。

---

## 密码哈希：100000 轮是硬上限（已踩过）

**首次部署登录会直接失败**，报这个错：

```
Pbkdf2 failed: iteration counts above 100000 are not supported (requested 120000)
```

原因：从旧后端 `data/config.json` 平移过来的哈希是 **120000 轮**，而 workerd 的
WebCrypto 对 PBKDF2 迭代数有**硬上限 100000** —— 超过就直接抛错，**升级付费版也不放宽**
（这是防 DoS 的保护，不是套餐限制）。所以 120000 轮的哈希在 Workers 上根本无法校验。

修法（三步，已按此执行）：

```bash
# 1. 生成 10 万轮的新哈希（用你原来的密码，登录体验不变）
npm run password -- "你的密码"

# 2. 写进 D1（同时会清空所有会话）
npx wrangler d1 execute zfsn-db --remote --file=./tools/migrate/password.sql

# 3. 重新部署
npm run deploy
```

⚠ 别忘了 `wrangler.toml` 里的 `PBKDF2_ITERATIONS` 也要 ≤ 100000，当前已是 100000。

好消息：**PBKDF2 不吃那 10ms CPU 配额**。它跑在原生加密层，10 万轮实测约 75ms
但不会触发 CPU 超时，所以不需要为了 CPU 去降轮数。

另外，密码记录里现在会存 `iter`（轮数）。以后调整默认轮数时，旧哈希仍按它自己的
轮数校验，不会突然登不上；真遇到超限的哈希，登录接口会明确告诉你"需重设密码"，
而不是含糊地报"密码错误"。

---

## 回退方案（重要）

迁移期我保留了双通道：前端候选列表里，**同源第一、隧道第二**。

- Worker 正常 → 走同源，家里电脑开不开都行。
- Worker 没部署好 / 出错 → 自动回退到 `https://api.zfsnnb.dpdns.org`，只要家里那台开着，站就还是完整的。

所以可以放心先部署验证，确认没问题了再停本地服务。要停的话：

```bash
# 停掉开机自启的计划任务（任务计划程序里搜 ZFSN-Web-Backend）
# 或者直接跑 D:\ZFSN-server\重启服务.bat 的反操作
```

**建议**：先让两边并存跑几天，确认 Worker 稳定了再停本地。

---

## 迁移后的变化

1. **上传不再需要 git push**：以前 admin 传图要等每分钟一次的自动 commit+push 才在公网可见，现在直接进 KV。`server.js` 里那段发布逻辑不再需要。注意 KV 最终一致，传完最多 60 秒才全网可见。
2. **归属地来源变了**：以前查 ip-api.com，现在用 Cloudflare 边缘的 `request.cf`。好处是零延迟、无限流；代价是拿不到 ISP（留言里"运营商"一栏会是空）。想要 ISP 就把 `wrangler.toml` 里的 `GEO_SOURCE` 改成 `ipapi`（但 ip-api 有 45 次/分钟限流，并发高了会失败）。
3. **视频上传上限 50MB**：Worker 内存 128MB，`formData()` 会把整个文件读进内存，100MB 太大容易 OOM。现有那个 38MB 的视频没问题（存进 KV 时切成 5 片，每片 8 MiB）。
4. **留言时间**：Worker 跑在 UTC，已按 `TZ_OFFSET = 8` 补偿，显示还是北京时间。

## 额度够不够

完全够。免费版：Workers 每天 10 万请求、D1 5GB 存储（每天 500 万行读 / 10 万行写）、KV 1GB 存储（每天 10 万次读 / **1 千次写**）。你现在的数据量是 7 条留言、6 个作品、41MB 媒体，差着好几个数量级。

唯一需要盯一眼的是 **KV 的写配额 1000 次/天**：每个文件写入 = 分片数 + 1。
传一个 50MB 视频 = 8 次；正常一天传几十条留言图片也才几十次。
只有批量灌数据时才可能撞线（本次迁移总共 12 次）。

## 安全提醒

迁移完第一件事：**进 /admin 把管理员密码改掉**。现在还是初始密码（已在校验时确认过），而且这次站是真正 24 小时暴露在公网了。改完密码记得把 `tools/migrate/password.sql` 删掉，里面有哈希。

---

# 日常改动流程（本轮新增的工具链）

改了代码之后，按下面走。**别跳过第 1、2 步** —— 跳过会出现
「HTML 引用了新哈希文件但文件没生成」或「文件生成了但 HTML 还指旧的」，
前者 404、后者改动不生效，都是线上才会发现的坑。

## 一、改了 JS 之后：重新算哈希

```bash
python tools/hash_assets.py
```

它会做四件事：算 `assets/js/app.js` 的 SHA-256 前 8 位 → 生成
`app.<hash>.js` → **回写 index.html 的引用** → 更新 `_headers` 的长缓存规则
→ 删掉上一轮的旧哈希文件（避免仓库里堆历史版本）。

脚本**幂等**：内容没变就是什么都不做。验证当前是否一致：

```bash
python tools/hash_assets.py --check
```

> ⚠ 不要手改 index.html 里的哈希文件名，下次跑脚本会被改回去。
> 要改内容就改 `app.js`，再跑一次脚本。
>
> ⚠ 新加 JS 文件要把它填进 `hash_assets.py` 顶部的 `ASSETS` 列表再跑，
> 否则那份文件不会被哈希化，只能走「每次回源协商」。

## 二、加了新图片之后：压缩

```bash
python tools/optimize_images.py --dry-run            # 先看收益
python tools/optimize_images.py --backup tools/orig-images/$(date +%Y%m%d)
```

原地转 WebP（**保留原文件名和路径**，所以散落在 HTML/JSON/D1 里的引用
全都不用改）。脚本有两个安全阀：压完反而变大就保留原文件；PSNR < 30
（压过头）也放弃这笔收益。

> 本轮实测：133 张图 9.35 MB → 5.64 MB（省 40%）。
> 收益几乎全部来自 3 张 1280×720 的 PNG 截图（2.9 MB → 0.3 MB）——
> 截图存成无损 PNG 是最典型的浪费，有损 WebP 能省 90% 以上。
>
> 关于 AVIF：实测再省约 40%，但要改 HTML/JS 成 `<picture>` 才能用上，
> 且会多占 3.5 MB 仓库体积。目前已决定**不生成** AVIF 副本。

## 三、作品有增删之后：重建 sitemap

```bash
python tools/build_sitemap.py
```

> 作品详情页是 hash 路由（`/#work/<id>`），**无法被搜索引擎单独收录**，
> 所以不写进 sitemap（写了是无效条目）。作品的可发现性靠 `/feed.xml`。
> 这是路由方案的固有代价，不是配置问题。

## 四、提交前：本地回归

```bash
node tools/dev/sanity_frontend.cjs      # 前端基础体检
```

## 五、部署后：线上验证

```bash
bash tools/dev/verify_deploy.sh
```

约 20 个请求、1~3 分钟（走代理较慢）。检查项：
基础可达性、charset、**哈希 JS 是否可访问且带 immutable 缓存头**、
JSON-LD 节点齐全、RSS 格式（pubDate 必须是 RFC822）、sitemap 内 URL 无死链、
统计接口权限（`/api/stats` 未登录必须 401）、光标、图片可解码、
缺失资源返回 404 而非 500。

> 本机出网走代理，偶发 `000`。脚本所有请求都重试 3 次再判定，
> 避免把代理抖动误报成站点故障。

## 一次性操作：访问统计的建表

**本轮新增的 `/api/pv`、`/api/stats` 需要先建表**，否则上报会 500：

```bash
npx wrangler d1 execute zfsn-db --remote --file=./schema/0002_analytics.sql
```

建三张表：`pageviews`（按天+页面聚合 PV/UV）、`pv_visitors`
（当天 UV 去重，只存 `SHA-256(ip+ua+day+salt)` 前 32 位，**不存原始 IP**）、
`work_views`（每件作品的浏览量）。

另外 Cloudflare Web Analytics 需要在面板 **手动 Add a site** 才会开始收集
（CF 代理站点默认注入 RUM 脚本，但不 Add 就没数据）。详见
`docs/analytics-setup.md`。

## 缓存头速查

| 资源 | 策略 | 在哪配 |
|---|---|---|
| 哈希化的 JS | `max-age=31536000, immutable` | `_headers`（脚本自动写） |
| 未哈希的 JS | `max-age=0, must-revalidate` | 默认（刻意不加） |
| 图片 | `max-age=2592000`（30 天） | `_headers` |
| HTML | `max-age=0, must-revalidate` | `_headers` |
| `/pvz/*.js`、`mainpak` | `max-age=31536000, immutable` | `_headers` |

> `_headers` 匹配的是**请求 URL**，不是文件路径。`/` ≠ `/index.html`；
> 被 `html_handling` 剥掉扩展名的页面（如 `/pvz/pvz-portable.html`
> → 307 → `/pvz/pvz-portable`）要按**去扩展名的路径**再写一份规则，
> 否则只作用于 307 响应本身、最终页面完全不生效。

