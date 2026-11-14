// worldgen/ores.js
// ───────────────────────────────────────────────────────────────────────────
// 矿石与地下资源（规格书 §5）。按「矿脉团块」生成：每个区块、每种矿石尝试若干次，
// 每次取中心点（由坐标哈希确定，与生成顺序无关），按给定大小生成近似椭球。
// 只替换石头 / 深板岩（及安山岩/闪长岩/花岗岩/凝灰岩），绝不替换泥土、沙子、水、空气。
//
// ★ 2D 密度缩放（规格书 §5 要求说明缩放系数）
//   ★ 旧公式把 Java 的 veinSize（一次矿脉的**矿石块数**，如煤炭 17 块）当成了
//     球半径 r，于是每次生成了一个半径 8 的 2D 圆盘（≈140 格）。煤炭实测
//     320 块/区块、占总方块 7.8%，看起来就是「地下全是矿」。
//   现在的算法：保持「矿石占总方块的比例」与 Java 一致。
//     Java 每区块矿块数  B = perChunk × veinSizeJava
//     Java 区块 16×16×384 = 98304 格；2D 区块 16×256 = 4096 格 → 4096/98304 = 1/24
//     2D 单次矿脉平均面积 A（r=1 → 1 格，r=2 → 9 格，r=3 → 约 22 格）
//     perChunk2D = (B / 24) / A
//   算出的 perChunk2D 是小数，见下面的 attemptsFor()：整数部分每次都生成，
//   小数部分用「区块哈希 < 小数」决定是否补一次，这样既保持长期密度，又不放大。
//   各矿种的最终次数见 constants.js（perChunk2D 字段）。
//
// ★ Y 分布：Java 用三角分布（min..max，峰值在 mode），这里照做：
//   y = a + sqrt(u(b-a)(m-a))  （u < c）  或  b - sqrt((1-u)(b-a)(b-m))（否则）
// ───────────────────────────────────────────────────────────────────────────
import { toSeed, mixSeed, hash1, hash2, rand01 } from './rng.js';
import { ORES, ORE_EXTRA_IRON, ORE_SCALE, DEEPSLATE_BAND, WORLD_MIN_Y, WORLD_MAX_Y } from './constants.js';

const ORE_REPLACEABLE = new Set(['stone','deepslate','andesite','diorite','granite','tuff']);

/* 三角分布采样：区间 [a,b]，峰值在 m。 */
function triangular(a, b, m, u){
  if (b <= a) return a;
  const c = (m - a) / (b - a);
  if (u < c) return a + Math.sqrt(u * (b - a) * (m - a));
  return b - Math.sqrt((1 - u) * (b - a) * (b - m));
}

export function makeOres(seed){
  const s = toSeed(seed);

  /* 每区块尝试次数：支持小数。整数部分必定生成，小数部分按区块哈希掷一次。
     不能直接 Math.round —— 0.30 会被抹成 0（钻石、青金石直接消失）或 1（密度翻倍）。 */
  function attemptsFor(ore, cx, salt = 0){
    const raw = Math.max(0, (ore.perChunk2D ?? ore.perChunk) * ORE_SCALE);
    const whole = Math.floor(raw + 1e-9);
    const frac = raw - whole;
    if (frac <= 1e-9) return whole;
    const roll = rand01(hash2(mixSeed(mixSeed(s, hashStrInt(ore.id) ^ salt), 4242), cx, 9));
    return whole + (roll < frac ? 1 : 0);
  }

  /* 单次矿脉尝试。cx 参与子种子，但结果只依赖坐标哈希 → 与生成顺序无关。 */
  function vein(cx, ore, attempt, set, get){
    const salt = mixSeed(mixSeed(s, attempt * 2654435761), cx * 40503) ^ hashStrInt(ore.id);
    const r1 = rand01(hash2(salt, cx, 1));
    const r2 = rand01(hash2(salt, cx, 2));
    const r3 = rand01(hash2(salt, cx, 3));
    // 中心 Y：三角分布，峰值在 ore.center
    const mode = ore.center ?? (ore.yMin + ore.yMax) / 2;
    const y0 = Math.round(clampInt(triangular(ore.yMin, ore.yMax, mode, r1), ore.yMin, ore.yMax));
    // 中心 X：在区块内随机列
    const x0 = cx * 16 + Math.floor(r2 * 16);
    const size = ore.veinSize;
    for (let dy = -size; dy <= size; dy++){
      for (let dx = -size; dx <= size; dx++){
        const dist2 = dx * dx + dy * dy;
        if (dist2 > size * size * (0.55 + 0.45 * r3)) continue;
        const x = x0 + dx, y = y0 + dy;
        if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) continue;
        // 整条矿脉都必须在该矿种的 Y 范围内（Java 的 ore feature 也是这么裁的）
        if (y < ore.yMin || y > ore.yMax) continue;
        const cur = get(x, y);
        if (!ORE_REPLACEABLE.has(cur)) continue;
        const isDeep = y <= DEEPSLATE_BAND + 2;
        const block = isDeep && ore.deepBlock ? ore.deepBlock : ore.block;
        set(x, y, block);
      }
    }
  }

  /* 对单个区块生成所有矿石。chunk 提供 {cx, get, set, biomeAt}。 */
  function generate(chunk){
    const { cx } = chunk;
    for (const ore of ORES){
      if (ore.id === 'emerald'){
        // 仅山地群系，单点随机（Java 1.20：绿宝石每区块 1 次，单点）
        const bx = cx * 16 + 8;
        if (!chunk.biomeAt(bx)?.mountainous) continue;
        const r = rand01(hash1(mixSeed(s, cx), 777));
        if (r > 0.25) continue;                 // 约每 4 个山地区块 1 个绿宝石点
        const x = cx * 16 + Math.floor(rand01(hash1(mixSeed(s, cx), 11)) * 16);
        const y = 4 + Math.floor(rand01(hash1(mixSeed(s, cx), 22)) * 27);
        if (ORE_REPLACEABLE.has(chunk.get(x, y))) chunk.set(x, y, ore.block);
        continue;
      }
      const attempts = attemptsFor(ore, cx);
      for (let a = 0; a < attempts; a++) vein(cx, ore, a + 1, chunk.set, chunk.get);
    }
    // 山区铁矿额外层（Java 1.20：山区 80~250 额外铁矿）
    if (chunk.biomeAt(cx * 16 + 8)?.mountainous){
      const ore = { ...ORE_EXTRA_IRON, block:'iron_ore', deepBlock:'deepslate_iron_ore' };
      const attempts = attemptsFor(ore, cx, 1000);
      for (let a = 0; a < attempts; a++) vein(cx, ore, a + 100, chunk.set, chunk.get);
    }
  }

  return { generate };
}

function clampInt(v, a, b){ return v < a ? a : v > b ? b : v; }
function hashStrInt(str){
  const t = String(str ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < t.length; i++){ h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
