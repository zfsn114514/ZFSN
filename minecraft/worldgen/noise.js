// worldgen/noise.js
// ───────────────────────────────────────────────────────────────────────────
// 种子可复现的 Perlin / 梯度噪声 + 分形叠加（fBm）。
// 所有实现按「绝对世界坐标」求值，与噪声场的采样顺序无关，
// 因此区块无论以什么顺序生成，得到的噪声值都完全一致（验收 §12.1 / §12.2）。
// ───────────────────────────────────────────────────────────────────────────
import { mixSeed, hash1, hash2 } from './rng.js';

const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/* 一维梯度噪声：在整数格点取确定性「梯度值」，平滑插值。范围约 [-1,1]。 */
export function makeNoise1D(seed){
  const g = x => (hash1(seed >>> 0, x | 0) / 4294967296) * 2 - 1;
  return function(x){
    const xi = Math.floor(x), xf = x - xi;
    const u = fade(xf);
    return lerp(g(xi), g(xi + 1), u);
  };
}

/* 二维梯度噪声：8 向梯度点乘。范围约 [-1,1]。 */
const G2 = [[1,0],[-1,0],[0,1],[0,-1],[0.7071,0.7071],[-0.7071,0.7071],[0.7071,-0.7071],[-0.7071,-0.7071]];
export function makeNoise2D(seed){
  const gi = (x, y) => hash2(seed >>> 0, x | 0, y | 0) & 7;
  return function(x, y){
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const g00 = G2[gi(xi, yi)],     g10 = G2[gi(xi + 1, yi)];
    const g01 = G2[gi(xi, yi + 1)], g11 = G2[gi(xi + 1, yi + 1)];
    const n00 = g00[0]*xf + g00[1]*yf;
    const n10 = g10[0]*(xf-1) + g10[1]*yf;
    const n01 = g01[0]*xf + g01[1]*(yf-1);
    const n11 = g11[0]*(xf-1) + g11[1]*(yf-1);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
  };
}

/* fBm：多层噪声叠加。返回 (x) => [-1,1] 的一维函数。 */
export function makeFbm1D(baseSeed, { freq = 1, octaves = 3, persistence = 0.5, lacunarity = 2, salt = 0 } = {}){
  const n = makeNoise1D(mixSeed(baseSeed >>> 0, salt));
  return function(x){
    let amp = 1, sum = 0, norm = 0, f = freq;
    for (let o = 0; o < octaves; o++){ sum += amp * n(x * f); norm += amp; amp *= persistence; f *= lacunarity; }
    return sum / norm;
  };
}

/* fBm：返回 (x,y) => [-1,1] 的二维函数。 */
export function makeFbm2D(baseSeed, { freq = 1, octaves = 3, persistence = 0.5, lacunarity = 2, salt = 0 } = {}){
  const n = makeNoise2D(mixSeed(baseSeed >>> 0, salt));
  return function(x, y){
    let amp = 1, sum = 0, norm = 0, f = freq;
    for (let o = 0; o < octaves; o++){ sum += amp * n(x * f, y * f); norm += amp; amp *= persistence; f *= lacunarity; }
    return sum / norm;
  };
}
