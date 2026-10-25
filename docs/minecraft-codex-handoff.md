# 网页版《我的世界》— 接手说明

> 写给人（或另一个 AI）接手这个模块用。目标不是复述历史，而是**让你在不知道前情的情况下
> 不踩已经在踩过的坑**。读一遍大约 5 分钟，能省掉半天。

---

## 1. 这是什么、在哪

浏览器里跑的 2D 沙盒《我的世界》，本站自制（不是 Java 客户端移植，也不是别处的开源项目）。
**界面走原版 Java 1.21.1 的贴图与布局**，不自己设计 UI —— 这是明确的长期要求。

| | |
|---|---|
| 代码目录 | `D:\ZFSNwebsite\minecraft\` |
| 线上地址 | <https://www.zfsnnb.dpdns.org/minecraft/> |
| 玩法文档 | `docs/minecraft.md`（面向玩家，改动玩法时要同步） |
| 规模 | `game.js` ≈ 1700 行、`style.css` ≈ 350 行、`index.html` ≈ 185 行 |

技术形态：**纯前端，没有构建步骤**。一个 `game.js`（ES module）+ 一个 `style.css` +
官方原始贴图。部署在 Cloudflare Worker 的静态资源层（`[assets]` binding），推 GitHub 后
Cloudflare 自动重建，约 1 分钟生效，**没有 workflow 文件**。

---

## 2. 当前状态（务必先看清楚）

`git log` 上最后一次提交是 `d79dd2c`（已推送、线上已生效），内容是：
原版物品栏手感 / 原版天空 / 平滑光照 / 可穿树 / 蹲下 / 聊天指令 / 世界放大到 640×160。

**但工作区里还有一批未提交的改动** —— 挥手动画 + 手上显示物品：

```
 M  _headers
 M  minecraft/game.js
 M  minecraft/index.html
 D  minecraft/game.50b353b2.js      ← 旧的带哈希文件，被删
 ?? minecraft/game.5bfd2573.js      ← 新生成的带哈希文件
 ?? tools/dev/probe_swing.cjs       ← 新测试脚本
```

这批改动本地验证全过（`probe_swing` 18 项 + 四个回归脚本 0 问题），
但**没跑线上回归**（因为没推）。所以你的第一件事多半是：确认这批改动、
提交、推送、然后对着线上再跑一遍 `check_mc_full`。

---

## 3. ★ 改完代码必须做的两步（最容易忘）

```sh
python tools/hash_assets.py                      # 重算哈希、生成新文件名、回写 index.html 与 _headers
python tools/dev/to_crlf.py minecraft/index.html _headers   # hash_assets 会写成 LF，得转回 CRLF
```

**为什么必须有第一步**：`index.html` 引用的是 `game.5bfd2573.js` 这种带内容哈希的文件名，
不是 `game.js`。你改了 `game.js` 却不跑 `hash_assets.py`，浏览器加载的仍然是**旧代码**，
于是你会对着「明明改了却没生效」的现象调试半天。

磁盘上同时存在 `game.js`（源文件）和 `game.<hash>.js`（部署产物），**两个都要在 git 里**。
每次改 `game.js` 都会新增一个哈希文件、删掉上一个，git 会把它识别成 rename。

---

## 4. 代码地图（按功能找，别按行号找）

```
minecraft/game.js
├─ W, H, DAY, BLOCKS, ITEMS, RECIPES      常量与数据表
├─ generate(seed)                          地形生成（含 natural[] 标记）
├─ World                                   世界状态 + 物理 + 合成 + 存档
│   ├─ update(dt)                          固定 1/60 步长；玩家/生物/水/天气/昼夜
│   ├─ solid / isThru / set / get          碰撞与方块读写
│   ├─ stepWater / setWaterSource          流体
│   ├─ place / mine / attack / eat         交互入口（会调 swing()）
│   ├─ swing(dur)                          一次性挥臂
│   ├─ findGridRecipe / findTableRecipe    合成
│   └─ serialize / World.restore           存档（version:3，RLE）
├─ entityMesh(type,time,velocity,swing)    生物/玩家的盒模型（脚部在 y=0，向上为正）
├─ drawEntity(ctx,images,mob,time,cx,groundY,heightPx,yaw,hold)   盒模型的软件光栅化
├─ steveArmAngle / steveHand / STEVE_ARM   右臂角度与手的模型坐标
└─ boot 区（DOM 装配、渲染循环、物品栏、聊天、触屏）
```

快速定位技巧：

```sh
grep -n "function steveArmAngle" minecraft/game.js
grep -n "window.zfsnMC" minecraft/game.js     # 探针接口，测试全靠它
grep -n "#touch-controls" minecraft/style.css
```

---

## 5. ★ 陷阱清单（每条都真的踩过）

### 渲染

1. **`<dialog showModal()>` 进入浏览器 top layer，任何 `z-index` 都盖不过它。**
   背包里「跟随鼠标的物品图标」（`#held-cursor`）必须挂在 `#inventory-dialog` **内部**，
   挂到 `body` 上哪怕 `z-index:900` 也完全看不见。

2. **`.slot` 绝对不能写 `position:absolute`。** 它是 grid 的子项
   （`#slots` / `#inv-hotbar` / `#craft-grid`），绝对定位会脱离网格全堆到容器左上角 ——
   表现是「物品叠在一起」且点击永远命中同一格，看着像「拿不起物品」。

3. **模型面向右侧时，靠近镜头的是 `x = -6` 那条手臂。**
   `rot()` 里 `z' = -x*sy + z*cy`，yaw≈0.95 时 `+x` 被转到负 z = 背对镜头。
   要动「看得见的那只手」就必须动 `-6` 那条（它的 uv `[40,16]` 也正是原版右臂）。

4. **手臂角度只有一个来源：`steveArmAngle(time, vx, swing)`。**
   模型（`entityMesh`）和手上物品（`drawEntity` 里的 `hold`）必须调同一个函数。
   曾经两边走不同分支，静止时差 0.3 rad → 物品悬浮在离手半个手臂的位置。

5. **绘制顺序按 `faces[].depth` 排序。** 手上的物品是**平面精灵**（MC 里本来就是一张图，
   不是立方体），塞进同一个 `faces` 数组参与排序，不要单独在最后画。

### 玩法

6. **自然生成的树可穿透，玩家放的有碰撞。** 靠 `natural: Uint8Array` 标记区分，
   `set()` 会把标记清 0（挖掉再放回来 = 实体）。**不能只判方块 id** —— 两者 id 都是 5/6。

7. **生物离玩家远时必须「挂起」，不能 filter 掉。**
   原来写 `mobs.filter(m => Math.abs(m.x-p.x) < 95)`，世界扩到 640 宽后等于一走动就把大半张图
   的动物删了（构造时刷 28 只，实测只剩 6 只）。现在远处只把 `vx` 置 0 并跳过更新。

8. **合成格每格上限 1。** `slotLimit(area,id) = area==='grid' ? 1 : stackLimit(id)`。
   按 64 算会导致 `recipeIn` 把「1 个格子」当成「3 份材料」，凭空合成。

9. **关背包时手上那叠必须塞回背包**（塞不下走 `world.add` 掉落兜底），
   直接 `heldItem = null` 就是凭空吞物品。

10. **合成器采样相位不能用挖掘进度。** 石头慢、泥土快，进度回绕会让挥手动画跳帧。
    用独立的 `mining.swingT` 累加，渲染时 `(swingT*2.4)%1`。

### 手机端

11. 触屏键底边 **84px（窄屏 <760px 用 104px）**，`@media (pointer:coarse) #chat { bottom: 156px }`
    是配套的（156 = 触屏键顶边 148 + 8px 缝）。**改一处必须同步另一处**，
    否则要么聊天提示压在按钮上、要么按钮压在血量条上。

12. **跳跃键必须在右手组「整排最右端」。** 只挪进右手组第一位的话中心 x≈145（375 屏），
    仍在左半边，等于没移。断言阈值用 `centerX > innerWidth * .7`，别用 `> innerWidth/2`。

### 存档

13. **`blocks` / `natural` / `water` 走 RLE 压缩**（`[值,重数,...]`），存 `version: 3`。
    5 万格直接 JSON 是 200KB+。`World.restore()` 对 v1/v2/v3 都接受；
    **尺寸对不上时保留新地形、只迁移玩家数据**并置 `migrated = true` —— 不报错，也不吞存档。

14. 存档 `localStorage` 键是 `zfsn.minecraft2d.v1`（键名里的 v1 是历史遗留，与存档内部的
    `version` 字段无关，别改键名否则所有人存档丢失）。

### 环境（这台机器的怪问题）

15. **本机装了 IDM（Internet Download Manager），会静默吞掉音频请求。**
    它把 `audio/ogg` 的响应重写成 **`204 No Content` + 空体**，而 `204` 属于 2xx、
    `r.ok` 仍是 `true` → 接着 `decodeAudioData` 报 `Unable to decode audio data`。
    **带 `Range: bytes=0-` 的请求不在接管名单里**，`game.js` 的 `fetchSoundBytes()` 就靠这条兜底。
    排查任何「fetch 拿到空体」先怀疑 IDM：判据是 `.dat` 后缀 200 而 `.ogg` 后缀 204。

16. **`git push` 判成败不要用管道。** `if git push 2>&1 | tail -3` 取的是 `tail` 的退出码，
    成败都是 0。要写成 `if git push > /tmp/p.log 2>&1; then ... fi`。

17. **验证文件是否同步，比 blob hash，不要比字节数。**
    `core.autocrlf=true` 时工作区是 CRLF、git 内是 LF，字节数差 = 行数，
    看起来像没同步其实完全一致。用 `git rev-parse HEAD:<path>` 对比 `origin/main:<path>`。

---

## 6. 测试工具箱

所有浏览器测试都走同一个 runner：

```sh
sh tools/dev/mc_shot.sh tools/dev/<脚本>.cjs
# 对线上跑（本地 mock 通过 ≠ 线上通过）：
MC_URL=https://www.zfsnnb.dpdns.org/minecraft/ sh tools/dev/mc_shot.sh tools/dev/check_mc_full.cjs
```

runner 会拉起 headless Edge + CDP，跑完输出 `PASS` / `FAIL` 与问题列表。

| 脚本 | 覆盖 |
|---|---|
| `check_mc_full.cjs` | 主回归：3D 生物、水流、挖掘掉落、音效、HUD 几何、熔炉 |
| `probe_inv.cjs` | 背包、2×2 与工作台合成 |
| `probe_drag.cjs` | 物品栏四种操作（真实鼠标事件） |
| `probe_features.cjs` | 世界尺寸、穿树、蹲下、聊天指令 |
| `probe_swing.cjs` | 挥手动画、手上物品、模型角度一致性 |
| `probe_mobile.cjs` | 375 / 390 宽布局、聊天栏、跳跃键位置与真实触摸跳跃 |

★ **跑测试前先 `taskkill //F //IM msedge.exe`**，残留的浏览器进程会占住调试端口。

★ **验证脚本会「撒谎」**：取不到值是空串/`null` → falsy → 假通过。
写断言时把实际值一起打印出来，并**故意改坏输入跑一遍**确认它真会报错。

### 写新探针时的三个坑

- **合成 `KeyboardEvent` 派发到 `window` 到不了 `document` 上的监听器**
  （window 在传播路径之上，不是它的祖先）。用 CDP `Input.dispatchKeyEvent`。
- **合成 `PointerEvent` 测不了触屏按钮**：处理函数第一行 `setPointerCapture(e.pointerId)`
  对未激活的 pointerId 抛 `NotFoundError`，`heldTouches` 根本不会被写入。
  用 `Input.dispatchTouchEvent` 传真实坐标。
- **`el.click()` 测不出重叠格子的 bug**，必须真实鼠标事件（`Input.dispatchMouseEvent`）。
- **创造模式挖方块只要 0.12 秒**，探针还没采样就已经挖穿、`world.mining` 被置回 null，
  看起来像「鼠标没生效」。测挖掘要用**生存模式**。
- 目标方块不要取 `floor(p.y + p.h)` —— 那是玩家脚底所在的**空气格**，取 `world.surface[x]`。
- 验证完游戏页要 `Page.navigate about:blank`，否则常驻的 `requestAnimationFrame`
  会一直占着渲染进程，下次连 `Page.enable` 都超时。

探针接口在 `game.js` 末尾的 `window.zfsnMC`：`world` / `images` / `playing` / `chatOpen` /
`runCommand` / `entityMesh` / `drawEntity` / `steveArmAngle` / `steveHand` /
`screenOf(wx,wy)`（世界坐标 → 屏幕像素，点方块全靠它）/ `view`（相机与 tile 尺寸）。

---

## 7. 还没做 / 已知薄弱的地方

以下是观察到的，不是结论，按你的判断取舍：

- **工作区这批挥手改动还没提交、也没跑线上回归** —— 优先级最高。
- `index.html` 的「操作说明」面板和 `docs/minecraft.md` 已经按「Shift 蹲下、双击疾跑、
  T 聊天」更新过，但**改玩法时容易忘同步**，建议当一次改动的一部分来处理。
- 音效在装了 IDM 的机器上会静默失败（见陷阱 15）。目前只有 Range 兜底，没有用户可见的提示。
- 手机端触屏现在 7 个按钮挤在两行区域里，320 宽的小屏没测过。
- 世界 640×160、每帧全量重绘 + 光照贴图放大，中低端手机上的帧率没有量化过。
- 存档只在本机 `localStorage`，跨设备靠菜单「导出 / 导入存档」，没有云端同步。
- 联机、红石、下界、完整流体、全部 Java 版配方都还没有（这是定位上的取舍，不是 bug）。

---

## 8. 不要动的地方

- **网站留言板（`.glist`）的布局已定型**，用户明确要求「保持一开始的样子」。
  和 MC 无关，但同一个仓库里，别顺手「优化」。
- **AVIF 全量转换**已经评估过但**故意只落地了 6 张**（`docs/avif-evaluation.md`）：
  全量会让仓库永久 +3.37MB 且 git 历史不可回退。这是决定，不是半途而废。
- **`.assetsignore` 里临时目录必须写通配 `.tmp-*/`**。逐个列（`.tmp-v/` 那种）漏一个就会
  被整个打包，`.tmp-mc/` 是 Chrome profile 有 274MB，直接报 `Asset too large`
  而且 wrangler **只说这一句，不告诉你哪个目录**。


## 9. 接手验证更新（2026-10-25）

- 挥手与手持物品已提交并推送：`98a3510`。推送前 fetch、本地 probe_swing 和 check_mc_full 均通过。
- 等待 Cloudflare 重建后，线上 check_mc_full 通过；线上 HTML 引用 `game.5bfd2573.js` 已核实。
- 后续本地修复：320px 下快捷栏裁切、跳跃按钮越界、背包面板越界。
  保留 Java 原版贴图，缩放 HUD/背包；右侧动作键两行，跳跃键在最右端；聊天底边配套调高。
- probe_mobile 增加 320×568，保留 375/390，加入实际屏宽检查，失败返回非零退出码。
  修复前实际报错并返回 1，修复后全部通过并返回 0；截图已目视核对。
- 上述小屏改进未提交、未推送，不能把本地通过说成线上已生效。
- PowerShell 的 PATH 没有 sh，使用 `& 'C:/Program Files/Git/bin/sh.exe' tools/dev/mc_shot.sh ...`。


## 10. 工具与建材更新（本地，未提交）

- 工具由原版 16×16 alpha 轮廓生成薄立体模型，toolVertex 定义柄部到掌心的变换；toolFaces 缓存轮廓。
- 渲染必须在手持模型加入后再排序；透明工具正反面不能直接 fillRect 阴影，否则出现矩形底色。
- 新增 10 种物品：钻石斧/剑/锹、木炭、石砖、砂岩、平滑石头、铁块/钻石块/煤炭块。
  方块 ID 仅追加，旧地形 ID 不变。官方贴图导入脚本和 manifest 已更新。
- 熔炉预留原料再规划燃料，两根木棍烧一件；煤炭块 800 秒燃料，存档恢复不可再钳制到 80。
- unrle 校验数值、游程和总长，坏存档不再被 Uint8Array 静默截断。
- 字体重新生成并在 CSS 加内容版本参数；所有 JS/CSS 哈希已同步。
- node --test tools/dev/test_minecraft.mjs：8 项通过。probe_swing 新增所有新贴图和双朝向工具检查。
- 物品总计 60 种（包括内部水/基岩），合成配方 31 条；仍为材料数量匹配，不是完整 Java 配方。
