/**
 * 把旧后端 data/*.json 转成 D1 种子 SQL。
 *
 *   node tools/migrate/export_seed.mjs
 *   产物：tools/migrate/seed.sql
 *   然后：npx wrangler d1 execute zfsn-db --remote --file=./tools/migrate/seed.sql
 *
 * 脚本只生成文件，不碰数据库 —— 想先看看内容再决定要不要灌。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.ZFSN_DATA || "D:/ZFSN-server/data";
const OUT = path.join(HERE, "seed.sql");

const readJSON = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));
  } catch (e) {
    console.warn("  ⚠ 读不到 " + f + "（" + e.message + "），跳过");
    return fb;
  }
};

/** SQL 字符串转义：单引号翻倍。这是 SQLite 唯一需要处理的。 */
const q = (s) => "'" + String(s === null || s === undefined ? "" : s).replace(/'/g, "''") + "'";
const j = (v) => q(JSON.stringify(v === undefined ? null : v));
const num = (v) => String(Number(v) || 0);

const out = [];
out.push("-- 由 tools/migrate/export_seed.mjs 自动生成，来源：" + DATA);
out.push("-- 可重复执行：先清空再插入。");
out.push("");
out.push("DELETE FROM messages;");
out.push("DELETE FROM likes;");
out.push("DELETE FROM comments;");
out.push("DELETE FROM works;");
out.push("DELETE FROM sessions;");
out.push("");

/* ── 配置（管理员密码哈希，原样搬过来 → 老密码继续可用）────────── */
const cfg = readJSON("config.json", null);
if (cfg && cfg.password) {
  out.push("DELETE FROM config WHERE k = 'password';");
  out.push(
    "INSERT INTO config (k, v) VALUES ('password', " +
    q(JSON.stringify(cfg.password)) + ");"
  );
  out.push("");
}

/* ── 留言 ──────────────────────────────────────────────────── */
const msg = readJSON("messages.json", { items: [] });
let n = 0;
for (const it of msg.items || []) {
  if (!it || !it.id) continue;
  out.push(
    "INSERT INTO messages (id, name, text, ts, time, ip, geo, ua, images, voices, deleted) VALUES (" +
    [
      q(it.id), q(it.name), q(it.text), num(it.ts), q(it.time),
      q(it.ip || ""), j(it.geo || {}), q(it.ua || ""),
      j(it.images || []), j(it.voices || []), it.deleted ? "1" : "0"
    ].join(", ") + ");"
  );
  n++;
}
out.push("-- 留言 " + n + " 条");
out.push("");

/* ── 作品（desc 字段在库里叫 descr，order 叫 ord）───────────── */
const works = readJSON("works.json", { items: [] });
n = 0;
for (const w of works.items || []) {
  if (!w || !w.id) continue;
  out.push(
    "INSERT INTO works (id, title, descr, link, cover, tag, images, video, files, ord, ts, time, updated_at) VALUES (" +
    [
      q(w.id), q(w.title), q(w.desc || ""), q(w.link || ""), q(w.cover || ""),
      q(w.tag || ""), j(w.images || []), q(w.video || ""), j(w.files || []),
      num(w.order), num(w.ts), q(w.time || ""), q(w.updatedAt || "")
    ].join(", ") + ");"
  );
  n++;
}
out.push("-- 作品 " + n + " 个");
out.push("");

/* ── 点赞 / 评论 ───────────────────────────────────────────────
   旧结构是 work_interactions.json：items[workId] = { likes: [], comments: [] }
   D1 里拆成两张表。 */
const inter = readJSON("work_interactions.json", { items: {} });
let nLike = 0;
let nCmt = 0;
const items = inter.items || {};
for (const workId of Object.keys(items)) {
  const rec = items[workId] || {};
  for (const l of rec.likes || []) {
    if (!l || !l.ip) continue;
    out.push(
      "INSERT OR IGNORE INTO likes (work_id, ip, geo, ua, ts, time) VALUES (" +
      [q(workId), q(l.ip), j(l.geo || {}), q(l.ua || ""), num(l.ts), q(l.time || "")].join(", ") +
      ");"
    );
    nLike++;
  }
  for (const c of rec.comments || []) {
    if (!c || !c.id) continue;
    out.push(
      "INSERT OR IGNORE INTO comments (id, work_id, name, text, ip, geo, ua, ts, time) VALUES (" +
      [
        q(c.id), q(c.workId || workId), q(c.name || ""), q(c.text || ""),
        q(c.ip || ""), j(c.geo || {}), q(c.ua || ""), num(c.ts), q(c.time || "")
      ].join(", ") + ");"
    );
    nCmt++;
  }
}
out.push("-- 点赞 " + nLike + " 条 / 评论 " + nCmt + " 条");
out.push("");

fs.writeFileSync(OUT, out.join("\n"), "utf8");

console.log("✓ 已生成 " + OUT);
console.log("  留言 " + (msg.items || []).length +
  " / 作品 " + (works.items || []).length +
  " / 点赞 " + nLike + " / 评论 " + nCmt);
console.log("");
console.log("灌进 D1：");
console.log("  npx wrangler d1 execute zfsn-db --remote --file=./tools/migrate/seed.sql");
