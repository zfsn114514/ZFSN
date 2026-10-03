/**
 * 轻量校验线上 PvZ 分片是否与本地一致
 * ─────────────────────────────────────────────────────────────
 * 用途：在不下载全量 46MB 的前提下，确认线上分片是本次上传的版本。
 *
 * 两条已踩过的坑（别再走）：
 *   ① Cloudflare 的 ETag **不是内容 MD5**。实测本地 part.00 的 md5 是
 *      5cb19f32…，线上 ETag 是 73b6c575… —— 不能用 ETag 比对内容。
 *   ② 这条链路上 **Range 请求不生效**：带 `Range: bytes=0-1023` 仍返回
 *      整份文件（HTTP 200 而非 206，无 Content-Range 头）。
 *      所以「只取前 64 KiB 抽样」在这里做不到。
 *
 * 因此本脚本的实际策略是：只拉**最后一片**（4.1MB，其余 5 片各 8MB），
 * 拉满后比 sha256。最后一片的长度在换版本时必然变化，是最强的判别点：
 *     旧版 part.05 = 3,934,586   新版 part.05 = 4,313,916
 * 只比前几片的头部无法区分新旧（头部内容一致）。
 *
 * 用法: node tools/dev/verify_parts_online.cjs [baseUrl]
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");

const BASE = process.argv[2] || "https://www.zfsnnb.dpdns.org/pvz/mainpak";
const LOCAL = path.join(__dirname, "..", "..", "pvz", "mainpak");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 600000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
  });
}

(async function main() {
  const parts = fs
    .readdirSync(LOCAL)
    .filter((f) => /^part\./.test(f))
    .sort();

  // 最后一片最小，只拉它；其余片靠部署日志 + 大小清单佐证
  const target = parts[parts.length - 1];
  const local = fs.readFileSync(path.join(LOCAL, target));
  console.log(`分片总数: ${parts.length}，本轮只拉最后一片 ${target}`);
  console.log(`本地大小: ${local.length} 字节`);
  console.log("下载中（约 4MB，链路较慢）…");

  const t0 = Date.now();
  const { body } = await get(`${BASE}/${target}`);
  const remote = sha256(body);
  const localHash = sha256(local);

  console.log(`线上大小: ${body.length} 字节  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`本地 sha256: ${localHash}`);
  console.log(`线上 sha256: ${remote}`);
  console.log("");

  const sizeOK = body.length === local.length;
  const hashOK = remote === localHash;
  if (hashOK) {
    console.log(`通过：线上 ${target} 与本地完全一致，且长度 ${body.length} 证明是新版 pak。`);
    process.exit(0);
  }
  if (!sizeOK) {
    console.log(`★长度不符：线上 ${body.length} vs 本地 ${local.length} —— 线上还是旧版。`);
  }
  console.log("★内容不一致，需要重新部署。");
  process.exit(1);
})();
