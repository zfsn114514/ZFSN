# 方块世界 2D

本地 IIS 入口：<http://localhost:88/minecraft/>。首页和游戏库的「本站自制」卡片均可进入。
这是浏览器内运行的独立单人 2D 沙盒，不是 Java 客户端移植。尚无联机、红石、下界、完整流体模拟或全部 Java 版配方。

## 玩法与存档

- A/D 或方向键移动，空格跳跃，Shift 疾跑，左键长按挖掘/攻击，右键放置。
- 数字 1–9 / 滚轮选择快捷栏，E 背包合成，F 进食或附近工作站交互，Esc 暂停。
- 手机点击场景选定方块，再长按「挖掘」；方向、跳跃、放置、使用均有触屏按钮。
- 原木 → 木板 → 工作台和木棍 → 木镐 → 圆石 → 熔炉；高级合成需附近有工作台。
- 20 分钟有效游戏时间为一昼夜。新世界从第 120 秒开始，约 528 秒后进入夜晚。
  `World.update(dt)` 的 `dt` 单位为秒，60 Hz 固定步长为 `1 / 60`，不能把 `DAY` 当作帧数。
- 菜单、背包、失焦时暂停；自动存档每 20 秒一次，暂停和离开页面也会保存。
- 存档位于当前域名、当前浏览器的 `localStorage`，键为 `zfsn.minecraft2d.v1`。
  本地、线上和不同设备之间通过菜单「导出存档 / 导入存档」迁移。

## 素材与更新

`minecraft/textures/` 为从 Mojang 官方 Java 1.21.1 客户端提取的 59 张原始 PNG。
`minecraft/asset-source.json` 保存官方 URL 和客户端 SHA-1，`textures/manifest.json` 保存每张 PNG 的 SHA-256。
完整客户端仅下载到系统临时目录，不包含在网站中。贴图版权属于 Mojang / Microsoft，游戏标题页有非官方作品说明。

```powershell
python tools/import_minecraft_textures.py
# 也可以传入同版本、未经修改的客户端 jar 路径
python tools/hash_assets.py
python tools/hash_assets.py --check
```

修改游戏 JS/CSS 后运行哈希脚本。游戏入口、主页和管理页一起校验，旧的受管哈希副本由脚本清理。

## 验收（2026-10-25）

本轮没有重做已完成的首页入口与样式工作，也没有提交或推送 Git。

1. **桌面真实浏览器自然世界**：固定种子 `1`，生存模式、空背包开始；通过鼠标和键盘采集 3 原木 → 12 木板 → 放置工作台 → 合成木镐 → 开采并拾取至少 8 圆石 → 合成熔炉。校验方块 ID、库存数及 UI 工作台文案。为放置井下工作台额外采集 1 圆石，熔炉合成时库存从 9 降到 1。
2. **375 / 390 宽触屏模拟**：使用 Chromium 的移动设备上下文和真实触摸输入事件；右移 X 从 40 到约 41.15、点选草方块、长按挖掘后泥土从 0 增至 1；检查实际截图、背包和控件边界。此项不是实体 iPhone/Android 设备测试。
3. **引擎回归**：验证 20 分钟昼夜、配方消耗及工作台限制、错误工具无矿物掉落、遮挡/放置碰撞、熔炉生成并领取铁锭、存档恢复、损坏存档拒绝、死亡掉落与重生。
4. **资源与路由**：IIS 返回的新 JS/CSS 和全部 59 张 PNG 与本地字节/哈希一致；Cloudflare 本地运行器的 `/minecraft/` 目录路由、最终哈希资源内容及 `immutable` 响应头通过。运行器首次启动较慢，测试需等到 ready；重建哈希前应停止运行器，避免扫描中的旧哈希文件被清理引发 ENOENT。未部署或验证线上域名。
5. **截图发现并修复**：`.primary` 的 `display:flex` 曾覆盖 `hidden`，让无存档的标题页误显示「继续我的世界」。游戏 CSS 现在明确尊重 `hidden`，两种触屏尺寸均增加断言并复测通过。

```powershell
node --test tools/dev/test_minecraft.mjs
# Playwright 安装到临时目录，不改项目依赖
npm install --prefix "$env:TEMP/zfsn-media-check" playwright --no-audit --no-fund
$env:PLAYWRIGHT_MODULE = "$env:TEMP/zfsn-media-check/node_modules/playwright"
$env:MC_URL = "http://localhost:88/minecraft/"
node tools/dev/check_mc_survival.cjs
node tools/dev/check_mc_mobile.cjs
```

浏览器测试各自创建隔离会话，不改用户浏览器存档；无论成功失败都会关闭测试浏览器。
截图与 JSON 证据保存到 `.tmp-mc/acceptance/`，该目录被 Git 和 Cloudflare 静态资源排除。
