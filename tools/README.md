# tools —— 数据脚本说明

网站上的数据（Steam 游戏、B站 投稿、Xbox 封面）都由这里的脚本抓取，
生成站点根目录下的 `.json` 文件，前端直接读取。

**日常只需要双击 `更新数据.bat`**，其余脚本不用手动跑。

---

## 目录结构

```
tools/
├── 更新数据.bat              ← 日常就双击这个
├── config.json               ← 真实配置（含 API Key）★ 已被 gitignore，绝不提交
├── config.example.json       ← 配置模板，可提交；缺 config.json 时自动回退到它
├── common.py                 ← 公共工具（路径 / VDF / HTTP / Steam API / 原子写盘）
│
├── build_steam_owned.py      ← Steam「自己拥有」的游戏（需 API Key）
├── build_steam_family.py     ← Steam「家庭共享」的游戏（需 API Key）
├── fetch_bili_list_cdp.js    ← B站 全量投稿列表（真实 Chrome + CDP，需 Node.js）
├── build_bili_full.py        ← B站 详情 + 封面 + 账号信息 → bili_videos.json
├── build_xbox_covers.py      ← Xbox 游戏封面（微软官方商店）
├── fetch_covers.py           ← B站 封面补抓（修复工具，平时不用跑）
│
├── ── 站点交付工具链（改前端 / 发版时用，见「站点交付工具链」一节）──
├── hash_assets.py            ← JS 内容哈希 + 回写 HTML 与 _headers
├── optimize_images.py        ← 图片原地转 WebP（带 PSNR 安全阀）
├── build_sitemap.py          ← 生成 sitemap.xml
│
├── build_bili.py             ← ⚠ 历史脚本（Python 直连抓列表，现必失败，仅作参考）
├── build_bili_profile.py     ← ⚠ 历史脚本（职责已被 build_bili_full.py 覆盖）
│
└── dev/
    ├── verify_deploy.sh        ← 部署后自动线上验证（11 个检查段）
    ├── sanity_frontend.js      ← 前端脚本冒烟测试（顶层运行时错误）
    ├── check_bili_render.js    ← B站 页渲染回归（条数 / 懒加载 / 排序 / 搜索 / 破图）
    ├── check_steam_merge.js    ← Steam 自有 + 家庭共享 的合并契约检查
    ├── check_api_candidates.js ← 后端地址探测 / 混合内容规则检查
    ├── check_api_detect.js     ← 「只有隧道可用」时的地址判定桩测试
    ├── check_media_api.js      ← 作品媒体接口自测（多图 / 视频 / Range / 下载 / 反例）
    ├── check_work_media.js     ← 作品媒体冒烟（无头 Chrome 跑前台详情页 + 后台表单）
    ├── cdp_capture.js          ← 诊断工具：钩住空间页的 fetch，看接口真实返回
    └── shot_bili.js            ← 打开页面切到 B站 页并截图（验证渲染效果）
```

---

## ★ 两件必须知道的事

### 1. `config.json` 里有 API Key，绝对不要提交

它已经在 `.gitignore` 里。**历史上它曾被提交到公开仓库，导致旧 Steam API Key
泄露并被 Steam 撤销** —— 所以现在改成：真实配置只存在本地，模板才进仓库。

新克隆仓库的人执行一次：

```bash
copy config.example.json config.json     # Windows
cp config.example.json config.json       # Git Bash
```

然后填上自己的 `steam.api_key`。也可以完全不用文件，改用环境变量：

```bash
set STEAM_API_KEY=你的key
set STEAM_ID=7656119xxxxxxxxxx
```

### 2. `api.steampowered.com` 的 443 被网络拦截，脚本会自动回退 HTTP

实测：TCP 连得上（0.002s），但 TLS 握手阶段被重置，`curl` 退出码 56 / HTTP 000。
**而 80 端口（明文 HTTP）是通的。**

`common.steam_api_base()` 会探测一次并缓存结果，之后所有请求都走通的通道。

---

## 发布一次内容，完整走这条流程

```bash
# 1) 更新数据（本地 → JSON）
tools\更新数据.bat

# 2) 静态资源有改动时重新生成内容哈希
python tools/hash_assets.py

# 3) 提交并推送（GitHub push 自动构建，约 1 分钟）
git add -A && git commit -m "..." && git push

# 4) 等构建完，线上验证
bash tools/dev/verify_deploy.sh

# 5) ★ 通知搜索引擎（内容真的变了才跑）
python tools/indexnow.py
```

第 5 步最容易被忘 —— 忘了必应就不会知道页面更新了。
**只有新增/更新/删除页面时才跑**，别每次 push 都跑（会被当垃圾）。
回退到 HTTP 时脚本会明确提示 —— 那意味着 `api_key` 会以明文经过链路，
本机/家庭网络下没问题，**别在公共网络里跑**。

---

## 各脚本干什么

### `build_steam_owned.py` → `steam_games.json`

走 Steam 官方 Web API，拿**自己拥有**的游戏 + 精确游玩时长。

- **需要 API Key**，填在 `config.json` → `steam.api_key`
- 申请地址：<https://steamcommunity.com/dev/apikey>（**国内打不开**，需换网络）
- 前置条件：Steam 个人资料 → 隐私设置 → 「游戏详情」必须设为**公开**
- Key 失效时会**明确报错并保留旧数据**，不会把 json 写坏
- 报错信息会区分 `Unauthorized`（key 填错）和 `Forbidden`（key 已被撤销）

### `build_steam_family.py` → `steam_family.json`

拿**家庭共享**的游戏 —— 包括**本机没下载过**的那些。

Steam 的 `GetOwnedGames` 只返回自己拥有的游戏，共享来的一律不返回
（不报错、不提示），所以站点原本完全看不到它们。三条数据来源：

| 步骤 | 来源 | 说明 |
|---|---|---|
| ① 成员名单 | 本机 `localconfig.vdf` 的 `FamilyGroup` 块 | groupid + 全部成员的 accountid |
| ② 各成员游戏库 | `GetOwnedGames`（需 API Key） | 逐个成员查，取并集 |
| ③ 中文名 / 类型 | 商店 `appdetails`（免 Key，永久缓存） | 补中文名，按 `type` 过滤 DLC/原声带/Demo |

再减去 `steam_games.json` 里「自己拥有」的，就是家庭共享游戏。

> ⚠ **成员名单必须从 `FamilyGroup` 读，不能靠 `loginusers.vdf` 猜。**
> 「本机登录过的账号」和「家庭成员」完全是两回事 ——
> 实测本机 6 个登录账号里只有 1 个在家庭组内，另外 5 个各自属于别的家庭组。

> ⚠ **需要每位成员的「游戏详情」隐私设为公开**，否则该成员返回空对象。
> 脚本会明确列出哪些成员拿不到，不会静默少算。

**游玩时长**读本机 `localconfig.vdf` 的 `Playtime` —— 那是**自己**在这些游戏上的时长。
不会显示别的成员的时长（既是隐私，也容易让人误解）。没玩过的显示「未玩过」。

Steam 路径写在 `config.json` → `steam_local.steam_root`，留空会自动探测。

### `fetch_bili_list_cdp.js` → `tools/.cache/bili_list.json`（B站 全量投稿列表）

**这是 B站 投稿列表现在唯一可靠的来源。** 用真实 Chrome 渲染空间页，
再把页面自己发出的 `arc/search` 响应钩下来。

#### 为什么不能用 Python 直接调接口

`/x/space/wbi/arc/search` 对本机 IP 是**纯 IP 级风控封禁**（HTTP 412）。
以下手段**全部实测无效**，不要再试：

| 试过的办法 | 结果 |
|---|---|
| 换 UA（Chrome / Edge / 手机 Chrome） | 全 412 |
| 补新版风控参数 `dm_img_list` / `dm_img_str` / `dm_cover_img_str` / `dm_img_inter` | `-352 风控校验失败`（带 `v_voucher` 挑战） |
| 刷新 buvid3 / buvid4 cookie | 无效 |
| 旧版非 wbi 接口 `/x/space/arc/search` | `-799 请求过于频繁` → 412 |
| APP 端 `/x/v2/space/archive/cursor` | `-400 请求错误`（需要 appkey+sign） |
| 动态接口 `polymer/web-dynamic/v1/feed/space` | `-352` |
| 移动端 SSR `m.bilibili.com/space/{mid}` 的 `feedList` | 返回空数组（客户端异步加载） |

**结论：这不是签名问题，是 IP 信誉问题。** 但真实浏览器（TLS 指纹 +
完整 cookie + JS 环境）能过 —— 所以改用 Chrome。

#### 三个必须知道的坑

1. **风控是「概率性放行」**
   同一条命令连续跑，会随机出现「渲染出 40 张卡片」和「列表为空
   （页面显示*空间主人还没投过视频…*）」两种结果。
   第 1 页经常要试 2~4 次才出来。**脚本必须重试，不能一次失败就放弃。**

2. **登录不是必要条件**
   用全新临时 profile 重试也能成功（验证过）。
   所以可以用**独立 profile** 起 Chrome，不干扰用户正在用的浏览器。

3. **必须点击翻页，URL 参数无效**
   `?pn=2` / `?page=2` 一律无效：`/video` 会 302 到 `/upload/video`
   并**重置回第 1 页**。只能点 DOM 里的分页按钮，而且
   headless 下 JS 的 `el.click()` 不可靠，要用 CDP 的真实鼠标事件。

#### 成功判据

用**「出现了没见过的 BV 号」**判断翻页成功。
不要用「首个 BV 变了」—— 页面可能把新卡片追加在后面，首个 BV 不变，
会导致明明成功却判失败（踩过，白跑了 8 轮重试）。

产出 `tools/.cache/bili_list.json`，含 108 条投稿的 bvid / title / cover /
pub / ts / length / views / danmaku / reply / desc / typeid。

### `build_bili_full.py` → `bili_videos.json`

读上一步的缓存列表，逐条补齐 **点赞 / 投币 / 收藏 / 分区**，
把封面下载到 `assets/bili/`（B站 CDN 有防盗链，必须带 Referer + 三子域轮询），
并抓账号总览。**108 条约 5 分钟。**

```bash
python build_bili_full.py                # 全量
python build_bili_full.py --no-detail    # 只用列表数据（秒级）
python build_bili_full.py --reuse-detail # 复用已有 like/coin/favorite，只补封面/账号（秒级）
python build_bili_full.py --limit 5      # 只处理前 5 条（调试）
```

几个设计要点：

- **`tname` 要靠本地映射。** `/x/web-interface/view` 对本账号返回的
  `tname` 是**空串**（108/108 全空），但同一条响应里的 `tid` 有值。
  所以脚本内置了 `TID_NAME` 表把 tid 翻成分区名。
- **账号信息走 `m.bilibili.com` 的 SSR 数据**，不走 `acc/info`
  （后者常年 `-352`）。取不到时依次回落到 `acc/info` → 已有 JSON，**绝不把真实值刷成空**。
- **缓存列表缺失时不报错退出**，而是退回用现有 `bili_videos.json` 的列表继续补数据。
- 只在全部成功时**原子替换**（先写 `.tmp` 再 `os.replace`），中途失败不会毁掉旧数据。

### `build_bili.py` / `build_bili_profile.py`（历史脚本，日常不用跑）

`build_bili.py` 是旧的「Python 直连 API 抓列表」实现，**现在必然失败**
（412 封禁），仅保留其 wbi 签名与降级逻辑作参考。
`build_bili_profile.py` 的职责已被 `build_bili_full.py` 覆盖，
留作应急兜底（缓存列表丢失、只想给现有 JSON 补互动数据时可用）。

### `build_xbox_covers.py` → 回写 `xbox_games.json`

用微软官方 displaycatalog 接口按游戏名搜封面，下载到 `assets/xbox/`。

Xbox 的**游玩时长和成就无法通过接口获取**，只能从 Xbox 应用手动导出后
填进 `xbox_games.json`，再跑这个脚本补封面。

### `fetch_covers.py`

**修复工具**，日常流程里用不到（`build_bili_full.py` 会顺带下封面）。
当封面缺失 / 被风控挡掉 / 手工改坏了路径时，单独跑它补齐。
已存在的会跳过，可反复执行。

---

## 站点交付工具链

上面那些脚本管的是**数据**（游戏列表、B站投稿）；下面这几个管的是**交付** ——
改完前端、压完图、准备发布时跑。它们不碰数据文件，改动都在站点资源与元数据上。

> **一句话记法**：改了 `assets/js/*.js` → 跑 `hash_assets.py`；
> 加了图片 → 跑 `optimize_images.py`；作品增删 → 跑 `build_sitemap.py`；
> 部署完 → 跑 `dev/verify_deploy.sh`。

### `hash_assets.py` —— JS 内容哈希（★ 改完 JS 必须跑）

把 `assets/js/app.js` / `danmaku.js` 复制成 `app.<sha256前8位>.js`，
再把 `index.html` 里的引用改过去，同时重写 `_headers` 里那段
`immutable` 长缓存规则。

**为什么必须跑**：`index.html` 引用的是**带哈希的文件名**，不是 `app.js`。
改了 `app.js` 但没重跑本脚本 → 页面还在加载**旧的哈希文件** →
**改动完全不生效，而且不报任何错**（踩过，排查了半天才发现）。

```bash
python tools/hash_assets.py            # 生成 / 更新
python tools/hash_assets.py --check    # 只校验，装 CI 或提交前用
```

幂等：源文件内容没变就不改名，连 304 都省了。旧哈希文件会自动清理。

**新增脚本后**：把它加进脚本顶部的 `ASSETS` 列表再跑一次。

### `optimize_images.py` —— 图片原地转 WebP

扫描 `assets/`，把 PNG / JPG **原地**转成 WebP（**保留原文件名与扩展名**），
原图备份到 `tools/orig-images/<日期>/`（已 gitignore）。

**为什么保留扩展名**：图片路径散落在 `index.html`、各 `*.json`、
以及 D1 的作品记录（后台可编辑）里。一旦把 `a.png` 改成 `a.webp`，
D1 里存的 `a.png` 立刻 404。所以统一「原地压缩、同名覆盖」——
只是文件内容变成了 WebP，客户端靠魔数识别，不看扩展名。

两个**安全阀**（避免为了省体积牺牲质量）：

| 情况 | 处理 |
|---|---|
| 压完反而更大 | 保留原文件 |
| PSNR < 30（肉眼能看出糊） | 放弃这笔收益 |

```bash
python tools/optimize_images.py --dry-run                 # 先看收益
python tools/optimize_images.py --backup tools/orig-images/$(date +%Y%m%d)
python tools/optimize_images.py --only png                # 只压 PNG

# 只给指定子目录产 AVIF 副本（不改主文件），配合前端 <picture>
python tools/optimize_images.py --avif --dirs assets/works --no-primary
```

实测 133 张 9.35 MB → 5.64 MB（省 40%）。收益全在**截图类 PNG** 上；
摄影 JPG 本来就压过，再压只省 10~20%。

#### AVIF 副本（`--avif` / `--dirs` / `--no-primary`）

默认**不产** AVIF —— 因为前端没有 `<picture>` 时这些文件永远不会被请求，
纯属浪费仓库体积。目前已对 `assets/works/` 落地（详见 `docs/avif-evaluation.md`）。

| 参数 | 作用 |
|---|---|
| `--avif` | 额外产出 AVIF 副本 |
| `--dirs a,b` | 只处理这些子目录（相对站点根），默认扫 `assets` 全量 |
| `--no-primary` | 不改写主文件，**只产 AVIF 副本** |

产物命名是标准单后缀：`vrc.png` → `vrc.avif`（不是 `vrc.png.avif`）。

⚠ **产了 AVIF 就要同步三处**，否则会出现「支持 AVIF 的浏览器破图」：
1. `assets/js/app.js` 的 `avifCandidate()` 白名单里加上这个目录
2. `_headers` 里有 `/assets/*.avif` 的 `image/avif` 规则（一条即可，**别写两条**）
3. 重跑 `hash_assets.py`

### `build_sitemap.py` —— 生成 sitemap.xml

按 `STATIC_PAGES` 列表 + 线上作品生成 `sitemap.xml`。

**★ 刻意不收录作品详情页**：作品详情是 `/#work/<id>` 这种 hash 路由，
`#` 后的 fragment **不被搜索引擎单独收录**，而 sitemap 规范要求
`<loc>` 不含 `#` —— 列进去是负收益。作品的可发现性靠 `/feed.xml`（RSS）。

```bash
python tools/build_sitemap.py            # 生成
python tools/build_sitemap.py --dry-run  # 只看会写出什么
```

线上作品拉取失败时会**打警告但仍生成**（宁可少几条，也不要什么都生成不出来）。
新增静态页就加到脚本顶部的 `STATIC_PAGES`。

### `indexnow.py` —— 主动提交 URL 给必应（★ 内容更新后跑）

把 URL 主动推送给搜索引擎，比在必应站长工具点「请求索引」快得多 ——
后者只是排队等调度，实测经常几周没动静。

```bash
python tools/indexnow.py              # 提交默认列表（首页 + PvZ 页）
python tools/indexnow.py --url <URL>  # 提交单个 URL（可重复传）
python tools/indexnow.py --all        # 提交 sitemap 里的全部 URL
python tools/indexnow.py --dry-run    # 只看要提交什么，不真发
```

一次提交**同步给所有参与引擎**（Bing / Yandex / Seznam / Naver），
不用分别 ping。**Google 不参与 IndexNow**，它只能靠 sitemap + 自然抓取。

- 密钥文件在仓库根目录 `8418a371656250f21c912c2f7ff3dced.txt`，
  **不能删**（删了提交会返回 403）
- 脚本会**先自查密钥文件可访问性**再提交 —— 403 基本都是这个原因
- 状态码：`200` 成功（密钥已验证）/ `202` 已接受（验证中，首次常见）/
  `403` 密钥无效 / `422` URL 不属于该 host / `429` 提交过频

**⚠ 只提交真正变更的页面。** IndexNow 是事件信号，不是每晚重发的
sitemap；反复提交未变动的 URL 会被当垃圾（返回 429）并降低抓取优先级。
**新增 / 更新 / 删除**这三种情况才提交。

背景与完整诊断见 `docs/bing-indexing-diagnosis.md`。

### `dev/verify_deploy.sh` —— 部署后自动线上验证

部署完跑一遍，11 个检查段覆盖整条交付链：可达性、charset、
哈希静态资源（JS + CSS，含 `text/css` 与 `immutable` 缓存头，
以及「首页**不应**长缓存」）、JSON-LD、RSS、sitemap/robots（含死链检测）、
统计接口、光标与图片、**AVIF 副本（存在性 + `image/avif` + 头不重复）**、
**「关于我」接口（`/api/about` 结构 + `has_content` 布尔类型）+
CSS 变量 `--c1` 是否定义**、关键子资源（**缺失资源须 404 而非 500**）。

```bash
bash tools/dev/verify_deploy.sh
```

输出分 通过 / 失败 / 警告 三类，末尾给汇总。
**警告**是「功能未部署」这类可接受项，**失败**是「部署了但坏了」——
两者分开避免把未上线误判成故障。约 4~5 分钟（20+ 请求，每个带 3 次重试，
本机走代理时裸 curl 偶发 000）。

⚠ **改脚本时注意两点**：

1. `hdrval` 内部已给参数拼 `.h`（响应头存在 `$out.h`），
   调用时**只传基础名**，别写成 `"$TMP/x.h"` —— 会变成 `x.h.h` 读不到值。
2. 取 HTTP 状态码要接 `head_only` 的**返回值**（它 `echo` 出来），
   不要去 grep 下载下来的文件 —— 图片是二进制，抓不到状态码。
3. 判断响应头「是否重复」不能笼统用 `*,*`：`Cache-Control` 本身天然含逗号
   （`public, max-age=2592000`）。要针对具体值判（如数 `public` 出现几次）。
且每个检查的失败分支必须**打印实际取到的值**（`${VAL:-空}`），
否则空值会静默「通过」，检查形同虚设。

---

## 前端怎么用这些数据

| 文件 | 谁读 | 说明 |
|---|---|---|
| `steam_games.json` | `index.html` | 自己拥有的游戏（165 款） |
| `steam_family.json` | `index.html` | 家庭共享游戏（395 款），**合并进主列表**显示 |
| `bili_videos.json` | `index.html` | B站 投稿与账号数据 |
| `xbox_games.json` | `index.html` | Xbox 游戏列表与封面 |

家庭共享**不单独成区** —— 前端把两份数据合并成一个列表，只在卡片右上角
挂一个小小的「家庭」角标标明来源。搜索和排序都覆盖全部游戏。

---

## 常见问题

**Q: 跑完没变化？**
脚本设计成「抓不到就保留旧数据」。看控制台输出的错误提示，
多半是风控、Key 失效、或某个家庭成员的隐私没公开。

**Q: Steam 游戏数变少了？**
先检查 `config.json` 里的 `max_games` / `min_playtime` 是不是被改过，
再确认 API Key 是否还有效。

**Q: 家庭共享游戏数不对？**
① 确认每位成员的「游戏详情」是公开；
② 确认你在家庭组里（脚本会打印 groupid 和成员数）；
③ `include_members` 若填了值，只会同步列出的那几个人。

**Q: 第一次跑家庭共享脚本很慢？**
要查 300+ 个商店接口，约 10 分钟。结果永久缓存在 `tools/.cache/appdetails.json`，
之后重跑只要几秒。中途 Ctrl-C 也不会全丢（每 25 条落一次盘）。

**Q: B站 投稿少了 / 抓不到？**
`[3/5]` 那一步失败最可能。它是**概率性放行**的，脚本自己会重试几轮；
如果整轮都失败，直接再跑一次 `更新数据.bat` 即可（旧数据不会被覆盖）。
另外确认本机装了 **Chrome** 和 **Node.js** —— 这一步靠无头 Chrome 驱动。
想单独重试就 `cd tools && node fetch_bili_list_cdp.js`。

**Q: B站 视频的「分区」标签是空的？**
B站 的 `view` 接口对本账号返回的 `tname` 就是空串（108/108 全空），
这是接口的真实行为，不是脚本 bug。脚本改用 `tid` + 本地分区表映射，
所以正常情况**应该**有值；若某条确实没有，说明该 `tid` 还没加进
`build_bili_full.py` 的 `TID_NAME` 表，补一行即可。

**Q: 数据文件的结构能改吗？**
**不能随便改字段名**。前端的渲染逻辑是按字段名硬编码的，
改了字段名页面会整块渲染失败。新增字段没问题，重命名/删除要同步改前端。
（`dev/check_steam_merge.js` 会帮你守住 Steam 这两份。）

**Q: 改了后端端口，前端要动吗？**
要。`index.html` 与 `admin/index.html` 里的 `HTTP_API_PORT` / `HTTPS_API_PORT`
两个常量必须和 `D:\ZFSN-server\server.js` 的 `PORT` / `HTTPS_PORT`
默认值一致（3000 / 3443），否则跨端口访问时探测不到后端。
改完跑 `node dev/check_api_candidates.js` 确认没写错。

---

## 开发用

以下几个脚本都是只读检查，改完前端建议都跑一遍。

### `dev/sanity_frontend.js` —— 顶层运行时错误

把 `index.html` / `admin/index.html` 里的内联脚本放进桩环境跑一遍，
能抓出未定义变量、拼错函数名这类顶层运行时错误。比纯语法检查有用得多。

```bash
node dev/sanity_frontend.js
```

> 注意：桩环境里 `fetch` 必然失败，会触发各数据源的降级分支，
> 那些分支依赖真实 DOM，报错属正常（会标成"桩限制"），按错误类型排除即可。

### `dev/check_steam_merge.js` —— Steam 合并契约

用真实的 `steam_games.json` + `steam_family.json` 跑一遍合并与渲染逻辑，
断言：合并总数、去重、`family` 标记、角标、排名、统计文案、家庭数据缺失时的降级。

**为什么需要它**：这两份 json 由 Python 生成、由前端手写 JS 消费合并，
任何一边改了字段名（`appid` / `games` / `hours` / `playtime` / `cover` /
`store` / `count` / `total_hours`），页面会**静默不显示**，肉眼很难发现。

```bash
node dev/check_steam_merge.js
```

### `dev/check_api_candidates.js` —— 混合内容规则

把 `apiCandidates()` 抠出来，在 7 种访问方式（https 同源 / https 443 /
https 的 IIS / http 同源 / 非常规端口 / http 的 IIS / file://）下
断言候选地址列表，并强制校验一条不变量：

> **https 页面下不得出现指向非 localhost 的 http 候选。**

**为什么需要它**：浏览器对混合内容是硬拦截 —— 请求根本发不出去，
控制台只留一行记录，后端日志里什么都没有。表现为"作品墙空着 /
留言发不出"，极难排查。这条规则必须钉死。

```bash
node dev/check_api_candidates.js
```

### `dev/check_bili_render.js` —— B站 页渲染回归

起本地静态服务 + 无头 Chrome，真的把页面打开、切到 B站 页，断言 11 项：
json 已加载、计数文案、**首屏 24 条**、工具栏计数、6 个统计格子、
总播放文案、**触底能加载到 108 条**、按播放排序、搜索命中、
封面无破图、无控制台错误。

**为什么需要它**：`bili_videos.json` 从 12 条涨到 108 条是一次量级跃迁，
只校验 JSON 结构不够 —— 分页批量、懒加载、排序、搜索都可能在新数据下出问题。
而这些问题在页面上表现为"少几条"，肉眼根本发现不了。

```bash
node dev/check_bili_render.js
```

### `dev/check_media_api.js` —— 作品媒体接口自测（纯接口）

不开浏览器，直接打后端接口，断言 **48 项**：多图上传（含"魔数优先"——
PNG 内容 + `.jpg` 文件名仍存成 `.png`）、视频上传、文件上传、
建作品后读回校验 `images/video/files`、**视频 Range**（206 / Content-Range /
`Accept-Ranges` / 尾部区间 / 越界 416）、附件下载（`Content-Disposition`
带 RFC5987 原始中文名）、以及反例（文本冒充图片、白名单外扩展名、无 token）。

```bash
cd D:\ZFSN-server && set PORT=3100 && set HTTPS=0 && node server.js   # 另开一个窗口
node dev/check_media_api.js
```

**为什么要用 3100 测试端口**：线上那个 3000 是计划任务托管的正式服务，
拿它跑自测会往真实作品库里写数据。测试端口连的是同一份 `data/`，
但作品会被脚本自己删掉。

### `dev/check_work_media.js` —— 作品媒体冒烟（无头 Chrome，26 项）

真的开浏览器，走完整用户路径：

* **前台详情页** —— `<video>` 的 src 指向后端隧道、相册缩略图 3 张、
  下载列表 2 条且显示原始文件名与体积、统计条含「图片/附件」、
  点缩略图能切换视频封面；
* **前台作品墙** —— 卡片角标「3 张 / 视频 / 2 个附件」；
* **后台表单** —— 点「作品」标签 → 点这条作品的「编辑」，
  校验三块上传区都正确回填，点「设为封面」能把第 2 张挪到最前；
* 无控制台错误；跑完自动删掉测试作品与上传的图片。

```bash
node dev/check_work_media.js          # 默认打 http://127.0.0.1:3100
```

截图落在 `dev/_shots/work_media_*.png`。

**★ 一个坑：`admin/index.html` 的脚本整体包在 `(function(){…})()` 里**，
`WORKS`、`openWorkForm` 这些都不是全局变量，测试里**不能直接调**。
必须走真实路径（点标签 → 点编辑按钮），否则会拿到 `typeof WORKS === "undefined"`
而误判成"后台坏了"。

### `dev/cdp_capture.js` —— B站 接口诊断

钩住空间页的 `fetch` / `XHR`，把 `arc/search` 的**真实请求 URL 与响应体**
打印并落盘到 `dev/_shots/cap_*.json`。

**什么时候用**：当 `fetch_bili_list_cdp.js` 翻页失败、想知道页面到底请求了
什么、返回了什么 code 时。这是排查"活动页码变了但列表不刷新"这类问题的
第一手证据（实测就是靠它才发现三页其实都能返回 `code=0`，纯粹是概率性放行）。

```bash
node dev/cdp_capture.js
```

### 样式排查（可选）

想看一眼页面实际长什么样，可以用本机 Chrome 的无头模式截图，
不用装任何依赖：

```bash
"/c/Program Files/Google/Chrome/Application/chrome.exe" \
  --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1440,3000 --virtual-time-budget=20000 \
  --screenshot="tools/dev/_shots/steam.png" "http://127.0.0.1:3000/#steam"
```

`#steam` / `#bili` / `#guest` 是页面的 hash 路由，可以直接定位到某个标签页。
访问自签名证书的 https 站点时还要加 `--ignore-certificate-errors`。
`_shots/` 已在 `.gitignore` 里，不会进仓库。

**★ 一个坑：卡片封面是 `loading="lazy"` 的，视口外的图永远不会加载。**
所以用 `--window-size` 拉高 + 一次截长图时，**下半屏的封面会全是空白**。
要截长图得先滚动触发加载；只截首屏则没这个问题。
需要「打开 → 切到 B站 页 → 截图」这种带交互的截图，用现成脚本：

```bash
node dev/shot_bili.js     # 产出 tools/dev/_shots/bili_108.png
```
