"""给「非立方体物品」补上正确的物品栏图标。

背景
────
`import_minecraft_catalog.py` 只为 cube 方块生成了 32×32 的等轴测图标（icons/ 390 张），
非 cube 的 942 个物品一律走 `textures/<id>.png`——而那个文件是脚本从物品模型里挑的
「第一张贴图」：

  * 盾牌的模型是 builtin/entity，只有 particle: block/dark_oak_planks
    → textures/shield.png 直接就是深色橡木木板（用户看到的「暗色木板」）
  * 楼梯/台阶/栅栏门的模型 parent 是 block/*（真·方块模型）
    → 拿到的是原木/木板原贴图，背包里就成了「一张平面贴图」
  * 80 个刷怪蛋的模型都是 item/template_spawn_egg（layer0 = 白色蛋胚）
    → 全部存成同一张白蛋（md5 全一样）

这个脚本只补「缺的/错的」，不碰 icons/ 里已经正确的 390 张立方体图标：
  1. 方块模型物品（楼梯/台阶/栅栏/栅栏门/按钮/压力板/活板门/墙…）→ 真·等轴测渲染
  2. 刷怪蛋 → 取该生物实体贴图的代表色，给蛋胚+斑点各染一次色
  3. builtin/entity 物品（床/旗帜/潜影盒/箱子/盾牌…）→ 直接用原版 entity 贴图

产物：minecraft/icons/*.png + minecraft/icons/index.js（同步可用的 id 清单，
前端靠它决定「这个物品有正确图标」，避免贴图加载完再换图造成的闪烁）。

用法：python tools/rebuild_minecraft_item_icons.py
需要：Pillow + 原版客户端 jar（与 import_minecraft_catalog.py 同一份）
"""
import io, json, math, tempfile, zipfile
from collections import Counter
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance

root = Path(__file__).resolve().parents[1] / 'minecraft'
jar = Path(tempfile.gettempdir()) / 'zfsn-minecraft-1.21.1.jar'
if not jar.exists():
    raise SystemExit(f'找不到客户端 jar：{jar}（先跑 import_minecraft_catalog.py）')

z = zipfile.ZipFile(jar)
files = set(z.namelist())
SIZE = 32

text = (root / 'catalog.js').read_text(encoding='utf-8')
catalog = json.loads(text[text.index('['): text.rindex(']') + 1])


# ── 模型解析 ───────────────────────────────────────────────
def model(name, seen=None):
    """解析模型链，返回 (textures, parents)。"""
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


def elements_of(item_id):
    """沿 parent 链往上走，取第一个带 elements 的模型 + 整条链合并出的贴图表。

    ★ 关键是「元素」和「贴图」常常不在同一层：楼梯的 elements 在模板
      block/stairs 上，而 #top/#side/#bottom 这些贴图名写在 block/oak_stairs 上。
      只在找到 elements 的那一层解析贴图，会拿到空表 → 三个面全画不出来。
      所以先把整条链记下来，再按「父 → 子」顺序合并（子的贴图覆盖父的）。
    """
    name = 'item/' + item_id
    seen, chain = set(), []
    for _ in range(12):
        name = name.replace('minecraft:', '')
        if name in seen:
            break
        seen.add(name)
        path = 'assets/minecraft/models/' + name + '.json'
        if path not in files:
            break
        m = json.loads(z.read(path))
        chain.append(m)
        if 'elements' in m:
            tex = {}
            for node in reversed(chain):       # 父在前，子覆盖父
                tex.update(node.get('textures') or {})
            return m['elements'], tex
        if 'parent' not in m:
            break
        name = m['parent']
    return None, None


def load_texture(ref):
    """#key / minecraft:xxx → 16×16（或原始尺寸）RGBA。"""
    if not ref:
        return None
    ref = ref.replace('minecraft:', '')
    path = 'assets/minecraft/textures/' + ref + '.png'
    if path not in files:
        return None
    return Image.open(io.BytesIO(z.read(path))).convert('RGBA')


def resolve(tex, ref):
    for _ in range(10):
        if ref and ref.startswith('#'):
            ref = tex.get(ref[1:])
        else:
            break
    return ref


# ── 等轴测投影（与 icons/ 里已有立方体图标同一套几何）────────────
#   px = 16 + 0.875*(x - z)
#   py = 1  + 0.4375*(x + z) + (16 - y)
# 验证：整立方体顶面四角 = (16,1) (30,8) (16,15) (2,8)，与 cube_icon 的 quad 完全一致。
def project(x, y, zz):
    return (16 + 0.875 * (x - zz), 1 + 0.4375 * (x + zz) + (16 - y))


# 只有 up / south(z+) / east(x+) 三面朝向镜头；north/west/down 永远看不到。
FACE_CORNERS = {
    # face: (四个角，顺序 = 贴图 (0,0) (1,0) (1,1) (0,1))
    'up':    lambda f, t: ((f[0], t[1], f[2]), (t[0], t[1], f[2]), (t[0], t[1], t[2]), (f[0], t[1], t[2])),
    'south': lambda f, t: ((f[0], t[1], t[2]), (t[0], t[1], t[2]), (t[0], f[1], t[2]), (f[0], f[1], t[2])),
    'east':  lambda f, t: ((t[0], t[1], t[2]), (t[0], t[1], f[2]), (t[0], f[1], f[2]), (t[0], f[1], t[2])),
}
SHADE = {'up': 1.0, 'south': 0.8, 'east': 0.6}


def rotate_point(p, origin, axis, angle):
    """元素级旋转（原版只允许 ±22.5 / ±45）。"""
    a = math.radians(angle)
    cos, sin = math.cos(a), math.sin(a)
    x, y, zz = [v - o for v, o in zip(p, origin)]
    if axis == 'x':
        y, zz = y * cos - zz * sin, y * sin + zz * cos
    elif axis == 'y':
        x, zz = x * cos + zz * sin, -x * sin + zz * cos
    elif axis == 'z':
        x, y = x * cos - y * sin, x * sin + y * cos
    return (x + origin[0], y + origin[1], zz + origin[2])


def draw_quad(out, corners, image, uv, shade, uv_rot=0):
    """把一张贴图的 uv 子矩形仿射贴到投影后的平行四边形上。"""
    a2, b2, d2 = corners[0], corners[1], corners[3]
    w, h = image.width, image.height
    # uv 是 0..16 的模型坐标，换算到贴图像素
    sx0, sy0, sx1, sy1 = [v / 16 * (w if i % 2 == 0 else h) for i, v in enumerate(uv)]
    sx0, sx1 = sorted((sx0, sx1))
    sy0, sy1 = sorted((sy0, sy1))
    box = (int(round(sx0)), int(round(sy0)), max(int(round(sx1)), int(round(sx0)) + 1),
           max(int(round(sy1)), int(round(sy0)) + 1))
    crop = image.crop(box)
    if uv_rot:
        crop = crop.rotate(-uv_rot, expand=True)
    cw, ch = crop.size
    if cw < 1 or ch < 1:
        return
    ax, ay = a2
    ux, uy = (b2[0] - ax) / cw, (b2[1] - ay) / cw
    vx, vy = (d2[0] - ax) / ch, (d2[1] - ay) / ch
    det = ux * vy - uy * vx
    if abs(det) < 1e-9:
        return
    # Pillow AFFINE 是「目标像素 → 源像素」的逆变换
    coeff = (vy / det, -vx / det, (-vy * ax + vx * ay) / det,
             -uy / det, ux / det, (uy * ax - ux * ay) / det)
    layer = crop.transform((SIZE, SIZE), Image.Transform.AFFINE, coeff, Image.Resampling.NEAREST)
    if shade != 1.0:
        layer = ImageEnhance.Brightness(layer).enhance(shade)
    mask = Image.new('L', (SIZE, SIZE))
    ImageDraw.Draw(mask).polygon([a2, b2, corners[2], d2], fill=255)
    layer.putalpha(Image.composite(layer.getchannel('A'), Image.new('L', (SIZE, SIZE)), mask))
    out.alpha_composite(layer)


def render_block_model(item_id):
    """把方块模型渲成 32×32 等轴测图标。"""
    elements, tex = elements_of(item_id)
    if not elements:
        return None
    out = Image.new('RGBA', (SIZE, SIZE))
    quads = []
    for el in elements:
        frm, to = el.get('from'), el.get('to')
        if not frm or not to:
            continue
        rot = el.get('rotation') or {}
        origin = rot.get('origin', [8, 8, 8])
        axis = rot.get('axis', 'y')
        angle = rot.get('angle', 0)
        faces = el.get('faces', {})

        def pt(p):
            return rotate_point(p, origin, axis, angle) if angle else p

        for face in ('up', 'south', 'east'):
            f = faces.get(face)
            if not f:
                continue
            ref = resolve(tex, f.get('texture'))
            img = load_texture(ref)
            if img is None:
                continue
            uv = f.get('uv') or [0, 0, 16, 16]
            corners3 = [pt(c) for c in FACE_CORNERS[face](frm, to)]
            # 画家算法：离镜头越远越先画（相机在 +x/+y/+z）
            depth = sum(sum(c) for c in corners3) / 4
            quads.append((depth, [project(*c) for c in corners3], img, uv, SHADE[face], f.get('rotation', 0)))
    if not quads:
        return None
    quads.sort(key=lambda q: q[0])
    for _, corners, img, uv, shade, uv_rot in quads:
        draw_quad(out, corners, img, uv, shade, uv_rot)
    return out if out.getbbox() else None


# ── 刷怪蛋：取生物实体贴图的代表色 ───────────────────────────
def mob_texture(mob):
    for cand in (f'assets/minecraft/textures/entity/{mob}/{mob}.png',
                 f'assets/minecraft/textures/entity/{mob}.png'):
        if cand in files:
            return cand
    hits = [n for n in sorted(files)
            if n.startswith('assets/minecraft/textures/entity/') and n.endswith(f'/{mob}.png')]
    return hits[0] if hits else None


def dominant_color(path):
    """取不透明像素里最常见、且有色相的颜色（避开纯黑描边/纯白高光）。"""
    img = Image.open(io.BytesIO(z.read(path))).convert('RGBA')
    img.thumbnail((64, 64))
    cnt = Counter()
    for r, g, b, a in img.getdata():
        if a < 128:
            continue
        mx, mn = max(r, g, b), min(r, g, b)
        if mx < 40 or mn > 225:          # 太黑（描边）或太白（高光）
            continue
        cnt[(r // 12 * 12, g // 12 * 12, b // 12 * 12)] += 1
    if not cnt:
        return (150, 150, 150)
    return cnt.most_common(1)[0][0]


def boost(rgb, sat=1.35, val=1.0):
    """提一点饱和度，让蛋的颜色更接近原版观感。"""
    r, g, b = [v / 255 for v in rgb]
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if mx == mn:
        return rgb
    d = mx - mn
    s = 0 if l > .5 else d / (mx + mn)
    if l > .5:
        s = d / (2 - mx - mn)
    s = min(1.0, s * sat)
    q = l * (1 + s) if l < .5 else l + s - l * s
    p = 2 * l - q
    h = 0.0
    if mx == r:
        h = (g - b) / d + (6 if g < b else 0)
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    h /= 6

    def hue2rgb(p, q, t):
        t %= 1
        if t < 1 / 6:
            return p + (q - p) * 6 * t
        if t < 1 / 2:
            return q
        if t < 2 / 3:
            return p + (q - p) * (2 / 3 - t) * 6
        return p

    return tuple(min(255, int(round(v * 255 * val)))
                 for v in (hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)))


def _multiply(img, color):
    """multiply 染色 + 保留原 alpha（与原版 layer 染色一致）。"""
    r, g, b = img.split()[:3]
    a = img.getchannel('A')
    r = r.point(lambda v, k=color[0]: v * k // 255)
    g = g.point(lambda v, k=color[1]: v * k // 255)
    b = b.point(lambda v, k=color[2]: v * k // 255)
    return Image.merge('RGBA', (r, g, b, a))


def render_spawn_egg(mob):
    base = load_texture('item/spawn_egg')
    overlay = load_texture('item/spawn_egg_overlay')
    if base is None:
        return None
    path = mob_texture(mob)
    color = boost(dominant_color(path)) if path else (150, 150, 150)
    spot = tuple(min(255, int(v * 1.45)) if max(color) < 120 else max(0, int(v * .55)) for v in color)
    out = _multiply(base, color)
    if overlay is not None:
        out.alpha_composite(_multiply(overlay, spot))
    return out.resize((SIZE, SIZE), Image.Resampling.NEAREST)


# ── builtin/entity 物品 ───────────────────────────────────
DYE = {
    'white': (234, 234, 234), 'orange': (240, 118, 19), 'magenta': (189, 68, 179),
    'light_blue': (58, 175, 217), 'yellow': (248, 197, 39), 'lime': (127, 204, 25),
    'pink': (242, 127, 165), 'gray': (71, 79, 82), 'light_gray': (157, 157, 151),
    'cyan': (21, 137, 145), 'purple': (138, 50, 184), 'blue': (53, 57, 157),
    'brown': (114, 71, 40), 'green': (84, 109, 27), 'red': (161, 33, 33), 'black': (25, 22, 22),
}


def render_shield():
    """盾牌是 builtin/entity：模型只有 particle 贴图（深色橡木木板），
    旧版直接把那张木板当图标 —— 背包里就是「一块棕色木板」，和原版完全不像。

    原版 entity/shield_base_nopattern.png（64×64）里，(0,0)-(13,22) 这一块
    正是盾牌正面：中间 10×20 是木板，四周 2px 是铁的包边（实测 #A3A4AA 亮面、
    #91939B 侧面、#6E7077 底/暗面）。这里把这整块「正面（含包边）」按盾形
    轮廓逐像素最近邻采样到 32×32，颜色/纹理/包边全部来自官方贴图，
    不再自绘白点或横纹。"""
    base = load_texture('entity/shield_base_nopattern')
    if base is None:
        return None
    plate = base.crop((0, 0, 14, 23))          # 正面：木板 + 铁包边
    w, h = plate.size

    # 盾形：平顶 + 上角略收 + 两侧直下 + 收成圆尖底（和原版物品图标一致）
    poly = [(8, 3), (23, 3), (24, 5), (24, 12), (23, 16), (21, 20),
            (18, 24), (16, 29), (14, 24), (11, 20), (9, 16), (8, 12), (8, 5)]
    mask = Image.new('L', (SIZE, SIZE))
    ImageDraw.Draw(mask).polygon(poly, fill=255)

    out = Image.new('RGBA', (SIZE, SIZE))
    px = out.load()
    src = plate.load()
    # 外接矩形取 17×27，和贴图 14×23 的比例（0.61 / 0.63）几乎一致 →
    # 木板和包边只等比放大 1.2 倍，不会一边被拉宽、边框挤进木面里。
    x0, y0, x1, y1 = 8, 3, 25, 30
    for y in range(y0, y1):
        for x in range(x0, x1):
            if mask.getpixel((x, y)) == 0:
                continue
            # 把盾形内部归一化到官方正面贴图 (0..13, 0..22)
            u = min(w - 1, max(0, int((x - x0) / (x1 - x0) * w)))
            v = min(h - 1, max(0, int((y - y0) / (y1 - y0) * h)))
            px[x, y] = src[u, v]
    return out


# 生物头颅：标准 64×32/64×64 皮肤里，头部正面在 (8,8)-(16,16)
HEAD_SKINS = {
    'creeper_head': 'entity/creeper/creeper',
    'zombie_head': 'entity/zombie/zombie',
    'skeleton_skull': 'entity/skeleton/skeleton',
    'wither_skeleton_skull': 'entity/skeleton/wither_skeleton',
    'piglin_head': 'entity/piglin/piglin',
    'player_head': 'entity/player/wide/steve',
}


def render_head(item_id):
    ref = HEAD_SKINS.get(item_id)
    if not ref:
        return None
    img = load_texture(ref)
    if img is None:
        return None
    w, h = img.size
    scale = w / 64
    box = tuple(int(v * scale) for v in (8, 8, 16, 16))
    if box[2] > w or box[3] > h:
        return None
    head = img.crop(box)
    return head.resize((SIZE, SIZE), Image.Resampling.NEAREST)


def render_entity_item(item_id):
    """床/旗帜/潜影盒/箱子/盾牌/头颅 → 直接用原版 entity 贴图。"""
    if item_id == 'shield':
        return render_shield()
    if item_id in HEAD_SKINS:
        return render_head(item_id)
    if item_id == 'shulker_box':
        img = load_texture('entity/shulker/shulker')
        return img.resize((SIZE, SIZE), Image.Resampling.NEAREST) if img else None

    for suffix, pat in (('_bed', 'entity/bed/{}'), ('_shulker_box', 'entity/shulker/shulker_{}')):
        if item_id.endswith(suffix):
            color = item_id[:-len(suffix)]
            img = load_texture(pat.format(color))
            return img.resize((SIZE, SIZE), Image.Resampling.NEAREST) if img else None

    if item_id.endswith('_banner'):
        color = item_id[:-len('_banner')]
        base, border = load_texture('entity/banner/base'), load_texture('entity/banner/border')
        if base is None:
            return None
        out = _multiply(base.convert('RGBA'), DYE.get(color, (234, 234, 234)))
        if border is not None:
            out.alpha_composite(border.convert('RGBA'))
        return out.resize((SIZE, SIZE), Image.Resampling.NEAREST)

    chest = {'chest': 'entity/chest/normal', 'trapped_chest': 'entity/chest/trapped',
             'ender_chest': 'entity/chest/ender'}
    if item_id in chest:
        img = load_texture(chest[item_id])
        return img.resize((SIZE, SIZE), Image.Resampling.NEAREST) if img else None
    return None


# ── 主流程 ───────────────────────────────────────────────
(root / 'icons').mkdir(exist_ok=True)
made, skipped, failed = [], [], []

for entry in catalog:
    item_id = entry['id']
    if entry.get('cube'):
        continue                      # 立方体图标已经是正确的，不动
    if item_id.endswith('_spawn_egg'):
        img = render_spawn_egg(item_id[:-len('_spawn_egg')])
        if img is None:
            failed.append((item_id, '蛋胚缺失'))
            continue
        img.save(root / 'icons' / f'{item_id}.png')
        made.append(item_id)
        continue

    tex, parents = model('item/' + item_id)
    if any(p.startswith('block/') for p in parents):
        img = render_block_model(item_id)
        if img is None:
            failed.append((item_id, '方块模型无可用面'))
            continue
        img.save(root / 'icons' / f'{item_id}.png')
        made.append(item_id)
        continue

    img = render_entity_item(item_id)
    if img is not None:
        img.save(root / 'icons' / f'{item_id}.png')
        made.append(item_id)
    elif 'layer0' in tex or 'layer1' in tex:
        skipped.append(item_id)       # 平面图标本来就是对的，继续用 textures/
    else:
        failed.append((item_id, '无 entity 贴图'))

print(f'新生成图标 {len(made)} 个（其中方块模型/蛋/entity 各见下）')
print(f'沿用 textures/ 平面图标 {len(skipped)} 个')
print(f'失败 {len(failed)} 个：')
for item_id, why in failed[:30]:
    print(f'  {item_id}：{why}')

# 同步清单：前端靠它在模块加载时就知道「谁有正确图标」，不再等贴图加载才换图
ids = sorted(p.stem for p in (root / 'icons').glob('*.png'))
(root / 'icons' / 'index.js').write_text(
    '/* 由 tools/rebuild_minecraft_item_icons.py 生成：icons/ 下真正存在的物品图标 id。\n'
    '   前端同步 import 它，避免「先用占位图、贴图到货后再换图」造成的闪烁。 */\n'
    'export const ICON_IDS = new Set(' + json.dumps(ids) + ');\n', encoding='utf-8')
print(f'\nicons/ 现有图标 {len(ids)} 个，已写入 icons/index.js')
