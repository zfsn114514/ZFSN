# -*- coding: utf-8 -*-
"""生成 ZFSN 红色发光风格 Windows 光标方案（.cur / .ani）

设计语言复刻自站点 assets/cursor/*.svg：
  - 主色 #ff2d4a
  - 高斯模糊发光（feGaussianBlur + feMerge x2）
  - 主光标热点 (4, 2)
输出：32x32，PNG-in-CUR（Vista+），动画用真正的 .ani 帧序列。
"""
import os, struct, sys
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "zfsn")
os.makedirs(OUT, exist_ok=True)

RED = (255, 51, 74, 255)          # #ff334a，比原 #ff2d4a 更亮更饱和
RED_SOFT = (255, 51, 74, 45)      # 中空填充 ~18%，对齐网页 .12~.14
DARK = (45, 4, 14, 255)           # 深色描边，保证浅色桌面也看得见
WHITE = (255, 255, 255, 255)

S = 4                              # 超采样倍数
N = 32
CV = N * S                         # 128 画布


def canvas():
    return Image.new("RGBA", (CV, CV), (0, 0, 0, 0))




def finish(img):
    return img.resize((N, N), Image.LANCZOS)


def scaled(pts):
    return [(x * S, y * S) for x, y in pts]


# ────────────────────────── 各光标绘制 ──────────────────────────

def arrow_shape(d, ox=0, oy=0, fill=RED_SOFT, stroke=RED, w=2.0, dark=True):
    """站点同款三角箭头，顶点 (4,2.5)"""
    pts = scaled([(4 + ox, 2.5 + oy), (22.5 + ox, 11.5 + oy), (13 + ox, 20.5 + oy)])
    if dark:
        d.line(pts + [pts[0]], fill=DARK, width=int(w * S) + int(1.2 * S), joint="curve")
    d.line(pts + [pts[0]], fill=stroke, width=int(w * S), joint="curve")
    if fill:
        d.polygon(pts, fill=fill)


def draw_arrow(img, **kw):
    lay = canvas()
    arrow_shape(ImageDraw.Draw(lay), **kw)
    img.alpha_composite(lay)


def draw_help(img):
    draw_arrow(img)
    d = ImageDraw.Draw(img)
    # 问号气泡
    bx, by, br = 20 * S, 21 * S, 8.5 * S
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=DARK)
    d.ellipse([bx - br + 1 * S, by - br + 1 * S, bx + br - 1 * S, by + br - 1 * S],
              fill=(255, 255, 255, 235))
    d.ellipse([bx - br + 2 * S, by - br + 2 * S, bx + br - 2 * S, by + br - 2 * S],
              fill=RED)
    # 问号笔画
    q = [(bx - 2.6 * S, by - 2.4 * S), (bx - 0.6 * S, by - 4.2 * S),
         (bx + 1.4 * S, by - 3.0 * S), (bx + 2.0 * S, by - 1.0 * S),
         (bx + 2.0 * S, by + 0.8 * S), (bx - 0.6 * S, by + 1.6 * S)]
    d.line(q, fill=WHITE, width=int(1.5 * S), joint="curve")
    d.ellipse([bx - 1.1 * S, by + 3.4 * S, bx + 0.7 * S, by + 5.2 * S], fill=WHITE)


def draw_ibeam(img):
    d = ImageDraw.Draw(img)
    x = 15.5 * S
    w = int(2.4 * S)
    d.line([(x, 6 * S), (x, 26 * S)], fill=DARK, width=w + int(1.4 * S))
    d.line([(x, 6 * S), (x, 26 * S)], fill=RED, width=w)
    # 上下衬线
    for yy in (6 * S, 26 * S):
        d.line([(x - 3.4 * S, yy), (x + 3.4 * S, yy)], fill=DARK, width=int(1.9 * S))
        d.line([(x - 2.6 * S, yy), (x + 2.6 * S, yy)], fill=RED, width=int(1.5 * S))
    lay = canvas()
    dl = ImageDraw.Draw(lay)
    dl.line([(x, 6 * S), (x, 26 * S)], fill=RED, width=w)
    for yy in (6 * S, 26 * S):
        dl.line([(x - 2.6 * S, yy), (x + 2.6 * S, yy)], fill=RED, width=int(1.5 * S))


def draw_link(img):
    """链接选择：复刻站点 point.svg 的同心圆环（外环 + 中心实心点）。

    放弃手型方案：手型用圆角矩形拼出来必然"手绘感"，
    而正圆是数学上完美的图形，也更贴合站点原有设计。
    """
    d = ImageDraw.Draw(img)
    c = 16 * S
    r = 8.4 * S
    sw = 2.4 * S

    def ring(dd, col, w):
        dd.ellipse([c - r, c - r, c + r, c + r], outline=col, width=int(w))

    # 深色外衬（浅色桌面也看得见）
    ring(d, DARK, sw + 1.3 * S)
    # 发光
    # 主环
    ring(d, RED, sw)
    # 中心实心点
    d.ellipse([c - 2.9 * S, c - 2.9 * S, c + 2.9 * S, c + 2.9 * S], fill=DARK)
    d.ellipse([c - 2.2 * S, c - 2.2 * S, c + 2.2 * S, c + 2.2 * S], fill=RED)


def draw_precision(img):
    """精确选择：严格关于 (16,16) 对称的十字 + 中心点。

    旧版四条臂长度不一，是"手绘感"的来源；这里用同一常量
    生成四条臂，保证镜像对称。
    """
    d = ImageDraw.Draw(img)
    c = 16 * S
    w = 1.9 * S
    inner = 4.4 * S          # 中心缺口半径
    outer = 12.8 * S         # 臂长
    arms = [(0, -1), (0, 1), (-1, 0), (1, 0)]
    segs = [(c + dx * inner, c + dy * inner, c + dx * outer, c + dy * outer)
            for dx, dy in arms]

    for a, b, cc, dd in segs:
        d.line([(a, b), (cc, dd)], fill=DARK, width=int(w + 1.3 * S))
    for a, b, cc, dd in segs:
        d.line([(a, b), (cc, dd)], fill=RED, width=int(w))
    # 末端小刻度，增强 HUD 感（同样对称）
    tk = 2.6 * S
    for dx, dy in arms:
        px, py = c + dx * outer, c + dy * outer
        if dx:
            d.line([(px, py - tk), (px, py + tk)], fill=RED, width=int(w))
        else:
            d.line([(px - tk, py), (px + tk, py)], fill=RED, width=int(w))
    # 中心点
    d.ellipse([c - 1.3 * S, c - 1.3 * S, c + 1.3 * S, c + 1.3 * S], fill=DARK)
    d.ellipse([c - 0.8 * S, c - 0.8 * S, c + 0.8 * S, c + 0.8 * S], fill=WHITE)


def _double_arrow(d, ang_deg, color_body=RED):
    """双头箭头；ang_deg=90 上下、0 左右、135/45 对角"""
    import math
    a = math.radians(ang_deg)
    ca, sa = math.cos(a), math.sin(a)
    c = 16 * S
    L = 11 * S
    hw = 5.6 * S          # 箭头半宽
    hh = 5.2 * S          # 箭头半长
    shaft = 2.2 * S

    def rot(x, y):
        return (c + x * ca - y * sa, c + x * sa + y * ca)

    # 杆
    d.line([rot(-L, 0), rot(L, 0)], fill=DARK, width=int(shaft + 1.2 * S))
    for sgn in (1, -1):
        tip = rot(sgn * L, 0)
        b1 = rot(sgn * (L - hh), -hw)
        b2 = rot(sgn * (L - hh), hw)
        d.polygon([tip, b1, b2], fill=DARK)
    d.line([rot(-L, 0), rot(L, 0)], fill=color_body, width=int(shaft))
    for sgn in (1, -1):
        tip = rot(sgn * L, 0)
        b1 = rot(sgn * (L - hh), -hw)
        b2 = rot(sgn * (L - hh), hw)
        d.polygon([tip, b1, b2], fill=color_body)


def draw_resize(img, ang):
    lay = canvas()
    _double_arrow(ImageDraw.Draw(lay), ang)
    img.alpha_composite(lay)


def draw_move(img):
    d = ImageDraw.Draw(img)
    c = 16 * S
    import math
    for ang in (0, 90, 45, 135):
        a = math.radians(ang)
        ca, sa = math.cos(a), math.sin(a)
        L = 12 * S
        hw, hh = 4.6 * S, 4.0 * S

        def rot(x, y):
            return (c + x * ca - y * sa, c + x * sa + y * ca)
        for sgn in (1, -1):
            tip = rot(sgn * L, 0)
            d.polygon([tip, rot(sgn * (L - hh), -hw), rot(sgn * (L - hh), hw)], fill=DARK)
    lay = canvas()
    dl = ImageDraw.Draw(lay)
    for ang in (0, 90, 45, 135):
        a = math.radians(ang)
        ca, sa = math.cos(a), math.sin(a)
        L = 12 * S
        hw, hh = 4.6 * S, 4.0 * S

        def rot(x, y):
            return (c + x * ca - y * sa, c + x * sa + y * ca)
        for sgn in (1, -1):
            tip = rot(sgn * L, 0)
            dl.polygon([tip, rot(sgn * (L - hh), -hw), rot(sgn * (L - hh), hw)], fill=RED)
    img.alpha_composite(lay)
    d2 = ImageDraw.Draw(img)
    d2.ellipse([c - 2.2 * S, c - 2.2 * S, c + 2.2 * S, c + 2.2 * S], fill=DARK)
    d2.ellipse([c - 1.5 * S, c - 1.5 * S, c + 1.5 * S, c + 1.5 * S], fill=WHITE)


def draw_no(img):
    d = ImageDraw.Draw(img)
    c = 16 * S
    r = 10.5 * S
    d.ellipse([c - r, c - r, c + r, c + r], outline=DARK, width=int(3.2 * S))
    d.ellipse([c - r, c - r, c + r, c + r], outline=RED, width=int(2.2 * S))
    d.line([(c - 7.4 * S, c - 7.4 * S), (c + 7.4 * S, c + 7.4 * S)],
           fill=DARK, width=int(3.2 * S))
    d.line([(c - 7.4 * S, c - 7.4 * S), (c + 7.4 * S, c + 7.4 * S)],
           fill=RED, width=int(2.2 * S))


def draw_pen(img):
    """手写光标：几何钢笔。

    旧版把「宽度」偏移沿笔轴方向加，画出来是个细长三角条（可见像素仅 26），
    是整套里最小的一个。这里用正确的平行四边形数学：
    轴 u = (0.707,-0.707)（向右上），宽 v = (0.707,0.707)（向右下），
    五边形 = 笔尖 + 下沿 + 后端 + 上沿。
    """
    import math
    d = ImageDraw.Draw(img)
    ux, uy = math.sqrt(0.5), -math.sqrt(0.5)     # 轴
    vx, vy = math.sqrt(0.5), math.sqrt(0.5)      # 宽
    T = (4.6, 25.8)                               # 笔尖根
    L, W, NIB = 19.0, 7.2, 3.6

    def add(p, dx, dy):
        return (p[0] + dx, p[1] + dy)

    A = T                                                    # 笔尖根
    B = add(A, vx * W, vy * W)                               # 下沿起点
    C = add(B, ux * L, uy * L)                               # 后端下角
    D = add(C, -vx * W, -vy * W)                             # 后端上角
    N = add(A, -ux * NIB, -uy * NIB)                          # 笔尖尖
    outer = [N, B, C, D, A]

    # 内缩版本（绕质心缩 12%，露出深色描边）
    cx = sum(p[0] for p in outer) / len(outer)
    cy = sum(p[1] for p in outer) / len(outer)
    k = 0.88
    inner = [(cx + (p[0] - cx) * k, cy + (p[1] - cy) * k) for p in outer]

    d.polygon(scaled(outer), fill=DARK)
    d.polygon(scaled(inner), fill=RED)
    # 笔尖白点（热点提示）
    d.ellipse(scaled([(N[0] - 1.5, N[1] - 1.5), (N[0] + 1.5, N[1] + 1.5)]), fill=WHITE)
    # 发光


def draw_uparrow(img):
    d = ImageDraw.Draw(img)
    c = 16 * S
    d.line([(c, 3 * S), (c, 26 * S)], fill=DARK, width=int(4.4 * S))
    d.line([(c, 3 * S), (c, 26 * S)], fill=RED, width=int(3.0 * S))
    tip = (c, 2 * S)
    d.polygon([tip, (c - 6.5 * S, c - 1.0 * S), (c + 6.5 * S, c - 1.0 * S)], fill=DARK)
    d.polygon([tip, (c - 5.2 * S, c - 0.4 * S), (c + 5.2 * S, c - 0.4 * S)], fill=RED)


def draw_busy_frame(img, t):
    """旋转的三点弧（红），t in [0,1)"""
    import math
    d = ImageDraw.Draw(img)
    c = 16 * S
    r = 9.5 * S
    for i in range(8):
        ph = (t * 2 * math.pi) + i * (2 * math.pi / 8)
        x = c + r * math.cos(ph)
        y = c + r * math.sin(ph)
        # 尾迹淡出
        k = 1.0 - i / 8.0
        a = int(255 * (0.45 + 0.55 * k))
        col = (255, 45, 74, a)
        rr = (2.5 - 0.9 * i / 8.0) * S
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=col)
    d2 = ImageDraw.Draw(img)
    d2.ellipse([c - 1.4 * S, c - 1.4 * S, c + 1.4 * S, c + 1.4 * S], fill=WHITE)


def draw_appstart_frame(img, t):
    """箭头 + 同款旋转弧"""
    draw_arrow(img)
    import math
    d = ImageDraw.Draw(img)
    c = 24 * S
    r = 7.0 * S
    for i in range(6):
        ph = (t * 2 * math.pi) + i * (2 * math.pi / 6)
        x = c + r * math.cos(ph)
        y = c + r * math.sin(ph)
        k = 1.0 - i / 6.0
        a = int(255 * (0.45 + 0.55 * k))
        rr = (1.9 - 0.7 * i / 6.0) * S
        d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(255, 45, 74, a))


# ────────────────────────── 编码输出 ──────────────────────────

def png_bytes(img):
    import io
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def dib_bmp(img):
    """经典 BMP DIB（32bpp BGRA + 1bpp AND 掩码）。

    不用 PNG-in-CUR：后者虽 Vista+ 支持，但经典 BMP 格式在所有
    Windows 版本上都能正确显示，且 AND 掩码兜底半透明失效的情况。
    """
    w, h = img.size
    px = img.convert("RGBA")
    # XOR 位图：自下而上，BGRA
    xor = bytearray()
    for y in range(h - 1, -1, -1):
        row = bytearray()
        for x in range(w):
            r, g, b, a = px.getpixel((x, y))
            row += bytes((b, g, r, a))
        xor += row
    # AND 掩码：1bpp，自下而上，每行补到 32 位边界；alpha<128 的位记 1。
    # ⚠ 字节序坑：DIB 要求「每个字节内 MSB 优先」，即像素 x=0 占字节 0 的 bit7。
    # 若用 struct.pack("<I") 打包，小端会反转字节顺序，读写就不一致，
    # 结果是所有像素被误判为透明（alpha 全被清零）。
    andm = bytearray()
    rowbytes = ((w + 31) // 32) * 4
    for y in range(h - 1, -1, -1):
        bits = [0 if px.getpixel((x, y))[3] >= 128 else 1 for x in range(w)]
        bits += [0] * (rowbytes * 8 - len(bits))       # 补到 32 位边界
        for i in range(0, len(bits), 8):
            byte = 0
            for b in bits[i:i + 8]:
                byte = (byte << 1) | b
            andm.append(byte)
    hdr = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0,
                      len(xor) + len(andm), 0, 0, 0, 0)
    return bytes(hdr) + bytes(xor) + bytes(andm)


def write_cur(path, img, hx, hy):
    data = dib_bmp(img)
    hdr = struct.pack("<HHH", 0, 2, 1)
    ent = struct.pack("<BBBBHHII", N, N, 0, 0, hx, hy, len(data), 6 + 16)
    with open(path, "wb") as f:
        f.write(hdr + ent + data)


def ico_bytes(img, hx=0, hy=0):
    """完整 ICO 容器（.ani 的 fram 块要求 ICO 格式，不是裸 DIB）

    hx,hy 是热点。.ani 的热点存在每帧 ICO 的目录项里 ——
    漏掉它默认就是 (0,0)，点击会落在光标左上角，等于不可用。
    """
    data = dib_bmp(img)
    hdr = struct.pack("<HHH", 0, 1, 1)
    ent = struct.pack("<BBBBHHII", N, N, 0, 0, hx, hy, len(data), 6 + 16)
    return hdr + ent + data


def write_ico(path, img):
    with open(path, "wb") as f:
        f.write(ico_bytes(img))


def write_ani(path, frames, rate=8, hx=0, hy=0):
    """frames: [PIL.Image]；rate: 每帧 jiffies (1/60s)，8 ≈ 133ms

    ANIHEADER 是 9 个 DWORD = 36 字节，最后一个是 flags（AF_ICON=1）。
    少打一个字段会让后续 chunk 的偏移全部错位 —— 文件"生成了"但读不出来。
    """
    icos = [ico_bytes(f, hx, hy) for f in frames]
    nf = len(icos)
    anih = struct.pack("<IIIIIIIII", 36, nf, nf, N, N, 32, 1, rate, 0x01)
    chunks = b"anih" + struct.pack("<I", len(anih)) + anih
    rt = struct.pack("<%di" % nf, *([rate] * nf))
    chunks += b"rate" + struct.pack("<I", len(rt)) + rt
    sq = struct.pack("<%di" % nf, *range(nf))
    # ⚠ RIFF 块 ID 必须正好 4 字节：动画序列块的规范名是 "seq "（带尾随空格），
    # 写成 "seq"（3 字节）会让后续所有 chunk 偏移错位，文件结构直接崩。
    chunks += b"seq " + struct.pack("<I", len(sq)) + sq
    fram = b""
    for ic in icos:
        fram += b"fram" + struct.pack("<I", len(ic)) + ic
    lst = b"LIST" + struct.pack("<I", 4 + len(fram)) + b"fram" + fram
    body = b"ACON" + chunks + lst
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", len(body)) + body)


# ────────────────────────── 组装 ──────────────────────────

SPEC = [
    # (文件名, 绘制fn, hotspot)
    ("Normal",   lambda im: draw_arrow(im),                      4, 2),
    ("Help",     lambda im: draw_help(im),                       4, 2),
    ("Text",     lambda im: draw_ibeam(im),                      16, 15),
    ("Link",      lambda im: draw_link(im),                      16, 16),
    ("Precision", lambda im: draw_precision(im),                 16, 16),
    ("SizeNS",   lambda im: draw_resize(im, 90),                 16, 16),
    ("SizeWE",   lambda im: draw_resize(im, 0),                  16, 16),
    ("SizeNWSE", lambda im: draw_resize(im, 45),                 16, 16),
    ("SizeNESW", lambda im: draw_resize(im, 135),                16, 16),
    ("Move",     lambda im: draw_move(im),                       16, 16),
    ("Unavailable", lambda im: draw_no(im),                      16, 16),
    ("Handwriting", lambda im: draw_pen(im),                      2, 29),
    ("Up",       lambda im: draw_uparrow(im),                    16, 3),
]

made = []
previews = []
for name, fn, hx, hy in SPEC:
    im = canvas()
    fn(im)
    im = finish(im)
    p = os.path.join(OUT, name + ".cur")
    write_cur(p, im, hx, hy)
    made.append((name, p))
    previews.append((name, im))

# 动画
BUSY_F = 12
frames = []
for i in range(BUSY_F):
    im = canvas()
    draw_busy_frame(im, i / BUSY_F)
    frames.append(finish(im))
write_ani(os.path.join(OUT, "Busy.ani"), frames, rate=7, hx=16, hy=16)
made.append(("Busy", os.path.join(OUT, "Busy.ani")))
previews.append(("Busy", frames[0]))

frames = []
for i in range(BUSY_F):
    im = canvas()
    draw_appstart_frame(im, i / BUSY_F)
    frames.append(finish(im))
write_ani(os.path.join(OUT, "Working.ani"), frames, rate=7, hx=4, hy=2)
made.append(("Working", os.path.join(OUT, "Working.ani")))
previews.append(("Working", frames[0]))

# ── 预览接触表 ──
cols = 5
rows = (len(previews) + cols - 1) // cols
CELL = 96
sheet = Image.new("RGBA", (cols * CELL, rows * CELL), (24, 24, 30, 255))
d = ImageDraw.Draw(sheet)
for i, (name, im) in enumerate(previews):
    cx, cy = (i % cols) * CELL, (i // cols) * CELL
    im = im.resize((56, 56), Image.LANCZOS)
    # 棋盘底衬出半透明
    for yy in range(56):
        for xx in range(56):
            if (xx // 7 + yy // 7) % 2 == 0:
                sheet.putpixel((cx + 20 + xx, cy + 12 + yy), (44, 44, 52, 255))
    sheet.alpha_composite(im, (cx + 20, cy + 12))
    d.text((cx + 10, cy + 72), name, fill=(230, 230, 240, 255))
sheet.convert("RGB").save(os.path.join(os.path.dirname(OUT), "preview.png"))
print("生成", len(made), "个光标 ->", OUT)
for n, p in made:
    print("  ", n, os.path.basename(p), os.path.getsize(p), "bytes")

# ── 主题文件（.theme 的 [Control Panel\Cursors] 段） ──
# 键名是 Windows 内部名，不是文件名；装错名字该角色就不会生效。
THEME_MAP = [
    ("Arrow",     "Normal.cur",      "正常选择"),
    ("Help",      "Help.cur",        "帮助选择"),
    ("AppStarting", "Working.ani",   "后台运行"),
    ("Wait",      "Busy.ani",        "忙"),
    ("NWPen",     "Handwriting.cur", "手写"),
    ("No",        "Unavailable.cur", "不可用"),
    ("SizeAll",   "Move.cur",        "移动"),
    ("SizeNESW",  "SizeNESW.cur",    "对角线调整 2"),
    ("SizeNS",    "SizeNS.cur",      "垂直调整"),
    ("SizeNWSE",  "SizeNWSE.cur",    "对角线调整 1"),
    ("SizeWE",    "SizeWE.cur",      "水平调整"),
    ("UpArrow",   "Up.cur",          "备用"),
    ("Crosshair", "Precision.cur",   "精确选择"),
    ("IBeam",     "Text.cur",        "文本选择"),
    ("Hand",      "Link.cur",        "链接选择"),
]
tp = os.path.join(os.path.dirname(OUT), "ZFSN.theme")
with open(tp, "w", encoding="ascii") as f:
    f.write("[Theme]\r\n")
    f.write("DisplayName=ZFSN Red Glow\r\n")
    f.write("\r\n[Control Panel\\Cursors]\r\n")
    for key, fn, _cn in THEME_MAP:
        f.write("%s=%%CURDIR%%\\%s\r\n" % (key, fn))
print("主题模板 ->", tp, "（%%CURDIR%% 由 install.bat 替换为实际路径）")
with open(os.path.join(os.path.dirname(OUT), "theme_map.txt"), "w", encoding="utf-8") as f:
    for key, fn, cn in THEME_MAP:
        f.write("%-12s %-16s %s\n" % (key, fn, cn))
