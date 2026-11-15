/* ══════════════════════════════════════════════════════════════
 *  ZF语音 —— 麦克风激活阈值（门限）回归测试
 *
 *  这一组专门盯住「阈值调到最低也说不了话」那次事故：
 *   1) 门限不能再靠 track.enabled 实现——enabled 是静音语义，会被 SDK 的
 *      mute()/unmute()、换设备后的 replaceTrack 反复覆写，一旦卡在 false
 *      就永远开不回来；
 *   2) 门限静音时必须只压增益，音轨本身保持 enabled=true；
 *   3) 电平检测必须在门限之前取样，否则关门就把自己的探测器一起关死（自锁）；
 *   4) 换麦克风（refreshAudio）后 VAD 必须重新跑起来，门限跟着新音频图工作。
 *
 *  前置：本地 dev server 在跑（npm run voice:dev），本机有 Chrome/Edge。
 *  运行：npm run voice:test:gate
 * ══════════════════════════════════════════════════════════════ */

import assert from "node:assert/strict";
import { launch, page } from "../../tools/dev/cdp.mjs";

const BASE = process.env.VOICE_UI_BASE || "http://127.0.0.1:8790";

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); console.log("  ✔ " + name); pass++; }
  catch (e) { console.error("  ✘ " + name + "\n    " + (e && e.stack || e)); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\nZF语音 麦克风门限回归（" + BASE + "）\n");

const browser = await launch({ port: 9800 + Math.floor(Math.random() * 100) });
const p = await page(browser, BASE + "/voice/?preview=1", { waitMs: 2200 });

/* 在页面里建一个真的传输层（假麦克风设备），采样门限状态 */
async function sample(js) {
  return p.evaluate(`(async function(){
    function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
    var room = { setState: function(){}, state: {} };
    var t = new window.VoiceTransport.Base(room, { join: { settings: { audio: {}, screen: {} } } });
    ${js}
  })()`);
}

try {
  await step("门限静音只用增益，不动 track.enabled", async () => {
    const r = await sample(`
      t.setVoiceGate({ enabled: true, threshold: 0.02 });
      await t.publishAudio();
      var track = t.localAudioTrack();
      var enabled = [], gains = [], levels = [];
      for (var i = 0; i < 40; i++) {
        await wait(100);
        enabled.push(track.enabled);
        gains.push(+(+t.gateGain.gain.value).toFixed(2));
        levels.push(+(+t.level).toFixed(2));
      }
      await t.disposeAudio();
      return { alwaysEnabled: enabled.every(function(v){ return v === true; }),
               minGain: Math.min.apply(null, gains), maxGain: Math.max.apply(null, gains),
               maxLevel: Math.max.apply(null, levels), openedSometime: gains.indexOf(1) >= 0 };
    `);
    assert.equal(r.alwaysEnabled, true, "门限不能把 track.enabled 置为 false（会被 SDK 覆写后卡死）");
    assert.ok(r.maxLevel > 0.02, "电平取样必须来自门限之前，不然关门后再也打不开（实测 maxLevel=" + r.maxLevel + "）");
    assert.ok(r.openedSometime, "有输入信号时门限必须放行（实测 maxGain=" + r.maxGain + "）");
    assert.equal(r.minGain, 0, "安静时增益应压到 0（实测 minGain=" + r.minGain + "）");
  });

  await step("关闭门限后增益恒为 1（阈值拖到 0 的退路）", async () => {
    const r = await sample(`
      t.setVoiceGate({ enabled: true, threshold: 0.02 });
      await t.publishAudio();
      t.setVoiceGate({ enabled: false, threshold: 0.02 });
      var gains = [];
      for (var i = 0; i < 12; i++) { await wait(80); gains.push(+(+t.gateGain.gain.value).toFixed(2)); }
      await t.disposeAudio();
      return { min: Math.min.apply(null, gains), max: Math.max.apply(null, gains) };
    `);
    assert.equal(r.min, 1, "门限关闭后不能还有静音（min=" + r.min + "）");
  });

  await step("静音按钮仍然有效，且能恢复", async () => {
    const r = await sample(`
      t.setVoiceGate({ enabled: false, threshold: 0.02 });
      await t.publishAudio();
      var track = t.localAudioTrack();
      t.setMic(false);
      await wait(150);
      var off = { gain: +(+t.gateGain.gain.value).toFixed(2), enabled: track.enabled };
      t.setMic(true);
      await wait(150);
      var on = { gain: +(+t.gateGain.gain.value).toFixed(2), enabled: track.enabled };
      await t.disposeAudio();
      return { off: off, on: on };
    `);
    assert.equal(r.off.enabled, false, "静音时音轨应 enabled=false");
    assert.equal(r.off.gain, 0, "静音时增益应为 0");
    assert.equal(r.on.enabled, true, "取消静音后音轨要恢复");
    assert.equal(r.on.gain, 1, "取消静音后增益要恢复");
  });

  await step("换麦克风后 VAD 与门限跟着新的音频图继续工作", async () => {
    const r = await sample(`
      t.setVoiceGate({ enabled: true, threshold: 0.02 });
      await t.publishAudio();
      await t.refreshAudio({});
      var hasVad = !!t.vadTimer;
      var hasAnalyser = !!t.analyser;
      var hasGateGain = !!t.gateGain;
      var gains = [], levels = [], enabled = [];
      var track = t.localAudioTrack();
      for (var i = 0; i < 30; i++) {
        await wait(100);
        gains.push(+(+t.gateGain.gain.value).toFixed(2));
        levels.push(+(+t.level).toFixed(2));
        enabled.push(track.enabled);
      }
      await t.disposeAudio();
      return { hasVad: hasVad, hasAnalyser: hasAnalyser, hasGateGain: hasGateGain,
               maxGain: Math.max.apply(null, gains), minGain: Math.min.apply(null, gains),
               maxLevel: Math.max.apply(null, levels),
               alwaysEnabled: enabled.every(function(v){ return v === true; }) };
    `);
    assert.equal(r.hasVad, true, "换设备后 VAD 定时器必须重启");
    assert.equal(r.hasAnalyser, true, "换设备后要重建分析器");
    assert.equal(r.hasGateGain, true, "换设备后要重建门限增益节点");
    assert.ok(r.maxLevel > 0.02, "换设备后电平仍要能读到（实测 " + r.maxLevel + "）");
    assert.ok(r.maxGain === 1, "换设备后有信号要放行（实测 maxGain=" + r.maxGain + "）");
    assert.equal(r.alwaysEnabled, true, "换设备后也不能把 track.enabled 关死");
  });

  await step("整个过程没有 JS 异常", async () => {
    assert.deepEqual(p.errors, [], "页面报错：" + p.errors.join(" | "));
  });
} finally {
  await p.close();
  await browser.close();
}

console.log("\n结果：通过 " + pass + " · 失败 " + fail + "\n");
process.exit(fail ? 1 : 0);
