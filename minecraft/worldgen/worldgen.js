// worldgen/worldgen.js
// ───────────────────────────────────────────────────────────────────────────
// 世界生成管理器：按需生成区块、按需卸载、存档只保存「被玩家改动的区块」。
//
// 生成顺序无关性（验收 §12.1）：
//   · 地形/洞穴/矿石/结构都只依赖「绝对坐标 + 种子」的纯函数；
//   · 树木等跨区块装饰由「拥有者区块」产生，通过 outgoing 队列转发；
//     目标区块若已生成 → 直接空填（只填空气）；若未生成 → 进入 pendingIn，等它生成时合并。
//   · 两种路径都是「只填空气」，且每棵树只被一个区块拥有（树根间距 ≥ 6），
//     因此无论生成顺序如何，最终方块逐格一致。
//
// 性能：本实现采用「时间片」分帧生成（每帧最多 MAX_CHUNKS_PER_TICK 个区块、
// 或累计 WORLDGEN_BUDGET_MS 毫秒）。规格书允许在架构不支持时用时间片替代 Web Worker。
// ───────────────────────────────────────────────────────────────────────────
import {
  CHUNK_W, WORLD_HEIGHT, WORLD_MAX_Y, WORLD_MIN_Y, SEA_LEVEL, BEDROCK_TOP,
  RENDER_DISTANCE, UNLOAD_DISTANCE, WORLDGEN_BUDGET_MS, MAX_CHUNKS_PER_TICK,
  WORLD_TYPES, WORLDGEN_VERSION, CHUNK_STATE, CAVES, DEEPSLATE_BAND, LAVA_DEPTH,
} from './constants.js';
import { toSeed, mixSeed, hash1, hash2, rand01 } from './rng.js';
import { Chunk } from './chunk.js';
import { makeTerrain } from './terrain.js';
import { makeCaves, CAVE_REPLACEABLE } from './caves.js';
import { makeOres } from './ores.js';
import { makeDecorations } from './decorations.js';
import { makeStructures } from './structures.js';

/* 全局固定调色板：名字 → 索引。所有区块共用，索引语义稳定（存档/跨区块写入都依赖它）。 */
export const WG_PALETTE = [
  'air','bedrock','stone','deepslate','andesite','diorite','granite','tuff','gravel',
  'dirt','coarse_dirt','grass_block','sand','sandstone','red_sand','clay',
  'water','ice','lava','snow_block','snow',
  'coal_ore','iron_ore','copper_ore','gold_ore','redstone_ore','lapis_ore','diamond_ore','emerald_ore',
  'deepslate_coal_ore','deepslate_iron_ore','deepslate_copper_ore','deepslate_gold_ore',
  'deepslate_redstone_ore','deepslate_lapis_ore','deepslate_diamond_ore','deepslate_emerald_ore',
  'oak_log','oak_leaves','birch_log','birch_leaves','spruce_log','spruce_leaves',
  'acacia_log','acacia_leaves','jungle_log','jungle_leaves',
  'dead_bush','cactus','sugar_cane','lily_pad','vine','kelp','seagrass',
  'short_grass','fern','dandelion','poppy','pumpkin','melon',
  'rail','spider_web','chest','oak_planks',
];
const NAME_TO_ID = new Map(WG_PALETTE.map((n, i) => [n, i]));

/* 地表方块：挖开地表形成洞口时，只挖这些「地面」方块。 */
const GROUND_SURFACE = new Set(['grass_block','dirt','coarse_dirt','sand','sandstone','snow_block','gravel','podzol']);

/* 存档用的 RLE（与旧版 game.js 的 rle/unrle 同格式）。 */function rle(arr){
  const out = []; let run = arr[0] | 0, count = 1;
  for (let i = 1; i < arr.length; i++){
    const v = arr[i] | 0;
    if (v === run && count < 65535) count++;
    else { out.push(run, count); run = v; count = 1; }
  }
  out.push(run, count);
  return out;
}
function unrle(flat, length, Type = Uint16Array){
  if (!Array.isArray(flat) || flat.length % 2) throw Error('存档方块压缩数据损坏');
  const out = new Type(length); let o = 0;
  for (let i = 0; i < flat.length; i += 2){
    const v = flat[i], n = flat[i+1];
    if (!Number.isInteger(v) || v < 0 || !Number.isInteger(n) || n < 1 || o + n > length) throw Error('存档方块压缩数据损坏');
    out.fill(v, o, o + n); o += n;
  }
  if (o !== length) throw Error('存档方块压缩长度损坏');
  return out;
}

export class WorldGen {
  constructor(seed, worldType = 'default', options = {}){
    this.seed = String(seed);
    this.seedInt = toSeed(seed);
    this.worldType = (typeof worldType === 'string') ? (WORLD_TYPES[worldType] || WORLD_TYPES.default) : { ...WORLD_TYPES.default, ...worldType };
    this.worldgenVersion = WORLDGEN_VERSION;
    this.chunks = new Map();       // cx → Chunk
    this.pendingIn = new Map();    // cx → 待合并的跨区块写入
    this.savedChunks = new Map();  // cx → 从存档读入的差异（覆盖生成结果）
    /* 调色板可以由调用方扩展（游戏层要把 1300 多个方块也塞进来）。
     * 默认仍是 worldgen 自己的 WG_PALETTE —— 纯逻辑层不依赖游戏。 */
    this.palette = options.palette || WG_PALETTE;
    this.nameToId = options.nameToId || NAME_TO_ID;

    this.terrain = makeTerrain(this.seedInt, this.worldType);
    this.caves = makeCaves(this.seedInt, this.worldType.caves !== false);
    /* 矿石可以单独关掉（用于「纯净地形」对照，以及验收时证明
       「矿石只替换石头类、不动泥土/沙子/水」）。 */
    this.ores = options.ores === false ? { generate(){} } : makeOres(this.seedInt);
    this.decor = makeDecorations(this.seedInt);
    this.structures = makeStructures(this.seedInt, this.worldType);
  }

  /* ── 区块生成 ───────────────────────────────────────────────────────── */
  generateChunk(cx){
    const chunk = new Chunk(cx, this.palette, this.nameToId);
    this.chunks.set(cx, chunk);

    // 1) TERRAIN：基础地形 + 地层 + 海洋 + 河流湖泊 + 雪冰
    chunk.state = CHUNK_STATE.TERRAIN;
    for (let x = chunk.x0; x <= chunk.x1; x++){
      this.terrain.buildColumn(x, (y, name) => chunk.set(x, y, name));
    }

    // 2) CARVED：洞穴（蠕虫 / 大空洞 / 竖井 / 洞口竖井），不穿基岩、不破海底
    chunk.state = CHUNK_STATE.CARVED;
    this.carve(chunk);

    // 3) 矿石（放在洞穴之后：被挖空的格子自然不会有矿）
    this.ores.generate(this.adapter(chunk));

    /* 3.5) 合并「先前邻居写给我」的跨区块数据（只填空气）。
     * ★ 必须放在地形/洞穴/矿石之后：地形构建会把整列从 0 写到最后，
     *   如果在这里合并，树叶会被后面的地形重写成空气 → 乱序生成结果不一致。 */
    const inbound = this.pendingIn.get(cx);
    if (inbound){
      for (const w of inbound) chunk.setIfAir(w.x, w.y, w.name);
      this.pendingIn.delete(cx);
    }

    /* 3.6) 旧存档覆盖层：把旧地图的格子贴回来（只贴旧地图有的格子，
     *       其余格子保持生成结果 → 世界连续，没有悬空的空腔）。
     *       放在装饰之前：老地形上照样能长树、长草。 */
    if (this.legacyOverlay) this.applyLegacyOverlay(chunk);

    // 4) DECORATED：树木、植物、结构（超平坦没有群系 → 不生成）
    chunk.state = CHUNK_STATE.DECORATED;
    if (this.worldType.biomes !== false){
      this.decor.generate(this.adapter(chunk));
      this.structures.generate(this.adapter(chunk));
    }

    // 5) 应用存档差异（玩家改动过的区块：存档优先于生成结果）
    const saved = this.savedChunks.get(cx);
    if (saved){
      chunk.blocks.set(saved.blocks);
      if (saved.natural) chunk.natural.set(saved.natural);
      chunk.modified = true;
    }

    chunk.state = CHUNK_STATE.FULL;

    // 6) 转发本区块产生的跨区块写入
    for (const w of chunk.outgoing){
      const target = this.chunks.get(w.cx);
      if (target){
        // 邻居已生成 → 直接合并（只填空气）
        target.setIfAir(w.x, w.y, w.name);
        if (w.cx !== cx) target.markModified && 0;   // 装饰写入不算玩家改动
      } else {
        // 邻居未生成 → 排队，等它生成时合并
        if (!this.pendingIn.has(w.cx)) this.pendingIn.set(w.cx, []);
        this.pendingIn.get(w.cx).push(w);
      }
    }
    chunk.outgoing.length = 0;
    return chunk;
  }

  /* 某一列的「洞穴计划」：地表高度、是否落在裂隙里、是否有洞口竖井。
   * ★ 纯函数：carve() 与 findSpawn() 都用它 —— 前者真的挖，后者只是「提前避开」，
   *   两边判定必须一致，否则会出现「出生点算出来是地面、挖完就不是了」。 */
  cavePlanAt(x){
    const surf = this.terrain.surfaceY(x);
    const rav = this.caves.ravineAt(x);
    const inRavine = !!(rav && x >= rav.x0 && x <= rav.x1);
    // 洞口竖井：保证约每 100 格能找到一个洞口
    let shaft = null;
    if (rand01(hash2(mixSeed(this.seedInt, 4242), x, 9)) < CAVES.entranceChance){
      for (let y = surf - 2; y > Math.max(BEDROCK_TOP, surf - CAVES.entranceMaxDepth); y--){
        if (this.caves.isCaveAt(x, y)){ shaft = y; break; }
      }
    }
    return { surf, inRavine, shaft, rav };
  }

  /* 洞穴雕刻。护栏：基岩不切、地表 3 格内不切（除非竖井/洞口）、上方有水不切。 */
  carve(chunk){
    const caves = this.caves;
    for (let x = chunk.x0; x <= chunk.x1; x++){
      const { surf, inRavine, shaft, rav } = this.cavePlanAt(x);
      // 裂隙：顶端贴近地表（贯通到地表形成洞口），底端有深度上限（不掏空整个地层）
      const ravTop = inRavine ? Math.min(WORLD_MAX_Y - 1, surf - 1) : -1;
      const ravBot = inRavine ? Math.max(BEDROCK_TOP + 1, surf - 1 - rav.depth) : -1;
      /* ★ 只扫到地表为止：洞穴本来就在地下，竖井/裂隙的顶端也只到 surf-1。
         *   原来扫到 255，每列白算 150 多个格子的噪声（洞穴阶段占了整个区块
         *   生成耗时的 70%）。砍掉之后每区块省 ~2ms。 */
      for (let y = BEDROCK_TOP + 1; y <= surf; y++){
        let hit = caves.isCaveAt(x, y);
        if (!hit && inRavine && y >= ravBot && y <= ravTop) hit = true;
        if (!hit && shaft !== null && y >= shaft && y <= surf - 1) hit = true;
        if (!hit) continue;
        // 地表保护：非竖井时地表 3 格内不挖（保持地表连续、不产生悬空）
        if (!inRavine && shaft === null && y > surf - 3) continue;
        const cur = chunk.get(x, y);
        if (!CAVE_REPLACEABLE.has(cur)) continue;
        // 海洋漏水护栏：上方（含）有任何水就不挖
        if (y <= SEA_LEVEL + CAVES.oceanLeakGuard){
          let wet = false;
          for (let yy = y + 1; yy <= Math.min(SEA_LEVEL + CAVES.oceanLeakGuard, WORLD_MAX_Y); yy++){
            if (chunk.get(x, yy) === 'water'){ wet = true; break; }
          }
          if (wet) continue;
        }
        chunk.set(x, y, y <= LAVA_DEPTH ? 'lava' : 'air');   // 底部岩浆
      }

      // 洞口/裂隙要真正「打通地表」：把地表的草/土/沙那一格挖掉，形成入口。
      // 否则地表方块会悬空（下面被挖空、上面是空气），既不真实也违反验收 §12.4。
      if ((shaft !== null || inRavine) && chunk.get(x, surf) !== 'air' && chunk.get(x, surf + 1) === 'air'){
        const g = chunk.get(x, surf);
        if (GROUND_SURFACE.has(g)) chunk.set(x, surf, 'air');
      }
    }
  }

  /* 统一的适配器：把区块暴露成各生成器需要的形状。 */
  adapter(chunk){
    const self = this;
    return {
      cx: chunk.cx, x0: chunk.x0, x1: chunk.x1,
      get: (x, y) => chunk.get(x, y),
      set: (x, y, name) => chunk.set(x, y, name),
      surfaceY: (x) => self.terrain.surfaceY(x),
      groundY: (x) => self.terrain.groundY(x),
      waterSurfaceY: (x) => self.terrain.waterSurfaceY(x),
      biomeAt: (x) => self.terrain.biomeAt(x),
      plant: (x, y, name) => {
        if (x >= chunk.x0 && x <= chunk.x1){
          if (chunk.get(x, y) === 'air'){
            chunk.set(x, y, name);
            if (/(_log|_leaves)$/.test(name)) chunk.setNatural(x, y, 1);
          }
        } else {
          chunk.outgoing.push({ cx: Math.floor(x / CHUNK_W), x, y, name });
        }
      },
    };
  }

  /* ── 访问 ───────────────────────────────────────────────────────────── */
  getChunk(cx){ return this.chunks.get(cx) || this.generateChunk(cx); }
  hasChunk(cx){ return this.chunks.has(cx); }

  /* 调色板索引（热路径）。游戏层每帧要读几千格，走索引比走名字快一个数量级。 */
  getIndex(x, y){
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return 0;
    const cx = Math.floor(x / CHUNK_W);
    const c = this.getChunk(cx);
    return c.idAt(x, y);
  }

  /* 「世界自带的树」标记（1 = 玩家可以穿过去）。 */
  naturalAt(x, y){
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return 0;
    const cx = Math.floor(x / CHUNK_W);
    const c = this.getChunk(cx);
    return c.naturalAt(x, y);
  }

  get(x, y){
    if (y < WORLD_MIN_Y || y > WORLD_MAX_Y) return 'air';
    const cx = Math.floor(x / CHUNK_W);
    const c = this.getChunk(cx);
    return c.get(x, y);
  }
  /* 玩家改动：写进区块并标记为「已修改」（决定是否进存档）。 */
  set(x, y, name){
    const cx = Math.floor(x / CHUNK_W);
    const c = this.getChunk(cx);
    c.set(x, y, name);
    c.setNatural(x, y, 0);
    c.markModified();
  }
  surfaceY(x){ return this.terrain.surfaceY(x); }
  biomeAt(x){ return this.terrain.biomeAt(x); }
  tagAt(x){ return this.terrain.tagAt(x); }

  /* ── 流式加载 / 卸载 ────────────────────────────────────────────────── */
  /* 以玩家所在区块为中心，保证左右各 RENDER_DISTANCE 个区块存在。
   * 每帧最多生成 MAX_CHUNKS_PER_TICK 个，累计不超过 WORLDGEN_BUDGET_MS 毫秒。 */
  update(playerX, nowMs = 0){
    const pcx = Math.floor(playerX / CHUNK_W);
    const start = nowMs || (typeof performance !== 'undefined' ? performance.now() : 0);
    let made = 0;
    // 按「离玩家由近到远」的顺序生成，优先玩家前进方向
    const wanted = [];
    for (let d = 0; d <= RENDER_DISTANCE; d++){
      wanted.push(pcx + d, pcx - d);
    }
    for (const cx of wanted){
      if (this.chunks.has(cx)) continue;
      if (made >= MAX_CHUNKS_PER_TICK) break;
      const t = (typeof performance !== 'undefined' ? performance.now() : 0);
      if (made > 0 && t - start > WORLDGEN_BUDGET_MS) break;
      this.generateChunk(cx);
      made++;
    }
    // 卸载超出 UNLOAD_DISTANCE 的区块
    for (const [cx, chunk] of this.chunks){
      if (Math.abs(cx - pcx) > UNLOAD_DISTANCE){
        if (chunk.modified) this.savedChunks.set(cx, { blocks: chunk.blocks.slice(), natural: chunk.natural.slice() });
        this.chunks.delete(cx);
      }
    }
    return made;
  }

  /* ── 存档 ───────────────────────────────────────────────────────────── */
  /* 内存里 savedChunks 存的永远是「解包后的数组」；只有在写 JSON 时才 RLE 压缩。
   * （早前把 RLE 数组直接存进 savedChunks，读取时当成数组 set 进区块 → 存档内容错乱。） */
  serializeChunk(chunk){
    return { blocks: rle(Array.from(chunk.blocks)), natural: rle(Array.from(chunk.natural)) };
  }
  /* 只保存被玩家改动的区块（规格书 §1.1）。 */
  serializeChanges(){
    const chunks = {};
    for (const [cx, chunk] of this.chunks) if (chunk.modified) chunks[cx] = this.serializeChunk(chunk);
    for (const [cx, data] of this.savedChunks){
      if (cx in chunks) continue;
      chunks[cx] = { blocks: rle(Array.from(data.blocks)), natural: data.natural ? rle(Array.from(data.natural)) : null };
    }
    return { chunks };
  }
  loadChanges(data){
    if (!data || !data.chunks) return;
    for (const [cx, d] of Object.entries(data.chunks)){
      const c = Number(cx);
      const blocks = unrle(d.blocks, CHUNK_W * WORLD_HEIGHT, Uint16Array);
      const natural = d.natural ? unrle(d.natural, CHUNK_W * WORLD_HEIGHT, Uint8Array) : null;
      this.savedChunks.set(c, { blocks, natural });
      const existing = this.chunks.get(c);
      if (existing){ existing.blocks.set(blocks); if (natural) existing.natural.set(natural); existing.modified = true; }
    }
  }
  /* 导入旧版「整张地图」存档（规格书 §1.1 / §10 的老存档兼容）。
   * ★ 旧存档里的方块 id 是「游戏方块表（BLOCKS）」的下标，不是 worldgen 的调色板下标。
   *   所以必须由调用方给出换算函数 mapIndex(旧 id) → 新调色板下标；
   *   不给就按「已经是调色板下标」处理（worldgen 自测用）。
   *
   * ★ 为什么用「覆盖层」而不是「整块替换区块」：
   *   旧地图只有 144~256 行高、宽度也有限（最老的是 384×144）。
   *   如果按整块替换，那些区块里旧地图之外的部分会变成空气 →
   *   地下出现一个巨大的空腔、旧世界底部悬空（违反验收 §12.4 的边界合法性）。
   *   覆盖层的做法是：旧地图有的格子用旧值，没有的格子照常生成 → 世界是连续的。
   *
   * ★ 坐标：调用方传进来的 blocks 已经是「worldgen 坐标（y 向上）」，
   *   行 0 = 旧地图的最底一行。 */
  importLegacyMap(blocks, natural, width, height, mapIndex){
    const map = mapIndex || ((v) => v);
    const h = Math.min(height, WORLD_HEIGHT);
    const ov = {
      blocks: new Uint16Array(width * h),
      natural: new Uint8Array(width * h),
      width, height: h,
    };
    for (let y = 0; y < h; y++){
      for (let x = 0; x < width; x++){
        const v = blocks[y * width + x] | 0;
        const p = map(v);
        ov.blocks[y * width + x] = (p >= 0 && p < this.palette.length) ? p : 0;
        if (natural) ov.natural[y * width + x] = natural[y * width + x] | 0;
      }
    }
    this.legacyOverlay = ov;
  }

  /* 把旧存档的覆盖层贴进本区块（只覆盖旧地图真正有的格子）。 */
  applyLegacyOverlay(chunk){
    const ov = this.legacyOverlay;
    if (!ov) return;
    for (let y = 0; y < ov.height; y++){
      for (let lx = 0; lx < CHUNK_W; lx++){
        const x = chunk.cx * CHUNK_W + lx;
        if (x >= ov.width) break;
        chunk.blocks[y * CHUNK_W + lx] = ov.blocks[y * ov.width + x];
        chunk.natural[y * CHUNK_W + lx] = ov.natural[y * ov.width + x];
      }
    }
    chunk.markModified();
  }

  /* ── 出生点 ─────────────────────────────────────────────────────────── */
  /* 在种子决定的位置寻找一个「地表为草/沙、非水下」的位置（验收 §12.9）。
   * ★ 返回的 y 是「地面方块所在的那一格」（worldgen 的 y 向上：y=0 是基岩）。
   *   站立的坐标由调用方按自己的坐标约定换算 —— 这里不替你决定「玩家脚底离地几格」，
   *   否则换一个坐标约定就会差两格（这正是早期版本把玩家埋进地里的原因）。
   * ★ 全程不生成区块：地表方块名由 terrain.surfaceBlockAt(x) 纯函数给出。
   *   否则为了找一个出生点要生成上百个区块，开局会卡好几秒。 */
  findSpawn(){
    const OK_SURFACE = new Set(['grass_block','sand','snow_block','podzol','coarse_dirt']);
    /* 起点由种子决定（不是永远从 x=0 开始），否则每个世界的出生点都在最左边，
       看起来像是「世界有个左边界」。 */
    const start = Math.floor(rand01(hash1(mixSeed(this.seedInt, 7777), 0)) * 4096);
    const groundY = (x) => this.terrain.groundY(x);
    const biomeAt = (x) => this.biomeAt(x);
    const densityAt = (x) => this.decor.densityAt(x, biomeAt);
    const isTreeBase = (x) => this.decor.isTreeBase(x, biomeAt, densityAt);
    for (let i = 0; i < 4096; i++){
      const x = (start + i) % 4096;
      const b = biomeAt(x);
      if (b.isOcean) continue;
      const y = groundY(x);            // 实际地面（河流/湖泊会把它下切）
      if (y <= BEDROCK_TOP) continue;
      if (!OK_SURFACE.has(this.terrain.surfaceBlockAt(x))) continue;
      if (this.terrain.waterSurfaceY(x) >= 0) continue;   // 泡在水里 → 不算
      /* 洞口竖井 / 裂隙会把地表那一格挖掉 → 那儿已经不是「地面」了。 */
      const plan = this.cavePlanAt(x);
      if (plan.inRavine || plan.shaft !== null) continue;
      /* 出生点正上方不能是树干，否则玩家一出生就被卡在树里。
         ★ 丛林巨木是 2 格宽的树干（占 base 与 base+1 两列），
           所以 base+1 那一列虽然不是「树根」，头顶照样是树干 —— 也要排除。 */
      if (isTreeBase(x) || isTreeBase(x - 1)) continue;
      /* 也不能落在村庄木屋里（地板是木板，头顶是木墙）。 */
      if (this.structures.spawnBlocked(x, groundY, biomeAt)) continue;
      return { x, y };
    }
    return { x: 0, y: SEA_LEVEL };
  }
}

export { NAME_TO_ID };
