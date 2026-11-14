// worldbridge.js —— worldgen 纯逻辑层 与 游戏方块表 之间的适配层
// ─────────────────────────────────────────────────────────────────────────────
// 为什么要单独一层？worldgen/ 目录必须保持「不依赖游戏、可被 node 直接 import、
// 不碰 DOM」的纯逻辑特性（规格书 §0），而游戏层要用 BLOCKS 的数字下标、
// 2D 侧视的坐标习惯。两边有四处不一致，全部收在这里：
//
//   1) 方块身份：worldgen 用「名字 + 自己的调色板」，游戏用 BLOCKS 的下标。
//   2) 名字对不上：grass_block ↔ grass_block_side、water ↔ water_still、
//      spider_web ↔ cobweb。
//   3) Y 轴方向：★ 最重要的一个。
//        worldgen：y 向上。y=0 是基岩，SEA_LEVEL=63，地表在 63~120。
//        游戏：    y 向下。y=0 是天空，y=255 是基岩（2D 侧视，重力 +y）。
//      适配层统一按 gameY = WG_HEIGHT-1 - wgY 换算。
//      为什么不反过来改 worldgen？因为整套 worldgen + 26 项测试都是按
//      「y 向上」写的（那也是 Java 版和规格书的约定），倒过来要重写 8 个文件、
//      几百行、并把 26 项测试全部翻面 —— 收益远小于风险。
//      代价是：所有跨层调用都必须经过本文件的换算函数，不能直接用 wg 的 y。
//
//   4) X 轴：游戏原本只有 4096 格宽，worldgen 是无限的。
//
// 本模块不 import 游戏代码，也不碰 DOM —— node 测试可以直接用。
// ─────────────────────────────────────────────────────────────────────────────
import { WG_PALETTE } from './worldgen/worldgen.js';
import { WORLD_HEIGHT } from './worldgen/constants.js';

/* ── 名字别名：worldgen 名 → 游戏方块 id ─────────────────────────────── */
export const WG_ALIAS_TO_GAME = {
  grass_block: 'grass_block_side',   // 游戏的草方块 id 叫 grass_block_side（老存档依赖）
  water: 'water_still',              // 游戏里水的 id 是 water_still（老存档依赖）
  spider_web: 'cobweb',              // 目录里的名字是 cobweb
};
/* 反向：游戏方块 id → worldgen 名 */
export const WG_ALIAS_FROM_GAME = Object.fromEntries(
  Object.entries(WG_ALIAS_TO_GAME).map(([wg, game]) => [game, wg]),
);

/* ── worldgen 需要、但游戏 BLOCKS 表里没有的方块 ─────────────────────
 * 原因：目录脚本只把「整方块（cube）」加进 BLOCKS（见 game.js 顶部），
 * 而草、花、蘑菇、仙人掌、铁轨、蜘蛛网这些在原版里不是整方块，只进了 ITEMS。
 * 地形生成要往世界里写它们，所以必须补进 BLOCKS。
 * ★ 全部追加在表尾 —— 不动任何既有下标 → 老存档的方块 id 仍然有效。
 * ★ solid=false 的都是「装饰」：不挡路，可以被水冲掉，可以被火把替换。 */
export const WG_EXTRA_BLOCKS = [
  { id:'cobweb',     name:'蜘蛛网',     hard:.4,  solid:false },
  { id:'snow',       name:'雪',         hard:.2,  solid:false },
  { id:'short_grass',name:'草',         hard:.1,  solid:false },
  { id:'fern',       name:'蕨',         hard:.1,  solid:false },
  { id:'dandelion',  name:'蒲公英',     hard:.1,  solid:false },
  { id:'poppy',      name:'虞美人',     hard:.1,  solid:false },
  { id:'dead_bush',  name:'枯萎的灌木', hard:.1,  solid:false },
  { id:'sugar_cane', name:'甘蔗',       hard:.1,  solid:false },
  { id:'vine',       name:'藤蔓',       hard:.2,  solid:false },
  { id:'lily_pad',   name:'睡莲',       hard:.1,  solid:false },
  { id:'kelp',       name:'海带',       hard:.1,  solid:false },
  { id:'seagrass',   name:'海草',       hard:.1,  solid:false },
  { id:'cactus',     name:'仙人掌',     hard:.4,  solid:false },
  { id:'rail',       name:'铁轨',       hard:.1,  solid:false },
  { id:'chest',      name:'箱子',       hard:.5,  tool:'axe' },
];

/* 装饰类方块：渲染时按「薄片/植物」画，不占满整格。 */
export const WG_DECOR = new Set([
  'short_grass','fern','dandelion','poppy','dead_bush','sugar_cane','vine','lily_pad','kelp','seagrass',
]);
/* 薄片类：画在所在格子的下沿（像原版的雪层/铁轨贴在地面上）。 */
export const WG_THIN_LAYER = new Set(['snow','rail']);

/* ── Y 轴换算 ────────────────────────────────────────────────────────── */
export const WG_HEIGHT = WORLD_HEIGHT;
/** worldgen 的 y → 游戏的 y（y 向上 → y 向下） */
export function toGameY(wgY){ return WG_HEIGHT - 1 - wgY; }
/** 游戏的 y → worldgen 的 y */
export function toWgY(gameY){ return WG_HEIGHT - 1 - gameY; }

/* ── 调色板构建 ─────────────────────────────────────────────────────────
 * 完整调色板 = worldgen 自己的 61 个名字 + 游戏 BLOCKS 里其余方块的 id。
 * 索引语义必须稳定（存档、跨区块写入都依赖它），所以：
 *   · worldgen 的名字永远排在前，顺序固定；
 *   · 游戏方块按 BLOCKS 的顺序追加，顺序也固定；
 *   · 调色板内容变化时 paletteHash 会变 → 存档可以据此提示「需要迁移」。 */
export function buildPalette(BLOCKS){
  const palette = WG_PALETTE.slice();
  const seen = new Set(palette);
  // 别名的「目标」（grass_block_side 等）已经被 worldgen 的名字代表，不再重复入表
  const aliasTargets = new Set(Object.values(WG_ALIAS_TO_GAME));
  for (const b of BLOCKS){
    if (seen.has(b.id) || aliasTargets.has(b.id)) continue;
    seen.add(b.id);
    palette.push(b.id);
  }
  const nameToId = new Map(palette.map((n, i) => [n, i]));

  // 调色板下标 → 游戏方块下标
  /* ★ 用「首次出现」的下标（和 BLOCKS.findIndex 语义一致）：
     BLOCKS 表里 obsidian 有两条（239 与 397，目录里已有一条、后面又手推了一条）。
     游戏里 LAVA_ID/OBSIDIAN_ID 都是用 findIndex 取的（=239），
     这里若用「后出现的」就会把黑曜石读成 397，与各处不一致。 */
  const blockIndex = new Map();
  BLOCKS.forEach((b, i) => { if (!blockIndex.has(b.id)) blockIndex.set(b.id, i); });
  const toBlock = new Uint16Array(palette.length);
  const missing = [];
  for (let i = 0; i < palette.length; i++){
    const name = palette[i];
    const target = WG_ALIAS_TO_GAME[name] || name;
    const bi = blockIndex.get(target);
    if (bi === undefined){ missing.push(name); toBlock[i] = 0; continue; }
    toBlock[i] = bi;
  }
  if (missing.length) throw Error(`worldbridge: 调色板里有游戏不认识的方块：${missing.join(', ')}`);

  // 游戏方块下标 → worldgen 名
  const toName = new Array(BLOCKS.length).fill(null);
  for (let i = 0; i < BLOCKS.length; i++){
    const id = BLOCKS[i].id;
    toName[i] = WG_ALIAS_FROM_GAME[id] || id;
    if (!nameToId.has(toName[i])) throw Error(`worldbridge: 方块 ${id} 没有对应的 worldgen 名`);
  }

  return { palette, nameToId, toBlock, toName, missing };
}

/* 调色板指纹：内容变了就变。存档头里存它，用来判断老存档还能不能直接读。 */
export function paletteHash(palette){
  let h = 2166136261;
  for (const n of palette){
    h ^= n.length;
    for (let i = 0; i < n.length; i++){ h = Math.imul(h ^ n.charCodeAt(i), 16777619); }
    h = Math.imul(h ^ (h >>> 13), 16777619);
  }
  return (h >>> 0).toString(36);
}
