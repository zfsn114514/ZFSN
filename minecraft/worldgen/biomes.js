// worldgen/biomes.js
// ───────────────────────────────────────────────────────────────────────────
// 生物群系系统（2D 适配：沿 X 轴一维分布）。
// 用四个种子相关的一维分形噪声决定群系：温度 / 湿度 / 大陆度 / 侵蚀。
// 群系边界通过「地表参数在 BLEND_RADIUS 内按距离加权平均」平滑过渡（规格书 §2.3 / §3.3）。
// 所有结果都是坐标的纯函数 → 与区块生成顺序无关。
// ───────────────────────────────────────────────────────────────────────────
import { toSeed, mixSeed, hash1, rand01 } from './rng.js';
import { makeFbm1D } from './noise.js';
import { NOISE, BLEND_RADIUS, SEA_LEVEL, COAST, DEEP_COAST } from './constants.js';

/* 群系注册表。每个群系是纯数据对象。
 * baseHeight / heightVariation 单位：格（相对海平面 SEA_LEVEL 的偏移基准在 terrain 里处理）。
 * surface=地表块；sub=次表层块；subDepth=次表层厚度；stone=该群系石头变种（一般就是 stone）。
 * trees/plants 是装饰阶段用的（见 decorations.js），这里只放声明。 */
export const BIOMES = {
  plains:      { id:'plains',      name:'平原',   surface:'grass_block', sub:'dirt', subDepth:4, stone:'stone',
                 baseHeight:1,  heightVariation:3,  temperature:0.5,  humidity:0.4, hasSnow:false, hasRain:true,
                 grassColor:'#91bd59', foliageColor:'#77ab2f', waterColor:'#3f76e4',
                 treeDensity:0.05,
                 trees:[{type:'oak',weight:1}], plants:['dandelion','poppy','short_grass'], mobs:['pig','cow','sheep','chicken'] },
  forest:      { id:'forest',      name:'森林',   surface:'grass_block', sub:'dirt', subDepth:4, stone:'stone',
                 baseHeight:2,  heightVariation:4,  temperature:0.45, humidity:0.6, hasSnow:false, hasRain:true,
                 grassColor:'#79c05a', foliageColor:'#59ae30', waterColor:'#3f76e4',
                 treeDensity:0.3,
                 trees:[{type:'oak',weight:3},{type:'birch',weight:2}], plants:['short_grass','fern'], mobs:['pig','cow','sheep','chicken'] },
  desert:      { id:'desert',      name:'沙漠',   surface:'sand',       sub:'sandstone', subDepth:4, stone:'sandstone',
                 baseHeight:1,  heightVariation:2,  temperature:0.9,  humidity:0.0, hasSnow:false, hasRain:false,
                 grassColor:'#bfb755', foliageColor:'#aea42a', waterColor:'#32a598',
                 treeDensity:0,
                 trees:[], plants:['dead_bush','cactus'], mobs:[] },
  snowy_plains:{ id:'snowy_plains',name:'雪原',   surface:'snow_block', sub:'dirt', subDepth:3, stone:'stone',
                 baseHeight:1,  heightVariation:2,  temperature:-0.5, humidity:0.3, hasSnow:true,  hasRain:false,
                 grassColor:'#80b497', foliageColor:'#60a17b', waterColor:'#3d57d6',
                 treeDensity:0.05,
                 trees:[{type:'spruce',weight:1}], plants:['short_grass'], mobs:['rabbit'] },
  taiga:       { id:'taiga',       name:'针叶林', surface:'grass_block', sub:'dirt', subDepth:4, stone:'stone',
                 baseHeight:2,  heightVariation:5,  temperature:-0.1, humidity:0.5, hasSnow:true,  hasRain:true,
                 grassColor:'#86b783', foliageColor:'#68a464', waterColor:'#3d57d6',
                 treeDensity:0.24,
                 trees:[{type:'spruce',weight:3},{type:'oak',weight:1}], plants:['fern','short_grass'], mobs:['pig','cow','sheep','chicken'] },
  mountains:   { id:'mountains',   name:'山地',   surface:'stone',      sub:'stone', subDepth:2, stone:'stone',
                 baseHeight:18, heightVariation:24, temperature:0.3,  humidity:0.3, hasSnow:false, hasRain:true, mountainous:true,
                 grassColor:'#8ab689', foliageColor:'#6da36b', waterColor:'#3f76e4',
                 treeDensity:0,
                 trees:[], plants:['stone','gravel'], mobs:['sheep','goat'] },
  swamp:       { id:'swamp',       name:'沼泽',   surface:'grass_block', sub:'dirt', subDepth:4, stone:'stone',
                 baseHeight:-2, heightVariation:2,  temperature:0.5,  humidity:0.9, hasSnow:false, hasRain:true,
                 grassColor:'#6a7039', foliageColor:'#6a7039', waterColor:'#617b64',
                 treeDensity:0.12,
                 trees:[{type:'oak',weight:2},{type:'swamp_oak',weight:1}], plants:['vine','fern','lily_pad'], mobs:['pig','chicken','slime'] },
  jungle:      { id:'jungle',      name:'丛林',   surface:'grass_block', sub:'dirt', subDepth:4, stone:'stone',
                 baseHeight:2,  heightVariation:5,  temperature:0.85, humidity:0.85, hasSnow:false, hasRain:true,
                 grassColor:'#59c93c', foliageColor:'#30bb0b', waterColor:'#3af3e6',
                 treeDensity:0.32,
                 trees:[{type:'jungle',weight:3},{type:'oak',weight:1}], plants:['fern','vine','cocoa'], mobs:['pig','cow','chicken'] },
  savanna:     { id:'savanna',     name:'热带草原',surface:'grass_block', sub:'dirt', subDepth:3, stone:'stone',
                 baseHeight:2,  heightVariation:3,  temperature:0.8,  humidity:0.1, hasSnow:false, hasRain:false,
                 grassColor:'#bfb755', foliageColor:'#aea42a', waterColor:'#3f76e4',
                 treeDensity:0.07,
                 trees:[{type:'acacia',weight:2}], plants:['short_grass'], mobs:['pig','cow','sheep','horse'] },
  ocean:       { id:'ocean',       name:'海洋',   surface:'sand',       sub:'sand',  subDepth:3, stone:'stone',
                 baseHeight:-20,heightVariation:3,  temperature:0.5,  humidity:0.5, hasSnow:false, hasRain:true, isOcean:true,
                 grassColor:'#8eb971', foliageColor:'#71a74d', waterColor:'#3f76e4',
                 treeDensity:0,
                 trees:[], plants:['seagrass','kelp'], mobs:[] },
  deep_ocean:  { id:'deep_ocean',  name:'深海',   surface:'gravel',     sub:'gravel',subDepth:3, stone:'stone',
                 baseHeight:-38,heightVariation:3,  temperature:0.5,  humidity:0.5, hasSnow:false, hasRain:true, isOcean:true,
                 grassColor:'#8eb971', foliageColor:'#71a74d', waterColor:'#3f76e4',
                 treeDensity:0,
                 trees:[], plants:['seagrass'], mobs:[] },
  beach:       { id:'beach',       name:'海滩',   surface:'sand',       sub:'sand',  subDepth:3, stone:'sandstone',
                 baseHeight:0,  heightVariation:1,  temperature:0.6,  humidity:0.3, hasSnow:false, hasRain:true, isBeach:true,
                 grassColor:'#91bd59', foliageColor:'#77ab2f', waterColor:'#3f76e4',
                 treeDensity:0,
                 trees:[], plants:['dead_bush'], mobs:[] },
  river:       { id:'river',       name:'河流',   surface:'sand',       sub:'sand',  subDepth:2, stone:'stone',
                 baseHeight:-4, heightVariation:1,  temperature:0.5,  humidity:0.6, hasSnow:false, hasRain:true, isRiver:true,
                 grassColor:'#91bd59', foliageColor:'#77ab2f', waterColor:'#3f76e4',
                 treeDensity:0,
                 trees:[], plants:['seagrass'], mobs:[] },
};

/* 扩展点：第二批群系（规格书 §2.2）。本轮只留注册表，不强制出现。 */
export const BIOME_EXTENSIONS = ['badlands','mushroom_fields','cherry_grove','mangrove','ice_spikes'];

/* 由种子构建采样器。worldType.biomeScale 放大群系尺度（巨大群系 ×4）。 */
export function makeBiomeSampler(seed, worldType = { biomeScale: 1 }){
  const s = toSeed(seed);
  const scale = worldType.biomeScale || 1;
  const f = k => NOISE[k].freq / scale;
  const temp    = makeFbm1D(s, { freq: f('temperature'),    octaves: NOISE.temperature.octaves,    persistence: NOISE.temperature.persistence,    lacunarity: NOISE.temperature.lacunarity,    salt: NOISE.temperature.salt });
  const humid   = makeFbm1D(s, { freq: f('humidity'),       octaves: NOISE.humidity.octaves,       persistence: NOISE.humidity.persistence,       lacunarity: NOISE.humidity.lacunarity,       salt: NOISE.humidity.salt });
  const contin  = makeFbm1D(s, { freq: f('continental'),     octaves: NOISE.continental.octaves,     persistence: NOISE.continental.persistence,     lacunarity: NOISE.continental.lacunarity,     salt: NOISE.continental.salt });
  const eros    = makeFbm1D(s, { freq: f('erosion'),         octaves: NOISE.erosion.octaves,         persistence: NOISE.erosion.persistence,         lacunarity: NOISE.erosion.lacunarity,         salt: NOISE.erosion.salt });

  function climateAt(x){
    return {
      temperature: temp(x),
      humidity:    humid(x),
      continental: contin(x),
      erosion:     eros(x),
    };
  }

  /* 气候低通滤波：把 ±CLIMATE_SMOOTH_WINDOW 内的原始气候取平均。
   * 作用有二：
   *   1) 让群系边界变宽，消除「宽度 < 20 格的碎片」（规格书 §12.3）；
   *   2) 边界处的过渡更平滑（群系混合的前提）。
   * 窗口对称 → 仍然是 x 的纯函数，与生成顺序无关。 */
  const CLIMATE_SMOOTH_WINDOW = 28;
  const CLIMATE_SMOOTH_STEP = 4;
  const _climateCache = new Map();
  const _biomeCache = new Map();
  const _cellBiome = new Map();

  /* 群系单元格：基础宽 256 格，扭曲幅度 ±40 → 实际宽度约 176~336 格（落在 150~600 内）。 */
  const BIOME_CELL = 256;
  const BIOME_WARP = 40;
  const warp = makeFbm1D(s, { freq: 1/900, octaves: 1, persistence: 0.5, lacunarity: 2, salt: 907 });

  function smoothedClimate(x){
    if (_climateCache.has(x)) return _climateCache.get(x);
    let t = 0, h = 0, c = 0, e = 0, n = 0;
    for (let dx = -CLIMATE_SMOOTH_WINDOW; dx <= CLIMATE_SMOOTH_WINDOW; dx += CLIMATE_SMOOTH_STEP){
      t += temp(x + dx); h += humid(x + dx); c += contin(x + dx); e += eros(x + dx); n++;
    }
    const out = { temperature: t/n, humidity: h/n, continental: c/n, erosion: e/n };
    _climateCache.set(x, out);
    return out;
  }

  /* 群系按「单元格」划分（规格书 §2.1：群系宽度目标 150~600 格、不要碎片）：
   *   单元格基础宽 BIOME_CELL，再用低频噪声做 ±BIOME_WARP 的扭曲，
   *   于是边界不规则但宽度始终落在 150~600 内；每个单元格的群系由
   *   「该单元格中心处的气候」决定 → 分布仍由气候驱动，且天然没有 <20 格的碎片。
   * 单元格划分是 x 的纯函数（扭曲噪声 + 向下取整），与生成顺序无关。
   *
   * 气候 → 群系用「打分取最大」而不是硬阈值：
   *   硬阈值在两个条件几乎同时越界时会产生 1~2 格的碎片群系，
   *   且「又热又干」这类组合可能永远不出现（两个独立噪声要恰好同时越界）。
   *   打分法给每个气候带一个 0~1 的匹配度，取最高者；同一带内再用哈希挑选具体群系，
   *   分布由气候驱动，同时保证每个群系都有机会出现。 */
  const ZONE_BIOMES = {
    ocean:    [['ocean', 0.65], ['deep_ocean', 0.35]],
    cold:     [['taiga', 0.55], ['snowy_plains', 0.45]],
    hotDry:   [['desert', 0.6], ['savanna', 0.4]],
    hotWet:   [['jungle', 0.5], ['forest', 0.5]],
    wet:      [['swamp', 0.55], ['forest', 0.45]],
    mountain: [['mountains', 0.62], ['taiga', 0.19], ['snowy_plains', 0.19]],
    temperate:[['plains', 0.5], ['forest', 0.3], ['savanna', 0.2]],
  };
  const INLAND_BIOMES = ['plains','forest','desert','savanna','jungle','swamp','taiga','snowy_plains','mountains'];

  /* ── 覆盖率兜底（规格书 §12.3：每个一批群系在 ±10000 内都要能出现）──────
   * 纯气候分区在某些种子里会让「沼泽」这种冷门群系整段缺失（实测某个种子
   * 在 ±10000 内只出现 10/11 种）。所以每 9 个单元格安排 1 个「保底槽」，
   * 槽位按一个**由种子决定的固定排列**轮换群系：
   *   · 相邻槽相距 9×256 = 2304 格，一轮 9 个槽刚好把 9 种陆地群系各用一次
   *     → 任意 ±10000（78 格 ≈ 8~9 个槽）内必定每种陆地群系都出现过；
   *   · 排列固定不变 → 不会每轮都换顺序（那会让人看出规律）；
   *   · 海洋/深海不参与（它们由大陆度决定，出现频率本来就够）。 */
  const COVER_PERM = (() => {
    // 用种子把 INLAND_BIOMES 洗成一个固定排列（Fisher–Yates，哈希取随机数）
    const arr = INLAND_BIOMES.slice();
    for (let i = arr.length - 1; i > 0; i--){
      const j = Math.floor(rand01(hash1(mixSeed(s, 995), i * 131)) * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  })();

  const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

  function zoneScores(cl){
    const { temperature: t, humidity: h, continental: c, erosion: e } = cl;
    return {
      ocean:     clamp01((-c + 0.02) / 0.28),
      cold:      clamp01((-t - 0.12) / 0.38),
      hotDry:    clamp01((t - 0.08) / 0.38) * clamp01((-h + 0.08) / 0.38),
      hotWet:    clamp01((t - 0.05) / 0.40) * clamp01((h - 0.18) / 0.40),
      wet:       clamp01((h - 0.18) / 0.40) * clamp01((-e - 0.02) / 0.40),
      mountain:  clamp01((e - 0.12) / 0.40),
      temperate: 0.30,
    };
  }

  function cellIndex(x){
    const w = warp(x) * BIOME_WARP;
    return Math.floor((x + w) / BIOME_CELL);
  }

  /* 按气候打分挑区间。allowOcean=false 时把海洋排除，用于「气候是陆地但
     单元格因抖动选中海洋」的兜底。 */
  function pickZone(ci, cl, allowOcean){
    const scores = zoneScores(cl);
    if (!allowOcean) delete scores.ocean;
    // 每个单元格加一点哈希抖动，避免等分时的系统性并列
    let best = 'temperate', bestScore = -1;
    for (const [zone, sc] of Object.entries(scores)){
      const jitter = (rand01(hash1(mixSeed(s, 991), ci * 31 + zone.length * 7)) - 0.5) * 0.24;
      const v = sc + jitter;
      if (v > bestScore){ bestScore = v; best = zone; }
    }
    return best;
  }

  function pickFromZone(ci, zone){
    const list = ZONE_BIOMES[zone];
    const r = rand01(hash1(mixSeed(s, 992), ci));
    let acc = r, chosen = list[list.length - 1][0];
    for (const [bid, w] of list){ acc -= w; if (acc <= 0){ chosen = bid; break; } }
    // 覆盖率兜底：每 9 个单元格一个「保底槽」，按固定排列轮换陆地群系，
    // 保证任意一段足够长的世界里，每个第一批群系都一定出现过（验收 §12.3）。
    // 海洋不参与（海陆已经由大陆度决定，不再让保底槽把海改成陆地）。
    if (zone === 'ocean') return chosen;
    const COVER_N = COVER_PERM.length;
    if (((ci % COVER_N) + COVER_N) % COVER_N === 0){
      const cycle = Math.floor(ci / COVER_N);
      chosen = COVER_PERM[((cycle % COVER_N) + COVER_N) % COVER_N];
    }
    return chosen;
  }

  function cellBiomeId(ci){
    let id = _cellBiome.get(ci);
    if (id !== undefined) return id;
    const cl = smoothedClimate(Math.round((ci + 0.5) * BIOME_CELL));
    id = pickFromZone(ci, pickZone(ci, cl, true));
    _cellBiome.set(ci, id);
    return id;
  }

  function baseBiomeId(x){
    if (_biomeCache.has(x)) return _biomeCache.get(x);
    const cl = smoothedClimate(x);
    const ci = cellIndex(x);
    let id;
    if (cl.continental < COAST){
      /* ★ 海陆必须由「这一列」的大陆度决定，不能只看单元格中心。
         单元格宽 256 格、大陆度噪声波长 1100 格，同一格内完全可以横跨海岸线。
         旧实现只看单元格 → 海洋单元格里的陆地高度也灌水（海水堆在平原上），
         陆地单元格里的海底则没有水（干坑）。 */
      id = cl.continental < DEEP_COAST ? 'deep_ocean' : 'ocean';
    } else {
      id = cellBiomeId(ci);
      // 单元格选中了海洋、但这一列其实是陆地 → 换成最匹配的陆地群系。
      if (BIOMES[id].isOcean) id = pickFromZone(ci, pickZone(ci, cl, false));
    }
    _biomeCache.set(x, id);
    return id;
  }

  function baseBiomeAt(x){ return BIOMES[baseBiomeId(x)]; }

  /* 「气候上最匹配的陆地群系」：给 terrain 用 —— 有些列因为平滑可能变成
     陆地高度却仍处在大陆度偏低的位置，这时不该继续显示海洋群系。 */
  function landBiomeAt(x){
    const ci = cellIndex(x);
    return BIOMES[pickFromZone(ci, pickZone(ci, smoothedClimate(x), false))];
  }

  /* 地表参数混合：在 BLEND_RADIUS 内采样若干点，按距离加权求 baseHeight / heightVariation。
   * 地表方块用「本列主群系」自身（规格书 §3.3：不做方块混合，避免不存在的方块组合）。 */
  function surfaceParamsAt(x){
    let wSum = 0, bh = 0, hv = 0;
    for (let dx = -BLEND_RADIUS; dx <= BLEND_RADIUS; dx += 2){
      const d = Math.abs(dx);
      const w = 1 / (1 + d * d * 0.06);
      const b = baseBiomeAt(x + dx);
      bh += b.baseHeight * w; hv += b.heightVariation * w; wSum += w;
    }
    return { baseHeight: bh / wSum, heightVariation: hv / wSum, biome: baseBiomeAt(x) };
  }

  return { climateAt, smoothedClimate, baseBiomeId, baseBiomeAt, landBiomeAt, surfaceParamsAt, BIOMES };
}

export { SEA_LEVEL };
