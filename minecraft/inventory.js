/* ── 物品栏数据层（纯数据，可单测）─────────────────────────────────
 *
 * 这一层的唯一职责：给「一格格子 + 一个手持栈 + 一次点击」算出新状态。
 * 它不 import DOM、不 import canvas、不 import 游戏本体，因此 node 里
 * 可以直接跑 `node --test minecraft/tests/`。
 *
 * ★ 为什么要拆出来：
 *   以前 clickSlot / shiftMove / collectSame / 拖拽全写在 game.js 的 boot()
 *   闭包里，每个分支顺手改 world.inventory 和 heldItem。想验证
 *   「Shift+点击快捷栏应该先进主背包」只能开浏览器点鼠标，而且改一处
 *   另一处就悄悄回归（丢物品、复制物品这类 bug 都出在这里）。
 *
 * ★ 栈的形状和存档保持一致：{id, n, dur?, nbt?}
 *   dur 就是原版的 damage（耐久已消耗值），这里沿用地图里的字段名，
 *   避免全站存档迁移。sameStack() 是唯一的「同类」判据。
 */

export const EMPTY = null;
export const MAX_STACK = 64;

/* ── 栈的基本操作 ─────────────────────────────────────────────── */

export function stack(id, n = 1, extra = null) {
  const s = { id, n };
  if (extra) for (const k of Object.keys(extra)) if (extra[k] !== undefined && extra[k] !== null) s[k] = extra[k];
  return s;
}

export function cloneStack(s) {
  if (!s) return EMPTY;
  const out = { ...s };
  if (s.nbt && typeof s.nbt === 'object') out.nbt = JSON.parse(JSON.stringify(s.nbt));
  return out;
}

/** 原版 areItemStacksEqual：id、damage(dur)、nbt 全一致才算同类。 */
export function sameStack(a, b) {
  if (!a || !b) return false;
  if (a.id !== b.id) return false;
  if ((a.dur ?? null) !== (b.dur ?? null)) return false;
  return sameNbt(a.nbt, b.nbt);
}

function sameNbt(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 只按下标里的 id 数总量（掉落物合并、任务统计用）。 */
export function totalOf(stacks, id) {
  return stacks.reduce((sum, s) => sum + (s && s.id === id ? s.n : 0), 0);
}

/* ── Slot / Container ─────────────────────────────────────────── */

/**
 * 一格。
 * @param {object} o
 *  - get/set：读写真实存储（数组、对象属性、甚至计算值）
 *  - place：额外放置规则（盔甲槽、合成输出槽）
 *  - take：能否取走（合成输出能取不能放）
 *  - limit：该格自己的堆叠上限（合成输出、创造格）
 *  - tag：UI 用来定位（'out' | 'grid' | 'armor' | 'inv' | 'offhand'）
 */
export class Slot {
  constructor({ get, set, place = null, take = true, limit = null, tag = '', meta = null, output = false }) {
    this._get = get;
    this._set = set;
    this._place = place;
    this._take = take;
    this._limit = limit;
    this.tag = tag;
    this.meta = meta;
    this.output = output;      // 合成输出格：能取不能放（Shift+点击走「一键合成」）
  }
  get() { return this._get() ?? EMPTY; }
  set(s) { this._set(s ?? EMPTY); }
  canTake() { return this._take !== false; }
  canPlace(s) { return !!s && !this.output && (this._place ? !!this._place(s) : true); }
  limitFor(s) { return this._limit != null ? this._limit : null; }
}

/**
 * 一个容器（玩家背包、工作台、箱子…）+ 一个手持栈。
 * 所有交互都从 click() 进 —— 这是「统一入口」的落点。
 */
export class Container {
  constructor(slots, reg) {
    this.slots = slots;
    this.reg = reg || { maxStack: () => MAX_STACK };
    this.cursor = EMPTY;
    this.outbox = [];          // 被丢出去的栈，游戏层取走生成掉落物
  }

  maxStackOf(s) {
    if (!s) return MAX_STACK;
    return this.reg?.maxStack ? this.reg.maxStack(s.id) : MAX_STACK;
  }

  /** 某格最多能装多少个「这一种栈」。 */
  limitOf(slot, s) {
    const own = slot.limitFor(s);
    return own != null ? Math.min(own, this.maxStackOf(s)) : this.maxStackOf(s);
  }

  /** 统一入口。返回 true 表示「状态有变化」。 */
  click(index, button, mode = 'pickup', opts = {}) {
    const slot = index == null || index < 0 ? null : this.slots[index];
    switch (mode) {
      case 'pickup':     return this._pickup(slot, button);
      case 'quick':      return this._quick(slot, index, opts);
      case 'swap':       return this._swap(slot, opts.target);
      case 'clone':      return this._clone(slot);
      case 'throw':      return this._throwSlot(slot, !!opts.all);
      case 'throw_cursor': return this._throwCursor(button === 2 ? 1 : Infinity);
      case 'pickup_all': return this._pickupAll(slot);
      case 'destroy_cursor': this.cursor = EMPTY; return true;
      default: return false;
    }
  }

  /* 4.2 普通点击 */
  _pickup(slot, button) {
    if (!slot) return false;
    const cur = this.cursor;
    const t = slot.get();

    if (button === 2) {
      /* 右键 */
      if (!cur) {
        if (!t || !slot.canTake()) return false;
        const take = Math.ceil(t.n / 2);
        this.cursor = { ...t, n: take };
        slot.set(t.n - take > 0 ? { ...t, n: t.n - take } : EMPTY);
        return true;
      }
      if (!slot.canPlace(cur)) return false;
      if (!t) {
        slot.set({ ...cur, n: 1 });
        this.cursor = cur.n > 1 ? { ...cur, n: cur.n - 1 } : EMPTY;
        return true;
      }
      if (sameStack(t, cur)) {
        const lim = this.limitOf(slot, t);
        if (t.n >= lim) { this.cursor = t; slot.set(cur); return true; }   // 满了 → 交换
        slot.set({ ...t, n: t.n + 1 });
        this.cursor = cur.n > 1 ? { ...cur, n: cur.n - 1 } : EMPTY;
        return true;
      }
      slot.set(cur); this.cursor = t; return true;                        // 异类 → 交换
    }

    /* 左键 */
    if (!cur) {
      if (!t || !slot.canTake()) return false;
      slot.set(EMPTY); this.cursor = t; return true;
    }
    if (!slot.canPlace(cur)) return false;
    if (!t) { slot.set(cur); this.cursor = EMPTY; return true; }
    if (sameStack(t, cur)) {
      const room = this.limitOf(slot, t) - t.n;
      if (room <= 0) { this.cursor = t; slot.set(cur); return true; }     // 满了 → 交换
      const move = Math.min(room, cur.n);
      slot.set({ ...t, n: t.n + move });
      this.cursor = cur.n - move > 0 ? { ...cur, n: cur.n - move } : EMPTY;
      return true;
    }
    slot.set(cur); this.cursor = t; return true;                          // 异类 → 交换
  }

  /* 4.3 Shift+点击 */
  _quick(slot, index, opts) {
    if (!slot) return false;
    const s = slot.get();
    if (!s) return false;
    if (slot.output) return opts.craftAll ? !!opts.craftAll(index) : false;
    if (!slot.canTake()) return false;
    const order = opts.quickOrder ? opts.quickOrder(index, s, this) : [];
    return this.moveInto(slot, index, order || []);
  }

  /**
   * 把 from 格的栈搬进 order 里的格子：先并入同类未满堆叠，再放空格。
   * 搬不动的留在原格（原版行为：无处可放就原地不动）。
   */
  moveInto(fromSlot, fromIndex, order) {
    let s = fromSlot.get();
    if (!s) return false;
    const started = s.n;

    for (const i of order) {                                   // ① 合并同类
      if (!s) break;
      if (i === fromIndex) continue;
      const t = this.slots[i];
      if (!t || !t.canPlace(s)) continue;
      const ts = t.get();
      if (!ts || !sameStack(ts, s)) continue;
      const room = this.limitOf(t, ts) - ts.n;
      if (room <= 0) continue;
      const move = Math.min(room, s.n);
      t.set({ ...ts, n: ts.n + move });
      s = s.n - move > 0 ? { ...s, n: s.n - move } : EMPTY;
    }
    for (const i of order) {                                   // ② 放进空格
      if (!s) break;
      if (i === fromIndex) continue;
      const t = this.slots[i];
      if (!t || !t.canPlace(s) || t.get()) continue;
      const move = Math.min(this.limitOf(t, s), s.n);
      t.set({ ...s, n: move });
      s = s.n - move > 0 ? { ...s, n: s.n - move } : EMPTY;
    }
    fromSlot.set(s);
    return (s ? s.n : 0) !== started;
  }

  /* 4.4 数字键 / F：悬停格与快捷栏格互换 */
  _swap(slot, target) {
    if (!slot || target == null) return false;
    const other = this.slots[target];
    if (!other || other === slot) return false;
    const a = slot.get(), b = other.get();
    if (!a && !b) return false;
    if (a && !other.canPlace(a)) return false;
    if (b && !slot.canPlace(b)) return false;
    if (a && !b) {                                 // 目标空：整栈搬过去，不校验上限
      other.set(a); slot.set(EMPTY); return true;
    }
    other.set(a); slot.set(b);
    return true;
  }

  /* 4.12 中键：复制整栈到光标（仅创造模式由调用方把关） */
  _clone(slot) {
    if (!slot) return false;
    const s = slot.get();
    if (!s) return false;
    this.cursor = { ...s, n: this.maxStackOf(s) };
    return true;
  }

  /* 4.5 丢弃 */
  _throwSlot(slot, all) {
    if (!slot || !slot.canTake()) return false;
    const s = slot.get();
    if (!s) return false;
    const n = all ? s.n : 1;
    slot.set(s.n - n > 0 ? { ...s, n: s.n - n } : EMPTY);
    this.outbox.push({ ...s, n });
    return true;
  }

  _throwCursor(n) {
    const s = this.cursor;
    if (!s) return false;
    const take = Math.min(n, s.n);
    this.outbox.push({ ...s, n: take });
    this.cursor = s.n - take > 0 ? { ...s, n: s.n - take } : EMPTY;
    return true;
  }

  /* 4.6 双击收集：先把未满的收完，再收满的 */
  _pickupAll(target) {
    const cur = this.cursor;
    if (!cur) return false;
    const lim = this.maxStackOf(cur);
    let moved = false;
    const sweep = (wantPartial) => {
      for (const t of this.slots) {
        if (this.cursor.n >= lim) return;
        if (t.output || !t.canTake()) continue;
        const ts = t.get();
        if (!sameStack(ts, this.cursor)) continue;
        if (wantPartial !== ts.n < lim) continue;
        const room = lim - this.cursor.n;
        if (room <= 0) return;
        const move = Math.min(room, ts.n);
        this.cursor = { ...this.cursor, n: this.cursor.n + move };
        t.set(ts.n - move > 0 ? { ...ts, n: ts.n - move } : EMPTY);
        moved = true;
      }
    };
    sweep(true);
    sweep(false);
    return moved;
  }

  /** 关闭界面：光标里的东西塞回容器，塞不下的交给调用方（丢到世界里）。 */
  drainCursor(order = []) {
    const cur = this.cursor;
    if (!cur) return EMPTY;
    this.cursor = EMPTY;
    const fake = { get: () => cur, set: () => {} };
    const before = cur.n;
    this.moveInto(fake, -1, order.length ? order : this.slots.map((_, i) => i));
    const left = fake.get();
    return left && left.n === before ? cur : (left || EMPTY);
  }
}

/* ── 4.7 拖拽分配（QUICK_CRAFT）────────────────────────────────────
 *
 * 左键拖：经过的格子每格先放 1 个，松开时把「光标剩余 + 本轮放出去的」
 *        按格数均分，余数留在光标上（每格受 maxStack 限制）。
 * 右键拖：每格放 1 个，剩下的留在光标上。
 * 创造中键拖：每格填满到上限，光标不消耗。
 */
export class DragSession {
  constructor(container, button, opts = {}) {
    this.c = container;
    this.button = button;
    this.creative = !!opts.creative;
    this.active = false;
    this.order = [];               // 经过的格子（按经过顺序）
    this.records = new Map();      // index -> {base, added}
    this.proto = EMPTY;
  }

  begin(index) {
    const cur = this.c.cursor;
    if (!cur) return false;
    this.active = true;
    this.proto = { ...cur };
    this.pass(index);
    return true;
  }

  /** 经过一格。返回 true 表示这一格有新东西。 */
  pass(index) {
    if (!this.active) return false;
    const slot = this.c.slots[index];
    if (!slot) return false;
    if (this.records.has(index)) return false;
    const cur = this.c.cursor;
    if (!cur) return false;
    if (slot.output || !slot.canPlace(cur)) return false;

    const base = slot.get();
    if (base && !sameStack(base, cur)) return false;          // 只认空格或同类
    const lim = this.c.limitOf(slot, cur);
    const have = base ? base.n : 0;
    if (have >= lim) return false;

    if (this.button === 1 && this.creative) {                 // 中键：填满，不消耗光标
      slot.set({ ...cur, n: lim });
      this.order.push(index);
      this.records.set(index, { base, added: lim - have, infinite: true });
      return true;
    }

    slot.set({ ...cur, n: have + 1 });
    this.c.cursor = cur.n > 1 ? { ...cur, n: cur.n - 1 } : EMPTY;
    this.order.push(index);
    this.records.set(index, { base, added: 1 });
    return this.c.cursor !== EMPTY;
  }

  /** 左键拖的实时预览：这一格最终会是多少个。 */
  projection() {
    const out = new Map();
    if (!this.active || this.button !== 0) return out;
    const cur = this.c.cursor;
    let total = cur ? cur.n : 0;
    for (const r of this.records.values()) if (!r.infinite) total += r.added;
    const per = this.records.size ? Math.floor(total / this.records.size) : 0;
    for (const [i, r] of this.records) {
      if (r.infinite) { out.set(i, this.c.limitOf(this.c.slots[i], this.proto)); continue; }
      const base = r.base ? r.base.n : 0;
      const lim = this.c.limitOf(this.c.slots[i], this.proto);
      out.set(i, Math.min(lim, base + per));
    }
    return out;
  }

  end() {
    if (!this.active) return false;
    this.active = false;
    if (this.button !== 0) return true;                        // 右键/中键：已经在 pass 里放好了
    const visited = this.order.slice();
    if (!visited.length) return false;

    const cur = this.c.cursor;
    let total = cur ? cur.n : 0;
    for (const i of visited) total += this.records.get(i).added;

    for (const i of visited) this.c.slots[i].set(this.records.get(i).base);   // 回到拖拽前
    const per = Math.floor(total / visited.length);
    let used = 0;
    for (const i of visited) {
      const slot = this.c.slots[i];
      const base = this.records.get(i).base;
      const lim = this.c.limitOf(slot, this.proto);
      const have = base ? base.n : 0;
      const give = Math.min(per, Math.max(0, lim - have));
      if (give <= 0) continue;
      slot.set({ ...this.proto, n: have + give });
      used += give;
    }
    const left = total - used;
    this.c.cursor = left > 0 ? { ...this.proto, n: left } : EMPTY;
    return true;
  }
}

/* ── 玩家背包布局（与 Java 版一致）─────────────────────────────
 *   0      合成输出
 *   1~4    2×2 合成格
 *   5~8    盔甲（头、胸、腿、鞋）
 *   9~35   主背包 27 格
 *   36~44  快捷栏 9 格
 *   45     副手
 * 工作台（3×3）是另一个容器，拼在 46 之后，这样上面这些下标永远不变。
 */
export const LAYOUT = {
  OUTPUT: 0,
  GRID: 1,
  ARMOR: 5,
  MAIN: 9, MAIN_END: 35,
  HOTBAR: 36, HOTBAR_END: 44,
  OFFHAND: 45,
  PLAYER_SIZE: 46,
  TABLE_OUTPUT: 46,
  TABLE_GRID: 47,
};
export const ARMOR_PARTS = ['helmet', 'chestplate', 'leggings', 'boots'];

export function armorPartOf(id) {
  const m = String(id || '').match(/_(helmet|chestplate|leggings|boots|horse_armor)$/);
  if (!m) return null;
  return m[1] === 'horse_armor' ? null : m[1];
}

/**
 * 构造玩家容器的 46 个格子。
 * @param o.inventory 36 长数组（0–8 是快捷栏）
 * @param o.armor     {helmet,chestplate,leggings,boots}
 * @param o.grid      2×2 合成格（4 长数组）
 * @param o.offhand   {value} —— 用对象包一层，方便写回
 * @param o.output    () => 当前合成结果
 */
export function buildPlayerSlots(o) {
  const { inventory, armor, grid, offhand, output } = o;
  const slots = [];

  slots.push(new Slot({
    get: () => (output ? output() : EMPTY), set: () => {},
    place: () => false, take: true, output: true, tag: 'out', meta: LAYOUT.OUTPUT,
  }));

  for (let i = 0; i < 4; i++) {
    slots.push(new Slot({
      get: () => (grid ? grid[i] ?? EMPTY : EMPTY),
      set: s => { if (grid) grid[i] = s; },
      tag: 'grid', meta: i,
    }));
  }

  for (let i = 0; i < 4; i++) {
    const part = ARMOR_PARTS[i];
    slots.push(new Slot({
      get: () => armor?.[part] ?? EMPTY,
      set: s => { if (armor) armor[part] = s; },
      place: s => armorPartOf(s.id) === part,
      tag: 'armor', meta: i,
    }));
  }

  for (let i = LAYOUT.MAIN; i <= LAYOUT.MAIN_END; i++) {
    slots.push(new Slot({
      get: () => inventory[i] ?? EMPTY,
      set: s => { inventory[i] = s; },
      tag: 'inv', meta: i,
    }));
  }
  for (let i = LAYOUT.HOTBAR; i <= LAYOUT.HOTBAR_END; i++) {
    const h = i - LAYOUT.HOTBAR;
    slots.push(new Slot({
      get: () => inventory[h] ?? EMPTY,
      set: s => { inventory[h] = s; },
      tag: 'inv', meta: h,
    }));
  }

  slots.push(new Slot({
    get: () => offhand?.value ?? EMPTY,
    set: s => { if (offhand) offhand.value = s; },
    tag: 'offhand', meta: LAYOUT.OFFHAND,
  }));

  return slots;
}

/** 工作台 3×3 容器（拼在玩家容器后面）。 */
export function buildTableSlots(o) {
  const { grid, output } = o;
  const slots = [new Slot({
    get: () => (output ? output() : EMPTY), set: () => {},
    place: () => false, take: true, output: true, tag: 'tout', meta: 0,
  })];
  for (let i = 0; i < 9; i++) {
    slots.push(new Slot({
      get: () => (grid ? grid[i] ?? EMPTY : EMPTY),
      set: s => { if (grid) grid[i] = s; },
      tag: 'tgrid', meta: i,
    }));
  }
  return slots;
}

/* ── 合成：有序 / 无序 ────────────────────────────────────────── */

/** 把 {pattern,key} 的配方补出 needs（旧代码、配方书、/give 提示都在用 needs）。 */
export function normalizeRecipe(r) {
  if (!r || !r.pattern) return { ...r, shaped: false };
  const needs = {};
  for (const row of r.pattern) for (const ch of row) {
    if (ch === ' ') continue;
    const id = r.key?.[ch];
    if (!id) throw Error(`配方 ${r.out} 缺少 key「${ch}」`);
    needs[id] = (needs[id] || 0) + 1;
  }
  return { ...r, needs, shaped: true };
}

export function normalizeRecipes(list) {
  return list.map(normalizeRecipe);
}

function trimRows(rows) {
  let out = rows.map(r => String(r));
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  let left = Infinity, right = -1;
  for (const r of out) {
    const a = r.search(/\S/), b = r.length - 1 - [...r].reverse().findIndex(c => c !== ' ');
    if (a >= 0) { left = Math.min(left, a); right = Math.max(right, b); }
  }
  if (right < 0) return [];
  return out.map(r => r.slice(left, right + 1).padEnd(right - left + 1, ' '));
}

function mirrorRows(rows) {
  return rows.map(r => [...r].reverse().join(''));
}

/** 网格里非空格子的包围盒（无视 null）。 */
function bounds(cells, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!cells[y * w + x]) continue;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/**
 * 在网格里找配方。
 * @param cells  长度 w*h 的栈数组（null 表示空）
 * @param opts.mirror 是否也试左右镜像（原版合成台会；2×2 玩家格子同样）
 * @returns 命中的配方对象或 null
 */
export function matchRecipe(recipes, cells, w, h, opts = {}) {
  const box = bounds(cells, w, h);
  if (!box) return null;
  const bw = box.maxX - box.minX + 1, bh = box.maxY - box.minY + 1;

  for (const raw of recipes) {
    const r = raw.shaped === undefined ? normalizeRecipe(raw) : raw;
    if (opts.station === false && r.station) continue;
    if (!r.shaped) {
      // 无序：只比「每种材料的总数」
      const have = {};
      for (const s of cells) if (s) have[s.id] = (have[s.id] || 0) + s.n;
      const keys = Object.keys(r.needs || {});
      if (keys.length !== Object.keys(have).length) continue;
      if (keys.every(id => have[id] === r.needs[id])) return r;
      continue;
    }
    const pat = trimRows(r.pattern);
    if (!pat.length) continue;
    const ph = pat.length, pw = pat[0].length;
    if (ph !== bh || pw !== bw) continue;
    if (matchesAt(r, pat, cells, w, box)) return r;
    if (opts.mirror !== false) {
      const mp = mirrorRows(pat);
      if (matchesAt(r, mp, cells, w, box)) return r;
    }
  }
  return null;
}

function matchesAt(r, pat, cells, w, box) {
  for (let y = 0; y < pat.length; y++) for (let x = 0; x < pat[0].length; x++) {
    const ch = pat[y][x];
    const want = ch === ' ' ? null : r.key[ch];
    const got = cells[(box.minY + y) * w + (box.minX + x)];
    if (want === null) { if (got) return false; continue; }
    if (!got || got.id !== want) return false;
  }
  return true;
}

/**
 * 合成一次：按配方从网格里扣材料，返回 {out, n} 或 null。
 * remainder: {itemId: 剩余物Id}（如水桶 → 空桶）。扣到 0 时用剩余物替换。
 */
export function consumeForCraft(cells, w, h, recipe, remainder = {}) {
  const box = bounds(cells, w, h);
  if (!box) return null;
  const take = (index, id) => {
    const s = cells[index];
    if (!s || s.id !== id) return false;
    if (s.n > 1) cells[index] = { ...s, n: s.n - 1 };
    else cells[index] = remainder[id] ? { id: remainder[id], n: 1 } : null;
    return true;
  };
  if (recipe.shaped) {
    const pat = trimRows(recipe.pattern);
    for (let y = 0; y < pat.length; y++) for (let x = 0; x < pat[0].length; x++) {
      const ch = pat[y][x];
      if (ch === ' ') continue;
      take((box.minY + y) * w + (box.minX + x), recipe.key[ch]);
    }
    return { out: recipe.out, n: recipe.n || 1 };
  }
  for (const [id, need] of Object.entries(recipe.needs || {})) {
    let left = need;
    for (let i = 0; i < cells.length && left > 0; i++) {
      const s = cells[i];
      if (!s || s.id !== id) continue;
      const use = Math.min(left, s.n);
      left -= use;
      if (s.n - use > 0) cells[i] = { ...s, n: s.n - use };
      else cells[i] = remainder[id] ? { id: remainder[id], n: 1 } : null;
    }
  }
  return { out: recipe.out, n: recipe.n || 1 };
}
