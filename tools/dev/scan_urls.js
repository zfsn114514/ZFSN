// 扫描 works.json 里所有异常的图片/视频 URL
const fs = require("fs");
const path = require("path");
const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "ZFSN-server", "data", "works.json"), "utf8"));
const items = (data.items || data) || [];
console.log("总作品数:", items.length);

const looks = { absolute: [], http127: [], weird: [], ok: [] };
items.forEach(w => {
  ["cover", "images", "video"].forEach(k => {
    const v = w[k];
    const arr = Array.isArray(v) ? v : (v ? [v] : []);
    arr.forEach(p => {
      if (!p) return;
      const s = String(p);
      if (/^https?:\/\//i.test(s)) looks.absolute.push({ id: w.id, title: w.title, k, url: s });
      else if (/^http:\/\/127\.0\.0\.1:3000/i.test(s)) looks.http127.push({ id: w.id, title: w.title, k, url: s });
      else if (!/^assets\/works\//.test(s) && !/^media\/works\//.test(s)) looks.weird.push({ id: w.id, title: w.title, k, url: s });
      else looks.ok.push({ id: w.id, title: w.title, k, url: s });
    });
  });
});

console.log("\n=== 含绝对 URL (http/https) ===");
looks.absolute.forEach(x => console.log(" ", x.id, x.title, "[" + x.k + "]", x.url));

console.log("\n=== 形如 http://127.0.0.1:3000/... ===");
looks.http127.forEach(x => console.log(" ", x.id, x.title, "[" + x.k + "]", x.url));

console.log("\n=== 路径异常（非 assets/works 也非 media/works） ===");
looks.weird.forEach(x => console.log(" ", x.id, x.title, "[" + x.k + "]", x.url));

console.log("\n=== 正常的（路径式）条数:", looks.ok.length, "===");
