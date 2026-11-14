// worldgen/constants.js
// ───────────────────────────────────────────────────────────────────────────
// 所有地形生成的可调参数集中在这里。不要在其他文件里写魔法数字。
// 数值来源在注释里标注；凡是我凭记忆给的量级，标注「[估算]」并说明，方便后续对照 Java 1.20 校正。
//
// 世界高度：本实现采用规格书允许的回退方案 —— 256 格高（Y 0~255），
// 海平面 SEA_LEVEL=63，基岩在 Y=0 附近。原因：现有渲染/方块表按 256 高设计，
// 且规格书第 5 节矿石表明确以「基岩为 Y=0 的 256 高度世界」为基准。
// 若要切到 Java 版全高（-64~320），改 WORLD_MIN_Y/WORLD_MAX_Y 并把所有深度换算成相对基岩的偏移即可，
// 矿石表里的「Y 范围」是按基岩=0 给的，已与 256 高度对齐。
// ───────────────────────────────────────────────────────────────────────────

/* 世界尺寸（Y 固定 256，X 无限）。 */
export const WORLD_HEIGHT      = 256;
export const WORLD_MIN_Y       = 0;
export const WORLD_MAX_Y       = WORLD_HEIGHT - 1;   // 255
export const SEA_LEVEL         = 63;
export const BEDROCK_TOP       = 4;                 // Y 0 全封，1~3 随机渐变
export const DEEPSLATE_BAND    = 16;                // 最底部 16 格为深板岩渐变带
export const LAVA_DEPTH        = 12;                // Y <= LAVA_DEPTH 的洞穴填岩浆

/* 区块。2D 版建议宽 16 列、高为整个世界高度。 */
export const CHUNK_W           = 16;
export const CHUNK_H           = WORLD_HEIGHT;

/* 加载 / 卸载 */
export const RENDER_DISTANCE   = 8;     // 玩家左右各 8 个区块
export const UNLOAD_DISTANCE   = RENDER_DISTANCE + 4;
export const WORLDGEN_BUDGET_MS= 4;     // 每帧生成耗时上限
export const MAX_CHUNKS_PER_TICK = 1;   // 每帧最多生成区块数（配合时间片）

/* 高度平滑 */
export const MAX_STEP          = 4;     // 相邻列最大高度差（平原/丘陵）
export const MAX_STEP_MOUNTAIN = 8;     // 山地放宽
export const BLEND_RADIUS      = 12;    // 群系地表参数混合半径（格）

/* 海岸线 / 海陆判定（唯一真源）。
 * 地形（terrain.rawHeight）和群系（biomes.baseBiomeAt）必须用同一个阈值，
 * 否则会出现「海洋群系 + 陆地高度」或「陆地群系 + 海底」的错位 ——
 * 表现就是海水凭空堆在平原上，或者海边出现没有水的干坑。
 *   continental < COAST      → 海洋
 *   continental < DEEP_COAST → 深海（约 20 格水深）
 * 另外 terrain.columnTop 还会按「实际地形是否低于海平面」补一次一致性校正。 */
export const COAST          = -0.12;
export const DEEP_COAST     = -0.55;
export const DEEP_OCEAN_DEPTH = 20;     // 水深超过该值显示为深海群系

/* 整数安全范围：超出给提示即可（规格书 §9）。 */
export const SAFE_X            = 2 ** 25;

/* ── 噪声参数（fBm）────────────────────────────────────────────────────── */
// 不同用途用不同子种子盐（见 rng.js 的 mixSeed），互不相关。
export const NOISE = {
  // 气候（一维，沿 X 轴）：决定群系
  temperature:    { freq: 1/700,  octaves: 2, persistence: 0.5, lacunarity: 2.0, salt: 11 },
  humidity:       { freq: 1/620,  octaves: 2, persistence: 0.5, lacunarity: 2.0, salt: 23 },
  continental:    { freq: 1/1100, octaves: 3, persistence: 0.55, lacunarity: 2.1, salt: 37 }, // 低频：海洋/陆地/内陆
  erosion:        { freq: 1/520,  octaves: 3, persistence: 0.55, lacunarity: 2.0, salt: 53 }, // 山地度/侵蚀
  // 地形
  continent_base: { freq: 1/1200, octaves: 4, persistence: 0.55, lacunarity: 2.2, salt: 71 }, // 大陆度起伏（极低频）
  hills:          { freq: 1/180,  octaves: 3, persistence: 0.5,  lacunarity: 2.0, salt: 89 }, // 丘陵（低频）
  detail:         { freq: 1/38,   octaves: 2, persistence: 0.5,  lacunarity: 2.0, salt: 101 },// 地表凹凸（高频）
  mountain:       { freq: 1/420,  octaves: 4, persistence: 0.6,  lacunarity: 2.3, salt: 113 },// 山地尖峰
  river:          { freq: 1/240,  octaves: 3, persistence: 0.6,  lacunarity: 2.0, salt: 131 },// 河流窄带（取 |noise| 近 0）
  lake:           { freq: 1/300,  octaves: 2, persistence: 0.5,  lacunarity: 2.0, salt: 149 },// 湖泊盆地
  // 洞穴（二维，按绝对坐标）
  cave_worm:     { freq: 1/12,   octaves: 3, persistence: 0.55, lacunarity: 2.0, salt: 167 },
  cave_cheese:   { freq: 1/30,   octaves: 2, persistence: 0.5,  lacunarity: 2.0, salt: 181 },
  cave_ravine:   { freq: 1/70,   octaves: 2, persistence: 0.5,  lacunarity: 2.0, salt: 199 },
  stone_blob:    { freq: 1/30,   octaves: 2, persistence: 0.5,  lacunarity: 2.0, salt: 211 }, // 地层大团块
};

/* ── 洞穴参数（2D 适配）────────────────────────────────────────────────── */
export const CAVES = {
  // ★ 阈值由「覆盖率标定」得出（见 tools/calibrate-caves 说明）：
  //   本实现的 2D fBm 实际取值范围只有约 [-0.35, 0.50]（多层平均后被压缩），
  //   所以阈值必须按覆盖率反推，不能想当然写 0.3（那会把 98% 的地下全挖空）。
  //   worm: freq=1/12, |n|<0.02 → 约 14% 覆盖，隧道宽约 2~4 格 ✔
  //   cheese: freq=1/30, n>0.26 → 约 2.6% 覆盖，洞室直径约 8~25 格 ✔
  wormThreshold:   0.02,   // |noise| < 该值 → 蜿蜒通道（2~4 格宽）
  wormWidth:       1.6,
  cheeseThreshold: 0.26,   // 低频噪声 > 该值 → 大洞室（直径 8~25）
  cheeseMinD:      4,      // 洞室半径下限（格）
  cheeseMaxD:      12,     // 洞室半径上限
  ravineChance:    0.0025, // 每列成为竖井起点的概率（约每 400 格 1 个）
  ravineWidth:     2.2,
  ravineMinDepth:  26,     // 裂隙最小深度
  ravineDepthRange:44,     // 裂隙深度随机范围（26~70 格）
  oceanLeakGuard:  3,      // 海平面以下该格数内、上方是水 → 不挖（防海洋灌入）
  enterDensity:    1,      // 保证约每 100 格内能找到洞口（通过阈值配合）
  entranceChance:  0.009,  // 每列成为「洞口竖井」起点的概率 ≈ 1/111 格（满足「走 100 格能遇到洞口」）
  entranceMaxDepth:34,     // 竖井向下寻找洞穴的最大距离
};

/* ── 矿石（Java 1.20 ore feature 基准，按基岩 Y=0 / 256 高世界）────────────
 * perChunk  = Java 每 16×16 区块的尝试次数（Minecraft Wiki「Ore distribution」）。
 * veinSize  = Java 一次生成的**矿块数量上限**（不是半径！旧注释把 17 当成半径，
 *             实际生成了半径 8 的圆盘，煤炭密度被放大到 9% —— 全屏都是煤）。
 *             本实现里这个字段改作 2D 圆盘半径，取值 1~3，视觉上仍是小矿脉。
 * perChunk2D= 本 2D 实现实际使用的「每区块尝试次数」，可以是小数。
 *
 * 换算（保持与 Java 相同的矿石占比）：
 *   Java 每区块矿块数 B = perChunk × veinSize(原版数量上限)
 *   Java 区块 16×16×384 = 98304 格；本 2D 区块 16×256 = 4096 格 → 比例 1/24
 *   单次 2D 矿脉平均面积 A（r=1 → 1 格，r=2 → 9 格，r=3 → 约 22 格）
 *   perChunk2D = (B / 24) / A
 * 由此煤炭约 14 块/区块、铁矿约 7.5 块/区块；按公式合计约 35 块/区块（理论 0.87%），
 * 实际地形有洞穴/泥土/砂砾，实测约 20~31 块/区块。
 * 来源：Minecraft Wiki「Ore distribution」(Java 1.20) + 本提示词第 5 节表格（标注 [估算] 处为提示词量级）。 */
export const ORE_SCALE = 1.0;
export const ORES = [
  // block = 石头里的矿石；deepBlock = 深板岩区对应变种。
  // perChunk  = Java 每区块尝试次数；veinSizeJava = 原版单次矿块数上限
  // veinSize  = 本 2D 圆盘半径（格）；perChunk2D = 本实现每区块尝试次数（可小数）
  { id:'coal',     block:'coal_ore',            deepBlock:'deepslate_coal_ore',     yMin:1,  yMax:130, center:70,  perChunk:20, veinSize:3, perChunk2D:0.65, note:'Java 1.20: 0~130，聚集 40~100；原版单次最多 17 块' },
  { id:'iron',     block:'iron_ore',            deepBlock:'deepslate_iron_ore',     yMin:1,  yMax:72,  center:24,  perChunk:20, veinSize:2, perChunk2D:0.83, note:'Java 1.20: 0~72（三角分布峰值 24）；山区 80~250 额外 → 见 ORE_EXTRA_IRON' },
  { id:'copper',   block:'copper_ore',          deepBlock:'deepslate_copper_ore',   yMin:1,  yMax:96,  center:48,  perChunk:16, veinSize:2, perChunk2D:0.74, note:'Java 1.20: 0~96，聚集 48 附近；原版单次最多 10 块' },
  { id:'gold',     block:'gold_ore',            deepBlock:'deepslate_gold_ore',     yMin:1,  yMax:32,  center:16,  perChunk:4,  veinSize:1, perChunk2D:1.50, note:'Java 1.20: 0~32；原版单次最多 9 块。r=1 只占 1 格，次数按块数直接折算' },
  { id:'redstone', block:'redstone_ore',        deepBlock:'deepslate_redstone_ore', yMin:1,  yMax:16,  center:8,   perChunk:8,  veinSize:2, perChunk2D:0.30, note:'Java 1.20: 0~16，聚集靠近基岩；原版单次最多 8 块' },
  { id:'lapis',    block:'lapis_ore',           deepBlock:'deepslate_lapis_ore',    yMin:1,  yMax:64,  center:16,  perChunk:2,  veinSize:1, perChunk2D:0.58, note:'Java 1.20: 0~64，聚集 16 附近；原版单次最多 7 块' },
  { id:'diamond',  block:'diamond_ore',         deepBlock:'deepslate_diamond_ore',  yMin:1,  yMax:16,  center:6,   perChunk:7,  veinSize:1, perChunk2D:2.33, note:'Java 1.20: 0~16，越深越多；原版单次最多 8 块' },
  { id:'emerald',  block:'emerald_ore',         deepBlock:'deepslate_emerald_ore',  yMin:4,  yMax:31,  center:16,  perChunk:0,  veinSize:1, perChunk2D:0,    note:'仅山地群系，单点随机（Java: 每区块 1 次）→ 见 ores.js 的山地分支' },
];
// 山区铁矿额外层（Java 1.20 山区 80~250）。仅当 biome.mountainous 时启用。
export const ORE_EXTRA_IRON = { id:'iron_extra', yMin:80, yMax:250, center:160, perChunk:20, veinSize:2, perChunk2D:0.54 };

/* 地层大团块（安山岩/闪长岩/花岗岩/泥土/砂砾），体积 10~40 格的椭圆。 */
export const STONE_BLOBS = [
  { block:'andesite', weight:3 },
  { block:'diorite',  weight:3 },
  { block:'granite',  weight:3 },
  { block:'gravel',   weight:2 },
  { block:'dirt',     weight:2 },
];
export const STONE_BLOB_PER_CHUNK = 4;   // [估算] 每区块尝试次数（保持单位面积密度）
export const STONE_BLOB_MAX_R     = 4;

/* 海底粘土团块：海洋底部偶发粘土。 */
export const CLAY_CHANCE = 0.02;        // [估算] 每列海底成为粘土团中心的概率

/* ── 树木 / 植被密度（由群系配置驱动，见 biomes.js）────────────────────── */
export const TREE = {
  // 树只长在合法地表（草/泥土/灰化土/砂土），周围有空间，不穿洞穴/水。
  minTrunkAir: 1,           // 树干两侧需留空的格数（防重叠）
  leafReplaceAirOnly: true,// 树叶只盖在空气上（不覆盖实心方块）
  crossChunkQueue: true,   // 跨区块树通过待写入队列处理
};

/* 世界类型 */
export const WORLD_TYPES = {
  default:  { id:'default',  biomeScale:1,    flat:false, caves:true,  structures:true,  biomes:true },
  flat:     { id:'flat',    biomeScale:1,    flat:true,  caves:false, structures:false, biomes:false },
  huge:     { id:'huge',    biomeScale:4,    flat:false, caves:true,  structures:true,  biomes:true },
};

/* 创建世界界面用的预设（含中文名）。'flat' 对应规格书里的「超平坦」：
 * 基岩 1 + 泥土 2 + 草 1，无洞穴、无结构、无群系。 */
export const WORLD_TYPE_PRESETS = {
  default:{ id:'default', label:'默认',     biomeScale:1, flat:false, caves:true,  structures:true,  biomes:true },
  flat:   { id:'flat',    label:'超平坦',   biomeScale:1, flat:true,  caves:false, structures:false, biomes:false },
  huge:   { id:'huge',    label:'巨大群系', biomeScale:4, flat:false, caves:true,  structures:true,  biomes:true },
};

/** 把「界面选的类型 + 单独开关」解析成 worldgen 能用的世界类型对象。 */
export function resolveWorldType(key = 'default', overrides = {}){
  const p = WORLD_TYPE_PRESETS[key] || WORLD_TYPE_PRESETS.default;
  return {
    id: p.id,
    label: p.label,
    biomeScale: p.biomeScale,
    flat: p.flat,
    biomes: p.biomes,
    caves: overrides.caves === undefined ? p.caves : !!overrides.caves,
    structures: overrides.structures === undefined ? p.structures : !!overrides.structures,
  };
}

/* 存档格式版本：升级生成算法时 +1，旧存档按对应版本算法继续生成未改动区域。 */
export const WORLDGEN_VERSION = 1;

/* 区块状态机 */
export const CHUNK_STATE = { EMPTY:0, TERRAIN:1, CARVED:2, DECORATED:3, FULL:4 };
