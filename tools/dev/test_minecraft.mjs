import test from 'node:test';
import assert from 'node:assert/strict';
import {World, DAY, W, H, RECIPES} from '../../minecraft/game.js';

function advance(world,seconds,controls={}) {
  for(let i=0;i<Math.round(seconds*60);i++) world.update(1/60,controls);
}
function fixture() {
  const world=new World('regression');
  world.blocks.fill(0);for(let y=50;y<H;y++)for(let x=0;x<W;x++)world.set(x,y,y===H-1?4:3);
  world.surface.fill(50);world.player.x=40;world.player.y=48.2;world.mobs=[];return world;
}
function recipe(id) {return RECIPES.find(r=>r.out===id);}

test('DAY uses seconds: 1200 simulation steps are 20 seconds, one day is 72000 steps',()=>{
  const world=fixture();world.mode='creative';const start=world.time;
  advance(world,20);assert.ok(Math.abs(world.time-start-20)<.00001);assert.equal(world.night(),false);
  advance(world,DAY-20);assert.ok(Math.abs(world.time-start-DAY)<.00001);assert.equal(world.night(),false);
  assert.equal(DAY,20*60);
});

test('workbench, wood pickaxe, cobblestone and furnace require real materials and tools',()=>{
  const world=fixture();world.add('oak_log',3);
  for(let i=0;i<3;i++)assert.equal(world.craft(recipe('oak_planks')),true);
  assert.equal(world.count('oak_log'),0);assert.equal(world.count('oak_planks'),12);
  assert.equal(world.craft(recipe('crafting_table_front')),true);
  assert.equal(world.craft(recipe('stick')),true);
  assert.equal(world.craft(recipe('wooden_pickaxe')),false,'tool crafting must require a nearby workbench');
  world.selected=world.inventory.findIndex(s=>s?.id==='crafting_table_front');
  assert.equal(world.place(39,49),true);assert.equal(world.count('crafting_table_front'),0);
  assert.equal(world.craft(recipe('wooden_pickaxe')),true);
  world.selected=world.inventory.findIndex(s=>s?.id==='wooden_pickaxe');
  for(let i=0;i<8;i++){
    world.set(41,49,3);for(let frame=0;frame<75;frame++)world.mine(41,49,1/60);
    assert.equal(world.get(41,49),0);advance(world,.3,{right:true});advance(world,.4);advance(world,.3,{left:true});
  }
  assert.equal(world.count('cobblestone'),8);assert.equal(world.held().dur,51);
  assert.equal(world.craft(recipe('furnace_front')),true);assert.equal(world.count('cobblestone'),0);
  world.selected=world.inventory.findIndex(s=>s?.id==='furnace_front');assert.equal(world.place(41,49),true);
  world.add('raw_iron',1);world.add('coal',1);assert.equal(world.smelt('raw_iron'),true);
  assert.equal(world.count('raw_iron'),0);assert.equal(world.count('coal'),0);
  advance(world,10.1);assert.equal(world.furnaces['41,49'].output,'iron_ingot');
  world.collectSmelt();assert.equal(world.count('iron_ingot'),1);
});

test('wrong tool does not drop ore, blocked targets and body-intersecting placement are rejected',()=>{
  const w=fixture();w.set(41,49,9);for(let i=0;i<901;i++)w.mine(41,49,1/60);
  assert.equal(w.get(41,49),0);assert.equal(w.drops.length,0);
  w.add('dirt',4);w.selected=0;assert.equal(w.place(40,49),false);
  w.set(41,48,3);w.set(41,49,3);assert.equal(w.reachable(43,49),false);
});

test('save roundtrip preserves terrain, inventory, furnace progress and dropped items',()=>{
  const w=fixture();w.add('wooden_pickaxe');w.set(41,49,14);w.add('sand');w.add('coal');w.smelt('sand');advance(w,4);
  w.drop('diamond',2,45,49);const data=w.serialize(),restored=World.restore(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(restored.inventory,w.inventory);assert.deepEqual(restored.blocks,w.blocks);
  assert.equal(restored.furnaces['41,49'].input,'sand');assert.ok(restored.furnaces['41,49'].progress>3.9);
  assert.equal(restored.drops[0].n,2);advance(restored,6.2);assert.equal(restored.furnaces['41,49'].output,'glass');
  data.blocks[0]=999;assert.throws(()=>World.restore(data),/方块/);
});

test('death drops inventory, respawn restores life and does not duplicate items',()=>{
  const w=fixture();w.add('diamond',3);w.damage(20,'test');assert.equal(w.player.health,0);assert.equal(w.count('diamond'),0);
  assert.equal(w.drops.reduce((sum,d)=>sum+d.n,0),3);w.respawn();assert.equal(w.player.health,20);assert.equal(w.count('diamond'),0);
});
