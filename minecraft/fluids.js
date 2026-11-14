/* ════════════════════════════════════════════════════════════════════════════
 * fluids.js —— 流体系统纯逻辑层（与渲染、实体、DOM 完全无关）
 * ────────────────────────────────────────────────────────────────────────────
 * 这是「数据模型 / 调度 / 扩散 / 交互」的全部核心。它不画任何东西，也不依赖
 * 浏览器，可以直接被 node:test 单测（见 tests/fluids.test.mjs）。
 *
 * 设计要点（对应任务书）：
 *   · 流体状态用紧凑 Uint8 存储（见 pack/unpack），不给每个流体格建对象；
 *     算法运行期临时用 {type,amount,falling,isSource} 描述符，不持久化。
 *   · 用「计划 tick 队列」（最小堆，按 (triggerTick, seq) 排序）替代旧的全图
 *     BFS 重算；同一坐标只保留「最早触发」的一次（去重）。
 *   · 所有算法按固定 20 TPS 的 tick 驱动，delay 全部来自 config.FLUID。
 *   · 2D 适配：水平只有 左 / 右 两个方向（DOWN=+y，UP=-y，屏幕坐标 y 向下）。
 *
 * ── 适配器契约（world 必须实现，GameWorld 与测试 MemWorld 都满足） ──
 *   world.W, world.H           地图宽高（格）
 *   world.tickCount            当前逻辑 tick（number，由 world 维护）
 *   world.getDimension()       维度名，默认 'overworld'（用于下界岩浆取值）
 *   world.fluidGet(x,y)        返回该格流体描述符 {type,amount,falling,isSource}
 *                              或 null（非流体 / 越界）
 *   world.fluidSet(x,y,cell)   cell 为描述符则写入该流体（自动落方块+打包），
 *                              cell 为 null 则清除流体（变空气）
 *   world.fluidSetBlock(x,y,id)把该格设成普通方块 id（清流体；用于黑曜石/圆石/石头）
 *   world.fluidSolid(x,y)      是否「实心」（流体不可进入）。越界视为实心墙
 *   world.fluidBlocking(x,y)   是否非实心但流体进不去（门/梯子等）。本作暂无 → false
 *   world.fluidReplaceable(x,y)是否可被流体冲掉并掉物品（火把/花草等）
 *   world.fluidIsAir(x,y)      是否「空」（非流体/非实心/非阻挡/非可替换）
 *   world.fluidDropItem(x,y)   把 (x,y) 的可替换方块掉成物品
 *   world.fluidSizzle(x,y)     [可选] 嘶嘶音效 + 白烟（无音频/粒子时留空）
 * ════════════════════════════════════════════════════════════════════════════ */
import * as C from './config.js';

const FLUID = C.FLUID;
export const WATER = 'water';
export const LAVA = 'lava';

/* 流体对应的方块 id 由 game.js 在运行时注入（BLOCKS 索引在加载后才确定）。
 * 这里给一组合理默认值，测试里会按需覆盖。 */
export const FLUID_BLOCK = {
  water: 17, lava: 18, obsidian: 0, cobblestone: 12, stone: 3,
};
/** 注入实际方块 id（game.js 与测试都会调用）。 */
export function setFluidBlocks(map) { Object.assign(FLUID_BLOCK, map); }

/* ── 方向（2D：水平仅左右） ─────────────────────────────────────────────── */
export const LEFT = { x: -1, y: 0 };
export const RIGHT = { x: 1, y: 0 };
export const UP = { x: 0, y: -1 };
export const DOWN = { x: 0, y: 1 };
const DIRS4 = [UP, DOWN, LEFT, RIGHT];
const SIDES = [LEFT, RIGHT];

/* ── 紧凑存储：一个 Uint8 装下整格流体状态 ───────────────────────────────
 * bit0..3  amount(1..8)   本格水量（源头/下落恒为 8）
 * bit4     falling        是否处于下落中
 * bit5     isSource       是否为源头
 * bit6     type           0=水 1=岩浆（其余类型可继续加 bit7）
 * 非流体格存 0。这样每个流体格只占 1 字节，且可与区块数据一起 rle 存档。 */
const A_MASK = 0x0F;
const F_FALL = 1 << 4;
const F_SRC = 1 << 5;
const F_LAVA = 1 << 6;

export function packFluid(cell) {
  if (!cell) return 0;
  let v = (cell.amount & A_MASK) | (cell.type === LAVA ? F_LAVA : 0);
  if (cell.falling) v |= F_FALL;
  if (cell.isSource) v |= F_SRC;
  return v;
}
export function unpackFluid(v) {
  if (!v) return null;
  return {
    type: (v & F_LAVA) ? LAVA : WATER,
    amount: v & A_MASK,
    falling: !!(v & F_FALL),
    isSource: !!(v & F_SRC),
  };
}

/* 描述符相等（用于判断状态是否变化，决定是否继续调度） */
function sameCell(a, b) {
  return a.type === b.type && a.amount === b.amount &&
         a.falling === b.falling && a.isSource === b.isSource;
}

export class FluidEngine {
  constructor() {
    this.heap = [];                 // 最小堆：{t,seq,x,y}
    this.pending = new Map();       // idx -> triggerTick（去重权威集合）
    this.seq = 0;
    this.maxPerTick = FLUID.MAX_UPDATES_PER_TICK;
    this.stats = { queueLen: 0, processedThisTick: 0 };
  }

  attach(world) { this.W = world.W; this.H = world.H; }
  /* 调度去重键：必须是 (x,y) 的一一对应映射。
   * ★ 以前用「y*宽度+x」：世界改成无限宽之后它会撞车
   *   （x=4096,y=0 与 x=0,y=1 同键 → 去重把两个格子当成一个，流动就乱了）。
   *   y 恒在 0~255，所以 x*256+y 对任意（正负）x 都唯一。 */
  _cellKey(x, y) { return x * 256 + y; }
  /* world 可能不暴露 W/H 属性（game.js 的 World 是模块常量），用 attach 捕获的兜底 */
  _width(world) { return world.W ?? this.W; }

  /* ── 调度 ─────────────────────────────────────────────────────────── */
  schedule(world, x, y, delay) {
    const idx = this._cellKey(x, y);
    const trigger = world.tickCount + (delay | 0);
    const prev = this.pending.get(idx);
    if (prev !== undefined && prev <= trigger) return; // 已有更早/相同触发，去重
    this.pending.set(idx, trigger);
    this.heap.push({ t: trigger, seq: this.seq++, x, y });
    this._siftUp(this.heap.length - 1);
  }

  scheduleNeighbors(world, x, y) {
    for (const d of DIRS4) {
      const nx = x + d.x, ny = y + d.y;
      const c = world.fluidGet(nx, ny);
      if (c) this.schedule(world, nx, ny, this.tickDelay(c.type, world));
    }
  }

  /** 非流体方块被放置/破坏后，唤醒相邻流体重新计算。 */
  notifyBlockChanged(world, x, y) { this.scheduleNeighbors(world, x, y); }

  /** 倒一桶流体：目标为空气/可替换→放源头；目标为岩浆→按交互规则转化。 */
  pour(world, x, y, type) {
    const cur = world.fluidGet(x, y);
    if (cur && cur.type === type) return;            // 已是同类流体
    if (cur && cur.type !== type) {
      // 倒水到岩浆 / 倒岩浆到水：触发交互（源头→黑曜石、流动→圆石），不覆盖
      if (type === WATER && cur.type === LAVA) { this._lavaHitByFluid(world, x, y, cur); return; }
      if (type === LAVA && cur.type === WATER) { this._lavaCellConvert(world, x, y, cur); return; }
    }
    if (world.fluidSolid(x, y) || world.fluidBlocking(x, y)) return;
    world.fluidSet(x, y, { type, amount: 8, falling: false, isSource: true });
    this.schedule(world, x, y, this.tickDelay(type, world));
    this.scheduleNeighbors(world, x, y);
  }

  /** 舀起（仅源头可舀，流动态不行）；返回是否被舀起。 */
  scoop(world, x, y) {
    const c = world.fluidGet(x, y);
    if (!c || !c.isSource) return false;
    world.fluidSet(x, y, null);
    this.scheduleNeighbors(world, x, y);
    return true;
  }

  /* ── 单 tick 处理：取出所有 trigger<=now 的项，受 maxPerTick 限制 ────── */
  process(world, now) {
    let count = 0;
    while (this.heap.length && count < this.maxPerTick) {
      const top = this.heap[0];
      if (top.t > now) break;
      const item = this._popMin();
      const idx = this._cellKey(item.x, item.y);
      if (this.pending.get(idx) !== item.t) continue; // 已被更早的调度覆盖 → 丢弃
      this.pending.delete(idx);
      this.fluidTick(world, item.x, item.y);
      count++;
    }
    this.stats.queueLen = this.pending.size;
    this.stats.processedThisTick = count;
    return count;
  }

  /** 测试/生成用：把队列跑到空（或到达上限），同时推进 tickCount。 */
  runToCompletion(world, maxTicks = 200000) {
    let n = 0;
    while (this.heap.length && n < maxTicks) {
      world.tickCount++;
      this.process(world, world.tickCount);
      n++;
    }
    return this.stats;
  }

  hasPending() { return this.heap.length > 0; }
  queueLength() { return this.pending.size; }

  /* ── 单个流体格的 tick 算法（对应任务书 3.） ───────────────────────── */
  fluidTick(world, x, y) {
    let cell = world.fluidGet(x, y);
    if (!cell) return;
    let changed = false, spreadOccurred = false;

    if (!cell.isSource) {
      const ns = this.computeFlowingState(world, x, y, cell.type);
      if (ns === null) {                          // 衰减到空 → 清除
        world.fluidSet(x, y, null);
        this.scheduleNeighbors(world, x, y);
        return;
      }
      if (!sameCell(ns, cell)) {
        world.fluidSet(x, y, ns);
        changed = true;
        this.scheduleNeighbors(world, x, y);
        cell = ns;
      }
    }

    spreadOccurred = this.spread(world, x, y, cell);
    this.checkLava(world, x, y);

    // 只有「自己变了」或「确实向外扩散了」才继续排队，保证静止世界最终队列清空
    if (changed || spreadOccurred) {
      this.schedule(world, x, y, this.tickDelay(cell.type, world));
    }
  }

  /* 3.1 决定非源头格的新状态 */
  computeFlowingState(world, x, y, type) {
    const p = this.params(type, world);
    let maxAmount = 0, sourceCount = 0;
    for (const d of SIDES) {
      const n = this.fluidGet(world, x + d.x, y + d.y, type);
      if (n) {
        if (n.isSource) sourceCount++;
        if (n.amount > maxAmount) maxAmount = n.amount;
      }
    }
    // 无限水源：两侧水平相邻源头，且下方实心 / 同类源头
    if (p.canConvertToSource && sourceCount >= FLUID.INFINITE_SOURCE_MIN_NEIGHBORS) {
      const below = this.fluidGet(world, x, y + 1, type);
      if (world.fluidSolid(x, y + 1) || world.fluidBlocking(x, y + 1) ||
          (below && below.type === type && below.isSource)) {
        return { type, amount: 8, falling: false, isSource: true };
      }
    }
    // 上方有同类流体 → 变成下落流体
    if (this.fluidGet(world, x, y - 1, type)) {
      return { type, amount: 8, falling: true, isSource: false };
    }
    const newAmount = maxAmount - p.dropOff;
    return newAmount <= 0 ? null : { type, amount: newAmount, falling: false, isSource: false };
  }

  /* 3.2 向外扩散 */
  spread(world, x, y, cell) {
    // 先看下方：能落就落（下落水柱）
    if (this.canSpreadInto(world, x, y + 1, cell.type,
        { type: cell.type, amount: 8, falling: true, isSource: false })) {
      return this.spreadTo(world, x, y + 1,
        { type: cell.type, amount: 8, falling: true, isSource: false });
    }
    /* ★ 下方已是同类「下落中」流体 → 说明本格正被下方输送，不向两侧漫出。
       否则水柱上方的源头会在源头高度水平溢出（原版不会）。 */
    const below = world.fluidGet(x, y + 1);
    if (below && below.type === cell.type && below.falling) return false;
    // 源头，或下方不是「洞」（即被支撑）才向两侧扩散
    if (cell.isSource || !this.isHole(world, x, y + 1, cell.type)) {
      return this.spreadToSides(world, x, y, cell);
    }
    return false;
  }

  spreadToSides(world, x, y, cell) {
    const p = this.params(cell.type, world);
    let i = cell.amount - p.dropOff;
    if (cell.falling) i = FLUID.SPREAD_FALLING_AMOUNT;   // 下落落地后侧向起始量（[记忆] 7）
    if (i <= 0) return false;
    let occ = false;
    for (const dir of this.getSpreadDirections(world, x, y, cell.type)) {
      if (this.spreadTo(world, x + dir.x, y + dir.y,
          { type: cell.type, amount: i, falling: false, isSource: false })) occ = true;
    }
    return occ;
  }

  /* 3.3 找下坡：优先流向最近落差；落差距离相同则两侧都流 */
  getSpreadDirections(world, x, y, type) {
    let best = 1000;
    const result = [];
    for (const dir of SIDES) {
      const nx = x + dir.x, ny = y + dir.y;
      if (!this.canPassThrough(world, nx, ny, type)) continue;
      const d = this.isHole(world, nx, ny + 1, type) ? 0 : this.slopeDistance(world, nx, ny, 1, dir, type);
      if (d < best) { best = d; result.length = 0; result.push(dir); }
      else if (d === best) result.push(dir);
    }
    return result;
  }

  slopeDistance(world, x, y, step, dir, type) {
    const p = this.params(type, world);
    if (step > p.slopeFindDistance) return 1000;
    const nx = x + dir.x, ny = y + dir.y;
    if (!this.canPassThrough(world, nx, ny, type)) return 1000;
    if (this.isHole(world, nx, ny + 1, type)) return step;
    return this.slopeDistance(world, nx, ny, step + 1, dir, type);
  }

  /* 3.4 能否进入目标格：空气/可替换/同类且新量严格大于旧量；同类源头永不被覆盖 */
  canSpreadInto(world, x, y, type, newCell) {
    if (world.fluidSolid(x, y) || world.fluidBlocking(x, y)) return false;
    const f = world.fluidGet(x, y);            // ★ 必须用原始读取：异类流体不能当"空格"
    if (!f) return true;                       // 空气或可替换 → 可进（可替换在 spreadTo 里掉物品）
    if (f.type !== type) return false;        // 异类流体 → 不进（交互由岩浆自身检测）
    if (f.isSource) return false;             // 源头永不被流动态覆盖
    return newCell.amount > f.amount;          // 严格更大才覆盖
  }

  spreadTo(world, x, y, newCell) {
    if (!this.canSpreadInto(world, x, y, newCell.type, newCell)) return false;
    if (world.fluidReplaceable(x, y)) world.fluidDropItem(x, y);
    world.fluidSet(x, y, newCell);
    this.schedule(world, x, y, this.tickDelay(newCell.type, world));
    this.scheduleNeighbors(world, x, y);
    return true;
  }

  /* ── 水与岩浆交互（任务书 4.） ───────────────────────────────────────
   * 岩浆检测 上/左/右（不检测下方）。遇水：源头→黑曜石、流动→圆石。
   * 岩浆向下流入水所在格（目标是水）→ 水变石头，岩浆不再继续扩散。 */
  checkLava(world, x, y) {
    const cell = world.fluidGet(x, y);
    if (!cell || cell.type !== LAVA) return;
    for (const d of [UP, LEFT, RIGHT]) {
      const n = world.fluidGet(x + d.x, y + d.y);
      if (n && n.type === WATER) { this._lavaCellConvert(world, x, y, cell); return; }
    }
    /* 向下流入水（目标格是水）→ 水变石头。★ 只在岩浆「正在下落」时才转化：
       静置的岩浆源压着静水不算"流入"，与验收 7 的
       「水从下方接触岩浆不触发」保持一致。 */
    if (cell.falling) {
      const dn = world.fluidGet(x, y + 1);
      if (dn && dn.type === WATER) {
        world.fluidSetBlock(x, y + 1, FLUID_BLOCK.stone);
        this.scheduleNeighbors(world, x, y);
        this.scheduleNeighbors(world, x, y + 1);
        if (world.fluidSizzle) world.fluidSizzle(x, y + 1);
      }
    }
  }
  // 水从下方/侧面接触岩浆：源头→黑曜石，流动→圆石
  _lavaCellConvert(world, x, y, lavaCell) {
    const id = lavaCell.isSource ? FLUID_BLOCK.obsidian : FLUID_BLOCK.cobblestone;
    world.fluidSetBlock(x, y, id);
    this.scheduleNeighbors(world, x, y);
    if (world.fluidSizzle) world.fluidSizzle(x, y);
  }
  // 倒水到岩浆上（pour 的 WATER-on-LAVA 分支）
  _lavaHitByFluid(world, x, y, lavaCell) { this._lavaCellConvert(world, x, y, lavaCell); }

  /* ── 辅助：同类流体获取 / 可通过 / 是洞 ───────────────────────────── */
  fluidGet(world, x, y, type) {
    const f = world.fluidGet(x, y);
    if (!f) return null;
    if (type && f.type !== type) return null;   // 指定类型且不同 → 视为无
    return f;
  }
  canPassThrough(world, x, y, type) {
    // 同类流体 / 空气 / 可替换（火把、花草等）都算「可通过」（对应任务书 3.3）
    const f = world.fluidGet(x, y);
    if (f) return f.type === type;                // 同类流体通过；异类不通过
    if (world.fluidSolid(x, y) || world.fluidBlocking(x, y)) return false;
    return true;                                  // 空气 或 可替换 → 通过
  }
  isHole(world, x, y, type) {
    if (world.fluidSolid(x, y) || world.fluidBlocking(x, y)) return false;
    const f = world.fluidGet(x, y);
    if (f) return f.type === type;               // 同类流体 → 可继续往下；异类 → 不可
    return true;                                  // 空气/可替换 → 是洞
  }

  params(type, world) {
    if (type === LAVA && world.getDimension && world.getDimension() === 'nether') return FLUID.lava_nether;
    return FLUID[type];
  }
  tickDelay(type, world) { return this.params(type, world).tickDelay; }

  /* ── 存档：待处理队列按「相对剩余延迟」序列化，读档后恢复 ───────────── */
  serializeQueue(world) {
    const out = [];
    for (const [idx, trigger] of this.pending) {
      const x = Math.floor(idx / 256), y = idx - x * 256;
      out.push([x, y, trigger - world.tickCount]);
    }
    return out;
  }
  restoreQueue(world, list) {
    this.heap = []; this.pending.clear(); this.seq = 0;
    if (!Array.isArray(list)) return;
    for (const [x, y, rem] of list) {
      const trigger = world.tickCount + (rem | 0);
      const idx = this._cellKey(x, y);
      const prev = this.pending.get(idx);
      if (prev !== undefined && prev <= trigger) continue;
      this.pending.set(idx, trigger);
      this.heap.push({ t: trigger, seq: this.seq++, x, y });
      this._siftUp(this.heap.length - 1);
    }
  }

  /* ── 最小堆（按 (t, seq) 比较，seq 保证同 tick 内顺序确定） ────────── */  _less(a, b) { return a.t < b.t || (a.t === b.t && a.seq < b.seq); }
  _siftUp(i) {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this._less(h[i], h[p])) { const t = h[i]; h[i] = h[p]; h[p] = t; i = p; } else break;
    }
  }
  _popMin() {
    const h = this.heap, top = h[0], last = h.pop();
    if (h.length) { h[0] = last; this._siftDown(0); }
    return top;
  }
  _siftDown(i) {
    const h = this.heap, n = h.length;
    for (;;) {
      let l = 2 * i + 1, r = 2 * i + 2, s = i;
      if (l < n && this._less(h[l], h[s])) s = l;
      if (r < n && this._less(h[r], h[s])) s = r;
      if (s === i) break;
      const t = h[i]; h[i] = h[s]; h[s] = t; i = s;
    }
  }
}

/* ── 实体物理：流向推力（任务书 6.）──────────────────────────────────────
 * 实体所在格的流向由左右同类流体的 amount 差决定（高处流向低处）；
 * 上方是同类下落流体 → 产生向下推力。返回每 tick 的加速度（格/tick²），
 * 幅值取 config.FLUID 对应流体的 push（水 0.014、岩浆 0.007/3 [记忆]）。
 * 纯函数：不碰实体，game.js 拿到向量后叠进自身物理。 */
export function fluidPushVector(world, x, y) {
  const cell = world.fluidGet(Math.floor(x), Math.floor(y));
  if (!cell) return null;
  const p = (cell.type === LAVA && world.getDimension && world.getDimension() === 'nether')
    ? FLUID.lava_nether : FLUID[cell.type];
  const at = (dx, dy) => {
    const f = world.fluidGet(Math.floor(x) + dx, Math.floor(y) + dy);
    return (f && f.type === cell.type) ? f : null;
  };
  const l = at(-1, 0), r = at(1, 0);
  const lm = l ? l.amount : 0, rm = r ? r.amount : 0;
  let vx = 0, vy = 0;
  if (lm > rm) vx = 1;          // 左边水多 → 流向右
  else if (rm > lm) vx = -1;    // 右边水多 → 流向左
  const up = at(0, -1);
  if (up && up.falling) vy = 1; // 上方同类在垂直下落 → 向下推
  return { vx: vx * p.push, vy: vy * p.push };
}
