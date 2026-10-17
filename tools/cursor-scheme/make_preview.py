# -*- coding: utf-8 -*-
"""生成对比预览：每个光标并排放在浅色/深色背景上。

光标必须在两种底色下都清晰可辨 —— 只测深色底会漏掉
「浅色桌面下深色图形看不见」这类问题。
"""
import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "zfsn")
NAMES = [
    ("Normal", "正常选择"), ("Help", "帮助选择"), ("Text", "文本选择"),
    ("Link", "链接选择"), ("Precision", "精确选择"), ("SizeNS", "垂直调整"),
    ("SizeWE", "水平调整"), ("SizeNWSE", "对角线调整1"), ("SizeNESW", "对角线调整2"),
    ("Move", "移动"), ("Unavailable", "不可用"), ("Handwriting", "手写"),
    ("Up", "备用"), ("Busy", "忙(动画)"), ("Working", "后台运行(动画)"),
]

import struct


def load_cur(path):
    b = open(path, "rb").read()
    w, h, cc, res, hx, hy, size, off = struct.unpack("<BBBBHHII", b[6:22])
    dib = b[off:off + size]
    ih = struct.unpack("<IiiHHIIiiII", dib[:40])
    W, H = ih[1], ih[2] // 2
    xlen = W * 4
    xor = dib[40:40 + xlen * H]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = img.load()
    for row in range(H):
        y = H - 1 - row
        for x in range(W):
            i = row * xlen + x * 4
            px[x, y] = (xor[i + 2], xor[i + 1], xor[i], xor[i + 3])
    return img, (hx, hy)


def load_ani_first(path):
    b = open(path, "rb").read()
    pos = 12
    while pos < len(b) - 8:
        cid = b[pos:pos + 4]
        csz = struct.unpack("<I", b[pos + 4:pos + 8])[0]
        body = b[pos + 8:pos + 8 + csz]
        if cid == b"LIST":
            p = 4
            while p < len(body):
                fid = body[p:p + 4]
                fsz = struct.unpack("<I", body[p + 4:p + 8])[0]
                if fid == b"fram":
                    return load_cur_from_ico(body[p + 8:p + 8 + fsz])
                p += 8 + fsz
        pos += 8 + csz
    raise RuntimeError("no frame")


def load_cur_from_ico(ic):
    w, h, cc, res, hx, hy, size, off = struct.unpack("<BBBBHHII", ic[6:22])
    dib = ic[off:off + size]
    ih = struct.unpack("<IiiHHIIiiII", dib[:40])
    W, H = ih[1], ih[2] // 2
    xlen = W * 4
    xor = dib[40:40 + xlen * H]
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = img.load()
    for row in range(H):
        y = H - 1 - row
        for x in range(W):
            i = row * xlen + x * 4
            px[x, y] = (xor[i + 2], xor[i + 1], xor[i], xor[i + 3])
    return img, (hx, hy)


COLS = 5
ROWS = (len(NAMES) + COLS - 1) // COLS
CELL = 150
SC = 2.5            # 放大倍数便于观察
sheet = Image.new("RGBA", (COLS * CELL, ROWS * CELL), (18, 18, 24, 255))
d = ImageDraw.Draw(sheet)

for i, (fn, cn) in enumerate(NAMES):
    cx, cy = (i % COLS) * CELL, (i // COLS) * CELL
    p = os.path.join(OUT, fn + ".cur")
    if os.path.exists(p):
        img, hot = load_cur(p)
    else:
        img, hot = load_ani_first(os.path.join(OUT, fn + ".ani"))
    big = img.resize((int(32 * SC), int(32 * SC)), Image.LANCZOS)
    bw, bh = big.size
    # 左半：浅色底；右半：深色底
    d.rectangle([cx + 6, cy + 6, cx + CELL - 6, cy + CELL - 34],
                fill=(238, 238, 242, 255))
    d.rectangle([cx + 6, cy + 6, cx + CELL - 6, cy + CELL - 34],
                outline=(120, 120, 130, 255))
    d.rectangle([cx + 6, cy + 6, cx + (CELL - 6) / 2, cy + CELL - 34],
                fill=(238, 238, 242, 255))
    d.rectangle([cx + (CELL - 6) / 2, cy + 6, cx + CELL - 6, cy + CELL - 34],
                fill=(38, 38, 46, 255))
    sheet.alpha_composite(big, (cx + 14, cy + 12))
    d.line([cx + 14 + hot[0] * SC, cy + 12,
            cx + 14 + hot[0] * SC, cy + 12 + bh],
           fill=(0, 200, 255, 160), width=1)
    d.line([cx + 14, cy + 12 + hot[1] * SC,
            cx + 14 + bw, cy + 12 + hot[1] * SC],
           fill=(0, 200, 255, 160), width=1)
    d.text((cx + 8, cy + CELL - 30), "%s  %s" % (cn, fn),
           fill=(235, 235, 245, 255))
    d.text((cx + 8, cy + CELL - 16), "hotspot (%d,%d)" % hot,
           fill=(150, 150, 165, 255))

sheet.convert("RGB").save(os.path.join(HERE, "preview_dual.png"))
print("preview_dual.png 已生成（浅色/深色双背景，蓝线=热点）")
