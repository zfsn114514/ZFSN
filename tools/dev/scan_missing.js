// 对比 works.json 引用的图 vs 磁盘实际存在的图
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "assets", "works");
const DATA = path.join(ROOT, "..", "ZFSN-server", "data", "works.json");

const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
const items = (data.items || data) || [];

const onDisk = new Set(fs.readdirSync(ASSETS));
console.log("磁盘图片:", onDisk.size, "张");

const referenced = new Set();
items.forEach(w => {
  ["cover", "images"].forEach(k => {
    const v = w[k];
    const arr = Array.isArray(v) ? v : (v ? [v] : []);
    arr.forEach(p => {
      if (!p) return;
      const s = String(p).replace(/\\/g, "/");
      const base = s.split("/").pop();
      if (base) referenced.add(base);
    });
  });
});
console.log("works.json 引用:", referenced.size, "张");

console.log("\n=== 引用了但磁盘上没有（公网 / LAN 都会显示空） ===");
[...referenced].filter(n => !onDisk.has(n)).forEach(n => console.log(" ", n));

console.log("\n=== 磁盘上有但没引用（孤儿文件，不影响功能） ===");
[...onDisk].filter(n => !referenced.has(n)).forEach(n => console.log(" ", n));
