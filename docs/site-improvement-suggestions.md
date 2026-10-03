# ZFSN 站点改进建议

> 基于当前代码库的实际情况给出，每条都标了「现状 → 做法 → 代价」。
> 分四组：**UI 优化** / **特效** / **新功能** / **工程与体验**。
> 优先级用 ★ 表示（★越多越推荐先做）。

---

## 一、UI 优化

### 1. ★★★ 顶栏滚动状态：加毛玻璃 + 收缩

**现状**：顶栏是固定定位，滚动到内容区后与正文视觉上贴在一起，缺少层次。

**做法**：滚动超过 40px 时给顶栏加 `.scrolled` 类，触发

```css
#topbar.scrolled{
  background:rgba(10,10,16,.72);
  backdrop-filter:blur(14px) saturate(1.4);
  border-bottom-color:var(--line);
  height:52px;               /* 从 64px 收缩 */
}
```

用 `IntersectionObserver` 监听一个顶部的哨兵元素，比监听 `scroll` 事件省性能（不触发主线程）。

**代价**：约 20 行 JS + 10 行 CSS。移动端 `backdrop-filter` 有性能开销，建议只在 `min-width:768px` 启用。

---

### 2. ★★★ 移动端底部导航栏

**现状**：6 个分区在移动端靠顶栏横向排列，手指够不着（顶栏在屏幕最上方），且横向空间紧张。

**做法**：`max-width:768px` 时把导航移到底部固定，做成 5 个图标的 Tab Bar（首页 / 作品 / B站 / Steam / 留言）。底部是拇指自然活动区，交互效率明显更高。

```css
@media (max-width:768px){
  #topbar nav{position:fixed;bottom:0;left:0;right:0;
    display:flex;justify-content:space-around;
    padding-bottom:env(safe-area-inset-bottom);  /* 适配 iPhone 刘海屏 */
    background:rgba(10,10,16,.9);backdrop-filter:blur(18px);}
}
```

`env(safe-area-inset-bottom)` 是关键，不加会被 iPhone 的底部横条挡住。

**代价**：纯 CSS + 少量结构调整。需要给 `body` 加 `padding-bottom` 避免内容被遮。

---

### 3. ★★ 作品墙瀑布流（改列数自适应）

**现状**：`.gallery` 用 `grid-template-columns:repeat(auto-fill,minmax(232px,1fr))`，所有卡片**强制 4:5**。横图会被裁掉两侧。

**做法**：作品图片宽高比差异大（截图有 16:9，插画有 4:5），全裁成 4:5 会损失信息。两种选择：

- **A. 保持裁剪但优化取景**：把 `object-position` 设成 `center 30%`，人物题材的脸通常在上三分之一，全居中容易切到头。
- **B. 真瀑布流**：用 CSS `columns` 或 JS 分列，卡片按真实比例显示。视觉更丰富，但布局会变得不规则。

推荐 **A**，成本极低（1 行 CSS），效果立竿见影。如果作品以横图为主就选 B。

**代价**：A 是一行 CSS；B 需要改渲染逻辑，约 50 行。

---

### 4. ★★ 焦点可见性（无障碍）

**现状**：站点靠键盘 Tab 时，焦点样式可能被 `outline:none` 清掉了（需要确认）。

**做法**：

```css
:focus-visible{
  outline:2px solid var(--c1);
  outline-offset:3px;
  border-radius:6px;
}
```

用 `:focus-visible` 而非 `:focus` —— 鼠标点击不显示焦点框，键盘操作才显示。这是现代无障碍的标准做法。

**代价**：3 行 CSS。顺带提升 Lighthouse 无障碍评分。

---

### 5. ★ 字体优化：中文子集化

**现状**：站点用系统字体栈（推测），中文渲染依赖用户设备。

**做法**：**不建议**自托管中文字体 —— 一个完整中文字体 5-10MB，得不偿失。当前用系统字体是**正确**的选择。如果想提升标题质感，只对**英文/数字**用一款特色字体（如 Inter / Outfit，约 30KB 子集），中文继续走系统栈：

```css
@font-face{font-family:Outfit;src:url(/assets/fonts/outfit-subset.woff2) format("woff2");
  unicode-range:U+0000-00FF,U+2000-206F;font-display:swap;}
```

`unicode-range` 限定只加载拉丁字符，中文自动回落系统字体。`font-display:swap` 避免字体加载时文字不可见。

**代价**：需下载并子集化字体文件。收益是「数字和英文更精致」，中文无变化。

---

## 二、特效（收敛优先）

> ⚠️ 特效的原则：**已有的粒子背景 + 弹幕 + 光晕已经不少了**。
> 再加特效的边际收益递减，而且会拖慢低端设备。
> 下面按「性价比」排序，只推荐 3 个。

### 1. ★★★ 鼠标跟随光斑（Spotlight）

**现状**：有静态光晕，但不随鼠标动。

**做法**：在 Hero 区加一层径向渐变，中心点跟随鼠标：

```js
document.addEventListener("pointermove", e => {
  hero.style.setProperty("--mx", e.clientX + "px");
  hero.style.setProperty("--my", e.clientY + "px");
}, { passive: true });
```

```css
.hero::before{
  content:"";position:absolute;inset:0;pointer-events:none;
  background:radial-gradient(400px circle at var(--mx) var(--my),
    rgba(255,45,74,.08), transparent 60%);
}
```

**关键**：用 CSS 变量而非直接改元素位置 —— 变量变化只触发**重绘**不触发**重排**，性能好得多。`{ passive: true }` 让浏览器不等 JS 就滚动。

**代价**：约 10 行。建议加 `@media (pointer:fine)` 只在鼠标设备启用。

---

### 2. ★★ 卡片 3D 倾斜（Tilt）

**现状**：`.card:hover` 只有 `translateY(-5px)`。

**做法**：鼠标在卡片上移动时，按位置算 `rotateX/rotateY`：

```js
card.addEventListener("pointermove", e => {
  const r = card.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width  - .5;
  const py = (e.clientY - r.top ) / r.height - .5;
  card.style.transform =
    `perspective(700px) rotateY(${px*8}deg) rotateX(${-py*8}deg) translateY(-5px)`;
});
card.addEventListener("pointerleave", () => card.style.transform = "");
```

**关键**：角度控制在 5-10 度之间。超过 15 度会显得廉价。加 `will-change:transform` 提示浏览器提前准备图层。

**代价**：约 15 行。**只在 `pointer:fine` 启用**，触屏上无意义还卡。

---

### 3. ★★ 图片渐进加载（Blur-up）

**现状**：图片加载完直接出现。

**做法**：给每张图存一个 16x16 的极小缩略图（base64 内联进 HTML，约 300 字节/张），先显示模糊版，真图加载完淡入替换。

```css
.gitem img{filter:blur(12px);transition:filter .4s}
.gitem img.loaded{filter:none}
```

**代价**：需要给现有图片批量生成缩略图（可以扩展 `optimize_images.py` 顺手做）。视觉提升明显，但有额外工作量。

**替代方案**：如果嫌麻烦，当前已有 skeleton 骨架屏，效果也能接受。

---

### 不推荐的特效

| 特效 | 为什么不做 |
|---|---|
| 页面切换动画 | 站点是单页锚点导航，加转场会拖慢每次点击的响应感 |
| 视差滚动（Parallax） | 移动端会引起滚动卡顿，且容易晕 |
| 鼠标自定义光标 | 干扰可用性，用户会找不到光标 |
| 全屏烟花 / 点击爆炸 | 新鲜感过后就是噪音，且耗电 |
| 自动播放的背景视频 | 几十 MB 流量，LCP 直接崩 |

---

## 三、新功能

### 1. ★★★ 作品归档/时间线页

**现状**：作品墙是平铺网格，作品多了之后无法按时间浏览。

**做法**：加一个 `/timeline` 分区，按年月分组：

```
2026 年 10 月
  ├─ 10-02  某个作品标题
  └─ 10-01  另一个作品
2026 年 9 月
  └─ ...
```

**为什么推荐**：这是「个人主页」类站点最自然的信息架构。访客想看的是「你最近在做什么」，而不是随机排列的网格。

**代价**：前端已有完整作品数据（D1 返回），按 `createdAt` 分组渲染即可，约 60 行。

---

### 2. ★★★ 作品标签 + 筛选

**现状**：作品有 `tag` 字段（代码里已用到 `w.tag`），但只用于显示分类标题。

**做法**：把标签做成可点击的筛选器。点击「绘画」只显示绘画类作品。

```js
let activeTag = null;
function renderGallery(){
  const list = activeTag ? works.filter(w => w.tag === activeTag) : works;
  // ... 渲染
}
```

**代价**：约 40 行。需要先统计现有作品的标签分布，在作品墙顶部渲染筛选条。

---

### 3. ★★ 作品搜索

**现状**：Steam 页有搜索框（`#ssearch`），作品墙没有。

**做法**：给作品墙加搜索输入，匹配标题 + 标签 + 描述。纯前端过滤，无需后端。

**代价**：约 30 行（可复用 Steam 页的搜索实现）。

---

### 4. ★★ RSS 订阅

**现状**：没有。搜索引擎和读者都无法订阅更新。

**做法**：Worker 加一个 `/feed.xml` 路由，输出 RSS 2.0：

```js
async function handleFeed(env){
  const works = await getWorks(env, { limit: 20 });
  const items = works.map(w => `
    <item>
      <title>${esc(w.title)}</title>
      <link>https://www.zfsnnb.dpdns.org/#work/${w.id}</link>
      <pubDate>${new Date(w.createdAt).toUTCString()}</pubDate>
      <description>${esc(w.desc)}</description>
    </item>`).join("");
  // ... 拼 XML，Content-Type: application/rss+xml
}
```

**为什么推荐**：写内容的人最怕「发了没人知道」。RSS 让读者用阅读器订阅，也便于搜索引擎发现新内容。**代码量很小**。

**代价**：约 50 行 Worker 代码。同时建议在 HTML 里加：

```html
<link rel="alternate" type="application/rss+xml" href="/feed.xml" title="ZFSN 作品更新">
```

---

### 5. ★★ 访问统计（隐私友好）

**现状**：只有留言板。没有浏览量数据。

**做法**：Worker 端用 D1 记一个 `page_views` 表，按天聚合：

```sql
CREATE TABLE stats_daily(
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER DEFAULT 0,
  PRIMARY KEY(day, path)
);
```

前端在页面加载时 `POST /api/hit`，Worker 里 `INSERT ... ON CONFLICT DO UPDATE views = views + 1`。

**关键**：**不要存 IP**。如果需要去重，存 `hash(IP + 当天日期 + 盐)` 用于当天去重，第二天就失效。这样既满足 GDPR 类的隐私要求，又能统计。

展示时可以在页脚加一行低调的「本站已运行 N 天，访问 M 次」。

**代价**：约 60 行（表 + Worker 路由 + 前端上报）。

---

### 6. ★ 作品详情页的「上一篇/下一篇」键盘导航

**现状**：已有 `prev`/`next` 按钮（`navHtml`）。

**做法**：加键盘快捷键：

```js
document.addEventListener("keydown", e => {
  if (e.target.matches("input,textarea")) return;   // 输入时不触发
  if (e.key === "ArrowLeft")  gotoPrev();
  if (e.key === "ArrowRight") gotoNext();
});
```

**注意**：必须判断当前是否在输入框里，否则在留言板打字会误触发。

**代价**：8 行。

---

### 7. ★ 分享按钮

**现状**：作品详情页没看到分享入口。

**做法**：优先用原生分享（移动端可唤起系统分享面板），降级到复制链接：

```js
async function share(w){
  const url = location.origin + "/#work/" + w.id;
  if (navigator.share) {
    try { await navigator.share({ title:w.title, url }); } catch(e){}
  } else {
    await navigator.clipboard.writeText(url);
    toast("链接已复制");
  }
}
```

**代价**：约 20 行。

---

### 8. ★ 留言板增强：表情 / 回复

**现状**：纯文本留言 + 昵称。

**做法**：
- **表情**：不引入第三方库，用系统 emoji 选择器（一个固定 emoji 面板，约 60 个常用表情），点击插入到 textarea 光标处。
- **回复**：D1 表加 `reply_to` 字段，渲染时缩进显示。

**代价**：表情约 40 行；回复需要改表结构 + 渲染，约 80 行。

---

## 四、工程与体验

### 1. ★★★ 给 JS 加内容哈希（长期正解）

**现状**：`assets/js/app.js` 文件名不带哈希。所以**不能**加长缓存 —— 否则改完用户看不到更新。这也是本次优化没有给 JS 加缓存头的原因。

**做法**：构建时给文件名加内容哈希（`app.a3f8d2.js`），然后就可以 `max-age=31536000, immutable`。HTML 不缓存，每次拿到新的 HTML 就知道该加载哪个哈希文件。

**为什么推荐**：这是「既能让用户立刻看到更新、又能让 JS 被永久缓存」的唯一正解。当前是次优方案（每次 304 协商）。

**代价**：需要一个构建步骤。可以用简单的 Node 脚本：

```js
const hash = require("crypto").createHash("md5")
  .update(fs.readFileSync("assets/js/app.js")).digest("hex").slice(0,8);
fs.copyFileSync("assets/js/app.js", `assets/js/app.${hash}.js`);
// 同时改写 index.html 里的引用
```

**注意**：Cloudflare Workers 的静态资源层不支持构建时替换，需要么在本地构建好再推、要么用 Wrangler 的构建钩子。对个人站点来说，「本地跑一下脚本再推」就够了。

---

### 2. ★★★ 图片转 AVIF/WebP（浏览器自动降级）

**现状**：本次已把图片压到 9.8MB（从 32.2MB）。但仍是 JPEG/PNG。

**做法**：用 `<picture>` 元素让浏览器自选格式，**不改文件名、不影响 D1 引用**：

```html
<picture>
  <source srcset="assets/works/vrc.avif" type="image/avif">
  <source srcset="assets/works/vrc.webp" type="image/webp">
  <img src="assets/works/vrc.png" alt="..." width="..." height="...">
</picture>
```

**关键**：`<img src>` 保留原来的 `.png` 路径作为兜底，所以**即使 AVIF/WebP 文件缺失，也不会 404** —— 浏览器会回落到 `<img>`。这就是之前 webp 协商方案失败后的正确解法。

AVIF 比 WebP 再小 20-30%，但编码慢、Safari 支持较晚（iOS 16+）。建议**同时生成 WebP 和 AVIF**，让浏览器自己挑。

**代价**：需要给图片渲染逻辑包 `<picture>`（约 20 行），加上批量转码脚本（可以扩展 `optimize_images.py`）。收益是图片再降 25-35%，**加上本次的 70%，总体能到 80%+**。

---

### 3. ★★ 部署后的自动验证

**现状**：每次推代码后要手动检查线上是否正常。

**做法**：写一个 `tools/dev/check-deploy.cjs`，推完跑一次，检查：

- 首页 200 + HTML 大小在预期范围
- `app.js` / `danmaku.js` 200
- sitemap 里的每条 URL 都 200
- 图片抽样 200
- SEO 关键项：title 长度、description、canonical 存在

**代价**：约 80 行。**这次的任务里有两次都是「改完不知道线上对不对」**，有这个脚本会省很多事。

---

### 4. ★★ 结构化数据（JSON-LD）

**现状**：只有 meta 标签。

**做法**：加 JSON-LD，让搜索引擎更准确理解站点：

```html
<script type="application/ld+json">
{
  "@context":"https://schema.org",
  "@type":"Person",
  "name":"ZFSN",
  "url":"https://www.zfsnnb.dpdns.org/",
  "sameAs":[
    "https://space.bilibili.com/1220210222",
    "https://steamcommunity.com/id/..."
  ]
}
</script>
```

作品详情页可以加 `CreativeWork` 类型。**这是 Google 生成富摘要的基础**，对「个人主页」类站点尤其重要 —— 搜索结果里能显示社交账号链接。

**代价**：约 15 行静态 JSON。

---

### 5. ★ 站点地图扩展到全部页面

**现状**：sitemap 只有 2 条 URL（首页 + 游戏页）。

**做法**：作品详情页是 `#work/<id>` 形式（hash 路由），**搜索引擎无法索引 hash**。如果要让作品页被收录，需要改成真实路径 `/work/<id>`。

**为什么提**：这是「作品详情页可被搜索到」的前提。如果希望作品能通过搜索被发现，必须改成路径路由。代价是要动路由逻辑（约 100 行）+ Worker 端加回退路由。

**权衡**：如果作品主要是给朋友看的，保持 hash 路由没问题。如果想让作品被搜到，值得做。

---

## 总结：如果只做三件事

1. **移动端底部导航**（UI）—— 影响面最大，移动端用户占比通常超过一半
2. **图片转 WebP/AVIF + `<picture>` 降级**（性能）—— 图片再降 30%，且零风险
3. **RSS 订阅**（功能）—— 代码量小，直接提升内容触达

其余可以按兴趣慢慢做。

---

*本文件由 AI 助手基于代码库实际情况生成，路径与实现细节均可直接对照仓库验证。*
