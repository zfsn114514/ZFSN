// 抓取 B站 空间页**全部投稿**（108 条），走「真实 Chrome + CDP + fetch 钩子」。
//
// ══════════════════════════════════════════════════════════════════
// 为什么是这个方案（每一步都是踩坑换来的，改动前请先读完）
//
// 1) 为什么不用 urllib 直接调 API
//    /x/space/wbi/arc/search 对本机 IP（河南联通 125.41.1.64）是 **412 纯 IP 级封禁**。
//    实测无效的手段：换 UA（Chrome/Edge/手机三种全 412）、补 dm_img_* 风控参数（-352）、
//    刷新 buvid cookie、换旧版 /x/space/arc/search（-799 → 412）、APP 端 cursor（-400）。
//    ★ 结论：这不是签名问题，是 IP 信誉问题，Python 侧无解。
//
// 2) 为什么用 Chrome 渲染
//    真实浏览器（TLS 指纹 + 完整 cookie + JS 环境）能过风控。
//    ★ 而且**登录不是必要条件**：用全新临时 profile 重试也能成功（验证过）。
//      所以可以用独立 profile 起 Chrome，不干扰用户正在用的浏览器。
//
// 3) 为什么必须重试
//    风控是**概率性放行**：同一条命令连续跑，会随机出现
//    「渲染出 40 张卡片」和「列表为空（空间主人还没投过视频…）」两种结果。
//    实测第 1 页经常要试 2~4 次才出来。
//
// 4) 为什么必须点击翻页，不能用 URL 参数
//    `?pn=2` / `?page=2` 一律无效：/video 会 302 到 /upload/video 且**重置回第 1 页**。
//    必须点 DOM 里的分页按钮。
//
// 5) 为什么钩 fetch 而不是解析 DOM
//    钩子拿到的是**接口原始 JSON**，字段干净且完整（created 精确时间戳、pic、play、
//    video_review、comment、description…），比从 HTML 正则抠数字可靠得多。
//
// 6) 成功判据为什么是「出现没见过的 BV」
//    不要用「首个 BV 变了」——页面可能把新卡片追加在后面，首个 BV 不变会导致
//    明明成功却判失败（踩过，白跑了 8 轮重试）。
// ══════════════════════════════════════════════════════════════════
//
// 用法: node tools/fetch_bili_list_cdp.js
// 产出:
//   tools/.cache/bili_raw_pages.json  各页原始响应（留档，便于排查）
//   tools/.cache/bili_list.json       { total, pages, videos:[{bvid,aid,title,cover,pub,ts,length,duration,views,danmaku,reply,desc}] }

const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");

const MID = 1220210222;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9336;
const HERE = __dirname;
const CACHE = path.join(HERE, ".cache");
const PROFILE = path.join(CACHE, "chrome-cdp");
const PAGE_URL = `https://space.bilibili.com/${MID}/video`;
const OUT_LIST = path.join(CACHE, "bili_list.json");
const OUT_RAW = path.join(CACHE, "bili_raw_pages.json");

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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + " 超时")); }
      }, 60000);
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("JS 异常 " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }
}

// 在页面任何 JS 之前注入：把 arc/search 的原始响应存到 window.__CAP__
const HOOK = `(() => {
  if (window.__CAP__) return;
  window.__CAP__ = [];
  function isTarget(u){ return u && String(u).indexOf('/x/space/wbi/arc/search') >= 0; }
  const of = window.fetch;
  window.fetch = function(...args) {
    const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
    const p = of.apply(this, args);
    if (isTarget(u)) {
      p.then(r => r.clone().text().then(t => window.__CAP__.push({ url: u, status: r.status, body: t })).catch(()=>{})).catch(()=>{});
    }
    return p;
  };
  const oo = XMLHttpRequest.prototype.open;
  const os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u) { this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function() {
    if (isTarget(this.__u)) {
      this.addEventListener('load', () => { try { window.__CAP__.push({ url: this.__u, status: this.status, body: String(this.responseText) }); } catch (e) {} });
    }
    return os.apply(this, arguments);
  };
})()`;

const CARDS = `(() => {
  const out = [];
  document.querySelectorAll('.upload-video-card').forEach(card => {
    const a = card.querySelector('a[href*="/video/BV"]');
    if (!a) return;
    const m = (a.getAttribute('href') || '').match(/BV[0-9A-Za-z]{10}/);
    if (m) out.push(m[0]);
  });
  const active = document.querySelector('.vui_pagenation--btn-num.vui_button--active');
  const cnt = document.querySelector('.vui_pagenation-go__count');
  return {
    bvs: out,
    active: active ? active.textContent.trim() : '',
    count: cnt ? cnt.textContent.trim() : '',
  };
})()`;

const CLICK = (pn) => `(() => {
  const btns = [...document.querySelectorAll('.vui_pagenation--btn-num')];
  const b = btns.find(x => x.textContent.trim() === '${pn}');
  if (b) { b.scrollIntoView({block:'center'}); b.click(); return true; }
  const nx = document.querySelector('[aria-label="下一页"]');
  if (nx) { nx.scrollIntoView({block:'center'}); nx.click(); return true; }
  return false;
})()`;

function hmsToSec(t) {
  const parts = String(t || "").split(":").map((x) => parseInt(x, 10) || 0);
  return parts.reduce((a, b) => a * 60 + b, 0);
}

async function waitFor(fn, timeout, step = 800) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { const v = await fn(); if (v) return v; } catch (e) { /* ignore */ }
    await sleep(step);
  }
  return null;
}

async function main() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(PROFILE, { recursive: true });

  const chrome = spawn(CHROME, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-networking",
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`,
    "--window-size=1400,3000", "about:blank",
  ], { stdio: "ignore" });
  console.log(`[启动] Chrome headless（独立 profile，调试端口 ${PORT}）`);

  let targets = null;
  for (let i = 0; i < 40; i++) {
    try { targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`); if (targets && targets.length) break; } catch (e) {}
    await sleep(500);
  }
  if (!targets || !targets.length) throw new Error("Chrome 调试端口未就绪");
  const page = targets.find((t) => t.type === "page") || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WebSocket 连接失败")); });
  const cdp = new CDP(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });

  let best = { pages: {}, total: null };
  const bestCount = () => Object.values(best.pages).reduce((a, p) => a + p.vlist.length, 0);

  for (let round = 1; round <= 6; round++) {
    console.log(`\n──────── 第 ${round} 轮 ────────`);

    // 页 1
    let p1 = null;
    for (let a = 1; a <= 6 && !p1; a++) {
      await cdp.send("Page.navigate", { url: PAGE_URL });
      await sleep(2500);
      const got = await waitFor(async () => {
        const c = await cdp.eval(CARDS);
        const caps = await cdp.eval("(window.__CAP__ || []).filter(c => c.body && c.body.indexOf('\"vlist\"') >= 0)");
        return (c && c.bvs.length && caps && caps.length) ? { c, caps } : null;
      }, 22000);
      if (got) {
        const parsed = got.caps.map((x) => { try { return JSON.parse(x.body); } catch (e) { return null; } })
          .filter((d) => d && d.code === 0 && d.data && d.data.list);
        if (parsed.length) {
          p1 = parsed[0];
          console.log(`[页 1] ✓ ${p1.data.list.vlist.length} 条（第 ${a} 次加载成功）`);
        }
      }
      if (!p1) console.log(`[页 1] ✗ 第 ${a} 次加载未拿到数据，重试…`);
      await sleep(1500);
    }
    if (!p1) { console.log("页 1 始终失败，进入下一轮"); continue; }

    const total = p1.data.page && p1.data.page.count;
    const pages = Math.ceil((total || 0) / (p1.data.page && p1.data.page.size || 40)) || 1;
    console.log(`[信息] 共 ${pages} 页 / ${total} 条`);

    const cur = { pages: { 1: { vlist: p1.data.list.vlist } }, total };
    const seen = new Set(cur.pages[1].vlist.map((v) => v.bvid));

    for (let pn = 2; pn <= pages; pn++) {
      let got = null;
      for (let a = 1; a <= 6 && !got; a++) {
        const before = await cdp.eval("(window.__CAP__ || []).length");
        const clicked = await cdp.eval(CLICK(pn));
        if (!clicked) { console.log(`[页 ${pn}] 找不到翻页按钮`); await sleep(3000); continue; }
        got = await waitFor(async () => {
          const caps = await cdp.eval("(window.__CAP__ || [])");
          if (!caps || caps.length <= before) return null;
          const fresh = caps.slice(before)
            .map((x) => { try { return JSON.parse(x.body); } catch (e) { return null; } })
            .filter((d) => d && d.code === 0 && d.data && d.data.list);
          return fresh.length ? fresh[fresh.length - 1] : null;
        }, 25000, 700);
        if (got) {
          const vl = got.data.list.vlist;
          const n = vl.filter((v) => !seen.has(v.bvid)).length;
          vl.forEach((v) => seen.add(v.bvid));
          cur.pages[pn] = { vlist: vl };
          console.log(`[页 ${pn}] ✓ ${vl.length} 条，新增 ${n}（累计 ${seen.size}）`);
        } else {
          console.log(`[页 ${pn}] ✗ 第 ${a} 次点击无新数据，重试…`);
          await sleep(4000);
        }
      }
      if (!got) console.log(`[页 ${pn}] ⚠ 本轮放弃`);
      await sleep(1200);
    }

    const cnt = Object.values(cur.pages).reduce((a, p) => a + p.vlist.length, 0);
    console.log(`本轮共 ${cnt} 条（历史最好 ${bestCount()} 条）`);
    if (cnt > bestCount()) {
      best = cur;
      fs.writeFileSync(OUT_RAW, JSON.stringify(cur, null, 2), "utf8");
      console.log("→ 已刷新最好结果");
    }
    if (total && bestCount() >= total) { console.log("已抓满，提前结束"); break; }
    await sleep(2000);
  }

  // ── 汇总去重 ──
  const byId = new Map();
  for (const pn of Object.keys(best.pages)) {
    for (const v of best.pages[pn].vlist) if (!byId.has(v.bvid)) byId.set(v.bvid, v);
  }
  const videos = [...byId.values()]
    .map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: v.title,
      cover: (v.pic || "").replace("http://", "https://"),
      pub: v.created ? new Date(v.created * 1000).toLocaleDateString("sv-SE") : "",
      ts: v.created || 0,
      length: v.length || "",
      duration: hmsToSec(v.length),
      views: v.play || 0,
      danmaku: v.video_review || 0,
      reply: v.comment || 0,
      desc: (v.description || "").slice(0, 200),
      // ★ typeid 一定要留着：view 接口对本账号返回的 tname 是**空串**，
      //   分区名只能靠本地 tid→名称表映射出来（见 build_bili_full.py 的 TID_NAME）。
      typeid: v.typeid || 0,
      tname: "",
      pages: v.videos || 1,
    }))
    .sort((a, b) => b.ts - a.ts);

  const out = {
    mid: MID,
    total: best.total,
    pages: Object.keys(best.pages).length,
    fetched: new Date().toISOString().slice(0, 19).replace("T", " "),
    source: `chrome-cdp: space.bilibili.com/${MID}/video`,
    videos,
  };
  fs.writeFileSync(OUT_LIST, JSON.stringify(out, null, 2), "utf8");

  console.log("\n" + "=".repeat(60));
  console.log(`共抓取 ${videos.length} 条（页面声称 ${best.total} 条）`);
  videos.slice(0, 4).forEach((v) => console.log(`  ${v.pub} ${v.bvid} | ${v.views} 播放 | ${v.title.slice(0, 30)}`));
  console.log("  …");
  videos.slice(-3).forEach((v) => console.log(`  ${v.pub} ${v.bvid} | ${v.views} 播放 | ${v.title.slice(0, 30)}`));
  console.log("已写入 " + OUT_LIST);
  console.log("=".repeat(60));

  try { ws.close(); } catch (e) {}
  try { chrome.kill(); } catch (e) {}
}

main().catch((e) => { console.error("失败: " + e.message); process.exit(1); });
