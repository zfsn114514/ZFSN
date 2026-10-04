# -*- coding: utf-8 -*-
"""
AVIF 落地可行性测评（只读，不写任何文件）

回答三个问题：
  ① 本站图片转 AVIF 能省多少？（相对当前的 WebP 主文件）
  ② 编码成本多大？（时间 / 单张耗时）
  ③ 兼容性风险在哪？（哪些浏览器不支持）

用法：
    python tools/dev/avif_probe.py            # 全量
    python tools/dev/avif_probe.py --limit 20 # 只测前 20 张（快速抽样）
"""
import io
import os
import sys
import time
import argparse

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from PIL import Image, features  # noqa: E402

WEBP_Q = 88      # 与 optimize_images.py 主文件一致
AVIF_Q = 62      # 与 optimize_images.py 一致
AVIF_SPEED = 4   # Pillow AVIF 的 speed（0=最慢最好，10=最快最差）

SCAN_DIRS = ["assets"]
SKIP_DIR_PARTS = {"cursor"}
MIN_BYTES = 8 * 1024


def human(n):
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.0f KB" % (n / 1024.0)
    return "%.2f MB" % (n / 1048576.0)


def collect():
    out = []
    for d in SCAN_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for dirpath, _dn, filenames in os.walk(base):
            parts = set(os.path.relpath(dirpath, ROOT).split(os.sep))
            if parts & SKIP_DIR_PARTS:
                continue
            for fn in filenames:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in (".png", ".jpg", ".jpeg", ".webp", ".avif"):
                    continue
                p = os.path.join(dirpath, fn)
                if os.path.getsize(p) < MIN_BYTES:
                    continue
                out.append(p)
    return sorted(out)


def decode_magic(path):
    """嗅探真实格式（不看扩展名），因为主文件是「扩展名不变、内容换成 webp」"""
    with open(path, "rb") as f:
        head = f.read(32)
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[:2] == b"\xff\xd8":
        return "jpeg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[4:8] == b"ftyp" and (b"avif" in head or b"avis" in head):
        return "avif"
    return "?"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只测前 N 张")
    args = ap.parse_args()

    if not features.check("avif"):
        print("✗ 本机 Pillow 不支持 AVIF，无法测评。")
        return 1
    if not features.check("webp"):
        print("✗ 本机 Pillow 不支持 WebP。")
        return 1

    files = collect()
    if args.limit:
        files = files[:args.limit]

    print("=" * 108)
    print("AVIF 落地可行性测评   ——  共 %d 个文件（>= %s）" % (len(files), human(MIN_BYTES)))
    print("参数：WebP q%d（当前主文件） vs AVIF q%d speed=%d" % (WEBP_Q, AVIF_Q, AVIF_SPEED))
    print("=" * 108)
    print()

    fmt_stat = {}      # 真实格式 -> [数量, 原始字节]
    rows = []
    t_avif_total = 0.0
    t_webp_total = 0.0
    fail = 0

    for p in files:
        rel = os.path.relpath(p, ROOT).replace(os.sep, "/")
        cur = os.path.getsize(p)
        f0 = decode_magic(p)
        s = fmt_stat.setdefault(f0, [0, 0])
        s[0] += 1
        s[1] += cur

        try:
            im = Image.open(p)
            im.load()
        except Exception as e:
            print("%-52s 跳过：打不开 (%s)" % (rel[:52], e))
            fail += 1
            continue

        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        work = im.convert("RGBA" if has_alpha else "RGB")

        # 同尺寸下比较：当前主文件 vs 新编码的 AVIF
        try:
            t0 = time.time()
            b = io.BytesIO()
            work.save(b, format="AVIF", quality=AVIF_Q, speed=AVIF_SPEED)
            ab = b.getvalue()
            dt = time.time() - t0
            t_avif_total += dt
            if args.limit and args.limit <= 30:
                t_webp_total += 0  # 抽样时不重复编码 webp
        except Exception as e:
            print("%-52s AVIF 编码失败：%s" % (rel[:52], e))
            fail += 1
            continue

        rows.append((rel, f0, cur, len(ab), dt, has_alpha))

    # ── 汇总 ──
    print("%-50s %6s %10s %10s %8s %7s" % ("文件", "真实格式", "当前", "AVIF", "省", "耗时"))
    print("-" * 108)
    for rel, f0, cur, av, dt, alpha in rows:
        save = (1 - av / float(cur)) * 100 if cur else 0
        flag = ""
        if save < 0:
            flag = "  ⚠ 变大"
        print("%-50s %6s %10s %10s %7.1f%% %6.2fs%s" % (
            rel[:50], f0, human(cur), human(av), save, dt, flag))
    print("-" * 108)

    tot_cur = sum(r[2] for r in rows)
    tot_av = sum(r[3] for r in rows)
    print()
    print("═══ 总体结论 ═══")
    print("参与比较：%d 张（失败/跳过 %d 张）" % (len(rows), fail))
    print("当前总体积：%s" % human(tot_cur))
    print("全转 AVIF  ：%s" % human(tot_av))
    if tot_cur:
        print("净节省    ：%s（%.1f%%）" % (
            human(tot_cur - tot_av), (1 - tot_av / float(tot_cur)) * 100))
    print("编码总耗时：%.1f s（平均 %.3f s/张）" % (t_avif_total, t_avif_total / max(1, len(rows))))
    print()
    print("── 按当前真实格式分组 ──")
    for k, (c, b) in sorted(fmt_stat.items(), key=lambda x: -x[1][1]):
        print("   %-6s %3d 张  %10s" % (k, c, human(b)))
    print()
    print("── 变大的文件（AVIF 不划算，必须逐张判断）──")
    worse = [(r[1], (1 - r[3] / float(r[2])) * 100, r[0]) for r in rows if r[3] >= r[2]]
    if not worse:
        print("   无")
    else:
        for f0, sv, rel in sorted(worse):
            print("   %-6s %+6.1f%%  %s" % (f0, sv, rel))
    return 0


if __name__ == "__main__":
    sys.exit(main())
