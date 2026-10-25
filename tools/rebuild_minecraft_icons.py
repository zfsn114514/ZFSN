"""只重建「空图标」，不重跑整个目录导入。

背景：`import_minecraft_catalog.py` 的 cube_icon() 原来只认 top/side/front 这组面 key，
而原版 block/cube 模型用的是 up/down/north/south/east/west，带釉陶瓦更是只有 pattern。
找不到贴图时三个面全被跳过，最后存下一张 32×32 全透明图（83 字节）——
图标「加载成功」（naturalWidth 正常），前端任何 onerror 兜底都救不了，
表现就是创造栏里 20 个方块是空白格子（工作台、制图台、制箭台、锻造台、16 色带釉陶瓦）。

这个脚本只做一件事：把当前为空（bbox 为 None）的 icons/*.png 用修正后的面 key 重画一遍。
已有的正常图标不动。

用法：python tools/rebuild_minecraft_icons.py
需要：Pillow + 原版客户端 jar（与 import_minecraft_catalog.py 同一份）
"""
import io, json, os, tempfile, zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance

root = Path(__file__).resolve().parents[1] / 'minecraft'
jar = Path(tempfile.gettempdir()) / 'zfsn-minecraft-1.21.1.jar'
if not jar.exists():
    raise SystemExit(f'找不到客户端 jar：{jar}（先跑 import_minecraft_catalog.py）')

z = zipfile.ZipFile(jar)
files = set(z.namelist())

# 从 catalog.js 里拿 cube 方块名单，不重新下载语言文件
text = (root / 'catalog.js').read_text(encoding='utf-8')
catalog = json.loads(text[text.index('['): text.rindex(']') + 1])
cube_ids = [e['id'] for e in catalog if e.get('cube')]


def model(name, seen=None):
    seen = set() if seen is None else seen
    name = name.replace('minecraft:', '')
    if name in seen:
        return {}, []
    seen.add(name)
    path = 'assets/minecraft/models/' + name + '.json'
    if path not in files:
        return {}, [name]
    m = json.loads(z.read(path))
    tex, parents = model(m['parent'], seen) if 'parent' in m else ({}, [])
    tex.update(m.get('textures', {}))
    return tex, [name] + parents


def cube_icon(item_id, tex):
    def texture(keys):
        v = next((tex[k] for k in keys if k in tex), None)
        for _ in range(10):
            if v and v.startswith('#'):
                v = tex.get(v[1:])
        if not v:
            return None
        try:
            raw = z.read('assets/minecraft/textures/' + v.replace('minecraft:', '') + '.png')
            return Image.open(io.BytesIO(raw)).convert('RGBA').crop((0, 0, 16, 16))
        except KeyError:
            return None

    out = Image.new('RGBA', (32, 32))
    for keys, quad, shade in [
        (['top', 'up', 'end', 'all', 'pattern'], [(16, 1), (30, 8), (16, 15), (2, 8)], 1),
        (['side', 'south', 'front', 'all', 'down', 'pattern'], [(2, 8), (16, 15), (16, 31), (2, 24)], .72),
        (['front', 'north', 'side', 'all', 'east', 'pattern'], [(16, 15), (30, 8), (30, 24), (16, 31)], .88),
    ]:
        im = texture(keys)
        if im is None:
            continue
        im = ImageEnhance.Brightness(im).enhance(shade)
        p0, p1, _, p3 = quad
        a = (p1[0] - p0[0]) / 16
        b = (p3[0] - p0[0]) / 16
        c = (p1[1] - p0[1]) / 16
        d = (p3[1] - p0[1]) / 16
        det = a * d - b * c
        coeff = (d / det, -b / det, (-d * p0[0] + b * p0[1]) / det,
                 -c / det, a / det, (c * p0[0] - a * p0[1]) / det)
        layer = im.transform((32, 32), Image.Transform.AFFINE, coeff, Image.Resampling.NEAREST)
        mask = Image.new('L', (32, 32))
        ImageDraw.Draw(mask).polygon(quad, fill=255)
        layer.putalpha(Image.composite(layer.getchannel('A'), Image.new('L', (32, 32)), mask))
        out.alpha_composite(layer)
    if out.getbbox() is None:
        src = texture(['all', 'side', 'top', 'up', 'front', 'north', 'end', 'pattern', 'particle'])
        if src is None:
            return None
        out = src.resize((32, 32), Image.Resampling.NEAREST)
    return out


empties = []
for p in sorted((root / 'icons').glob('*.png')):
    try:
        if Image.open(p).convert('RGBA').getbbox() is None:
            empties.append(p.stem)
    except Exception:
        empties.append(p.stem)

print(f'空图标 {len(empties)} 个：{empties}')

fixed, failed = [], []
for item_id in empties:
    tex, _ = model('item/' + item_id)
    if not tex:
        failed.append((item_id, '模型链里没有纹理'))
        continue
    img = cube_icon(item_id, tex)
    if img is None:
        failed.append((item_id, '找不到任何可用贴图'))
        continue
    img.save(root / 'icons' / f'{item_id}.png')
    fixed.append(item_id)

print(f'已重画 {len(fixed)} 个')
for item_id, why in failed:
    print(f'  失败 {item_id}：{why}')

# 复查：不许留空图
still = [p.stem for p in sorted((root / 'icons').glob('*.png'))
         if Image.open(p).convert('RGBA').getbbox() is None]
print('复查后仍为空：', still if still else '无')
