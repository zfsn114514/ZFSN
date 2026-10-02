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
├── build_bili.py             ← B站 投稿 + 封面 + 账号信息
├── build_bili_profile.py     ← B站 账号信息补抓（风控时的补救）
├── build_xbox_covers.py      ← Xbox 游戏封面（微软官方商店）
├── fetch_covers.py           ← B站 封面补抓（修复工具，平时不用跑）
│
└── dev/
    ├── sanity_frontend.js      ← 前端脚本冒烟测试（顶层运行时错误）
    ├── check_steam_merge.js    ← Steam 自有 + 家庭共享 的合并契约检查
    └── check_api_candidates.js ← 后端地址探测 / 混合内容规则检查
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

### `build_bili.py` → `bili_videos.json`

抓 B站 投稿列表、封面（下载到 `assets/bili/`）、账号信息、视频互动数据。

B站 有风控（`-352` / `412`）。脚本已内置退避重试，**抓不到时会保留旧数据**，
不会把 json 清空。风控严的时候等 5~10 分钟再跑。

### `build_bili_profile.py`

单独补账号信息（昵称 / 等级 / 签名 / 粉丝数）与视频互动数据。
走的是限流较松的 `view` / `relation/stat` 接口，`build_bili.py` 被风控时可以用它救急。

### `build_xbox_covers.py` → 回写 `xbox_games.json`

用微软官方 displaycatalog 接口按游戏名搜封面，下载到 `assets/xbox/`。

Xbox 的**游玩时长和成就无法通过接口获取**，只能从 Xbox 应用手动导出后
填进 `xbox_games.json`，再跑这个脚本补封面。

### `fetch_covers.py`

**修复工具**，日常流程里用不到（`build_bili.py` 抓投稿时会顺带下封面）。
当封面缺失 / 被风控挡掉 / 手工改坏了路径时，单独跑它补齐。
已存在的会跳过，可反复执行。

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

三个脚本都是只读检查，改完前端建议都跑一遍。

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
