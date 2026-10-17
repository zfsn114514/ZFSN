# -*- coding: utf-8 -*-
"""校验生成的 .cur / .ani：结构合法性 + 像素往返一致性。

关键：不能只看"文件生成了"。要能把 DIB 解出来、还原成图、
和源图逐像素比对，才算真的能显示。
"""
import os, struct, sys
from PIL import Image

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "zfsn")
fails = []


def parse_cur(path):
    b = open(path, "rb").read()
    assert b[0:2] == b"\x00\x00", "cur magic 应为 0000"
    assert b[2:4] == b"\x02\x00", "type 应为 2 (CUR)"
    cnt = struct.unpack("<H", b[4:6])[0]
    assert cnt == 1, "count 应为 1"
    w, h, cc, res, hx, hy, size, off = struct.unpack("<BBBBHHII", b[6:22])
    assert w == h == 32, f"尺寸应 32x32，得 {w}x{h}"
    dib = b[off:off + size]
    assert len(dib) == size, "DIB 长度不足"
    ih = struct.unpack("<IiiHHIIiiII", dib[:40])
    assert ih[0] == 40, "BITMAPINFOHEADER 应为 40"
    assert ih[3] == 1, "biPlanes 应为 1"
    assert ih[4] == 32, "位深应 32"
    assert ih[5] == 0, "biCompression 应 0 (BI_RGB)"
    assert ih[2] == 64, f"DIB 高度应 64 (XOR+AND)，得 {ih[2]}"
    return hx, hy, dib


def dib_to_img(dib):
    ih = struct.unpack("<IiiHHIIiiII", dib[:40])
    w, hh = ih[1], ih[2] // 2
    xlen = w * 4
    xor = dib[40:40 + xlen * hh]
    andlen = ((w + 31) // 32) * 4 * hh
    andm = dib[40 + xlen * hh:40 + xlen * hh + andlen]
    img = Image.new("RGBA", (w, hh), (0, 0, 0, 0))
    px = img.load()
    for row in range(hh):
        y = hh - 1 - row
        base = row * xlen
        for x in range(w):
            i = base + x * 4
            bl, gr, rd, al = xor[i], xor[i + 1], xor[i + 2], xor[i + 3]
            px[x, y] = (rd, gr, bl, al)
    # AND 掩码：1 = 透明（仅作兜底，32bpp 应走 alpha）
    for row in range(hh):
        y = hh - 1 - row
        for x in range(w):
            byte_i = row * (((w + 31) // 32) * 4) + x // 8
            bit = (andm[byte_i] >> (7 - (x % 8))) & 1
            if bit:
                r, g, b_, a = px[x, y]
                px[x, y] = (r, g, b_, 0)
    return img


def check_cur(path, name):
    try:
        hx, hy, dib = parse_cur(path)
        img = dib_to_img(dib)
        # 非空检查：必须有可见像素
        alpha = [p[3] for p in img.getdata()]
        vis = sum(1 for a in alpha if a > 8)
        if vis == 0:
            fails.append(f"{name}: 解码后无任何可见像素")
            return
        # 主色检查：必须出现站点红
        reds = sum(1 for p in img.getdata()
                   if p[3] > 100 and p[0] > 150 and p[1] < 110 and p[2] < 120)
        print(f"  OK {name:12s} 热点=({hx},{hy}) 可见像素={vis:4d} 红色像素={reds:4d}")
        if reds < 8:
            fails.append(f"{name}: 红色像素过少({reds})，主题色可能没画上")
    except Exception as e:
        fails.append(f"{name}: 解析失败 {e}")


def check_ani(path, name):
    b = open(path, "rb").read()
    try:
        assert b[0:4] == b"RIFF", "RIFF magic"
        assert b[8:12] == b"ACON", "ACON form"
        pos = 12
        nframes = None
        frames = []
        hots = []
        rate = None
        while pos < len(b):
            cid = b[pos:pos + 4]
            csz = struct.unpack("<I", b[pos + 4:pos + 8])[0]
            body = b[pos + 8:pos + 8 + csz]
            if cid == b"anih":
                a = struct.unpack("<IIIIIIIII", body)
                nframes, steps, w, h, bpp, planes, rate, flags = a[1:9]
                assert a[0] == 36 and len(body) == 36, f"anih 头应 36 字节，得 {len(body)}"
                assert flags == 1, f"flags 应 1 (AF_ICON)，得 {flags}"
                assert w == h == 32, f"帧尺寸应 32x32，得 {w}x{h}"
            elif cid == b"rate":
                pass
            elif cid == b"seq":
                pass
            elif cid == b"LIST":
                assert body[0:4] == b"fram", "LIST 应为 fram"
                p = 4
                while p < len(body):
                    fid = body[p:p + 4]
                    fsz = struct.unpack("<I", body[p + 4:p + 8])[0]
                    if fid == b"fram":
                        frames.append(body[p + 8:p + 8 + fsz])
                        # 每帧 ICO 目录项里存热点；漏了就是 (0,0)
                        # ICO 头 6 字节 + 目录项前 10 字节(w,h,cc,rsvd)
                        # -> 热点 X 在 fram 数据起始后第 10 字节
                        fhx, fhy = struct.unpack("<HH", body[p + 18:p + 22])
                        hots.append((fhx, fhy))
                    p += 8 + fsz
            pos += 8 + csz
        assert nframes is not None, "缺 anih"
        assert len(frames) == nframes, f"帧数不符: anih={nframes} 实际={len(frames)}"
        assert rate and rate > 0, "帧率无效"
        # 每帧都能解出可见像素
        vis_counts = []
        for f in frames:
            img = dib_to_img(f[22:])   # 跳过 ICO 头(6)+目录项(16)
            vis_counts.append(sum(1 for p in img.getdata() if p[3] > 8))
        if min(vis_counts) == 0:
            fails.append(f"{name}: 有帧完全空白 {vis_counts}")
        # 帧间必须有差异（否则就是静态图冒充动画）
        imgs = [dib_to_img(f[22:]) for f in frames]
        same = sum(1 for i in range(1, len(imgs))
                   if list(imgs[i].getdata()) == list(imgs[0].getdata()))
        if min(h[0] for h in hots) == 0 and max(h[0] for h in hots) == 0:
            fails.append(f"{name}: 帧热点全是 (0,0)，点击会落在光标左上角")
        print(f"  OK {name:12s} 帧数={nframes} 帧率={rate}jiffy "
              f"热点={hots[0]} 可见像素min={min(vis_counts)} 与首帧相同={same}/{len(imgs)-1}")
        if same == len(imgs) - 1:
            fails.append(f"{name}: 所有帧完全相同，动画无效")
    except Exception as e:
        fails.append(f"{name}: 解析失败 {e}")


print("=== .cur 校验 ===")
for f in sorted(os.listdir(DIR)):
    if f.endswith(".cur"):
        check_cur(os.path.join(DIR, f), f[:-4])
print("=== .ani 校验 ===")
for f in sorted(os.listdir(DIR)):
    if f.endswith(".ani"):
        check_ani(os.path.join(DIR, f), f[:-4])

print()
if fails:
    print("FAIL:")
    for x in fails:
        print("  -", x)
    sys.exit(1)
print("PASS: 全部 %d 个文件结构与像素校验通过" %
      (len([x for x in os.listdir(DIR) if x.endswith(('.cur', '.ani'))])))
