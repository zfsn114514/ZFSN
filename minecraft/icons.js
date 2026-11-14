/* ── 方块图标：等轴测立方体 ────────────────────────────────────────
 *
 * 物品栏/快捷栏/掉落物/手持物里的方块，原版画的是一个「等轴测立方体」：
 * 顶面 + 左面（南）+ 右面（东），三面亮度依次递减。以前这里只贴了一张
 * 单面贴图（grass_block_side 就是一块土），所以草方块在背包里看不出是
 * 个方块，也没有顶面的绿草。
 *
 * 做法（与提示词给的原版数学一致，T = 贴图边长 = 16）：
 *   顶面  setTransform(W/2/T,  W/4/T, -W/2/T, W/4/T, W/2, 0)
 *   左面  setTransform(W/2/T,  W/4/T,  0,      W/2/T, 0,   W/4)
 *   右面  setTransform(W/2/T, -W/4/T,  0,      W/2/T, W/2, W/2)
 * 每个面画完用半透明黑压暗：顶面 0、左面 20%、右面 40%。
 * 面之间按 0.5px 外扩，避免缩放后出现发丝缝。
 *
 * ★ 每张图标按物品 id 缓存，只生成一次。
 * ★ 这个模块不 import 游戏本体，只接受外部传进来的贴图查询函数，
 *   所以在 node 里 import 也不会炸（有测试覆盖 face 声明与几何）。
 */

import { ICON_SHADE_LEFT, ICON_SHADE_RIGHT, ICON_FACE_OVERLAP, ICON_TEXTURE_SIZE as T } from './config.js';

/* ── 各面贴图声明 ─────────────────────────────────────────────
 * top/bottom/left/right 是贴图名（textures/ 下的文件名，不含 .png）。
 * overlay：叠在同一面上的第二层（草方块侧面的草边），可带 tint 群系染色。
 * 没写的面在 resolveFaces() 里按下面的通用规则推。
 */
export const BLOCK_FACES = {
  // ── 需求里点名的多面方块 ──
  grass_block_side: {
    top: 'grass_block_top', bottom: 'dirt', left: 'grass_block_side', right: 'grass_block_side',
    /* 叠加层：侧面顶部那条草边，带群系染色（原版就是灰度高光，靠染色出绿）。
       顶面 grass_block_top 不在资源包里，由 game.js 的 synthFace() 合成，
       合成时已经取了草方块侧面里的真实草色，所以不再叠 tint（否则会二次压暗）。 */
    overlay: { left: 'grass_block_side_overlay', right: 'grass_block_side_overlay', tint: '#91bd59' },
  },
  dirt: { all: 'dirt' },
  stone: { all: 'stone' },
  cobblestone: { all: 'cobblestone' },
  smooth_stone: { all: 'smooth_stone' },
  oak_log: { top: 'oak_log_top', bottom: 'oak_log_top', left: 'oak_log', right: 'oak_log' },
  oak_planks: { all: 'oak_planks' },
  crafting_table_front: {
    top: 'crafting_table_top', bottom: 'oak_planks',
    left: 'crafting_table_side', right: 'crafting_table_side',
  },
  furnace_front: {
    top: 'furnace_top', bottom: 'furnace_top',
    left: 'furnace_side', right: 'furnace_side',
  },
  sandstone: { top: 'sandstone_top', bottom: 'sandstone_bottom', left: 'sandstone', right: 'sandstone' },
  tnt: { top: 'tnt_top', bottom: 'tnt_bottom', left: 'tnt_side', right: 'tnt_side' },
  bookshelf: { top: 'oak_planks', bottom: 'oak_planks', left: 'bookshelf', right: 'bookshelf' },
  glass: { all: 'glass' },
  stone_bricks: { all: 'stone_bricks' },
  white_wool: { all: 'white_wool' },
  iron_block: { all: 'iron_block' },
  diamond_block: { all: 'diamond_block' },
  coal_block: { all: 'coal_block' },
  sand: { all: 'sand' },
  coal_ore: { all: 'coal_ore' },
  iron_ore: { all: 'iron_ore' },
  diamond_ore: { all: 'diamond_ore' },
  oak_leaves: { all: 'oak_leaves', tint: { all: '#6caa3c' } },
};

/* 平面图标：这些方块在原版里也不是整块立方体，先用平面 item 贴图。
 * ★ 必须按「词尾」匹配（结尾 $）：早先写成 `(^|_)(grass|...)` 没有结尾锚点，
 *   `grass_block_side` 因为以 "grass" 开头就整块被判成平面，
 *   于是草方块在背包里退化成一张 16×16 的土 —— 三面图标全被跳过。 */
const FLAT_WORDS = [
  'torch', 'flower', 'sapling', 'mushroom', 'door', 'bed', 'fence', 'gate', 'rail',
  'sign', 'banner', 'carpet', 'lantern', 'button', 'lever', 'pressure_plate', 'pane',
  'bars', 'chain', 'ladder', 'scaffolding', 'conduit', 'head', 'skull', 'pot', 'boat',
  'minecart', 'cake', 'candle', 'web', 'cobweb', 'fern', 'grass', 'kelp', 'seagrass', 'vine',
  'lily_pad', 'bush', 'roots', 'sprouts', 'azalea', 'sugar_cane', 'cocoa', 'coral_fan',
  'bamboo', 'wheat', 'carrots', 'potatoes', 'beetroots', 'melon_stem', 'pumpkin_stem',
  // 单株花草：原版 id 不以 flower 结尾
  'dandelion', 'poppy', 'orchid', 'allium', 'bluet', 'tulip', 'daisy', 'cornflower',
  'valley', 'rose', 'sunflower', 'lilac', 'peony', 'torchflower',
];
const FLAT_RE = new RegExp(`(^|_)(${FLAT_WORDS.join('|')})$|_wall$`);
const ALWAYS_FLAT = new Set(['air', 'water_still', 'torch', 'lava_still', 'fire', 'bubble_column']);

/** cube / slab / flat */
export function iconKind(id) {
  if (!id) return 'flat';
  if (ALWAYS_FLAT.has(id)) return 'flat';
  if (/_slab$/.test(id)) return 'slab';
  if (FLAT_RE.test(id)) return 'flat';
  return 'cube';
}

const exists = (name, has) => !!name && (!has || has(name));

/**
 * 补齐一个方块的三面贴图。has(name) 用来判断贴图是否真的存在，
 * 不存在就按规则退化（_side → _top、_front → _side/_top、最后退成同一张）。
 */
export function resolveFaces(id, has = null) {
  const explicit = BLOCK_FACES[id];
  const pick = (...names) => names.find(n => exists(n, has)) || names[names.length - 1];
  let f;
  if (explicit?.all) {
    const t = explicit.all;
    f = { top: t, bottom: t, left: t, right: t, overlay: explicit.overlay || null, tint: explicit.tint || null };
  } else if (explicit) {
    f = {
      top: pick(explicit.top, explicit.all, id),
      bottom: pick(explicit.bottom, explicit.top, explicit.all, id),
      left: pick(explicit.left, explicit.side, explicit.all, id),
      right: pick(explicit.right, explicit.side, explicit.left, explicit.all, id),
      overlay: explicit.overlay || null,
      tint: explicit.tint || null,
    };
  } else {
    // 通用规则：原版贴图命名很规整，照着推就能得到正确的三个面
    const top = id.replace(/_(side|front|back|top|bottom)$/, '_top');
    const side = id.replace(/_(front|back|top|bottom)$/, '_side');
    f = {
      top: pick(top, id),
      bottom: pick(id.replace(/_(side|front|back)$/, '_bottom'), top, id),
      left: pick(side, id),
      right: pick(side, id),
      overlay: null,
      tint: null,
    };
  }
  return f;
}

/* ── 仿射变换 ───────────────────────────────────────────────── */

/** 一个面的 6 个变换参数（原版等轴测）。 */
export function faceMatrix(face, W, T2 = T) {
  const h = W / 2 / T2, q = W / 4 / T2;
  switch (face) {
    case 'top':   return [h, q, -h, q, W / 2, 0];
    case 'left':  return [h, q, 0, W / 2 / T2, 0, W / 4];
    case 'right': return [h, -q, 0, W / 2 / T2, W / 2, W / 2];
    default: throw Error(`未知面：${face}`);
  }
}

/** 面的四边形（用于 clip 与求亮暗范围）。 */
export function faceQuad(face, W) {
  const m = faceMatrix(face, W);
  const at = (u, v) => [m[0] * u + m[2] * v + m[4], m[1] * u + m[3] * v + m[5]];
  return [at(0, 0), at(T, 0), at(T, T), at(0, T)];
}

const SHADE = { top: 0, left: ICON_SHADE_LEFT, right: ICON_SHADE_RIGHT };

/** 以面中心为基准外扩 overlap 像素 → 面与面之间不会露缝。 */
function expand(quad, px) {
  const cx = (quad[0][0] + quad[1][0] + quad[2][0] + quad[3][0]) / 4;
  const cy = (quad[0][1] + quad[1][1] + quad[2][1] + quad[3][1]) / 4;
  const size = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]) || 1;
  const k = 1 + (px * 2) / size;
  return quad.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

/**
 * 创建一个图标渲染器。
 * @param {object} env
 *  - getTexture(name)  取已加载的贴图（Image/Canvas），没有就返回 null（并应触发懒加载）
 *  - tint(name,color)  取染色副本（草、树叶、水）
 *  - fallbackURL(id)   贴图缺失时的平面回退地址
 *  - onUpdate()        有新贴图到货，UI 应该重画
 */
export function createIconRenderer(env) {
  const { getTexture, tint = null, fallbackURL = () => '', onUpdate = () => {}, size = 32 } = env;
  const cache = new Map();       // id -> {url, canvas}
  const dirty = new Set();       // 因贴图未到货而临时降级的 id
  let version = 0;

  function texture(name) {
    const img = getTexture?.(name);
    return img && img.complete !== false && (img.width || img.naturalWidth) ? img : null;
  }
  function faceImage(name, color) {
    if (!name) return null;
    if (color && tint) return tint(name, color);
    return texture(name);
  }

  /** 生成（或取缓存）离屏 canvas。贴图没到货返回 null。 */
  function canvasFor(id, faces) {
    const hit = cache.get(id);
    if (hit) return hit.canvas;

    const kind = iconKind(id);
    if (kind === 'flat') return null;
    const f = faces || resolveFaces(id, null);
    /* 缺面时的回退链：资源包里只有侧/正面贴图，没有 *_top、*_side 这些单面图。
       某一面取不到就退到同一方块的另一面，最后才放弃（退成平面图）。
       以前这里只要 top/left/right 有一个为 null 就整块放弃 → 草方块在背包里
       直接退化成一张 16×16 的土。 */
    const pick = (...list) => {
      for (const [name, color] of list) {
        const img = faceImage(name, color);
        if (img) return img;
      }
      return null;
    };
    const tintOf = k => f.tint?.[k] || f.tint?.all;
    const imgs = {
      top: pick([f.top, tintOf('top')], [f.left, tintOf('left')], [f.bottom, tintOf('bottom')]),
      bottom: pick([f.bottom, tintOf('bottom')], [f.top, tintOf('top')]),
      left: pick([f.left, tintOf('left')], [f.right, tintOf('right')], [f.top, tintOf('top')]),
      right: pick([f.right, tintOf('right')], [f.left, tintOf('left')], [f.top, tintOf('top')]),
    };
    if (!imgs.top || !imgs.left || !imgs.right) { dirty.add(id); return null; }

    const W = size;
    const cv = typeof document !== 'undefined' ? document.createElement('canvas') : null;
    if (!cv) return null;
    cv.width = W; cv.height = W;
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;

    const height = kind === 'slab' ? 0.5 : 1;   // 台阶：半高立方体
    const drawFace = (face, image) => {
      if (!image) return;
      g.save();
      const quad = expand(faceQuad(face, W), ICON_FACE_OVERLAP);
      g.beginPath();
      g.moveTo(quad[0][0], quad[0][1]);
      for (let i = 1; i < quad.length; i++) g.lineTo(quad[i][0], quad[i][1]);
      g.closePath();
      g.clip();
      const m = faceMatrix(face, W);
      g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      const sw = image.width || T, sh = image.height || T;
      g.drawImage(image, 0, 0, Math.min(T, sw), Math.min(T, sh), 0, 0, T, T);
      g.setTransform(1, 0, 0, 1, 0, 0);
      const shade = SHADE[face] ?? 0;
      if (shade) { g.fillStyle = `rgba(0,0,0,${shade})`; g.fillRect(0, 0, W, W); }
      g.restore();
    };

    // 画序：顶 → 左 → 右。三个面互不重叠（除了 0.5px 外扩），顺序不影响结果。
    drawFace('top', imgs.top);
    drawFace('left', imgs.left);
    drawFace('right', imgs.right);

    // 侧面叠加层（草边）：画在侧面之上、压暗之下
    if (f.overlay) {
      for (const face of ['left', 'right']) {
        const name = face === 'left' ? f.overlay.left : f.overlay.right;
        const img = faceImage(name, f.overlay.tint);
        if (!img) continue;
        g.save();
        const quad = expand(faceQuad(face, W), ICON_FACE_OVERLAP);
        g.beginPath(); g.moveTo(quad[0][0], quad[0][1]);
        for (let i = 1; i < 4; i++) g.lineTo(quad[i][0], quad[i][1]);
        g.closePath(); g.clip();
        const m = faceMatrix(face, W);
        g.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        g.drawImage(img, 0, 0, T, T, 0, 0, T, T);
        g.setTransform(1, 0, 0, 1, 0, 0);
        const shade = SHADE[face] ?? 0;
        if (shade) { g.fillStyle = `rgba(0,0,0,${shade})`; g.fillRect(0, 0, W, W); }
        g.restore();
      }
    }

    // 台阶：整块压成半高再居中（先画完整立方体，再整体纵向缩放，
    // 这样三个面不会互相错位，也不会在接缝处露出空隙）
    let out = cv;
    if (height !== 1) {
      const tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = W;
      const tg = tmp.getContext('2d');
      tg.imageSmoothingEnabled = false;
      tg.drawImage(cv, 0, 0);
      g.clearRect(0, 0, W, W);
      g.imageSmoothingEnabled = false;
      g.drawImage(tmp, 0, 0, W, W, 0, (1 - height) * W / 2, W, W * height);
      out = cv;
    }

    const entry = { canvas: cv, url: null };
    cache.set(id, entry);
    dirty.delete(id);
    version++;
    return cv;
  }

  function urlFor(id, faces) {
    const cv = canvasFor(id, faces);
    if (!cv) return fallbackURL(id);
    const hit = cache.get(id);
    if (!hit.url) hit.url = cv.toDataURL('image/png');
    return hit.url;
  }

  /** 贴图到货后调用：清掉降级缓存，让 UI 重画。 */
  function refresh() {
    if (!dirty.size) return false;
    for (const id of [...dirty]) { cache.delete(id); }
    dirty.clear();
    onUpdate();
    return true;
  }

  return {
    canvasFor, urlFor, refresh,
    get version() { return version; },
    get pending() { return dirty.size; },
    clear() { cache.clear(); dirty.clear(); },
  };
}
