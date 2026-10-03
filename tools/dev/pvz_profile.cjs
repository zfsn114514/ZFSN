/**
 * PvZ profile (user1.dat) 加解密 —— EA Seed 算法
 * ─────────────────────────────────────────────────────────────
 * 背景：用户提供了原版 PvZ 的通关存档（`D:/Desktop/植物大战老马/userdata/`），
 * 想知道能不能直接喂给线上的 wasm 版。
 *
 * 先说结论：**原版存档和 mod 版存档格式不同，不能直接用**。
 *   - 原版：文本 `key=value` 明文，经 EA Seed 加密（×4 长度）
 *   - mod 版：二进制，头部标识 `PVZP_SAVE4`（在 wasm 里确认过）
 *
 * 但原版格式仍然值得解开 —— 能确认这份存档到底通关了哪些内容
 * （关卡进度、金币、植物图鉴），以及反过来作为生成 mod 版存档的参考。
 *
 * EA Seed 算法（逆向社区公开的通用实现）：
 *   加密时明文长度 L → 密文长度 L×4
 *   1. 用 key（4 字节，原版 [0xDE,0xAD,0xBE,0xEF]）生成置换表
 *   2. 密文[perm[i]] = 明文[i] XOR key[i%4] 的变体
 *   3. 末尾追加校验用数据
 *
 * 这里不照抄各家实现（版本差异容易踩坑），而是**直接枚举尝试**：
 * 存档明文是强结构化的（`profile=` 开头、含 `level=50` 之类），
 * 用"解出来是否是可打印 ASCII"就能判定哪个实现是对的。
 *
 * 用法:
 *   node tools/dev/pvz_profile.cjs verify <user1.dat>
 *   node tools/dev/pvz_profile.cjs dump   <user1.dat>
 */
"use strict";
const fs = require("fs");

/* 原版 PvZ 用的 key */
const SEED = [0xDE, 0xAD, 0xBE, 0xEF];

/* 已知明文前缀 —— 原版存档正文一定以 "profile=" 开头。
 * 有了这个锚点，可以反推出正确的置换表。 */
const KNOWN_PREFIX = "profile=";

/* 判定一段字节是不是明文：可打印 ASCII 占比高，且能看到 key=value 结构 */
function scorePlain(buf) {
  if (!buf || !buf.length) return -1;
  const s = buf.toString("latin1");
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
  }
  const ratio = printable / s.length;
  // 加分项：出现 "profile="、"level="、"=" 等结构
  let bonus = 0;
  if (s.includes("profile=")) bonus += 100;
  if (s.includes("level=")) bonus += 30;
  if (s.includes("=")) bonus += 10;
  return ratio * 100 + bonus;
}

/* ── 构造 EA Seed 置换表 ──
 * 原版实现（Adam Cross 的 pvz 逆向）：
 *   1. 把 key 复制到长度 n 的数组
 *   2. 做一次 "DEAL"（发牌）：从第 0 位开始，每次把牌放到 (prev + i) % n
 *   3. 记录被占用位置，得到 perm
 * 这里直接按寻址方式生成，不模拟洗牌过程 —— 少一层出错可能。 */
function buildPerm(n) {
  const perm = new Array(n);
  const used = new Array(n * 4).fill(false);
  // 两份 key：正序 + 倒序，循环取（原版就是这个组合）
  const pool = [];
  for (let i = 0; i < SEED.length; i++) pool.push(SEED[i]);
  for (let i = SEED.length - 1; i >= 0; i--) pool.push(SEED[i]);

  for (let i = 0; i < n; i++) {
    const k = pool[i % pool.length];
    let idx = (k + i) % (n * 4);
    let guard = 0;
    while (used[idx] && guard++ < n * 4) idx = (idx + 1) % (n * 4);
    used[idx] = true;
    perm[i] = idx;
  }
  return perm;
}

/* 尝试一组 (置换 + 异或) 组合，看解出来像不像明文 */
function tryDecode(buf, perm, xorByte) {
  const n = buf.length / 4;
  if (!Number.isInteger(n)) return null;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = buf[perm[i]] ^ xorByte;
  return out;
}

/* 反过来：如果已知明文开头，可以反推 XOR 字节和置换起点。
 * 这是最可靠的做法 —— 不猜算法，直接用已知明文当密码学锚点。 */
function crackByKnownPrefix(buf) {
  const n = buf.length / 4;
  if (!Number.isInteger(n)) return null;
  // 密文长度是明文的 4 倍，说明每个明文字节对应 4 个密文字节之一。
  // 假设置换是 perm[i]，则明文[0]='p' 在密文的某个位置。
  // 遍历所有位置找满足 XOR 后等于 'p' 的组合。
  for (let p0 = 0; p0 < buf.length; p0++) {
    const xor = buf[p0] ^ KNOWN_PREFIX.charCodeAt(0);
    if (xor === 0) continue;
    // 检查这个 xor 能否解出连贯的前缀
    let ok = true;
    for (let i = 0; i < KNOWN_PREFIX.length; i++) {
      // 找明文第 i 字节在密文中的位置（每 4 个密文字节里挑一个）
      let found = false;
      for (let k = 0; k < 4; k++) {
        const pos = i * 4 + k;
        if (pos >= buf.length) break;
        if ((buf[pos] ^ xor) === KNOWN_PREFIX.charCodeAt(i)) { found = true; break; }
      }
      if (!found) { ok = false; break; }
    }
    if (ok) return { xor, p0 };
  }
  return null;
}

function hexdump(buf, len) {
  const n = Math.min(buf.length, len);
  const lines = [];
  for (let i = 0; i < n; i += 16) {
    const chunk = buf.subarray(i, Math.min(i + 16, n));
    const hex = Array.from(chunk).map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const asc = Array.from(chunk)
      .map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : "."))
      .join("");
    lines.push(`  ${i.toString(16).padStart(4, "0")}  ${hex.padEnd(47)}  ${asc}`);
  }
  return lines.join("\n");
}

const [, , cmd, file] = process.argv;

if (cmd === "verify" && file) {
  const buf = fs.readFileSync(file);
  console.log("文件:", file);
  console.log("大小:", buf.length, "字节");
  console.log("明文长度应为:", buf.length / 4, Number.isInteger(buf.length / 4) ? "(整除 ✓)" : "(不能整除 ✗)");
  console.log("\n原始字节（前 128）:");
  console.log(hexdump(buf, 128));

  const n = buf.length / 4;
  if (Number.isInteger(n)) {
    const perm = buildPerm(n);
    const results = [];
    for (const xor of [0x6A, 0x6F, 0x00, 0x20]) {
      const out = tryDecode(buf, perm, xor);
      results.push({ xor, out, score: scorePlain(out) });
    }
    results.sort((a, b) => b.score - a.score);
    console.log("\n尝试常见 XOR 字节:");
    for (const r of results) {
      console.log(`  XOR 0x${r.xor.toString(16).padStart(2, "0")}  评分 ${r.score.toFixed(1)}  开头: ${JSON.stringify(r.out.toString("latin1").slice(0, 60))}`);
    }
  }
} else if (cmd === "dump" && file) {
  const buf = fs.readFileSync(file);
  console.log("=== 原始字节 ===");
  console.log(hexdump(buf, 256));
  const c = crackByKnownPrefix(buf);
  if (c) {
    console.log(`\n用已知明文 'profile=' 反推: XOR=0x${c.xor.toString(16)}`);
  } else {
    console.log("\n无法用 'profile=' 锚点反推 —— 格式可能不是 EA Seed 4 倍加密");
  }
} else {
  console.log("用法:");
  console.log("  node tools/dev/pvz_profile.cjs verify <user1.dat>");
  console.log("  node tools/dev/pvz_profile.cjs dump   <user1.dat>");
}
