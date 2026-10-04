# AVIF 落地可行性评估

> 评估日期：2026-10-04
> 评估对象：`assets/` 目录下 128 张站点图片（> 8 KB）
> 结论：**建议「部分落地」—— 只对首屏与详情页大图启用，其余维持现状**
> 落地状态：**第一步已执行**（见第九节）。`assets/works/` 下 6 张大图已接入
> `<picture>` + AVIF，线上验证通过。

---

## 一、结论先行

| 项目 | 结论 |
|---|---|
| 收益 | 全量转 AVIF **省 40.0%**（5.62 MB → 3.37 MB），**128 张无一例外全部正收益** |
| 质量 | 抽样 PSNR **35.0–37.6 dB**，全部在视觉无损区间（> 32 dB） |
| 兼容性 | 全球 AVIF 支持 **93–97%**（Chrome 85+ / Firefox 93+ / Safari 16.4+ / Edge 121+） |
| 技术可行性 | ✅ **已验证**：`<picture>` 与现有 `blurUp()` **零冲突**，前端改动极小 |
| **建议** | **部分落地**。不做全量，只做「首屏 + 作品详情大图」两处。 |

**一句话**：技术上完全可行、收益很实在，但**全量落地的边际成本不划算**；按「影响 LCP 的图」优先，用最小改动拿 80% 的收益。

---

## 二、实测数据

### 2.1 体积收益（全量 128 张）

```
参数：当前主文件 WebP q88  vs  AVIF q62 speed=4

当前总体积：5.62 MB
全转 AVIF  ：3.37 MB
净节省    ：2.25 MB（40.0%）
编码总耗时：77.3 s（平均 0.604 s/张）
变大的文件：无（128/128 全部正收益）
```

按当前真实格式分组（注意：主文件保留 `.jpg` 扩展名，内容实际是 WebP）：

| 真实格式 | 数量 | 体积 |
|---|---|---|
| webp | 119 张 | 4.92 MB |
| jpeg | 9 张 | 710 KB |

> 那 9 张仍是 JPEG 的是「压完反而不划算」被安全阀跳过的图（小图/已高度优化）。

### 2.2 质量验证（全量 PSNR）

对 5 张代表性图片（最大摄影图、渐变天空、普通封面、PNG 截图 ×2）做**全量** PSNR：

| 文件 | 当前 | AVIF | 省 | PSNR |
|---|---|---|---|---|
| w20261002-191034-c997b941.jpg | 209K | 122K | 41.6% | **36.4** |
| forza-horizon-5.jpg | 83K | 46K | 45.1% | **36.8** |
| BV1ZmFhe3EuZ.jpg | 82K | 55K | 32.3% | **35.0** |
| vrc.png | 138K | 78K | 43.3% | **37.6** |
| w20261002-033050-cea02996.png | 102K | 57K | 44.5% | **35.1** |
| **合计** | **615K** | **358K** | **41.7%** | — |

全部 **≥ 35 dB**，远高于「视觉无损」下限 32 dB。**无糊化、无色偏。**

### 2.3 兼容性

| 浏览器 | AVIF 支持起始版本 |
|---|---|
| Chrome / Chromium | 85（2020-08） |
| Chrome for Android | 85（2020-08） |
| Edge | 121（2024-01） |
| Firefox 桌面 | 93（2021-10） |
| Firefox Android | 113（2023-05） |
| **Safari（macOS / iOS）** | **16.4（2023-03）** |
| Samsung Internet | 14（2020-12） |
| Opera | 71（2020-09） |

**全球合计支持率：93% ~ 97%**（各来源统计口径不同）。
缺口部分主要是 iOS 15 及以下的旧设备、企业锁版浏览器。

⚠ **Safari 16.4 是关键分水岭**（2023-03）。iOS 16.4 之前完全不支持 AVIF。
若站点受众里有相当比例的旧 iPhone / iPad，必须保留降级链。

---

## 三、技术可行性实测（关键）

### 3.1 最大风险：`<picture>` 会破坏现有的 blur-up 吗？

**不会。实测证明两者天然兼容。**

本站的图片渐进加载 `blurUp()` 用的是「`new Image()` 后台预载 → 换 `img.src` → 加 `.pimg-on`」。直觉上 `<picture>` 的 `<source>` 优先级高于 `img.src`，换 `src` 应该失效。**实测结果相反**：

```
img.src       = forza-horizon-5.jpg          ← blurUp 换上去的
img.currentSrc= xxx.jpg.avif                  ← 浏览器实际用的
picture 内 source srcset = ["xxx.jpg.avif"]

=> 浏览器实际选择: xxx.jpg.avif   ✅
```

**结论**：`<picture>` 包住 `<img>` 后，`blurUp()` 换 `img.src` 的行为完全不受影响，
浏览器仍然优先选用 `<source>` 里的 AVIF。**无需改动任何 JS 逻辑。**

### 3.2 三种接入方案的实测对比

| 方案 | 写法 | 实测结果 | 评价 |
|---|---|---|---|
| ① 直接换 `src` | `<img src="x.avif">` | ✅ 可加载 | **无法降级**，旧 Safari 白板，不可用 |
| ② `<picture>` 原生 | `<picture><source…><img src="x.jpg"></picture>` | ✅ `currentSrc=x.avif` | **推荐**，但 `blurUp` 换 src 会失效 |
| ③ **`<picture>` + `blurUp`** | 在 ② 基础上保留 `blurUp` | ✅ `currentSrc=x.avif`，占位/淡入正常 | **最优解** |

方案③ 实测细节：
- `currentSrc` = `.avif` ✅ 走了 AVIF
- `naturalWidth/Height` = 1280×720 ✅ 解码正确
- `complete` = true ✅ 加载完成
- blur-up 占位 → 淡入正常 ✅

### 3.3 文件命名策略

现有脚本产出的是 **`xxx.jpg.avif`**（保留原扩展名 + 追加 `.avif`），URL 会带双后缀。

**建议改为标准 `xxx.avif`**（去掉原扩展名）：
- 好处：URL 干净、语义正确、避免某些 CDN / 中间件的 MIME 嗅探误判
- 代价：需改一点脚本逻辑（`os.path.splitext` 两段）

---

## 四、落地成本

### 4.1 仓库与部署体积

| 项 | 数值 |
|---|---|
| 新增文件 | 128 个 `.avif` 副本 |
| 新增仓库体积 | **+3.37 MB**（永久进入 git 历史） |
| 部署体积变化 | assets 6.5 MB → 约 9.9 MB |
| 每次更新图片 | 同时产生 webp + avif 两份 diff |

云朵免费版静态资源上限 **20 MiB（gzip 后）**，当前占用离上限还有余量，不会触发限制。
但要注意：**二进制文件进 git 是不可逆的**（历史无法瘦身），仓库越滚越大是长期负担。

### 4.2 编码时间

**77.3 s / 128 张**（约 0.6 s/张，单线程）。

这是**一次性离线成本**，不影响线上。但如果把它加进 `更新数据.bat` 的常规流程，每次全量重跑会多等 1 分多钟。可用 `--only` 增量规避。

### 4.3 前端改造面

好消息：**图片 URL 生成高度集中**，改造面很小。

| 位置 | 数量 | 说明 |
|---|---|---|
| `assets/js/app.js` 的 `<img>` 生成点 | 12 处 | 但都汇聚到 `imgPath()` / `workImg()` / `coverUrl()` 少数几个函数 |
| `index.html` 里的 `<img>` | 3 处 | 含头像、favicon 等 |
| `bili_videos.json` 封面路径 | 108 条 | **纯数据**，不需改动（`<picture>` 在 JS 渲染时包一层即可） |
| `xbox_games.json` 封面路径 | 15 条 | 同上 |
| D1 作品记录 | 运行时 | 需在渲染层统一包 `<picture>` |

**关键**：不需要改任何 JSON / D1 数据，只需在**渲染层**统一加一个
`avifSource(url)` 辅助函数返回 `<source>` 标签即可。

### 4.4 现有工具链就绪度

`tools/optimize_images.py` **已经内置 AVIF 生成能力**（`--avif` 开关），
包括 alpha 通道判断、PSNR 自检、编码失败降级。**无需从零开发。**

默认不生成 AVIF 的原因（脚本注释原话）：
> AVIF 虽然比 WebP 再省约 40%，但要用上必须把 HTML/JS 里的 `<img>` 改成 `<picture>`
> ……前端没有 `<picture>` 时这些文件永远不会被请求 —— 纯属浪费。

本次评估正是来回答「到底值不值得把 `<picture>` 补上」。

---

## 五、风险清单

| 风险 | 等级 | 说明 | 对策 |
|---|---|---|---|
| 旧 Safari（< 16.4）无 AVIF | 中 | iOS 15 及以下占比不可忽略 | `<picture>` 降级链，**必做** |
| 仓库体积不可逆增长 | 中 | +3.37 MB 永久进 git 历史 | 只对少量图启用，控制增量 |
| `xxx.jpg.avif` 双后缀 | 低 | 语义不洁、可能有 MIME 嗅探问题 | 改为标准 `xxx.avif` |
| AVIF 编码慢 | 低 | 0.6 s/张，一次性离线成本 | 增量处理，不进常规流程 |
| AVIF 在 flat graphic 上可能不如 WebP | 低 | 实测 5 张全部正收益，未复现 | PSNR 自检已有安全阀 |
| 部署体积 | 低 | 当前离 20 MiB 上限还有余量 | 定期复查 |

---

## 六、建议方案：**部分落地**

### 6.1 为什么不做全量

1. **收益与成本不匹配**：128 张图的 2.25 MB 省下来，只有**首屏那一两张**真正影响 LCP；
   滚动到下面的图是懒加载的，用户根本感知不到省了 40%。
2. **仓库永久膨胀 3.37 MB**：git 历史不可回退，长期是负担。
3. **改造面虽小但非零**：12 个 `<img>` 生成点都要动，有引入 bug 的风险（本项目已多次踩 CSS/JS 静默故障）。
4. **首屏图片总数少**：按「影响 LCP 的图优先」原则，只需处理一小部分。

### 6.2 推荐做法（分两步）

**第一步（低风险、高收益）** —— 只处理 **作品墙首屏 + 作品详情页大图**：

- 这两处是**最大、最影响 LCP** 的图（`assets/works/` 下 800 KB，其中单张最大 209 KB）
- 数量约 8–10 张，新增仓库体积 **< 500 KB**
- 改造点集中在 `app.js` 的 2 个渲染分支（作品卡片 `blurUp` 处 + 详情页大图处）
- 配套改 `optimize_images.py` 支持「只处理指定目录」

**第二步（观察后再定）** —— 若第一步效果满意，再评估是否扩展到：
- `assets/xbox/`（972 KB / 15 张）：游戏封面是网格展示，首屏可见
- `assets/bili/`（4.3 MB / 108 张）：量最大，但对 LCP 影响小，**建议最后考虑**

### 6.3 明确不做

- **不追求全量 128 张**：收益主要在「看不见的地方」
- **不去掉 WebP 主文件**：必须保留，作为降级链的兜底
- **不引入 Cloudflare Images 等付费服务**：本项目一直坚持零成本方案，
  纯静态 `<picture>` 已经够用

### 6.4 若决定执行，实施清单

1. 改 `tools/optimize_images.py`：
   - 新增 `--dirs` 参数（只处理指定子目录）
   - AVIF 产物命名改为标准 `xxx.avif`（`splitext` 两段）
2. 改 `tools/hash_assets.py`：把 `.avif` 也纳入哈希（若走内容哈希策略）
3. 改 `assets/js/app.js`：
   - 新增 `avifSource(url)` 辅助函数 → 返回 `<source type="image/avif" srcset="…">`
   - 在作品卡片 / 详情页的 `<img>` 外层包 `<picture>`
   - **保留 `blurUp()` 不动**（实测零冲突）
4. 加 `_headers`：`.avif` 设 `image/avif` + 长缓存
5. 回归验证：
   - 真机 iOS Safari（若可测）确认降级链生效
   - headless 确认 `currentSrc` 走的是 avif
   - 跑 `tools/dev/verify_deploy.sh`

---

## 七、复现方式

本次评估的两个脚本已保留，可随时重跑：

```bash
# 全量体积收益测评（只读，不写盘）
python tools/dev/avif_probe.py

# 抽样快速测评
python tools/dev/avif_probe.py --limit 20

# 质量 + 方案验证（产出 .tmp-avif/ 供浏览器实测）
python tools/dev/avif_probe2.py
```

`avif_probe2.py` 产出的 `.tmp-avif/picture-test.html` 是三种接入方案的对照页，
可用真实浏览器打开人工确认降级行为。

---

## 八、附：与其他优化项的收益对比

| 优化项 | 收益 | 成本 | 状态 |
|---|---|---|---|
| ① CSS 拆外链 + 哈希 | HTML 122 KB → **35.6 KB（省 70.9%）** | 低 | ✅ 已完成 |
| ② CSS 结构自检脚本 | 防「注释丢失」类静默故障 | 低 | ✅ 已完成 |
| ③ AVIF（全量） | 图片 5.62 MB → 3.37 MB（省 40%） | **中** | 📋 本报告 |
| ③ AVIF（部分） | 首屏大图省约 40%，仓库只增 < 500 KB | **低** | 💡 建议执行 |

**注意**：① 省下的 86 KB HTML 与 ③ 省下的 2.25 MB 图片，
对**首屏加载时间**的贡献是不对等的 —— 都远不如「减少一次请求」或「干掉一个阻塞脚本」。
这也是为什么建议 ③ **按需部分落地**，而不是追求数字上的最大化。

---

## 九、落地实施记录（2026-10-04）

按第六节「部分落地」建议执行了**第一步**：只给 `assets/works/` 的作品图
产出 AVIF 副本，其余目录维持现状。

### 9.1 实际改动

| 文件 | 改动 |
|---|---|
| `tools/optimize_images.py` | 新增 `--dirs`（只处理指定子目录）、`--no-primary`（只产 AVIF 不改主文件）；AVIF 产物命名从双后缀 `x.jpg.avif` 改为标准 `x.avif` |
| `assets/js/app.js` | 新增 `avifCandidate()` / `pictureHtml()`；作品卡片与详情页主图接入 `<picture>`；新增全局 `__zfsnAvifFallback()` 失败兜底 |
| `assets/css/app.css` | 新增 `picture{display:contents}`，让包装层在布局树中消失 |
| `_headers` | 新增 `/assets/*.avif` → `image/avif` + 长缓存 |
| `assets/works/*.avif` | 6 个新文件，共 **451 KB**（原 768 KB，省 41.4%） |

命令：
```bash
python tools/optimize_images.py --avif --dirs assets/works --no-primary
python tools/hash_assets.py
```

### 9.2 ⚠ 最重要的发现：`<picture>` 的降级语义被普遍误解

**`<picture>` 只在「类型/条件不匹配」时跳过 `<source>`，不会在「加载失败」后回落。**

实测证据（headless Chrome + CDP，把 `.avif` 请求全部改成 `BlockedByClient`）：

```
img.getAttribute("src") = "vrc.png"      ← 主文件
img.currentSrc          = "vrc.avif"     ← 卡在失败的候选上
img.naturalWidth        = 0              ← 破图，没有回落
```

这与很多人的直觉相反（「404 了浏览器自然会换下一个」）。所以：

- **老浏览器（真不支持 AVIF）是安全的** —— 它在解析阶段就跳过 `<source>`，不发请求
- **但「支持 AVIF 但文件缺失 / MIME 不对」= 用户看到破图** —— 这是真风险

对策：`pictureHtml()` 给 `<img>` 挂 `onerror="__zfsnAvifFallback(this)"`，
失败时摘掉同级 `<source>` 并重置 `src`，强制回落主文件。复测结果：

```
被拦截的 .avif 请求数: 18
能正常显示: 9/12    ← 9 张作品图全部正常（另 3 个是未展开的留言区图）
破图数: 0
picture 内 source 数: 0   ← 兜底已摘除
```

### 9.3 另一处踩坑：`display:contents` 让 `getBoundingClientRect` 归零

`<picture>` 用了 `display:contents` 后，它自身的 `getBoundingClientRect()`
**恒为 0**（元素在布局树中不存在）。因此验证脚本**不能**拿
`img.parentElement.getBoundingClientRect()` 当基准算宽度比例 ——
必须用 `img.closest('.gitem, .wd-media')`。

这个坑一开始让验证脚本误报 9 处「布局异常」，实际页面完全正常。

### 9.4 第三处踩坑：`_headers` 规则重复命中导致响应头拼接

最初写了 `/assets/*.avif` 与 `/assets/works/*.avif` 两条。线上实测：

```
Content-Type: image/avif, image/avif
Cache-Control: public, max-age=2592000, public, max-age=2592000
```

Cloudflare 对同名响应头是**追加而非覆盖**。删掉子目录那条即可 ——
实测 `/assets/*.avif` 本身就能匹配到 `assets/works/` 下的文件
（与仓库里既有的 SVG 注释「`*` 不跨目录分隔符」看似矛盾，但 AVIF 这条
确实匹配到了，以实测为准）。同源问题参见 `/pvz/pvz-portable.html` 的 charset 重复。

### 9.5 验证结果

| 检查项 | 结果 |
|---|---|
| 正常路径 `currentSrc` | ✅ `/assets/works/vrc.avif` |
| 布局（`display:contents` 后） | ✅ 图宽 255 / 卡片宽 257，无异常 |
| AVIF 全失败时的兜底 | ✅ 9/9 正常显示，0 破图 |
| hover 放大 / blur-up | ✅ 行为不变（`img.pimg` 选择器不受 `<picture>` 影响） |
| 线上 MIME | ✅ `image/avif`（单份，无重复） |
| 线上缓存头 | ✅ `public, max-age=2592000` |
| `regress.cjs` | ✅ 全绿 |
| `verify_deploy.sh` | ✅ 通过（新增第 ⑨ 节 AVIF 专项检查） |

### 9.6 后续可选（第二步，未执行）

若需要继续扩展，按优先级：

1. `assets/xbox/`（972 KB / 15 张）—— 游戏封面首屏可见，收益明确
2. `assets/bili/`（4.3 MB / 108 张）—— 量最大但对 LCP 影响小，**建议最后考虑**

扩展时只需三步：`optimize_images.py --avif --dirs assets/xbox --no-primary`
→ 把目录加进 `avifCandidate()` 白名单 → `hash_assets.py`。
**`avifCandidate()` 的白名单是必需的**：它防止给没有副本的目录拼出注定 404 的候选。
