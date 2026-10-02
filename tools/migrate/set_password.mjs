/**
 * 重设管理员密码，直接生成可执行的 SQL。
 *
 *   node tools/migrate/set_password.mjs                    交互输入密码
 *   node tools/migrate/set_password.mjs "新密码"            直接给密码
 *   node tools/migrate/set_password.mjs --iterations=80000  指定 PBKDF2 轮数
 *
 * ⚠ 轮数上限 100000，这是 Workers 运行时的硬限制：
 *   超过就抛 "Pbkdf2 failed: iteration counts above 100000 are not supported"，
 *   登录永远失败。**从 data/config.json 平移来的哈希是 120000 轮，
 *   在 Workers 上根本没法校验，所以必须跑一次本脚本重设密码。**
 *
 *   轮数会被写进密码记录（rec.iter），之后即使改了 wrangler.toml 里的
 *   默认值，旧哈希仍按它自己的轮数校验，不会突然登不上。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const MAX_ITER = 100000; // Workers 硬上限，超了线上无法校验

const argIter = (process.argv.find((a) => a.startsWith("--iterations=")) || "").split("=")[1];
const ITER = Number(argIter) || MAX_ITER;

if (ITER > MAX_ITER) {
  console.error(
    "轮数 " + ITER + " 超过 Workers 上限 " + MAX_ITER + "，线上将无法校验，已中止。"
  );
  process.exit(1);
}

/* 与 src/lib.js 保持一致：salt 是 32 位 hex 字符串，按 UTF-8 参与运算 */
function hashPassword(password, saltHex, iterations) {
  const salt = saltHex || crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 64, "sha512").toString("hex");
  return { salt, hash, iter: iterations };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    // 不开 echo 的话看不到自己输的，反而容易打错；这里只在结束时清一行
    rl.question(question, (ans) => { rl.close(); resolve(ans); });
  });
}

const fromArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
let pwd = fromArg || "";
if (!pwd) pwd = (await ask("新密码（至少 6 位）：")).trim();
pwd = String(pwd).trim();

if (pwd.length < 6) {
  console.error("密码至少 6 位");
  process.exit(1);
}

const rec = hashPassword(pwd, null, ITER);
const sql =
  "INSERT INTO config (k, v) VALUES ('password', '" +
  JSON.stringify(rec).replace(/'/g, "''") +
  "') ON CONFLICT(k) DO UPDATE SET v = excluded.v;\n" +
  "DELETE FROM sessions;\n";

const outFile = path.join(HERE, "password.sql");
fs.writeFileSync(outFile, sql, "utf8");

console.log("");
console.log("✓ 已生成 " + outFile + "（PBKDF2-SHA512，" + ITER + " 轮）");
console.log("");
console.log("写进 D1：");
console.log("  npx wrangler d1 execute zfsn-db --remote --file=./tools/migrate/password.sql");
console.log("");
console.log("ℹ wrangler.toml 里的 PBKDF2_ITERATIONS 建议也保持 " + ITER +
  "（它只用于还没存轮数的老记录，超过 100000 会导致登录报错）。");
console.log("  密码设置成功后，建议顺手把 password.sql 删掉（里面有哈希）。");
