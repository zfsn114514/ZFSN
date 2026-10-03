/**
 * wasm 探针：解出 data 段字符串的**运行时地址**，并反查代码里的引用
 * ─────────────────────────────────────────────────────────────
 * 为什么要这个：
 *   pvz-portable.wasm 是 strip 过的，导出名全是 `sf`/`tf` 这种两字母，
 *   看不到 ProfileMgr 之类的符号。但 data 段里的字符串还在
 *   （如 "Full Unlock"、"userdata/user{}.dat"、"PVZP_SAVE4"）。
 *   只要把「文件偏移 → 运行时地址」这个映射建对，就能用
 *   `i32.const <addr>`（0x41 + sleb128）在 code 段里反查引用点，
 *   再定位到是哪个函数 —— 这样就能在不反汇编全量 wasm 的前提下
 *   找到关键逻辑。
 *
 * 这个脚本踩过的坑：
 *   data 段不能想当然按「count + (flags, memidx, offset, size, bytes)」解析。
 *   段数是 2032（!），说明这份 wasm 的 data 段被切得很碎；
 *   一旦某处 LEB 没对齐，后面全部偏移都是错的（我第一版就因为
 *   算错 code 段末尾，把字符串映射到了一个 133 的荒谬地址）。
 *   所以这里每一步都带断言：解析完必须正好落在 data 段末尾。
 *
 * 用法:
 *   node tools/dev/pvz_wasm_probe.cjs strings [过滤子串]
 *   node tools/dev/pvz_wasm_probe.cjs xref "Full Unlock"
 *   node tools/dev/pvz_wasm_probe.cjs <别的.wasm> strings   # 换文件
 * ───────────────────────────────────────────────────────────── */
"use strict";
const fs = require("fs");
const path = require("path");

// 命令词是固定的 strings / xref，所以「第一个参数」可能是命令、也可能是 wasm 路径。
// 之前只按位置取 argv[3] 当命令，导致 `... xref "Full Unlock"` 被解释成
// 「wasm 路径 = xref」，然后打印用法 —— 看起来像工具坏了，其实是没认命令。
const argv = process.argv.slice(2);
let WASM = path.join(__dirname, "..", "..", "pvz", "pvz-portable.wasm");
if (argv[0] && !["strings", "xref"].includes(argv[0])) {
  WASM = argv.shift();
}

const b = fs.readFileSync(WASM);

/* ── 段目录 ── */
function readSections(buf) {
  const secs = {};
  let p = 8;
  while (p < buf.length) {
    const id = buf[p++];
    let size = 0, shift = 0, by;
    do { by = buf[p++]; size |= (by & 0x7f) << shift; shift += 7; } while (by & 0x80);
    (secs[id] = secs[id] || []).push({ start: p, size });
    p += size;
    if (p > buf.length) throw new Error("段解析越界：id=" + id);
  }
  return secs;
}
const secs = readSections(b);
const sec = (id) => secs[id] && secs[id][secs[id].length - 1];

/* ── LEB 读取器 ── */
function makeReader(buf, pos) {
  return {
    get pos() { return pos; },
    set pos(v) { pos = v; },
    u32() {
      let x = 0, s = 0, by;
      do {
        if (pos >= buf.length) throw new Error("LEB 读越界 @" + pos);
        by = buf[pos++];
        x += (by & 0x7f) * Math.pow(2, s);
        s += 7;
      } while (by & 0x80);
      return x;
    },
    // 有符号 LEB，用于 i32.const
    i32() {
      let x = 0, s = 0, by;
      do {
        if (pos >= buf.length) throw new Error("LEB 读越界 @" + pos);
        by = buf[pos++];
        x |= (by & 0x7f) << s;
        s += 7;
      } while (by & 0x80);
      if (s < 32 && (by & 0x40)) x |= (~0 << s);
      return x | 0;
    },
    skip(n) { pos += n; },
  };
}

/* ── data 段：建 文件偏移 → 运行时地址 映射 ── */
function parseDataSegments() {
  const s = sec(11);
  const r = makeReader(b, s.start);
  const count = r.u32();
  const segs = [];
  for (let i = 0; i < count; i++) {
    const flags = r.u32();
    if (flags !== 0 && flags !== 2 && flags !== 1) {
      throw new Error("遇到未知 data 段 flags=" + flags + "（第 " + i + " 段）");
    }
    let memOffset = 0;
    if (flags === 0 || flags === 2) {
      // 这里**没有 memidx**。按 wasm 规范，data 段是
      //   flags:u32 | (memidx:u32, 仅当 flags==2) | offset:init_expr | size | bytes
      // 我第一版按「flags 后一定有 memidx」写，结果把 offset 表达式的
      // 0x41(i32.const) 当成 memidx 吃掉，紧接着读到的 0x84 就
      // 「不是 i32.const」报错。段数 2032 看着很碎，也容易让人误判格式。
      const op = b[r.pos];
      if (op !== 0x41) throw new Error("offset 表达式不是 i32.const，op=0x" + op.toString(16));
      r.pos++;                       // 吃掉 0x41
      memOffset = r.i32() >>> 0;      // 读 sleb
      const end = b[r.pos];
      if (end !== 0x0b) throw new Error("offset 表达式结尾不是 0x0b，是 0x" + end.toString(16));
      r.pos++;                       // 吃掉 0x0b
    }
    const len = r.u32();
    segs.push({ file: r.pos, mem: memOffset, len, flags });
    r.skip(len);
  }
  const end = s.start + s.size;
  if (r.pos !== end) {
    throw new Error(
      "data 段解析未对齐：停在与预期相差 " + (end - r.pos) +
      " 字节处（多半是某处 LEB 读法不对，不能继续用这个映射）"
    );
  }
  return segs;
}

const dataSegs = parseDataSegments();

function memOfFileOffset(fo) {
  for (const s of dataSegs) {
    if (fo >= s.file && fo < s.file + s.len) return s.mem + (fo - s.file);
  }
  return null;
}

/* ── code 段：函数体边界 ── */
function parseFunctions() {
  const s = sec(10);
  const r = makeReader(b, s.start);
  const count = r.u32();
  const funcs = [];
  for (let i = 0; i < count; i++) {
    const size = r.u32();
    funcs.push({ start: r.pos, size, end: r.pos + size });
    r.skip(size);
  }
  if (r.pos !== s.start + s.size) throw new Error("code 段解析未对齐");
  // 起始文件偏移 → 函数下标
  const starts = funcs.map((f) => f.start);
  return {
    count,
    funcAt(off) {
      let lo = 0, hi = starts.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    },
  };
}
const fns = parseFunctions();

/* ── 字符串表 ── */
function strings(minLen = 4) {
  const out = [];
  let cur = "", start = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c >= 32 && c < 127) {
      if (!cur) start = i;
      cur += String.fromCharCode(c);
    } else {
      if (cur.length >= minLen) {
        const mem = memOfFileOffset(start);
        out.push({ file: start, mem, s: cur });
      }
      cur = "";
    }
  }
  if (cur.length >= minLen) {
    const mem = memOfFileOffset(start);
    out.push({ file: start, mem, s: cur });
  }
  return out;
}
const STRINGS = strings();

/* ── 反查 i32.const <addr> ── */
function slebBytes(v) {
  const out = [];
  let more = true;
  while (more) {
    let byte = v & 0x7f;
    v >>= 7;
    if ((v === 0 && !(byte & 0x40)) || (v === -1 && (byte & 0x40))) more = false;
    else byte |= 0x80;
    out.push(byte);
  }
  return out;
}

function xrefsToStr(needle) {
  const hit = STRINGS.find((x) => x.s === needle);
  if (!hit) return { error: "没找到字符串 " + JSON.stringify(needle) };
  if (hit.mem == null) return { error: "字符串 " + needle + " 不在任何 data 段里（file 0x" + hit.file.toString(16) + "）" };
  const s = sec(10);
  const pat = Buffer.from([0x41, ...slebBytes(hit.mem | 0)]);
  const hits = [];
  let pos = s.start;
  while ((pos = b.indexOf(pat, pos)) !== -1) {
    if (pos >= s.start + s.size) break;
    hits.push(pos);
    pos++;
  }
  return {
    needle,
    mem: "0x" + hit.mem.toString(16),
    file: "0x" + hit.file.toString(16),
    refs: hits.map((h) => ({
      file: "0x" + h.toString(16),
      func: fns.funcAt(h),
    })),
  };
}

/* ── CLI ── */
const cmd = argv[0] || "strings";
const arg = argv[1];

if (cmd === "strings") {
  const list = arg ? STRINGS.filter((x) => x.s.includes(arg)) : STRINGS;
  console.log("data 段 " + dataSegs.length + " 个，字符串 " + STRINGS.length + " 条");
  for (const x of list) {
    console.log(
      (x.mem == null ? "  ?  " : "0x" + x.mem.toString(16).padStart(6, "0")) +
      "  " + JSON.stringify(x.s)
    );
  }
  console.log("\n总计 " + list.length + " 条");
} else if (cmd === "xref") {
  const r = xrefsToStr(arg);
  if (r.error) { console.error(r.error); process.exit(1); }
  console.log("字符串 " + JSON.stringify(r.needle) + " 运行时地址 " + r.mem + "（文件 " + r.file + "）");
  console.log("引用点 " + r.refs.length + " 处：");
  for (const h of r.refs) console.log("  文件 " + h.file + "  函数 #" + h.func);
} else {
  console.log("用法: node pvz_wasm_probe.cjs [wasm路径] strings [过滤] | xref \"字符串\"");
  console.log("默认 wasm: " + WASM);
}
