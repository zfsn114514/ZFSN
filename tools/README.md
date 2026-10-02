# tools —— 数据脚本说明

网站上的数据（Steam 游戏、B站 投稿、Xbox 封面）都由这里的脚本抓取，
生成站点根目录下的 `.json` 文件，前端直接读取。

**日常只需要双击 `更新数据.bat`**，其余脚本不用手动跑。

---

## 目录结构

```
tools/
├── 更新数据.bat              ← 日常就双击这个
├── config.json               ← 集中配置（Steam Key / UID / 路径）
├── common.py                 ← 公共工具（路径定位、HTTP、写盘）
│
├── build_steam_owned.py      ← Steam「自己拥有」的游戏（需 API Key）
├── build_steam_family.py     ← Steam「家庭共享」的游戏（无需 Key）
├── build_bili.py             ← B站 投稿 + 封面 + 账号信息
├── build_bili_profile.py     ← B站 账号信息补抓（风控时的补救）
├── build_xbox_covers.py      ← Xbox 游戏封面（微软官方商店）
├── fetch_covers.py           ← B站 封面补抓（修复工具，平时不用跑）
│
└── dev/
    ├── sanity_frontend.js      ← 前端脚本冒烟测试（顶层运行时错误）
    ├── check_family_block.js   ← 家庭共享区块的数据契约检查
    └── check_api_candidates.js ← 后端地址探测 / 混合内容规则检查
```

---

## 各脚本干什么

### `build_steam_owned.py` → `steam_games.json`

走 Steam 官方 Web API，拿**自己拥有**的游戏 + 精确游玩时长。

- **需要 API Key**，填在 `config.json` → `steam.api_key`
- 申请地址：<https://steamcommunity.com/dev/apikey>
- 前置条件：Steam 个人资料 → 隐私设置 → 「游戏详情」必须设为**公开**
- Key 失效时会**明确报错并保留旧数据**，不会把 json 写坏

### `build_steam_family.py` → `steam_family.json`

拿**家庭共享**的游戏。

Steam 的 `GetOwnedGames` 接口只返回自己拥有的游戏，共享来的不在里面 ——
所以站点原本一直看不到它们。这个脚本换个思路：共享游戏既然装了，
就会出现在本机 Steam 的库列表里，而**这些数据全在本地，不需要任何 Key**。

原理：
1. 读 `<Steam>/config/libraryfolders.vdf` → 各磁盘库里已安装的 appid
2. 和自己拥有的做差集
3. 用商店公开接口补名称、封面，顺便用它返回的 `type` 过滤掉
   DLC / 原声带 / demo / 工具
4. 游玩时长从 `<Steam>/userdata/<accountid>/config/localconfig.vdf` 读

> ⚠ **已知限制**：只能发现**已安装**的共享游戏。
> 家庭里其他成员库中但你没装过的游戏，本地没有任何记录，列不出来。
> 想拿到完整共享库，只能登录每个成员的账号逐个导出。

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

## 常见问题

**Q: 跑完没变化？**
脚本设计成「抓不到就保留旧数据」。看控制台输出的错误提示，
多半是风控或 Key 失效。

**Q: Steam 游戏数变少了？**
先检查 `config.json` 里的 `max_games` / `min_playtime` 是不是被改过，
再确认 API Key 是否还有效。

**Q: 家庭共享游戏数不对？**
它只统计**已安装**的。想让某款共享游戏出现，先在 Steam 里装上它。

**Q: 数据文件的结构能改吗？**
**不能随便改字段名**。前端的渲染逻辑是按字段名硬编码的，
改了字段名页面会整块渲染失败。新增字段没问题，重命名/删除要同步改前端。
（`dev/check_family_block.js` 会帮你守住 `steam_family.json` 这一份。）

**Q: 改了后端端口，前端要动吗？**
要。`index.html` 与 `admin.html` 里的 `HTTP_API_PORT` / `HTTPS_API_PORT`
两个常量必须和 `D:\ZFSN-server\server.js` 的 `PORT` / `HTTPS_PORT`
默认值一致（3000 / 3443），否则跨端口访问时探测不到后端。
改完跑 `node dev/check_api_candidates.js` 确认没写错。

---

## 开发用

三个脚本都是只读检查，改完前端建议都跑一遍。

### `dev/sanity_frontend.js` —— 顶层运行时错误

把 `index.html` / `admin.html` 里的内联脚本放进桩环境跑一遍，
能抓出未定义变量、拼错函数名这类顶层运行时错误。比纯语法检查有用得多。

```bash
node dev/sanity_frontend.js
```

> 注意：桩环境里 `fetch` 必然失败，会触发各数据源的降级分支，
> 那些分支依赖真实 DOM，报错属正常（会标成"桩限制"），按错误类型排除即可。

### `dev/check_family_block.js` —— 家庭共享数据契约

用真实的 `steam_family.json` 跑一遍 `index.html` 里的家庭共享渲染逻辑，
断言卡片数量、角标、链接、分批展开、统计文案。

**为什么需要它**：这个 json 由 Python 生成、由前端手写 JS 消费，
两边任何一边改了字段名（`games` / `hours` / `playtime` / `cover` /
`store` / `count` / `total_hours`），页面会**静默不显示**，肉眼很难发现。

```bash
node dev/check_family_block.js
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
`_shots/` 已在 `.gitignore` 里，不会进仓库。
