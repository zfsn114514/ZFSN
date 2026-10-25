import test from 'node:test';
import assert from 'node:assert/strict';
import {World, DAY, W, H, RECIPES, ITEMS, BLOCKS, toolVertex} from '../../minecraft/game.js';

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


test('tool handle stays in the palm at every swing angle with a fixed model scale',()=>{
  for(const a of [-.3,-.8,-1.72,0,.3]){
    const p=toolVertex(4.5,12.5,0,a);
    assert.equal(p.x,-6);assert.ok(Math.abs(p.y-(24-10*Math.cos(a)))<1e-9);
    assert.ok(Math.abs(p.z+10*Math.sin(a))<1e-9);
    const tip=toolVertex(12.5,4.5,0,a);
    assert.ok(Math.abs(Math.hypot(tip.y-p.y,tip.z-p.z)-Math.sqrt(72))<1e-9);
  }
});
test('new diamond tools and reversible resource blocks have real recipes',()=>{
  const w=fixture();w.set(41,49,13);
  for(const tool of ['axe','sword','shovel']){
    w.add('diamond',3);w.add('stick',2);assert.equal(w.craft(recipe('diamond_'+tool)),true);
    assert.equal(ITEMS['diamond_'+tool].durability,1561);
  }
  for(const [block,item]of [['iron_block','iron_ingot'],['diamond_block','diamond'],['coal_block','coal']]){
    w.inventory.fill(null);w.add(item,9);assert.equal(w.craft(recipe(block)),true);
    assert.equal(w.count(item),0);assert.equal(w.count(block),1);
    assert.equal(w.craft(RECIPES.find(r=>r.out===item&&r.needs[block])),true);
    assert.equal(w.count(item),9);assert.equal(w.count(block),0);
  }
  for(const id of ['stone_bricks','sandstone','smooth_stone'])assert.ok(BLOCKS.some(b=>b.id===id));
});
test('charcoal reserves input, consumes enough fuel and survives save/reload',()=>{
  const w=fixture();w.set(41,49,14);w.add('oak_log');
  assert.equal(w.smelt('oak_log'),false);assert.equal(w.count('oak_log'),1);
  w.add('stick');assert.equal(w.smelt('oak_log'),false);assert.equal(w.count('stick'),1);
  w.add('stick');assert.equal(w.smelt('oak_log'),true);assert.equal(w.count('stick'),0);assert.equal(w.count('oak_log'),0);
  advance(w,10.2);assert.equal(w.furnaces['41,49'].output,'charcoal');w.collectSmelt();
  w.add('cobblestone');assert.equal(w.smelt('cobblestone'),true);advance(w,10.2);w.collectSmelt();
  assert.equal(w.count('stone'),1);assert.equal(w.smelt('stone'),true);advance(w,10.2);w.collectSmelt();assert.equal(w.count('smooth_stone'),1);
  w.furnaces['41,49'].fuel=0;w.add('coal_block');w.add('sand');assert.equal(w.smelt('sand'),true);
  const saved=World.restore(JSON.parse(JSON.stringify(w.serialize())));
  assert.equal(saved.furnaces['41,49'].fuel,800);
});


test('v3 expansion preserves buildings, water sources and player inventory in place',()=>{
  const w=fixture(),data=w.serialize(),width=640,height=160;
  const encode=arr=>{const a=[];let v=arr[0],n=0;for(const x of arr){if(x===v)n++;else{a.push(v,n);v=x;n=1;}}a.push(v,n);return a;};
  const blocks=new Uint16Array(width*height),natural=new Uint8Array(width*height),water=new Uint8Array(width*height);
  for(let x=0;x<width;x++)blocks[50*width+x]=3;
  blocks[49*width+42]=21;blocks[49*width+44]=17;water[49*width+44]=8;
  Object.assign(data,{version:3,blocks:encode(blocks),natural:encode(natural),water:encode(water),surface:Array(width).fill(50),waterSources:[49*width+44],inventory:Array(36).fill(null)});
  data.inventory[0]={id:'diamond',n:17};delete data.width;delete data.height;
  const restored=World.restore(data);
  assert.equal(restored.get(42,49),21);assert.equal(restored.get(44,49),17);assert.ok(restored.waterSources.has(49*W+44));assert.equal(restored.count('diamond'),17);
  assert.equal(restored.surface[400],50);assert.equal(restored.blocks.length,4096*256);assert.equal(restored.migrated,true);
});
test('catalog blocks above 255 survive placement, mining and v4 saves',()=>{
  const w=fixture();const index=BLOCKS.findIndex((b,i)=>i>255&&b.hard<Infinity);assert.ok(index>255);
  w.set(2000,49,index);w.add(BLOCKS[index].id,4);
  const restored=World.restore(JSON.parse(JSON.stringify(w.serialize())));assert.equal(restored.get(2000,49),index);assert.equal(restored.count(BLOCKS[index].id),4);
  assert.ok(Object.keys(ITEMS).length>1300);
});
test('supported spawn eggs spawn a live mob and consume the item',()=>{
  const w=fixture();w.add('cow_spawn_egg');w.selected=0;
  assert.equal(w.place(42,48),true);assert.equal(w.mobs[0].type,'cow');assert.equal(w.count('cow_spawn_egg'),0);
});
