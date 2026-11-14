// worldgen/chunk.js
// ───────────────────────────────────────────────────────────────────────────
// 区块（chunk）。2D 版：宽 16 列，高为整个世界高度（256）。
// 存储用 Uint16Array + 调色板（palette）索引，禁止用嵌套对象数组存每个方块（规格书 §9）。
// 调色板是全局固定的（见 worldgen.js 的 WG_PALETTE），所以「名字 → 索引」在所有区块里一致，
// 存档与跨区块写入才有稳定语义。
// ───────────────────────────────────────────────────────────────────────────
import { CHUNK_W, WORLD_HEIGHT, CHUNK_STATE } from './constants.js';

export class Chunk {
  constructor(cx, palette, nameToId){
    this.cx = cx;
    this.x0 = cx * CHUNK_W;
    this.x1 = cx * CHUNK_W + CHUNK_W - 1;
    this.W = CHUNK_W;
    this.H = WORLD_HEIGHT;
    this.blocks = new Uint16Array(CHUNK_W * WORLD_HEIGHT);   // 索引 = (y*CHUNK_W + lx)
    this.natural = new Uint8Array(CHUNK_W * WORLD_HEIGHT);  // 1 = 世界自带的树（玩家可穿过）
    this.state = CHUNK_STATE.EMPTY;
    this.modified = false;      // 玩家是否改动过（决定要不要写进存档）
    this.outgoing = [];         // 跨区块待写入：{cx, x, y, name}
    this._palette = palette;
    this._nameToId = nameToId;
  }

  /* 读方块名。区块外一律按空气处理（生成期不依赖邻居，保证顺序无关）。 */
  get(x, y){
    const lx = x - this.x0;
    if (lx < 0 || lx >= this.W || y < 0 || y >= this.H) return 'air';
    return this._palette[this.blocks[y * this.W + lx]] || 'air';
  }

  /* 读调色板索引（存档用，比名字省空间）。 */
  idAt(x, y){
    const lx = x - this.x0;
    if (lx < 0 || lx >= this.W || y < 0 || y >= this.H) return 0;
    return this.blocks[y * this.W + lx];
  }

  setId(x, y, id){
    const lx = x - this.x0;
    if (lx < 0 || lx >= this.W || y < 0 || y >= this.H) return false;
    this.blocks[y * this.W + lx] = id;
    return true;
  }

  /* 写方块名。区块外的写入进入 outgoing 队列（由 WorldGen 转发给邻居）。 */
  set(x, y, name){
    const lx = x - this.x0;
    if (lx < 0 || lx >= this.W || y < 0 || y >= this.H){
      this.outgoing.push({ cx: Math.floor(x / CHUNK_W), x, y, name });
      return false;
    }
    const id = this._nameToId.get(name);
    if (id === undefined){
      // 静默写成 0（空气）会「删掉」地形 —— 这是最难查的一类 bug。
      // 调色板缺名字属于程序错误，直接抛出来，不让它伪装成空气。
      throw new Error(`worldgen: 方块名 "${name}" 不在调色板里`);
    }
    this.blocks[y * this.W + lx] = id;
    return true;
  }

  /* 只填空气（树叶/植物用，保证不覆盖已有实心方块 → 顺序无关）。 */
  setIfAir(x, y, name){
    if (this.get(x, y) !== 'air') return false;
    this.set(x, y, name);
    return true;
  }

  markModified(){ this.modified = true; }

  /* 标记「世界自带的树」：玩家可穿过，但玩家动过之后要清零（沿用旧版 natural 语义）。 */
  setNatural(x, y, v){
    const lx = x - this.x0;
    if (lx < 0 || lx >= this.W || y < 0 || y >= this.H) return false;
    this.natural[y * this.W + lx] = v;
    return true;
  }
  naturalAt(x, y){
    const lx = x - this.x0;
    if (lx < 0 || lx >= this.W || y < 0 || y >= this.H) return 0;
    return this.natural[y * this.W + lx];
  }

  /* 该区块内某个 X 列的最高实心方块（调试用）。 */
  columnTop(x){
    const lx = x - this.x0;
    if (lx < 0 || lx >= this.W) return -1;
    for (let y = this.H - 1; y >= 0; y--){
      const id = this.blocks[y * this.W + lx];
      if (id !== 0) return y;
    }
    return -1;
  }
}
