# -*- coding: utf-8 -*-
"""放大预览：把指定光标放到 4 倍，浅/深背景并排，便于判断细节质量。"""
import os, struct
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "zfsn")


def _dib_to_img(dib):
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
    return img, (ih[3], ih[4])


def load(fn):
    p = os.path.join(OUT, fn)
    if p.endswith(".cur"):
        b = open(p, "rb").read()
        off = struct.unpack("<I", b[18:22])[0]
        return _dib_to_img(b[off:])
    # ani 第一帧
    b = open(p, "rb").read()
    pos = 12
    while pos < len(b) - 8:
        cid = b[pos:pos + 4]
        csz = struct.unpack("<I", b[pos + 4:pos + 8])[0]
        body = b[pos + 8:pos + 8 + csz]
        if cid == b"LIST":
            p2 = 4
            while p2 < len(body):
                fid = body[p2:p2 + 4]
                fsz = struct.unpack("<I", body[p2 + 4:p2 + 8])[0]
                if fid == b"fram":
                    ic = body[p2 + 8:p2 + 8 + fsz]
                    off = struct.unpack("<I", ic[18:22])[0]
                    return _dib_to_img(ic[off:])
                p2 += 8 + fsz
        pos += 8 + csz
    raise RuntimeError("no frame in " + fn)


FOCUS = ["Normal", "Help", "Link", "Precision", "Handwriting", "Text",
         "SizeNWSE", "Unavailable", "Up", "Busy"]
SC = 5
CELL = 32 * SC + 24
sheet = Image.new("RGBA", (CELL * 2, CELL * len(FOCUS)), (18, 18, 24, 255))
d = ImageDraw.Draw(sheet)
for i, fn in enumerate(FOCUS):
    img, _ = load(fn + (".ani" if fn == "Busy" else ".cur"))
    big = img.resize((32 * SC, 32 * SC), Image.NEAREST)   # NEAREST：看真实像素
    y = i * CELL
    d.rectangle([0, y, CELL - 1, y + CELL - 1], fill=(236, 236, 240, 255))
    d.rectangle([CELL, y, CELL * 2 - 1, y + CELL - 1], fill=(36, 36, 44, 255))
    sheet.alpha_composite(big, (12, y + 12))
    sheet.alpha_composite(big, (CELL + 12, y + 12))
sheet.convert("RGB").save(os.path.join(HERE, "preview_zoom.png"))
print("preview_zoom.png 已生成（5x 最近邻放大，左浅底/右深底）")
