// worldgen/structures.js
// ───────────────────────────────────────────────────────────────────────────
// 结构（规格书 §7）。按「区域格子」放置，与区块生成顺序无关：
//   · 废弃矿井：多段水平木支撑通道（木板 + 铁轨 + 蜘蛛网 + 偶尔箱子）。
//   · 简化村庄：仅在平原/沙漠/热带草原且地面平坦处，3~6 间小木屋 + 一条路径。
// 结构放置不破坏地形整体形状（地基自动填充、上方清空、边缘不悬空）。
// 本轮不做要塞/沙漠神殿/沉船（留扩展点）。
//
// ★「位置可查询」：村庄小屋的 x、矿井的 y 都由 (种子, 区块号) 的纯函数决定，
//   不生成区块也能算出来。findSpawn 用它排除「出生点落在矿井通道/木屋里」的情况。
// ───────────────────────────────────────────────────────────────────────────
import { toSeed, mixSeed, hash1, hash2, rand01 } from './rng.js';
import { SEA_LEVEL, BEDROCK_TOP, CHUNK_W } from './constants.js';

/* 小屋尺寸（格）：5 宽 4 高。 */
const HUT_W = 5, HUT_H = 4;

export function makeStructures(seed, worldType = { structures: true }){
  const s = toSeed(seed);
  const enabled = !!worldType.structures;

  /* ── 废弃矿井 ──────────────────────────────────────────────────────────
   * 每 8 个区块一个候选，命中则在区块内挖一条水平通道。
   * ★ 通道必须始终在「地面之下」：早期版本用固定 y（SEA_LEVEL-6 ~ SEA_LEVEL-20），
   *   在低洼地形上会直接把地表挖穿 —— 出生点会掉进隧道里（实测 seed-5）。
   *   现在取「本区块最低地表 - 4」，保证顶板至少 4 格厚、地面不会被破坏。 */
  function mineshaftPlan(cx, groundY){
    if (!enabled) return null;
    if (rand01(hash1(mixSeed(s, 3001), cx)) >= 0.18) return null;   // ~每 5~6 个区块一段
    const base = SEA_LEVEL - 6 - Math.floor(rand01(hash1(mixSeed(s, 3002), cx)) * 14);
    const x0 = cx * CHUNK_W, x1 = x0 + CHUNK_W - 1;
    let minGround = Infinity;
    for (let x = x0; x <= x1; x++) minGround = Math.min(minGround, groundY(x));
    const yc = Math.min(base, minGround - 4);
    if (yc <= BEDROCK_TOP + 4) return null;
    return { yc, x0, x1 };
  }

  function mineshaft(chunk){
    const plan = mineshaftPlan(chunk.cx, chunk.groundY);
    if (!plan) return;
    const { yc, x0, x1, set } = chunk;
    for (let x = x0; x <= x1; x++){
      for (let dy = -1; dy <= 1; dy++){
        const y = yc + dy;
        if (y <= BEDROCK_TOP + 1) continue;
        set(x, y, 'air');              // 挖空通道
      }
      // 地板 / 天花板木板
      set(x, yc - 2, 'oak_planks');
      set(x, yc + 2, 'oak_planks');
      // 铁轨（通道中心）
      set(x, yc - 1, 'rail');
      // 蜘蛛网 / 箱子（稀）
      const r = rand01(hash2(mixSeed(s, 3003), x));
      if (r < 0.05) set(x, yc, 'spider_web');
      else if (r < 0.06) set(x, yc, 'chest');
    }
  }

  /* ── 简化村庄 ──────────────────────────────────────────────────────────
   * 按区域格子（每 24 区块）决定是否落村，落在本区块的平坦地表上摆 2~4 间木屋。 */
  function villageHutXs(cx, groundY, biomeAt){
    if (!enabled) return [];
    const region = Math.floor(cx / 24);
    if (rand01(hash1(mixSeed(s, 4001), region)) >= 0.22) return [];   // 约 1/5 区域有村
    const b = biomeAt(cx * 16 + 8);
    if (!['plains','desert','savanna'].includes(b.id)) return [];
    // 检查地面平坦
    let flat = true; const base = groundY(cx * 16 + 8);
    for (let x = cx * 16; x < cx * 16 + 16; x++) if (Math.abs(groundY(x) - base) > 2) flat = false;
    if (!flat) return [];
    const hutCount = 2 + Math.floor(rand01(hash1(mixSeed(s, 4002), cx)) * 3); // 2~4
    const x0 = cx * CHUNK_W, x1 = x0 + CHUNK_W - 1;
    const xs = [];
    for (let i = 0; i < hutCount; i++){
      xs.push(x0 + 2 + Math.floor(rand01(hash2(mixSeed(s, 4003), cx * 10 + i)) * (x1 - x0 - 6)));
    }
    return xs;
  }

  function village(chunk){
    const xs = villageHutXs(chunk.cx, chunk.groundY, chunk.biomeAt);
    for (let i = 0; i < xs.length; i++){
      const hx = xs[i];
      buildHut(hx, chunk.groundY(hx), chunk.set, chunk.get, mixSeed(mixSeed(s, 4004), i * 31 + chunk.cx));
    }
  }

  function buildHut(x, groundY, set, get, hs){
    // 5 宽 4 高的小屋：原木墙、木板地、木板顶、门口留空
    for (let dx = 0; dx < HUT_W; dx++){
      for (let dy = 0; dy < HUT_H; dy++){
        const wx = x + dx, wy = groundY - dy;
        if (dy === 0){ set(wx, wy, 'oak_planks'); continue; }       // 地板
        if (dy === HUT_H - 1){ set(wx, wy, 'oak_planks'); continue; }   // 屋顶
        const side = dx === 0 || dx === HUT_W - 1;
        const door = (dx === 2 && dy === 1);                         // 门洞
        if (side && !door) set(wx, wy, 'oak_log');                   // 墙
        else set(wx, wy, 'air');
      }
    }
  }

  /* 「这一列被结构占了地面吗」——找出生点时排除木屋内部。 */
  function spawnBlocked(x, groundY, biomeAt){
    if (!enabled) return false;
    const cx = Math.floor(x / CHUNK_W);
    for (const hx of villageHutXs(cx, groundY, biomeAt)){
      if (x >= hx && x < hx + HUT_W) return true;
    }
    return false;
  }

  function generate(chunk){
    mineshaft(chunk);
    village(chunk);
  }

  return { generate, mineshaft, village, mineshaftPlan, villageHutXs, spawnBlocked };
}
