#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
IndexNow 主动提交 —— 内容新增/更新/删除后通知搜索引擎

━━ 为什么需要它 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Bing 站长工具里点「请求索引」只是**排队**，实测经常几周不动
（本项目就卡在「发现了但没有爬取」很久）。
IndexNow 是**主动推送**：一次 POST 直接把 URL 塞给 Bing，
Bing 承诺「几分钟到几小时内」安排抓取 —— 这是目前最快的通道。

而且提交一次会**同步给所有参与引擎**（Bing / Yandex / Seznam / Naver 等），
不需要分别 ping。Google 不参与 IndexNow，它有自己的 Indexing API
（且只对招聘/直播类页面开放），普通站点只能靠 sitemap + 自然抓取。

━━ 已就位的准备工作 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
根目录已有密钥文件 {KEY}.txt，且线上 https 可访问（已验证 200）。
这就是「所有权凭证」：引擎收到提交后会去取这个文件，
确认里面的 key 和提交的 key 一致，才认这次提交有效。

⚠ 密钥文件**不能删**，删了之后提交会返回 403。

用法：
    python tools/indexnow.py                    # 提交默认 URL 列表
    python tools/indexnow.py --url <URL>        # 提交单个 URL
    python tools/indexnow.py --all              # 提交 sitemap 里的全部 URL
    python tools/indexnow.py --dry-run          # 只看要提交什么，不真发

退出码：0=成功  1=失败（HTTP 4xx/5xx 或网络错误）
"""
import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# ── 站点与密钥 ────────────────────────────────────────────────
# 密钥文件就在仓库根目录，文件名即密钥（IndexNow 的约定）
KEY = "8418a371656250f21c912c2f7ff3dced"
HOST = "www.zfsnnb.dpdns.org"
SITE = "https://" + HOST

# IndexNow 共享端点：提交一次，所有参与引擎都收到
# （若要只投 Bing，可换成 https://www.bing.com/indexnow）
ENDPOINT = "https://api.indexnow.org/indexnow"

# 默认提交列表：站点的 canonical 页面
# ⚠ 只提交**真正变更**的页面。IndexNow 是事件信号，不是每晚重发的 sitemap ——
#   反复提交未变动的 URL 会被当垃圾，返回 429 并降低抓取优先级。
DEFAULT_URLS = [
    SITE + "/",
    SITE + "/pvz/pvz-portable",
]


def human(n):
    if n < 1024:
        return "%d B" % n
    return "%.1f KB" % (n / 1024.0)


def urls_from_sitemap():
    """从线上 sitemap.xml 抽取全部 <loc>，用于 --all"""
    import urllib.request
    req = urllib.request.Request(
        SITE + "/sitemap.xml",
        headers={"User-Agent": "ZFSN-indexnow/1.0"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        xml = r.read().decode("utf-8", "replace")
    return re.findall(r"<loc>\s*(.*?)\s*</loc>", xml, re.S)


def check_key_file():
    """提交前先自查密钥文件可访问性 —— 403 基本都出在这里"""
    import urllib.request
    url = "%s/%s.txt" % (SITE, KEY)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "ZFSN-indexnow/1.0"})
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read().decode("utf-8", "replace").strip()
    except Exception as e:
        return False, "取不到 %s（%s）" % (url, e)
    if body != KEY:
        return False, "文件内容不是密钥本身（实际：%r）" % body[:60]
    return True, url


def submit(urls, dry=False):
    payload = {
        "host": HOST,
        "key": KEY,
        "keyLocation": "%s/%s.txt" % (SITE, KEY),
        "urlList": urls,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    print("提交端点：%s" % ENDPOINT)
    print("host    ：%s" % HOST)
    print("URL 数量：%d" % len(urls))
    for u in urls:
        print("   · %s" % u)
    print()
    print("请求体大小：%s" % human(len(body)))

    if dry:
        print()
        print("(dry-run，未真正提交)")
        return 0

    import urllib.request
    import urllib.error
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "ZFSN-indexnow/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            code = r.status
            text = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        code = e.code
        text = e.read().decode("utf-8", "replace")
    except Exception as e:
        print()
        print("✗ 网络错误：%s" % e)
        return 1

    print()
    print("HTTP %d" % code)
    if text.strip():
        print("响应：%s" % text.strip()[:300])
    print()

    # ── 状态码语义（引自官方文档）──
    #   200 提交成功，且密钥已验证
    #   202 收到，密钥验证待完成（首次提交常见，不是错误）
    #   400 请求格式错（URL 编码 / JSON 结构）
    #   403 密钥无效：文件取不到，或内容与提交的 key 不一致
    #   422 URL 不属于该 host
    #   429 提交过于频繁，被当垃圾
    if code == 200:
        print("✅ 提交成功（密钥已验证，引擎会尽快安排抓取）")
        return 0
    if code == 202:
        print("✅ 已接受（密钥验证中）—— 首次提交属正常，不是错误")
        return 0
    if code == 400:
        print("✗ 请求格式错误：检查 URL 编码与 JSON 结构")
        return 1
    if code == 403:
        print("✗ 密钥无效：确认 %s/%s.txt 可公开访问且内容等于密钥" % (SITE, KEY))
        return 1
    if code == 422:
        print("✗ URL 不属于 host %s（IndexNow 只接受同域 URL）" % HOST)
        return 1
    if code == 429:
        print("✗ 提交过于频繁 —— 只提交真正变更的页面，别定时全量重发")
        return 1
    print("✗ 未预期的状态码 %d" % code)
    return 1


def main():
    ap = argparse.ArgumentParser(description="IndexNow 主动提交")
    ap.add_argument("--url", action="append", default=[],
                    help="提交单个 URL（可重复传多次）")
    ap.add_argument("--all", action="store_true",
                    help="提交 sitemap 里的全部 URL")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不提交")
    ap.add_argument("--skip-key-check", action="store_true",
                    help="跳过提交前的密钥文件可访问性自查")
    args = ap.parse_args()

    print("=" * 78)
    print("IndexNow 主动提交")
    print("=" * 78)
    print()

    # 密钥自查：403 的绝大多数原因都是这里，提前拦住能省一次无用的提交
    if not args.skip_key_check:
        ok, info = check_key_file()
        if ok:
            print("✓ 密钥文件可访问：%s" % info)
        else:
            print("✗ 密钥文件有问题：%s" % info)
            print("  提交会返回 403，已中止。")
            return 1
        print()

    if args.url:
        urls = args.url
    elif args.all:
        print("从 sitemap.xml 读取 URL …")
        try:
            urls = urls_from_sitemap()
        except Exception as e:
            print("✗ 读取 sitemap 失败：%s" % e)
            return 1
        if not urls:
            print("✗ sitemap 里没解析到 <loc>")
            return 1
        print("读到 %d 个 URL" % len(urls))
        print()
    else:
        urls = DEFAULT_URLS

    # 简单校验：必须同域 + 必须 https
    bad = [u for u in urls if not u.startswith(SITE + "/") and u != SITE]
    if bad:
        print("✗ 以下 URL 不属于 %s（会返回 422）：" % HOST)
        for u in bad:
            print("   %s" % u)
        return 1

    return submit(urls, dry=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
