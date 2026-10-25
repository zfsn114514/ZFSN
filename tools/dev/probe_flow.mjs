// 直接在 Node 里跑 World，检查世界放大后水流扩散是否还正常。
import { World, W } from '../../minecraft/game.js';

const seed = process.argv[2] || 'ZFSN-CHECK';
const w = new World(seed, 'survival');
const flat = (xx, y0) => w.surface[xx] === y0 && w.get(xx, y0) === 1 && w.get(xx, y0 - 1) === 0 && w.get(xx, y0 - 2) === 0;
let x = 60;
while (x < W - 40 && !(() => { const y0 = w.surface[x]; return flat(x, y0) && flat(x - 2, y0) && flat(x + 2, y0) && flat(x - 4, y0) && flat(x + 4, y0); })()) x++;
console.log('seed', seed, 'x', x, 'surface', w.surface[x]);
for (let yy = w.surface[x] - 6; yy <= w.surface[x] + 2; yy++) {
  const row = [];
  for (let xx = x - 8; xx <= x + 8; xx++) row.push(String(w.get(xx, yy)).padStart(2));
  console.log('y=' + String(yy).padStart(3), row.join(' '));
}
const count = () => w.blocks.reduce((n, v) => n + (v === 17 ? 1 : 0), 0);
const before = count();
w.setWaterSource(x, w.surface[x] - 4);
const steps = [];
for (let i = 0; i < 8; i++) { w.stepWater(); steps.push(count()); }
console.log('before', before, 'steps', steps.join(','), 'spread', steps[7] - before);
const y = w.surface[x] - 1, row2 = [];
for (let xx = x - 12; xx <= x + 12; xx++) row2.push(w.get(xx, y) === 17 ? 'W' + w.water[y * W + xx] : '..');
console.log('row y=' + y, row2.join(' '));
