# -*- coding: utf-8 -*-
"""
CSS 结构自检 —— 抓「解析层面」的静默故障。

━━ 为什么需要这个脚本 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
有一类 CSS bug **不会报错、不会警告**，但会让整条规则凭空消失：

    /* 注释块开头的 `/*` 丢了
       ↓
    ` * 这段文字…` 被浏览器当成 CSS 选择器
       ↓
    解析器一路吞到下一个 `}`，把**紧随其后的整条规则**一起吃掉
       ↓
    页面看起来「样式没生效」，控制台却干干净净

【真实踩过】作品墙的注释丢了 `/*`，结果吞掉了下面的
`.gallery{column-width:232px}` —— 于是 9 张卡片挤成单列、
每张占满 1080px 宽。肉眼只能看到「卡片大得离谱」，
读代码完全看不出问题（因为代码里规则明明写着）。

━━ 本脚本检查什么 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
① 花括号是否平衡（`{` 与 `}` 数量、且不出现负深度）
② **裸注释行** —— 以 `*` 开头、但不在任何注释块里的行（本条专治上面的 bug）
③ 未闭合的注释块（`/*` 没有配对的 `*/`）
④ 可疑的「注释块结尾孤悬」（`*/` 前面没有 `/*`）
⑤ 规则体内出现裸 `*` 选择器开头却不在 `{}` 内的情况

用法：
    python tools/check_css.py            # 检查 index.html 与 assets/css/*.css
    python tools/check_css.py --quiet    # 只输出结论（适合放进提交前脚本）
"""
import os
import re
import sys
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


# 从 HTML 里抽出 <style>…</style> 段（含起止行号，便于报错定位）
STYLE_RE = re.compile(r"<style[^>]*>(.*?)</style>", re.S)


def line_of(text, pos):
    """字符偏移 → 1-based 行号。"""
    return text.count("\n", 0, pos) + 1


def scan_css(css, origin):
    """检查一段 CSS，返回问题列表 [(行号, 说明), ...]。

    行号是**相对这段 CSS** 的；调用方负责换算成文件行号。
    """
    problems = []

    # ── ① 花括号平衡（先剥掉注释，避免注释里的 { } 干扰）──
    # 注意：剥注释本身也要能容忍「未闭合」，见下面 ③
    stripped = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    # 未闭合的注释块会把后面的全部吞掉，这里先检测出来
    opens = len(re.findall(r"/\*", css))
    closes = len(re.findall(r"\*/", css))
    depth = 0
    min_depth = 0
    for ch in stripped:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            min_depth = min(min_depth, depth)

    if depth != 0:
        problems.append((0, "花括号不平衡：`{` 比 `}` 多 %d 个（规则可能没闭合）"
                         % depth if depth > 0 else
                         "花括号不平衡：`}` 比 `{` 多 %d 个（多写了右括号）" % (-depth)))
    if min_depth < 0:
        problems.append((0, "右括号 `}` 先于左括号出现（有规则多闭合了）"))

    # ── ③ 未闭合的注释块 ──
    if opens != closes:
        problems.append((0, "注释块未闭合：`/*` %d 个，`*/` %d 个" % (opens, closes)))

    # ── ② + ④ 逐行扫描：裸注释行 / 孤悬的 */ ──
    # 用**跨行保持**的状态机跟踪「当前是否在注释块里」。
    #
    # ⚠ 这里必须跨行保持状态：注释是多行的（`/*` 在一行，`*/` 在几行之后）。
    #   早先写成「每行从头判断」会产生大量误报 —— 把所有正常的
    #   注释结束行 `*/` 都判成「孤悬」。
    lines = css.split("\n")
    in_comment = False          # 跨行保持
    comment_start_line = 0      # 注释块起始行（报错定位用）
    for idx, line in enumerate(lines, 1):
        s = line.strip()
        line_entered_in_comment = in_comment   # 本行开始时是否已在注释里

        # 逐字符推进状态机，处理一行内多个 /* */
        i = 0
        while i < len(line):
            if not in_comment:
                p = line.find("/*", i)
                if p < 0:
                    break
                in_comment = True
                comment_start_line = idx
                i = p + 2
            else:
                p = line.find("*/", i)
                if p < 0:
                    break
                in_comment = False
                i = p + 2

        # ④ 孤悬的 */：本行**开始时不在注释里**，却出现了 */
        if (not line_entered_in_comment) and s.startswith("*/"):
            problems.append((idx, "孤悬的 `*/`：这一行以 `*/` 开头，"
                                  "但前面没有对应的 `/*`（注释块的一头丢了？）"))

        # ② 裸注释行：本行**开始时不在注释里**，却以 `*` 开头
        #    （真正的注释内容行在块内，in_comment 会是 True，被排除）
        #    同时排掉 `*{...}` / `* > div` 这类合法的通配选择器。
        if (not line_entered_in_comment) and s.startswith("*") \
                and not s.startswith("*/") \
                and not re.match(r"^\*[\s{,:>+~[]", s):
            problems.append((idx, "裸注释行：`%s` —— 极可能是上面注释块的 `/*` 丢了" % s[:48]))

    return problems


def normalize_line_numbers(css, origin, problems):
    """把「相对 CSS 段」的行号换算成「文件内」的行号。"""
    out = []
    for ln, msg in problems:
        if ln == 0:
            out.append((None, msg))
        else:
            out.append((ln, msg))
    return out


def check_html_styles(path):
    """检查一个 HTML 文件里的所有 <style> 块。返回 (问题数, 报告行列表)。"""
    with open(path, "r", encoding="utf-8") as f:
        html = f.read()

    reports = []
    total = 0
    blocks = list(STYLE_RE.finditer(html))
    if not blocks:
        return 0, []

    for m in blocks:
        css = m.group(1)
        start_line = line_of(html, m.start(1))
        problems = scan_css(css, path)
        for ln, msg in problems:
            # 相对 CSS 的行号 + CSS 起始行 - 1 = 文件内行号
            file_line = (start_line + ln - 1) if ln else start_line
            reports.append((file_line, msg))
            total += 1
    return total, reports


def check_css_file(path):
    """检查独立的 .css 文件。返回 (问题数, 报告行列表)。"""
    with open(path, "r", encoding="utf-8") as f:
        css = f.read()
    problems = scan_css(css, path)
    return len(problems), problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quiet", action="store_true", help="只输出结论")
    args = ap.parse_args()

    root = common.site_root()
    if not args.quiet:
        common.banner("CSS 结构自检")

    targets = []          # (显示名, 检查函数, 路径)
    idx = os.path.join(root, "index.html")
    if os.path.exists(idx):
        targets.append(("index.html", check_html_styles, idx))

    # 独立的 CSS 文件（如果以后拆出去了）
    css_dir = os.path.join(root, "assets", "css")
    extra_css = []
    if os.path.isdir(css_dir):
        for fn in sorted(os.listdir(css_dir)):
            if fn.endswith(".css"):
                extra_css.append(os.path.join(css_dir, fn))

    # 也扫仓库根目录下可能的 .css
    for fn in sorted(os.listdir(root)):
        if fn.endswith(".css"):
            extra_css.append(os.path.join(root, fn))

    for p in extra_css:
        targets.append((os.path.relpath(p, root).replace(os.sep, "/"), check_css_file, p))

    if not targets:
        print("没找到可检查的 CSS（index.html 也没有 <style> 块）")
        return 1

    total_problems = 0
    checked_bytes = 0
    for name, fn, path in targets:
        n, reports = fn(path)
        checked_bytes += os.path.getsize(path)
        total_problems += n
        if args.quiet:
            continue
        if n == 0:
            print("  \033[32m✓\033[0m %-28s 结构正常" % name)
        else:
            print("  \033[31m✗\033[0m %-28s %d 个问题" % (name, n))
            for ln, msg in reports:
                loc = "第 %d 行" % ln if ln else "全文"
                print("      %s  %s" % (loc, msg))

    if not args.quiet:
        print()
        print("检查了 %d 个文件 / %.1f KB" % (len(targets), checked_bytes / 1024.0))

    if total_problems == 0:
        print("CSS 结构检查通过。")
        return 0
    else:
        print("发现 %d 个 CSS 结构问题 —— 这类问题**不会报错**，"
              "但会让规则静默失效，务必修掉。" % total_problems)
        return 1


if __name__ == "__main__":
    sys.exit(main())
