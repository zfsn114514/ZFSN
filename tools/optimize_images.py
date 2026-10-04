# -*- coding: utf-8 -*-
"""
图片再压缩 —— 原地转 WebP / AVIF，并生成 <picture> 需要的降级副本。

━━ 为什么是「原地替换」而不是「另存新格式」━━━━━━━━━━━━━━━━━━━━
曾经想过把 .jpg 全换成 .webp 再改所有引用，但那行不通：图片路径散落在
index.html、bili_videos.json、xbox_games.json、steam_games.json，
以及 **D1 数据库的作品记录**里（后台可编辑）。改扩展名 = 这些引用全 404。

所以策略是：
  · 主文件**保留原扩展名和原路径**，内容换成压缩后的数据。
    → 所有已有引用天然继续有效，零改动。
  · 额外产出 `.webp` / `.avif` 同名副本，供 <picture><source> 择优加载。
    → 浏览器支持就下更小的，不支持就回落到主文件。

━━ 为什么优先打 PNG 的注意 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
本站图片共 9.8 MB，其中 3 张 1280×720 的 **PNG 截图占了 2.9 MB**。
PNG 是无损格式，截图这类有大片渐变和抗锯齿文字的图，无损压缩几乎压不动
（273 KB/MP）—— 换成有损 WebP 后是 20 KB/MP 量级，体积差 10 倍以上。
摄影类 JPG 本来就已经压过了，再压收益小得多（10~20%）。

⚠ WebP/AVIF 对**带透明通道**的 PNG 要小心：转 JPEG 会丢掉 alpha，
  所以脚本按 mode 判断，有 alpha 的走 WebP（支持透明）并跳过 AVIF→JPG 的路径。

用法：
    python optimize_images.py                # 真的处理
    python optimize_images.py --dry-run      # 只报告，不写盘
    python optimize_images.py --only png     # 只处理 PNG（默认 all）
    python optimize_images.py --no-avif      # 跳过 AVIF（编码慢）
"""
import io
import os
import sys
import shutil
import argparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

try:
    from PIL import Image, features
except ImportError:
    print("需要 Pillow：pip install Pillow")
    sys.exit(1)

# ── 编码参数 ──────────────────────────────────────────────────
# 质量是「肉眼无损」档位，不是极限压缩档。
# 实测 PSNR：webp q88 ≈ 33~38 dB，avif q62 ≈ 32~36 dB，
# 都在「看不出差别」的区间（一般 >32 dB 即可认为视觉无损）。
WEBP_Q = 88
AVIF_Q = 62

# 扫描目录（相对站点根）
SCAN_DIRS = ["assets"]

# 不碰的东西：
#   cursor/ 是 SVG（矢量，改了没意义，且是光标热点依赖的尺寸）
#   任何 < 8 KB 的图 —— 压不出多少，徒增 AVIF 编码时间和产物数量
SKIP_DIR_PARTS = {"cursor"}
MIN_BYTES = 8 * 1024

# 主文件允许被重写为哪种格式
#   有 alpha → webp（保留透明）
#   无 alpha → webp（jpeg 也可，但 webp 更小且无损之外还能带 alpha）
PRIMARY_FMT = "WEBP"

HAS_WEBP = features.check("webp")
HAS_AVIF = features.check("avif")


def human(n):
    if n < 1024:
        return "%d B" % n
    if n < 1024 * 1024:
        return "%.0f KB" % (n / 1024.0)
    return "%.2f MB" % (n / 1048576.0)


def psnr(a, b):
    """峰值信噪比，用于自检「压完还看不看得出」。纯 Python，避免依赖 numpy。"""
    if a.size != b.size:
        return None
    da = a.tobytes()
    db = b.tobytes()
    n = len(da)
    if n == 0:
        return None
    # 逐字节算 MSE：字节串做差要过一遍 int，但图不大，够用
    se = 0
    for i in range(0, n, 997):        # 抽样 1/997，够估算且快
        d = da[i] - db[i]
        se += d * d
    samples = len(range(0, n, 997))
    mse = se / float(samples) if samples else 0
    if mse <= 0:
        return 99.0
    import math
    return 10.0 * math.log10((255.0 ** 2) / mse)


def encode(im, fmt, quality):
    b = io.BytesIO()
    if fmt == "WEBP":
        im.save(b, format="WEBP", quality=quality, method=6)
    elif fmt == "AVIF":
        im.save(b, format="AVIF", quality=quality, speed=4)
    else:
        raise ValueError(fmt)
    return b.getvalue()


def collect(root, only):
    out = []
    for d in SCAN_DIRS:
        base = os.path.join(root, d)
        if not os.path.isdir(base):
            continue
        for dirpath, _dirnames, filenames in os.walk(base):
            parts = set(os.path.relpath(dirpath, root).split(os.sep))
            if parts & SKIP_DIR_PARTS:
                continue
            for fn in filenames:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in (".png", ".jpg", ".jpeg"):
                    continue
                if only == "png" and ext != ".png":
                    continue
                if only == "jpg" and ext not in (".jpg", ".jpeg"):
                    continue
                p = os.path.join(dirpath, fn)
                if os.path.getsize(p) < MIN_BYTES:
                    continue
                out.append(p)
    return sorted(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    ap.add_argument("--only", choices=["all", "png", "jpg"], default="all")
    # 默认**不生成** AVIF 副本：
    #   AVIF 虽然比 WebP 再省约 40%，但要用上必须把 HTML/JS 里的 <img>
    #   改成 <picture>（本项目有多处 img 是 JS 动态生成的），
    #   而且要额外占 3.47 MB 仓库体积。前端没有 <picture> 时这些文件
    #   永远不会被请求 —— 纯属浪费。需要时显式加 --avif。
    ap.add_argument("--avif", dest="avif", action="store_true",
                    help="额外生成 AVIF 副本（默认不生成，前端需配合 <picture>）")
    ap.add_argument("--no-avif", dest="avif", action="store_false",
                    help="（已废弃，现为默认行为）")
    ap.set_defaults(avif=False)
    ap.add_argument("--backup", default="", help="把原图备份到此目录（建议填）")
    args = ap.parse_args()

    root = common.site_root()
    common.banner("图片再压缩")

    if not HAS_WEBP:
        print("✗ 本机 Pillow 不支持 WebP，无法继续。")
        return 1
    if not HAS_AVIF and args.avif:
        print("! 本机 Pillow 不支持 AVIF，自动跳过 AVIF 产物。")
        args.avif = False

    files = collect(root, args.only)
    print("待处理 %d 个文件（>= %s，目录 %s）" % (len(files), human(MIN_BYTES), ",".join(SCAN_DIRS)))
    if args.backup:
        print("原图备份到：%s" % args.backup)
    print()

    tot_before = tot_after = 0
    saved_list = []
    bad = []

    print("%-46s %9s %9s %9s %7s %6s" % ("文件", "原", "webp主", "avif", "省", "PSNR"))
    print("-" * 100)

    for p in files:
        rel = os.path.relpath(p, root).replace(os.sep, "/")
        before = os.path.getsize(p)
        try:
            im = Image.open(p)
            im.load()
        except Exception as e:
            print("%-46s  跳过：打不开 (%s)" % (rel, e))
            continue

        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        note = ""

        # ── 主文件：原地换内容，保留文件名 ──
        # 有 alpha 的必须是 WEBP/PNG，不能落 JPEG
        work = im.convert("RGBA" if has_alpha else "RGB")
        try:
            wb = encode(work, "WEBP", WEBP_Q)
        except Exception as e:
            print("%-46s  跳过：webp 编码失败 (%s)" % (rel, e))
            continue

        # 安全阀：压完反而变大就别换（小图 / 已高度优化的图会出现）
        if len(wb) >= before:
            note = "webp不划算，保留原文件"
            after = before
        else:
            after = len(wb)

        # ── AVIF 副本（默认不生成，见 --avif 说明）──
        ab = None
        if args.avif:
            try:
                ab = encode(work, "AVIF", AVIF_Q)
            except Exception as e:
                note = (note + " avif失败").strip()

        # 质量自检（只在真的替换时算）
        q = None
        if after != before:
            try:
                back = Image.open(io.BytesIO(wb)).convert("RGB")
                q = psnr(work.convert("RGB"), back)
            except Exception:
                q = None
            # PSNR < 30 说明压过头了，宁可放弃这单收益也不降画质
            if q is not None and q < 30:
                after = before
                ab = None
                note = "PSNR %.1f 过低，放弃" % q

        print("%-46s %9s %9s %9s %6.0f%% %6s" % (
            rel[:46], human(before),
            human(after) if after != before else "—",
            human(len(ab)) if ab else "—",
            (1 - after / float(before)) * 100 if before else 0,
            ("%.1f" % q) if q else "—",
        ))
        if note:
            print("      └ %s" % note)

        tot_before += before
        tot_after += after
        if after != before:
            saved_list.append((before - after, rel))

        if args.dry_run:
            continue

        # ── 落盘 ──
        try:
            if args.backup:
                bdir = os.path.join(args.backup, os.path.dirname(rel))
                os.makedirs(bdir, exist_ok=True)
                dst = os.path.join(bdir, os.path.basename(rel))
                if not os.path.exists(dst):
                    shutil.copy2(p, dst)
            if after != before:
                # 原子替换：先写临时文件再 os.replace，避免中断留下半个图
                tmp = p + ".tmpimg"
                with open(tmp, "wb") as f:
                    f.write(wb)
                os.replace(tmp, p)
            if ab:
                with open(p + ".avif", "wb") as f:
                    f.write(ab)
        except Exception as e:
            bad.append((rel, str(e)))
            print("      ✗ 写盘失败：%s" % e)

    print("-" * 100)
    print("合计：%s → %s，省 %s（%.1f%%）" % (
        human(tot_before), human(tot_after),
        human(tot_before - tot_after),
        (1 - tot_after / float(tot_before)) * 100 if tot_before else 0))

    if saved_list:
        print()
        print("收益最大的 5 个：")
        for d, rel in sorted(saved_list, reverse=True)[:5]:
            print("   %9s  %s" % (human(d), rel))

    if bad:
        print()
        print("⚠ 有 %d 个文件写盘失败：" % len(bad))
        for rel, e in bad:
            print("   %s —— %s" % (rel, e))
        return 1

    if args.dry_run:
        print()
        print("(dry-run，未写入任何文件)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
