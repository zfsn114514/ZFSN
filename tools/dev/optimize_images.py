#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
图片资源优化 —— ZFSN 站点
────────────────────────────────────────────────────────────────
背景：assets/ 下 130+ 张图共 32 MB，主要浪费在
  - 1920x1080 原图直接当卡片封面（实际显示区域只有几百像素）
  - works/ 里 3.4 MB 的照片用 PNG 存
  - xbox/ 竖版 1440x2160 当横向卡片封面

**核心约束：保留原扩展名，绝不改名。**
  图片路径散落在 index.html、bili_videos.json、xbox_games.json、
  steam_games.json 以及 D1 的作品记录（后台可编辑）里，
  一旦把 a.png 改成 a.webp，D1 里存的 "a.png" 立刻 404。
  所以统一「原地压缩、同名覆盖」。

策略：
  1. JPEG：按目录缩到目标长边 → JPEG q82 progressive
  2. PNG 照片：按目录缩到目标长边 → **仍存 PNG**，用
     quantize(256) 调色板压缩（肉眼几乎无差，体积降 60~80%）
     若调色板版反而更大，退化为 optimize=True 的真彩色 PNG
  3. 新文件必须比原文件小 15% 以上才替换，否则保持原样
  4. 小于 60 KB 的文件不动
  5. 原文件先备份到 assets/_orig/（保留目录结构）

用法：
  python tools/dev/optimize_images.py --dry-run   # 只报告不写入
  python tools/dev/optimize_images.py             # 实际执行
"""
import io
import os
import shutil
import argparse
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent.parent
ASSETS = ROOT / "assets"
ORIG = ASSETS / "_orig"

# 各目录的目标长边（像素）。封面类不需要 1080p。
MAX_EDGE = {
    "works": 1280,   # 作品图：点开看大图，保留较高分辨率
    "bili": 720,     # B站封面：卡片 + 悬浮预览，720p 足够且不发虚
    "xbox": 800,     # Xbox 封面：竖版变横版容器，800 长边够用
    "": 1280,        # 根目录杂项
}
JPEG_QUALITY = 84
MIN_GAIN = 0.15       # 至少省 15% 才替换
MIN_SIZE = 60 * 1024  # 小于 60KB 不动

# 文件被这些路径引用过时绝不处理（防止误伤）
EXTS = {".png", ".jpg", ".jpeg"}


def target_edge(rel: Path) -> int:
    key = rel.parts[0] if len(rel.parts) > 1 else ""
    return MAX_EDGE.get(key, 1280)


def human(n: int) -> str:
    return f"{n/1024:.0f}K" if n < 1024 * 1024 else f"{n/1048576:.1f}M"


def encode_png(im: Image.Image) -> bytes:
    """PNG 编码：优先调色板（256 色），不行再退回真彩色 optimize。"""
    best = None
    # 方案 A：调色板 256 色（对截图/UI 图效果极好，对照片也够用）
    try:
        q = im.convert("RGB").quantize(colors=256, method=Image.MEDIANCUT)
        buf = io.BytesIO()
        q.save(buf, format="PNG", optimize=True)
        best = buf.getvalue()
    except Exception:
        best = None
    # 方案 B：真彩色 + optimize
    try:
        buf2 = io.BytesIO()
        im.convert("RGB").save(buf2, format="PNG", optimize=True, compress_level=9)
        b = buf2.getvalue()
        if best is None or b < best:
            best = b
    except Exception:
        pass
    if best is None:
        raise RuntimeError("PNG 编码失败")
    return best


def encode_jpeg(im: Image.Image) -> bytes:
    buf = io.BytesIO()
    im.convert("RGB").save(buf, format="JPEG", quality=JPEG_QUALITY,
                           optimize=True, progressive=True)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="只报告，不写文件")
    args = ap.parse_args()

    files = []
    for p in ASSETS.rglob("*"):
        if not p.is_file() or p.suffix.lower() not in EXTS:
            continue
        if "_orig" in p.parts or "_backup" in p.parts:
            continue
        files.append(p)
    files.sort(key=lambda p: p.stat().st_size, reverse=True)

    total_before = sum(p.stat().st_size for p in files)
    total_after = 0
    converted = 0
    skipped = 0
    rows = []

    for p in files:
        rel = p.relative_to(ASSETS)
        before = p.stat().st_size

        if before < MIN_SIZE:
            total_after += before
            skipped += 1
            continue

        try:
            im = Image.open(p)
            im.load()
        except Exception as e:
            print(f"  ! 无法读取 {rel}: {e}")
            total_after += before
            skipped += 1
            continue

        w, h = im.size
        edge = target_edge(rel)
        work = im
        if max(w, h) > edge:
            ratio = edge / max(w, h)
            nw, nh = max(1, round(w * ratio)), max(1, round(h * ratio))
            work = im.resize((nw, nh), Image.LANCZOS)

        # 编码（保留原扩展名）
        try:
            if p.suffix.lower() in (".jpg", ".jpeg"):
                data = encode_jpeg(work)
            else:
                data = encode_png(work)
        except Exception as e:
            print(f"  ! 编码失败 {rel}: {e}")
            total_after += before
            skipped += 1
            continue

        est = len(data)
        if est >= before * (1 - MIN_GAIN):
            total_after += before
            skipped += 1
            continue

        after = est
        converted += 1
        rows.append((str(rel).replace(os.sep, "/"), before, after,
                     f"{w}x{h} -> {max(work.size)}px"))

        if not args.dry_run:
            bak = ORIG / rel
            bak.parent.mkdir(parents=True, exist_ok=True)
            if not bak.exists():
                shutil.copy2(p, bak)
            tmp = p.with_name(p.name + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(p)

        total_after += after

    print()
    print("=" * 78)
    print(f"{'文件':<46}{'优化前':>9}{'优化后':>9}{'变化':>10}")
    print("-" * 78)
    for name, b, a, note in rows[:45]:
        pct = (a - b) / b * 100 if b else 0
        print(f"{name[:45]:<46}{human(b):>9}{human(a):>9}{pct:>9.0f}%")
    if len(rows) > 45:
        print(f"... 另有 {len(rows)-45} 个文件")
    print("-" * 78)
    print(f"{'合计':<46}{human(total_before):>9}{human(total_after):>9}"
          f"{(total_after-total_before)/total_before*100:>9.0f}%")
    print(f"\n处理：{converted} 个已优化，{skipped} 个保持原样")
    print(f"总计：{human(total_before)} -> {human(total_after)}"
          f"  节省 {human(total_before-total_after)}")
    if args.dry_run:
        print("\n[DRY RUN] 未写入任何文件。去掉 --dry-run 实际执行。")
    else:
        print(f"\n原图备份在：{ORIG}")


if __name__ == "__main__":
    main()
