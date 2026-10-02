/**
 * 重设管理员密码，直接生成可执行的 SQL。
 *
 *   node tools/migrate/set_password.mjs                   交互输入密码
 *   node tools/migrate/set_password.mjs --iterations=30000 指定 PBKDF2 轮数
 *
 * 为什么要这个脚本：
 *   PBKDF2 的轮数必须和 Worker 里的 env.PBKDF2_ITERATIONS 一致，
 *   改轮数就意味着旧哈希全部失效，得重新生成。
 *   从 data/config.json 平移过来的哈希是 120000 轮，别乱改。
 *
 * ⚠ 轮数与 CPU：免费版 Worker 单请求 CPU 上限 10ms，120000 轮实测约 90ms，
 *   登录接口有可能打满。打满的话把轮数降到 30000 并重设密码，
 *   同时把 wrangler.toml 里的 PBKDF2_ITERATIONS 改成 30000 —— 两处必须一致。
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argIter = (process.argv.find((a) => a.startsWith("--iterations=")) || "").split("=")[1];
const ITER = Number(argIter) || 120000;

/* 与 src/lib.js 保持一致：salt 是 32 位 hex 字符串，按 UTF-8 参与运算 */
function hashPassword(password, saltHex, iterations) {
  const salt = saltHex || crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 64, "sha512").toString("hex");
  return { salt, hash };
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
console.log("⚠ 确认 wrangler.toml 里的 PBKDF2_ITERATIONS 也是 " + ITER + "，否则登录会一直失败。");
console.log("  密码设置成功后，建议顺手把 password.sql 删掉（里面有哈希）。");
