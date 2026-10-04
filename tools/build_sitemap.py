# -*- coding: utf-8 -*-
"""
生成 sitemap.xml —— 覆盖站内所有**可被搜索引擎索引的 URL**。

━━ 为什么需要这个脚本，而不是手写一份 XML ━━━━━━━━━━━━━━━━━━━━
手写有两个必然的失效方式：

  1. **作品是存在 D1 里、后台随时增删的。** 静态 sitemap 一提交就过期，
     新作品永远不会被收录，删掉的作品则变成死链（sitemap 里出现 404
     会拉低整份文件的信任度）。

  2. **静态页面会新增。** 这次就多了 /pvz/pvz-portable，将来还会有别的。
     靠人记得回来改 XML 是不可靠的。

所以：能从数据源推出来的（作品、B站视频）现算，写死的（首页、游戏页）
集中在本脚本顶部一份清单里，新增页面只改那一处。

━━ 关于本站是 hash 路由单页应用的重要说明 ━━━━━━━━━━━━━━━━━━━━
站点所有"页面"共用同一个 URL（`/`），切换靠 `#works` `#bili` 这类
hash。**hash 部分不会被发送到服务器，也不被搜索引擎当作独立 URL 收录**。
因此：

  · `/` 本身含首页 + 作品墙 + B站 + 游戏 + 留言 全部板块的正文 HTML
    （都在同一个文档里，只是 display 切换），收录 `/` 就等于收录了全部。
  · `/#works` 这类带 hash 的写法**不要写进 sitemap** —— 规范要求 <loc>
    是完整 URL 且不含片段（Google 会忽略或判为无效），写了是负收益。
  · 作品详情页 `/#work/<id>` 同理，无法单独收录 —— 这是这套路由方案的
    固有代价，不是配置错误。作品的可发现性靠 `<link rel="alternate">`
    指向的 RSS、以及站内的相互链接来补。

所以下面列的都是**真正独立的 URL**（各自返回 200 且内容不同）。

用法：
    python build_sitemap.py            # 写回 sitemap.xml
    python build_sitemap.py --dry-run  # 只打印，不写文件
"""
import os
import re
import sys
import json
import datetime
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

BASE = "https://www.zfsnnb.dpdns.org"

# ── 静态独立页面清单 ────────────────────────────────────────────
# 新增独立页面（返回自己 URL 的那种）就加到这里。
# 字段：path、changefreq、priority、lastmod 来源（见下方 _lastmod_*）
STATIC_PAGES = [
    {"path": "/",                "changefreq": "weekly",  "priority": "1.0", "lastmod": "index.html"},
    {"path": "/pvz/pvz-portable","changefreq": "monthly", "priority": "0.8", "lastmod": "pvz/pvz-portable.html"},
]

# 不写进 sitemap 但站点确实提供的独立 URL（列出以示"已考虑过"）：
#   /feed.xml  —— RSS 不是网页，属于 feed 发现机制，由 HTML 里的
#                 <link rel="alternate"> 和 robots.txt 之外的渠道声明。
#                 列进 sitemap 是常见但收益极低的做法，这里不列。
#   /admin/    —— robots.txt 已 Disallow，列进 sitemap 自相矛盾。
IGNORED = ["/feed.xml", "/rss.xml", "/admin/"]


def site_root():
    return common.site_root()


def _file_lastmod(root, rel):
    """取文件最后修改日期（本地时区），失败返回今天。"""
    try:
        ts = os.path.getmtime(os.path.join(root, rel))
        return datetime.date.fromtimestamp(ts).isoformat()
    except OSError:
        return datetime.date.today().isoformat()


def _today():
    return datetime.date.today().isoformat()


def fetch_json(url, timeout=20):
    """
    读一个 JSON。失败返回 None —— 调用方降级，不让整个脚本崩。

    为什么要容错：sitemap 是给爬虫看的，多几条少几条无所谓；
    但脚本崩了就一条都生成不了。宁可吐一份"缺作品"的 sitemap，
    也不要吐不出东西。
    """
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "zfsn-sitemap-builder/1.0 (+https://www.zfsnnb.dpdns.org/)",
            "Accept": "application/json,text/plain,*/*",
        })
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001 —— 就是要吞掉一切网络异常
        print("  ! 读取失败 %s：%s" % (url, e), file=sys.stderr)
        return None


def works_items(root):
    """
    作品 → 独立 URL 项。

    ⚠ 这里**返回空列表**，不是漏写。

    作品详情页的 URL 形式是 `/#work/<id>`，hash 不可收录（理由见文件头）。
    Google 明确要求 <loc> 不含片段标识符，写 `/#work/xxx` 属于无效条目。
    作品真正的可发现性来源是：
      · `/feed.xml`（每件作品一个 <item>，带标题与更新时间）
      · 作品墙 `/` 上渲染出的卡片（爬虫执行 JS 后能看到并跟进）
    """
    return []


def main():
    dry = "--dry-run" in sys.argv
    root = site_root()

    urls = []

    # 1) 静态页面
    for p in STATIC_PAGES:
        urls.append({
            "loc": BASE + p["path"],
            "lastmod": _file_lastmod(root, p["lastmod"]),
            "changefreq": p["changefreq"],
            "priority": p["priority"],
        })

    # 2) 线上作品（当前为空 —— 见 works_items 说明）
    print("读线上作品清单…")
    live = fetch_json(BASE + "/api/works")
    if live is None:
        print("  ! 未能读到线上作品，跳过（sitemap 仍会生成）", file=sys.stderr)
    else:
        n = len(live.get("works") or []) if isinstance(live, dict) else len(live or [])
        print("  线上作品 %d 件（hash 详情页不入 sitemap）" % n)
    urls.extend(works_items(root))

    # 3) 排序：priority 降序，同级按 loc
    urls.sort(key=lambda u: (-float(u["priority"]), u["loc"]))

    lines = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for u in urls:
        lines += [
            "  <url>",
            "    <loc>%s</loc>" % _esc(u["loc"]),
            "    <lastmod>%s</lastmod>" % u["lastmod"],
            "    <changefreq>%s</changefreq>" % u["changefreq"],
            "    <priority>%s</priority>" % u["priority"],
            "  </url>",
        ]
    lines.append("</urlset>")
    xml = "\n".join(lines) + "\n"

    print()
    print(xml)

    if dry:
        print("(dry-run，未写入)")
        return

    out = os.path.join(root, "sitemap.xml")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(xml)
    print("已写入 %s（%d 个 URL）" % (out, len(urls)))


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;")
            .replace(">", "&gt;").replace('"', "&quot;").replace("'", "&apos;"))


if __name__ == "__main__":
    main()
