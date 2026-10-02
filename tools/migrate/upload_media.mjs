/**
 * 把旧后端 data/media 下的附件搬到 Cloudflare KV。
 *
 *   node tools/migrate/upload_media.mjs           真传
 *   node tools/migrate/upload_media.mjs --dry-run  只看要传什么
 *
 * 路径映射（必须和 src/index.js 里的 key 规则一致，否则线上取不到）：
 *   data/media/messages/<id>/<file>     →  msg/<id>/<file>
 *   data/media/works/video/<name>       →  media/works/video/<name>
 *   data/media/works/file/<name>        →  media/works/file/<name>
 *
 * ⚠ assets/works/*.png 不用传 —— 那是仓库里的静态图片，
 *   Workers 的静态资源本来就提供它们。
 *
 * 存储格式必须和 src/media.js 完全一致（否则线上读不出来）：
 *   <key>          = 清单 JSON {"ct","size","chunk","n"}
 *   <key>!0 … !n-1 = 分片原始字节
 *   CHUNK 两边都写死 8 MiB，改一处就得改另一处。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DATA = process.env.ZFSN_DATA || "D:/ZFSN-server/data";
const BINDING = process.env.ZFSN_KV_BINDING || "MEDIA";
const DRY = process.argv.includes("--dry-run");

const CHUNK = 8 * 1024 * 1024; // 必须与 src/media.js 的 CHUNK 一致

/* wrangler 的可执行入口。直接交给 node 跑，绕开 Windows 上
   npx 是 .cmd、execFileSync 不认的老问题。 */
const WRANGLER = path.resolve("node_modules/wrangler/bin/wrangler.js");

const MEDIA = path.join(DATA, "media");
if (!fs.existsSync(MEDIA)) {
  console.error("找不到 " + MEDIA + "，设 ZFSN_DATA 指向数据目录再跑");
  process.exit(1);
}

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".avif": "image/avif",
  ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".m4v": "video/x-m4v", ".ogv": "video/ogg", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".flac": "audio/flac", ".pdf": "application/pdf",
  ".zip": "application/zip", ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed", ".gz": "application/gzip",
  ".tar": "application/x-tar", ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8"
};
const mimeOf = (name) => {
  const m = /\.[a-z0-9]{1,8}$/i.exec(String(name || ""));
  return (m && MIME[m[0].toLowerCase()]) || "application/octet-stream";
};

const jobs = [];

/* ── 留言附件 ─────────────────────────────────────────────── */
const msgDir = path.join(MEDIA, "messages");
if (fs.existsSync(msgDir)) {
  for (const id of fs.readdirSync(msgDir)) {
    const dir = path.join(msgDir, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      jobs.push({ file: path.join(dir, f), key: "msg/" + id + "/" + f });
    }
  }
}

/* ── 作品视频 / 下载文件 ──────────────────────────────────── */
const worksDir = path.join(MEDIA, "works");
for (const kind of ["video", "file"]) {
  const dir = path.join(worksDir, kind);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    jobs.push({ file: path.join(dir, f), key: "media/works/" + kind + "/" + f });
  }
}

console.log(jobs.length ? "待上传 " + jobs.length + " 个文件：" : "没有找到需要上传的媒体文件。");
let totalWrites = 0;
for (const j of jobs) {
  const size = fs.statSync(j.file).size;
  const n = Math.max(1, Math.ceil(size / CHUNK));
  totalWrites += n + 1; // 分片 + 清单
  console.log(
    "  " + (size / 1048576).toFixed(2) + " MB  " + j.key +
    (n > 1 ? "  （分 " + n + " 片）" : "")
  );
}
console.log("\n合计约 " + totalWrites + " 次 KV 写入（免费版每天 1000 次上限）\n");

if (DRY) {
  console.log("--dry-run：以上只是计划，没有真的上传。");
  process.exit(0);
}

function kvPut(key, file) {
  execFileSync(
    process.execPath,
    [WRANGLER, "kv", "key", "put", key, "--path", file, "--binding", BINDING, "--remote"],
    { stdio: "pipe" }
  );
}

/* 有些环境（受限沙箱、某些杀软）禁止 node 起子进程，
   spawnSync 直接抛 EBUSY。先探一下，不行就走"出计划、让别人执行"的路。 */
function canSpawn() {
  try {
    execFileSync(process.execPath, ["-e", "0"], { stdio: "pipe" });
    return true;
  } catch (_) {
    return false;
  }
}

/* ── 第一步：把每个文件切成片，落到临时目录 ──────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zfsn-kv-"));
const puts = []; // {key, file, n}

jobs.forEach((j, ji) => {
  const buf = fs.readFileSync(j.file);
  const size = buf.length;
  const n = Math.max(1, Math.ceil(size / CHUNK));
  for (let i = 0; i < n; i++) {
    const piece = buf.subarray(i * CHUNK, Math.min(size, (i + 1) * CHUNK));
    const f = path.join(tmp, ji + "-" + i + ".bin");
    fs.writeFileSync(f, piece);
    puts.push({ key: j.key + "!" + i, file: f });
  }
  // 清单放最后写入：清单先落地会读到缺片的坏文件
  const mf = path.join(tmp, ji + "-manifest.json");
  fs.writeFileSync(mf, JSON.stringify({ ct: mimeOf(j.key), size, chunk: CHUNK, n }));
  puts.push({ key: j.key, file: mf });
});

/* ── 第二步：写入 KV ─────────────────────────────────────── */
if (!canSpawn()) {
  const plan = path.resolve("tools/migrate/.kv-plan.tsv");
  fs.writeFileSync(
    plan,
    puts.map((p) => p.key + "\t" + p.file).join("\n") + "\n",
    "utf8"
  );
  console.log("⚠ 当前环境禁止 node 起子进程（spawnSync EBUSY）。");
  console.log("  分片已备好，写入清单：" + plan);
  console.log("");
  console.log("  请在 shell 里执行：");
  console.log(
    "    while IFS=$'\\t' read -r k f; do node node_modules/wrangler/bin/wrangler.js " +
    'kv key put "$k" --path "$f" --binding ' + BINDING + " --remote; done < " +
    plan.replace(/\\/g, "/")
  );
  console.log("");
  console.log("  或者一条条跑（共 " + puts.length + " 条）：");
  for (const p of puts) {
    console.log(
      '    node node_modules/wrangler/bin/wrangler.js kv key put "' + p.key +
      '" --path "' + p.file.replace(/\\/g, "/") + '" --binding ' + BINDING + " --remote"
    );
  }
  process.exit(0);
}

let done = 0;
let failed = 0;
try {
  for (const p of puts) {
    try {
      kvPut(p.key, p.file);
      done++;
      process.stdout.write(".");
    } catch (e) {
      failed++;
      console.error(
        "\n  ✗ " + p.key + "  " + (e.stderr ? e.stderr.toString().slice(0, 300) : e.message)
      );
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("");
console.log("完成：成功 " + done + " / 失败 " + failed + "（共 " + puts.length + " 个键）");
if (failed) {
  console.log("失败的可以单独重跑本脚本，已传成功的会被覆盖，无副作用。");
}
