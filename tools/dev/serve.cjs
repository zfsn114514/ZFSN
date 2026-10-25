// 测试用静态服务：HTTP/1.1 + keep-alive + Range，贴近线上 Cloudflare 的行为。
// python -m http.server 是 HTTP/1.0、每条响应都 Connection: close，
// 连续请求音效时浏览器会踩到连接复用/关闭竞态，出现「首个成功、后续 204 空体」的假象。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(process.argv[3] || 'D:/ZFSNwebsite');
const PORT = Number(process.argv[2] || 8900);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(ROOT, rel);
  if (!path.resolve(file).startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  } catch { res.writeHead(404); return res.end('not found'); }

  let st;
  try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const size = st.size;

  // Range 支持（媒体加载器会用）
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m) {
      let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? size - 1 : Number(m[2]);
      if (start < 0) start = 0;
      if (end >= size) end = size - 1;
      if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      res.writeHead(206, {
        'Content-Type': type, 'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': size,
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
});

server.keepAliveTimeout = 30000;
server.listen(PORT, '127.0.0.1', () => console.log(`serve ${ROOT} → ${PORT}`));
