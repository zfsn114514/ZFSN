/**
 * 生成 Google 搜索结果所需的站点图标。
 *
 * 背景：Google 抓 favicon 时按固定路径依次尝试：
 *   /favicon.ico → /favicon.png → <head> 里 <link rel="icon"> 的 href
 * 之前只有 assets/favicon.svg（在 <head> 里声明），根目录没有
 * /favicon.ico，实测这两个都是 404 —— 于是搜索结果只能用
 * 抓取时的默认地球图标。
 *
 * 注意：Google 抓图标**不认 SVG**（只认位图：ico/png/jpg/webp），
 * 所以 SVG 只能给浏览器标签页用，搜索结果必须另备位图。
 *
 * 产物（都放仓库根目录，因为 Google 只在根路径找）：
 *   favicon.ico     16/32/48 三合一，传统浏览器 + Google
 *   favicon-32.png  32px，Google 搜索结果的主尺寸
 *   favicon-16.png  16px
 *   apple-touch-icon.png  180px，iOS 主屏
 *   site.webp       512px，Google 新版偏好（部分场景）
 *
 * 用法：node tools/gen_favicons.cjs
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SVG = path.join(ROOT, "assets", "favicon.svg");

// 源 SVG 太小（64px），放大到 1024 再缩 —— 直接从 64 放大会糊
const MASTER = 1024;

async function main() {
  if (!fs.existsSync(SVG)) {
    console.error("✗ 找不到 " + SVG);
    process.exit(1);
  }

  // ① 把 SVG 放大成 PNG master
  const master = await sharp(SVG, { density: 384 })
    .resize(MASTER, MASTER, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(ROOT, "_favicon_master.png"), master);
  console.log("  master 1024px 已生成");

  // ② 各尺寸 PNG
  const pngs = {};
  for (const size of [16, 32, 48, 180, 512]) {
    const buf = await sharp(master).resize(size, size, { fit: "contain" }).png({ compressionLevel: 9 }).toBuffer();
    pngs[size] = buf;
  }
  fs.writeFileSync(path.join(ROOT, "favicon-16.png"), pngs[16]);
  fs.writeFileSync(path.join(ROOT, "favicon-32.png"), pngs[32]);
  fs.writeFileSync(path.join(ROOT, "apple-touch-icon.png"), pngs[180]);
  console.log("  favicon-16/32、apple-touch-icon 已生成");

  // ③ 512 转 WebP
  const webp = await sharp(master).resize(512, 512, { fit: "contain" }).webp({ quality: 90 }).toBuffer();
  fs.writeFileSync(path.join(ROOT, "site.webp"), webp);
  console.log("  site.webp 已生成");

  /* ④ 手写 ICO 容器。
   *
   * ICO 格式很简单：6 字节头 + 每张图 16 字节目录项 + 各图的原始数据。
   * 现代 ICO 允许**直接内嵌 PNG**（Vista 起支持），所以不必做 BMP 编码 ——
   * 那需要手工处理行 padding、AND 掩码、像素倒序，容易出错。
   *
   * 目录项（16 字节，按小端）：
   *   0  width      0 表示 256
   *   1  height     同上
   *   2  颜色数     0 = 不限
   *   3  保留       0
   *   4  planes     1（32 位色用 1，16 位色用 0）
   *   6  bitCount   32
   *   8  字节数     该图数据长度
   *  12  偏移       从 ICO 文件开头算起
   */
  const sizes = [16, 32, 48];
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);      // reserved
  head.writeUInt16LE(1, 2);      // type = 1 (icon)
  head.writeUInt16LE(sizes.length, 4);

  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + 16 * sizes.length;
  sizes.forEach((s, i) => {
    const b = i * 16;
    dir.writeUInt8(s === 256 ? 0 : s, b);      // width
    dir.writeUInt8(s === 256 ? 0 : s, b + 1);  // height
    dir.writeUInt8(0, b + 2);                   // 颜色数
    dir.writeUInt8(0, b + 3);                   // reserved
    dir.writeUInt16LE(1, b + 4);                // planes
    dir.writeUInt16LE(32, b + 6);               // bitCount
    dir.writeUInt32LE(pngs[s].length, b + 8);   // 数据长度
    dir.writeUInt32LE(offset, b + 12);          // 偏移
    offset += pngs[s].length;
  });

  const ico = Buffer.concat([head, dir, ...sizes.map(s => pngs[s])]);
  fs.writeFileSync(path.join(ROOT, "favicon.ico"), ico);
  console.log("  favicon.ico 已生成（" + ico.length + " 字节，内含 16/32/48）");

  // ⑤ 清理 master
  fs.unlinkSync(path.join(ROOT, "_favicon_master.png"));

  // ⑥ 报告体积
  console.log("\n  产物：");
  for (const f of ["favicon.ico", "favicon-16.png", "favicon-32.png", "apple-touch-icon.png", "site.webp"]) {
    console.log("    " + f.padEnd(24) + fs.statSync(path.join(ROOT, f)).size + " B");
  }
}

main().catch(e => { console.error("异常：", e.message); process.exit(1); });
