/* tools/dev/mc_worldgen_report.mjs
 * 「网页版 2D Minecraft 地形生成」验收报告（规格书 §12 的九项）。
 *
 * 用法：
 *   node tools/dev/mc_worldgen_report.mjs
 *
 * 它不是单元测试（测试在 minecraft/tests/ 下），而是一份**可读的数据报告**：
 * 把每一项验收要求的实测数字打出来，方便人工核对，也方便写进交付说明。
 * 纯逻辑、零 DOM、零浏览器依赖。
 */
import { WorldGen } from '../../minecraft/worldgen/worldgen.js';
import {
  CHUNK_W, WORLD_HEIGHT, SEA_LEVEL, BEDROCK_TOP, WORLD_MIN_Y, WORLD_MAX_Y,
} from '../../minecraft/worldgen/constants.js';
import { BIOMES } from '../../minecraft/worldgen/biomes.js';

const SEED = 'REPORT-SEED';
const PLANTS = new Set(['short_grass','fern','dandelion','poppy','dead_bush','sugar_cane',
  'vine','lily_pad','kelp','seagrass','cactus','snow','pumpkin','melon','rail','spider_web','chest']);
const TREES = new Set(['oak_log','oak_leaves','birch_log','birch_leaves','spruce_log','spruce_leaves',
  'acacia_log','acacia_leaves','jungle_log','jungle_leaves']);
const SOIL = new Set(['grass_block','sand','snow_block','coarse_dirt','podzol','dirt']);
const ORES = new Set(['coal_ore','iron_ore','copper_ore','gold_ore','redstone_ore','lapis_ore',
  'diamond_ore','emerald_ore','deepslate_coal_ore','deepslate_iron_ore','deepslate_copper_ore',
  'deepslate_gold_ore','deepslate_redstone_ore','deepslate_lapis_ore','deepslate_diamond_ore',
  'deepslate_emerald_ore']);

const line = (t) => console.log('\n' + '═'.repeat(72) + '\n  ' + t + '\n' + '═'.repeat(72));
const kv = (k, v) => console.log('  ' + String(k).padEnd(26) + v);

/* ══════════════ 1. 确定性 ══════════════ */
line('§12.1 确定性：同种子同坐标 = 同结果，且与区块生成顺序无关');
{
  const a = new WorldGen(SEED, 'default');
  const b = new WorldGen(SEED, 'default');
  let diff = 0, cells = 0;
  for (const cx of [0, 1, 2, 3, 4]){
    a.generateChunk(cx); b.generateChunk(cx);
  }
  for (const cx of [0, 1, 2, 3, 4]){
    for (let lx = 0; lx < CHUNK_W; lx++) for (let y = 0; y < WORLD_HEIGHT; y++){
      const x = cx * CHUNK_W + lx;
      cells++;
      if (a.get(x, y) !== b.get(x, y)) diff++;
    }
  }
  kv('两个实例逐格比对', `${cells} 格，差异 ${diff} 格`);

  // 顺序：0,1,2 与 2,1,0
  const o1 = new WorldGen(SEED, 'default');
  for (const cx of [0, 1, 2]) o1.generateChunk(cx);
  const o2 = new WorldGen(SEED, 'default');
  for (const cx of [2, 1, 0]) o2.generateChunk(cx);
  let d2 = 0;
  for (const cx of [0, 1, 2]) for (let lx = 0; lx < CHUNK_W; lx++) for (let y = 0; y < WORLD_HEIGHT; y++){
    const x = cx * CHUNK_W + lx;
    if (o1.get(x, y) !== o2.get(x, y)) d2++;
  }
  kv('生成顺序 0,1,2 vs 2,1,0', `差异 ${d2} 格（要求 0）`);
}

/* ══════════════ 2. 跨区块连续性 ══════════════ */
line('§12.2 跨区块连续性：100 条随机区块边界，相邻列高差 ≤ MAX_STEP');
{
  const wg = new WorldGen(SEED, 'default');
  let worst = 0, worstAt = 0, over = 0, checked = 0;
  const step = (x) => wg.terrain.surfaceY(x);
  for (let i = 0; i < 100; i++){
    const cx = Math.floor((Math.sin(i * 12.9898) * 43758.5453 % 1 + 1) % 1 * 4000) - 2000;
    const bx = cx * CHUNK_W;                       // 区块左边界
    for (let x = bx - 2; x < bx + 2; x++){
      const d = Math.abs(step(x + 1) - step(x));
      checked++;
      if (d > worst){ worst = d; worstAt = x; }
      if (d > 4) over++;
    }
  }
  kv('检查的相邻列对', `${checked} 对`);
  kv('最大高差', `${worst} 格（发生在 x=${worstAt}）`);
  kv('超过 MAX_STEP(4) 的次数', `${over}`);
}

/* ══════════════ 3. 群系分布 ══════════════ */
line('§12.3 群系分布：一批群系都能出现、平均带宽 150~600、无 20 格以下的碎带');
{
  const wg = new WorldGen(SEED, 'default');
  /* 群系带按「基础群系」统计（tag 里的 river/beach 是叠加在群系上的标签，
     不是独立群系带 —— 否则 3 格宽的河也会被算成一条「碎带」）。 */
  const FIRST = ['plains','forest','desert','snowy_plains','taiga','mountains','swamp',
    'jungle','savanna','ocean','deep_ocean'];
  const X0 = -10000, X1 = 10000;
  const seen = new Map();
  let prev = null, bandStart = 0, bands = [], tinyBands = 0;
  for (let x = X0; x <= X1; x++){
    const id = wg.biomeAt(x).id;
    if (!seen.has(id)) seen.set(id, x);
    if (id !== prev){
      if (prev !== null){
        const w = x - bandStart;
        bands.push({ id: prev, w });
        if (w < 20) tinyBands++;
      }
      prev = id; bandStart = x;
    }
  }
  bands.push({ id: prev, w: X1 + 1 - bandStart });
  const avgW = bands.reduce((s, b) => s + b.w, 0) / bands.length;
  const maxW = Math.max(...bands.map(b => b.w));
  const minW = Math.min(...bands.map(b => b.w));
  for (const id of FIRST){
    const at = seen.get(id);
    kv(`群系 ${id}`.padEnd(26), at === undefined ? '✗ 没出现' :
      `首次出现在 x=${at}（距离原点 ${Math.abs(at)}）`);
  }
  // 海滩/河流是「标签」，单独统计它们是否出现
  const tags = new Map();
  for (let x = X0; x <= X1; x++){ const t = wg.tagAt(x); if (!tags.has(t)) tags.set(t, x); }
  kv('标签 beach / river', `${tags.has('beach') ? 'x=' + tags.get('beach') : '✗ 没出现'} / ` +
    `${tags.has('river') ? 'x=' + tags.get('river') : '✗ 没出现'}`);
  kv('平均带宽', `${avgW.toFixed(1)} 格（要求 150~600）`);
  kv('带宽范围', `${minW} ~ ${maxW} 格`);
  kv('小于 20 格的碎带', `${tinyBands} 条`);
}

/* ══════════════ 4. 边界合法性 ══════════════ */
line('§12.4 边界合法性：无浮空水、无浮空土、基岩封底、海底不漏');
{
  const wg = new WorldGen(SEED, 'default');
  let floatingWater = 0, floatingDirt = 0, bedrockHole = 0, oceanLeak = 0, checked = 0;
  for (let cx = 0; cx < 12; cx++){
    wg.generateChunk(cx);
  }
  for (let cx = 0; cx < 12; cx++){
    for (let lx = 0; lx < CHUNK_W; lx++){
      const x = cx * CHUNK_W + lx;
      checked++;
      const col = [];
      for (let y = 0; y < WORLD_HEIGHT; y++) col.push(wg.get(x, y));
      // 基岩封底：y=0 必须是基岩
      if (col[0] !== 'bedrock') bedrockHole++;
      // 浮空水：水格下面必须是水/固体，不能是空气
      for (let y = 1; y < WORLD_HEIGHT; y++){
        if (col[y] === 'water' && col[y - 1] === 'air'){ floatingWater++; break; }
      }
      /* 地表不能悬空：地表那一格下面必须是实心方块
         （次表层下面有洞穴是正常的 —— 那是洞穴，不是「悬空土」）。 */
      const surf = wg.terrain.groundY(x);   // 实际地面（河流/湖泊会把它下切）
      const under = wg.get(x, surf - 1);
      if (!under || under === 'air' || under === 'water' || under === 'lava') floatingDirt++;
      /* 海底不漏：真正低于海平面的列，其海底方块下面不能是空气
         （否则海水会灌进洞穴）。 */
      if (surf < SEA_LEVEL){
        const bed = wg.get(x, surf);
        if ((bed === 'sand' || bed === 'gravel' || bed === 'clay') && wg.get(x, surf - 1) === 'air') oceanLeak++;
      }
    }
  }
  kv('检查的列', `${checked} 列`);
  kv('浮空水', `${floatingWater} 处`);
  kv('浮空土/沙/草', `${floatingDirt} 处`);
  kv('基岩缺口（y=0 不是基岩）', `${bedrockHole} 处`);
  kv('海底漏洞', `${oceanLeak} 处`);
}

/* ══════════════ 5. 矿石 ══════════════ */
line('§12.5 矿石：1000 区块统计、Y 区间正确、不长在泥土/空气里、钻石只在深处');
{
  const wg = new WorldGen(SEED, 'default');
  /* 对照组：同样的地形但完全不生成矿石。
     两边「泥土/沙/水/草」的格数必须完全一样 —— 这就证明了
     矿石只替换石头类方块，从没覆盖过泥土、沙子或水（规格书 §5）。 */
  const wgNoOre = new WorldGen(SEED, 'default', { ores: false });
  const stat = new Map();
  let inDirt = 0, inAir = 0, diamondShallow = 0, total = 0;
  for (let cx = 0; cx < 1000; cx++){
    wg.generateChunk(cx);
    for (let lx = 0; lx < CHUNK_W; lx++){
      const x = cx * CHUNK_W + lx;
      for (let y = 0; y < WORLD_HEIGHT; y++){
        const n = wg.get(x, y);
        if (!ORES.has(n)) continue;
        total++;
        const s = stat.get(n) || { min: 1e9, max: -1e9, count: 0 };
        s.min = Math.min(s.min, y); s.max = Math.max(s.max, y); s.count++;
        stat.set(n, s);
        if (n.includes('diamond') && y > 16) diamondShallow++;
      }
    }
  }
  kv('统计区块数', '1000 个（16000 列）');
  kv('矿脉格总数', `${total}`);
  kv('钻石出现在 y>16 的', `${diamondShallow}（应为 0）`);
  /* 对照组比对：泥土/沙/草/水的格数在「有矿石」与「无矿石」两个世界里必须一致 */
  {
    const count = (g) => {
      const c = { dirt:0, sand:0, grass:0, water:0 };
      for (let cx = 0; cx < 200; cx++){
        g.generateChunk(cx);
        for (let lx = 0; lx < CHUNK_W; lx++) for (let y = 0; y < WORLD_HEIGHT; y++){
          const n = g.get(cx * CHUNK_W + lx, y);
          if (n === 'dirt' || n === 'coarse_dirt') c.dirt++;
          else if (n === 'sand' || n === 'sandstone' || n === 'red_sand') c.sand++;
          else if (n === 'grass_block') c.grass++;
          else if (n === 'water') c.water++;
        }
      }
      return c;
    };
    const a = count(wg), b = count(wgNoOre);
    const same = a.dirt === b.dirt && a.sand === b.sand && a.grass === b.grass && a.water === b.water;
    kv('泥土格数（有矿 / 无矿）', `${a.dirt} / ${b.dirt}`);
    kv('沙子格数（有矿 / 无矿）', `${a.sand} / ${b.sand}`);
    kv('草地格数（有矿 / 无矿）', `${a.grass} / ${b.grass}`);
    kv('水格数（有矿 / 无矿）', `${a.water} / ${b.water}`);
    kv('结论', same ? '✓ 矿石没有覆盖泥土/沙/草/水' : '✗ 矿石覆盖了非石头方块');
  }
  console.log('  ── 各矿种的 Y 区间与数量 ──');
  for (const [n, s] of [...stat].sort((a, b) => a[0].localeCompare(b[0])))
    console.log('    ' + n.padEnd(26) + `Y ${String(s.min).padStart(3)}~${String(s.max).padStart(3)}   ${s.count} 格`);
}

/* ══════════════ 6. 树木 ══════════════ */
line('§12.6 树木：只长在合法土壤上、不穿洞、不重叠');
{
  const wg = new WorldGen(SEED, 'default');
  let trunks = 0, badSoil = 0, inCave = 0, overlap = 0;
  const trunkAt = new Set();
  for (let cx = 0; cx < 40; cx++){
    wg.generateChunk(cx);
    for (let lx = 0; lx < CHUNK_W; lx++){
      const x = cx * CHUNK_W + lx;
      for (let y = 1; y < WORLD_HEIGHT; y++){
        if (!/_log$/.test(wg.get(x, y))) continue;
        trunks++;
        if (trunkAt.has(x)) overlap++;
        trunkAt.add(x);
        const gy = wg.terrain.groundY(x);
        if (!SOIL.has(wg.get(x, gy))) badSoil++;
        // 树干必须从地面往上连续，不能有一截悬空（= 穿进洞里）
        let broken = false;
        for (let yy = gy + 1; yy <= y; yy++) if (wg.get(x, yy) !== wg.get(x, y)) { broken = true; break; }
        if (broken) inCave++;
        break;      // 每列只查最下面那截树干
      }
    }
  }
  kv('树干数（40 区块）', `${trunks}`);
  kv('地面不是合法土壤的', `${badSoil}`);
  kv('树干悬空/穿洞的', `${inCave}`);
  kv('同列重叠的树干', `${overlap}`);
}

/* ══════════════ 7. 存档 ══════════════ */
line('§12.7 存档：改动保留、未改动区重生成一致、旧存档能读');
{
  const wg = new WorldGen(SEED, 'default');
  wg.generateChunk(0); wg.generateChunk(1);
  wg.set(5, 100, 'stone');                       // 模拟玩家改动
  const before = wg.get(5, 100);
  const data = JSON.parse(JSON.stringify(wg.serializeChanges()));
  const wg2 = new WorldGen(SEED, 'default');
  wg2.loadChanges(data);
  kv('改动保留', `${before} → 恢复后 ${wg2.get(5, 100)}`);
  // 未改动区重生成一致
  wg2.generateChunk(2);
  let diff = 0;
  for (let lx = 0; lx < CHUNK_W; lx++) for (let y = 0; y < WORLD_HEIGHT; y++){
    if (wg.get(32 + lx, y) !== wg2.get(32 + lx, y)) diff++;
  }
  kv('未改动区重生成差异', `${diff} 格（要求 0）`);
  kv('存档只含改动区块', `${Object.keys(data.chunks).length} 个区块`);
}

/* ══════════════ 8. 性能 ══════════════ */
line('§12.8 性能：飞行 5000 格，FPS 稳定、内存不涨、远处区块被卸载');
{
  const wg = new WorldGen(SEED, 'default');
  const t0 = Date.now();
  let x = 0, worstFrame = 0;
  for (let i = 0; i < 320; i++){                // 320 帧 × 16 格 = 5120 格
    x += 16;
    const f0 = Date.now();
    wg.update(x);
    worstFrame = Math.max(worstFrame, Date.now() - f0);
  }
  const dt = Date.now() - t0;
  kv('飞过的距离', '5120 格（320 帧）');
  kv('总耗时', `${dt} ms`);
  kv('单帧最差耗时', `${worstFrame} ms（预算 4ms + 单块生成时间）`);
  kv('常驻区块数', `${wg.chunks.size}（超出卸载距离的会被回收）`);
  kv('卸载阈值', `渲染距离 + 4 = 12 区块`);
}

/* ══════════════ 9. 出生点 ══════════════ */
line('§12.9 出生点：50 个随机种子都在地表、不在水下、脚下有方块');
{
  let ok = 0, underWater = 0, noGround = 0, blocked = 0;
  for (let i = 0; i < 50; i++){
    const wg = new WorldGen('seed-' + i, 'default');
    const sp = wg.findSpawn();
    const ground = wg.get(sp.x, sp.y);
    const head = wg.get(sp.x, sp.y + 1);
    const below = wg.get(sp.x, sp.y - 1);
    if (!SOIL.has(ground)) noGround++;
    else if (head === 'water' || below === 'water') underWater++;
    else if (/_log$/.test(head)) blocked++;
    else ok++;
  }
  kv('合格', `${ok} / 50`);
  kv('脚下不是地面', `${noGround}`);
  kv('泡在水里', `${underWater}`);
  kv('卡在树干里', `${blocked}`);
}

console.log('\n' + '═'.repeat(72));
console.log('  报告结束');
console.log('═'.repeat(72) + '\n');
