/* 洞穴阈值标定（规格书 §5 / constants.js 的 CAVES 注释里引用了这份工具）
 * 用法：node tools/dev/mc_calib_caves.mjs
 * 目的：把「蠕虫/大空洞」的阈值按实际覆盖率反推 —— 本实现的 2D fBm 取值范围
 *       只有约 [-0.35, 0.50]，阈值必须按覆盖率定，不能想当然写 0.3。
 */
import { makeFbm2D } from '../../minecraft/worldgen/noise.js';
function mk(freq,salt){return makeFbm2D(12345,{freq,octaves:3,persistence:0.55,lacunarity:2,salt});}
function coverage(fn,pred){let n=0,tot=0;for(let x=-200;x<200;x+=2)for(let y=0;y<160;y+=2){tot++;if(pred(fn(x,y)))n++;}return n/tot;}
for (const freq of [1/8,1/12,1/16,1/26]){
  const w = mk(freq,167);
  const out=[];
  for (const t of [0.01,0.02,0.03,0.05,0.08]) out.push(`|n|<${t}:${(coverage(w,v=>Math.abs(v)<t)*100).toFixed(1)}%`);
  console.log('worm freq',freq.toFixed(3), out.join(' '));
}
for (const freq of [1/25,1/40,1/55]){
  const c = mk(freq,181);
  const out=[];
  for (const t of [0.20,0.25,0.30,0.35,0.40]) out.push(`n>${t}:${(coverage(c,v=>v>t)*100).toFixed(2)}%`);
  console.log('cheese freq',freq.toFixed(3), out.join(' '));
}
