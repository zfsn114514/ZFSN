# 访问统计接入说明

站点有**两套并行的统计**，互不冲突：

| | ① 第一方自建（`/api/pv`） | ② Cloudflare Web Analytics |
|---|---|---|
| 实现 | Worker + D1，自己写 | CF 边缘 + 一段 beacon 脚本 |
| 页面改动 | 无额外脚本（页面自己 fetch） | `index.html` 里一行 `<script type='module'>` |
| 数据在哪 | 自己的 D1，随时可查可改 | CF 面板 |
| 优势 | 数据自主、可做作品维度细分 | 边缘统计更准（含缓存命中）、带 Core Web Vitals |
| 状态 | ✅ 已上线跑通 | ✅ 已启用（见下文「当前状态」） |

> 自建部分的表结构与端点见 `schema/0002_analytics.sql` 与 `src/index.js`；
> UV 用 `SHA-256(ip+ua+day+salt)` 去重，**不存原始 IP**，无需 cookie 同意弹窗。

**没有**接入 Google Analytics / 百度统计 / 51.la 这类通用第三方分析脚本 ——
它们既拖慢首屏、又要 cookie 弹窗，还容易被拦截插件屏蔽，数据反而不可信。

---

## 当前状态（已启用）

站点走的是**手动埋点**（方案 B），不是自动注入。token：

```
769eabb4db2347bcaa66b69fc7bbba46
```

脚本已写入 `index.html` 的 `</body>` 之前。**这条不要删、不要改 token** ——
删了就收不到数据，改错了会记到别人的站点上。

如需确认是否在正常工作：打开线上站点按 F12 → Network，
筛选 `rum` 或 `cloudflareinsights`，应当能看到：

- `static.cloudflareinsights.com/beacon.min.js` 加载
- `cloudflareinsights.com/cdn-cgi/rum` 的 POST 上报

数据不会实时出现，首次录入通常要等 **几分钟到几十分钟**。

---

## 方案 A：自动注入（零代码，本站未采用）

适用前提：站点已经走 Cloudflare 代理 —— 本站满足
（`www.zfsnnb.dpdns.org` 是 Cloudflare Worker 的自定义域名）。

### 一次性开启步骤

1. 登录 Cloudflare 控制台
2. 左侧菜单 → **分析（Analytics）→ Web Analytics**
   （部分新版面板路径是 **Analytics & Logs → Web Analytics**）
3. 点 **Add a site / 添加站点**
4. 在下拉框里选 **`www.zfsnnb.dpdns.org`**（**不是**裸域 `zfsnnb.dpdns.org`，
   裸域指向家宽 IP，本站的 Worker 只挂在 www 上）
5. 点 **Done**

选完即生效。Cloudflare 会在边缘给每个 HTML 响应注入
`/cdn-cgi/rum` beacon，页面 HTML 里不需要改任何东西。

> ⚠ **注意**：即使站点已被 Cloudflare 代理，自动注入也要先在
> Web Analytics 页面**手动添加一次站点**才会真正开始收集数据。
> 只是「已经在用 Cloudflare」并不会自动开始统计。

**本站未采用方案 A 的原因**：面板里选择了「JS Snippet」安装方式，
所以改用了下面的手动埋点。两种方式**不要同时用** —— 会导致重复上报。

---

## 方案 B：手动埋点（本站当前采用）

1. 面板 → Web Analytics → 选中站点 → **Manage site**
2. 复制其中的 **JS Snippet**
3. 贴进 `index.html` 的 `</body>` 之前（本站已完成，见上方「当前状态」）

参考形式：

```html
<!-- 在 </body> 之前 -->
<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js"
        data-cf-beacon='{"token":"<TOKEN>"}'></script>
```

> `type="module"` 自带 defer 语义（异步、不阻塞渲染），放在 `<head>` 或
> `</body>` 前都行。CF 官方给的 snippet 用的是 `type='module'`，照抄即可。

### ⚠ CSP 注意事项

如果以后给站点加了 `Content-Security-Policy`，beacon 会被**静默拦截**
（不报错、数据就是不来）。必须在 CSP 里放行两个来源：

```
script-src  ... https://static.cloudflareinsights.com;
connect-src ... https://cloudflareinsights.com;
```

目前站点**没有设置 CSP**，不受影响。真要加 CSP 时记得回来看这一条。

---

## 关于「统计脚本被 CF 缓存」的坑

Cloudflare 的注入发生在**入缓存之前**，所以注入后的 HTML 会带着 beacon
一起进 CDN 缓存（`CF-Cache-Status: HIT`）。

这意味着：**开启 Web Analytics 后，已经缓存的 HTML 可能一段时间内仍不带 beacon**。
不需要手动清缓存，缓存过期后自然更新；想立刻生效可以到
控制台 → 缓存 → 配置 → **Purge Everything**。

---

## 能拿到什么数据

| 有 | 没有 |
|---|---|
| 页面浏览量（PV）/ 访客数（UV） | 单用户完整访问路径 |
| 来源网站（Referrer）/ 国家地区 | 自定义事件、转化漏斗 |
| Core Web Vitals（LCP / INP / CLS） | 用户级画像 |
| 访问量最高的页面 | 与其它分析工具的深度集成 |

对「有没有人来、从哪来、站点快不快」这三个问题，这些数据足够了。

> ⚠ 本站是**单页应用**（hash 路由 `#work/<id>`）。
> hash 后面的内容**不会发给服务器**，所以 Web Analytics 只能看到
> 「访问了 `/`」这一条记录 —— 无法区分访客看的是首页还是某个作品详情页。
> 想要页面级细分，需要改成 history 路由（`/work/<id>`）并让 Worker
> 把这些路径都重写到 index.html。这是一个独立的较大改动，暂未实施。
