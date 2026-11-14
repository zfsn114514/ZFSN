// worldgen/terrain.js
// ───────────────────────────────────────────────────────────────────────────
// 地形高度 + 地层。地表高度 surfaceY(x) 是 x 的纯函数 → 与区块生成顺序无关（验收 §12.1/§12.2）。
// 高度平滑用「对称」的多次邻域平均 + 步长封顶，不依赖遍历方向（否则跨区块边界会切错）。
//
// buildColumn(x, set) 把一个整列（y=0..WORLD_MAX_Y）写进区块缓冲。set(y,name) 由调用方
// 转成调色板索引（'air' = 0）。海洋/河流/湖泊的水也在这里填充到对应水位。
// ───────────────────────────────────────────────────────────────────────────
import { toSeed, mixSeed, hash2, rand01 } from './rng.js';
import { makeFbm1D, makeFbm2D } from './noise.js';
import { makeBiomeSampler, BIOMES } from './biomes.js';
import {
  WORLD_MAX_Y, WORLD_MIN_Y, SEA_LEVEL, BEDROCK_TOP, DEEPSLATE_BAND,
  NOISE, MAX_STEP, MAX_STEP_MOUNTAIN, BLEND_RADIUS, STONE_BLOBS, STONE_BLOB_MAX_R, CLAY_CHANCE,
  COAST, DEEP_OCEAN_DEPTH,
} from './constants.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function weightedPick(items, r){
  // items: [{block, weight}]
  let total = 0; for (const it of items) total += it.weight;
  let acc = r * total;
  for (const it of items){ acc -= it.weight; if (acc <= 0) return it.block; }
  return items[items.length - 1].block;
}

export function makeTerrain(seed, worldType = { flat: false, biomeScale: 1 }){
  const s = toSeed(seed);
  const biome = makeBiomeSampler(s, worldType);

  if (worldType.flat){
    // 超平坦：基岩 1 + 泥土 2 + 草 1，无群系/洞穴（规格书 §10）。
    return {
      biome,
      // surfaceY = 这一列最上面的实心方块所在的 y（草方块）。
      // 必须与 buildColumn 实际写进去的层一致，否则出生点/装饰会差一格。
      surfaceY(){ return SEA_LEVEL; },
      groundY(){ return SEA_LEVEL; },
      waterSurfaceY(){ return -1; },
      isRiverAt(){ return false; },
      tagAt(){ return 'plains'; },
      buildColumn(x, set){
        // 基岩 1 + 泥土 2 + 草 1，地表正好在海平面（SEA_LEVEL）
        set(SEA_LEVEL - 3, 'bedrock');
        set(SEA_LEVEL - 2, 'dirt');
        set(SEA_LEVEL - 1, 'dirt');
        set(SEA_LEVEL, 'grass_block');
      },
    };
  }

  const continent = makeFbm1D(s, { freq: NOISE.continent_base.freq, octaves: NOISE.continent_base.octaves, persistence: NOISE.continent_base.persistence, lacunarity: NOISE.continent_base.lacunarity, salt: NOISE.continent_base.salt });
  const hills     = makeFbm1D(s, { freq: NOISE.hills.freq,         octaves: NOISE.hills.octaves,         persistence: NOISE.hills.persistence,         lacunarity: NOISE.hills.lacunarity,         salt: NOISE.hills.salt });
  const detail    = makeFbm1D(s, { freq: NOISE.detail.freq,        octaves: NOISE.detail.octaves,        persistence: NOISE.detail.persistence,        lacunarity: NOISE.detail.lacunarity,        salt: NOISE.detail.salt });
  const mountain  = makeFbm1D(s, { freq: NOISE.mountain.freq,      octaves: NOISE.mountain.octaves,      persistence: NOISE.mountain.persistence,      lacunarity: NOISE.mountain.lacunarity,      salt: NOISE.mountain.salt });
  const riverN    = makeFbm1D(s, { freq: NOISE.river.freq,         octaves: NOISE.river.octaves,         persistence: NOISE.river.persistence,         lacunarity: NOISE.river.lacunarity,         salt: NOISE.river.salt });
  const lakeN     = makeFbm1D(s, { freq: NOISE.lake.freq,          octaves: NOISE.lake.octaves,          persistence: NOISE.lake.persistence,          lacunarity: NOISE.lake.lacunarity,          salt: NOISE.lake.salt });
  const blobN     = makeFbm2D(s, { freq: NOISE.stone_blob.freq,    octaves: NOISE.stone_blob.octaves,    persistence: NOISE.stone_blob.persistence,    lacunarity: NOISE.stone_blob.lacunarity,    salt: NOISE.stone_blob.salt });

  const blobSalt = mixSeed(s, 777);

  /* 原始高度（未平滑）。纯函数。
   * 关键：陆/海由「大陆度」连续决定，而不是直接拿群系的 baseHeight。
   * 早前直接用群系 baseHeight 会在海岸附近把大片陆地拉到海平面以下（实测 74% 是水），
   * 而且群系是「按单元格」划分的，边界一格就会让地形整片塌下去。
   * 现在：大陆度 c < COAST → 海洋（深度随 c 连续增加 3~38 格）；
   *       c >= COAST → 陆地（离岸越远越高），再叠加丘陵/细节/山地噪声。 */
  function rawHeight(x){
    const climate = biome.smoothedClimate(x);
    const c = climate.continental;
    const { heightVariation, biome: b } = biome.surfaceParamsAt(x);
    let h;
    if (c < COAST){
      const t = (COAST - c) / (COAST + 1);          // 0..1，越靠海心越深
      h = SEA_LEVEL - (3 + t * 35);                  // 海深 3~38 格
    } else {
      const t = (c - COAST) / (1 - COAST);           // 0..1，离岸程度
      h = SEA_LEVEL + 1 + t * 6;
      h += hills(x) * heightVariation;
      h += detail(x) * 1.8;
      if (b.mountainous) h += Math.pow(Math.max(0, mountain(x)), 1.4) * (90 + 60 * Math.max(0, climate.erosion));
      else h += Math.max(0, mountain(x)) * 5;
      if (b.id === 'swamp') h -= 2;                  // 沼泽低洼
    }
    return clamp(Math.round(h), BEDROCK_TOP + 2, WORLD_MAX_Y - 1);
  }

  /* 对称平滑 + 步长封顶（不依赖遍历方向）。返回平滑后的高度，纯函数。 */
  const _cache = new Map();
  function smoothHeight(x){
    const key = x;
    if (_cache.has(key)) return _cache.get(key);
    const R = BLEND_RADIUS + 4;
    const arr = [];
    for (let dx = -R; dx <= R; dx++) arr.push(rawHeight(x + dx));
    const maxStep = (biome.smoothedClimate(x).erosion > 0.42) ? MAX_STEP_MOUNTAIN : MAX_STEP;
    for (let pass = 0; pass < 3; pass++){
      const next = arr.slice();
      for (let i = 1; i < arr.length - 1; i++){
        const avg = (arr[i - 1] + arr[i] + arr[i + 1]) / 3;
        let cand = arr[i] + (avg - arr[i]) * 0.5;
        cand = clamp(cand, arr[i] - maxStep, arr[i] + maxStep);
        next[i] = Math.round(cand);
      }
      for (let i = 0; i < arr.length; i++) arr[i] = next[i];
    }
    const out = arr[R];
    _cache.set(key, out);
    return out;
  }

  /* 河流：对低频噪声取 |noise| 近 0 的窄带，在陆地上切出河道。海洋/大陆度低的区域不生成。 */
  function riverDepthAt(x){
    const c = biome.smoothedClimate(x).continental;
    if (c < -0.25) return 0;                 // 海洋不切河
    const r = Math.abs(riverN(x));
    const width = 0.06;                      // |noise| < width → 河道
    if (r >= width) return 0;
    const t = 1 - r / width;                 // 0..1，中心最深
    return Math.round(3 + t * 4);            // 深度 3~7
  }
  function isRiverAt(x){ return riverDepthAt(x) > 0; }

  /* 湖泊：低洼盆地（噪声极高）且不在海洋，填水到某一水位。 */
  function lakeAt(x){
    const c = biome.smoothedClimate(x).continental;
    if (c < -0.25) return null;
    const l = lakeN(x);
    if (l < 0.62) return null;
    const depth = Math.round((l - 0.62) / 0.38 * 4) + 1;
    return { depth };
  }

  /* 有效地表高度与水位。
   * 水位由「地形高度」决定（而不是群系标志）：任何地表低于海平面的列都会灌水，
   * 这样海岸线自然形成，也保证不会出现「内陆群系却是海洋底」的矛盾。 */
  function columnTop(x){
    const surf = smoothHeight(x);
    const rd = riverDepthAt(x);
    const lake = lakeAt(x);
    let top = surf;
    let waterTop = -1;
    /* ★ 水位只看「实际地形高度」，不再看群系标志。
       平滑后的海岸是连续斜坡：地表低于海平面的列就是水，高于海平面的列就是陆地。
       以前按 base.isOcean 灌水，会出现同一高度（surf=53）的海岸一边有水到 63、
       一边是干地 —— 视觉上就是海水竖着堆在平原上。 */
    if (rd > 0){
      top = surf - rd;
      // 河流水面：低地河流与海平面齐平，高地河流贴近河岸
      waterTop = (surf <= SEA_LEVEL + 2) ? SEA_LEVEL : surf - 1;
    } else if (lake && surf >= SEA_LEVEL){
      // 湖只在海平面以上挖；海平面以下的低地已经是海，不该再被「湖」抬成小水坑
      top = surf - lake.depth;
      waterTop = surf - 1;
    }
    // 兜底：地表低于海平面的列直接变成水下（海岸斜坡的最后一段）
    if (surf < SEA_LEVEL) waterTop = SEA_LEVEL;
    // 河/湖太浅时 top 会和水面重合 → 一格水都放不下（干水沟）。至少留 1 格水。
    if (waterTop >= 0 && top >= waterTop) top = waterTop - 1;
    top = clamp(top, BEDROCK_TOP + 2, WORLD_MAX_Y - 1);
    const underwater = waterTop >= 0 && top < waterTop;
    /* 群系跟着水位走：水下显示海洋/深海，水上显示气候群系。
       河流 / 湖泊保留陆地群系（tagAt 会另外标成 river）。 */
    let base = biome.baseBiomeAt(x);
    if (underwater && rd <= 0 && !lake){
      base = biome.BIOMES[(SEA_LEVEL - top > DEEP_OCEAN_DEPTH) ? 'deep_ocean' : 'ocean'];
    } else if (!underwater && base.isOcean){
      // 海岸陡坡处平滑后可能把「海洋气候」抬到海平面以上：改判陆地群系，避免干的海底。
      base = biome.landBiomeAt(x);
    }
    return { top, waterTop, underwater, base };
  }

  /* 对外暴露的「这一列到底是什么群系」：水下是海洋/深海，水上是陆地群系。
     矿石/植被/生物生成统一走这里，保证不会在海底长树、在平原水面上刷怪。 */
  function biomeAt(x){ return columnTop(x).base; }

  /* 海滩判定：本列是陆地、地表贴近海平面，且附近存在水下列 → 沙。 */
  function isBeach(x){
    const surf = smoothHeight(x);
    if (surf < SEA_LEVEL - 1 || surf > SEA_LEVEL + 2) return false;
    for (let dx = -3; dx <= 3; dx++){
      if (dx === 0) continue;
      if (smoothHeight(x + dx) < SEA_LEVEL) return true;
    }
    return false;
  }

  /* 列标签（用于调试显示与群系分布统计）。 */
  function tagAt(x){
    const base = biomeAt(x);
    if (base.isOcean) return base.id;
    if (isRiverAt(x)) return 'river';
    if (isBeach(x)) return 'beach';
    return base.id;
  }

  /* ── 列的完整地表信息（纯函数，不碰区块缓冲）──────────────────────────
   * buildColumn 与「找出生点」都要用同一套判定，所以抽成一个函数，
   * 免得两边各写一份、日后改岔。 */
  function surfaceInfo(x){
    const { top, waterTop, underwater, base } = columnTop(x);
    const beach = isBeach(x);
    const climate = biome.smoothedClimate(x);
    const snowy = base.hasSnow || (base.mountainous && top > SEA_LEVEL + 40 && climate.temperature < 0.2);
    const coldWater = climate.temperature < -0.15;   // 冰冻水面
    const isRiverCol = isRiverAt(x) && !underwater;

    // 地表方块选择
    let surfaceBlock = base.surface;
    let subBlock = base.sub;
    let subDepth = base.subDepth || 4;
    if (underwater){
      // 海底：深海用砂砾，其余用沙；偶发粘土团块
      surfaceBlock = base.id === 'deep_ocean' ? 'gravel' : 'sand';
      subBlock = surfaceBlock;
      subDepth = 3;
      if (rand01(hash2(mixSeed(s, 31), x, 0)) < CLAY_CHANCE){ surfaceBlock = 'clay'; subBlock = 'clay'; }
    } else if (isRiverCol){
      surfaceBlock = 'sand'; subBlock = 'sand'; subDepth = 2;
    } else if (beach){
      surfaceBlock = 'sand'; subBlock = 'sandstone'; subDepth = 3;
    }
    // 注意：雪原/针叶林的地表保持草方块（否则树永远长不出来），
    // 「雪层」由 decorations 作为地表之上的一层薄方块铺上（snow）。
    // ★ 群系注册表里 snowy_plains 写的是 snow_block，那是 Java 版的写法
    //   （雪原的地表就是雪块）。但本作 decorations 的 VALID_SOIL 只认草/土，
    //   直接用 snow_block 会导致：① 雪原一棵树都不长；② 雪层也铺不上
    //   （雪层的条件是「地表是 grass_block 或 dirt」）。实测寒冷群系 3954 列里
    //   只有 89 列有树。改成草方块地表 + 装饰阶段补雪层，观感等价且树能长出来。
    if (base.hasSnow && base.surface === 'snow_block') surfaceBlock = 'grass_block';

    return { top, waterTop, underwater, base, beach, snowy, coldWater, isRiverCol, surfaceBlock, subBlock, subDepth };
  }

  /* 这一列的地表方块名（纯函数）。找出生点时用来判断「是不是合法地面」，
     不用生成区块就能判断 —— 否则开局要生成上百个区块才找得到一个出生点。 */
  function surfaceBlockAt(x){ return surfaceInfo(x).surfaceBlock; }

  /* 构建一整列。set(y,name) 写调色板名（'air' = 空）。 */
  function buildColumn(x, set){
    const { top, waterTop, underwater, base, snowy, coldWater, surfaceBlock, subBlock, subDepth } = surfaceInfo(x);
    for (let y = 0; y <= WORLD_MAX_Y; y++){
      // 基岩层（最底部封底，1~3 随机渐变）
      if (y < BEDROCK_TOP){
        if (y === 0) { set(y, 'bedrock'); continue; }
        const p = (BEDROCK_TOP - y) / BEDROCK_TOP * 0.85;
        if (rand01(hash2(mixSeed(s, 9), x, y)) < p) { set(y, 'bedrock'); continue; }
        // 否则落到下面的石头分支
      }

      if (y > top){
        // 空气或水
        if (waterTop >= 0 && y <= waterTop){
          if (coldWater && y === waterTop) set(y, 'ice');
          else set(y, 'water');
        } else set(y, 'air');
        continue;
      }

      const depth = top - y; // 0 = 地表
      if (depth === 0){ set(y, surfaceBlock); continue; }

      // 深板岩渐变带（底部 16 格）
      let stoneKind = 'stone';
      if (y <= DEEPSLATE_BAND){
        const pDeep = (DEEPSLATE_BAND - y) / DEEPSLATE_BAND;
        if (y <= 2) stoneKind = 'deepslate';
        else if (rand01(hash2(mixSeed(s, 13), x, y)) < pDeep * 0.9) stoneKind = 'deepslate';
      }

      if (depth <= subDepth){ set(y, subBlock); continue; }

      // 石头 + 大团块（安山岩/闪长岩/花岗岩/砂砾/泥土）
      if (stoneKind === 'stone'){
        const bv = blobN(x * 0.12, y * 0.12);
        if (bv > 0.55){
          const gx = Math.round(x / 3), gy = Math.round(y / 3);
          const r = rand01(hash2(blobSalt, gx, gy));
          const pick = weightedPick(STONE_BLOBS, r);
          set(y, pick);
          continue;
        }
      }
      set(y, stoneKind);
    }
  }

  return {
    biome, surfaceY: smoothHeight,
    groundY: (x) => columnTop(x).top,
    waterSurfaceY: (x) => columnTop(x).waterTop,
    surfaceBlockAt,
    isRiverAt, lakeAt, isBeach, tagAt, buildColumn, columnTop, biomeAt,
  };
}
