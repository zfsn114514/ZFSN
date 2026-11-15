/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 语音设置弹窗（分类 / 麦克风激活阈值）UI 回归
 *
 *  覆盖 2026-11-15 的改造：
 *   1) 设置从「右侧长抽屉」改成居中窄弹窗，左侧四个分类、右侧只显示一个；
 *   2) 新增「麦克风激活阈值」——滑块、电平条、白线标记、门限状态文字；
 *   3) 说话方式的分段单选与阈值联动（按键说话时阈值禁用）；
 *   4) 设置项写入 localStorage，刷新后被记住。
 *
 *  前置：npm run voice:dev（默认 http://127.0.0.1:8790），本机有 Chrome / Edge。
 *  运行：npm run voice:test:settings
 * ══════════════════════════════════════════════════════════════ */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, page } from "../../tools/dev/cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BASE = process.env.VOICE_UI_BASE || "http://127.0.0.1:8790";
const SHOTS = path.join(ROOT, "tools/dev/_shots");
fs.mkdirSync(SHOTS, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) { console.error("  ✘ " + name + "\n    " + (e && e.stack || e)); fail++; }
}

console.log("\nZF语音 设置弹窗回归（" + BASE + "）\n");
const browser = await launch({ port: 9400 + Math.floor(Math.random() * 200) });
try {
  /* preview=1：不登后端，直接进预览大厅，只测 UI 行为 */
  const p = await page(browser, BASE + "/voice/?preview=1", { waitMs: 2200 });

  await step("点设置按钮打开居中弹窗，四个分类只有一个是可见的", async function () {
    assert.ok(await p.click("#btn-settings"), "找不到设置按钮");
    await wait(300);
    const r = await p.evaluate(`(function(){
      var d = document.getElementById("dlg-settings");
      var box = d.getBoundingClientRect();
      return {
        open: !!d.open,
        centered: Math.abs((box.left + box.width / 2) - window.innerWidth / 2) < 40,
        w: Math.round(box.width), h: Math.round(box.height),
        tabs: [].map.call(document.querySelectorAll(".set-tab"), function(b){ return b.textContent.trim(); }),
        visiblePanes: [].filter.call(document.querySelectorAll(".set-pane"), function(s){ return !s.hidden; })
          .map(function(s){ return s.getAttribute("data-pane"); })
      };
    })()`);
    assert.equal(r.open, true, "弹窗没打开");
    assert.equal(r.centered, true, "弹窗不在屏幕中间");
    assert.ok(r.w >= 380 && r.w <= 720, "宽度不是「小弹窗」：" + r.w);
    assert.equal(r.tabs.length, 4, "分类数量不对：" + r.tabs.join("/"));
    assert.deepEqual(r.visiblePanes, ["devices"], "默认应只显示设备页");
  });

  await step("切换分类：右侧只换内容，弹窗不关、尺寸不跳", async function () {
    const before = await p.evaluate(`Math.round(document.getElementById("dlg-settings").getBoundingClientRect().width)`);
    for (const name of ["mic", "talk", "profile", "devices"]) {
      await p.evaluate(`document.querySelector('.set-tab[data-pane="${name}"]').click()`);
      await wait(120);
      const r = await p.evaluate(`(function(){
        return { open: document.getElementById("dlg-settings").open,
                 on: document.querySelector(".set-tab.on").getAttribute("data-pane"),
                 visible: [].filter.call(document.querySelectorAll(".set-pane"), function(s){return !s.hidden})
                   .map(function(s){return s.getAttribute("data-pane")}) };
      })()`);
      assert.equal(r.open, true, name + " 切换后弹窗被关掉了");
      assert.equal(r.on, name);
      assert.deepEqual(r.visible, [name], name + " 页不是唯一可见");
    }
    const after = await p.evaluate(`Math.round(document.getElementById("dlg-settings").getBoundingClientRect().width)`);
    assert.equal(before, after, "切换分类时弹窗宽度跳变");
  });

  await step("麦克风页：电平条 / 白线 / 阈值滑块三者齐全且对齐", async function () {
    await p.evaluate(`document.querySelector('.set-tab[data-pane="mic"]').click()`);
    await wait(150);
    const r = await p.evaluate(`(function(){
      var m = document.getElementById("set-meter");
      var mark = document.getElementById("set-meter-mark");
      var thr = document.getElementById("set-threshold");
      var mb = m.getBoundingClientRect(), kb = mark.getBoundingClientRect();
      return {
        meterW: Math.round(mb.width),
        markPct: parseFloat(mark.style.left),
        markInside: kb.left >= mb.left - 2 && kb.right <= mb.right + 2,
        thr: thr.value, min: thr.min, max: thr.max,
        disabled: thr.disabled,
        state: document.getElementById("set-gate-state").textContent,
        label: document.getElementById("threshold-label").textContent
      };
    })()`);
    assert.ok(r.meterW > 100, "电平条没有渲染：" + r.meterW);
    assert.ok(r.markInside, "阈值白线跑到电平条外面了");
    assert.ok(r.markPct > 0 && r.markPct < 100, "白线位置异常：" + r.markPct);
    assert.equal(r.disabled, false, "语音激活模式下阈值应可用");
    assert.match(r.label, /阈值/);
    assert.ok(/进频道|静音|说话|关闭/.test(r.state), "状态文案异常：" + r.state);
  });

  await step("拖动阈值：白线跟着走、文案与本地存储同步", async function () {
    for (const v of [10, 70, 100]) {
      await p.evaluate(`(function(){
        var s = document.getElementById("set-threshold");
        s.value = "${v}";
        s.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await wait(90);
      const r = await p.evaluate(`(function(){
        return { mark: parseFloat(document.getElementById("set-meter-mark").style.left),
                 label: document.getElementById("threshold-label").textContent,
                 saved: localStorage.getItem("zf_voice_threshold") };
      })()`);
      assert.equal(r.saved, String(v), "阈值没写进 localStorage");
      assert.equal(r.label, "阈值 " + v);
      assert.ok(r.mark > 0 && r.mark <= 100, "白线位置异常：" + r.mark);
    }
  });

  await step("说话方式：按键说话时阈值禁用，切回语音激活恢复", async function () {
    await p.evaluate(`document.querySelector('.set-tab[data-pane="talk"]').click()`);
    await wait(120);
    const pick = async (mode) => {
      await p.evaluate(`(function(){
        var r = document.getElementById("set-mode-${mode}");
        r.checked = true; r.dispatchEvent(new Event("change", { bubbles: true }));
      })()`);
      await wait(150);
      return p.evaluate(`(function(){
        return { disabled: document.getElementById("set-threshold").disabled,
                 voiceOn: document.getElementById("seg-voice").classList.contains("on"),
                 pttOn: document.getElementById("seg-ptt").classList.contains("on"),
                 mode: localStorage.getItem("zf_voice_mode") };
      })()`);
    };
    const ptt = await pick("ptt");
    assert.equal(ptt.disabled, true, "按键说话时阈值应禁用");
    assert.equal(ptt.pttOn, true);
    assert.equal(ptt.voiceOn, false);
    assert.equal(ptt.mode, "ptt");
    const voice = await pick("voice");
    assert.equal(voice.disabled, false, "切回语音激活后阈值应恢复可用");
    assert.equal(voice.voiceOn, true);
    assert.equal(voice.mode, "voice");
  });

  await step("刷新页面后设置被记住（说话方式 + 阈值）", async function () {
    const p2 = await page(browser, BASE + "/voice/?preview=1", { waitMs: 2000 });
    const r = await p2.evaluate(`(function(){
      document.getElementById("btn-settings").click();
      return { mode: localStorage.getItem("zf_voice_mode"),
               thr: localStorage.getItem("zf_voice_threshold"),
               slider: document.getElementById("set-threshold").value,
               voiceOn: document.getElementById("seg-voice").classList.contains("on") };
    })()`);
    assert.equal(r.mode, "voice");
    assert.equal(r.thr, "100");
    assert.equal(r.slider, "100", "重新打开设置时滑块没回填");
    assert.equal(r.voiceOn, true);
    await p2.close();
  });

  await step("共享音量拉到 150% / 200% 不抛 IndexSizeError（volume 只吃 0~1）", async function () {
    const before = (p.errors || []).length;
    const r = await p.evaluate(`(function(){
      var s = document.getElementById("screen-volume");
      if (!s) return { ok: false, why: "找不到共享音量滑块" };
      var v = document.getElementById("screen-video");
      var out = [];
      [100, 150, 200, 30, 100].forEach(function (x) {
        s.value = String(x);
        s.dispatchEvent(new Event("input", { bubbles: true }));
        out.push({ slider: x, volume: v ? v.volume : null });
      });
      return { ok: true, max: s.max, out: out };
    })()`);
    assert.equal(r.ok, true, r.why);
    r.out.forEach(function (o) {
      assert.ok(typeof o.volume === "number", "没有取到元素音量：" + JSON.stringify(o));
      assert.ok(o.volume >= 0 && o.volume <= 1, "媒体元素音量越界（会抛 IndexSizeError）：" + JSON.stringify(o));
    });
    assert.equal(r.out[r.out.length - 1].volume, 1, "拖回 100% 后音量应为 1");
    const fresh = (p.errors || []).slice(before).filter((e) => !/favicon|ERR_|404/i.test(e));
    assert.deepEqual(fresh, [], "拖音量时抛出异常：" + fresh.join(" | "));
  });

  await step("弹窗与后台页面都没有 JS 异常", async function () {
    const errs = (p.errors || []).filter((e) => !/favicon|ERR_|404/i.test(e));
    assert.deepEqual(errs, [], "出现 JS 错误：" + errs.join(" | "));
  });

  await p.screenshot(path.join(SHOTS, "voice-settings-mic.png"));
  await p.close();
} catch (e) {
  console.error("✘ 运行失败：" + (e && e.stack || e));
  fail++;
} finally {
  try { await browser.close(); } catch (_) {}
}

console.log("\n结果：" + pass + " 通过 / " + fail + " 失败");
if (fail) process.exitCode = 1;
