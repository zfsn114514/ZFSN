/* ══════════════════════════════════════════════════════════════
 *  本地浏览器自动化小工具（仅开发测试用，不随站点部署）
 *
 *  通过 Chrome DevTools Protocol 驱动无头浏览器，用于验证：
 *   · 管理后台「ZF语音」标签页的数据加载；
 *   · 多标签页语音房间、屏幕共享等需要真实浏览器环境的场景。
 *
 *  用法：
 *    import { launch, page } from "./cdp.mjs";
 *    const browser = await launch({ port: 9222, url: "about:blank" });
 *    const tab = await page(browser, "http://127.0.0.1:8790/voice/");
 *    await tab.evaluate("document.title");
 *    await tab.close(); await browser.close();
 * ══════════════════════════════════════════════════════════════ */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
];

function chromePath() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("未找到 Chrome / Edge，可设置 CHROME_PATH 环境变量");
}

async function httpJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("CDP HTTP " + r.status + " " + url);
  return r.json();
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function launch(opts = {}) {
  const port = opts.port || 9222;
  const dir = opts.userDataDir || path.join(os.tmpdir(), "zf-cdp-" + Date.now());
  const exe = process.env.CHROME_PATH || chromePath();
  const args = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--no-proxy-server", "--remote-debugging-port=" + port,
    "--user-data-dir=" + dir, "--window-size=1440,900",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
    "--allow-insecure-localhost", "--mute-audio",
    opts.url || "about:blank"
  ];
  if (opts.extraArgs) args.push(...opts.extraArgs);
  const proc = spawn(exe, args, { stdio: "ignore", windowsHide: true });
  let info = null;
  for (let i = 0; i < 60; i++) {
    try { info = await httpJSON(`http://127.0.0.1:${port}/json/version`); break; }
    catch (_) { await wait(250); }
  }
  if (!info) { proc.kill(); throw new Error("Chrome CDP 未能在 15 秒内启动"); }

  const bws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { bws.once("open", res); bws.once("error", rej); });

  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  bws.on("message", (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(JSON.stringify(m.error)));
      else resolve(m.result);
    } else if (!m.id && m.method) {
      listeners.forEach(function (fn) { try { fn(m); } catch (_) {} });
    }
  });
  function send(method, params = {}, sessionId) {
    const id = ++seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    bws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error("CDP 超时: " + method)); }
      }, 20000);
    });
  }

  return {
    proc, dir, port, send,
    /** 订阅 CDP 事件；返回取消订阅函数。页面可用它收集 JS 异常 / console.error。 */
    onEvent(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
    async targets() { return httpJSON(`http://127.0.0.1:${port}/json/list`); },
    async close() {
      try { await send("Browser.close"); } catch (_) {}
      try { bws.close(); } catch (_) {}
      try { proc.kill(); } catch (_) {}
    }
  };
}

/** 新建一个标签页并返回一个可执行 JS 的会话。 */
export async function page(browser, url, opts = {}) {
  const t = await browser.send("Target.createTarget", { url: "about:blank" });
  const session = await browser.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
  const sid = session.sessionId;
  const call = (method, params = {}) => browser.send(method, params, sid);

  await call("Page.enable");
  await call("Runtime.enable");
  await call("Log.enable");
  const errors = [];
  const off = browser.onEvent(function (m) {
    if (m.sessionId && m.sessionId !== sid) return;
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params && m.params.exceptionDetails || {};
      errors.push((d.text || "JS 异常") + " " +
        ((d.exception && d.exception.description) || ""));
    }
    if (m.method === "Log.entryAdded") {
      const e = m.params && m.params.entry || {};
      if (e.level === "error") errors.push("console.error: " + (e.text || ""));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params && m.params.type === "error") {
      errors.push("console.error: " + (m.params.args || []).map(function (a) {
        return a.value || a.description || "";
      }).join(" "));
    }
  });
  await call("Page.navigate", { url });
  await wait(opts.waitMs == null ? 1800 : opts.waitMs);

  async function evaluate(expression, awaitPromise = true) {
    const r = await call("Runtime.evaluate", {
      expression, awaitPromise, returnByValue: true, userGesture: true
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.text + " " +
        (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ""));
    }
    return r.result && r.result.value;
  }
  async function text(selector) {
    return evaluate(`(document.querySelector(${JSON.stringify(selector)})||{}).innerText || ""`);
  }
  async function html(selector) {
    return evaluate(`(document.querySelector(${JSON.stringify(selector)})||{}).innerHTML || ""`);
  }
  async function click(selector) {
    return evaluate(`(function(){var e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;e.click();return true})()`);
  }
  async function screenshot(file) {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    return file;
  }
  async function setCookie(name, value, urlForCookie) {
    return call("Network.setCookie", {
      name, value, url: urlForCookie, httpOnly: false, sameSite: "Lax"
    });
  }
  return {
    targetId: t.targetId, sessionId: sid, call, evaluate, text, html, click,
    screenshot, setCookie, errors,
    async close() { off(); try { await browser.send("Target.closeTarget", { targetId: t.targetId }); } catch (_) {} }
  };
}
