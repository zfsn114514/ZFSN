// worldgen/rng.js
// ───────────────────────────────────────────────────────────────────────────
// 确定性随机：同一个种子、同一个坐标，永远得到同一个结果，且与「生成了哪些区块 /
// 生成顺序」无关。禁止在区块生成里直接调用 Math.random()。
//
// 提供：
//   hashStrToSeed(str)   字符串种子 → 32 位整数
//   mixSeed(base, salt)  由基础种子 + 盐 派生互不相关的子种子（气候/地形/洞穴/矿石…）
//   mulberry32(seed)     经典 32 位 PRNG，返回 () => [0,1)
//   hash2(seed,x,y)      坐标哈希 → uint32（逐列/逐块随机决策用）
//   hash1(seed,x)        一维坐标哈希 → uint32
//   rand01(uint32)       uint32 → [0,1)
// ───────────────────────────────────────────────────────────────────────────

const U32 = 0x100000000;

/* FNV-1a 字符串 → uint32（用于把 "ZFSN" 或任意种子串变成整数）。 */
export function hashStrToSeed(str){
  let h = 2166136261 >>> 0;
  const s = String(str);
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* 32 位整数种子也接受（数值直接取低位）。 */
export function toSeed(seed){
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  return hashStrToSeed(seed);
}

/* 由基础种子 + 盐派生子种子。使用 xmur3 风格的混合，保证各盐之间互不相关。 */
export function mixSeed(base, salt){
  let h = (base >>> 0) ^ Math.imul(salt >>> 0, 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  h ^= h >>> 16;
  return h >>> 0;
}

/* mulberry32：简单、快、确定性好。 */
export function mulberry32(seed){
  let a = seed >>> 0;
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* 整数哈希（基于 Wang / Murmur 混合），用于坐标哈希。 */
function ihash(n){
  n = n >>> 0;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = n ^ (n >>> 16);
  return n >>> 0;
}

/* 二维坐标哈希 → uint32。x,y 可负，先规整到无符号。 */
export function hash2(seed, x, y){
  const sx = (x >= 0 ? x : (-x) * 2 + 1) >>> 0;
  const sy = (y >= 0 ? y : (-y) * 2 + 1) >>> 0;
  let h = (seed >>> 0) ^ 0x811C9DC5;
  h = Math.imul(h ^ sx, 0x9E3779B1);
  h = Math.imul(h ^ sy, 0x85EBCA6B);
  h ^= h >>> 13;
  h = Math.imul(h, 0xC2B2AE35);
  h ^= h >>> 16;
  return ihash(h) >>> 0;
}

/* 一维坐标哈希 → uint32。 */
export function hash1(seed, x){
  return hash2(seed, x, 0x5bd1e995);
}

/* uint32 → [0,1)。 */
export function rand01(u32){
  return (u32 >>> 0) / U32;
}

/* 基于坐标哈希的随机浮点 [0,1)。 */
export function rand2(seed, x, y){ return rand01(hash2(seed, x, y)); }
export function rand1(seed, x){ return rand01(hash1(seed, x)); }
