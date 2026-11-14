// worldgen/decorations.js
// ───────────────────────────────────────────────────────────────────────────
// 植被与树木（规格书 §6）。
// ★ 坐标方向：本世界 y=0 是最底部（基岩），y 越大越高（海平面 63，地表 ~63~120）。
//   所以「地面之上」= y 更大，「地面之下」= y 更小。树从地面往上长。
//
// 树木只长在合法地表（草/泥土/灰化土上），周围有空间，不穿洞穴/水/其他树；
// 树叶/树干只覆盖空气（不覆盖已有的实心方块），因此跨区块的树叶通过 chunk.outgoing
// 待写入队列交给邻居，且「只填空气」保证无论以什么顺序生成区块，结果逐方块一致
// （验收 §12.1 / §12.2 / §12.6）。
//
// 树的所有权：列 x 是否成为「树根」由 (seed,x) 的纯函数决定（向左扫描 ≥ TREE_BASE_GAP 内无根），
// 因此相邻区块对「哪里有树」判断完全一致，不会出现重叠树。
// ───────────────────────────────────────────────────────────────────────────
import { toSeed, mixSeed, hash2, hash1, rand01 } from './rng.js';

// 树根最小间距：必须大于 2×最大树冠半径（丛林半径 3 → 需 ≥7），
// 这样任意两棵树的树冠不会覆盖同一格，保证「乱序生成」时边界树叶逐方块一致（验收 §12.1）。
const TREE_BASE_GAP = 7;   // ≥ 2×最大树冠半径(3)+1，保证两棵树的树冠不重叠
const VALID_SOIL = new Set(['grass_block','dirt','coarse_dirt','podzol','mossy_stone','mycelium']);

/* 树名 → 原木/树叶方块名（沼泽橡木复用橡木方块）。 */
function logName(type){ return (type === 'swamp_oak' ? 'oak' : type) + '_log'; }
function leafName(type){ return (type === 'swamp_oak' ? 'oak' : type) + '_leaves'; }

/* 树高（格，地面之上）。 */
function treeHeight(type, rng){
  return ({
    oak: 4 + Math.floor(rng()*3),          // 4~6
    birch: 5 + Math.floor(rng()*3),        // 5~7
    spruce: 5 + Math.floor(rng()*4),       // 5~8
    acacia: 4 + Math.floor(rng()*3),       // 4~6
    jungle: 8 + Math.floor(rng()*5),       // 8~12
    swamp_oak: 4 + Math.floor(rng()*3),
  })[type] || 5;
}

/* 实际放置：groundY 是地面方块所在 y，树干从 groundY+1 往上长到 groundY+h。 */
function placeTree(base, groundY, type, plant, rng){
  const h = treeHeight(type, rng);
  const top = groundY + h;                  // 树干顶端（最高一格原木）
  const wide = (type === 'jungle') ? 2 : 1; // 丛林树干 2 格宽（2D）
  // 树干（只填空气）
  for (let y = groundY + 1; y <= top; y++){
    for (let w = 0; w < wide; w++) plant(base + w, y, logName(type));
  }
  // 树冠
  if (type === 'spruce'){
    // 圆锥：越往下越宽
    for (let k = 0; k <= 3; k++){
      const ly = top - k;
      const r = k === 0 ? 0 : (k === 1 ? 1 : 2);
      for (let dx = -r; dx <= r; dx++) plant(base + dx, ly, 'spruce_leaves');
    }
    plant(base, top + 1, 'spruce_leaves');
  } else if (type === 'acacia'){
    // 平顶（歪树）：两层圆盘
    for (let dy = 0; dy <= 1; dy++){
      const r = dy === 0 ? 3 : 2;
      for (let dx = -r; dx <= r; dx++) plant(base + dx, top + dy, 'acacia_leaves');
    }
  } else {
    // 圆团（橡/白桦/丛林）
    const cy = (type === 'jungle') ? top - 2 : top - 1;
    const R = (type === 'jungle') ? 3 : 2;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++){
      const d = Math.abs(dx) + Math.abs(dy);
      if (d > R + 0.2) continue;
      if (Math.abs(dx) === R && Math.abs(dy) === R) continue;  // 去角
      plant(base + dx, cy + dy, leafName(type));
    }
    plant(base, top + 1, leafName(type));
    if (type === 'swamp_oak') plant(base + wide, groundY + 1, 'vine');  // 沼泽橡木带藤蔓
  }
}

export function makeDecorations(seed){
  const s = toSeed(seed);

  /* 列 x 是否为树根（纯函数，向左扫描 ≥ TREE_BASE_GAP 内无根）。
   * ★ 记忆化：递归深度是 TREE_BASE_GAP（7 层），不缓存的话最坏是 7^7 次调用。
   *   树根判定只依赖 x 与群系密度（纯函数），所以缓存永远有效。 */
  const _treeBaseCache = new Map();
  function isTreeBase(x, biomeAt, densityAt){
    const hit = _treeBaseCache.get(x);
    if (hit !== undefined) return hit;
    const d = densityAt(x);
    let res;
    if (d <= 0) res = false;
    else if (rand01(hash2(mixSeed(s, x), 1)) >= d) res = false;
    else {
      res = true;
      for (let dx = -TREE_BASE_GAP; dx <= -1; dx++){
        if (isTreeBase(x + dx, biomeAt, densityAt)){ res = false; break; }
      }
    }
    _treeBaseCache.set(x, res);
    return res;
  }

  /* 群系每列成树概率（规格书 §6：「所有密度由群系配置驱动」）。
   * 优先用群系注册表里的 treeDensity；没写就按「树型权重」折算。
   * ★ 真正的上限是 TREE_BASE_GAP（树根至少隔 7 列 → 最多约 14%）：
   *   所以密度给到 0.25 以上也不会更密，只会被间距规则压回去。
   *   森林/丛林给 0.30 是有意的 —— 命中间距上限 ≈ 每 8 列一棵树。 */
  function densityAt(x, biomeAt){
    const b = biomeAt(x);
    if (!b || !b.trees || b.trees.length === 0) return 0;
    if (typeof b.treeDensity === 'number') return Math.min(0.34, Math.max(0, b.treeDensity));
    const w = b.trees.reduce((a, t) => a + (t.weight||1), 0);
    return Math.min(0.22, 0.9 * w / (b.trees.length * 14));
  }

  function pickTree(x, biomeAt){
    const b = biomeAt(x);
    const rs = rand01(hash2(mixSeed(s, 3), x));
    let acc = rs * b.trees.reduce((a,t)=>a+(t.weight||1),0);
    for (const t of b.trees){ acc -= (t.weight||1); if (acc <= 0) return t.type; }
    return b.trees[0].type;
  }

  /* 在某区块内生成树木 + 植物。chunk 提供：
   *   x0,x1,cx, groundY(x), waterSurfaceY(x), biomeAt(x), get(x,y), plant(x,y,name) */
  function generate(chunk){
    const { x0, x1, groundY, waterSurfaceY, biomeAt, get, plant } = chunk;
    // 1) 树
    for (let x = x0; x <= x1; x++){
      if (!isTreeBase(x, biomeAt, (xx)=>densityAt(xx, biomeAt))) continue;
      const b = biomeAt(x);
      const type = pickTree(x, biomeAt);
      const gy = groundY(x);
      if (!VALID_SOIL.has(get(x, gy))) continue;   // 地表不合法（沙/水/石）→ 不生成
      if (get(x, gy + 1) !== 'air') continue;       // 头顶不是空气 → 不生成
      if (waterSurfaceY(x) >= 0) continue;          // 泡在水里 → 不生成
      placeTree(x, gy, type, plant, mulberryLocal(mixSeed(s, 555), x));
    }
    // 2) 地面植物 / 特殊植被
    for (let x = x0; x <= x1; x++){
      const b = biomeAt(x);
      const gy = groundY(x);
      const r = rand01(hash2(mixSeed(s, 9), x));
      const soil = get(x, gy);
      const above = get(x, gy + 1);
      // 仙人掌（沙漠：沙上 + 上方空气）
      if (soil === 'sand' && b.id === 'desert' && above === 'air' && r < 0.05){
        const ch = 1 + Math.floor(rand01(hash2(mixSeed(s, 91), x)) * 2);
        for (let k = 0; k < ch; k++) plant(x, gy + 1 + k, 'cactus');
        continue;
      }
      // 枯灌木
      if (soil === 'sand' && above === 'air' && rand01(hash2(mixSeed(s, 92), x)) < 0.04){ plant(x, gy + 1, 'dead_bush'); continue; }
      // 雪层：寒冷群系的地表之上盖 1 格雪
      if (b.hasSnow && above === 'air' && (soil === 'grass_block' || soil === 'dirt')){
        plant(x, gy + 1, 'snow');
      }
      // 草 / 蕨 / 花
      if ((soil === 'grass_block' || soil === 'dirt') && above === 'air' && b.plants){
        if (r < 0.22){
          const p = b.plants[Math.floor(rand01(hash2(mixSeed(s, 93), x)) * b.plants.length)];
          if (p === 'short_grass' || p === 'fern' || p === 'dandelion' || p === 'poppy') plant(x, gy + 1, p);
        }
      }
      // 甘蔗（水边的沙/草）
      const sideWater = get(x - 1, gy + 1) === 'water' || get(x + 1, gy + 1) === 'water' || get(x, gy + 1) === 'water';
      if (sideWater && (soil === 'grass_block' || soil === 'sand') && above === 'air' && rand01(hash2(mixSeed(s, 94), x)) < 0.06){
        const ch = 1 + Math.floor(rand01(hash2(mixSeed(s, 95), x)) * 2);
        for (let k = 0; k < ch; k++) plant(x, gy + 1 + k, 'sugar_cane');
      }
      // 睡莲（长在水面最上那格）
      const ws = waterSurfaceY(x);
      if (ws >= 0 && get(x, ws) === 'water' && rand01(hash2(mixSeed(s, 96), x)) < 0.03){
        plant(x, ws + 1, 'lily_pad');
      }
      // 水下植被：海草（浅水，1 格）与海带（深水，2~3 格）
      if (ws >= 0 && get(x, ws) === 'water'){
        const bed = get(x, ws - 1);
        if ((bed === 'sand' || bed === 'gravel' || bed === 'clay' || bed === 'dirt') && rand01(hash2(mixSeed(s, 97), x)) < 0.18){
          if (ws - 2 >= 0 && get(x, ws - 2) === 'water' && rand01(hash2(mixSeed(s, 98), x)) < 0.45){
            const len = 2 + Math.floor(rand01(hash2(mixSeed(s, 99), x)) * 2);
            for (let k = 0; k < len; k++) plant(x, ws - 1 - k, 'kelp');
          } else {
            plant(x, ws - 1, 'seagrass');
          }
        }
      }
      // 南瓜 / 西瓜（平原、森林的稀有地面装饰）
      if ((soil === 'grass_block' || soil === 'coarse_dirt') && above === 'air' && (b.id === 'plains' || b.id === 'forest')){
        const r2 = rand01(hash2(mixSeed(s, 101), x));
        if (r2 < 0.004) plant(x, gy + 1, 'pumpkin');
        else if (r2 < 0.008) plant(x, gy + 1, 'melon');
      }
    }
  }

  return { generate, isTreeBase, densityAt };
}

/* 局部确定性 RNG（仅用于树高这类「一次性的局部」随机，不写入任何全局状态）。 */
function mulberryLocal(seed, x){
  let a = mixSeed(seed, x) >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
