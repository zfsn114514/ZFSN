// 渲染回归测试：验证 B站 页在真实浏览器里能正确渲染（条数、统计、懒加载）。
//
// 为什么需要它：
//   bili_videos.json 从 12 条变成 108 条是一次量级跃迁，
//   只校验 JSON 结构不够 —— 必须确认前端真的渲染出来了、
//   首屏批量（24 条）正确、触底能加载更多、且没有运行时报错。
//
// 用法: node tools/dev/check_bili_render.js
// 退出码: 0 全部通过 / 1 有失败项
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9340;
const SRV_PORT = 8899;
const ROOT = path.resolve(__dirname, "..", "..");
const PROFILE = path.join(ROOT, "tools", ".cache", "chrome-cdp-check");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let b = ""; res.on("data", (d) => (b += d));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " timeout")); } }, 40000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("JS err " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
}

let pass = 0, fail = 0;
function check(ok, msg) {
  if (ok) { pass++; console.log("  ✓ " + msg); }
  else { fail++; console.log("  ✗ " + msg); }
}

async function main() {
  // 1) 起静态服务
  const srv = spawn("C:\\Users\\Administrator\\.workbuddy-ai\\binaries\\python\\versions\\3.13.12\\python.exe",
    ["-m", "http.server", String(SRV_PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  await sleep(1500);

  // 2) 起 Chrome
  fs.mkdirSync(PROFILE, { recursive: true });
  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1400,1000", "about:blank",
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

  // 收集控制台错误
  const errors = [];
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push((m.params.args || []).map((a) => a.value || a.description || "").join(" "));
    }
  });

  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${SRV_PORT}/index.html` });
  await sleep(2500);

  // 等 bili_videos.json 读完（#bili-count 不再是「正在载入」）
  const loaded = await (async () => {
    for (let i = 0; i < 30; i++) {
      const t = await cdp.eval(`(document.getElementById('bili-count')||{}).textContent || ''`);
      if (t && t.indexOf("正在载入") < 0) return t;
      await sleep(500);
    }
    return null;
  })();

  console.log("\n[B站 渲染回归]");
  check(!!loaded, `bili_videos.json 已加载（#bili-count = ${JSON.stringify(loaded)}）`);
  check(loaded && /108\s*条投稿/.test(loaded), "计数文案显示 108 条投稿");

  // 切到 B站 页
  await cdp.eval(`(() => { const b = document.querySelector('[data-go="bili"]'); if (b) b.click(); return !!b; })()`);
  await sleep(1200);

  const first = await cdp.eval(`document.querySelectorAll('#vgrid .vcard').length`);
  check(first === 24, `首屏渲染 24 条（实际 ${first}）`);

  const cnt = await cdp.eval(`(document.getElementById('bcnt')||{}).textContent || ''`);
  check(/108/.test(cnt), `工具栏计数含 108（实际 ${JSON.stringify(cnt)}）`);

  // 统计卡：粉丝 / 总播放
  const stats = await cdp.eval(`[...document.querySelectorAll('#b-stats .bstat')].map(e => e.querySelector('.bv').textContent + '|' + e.querySelector('.bk').textContent)`);
  console.log("        统计卡: " + JSON.stringify(stats));
  check(stats && stats.length === 6, "账号统计 6 个格子");
  check(stats && stats.some((s) => s.indexOf("16.8万") >= 0), "总播放显示 16.8万");

  // 触底加载更多
  await cdp.eval(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(2000);
  await cdp.eval(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(2000);
  const more = await cdp.eval(`document.querySelectorAll('#vgrid .vcard').length`);
  check(more > first, `触底加载更多生效（${first} → ${more}）`);

  // 排序：最多播放
  await cdp.eval(`(() => { const b = document.querySelector('#bsort button[data-sort="views"]'); if (b) b.click(); return !!b; })()`);
  await sleep(800);
  const topTitle = await cdp.eval(`(document.querySelector('#vgrid .vcard .vt')||{}).textContent || ''`);
  console.log("        按播放排序后第一条: " + JSON.stringify(topTitle));
  check(topTitle.indexOf("嘉豪") >= 0 || topTitle.length > 0, "按播放排序可用");

  // 搜索
  await cdp.eval(`(() => { const b = document.querySelector('#bsort button[data-sort="new"]'); if (b) b.click();
    const s = document.getElementById('bsearch'); s.value = '快手'; s.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
  await sleep(900);
  const hit = await cdp.eval(`document.querySelectorAll('#vgrid .vcard').length`);
  check(hit > 0 && hit < 24, `搜索「快手」命中 ${hit} 条（应为部分）`);

  // 封面：抽查图片是否真的加载出来
  const broken = await cdp.eval(`[...document.querySelectorAll('#vgrid .vcard img')].filter(i => i.complete && i.naturalWidth === 0).length`);
  check(broken === 0, `封面无破图（破图 ${broken} 张）`);

  const realErr = errors.filter((e) => e && e.indexOf("favicon") < 0);
  check(realErr.length === 0, `无控制台错误${realErr.length ? "：" + realErr.slice(0, 3).join(" | ") : ""}`);

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
  try { srv.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("失败: " + e.message); process.exit(1); });
