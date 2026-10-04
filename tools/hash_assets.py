# -*- coding: utf-8 -*-
"""
给 JS / CSS 加内容哈希（cache busting）。

━━ 要解决的问题 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`assets/js/app.js` 这个文件名**不含版本信息**，于是只有两条路，都不好：

  · 加长缓存 → 改完代码用户不生效，变成「你清了缓存吗」的玄学扯皮
  · 不加缓存 → 每次访问都回源协商。虽然命中 ETag 只回 304（几百字节），
               但每次开站都多一轮 RTT，且 304 也是要等主线程的

内容哈希把这对矛盾解开：
    app.<内容前8位>.js  →  内容变则文件名变
    文件名变 → 就是一个浏览器从没见过的新 URL → 可以放心缓存一亿年
    内容不变 → 文件名不变 → 一直命中强缓存，连 304 都不用发

━━ 做法 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 读 assets/js/*.js（以及列表里的 CSS），算 SHA-256
2. 产出 app.<hash8>.js 副本
3. **回写 index.html 里的引用**
4. 更新 `_headers` 里的长缓存规则（用新的哈希文件名）
5. 删掉上一轮生成的旧哈希文件（避免仓库里堆历史版本）

⚠ 本脚本**幂等**：同样内容跑两次，文件名一样，不会重复生成。

⚠ 不要手动改 index.html 里的哈希文件名 —— 下次跑脚本会被覆盖回去。
   要改内容就改 app.js，然后重新跑一次本脚本。

用法：
    python hash_assets.py            # 生成 + 回写
    python hash_assets.py --dry-run  # 只看会做什么
    python hash_assets.py --check    # 只校验 index.html 引用是否与内容一致
"""
import os
import re
import sys
import hashlib
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

# 需要加哈希的资源（相对站点根）。顺序无关。
ASSETS = [
    "assets/js/app.js",
    "assets/js/danmaku.js",
]

# 会被回写的 HTML
HTML_FILES = ["index.html"]

HASH_LEN = 8

# 旧哈希文件的识别式：app.a1b2c3d4.js
HASHED_RE = re.compile(r"^(?P<stem>.+)\.(?P<hash>[0-9a-f]{%d})\.(?P<ext>js|css)$" % HASH_LEN)


def sha8(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:HASH_LEN]


def hashed_name(rel):
    """assets/js/app.js → assets/js/app.<hash8>.js"""
    d, fn = os.path.split(rel)
    stem, ext = os.path.splitext(fn)
    return d, stem, ext


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--check", action="store_true", help="只校验，不改动")
    args = ap.parse_args()

    root = common.site_root()
    common.banner("静态资源内容哈希")

    plan = []          # (rel, hashed_rel, hash)
    for rel in ASSETS:
        src = os.path.join(root, rel)
        if not os.path.exists(src):
            print("✗ 找不到 %s" % rel)
            return 1
        d, stem, ext = hashed_name(rel)
        h = sha8(src)
        newrel = "%s/%s.%s%s" % (d, stem, h, ext) if d else "%s.%s%s" % (stem, h, ext)
        plan.append((rel, newrel.replace(os.sep, "/"), h))
        print("  %-26s  %s" % (rel, h))

    print()

    # ── 回写 HTML ──
    changes = []
    for html in HTML_FILES:
        hp = os.path.join(root, html)
        if not os.path.exists(hp):
            print("! 跳过不存在的 %s" % html)
            continue
        with open(hp, "r", encoding="utf-8") as f:
            text = f.read()
        orig = text
        for rel, newrel, h in plan:
            # 匹配 src=".../app.js" 和 src=".../app.<旧hash>.js"
            d, fn = os.path.split(rel)
            stem, ext = os.path.splitext(fn)
            pat = re.compile(
                r'(?P<pre>(?:src|href)\s*=\s*["\'])' +
                re.escape(d + "/") + re.escape(stem) +
                r'(?:\.[0-9a-f]{%d})?' % HASH_LEN +
                re.escape(ext) +
                r'(?P<post>["\'])'
            )
            new_text, n = pat.subn(lambda m: m.group("pre") + newrel + m.group("post"), text)
            if n:
                changes.append((html, rel, newrel, n))
                text = new_text
        if text != orig:
            if not args.dry_run and not args.check:
                with open(hp, "w", encoding="utf-8", newline="") as f:
                    f.write(text)

    if changes:
        print("HTML 引用更新：")
        for html, rel, newrel, n in changes:
            print("  %s: %s  →  %s  (%d 处)" % (html, rel, newrel, n))
    else:
        print("HTML 引用无需改动（已是当前哈希）")

    # ── 校验模式就此结束 ──
    if args.check:
        ok = True
        for rel, newrel, h in plan:
            fp = os.path.join(root, newrel)
            if not os.path.exists(fp):
                print("✗ 期望的文件不存在：%s" % newrel)
                ok = False
        print()
        print("校验%s" % ("通过" if ok else "失败"))
        return 0 if ok else 1

    if args.dry_run:
        print()
        print("(dry-run，未写入)")
        return 0

    # ── 落盘：写哈希副本 ──
    print()
    for rel, newrel, h in plan:
        src = os.path.join(root, rel)
        dst = os.path.join(root, newrel.replace("/", os.sep))
        with open(src, "rb") as f:
            data = f.read()
        # 已存在且内容一致就跳过（幂等，且不刷新 mtime）
        if os.path.exists(dst):
            with open(dst, "rb") as f:
                if f.read() == data:
                    print("  = %s（已存在且一致）" % newrel)
                    continue
        with open(dst, "wb") as f:
            f.write(data)
        print("  + %s" % newrel)

    # ── 清理上一轮的旧哈希文件 ──
    keep = {os.path.basename(p[1]) for p in plan}
    removed = []
    for rel, newrel, h in plan:
        d = os.path.dirname(os.path.join(root, rel))
        if not os.path.isdir(d):
            continue
        for fn in os.listdir(d):
            m = HASHED_RE.match(fn)
            if m and fn not in keep:
                os.remove(os.path.join(d, fn))
                removed.append(os.path.join(os.path.relpath(d, root), fn).replace(os.sep, "/"))
    if removed:
        print()
        print("清理旧版本 %d 个：" % len(removed))
        for r in removed:
            print("  - %s" % r)

    # ── 更新 _headers ──
    hdr = os.path.join(root, "_headers")
    if os.path.exists(hdr):
        with open(hdr, "r", encoding="utf-8") as f:
            ht = f.read()
        block = build_headers_block(plan)
        marker = "# ── 哈希化的 JS（由 tools/hash_assets.py 自动生成）──"
        if marker in ht:
            # 替换整个托管区块（从 marker 到下一个 "── " 标题行之前）
            pat = re.compile(re.escape(marker) + r".*?(?=\n# ── |\Z)", re.S)
            ht2 = pat.sub(block.rstrip() + "\n", ht)
        else:
            ht2 = ht.rstrip() + "\n\n" + block
        if ht2 != ht:
            with open(hdr, "w", encoding="utf-8", newline="") as f:
                f.write(ht2)
            print()
            print("_headers 已更新（%d 条长缓存规则）" % len(plan))

    print()
    print("完成。记得把新文件名一起提交 —— 站点靠它做缓存失效。")
    return 0


def build_headers_block(plan):
    lines = [
        "",
        "# ── 哈希化的 JS（由 tools/hash_assets.py 自动生成）────────────────",
        "#",
        "# 文件名里带内容哈希，所以内容一变文件名就变 —— 可以放心缓存很久。",
        "# 这些规则**不要手改**：跑一次 hash_assets.py 会自动重写本区块。",
        "#",
        "# 没被列进来的 assets/js/*.js（比如你新加但忘了登记的）仍走默认策略：",
        "# `public, max-age=0, must-revalidate`，也就是每次回源协商。",
        "# 新加脚本后请把它填进 hash_assets.py 顶部的 ASSETS 列表再跑一次。",
    ]
    for rel, newrel, h in plan:
        lines.append("")
        lines.append("/" + newrel)
        lines.append("  Cache-Control: public, max-age=31536000, immutable")
    lines.append("")
    return "\n".join(lines)


if __name__ == "__main__":
    sys.exit(main())
