// 截图：本地打开 index.html 并切到 B站 页，存一张 PNG（用于确认渲染效果）。
// 用法: node tools/dev/shot_bili.js
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9341;
const SRV_PORT = 8901;
const ROOT = path.resolve(__dirname, "..", "..");
const PROFILE = path.join(ROOT, "tools", ".cache", "chrome-cdp-shot");
const OUTDIR = path.join(__dirname, "_shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject); req.setTimeout(5000, () => req.destroy(new Error("timeout")));
  });
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " timeout")); } }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result && r.result.value;
  }
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  const srv = spawn("C:\\Users\\Administrator\\.workbuddy-ai\\binaries\\python\\versions\\3.13.12\\python.exe",
    ["-m", "http.server", String(SRV_PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  await sleep(1500);
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1500,1750", "about:blank",
  ], { stdio: "ignore" });

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`); if (targets && targets.length) break; } catch (e) {}
    await sleep(500);
  }
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws fail")); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride",
    { width: 1500, height: 1750, deviceScaleFactor: 1, mobile: false });

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${SRV_PORT}/index.html` });
  await sleep(3000);
  await cdp.eval(`(() => { const b = document.querySelector('[data-go="bili"]'); if (b) b.click(); return true; })()`);
  await sleep(2500);
  // 注意：卡片里的 img 带 loading="lazy"，视口外的图**永远不会触发 load**，
  // 所以不能 Promise.all 等全部图片（会挂住）。只等一小会儿 + 只截视口。
  await sleep(2500);
  await cdp.eval(`window.scrollTo(0, 0)`);
  await sleep(500);

  const n = await cdp.eval(`document.querySelectorAll('#vgrid .vcard').length`);
  console.log("卡片数:", n);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(OUTDIR, "bili_108.png");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("已保存 " + out + " (" + Math.round(fs.statSync(out).size / 1024) + " KB)");

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { srv.kill(); } catch (e) {}
}

main().catch((e) => { console.error("失败: " + e.message); process.exit(1); });
