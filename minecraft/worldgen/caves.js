// worldgen/caves.js
// ───────────────────────────────────────────────────────────────────────────
// 洞穴系统（2D 适配）。所有判定按「绝对世界坐标」求值 → 跨区块边界天然连续、与生成顺序无关。
// 提供纯谓词，由 chunk.js 在「仅替换石头类方块」的前提下调用，并施加护栏：
//   · 不切穿基岩；
//   · 海平面以下、且其上方是水的位置不挖（防止海洋灌入洞穴，规格书 §4.1）。
// 洞穴类型：蠕虫(worm) / 大空洞(cheese) / 竖井(ravine)。底部填岩浆。
// ───────────────────────────────────────────────────────────────────────────
import { toSeed, mixSeed, hash1, rand01 } from './rng.js';
import { makeFbm2D } from './noise.js';
import { NOISE, CAVES, BEDROCK_TOP, SEA_LEVEL, LAVA_DEPTH, WORLD_MAX_Y } from './constants.js';

/* 只有这些方块可被洞穴挖空（不挖泥土/沙子/次表层，避免洞穴啃食地表）。 */
export const CAVE_REPLACEABLE = new Set([
  'stone','deepslate','andesite','diorite','granite','tuff','gravel',
]);

export function makeCaves(seed, enabled = true){
  const s = toSeed(seed);
  const worm  = makeFbm2D(s, { freq: NOISE.cave_worm.freq,   octaves: NOISE.cave_worm.octaves,   persistence: NOISE.cave_worm.persistence,   lacunarity: NOISE.cave_worm.lacunarity,   salt: NOISE.cave_worm.salt });
  const cheese= makeFbm2D(s, { freq: NOISE.cave_cheese.freq, octaves: NOISE.cave_cheese.octaves, persistence: NOISE.cave_cheese.persistence, lacunarity: NOISE.cave_cheese.lacunarity, salt: NOISE.cave_cheese.salt });
  // 大空洞中心：用低频噪声做阈值，越靠近中心半径越大（椭圆团块）。
  const ravineSalt = mixSeed(s, 2001);

  function isWorm(x, y){
    return Math.abs(worm(x, y)) < CAVES.wormThreshold;
  }
  function isCheese(x, y){
    return cheese(x, y) > CAVES.cheeseThreshold;
  }
  /* 洞室半径（仅用于统计/调试）：阈值以上部分线性映射到 4~12 格。 */
  function cheeseRadius(x, y){
    const v = cheese(x, y);
    if (v < CAVES.cheeseThreshold) return 0;
    const t = (v - CAVES.cheeseThreshold) / (0.5 - CAVES.cheeseThreshold);
    return CAVES.cheeseMinD + Math.min(1, t) * (CAVES.cheeseMaxD - CAVES.cheeseMinD);
  }
  /* 竖井/裂隙：每列以 ravineChance 概率成为一条垂直裂缝的 X 中心。
   * 只返回「宽度」与「深度」，上下边界由调用方结合地表高度决定
   * （裂缝顶端贴近地表 → 贯通到地表形成洞口；底端有上限 → 不会把整个地层掏空）。 */
  function ravineAt(x){
    if (rand01(hash1(ravineSalt, x)) >= CAVES.ravineChance) return null;
    const w = Math.max(1, Math.round(CAVES.ravineWidth));
    const depth = CAVES.ravineMinDepth + Math.floor(rand01(hash1(mixSeed(ravineSalt, x), 1)) * CAVES.ravineDepthRange);
    return { x0: x - w, x1: x + w, depth };
  }

  /* 某格是否应被洞穴挖空（不含护栏；护栏在 chunk 循环里）。 */
  function isCaveAt(x, y){
    if (!enabled) return false;
    return isWorm(x, y) || isCheese(x, y);
  }

  return { isWorm, isCheese, cheeseRadius, ravineAt, isCaveAt, enabled };
}
