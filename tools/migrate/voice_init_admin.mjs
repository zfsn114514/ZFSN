/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 首个管理员初始化脚本（一次性）
 *
 *  为什么是脚本而不是在代码里写死默认密码：
 *    任何写进仓库的默认账号都是公开的后门。首个管理员必须由部署者
 *    在本地提供用户名与密码，脚本只产出**密码哈希**的 SQL，
 *    明文既不写文件、也不打印、也不进命令行历史（推荐用环境变量）。
 *
 *  用法（PowerShell）：
 *    $env:VOICE_ADMIN_USERNAME="admin"
 *    $env:VOICE_ADMIN_PASSWORD="换成一段强密码"
 *    node tools/migrate/voice_init_admin.mjs
 *    npx wrangler d1 execute zfsn-db --remote --file=./tools/migrate/voice_admin_init.sql
 *
 *  本地库把 --remote 换成 --local。也支持 --username= / --password=，
 *  但命令行参数会留在 shell 历史里，仅本地调试时图方便用。
 *
 *  生成的 SQL 用 INSERT OR REPLACE，可重复执行（相当于改密 + 恢复启用）。
 * ══════════════════════════════════════════════════════════════ */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  validateUsername,
  validatePassword,
  avatarColorFor,
  randomHexString,
  hashPasswordRecord
} from "../../src/voice-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "voice_admin_init.sql");

function arg(name) {
  const prefix = "--" + name + "=";
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : "";
}

const username = (process.env.VOICE_ADMIN_USERNAME || arg("username") || "").trim().toLowerCase();
const password = process.env.VOICE_ADMIN_PASSWORD || arg("password") || "";
const displayName = (process.env.VOICE_ADMIN_DISPLAY || arg("display") || "管理员").trim();

function die(msg) {
  console.error("✘ " + msg);
  process.exit(1);
}

if (!username) die("缺少 VOICE_ADMIN_USERNAME（3~20 位小写字母 / 数字 / 下划线）");
if (!validateUsername(username).ok) die(validateUsername(username).error);
if (!password) die("缺少 VOICE_ADMIN_PASSWORD");
if (!validatePassword(password).ok) die(validatePassword(password).error);
if (displayName.length > 24) die("显示名称不能超过 24 个字符");

function sqlStr(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/* salt 与 Worker 的 L.hashPassword 完全一致：16 字节随机数的 hex 字符串，
   并且参与 PBKDF2 运算时按 UTF-8 字符串编码（不是解码成 16 字节）。
   这里直接复用 voice-core.js 的 hashPasswordRecord，避免两边漂移。 */
const rec = await hashPasswordRecord(password, randomHexString(16), 100000);
const id = randomBytes(12).toString("hex");
const color = avatarColorFor(username);
const now = Date.now();

const sql = [
  "-- 由 tools/migrate/voice_init_admin.mjs 生成，仅含密码哈希，可安全提交或丢弃。",
  "-- 明文密码没有写入本文件。执行完建议删除本文件。",
  "-- 依赖 schema/0001_init.sql 与 schema/0003_voice.sql 已执行。",
  "",
  "INSERT OR REPLACE INTO voice_users",
  "  (id, username, display_name, avatar_ref, avatar_color, password_rec, role, status, created_at, last_login_at)",
  "VALUES (",
  "  " + sqlStr(id) + ", " + sqlStr(username) + ", " + sqlStr(displayName) + ", NULL, " + sqlStr(color) + ",",
  "  " + sqlStr(JSON.stringify(rec)) + ", 'admin', 'active', " + now + ", NULL",
  ");",
  "-- 保险：把这个用户名已有的其它普通账号会话清掉，避免旧 Cookie 仍可登录。",
  "DELETE FROM voice_sessions WHERE user_id IN (SELECT id FROM voice_users WHERE username = " + sqlStr(username) + " AND id <> " + sqlStr(id) + ");",
  ""
].join("\n");

writeFileSync(OUT, sql, "utf8");

console.log("✔ 已生成：" + OUT);
console.log("  用户名：" + username + "　角色：admin　（密码哈希已写入文件，明文未保存）");
console.log("");
console.log("线上执行：npx wrangler d1 execute zfsn-db --remote --file=./tools/migrate/voice_admin_init.sql");
console.log("本地执行：npx wrangler d1 execute zfsn-db --local  --file=./tools/migrate/voice_admin_init.sql");
console.log("");
console.log("⚠ 执行后请删除 tools/migrate/voice_admin_init.sql，并清除 VOICE_ADMIN_PASSWORD 环境变量。");
