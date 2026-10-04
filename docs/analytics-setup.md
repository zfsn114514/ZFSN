# 访问统计接入说明

站点**没有**接入任何第三方统计脚本（Google Analytics / 百度统计 / 51.la 等）。
原因是这类脚本会在页面里插一段外部 JS：既拖慢首屏，又需要 cookie 同意弹窗，
而且很容易被广告拦截插件屏蔽 —— 数据反而不可信。

改用 **Cloudflare Web Analytics**：免费、无 cookie、不跨站追踪、不需要同意弹窗，
而且**统计逻辑在 Cloudflare 边缘完成**，页面里可以一行脚本都不加。

---

## 方案 A：自动注入（推荐，零代码）

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

### 验证是否生效

打开线上站点，按 F12 → Network，筛选 `rum` 或 `cloudflareinsights`。
应当能看到一个对 `/cdn-cgi/rum` 的 POST 请求（或
`static.cloudflareinsights.com/beacon.min.js` 的加载）。

数据不会实时出现，首次录入通常要等 **几分钟到几十分钟**。

---

## 方案 B：手动埋点（自动注入被关掉时用）

如果面板里把 Web Analytics 的 setup 改成了 **Disable**，或者用了
「Enable with JS Snippet installation」，就需要手动加脚本。

1. 面板 → Web Analytics → 选中站点 → **Manage site**
2. 复制其中的 **JS Snippet**（形如 `<script defer src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token":"<TOKEN>"}'></script>`）
3. 把 `index.html` 里下面这段的注释去掉，并把 `TOKEN` 换成真实 token：

```html
<!-- 在 </body> 之前 -->
<script defer src="https://static.cloudflareinsights.com/beacon.min.js"
        data-cf-beacon='{"token":"这里填你的 TOKEN"}'></script>
```

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
