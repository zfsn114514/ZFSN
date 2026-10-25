/* Standalone 2D sandbox. Distances are blocks; simulation uses fixed 60 Hz steps.
 * No server calls, accounts, game-client code, or third-party runtime required. */
// Simulation time is in SECONDS, not frames: update(1 / 60) advances 1/60 s.
// A full day therefore takes 72,000 simulation steps (20 minutes of active play).
export const W = 384, H = 144, DAY = 20 * 60;
export const BLOCKS = [
  {id:'air',name:'空气',solid:false},
  {id:'grass_block_side',name:'草方块',hard:.6,tool:'shovel',drop:'dirt'},
  {id:'dirt',name:'泥土',hard:.5,tool:'shovel'},
  {id:'stone',name:'石头',hard:1.5,tool:'pickaxe',tier:1,drop:'cobblestone'},
  {id:'bedrock',name:'基岩',hard:Infinity},
  {id:'oak_log',name:'橡木原木',hard:2,tool:'axe'},
  {id:'oak_leaves',name:'橡树树叶',hard:.2},
  {id:'sand',name:'沙子',hard:.5,tool:'shovel'},
  {id:'coal_ore',name:'煤矿石',hard:3,tool:'pickaxe',tier:1,drop:'coal'},
  {id:'iron_ore',name:'铁矿石',hard:3,tool:'pickaxe',tier:2,drop:'raw_iron'},
  {id:'diamond_ore',name:'钻石矿石',hard:3,tool:'pickaxe',tier:3,drop:'diamond'},
  {id:'oak_planks',name:'橡木木板',hard:2,tool:'axe'},
  {id:'cobblestone',name:'圆石',hard:2,tool:'pickaxe',tier:1},
  {id:'crafting_table_front',name:'工作台',hard:2.5,tool:'axe'},
  {id:'furnace_front',name:'熔炉',hard:3.5,tool:'pickaxe',tier:1},
  {id:'glass',name:'玻璃',hard:.3,drop:null},
  {id:'torch',name:'火把',hard:0,solid:false},
  {id:'water_still',name:'水',solid:false,hard:Infinity},
];
export const ITEMS = Object.fromEntries(BLOCKS.slice(1).map((b,i)=>[b.id,{...b,block:i+1,stack:64}]));
Object.assign(ITEMS,{
  stick:{name:'木棍'},coal:{name:'煤炭'},raw_iron:{name:'粗铁'},iron_ingot:{name:'铁锭'},diamond:{name:'钻石'},
  apple:{name:'苹果',food:4},porkchop:{name:'生猪排',food:3},cooked_porkchop:{name:'熟猪排',food:8},
});
for (const [material,tier,speed,durability] of [['wooden',1,2,59],['stone',2,4,131],['iron',3,6,250],['diamond',4,8,1561]]) {
  for (const [tool,name] of [['pickaxe','镐'],['axe','斧'],['sword','剑'],['shovel','锹']]) {
    if(material==='diamond'&&tool!=='pickaxe') continue;
    ITEMS[`${material}_${tool}`]={name:({wooden:'木',stone:'石',iron:'铁',diamond:'钻石'})[material]+name,tool,tier,speed,durability,stack:1,damage:tool==='sword'?tier+3:tool==='axe'?tier+2:2};
  }
}
for (const [id,item] of Object.entries(ITEMS)) {item.id=id;item.stack??=64;}
export const RECIPES = [
  {out:'oak_planks',n:4,needs:{oak_log:1}},
  {out:'stick',n:4,needs:{oak_planks:2}},
  {out:'crafting_table_front',n:1,needs:{oak_planks:4}},
  {out:'torch',n:4,needs:{coal:1,stick:1}},
  {out:'furnace_front',n:1,needs:{cobblestone:8},station:true},
];
for(const [material,ingredient] of [['wooden','oak_planks'],['stone','cobblestone'],['iron','iron_ingot'],['diamond','diamond']]) {
  for(const [tool,amount,sticks] of [['pickaxe',3,2],['axe',3,2],['sword',2,1],['shovel',1,2]]) {
    if(material==='diamond'&&tool!=='pickaxe') continue;
    RECIPES.push({out:`${material}_${tool}`,n:1,needs:{[ingredient]:amount,stick:sticks},station:true});
  }
}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
function hash(s){let n=2166136261;for(const c of String(s)) n=Math.imul(n^c.charCodeAt(0),16777619);return n>>>0;}
function random(seed){let a=seed>>>0;return()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
export function generate(seed){
  const rng=random(hash(seed)), blocks=new Uint8Array(W*H), surface=new Int16Array(W);
  let elevation=45;
  for(let x=0;x<W;x++){
    elevation=clamp(elevation+(rng()-.5)*1.6,38,53);
    const top=Math.round(elevation+Math.sin(x*.045)*4+Math.sin(x*.12)*1.5);surface[x]=top;
    for(let y=top;y<H;y++) blocks[y*W+x]=y>H-3?4:y===top?1:y<top+4?2:3;
  }
  // Random walk caves: veins and caverns remain reproducible for the same seed.
  for(let cave=0;cave<74;cave++){
    let x=rng()*W,y=58+rng()*(H-65),angle=rng()*Math.PI*2;
    for(let step=0;step<35+rng()*80;step++){
      angle+=(rng()-.5)*.8;x+=Math.cos(angle)*1.6;y=clamp(y+Math.sin(angle),55,H-5);
      const radius=1+rng()*2;
      for(let yy=Math.floor(y-radius);yy<=y+radius;yy++)for(let xx=Math.floor(x-radius);xx<=x+radius;xx++){
        if(xx>0&&xx<W-1&&yy>surface[xx]+5&&yy<H-3&&(xx-x)**2+(yy-y)**2<radius*radius) blocks[yy*W+xx]=0;
      }
    }
  }
  for(let y=50;y<H-3;y++)for(let x=1;x<W-1;x++){
    if(blocks[y*W+x]!==3)continue;
    const r=rng();blocks[y*W+x]=y>99&&r<.013?10:y>62&&r<.038?9:r<.075?8:3;
  }
  for(let x=8;x<W-8;x+=40+Math.floor(rng()*24)){
    if(Math.abs(x-40)<14)continue;
    const level=surface[x];
    for(let xx=x-4;xx<=x+4;xx++){
      for(let y=Math.min(surface[xx],level);y<=level+2;y++)blocks[y*W+xx]=y<level+2?17:7;
      surface[xx]=level+2;
    }
  }
  for(let x=5;x<W-5;x+=5+Math.floor(rng()*7)){
    const y=surface[x];if(blocks[y*W+x]!==1||Math.abs(x-40)<3)continue;
    const height=4+Math.floor(rng()*3);
    for(let yy=y-height-2;yy<y-height+2;yy++)for(let xx=x-2;xx<=x+2;xx++){
      if(Math.abs(xx-x)+Math.abs(yy-(y-height))<4&&blocks[yy*W+xx]===0)blocks[yy*W+xx]=6;
    }
    for(let yy=y-height;yy<y;yy++)blocks[yy*W+x]=5;
  }
  return{blocks,surface};
}

export class World {
  constructor(seed='ZFSN',mode='survival'){
    this.seed=String(seed);this.mode=mode;const terrain=generate(this.seed);this.blocks=terrain.blocks;this.surface=terrain.surface;
    this.spawn={x:40,y:this.surface[40]-2};this.player={...this.spawn,w:.65,h:1.8,vx:0,vy:0,ground:false,health:20,food:20,invuln:0,face:1};
    this.inventory=Array(36).fill(null);this.selected=0;this.time=120;this.elapsed=0;this.drops=[];this.mobs=[];this.furnaces={};this.mining=null;this.attackCooldown=0;this.exhaustion=0;this.regen=0;this.mobClock=0;this.gravityClock=0;this.deathReason='';this.revision=0;this.notify=()=>{};
    this.rng=random(hash(seed)^0xabcd);
    if(mode==='creative') ['grass_block_side','dirt','stone','oak_log','oak_planks','glass','torch','crafting_table_front','furnace_front'].forEach(id=>this.add(id,64));
    for(let i=0;i<7;i++){const x=35+i*28;this.mobs.push(this.makeMob('pig',x,this.surface[x]-1));}
  }
  get(x,y){x=Math.floor(x);y=Math.floor(y);return x<0||x>=W||y>=H?4:y<0?0:this.blocks[y*W+x];}
  set(x,y,id){if(x>=0&&x<W&&y>=0&&y<H){this.blocks[y*W+x]=id;this.revision++;}}
  solid(x,y){const id=this.get(x,y);return id!==0&&BLOCKS[id].solid!==false;}
  collides(entity){for(let y=Math.floor(entity.y+.001);y<=Math.floor(entity.y+entity.h-.001);y++)for(let x=Math.floor(entity.x+.001);x<=Math.floor(entity.x+entity.w-.001);x++)if(this.solid(x,y))return true;return false;}
  count(id){return this.inventory.reduce((sum,s)=>sum+(s?.id===id?s.n:0),0);}
  add(id,n=1,dur){
    const item=ITEMS[id];if(!item)return n;
    if(item.stack>1)for(const slot of this.inventory){if(slot?.id===id){const take=Math.min(n,item.stack-slot.n);slot.n+=take;n-=take;if(!n)return 0;}}
    for(let i=0;i<this.inventory.length&&n;i++)if(!this.inventory[i]){const take=Math.min(n,item.stack);this.inventory[i]={id,n:take,...(item.durability?{dur:dur??item.durability}:{})};n-=take;}
    return n;
  }
  remove(id,n){if(this.count(id)<n)return false;for(let i=0;i<36&&n;i++){const slot=this.inventory[i];if(slot?.id===id){const take=Math.min(n,slot.n);slot.n-=take;n-=take;if(!slot.n)this.inventory[i]=null;}}return true;}
  held(){return this.inventory[this.selected];}
  nearBlock(id,radius=3){const p=this.player;for(let y=Math.floor(p.y)-radius;y<p.y+p.h+radius;y++)for(let x=Math.floor(p.x)-radius;x<p.x+radius;x++)if(this.get(x,y)===id)return{x,y,key:`${x},${y}`};return null;}
  canCraft(recipe){return(!recipe.station||this.nearBlock(13)||this.mode==='creative')&&Object.entries(recipe.needs).every(([id,n])=>this.count(id)>=n);}
  craft(recipe){
    if(!this.canCraft(recipe))return false;
    const before=structuredClone(this.inventory);for(const [id,n] of Object.entries(recipe.needs))this.remove(id,n);
    if(this.add(recipe.out,recipe.n)){this.inventory=before;this.notify('背包已满，先腾出一个格子');return false;}
    this.notify(`合成了 ${ITEMS[recipe.out].name} × ${recipe.n}`);return true;
  }
  giveCreative(id){if(this.mode!=='creative'||!ITEMS[id]||['bedrock','water_still'].includes(id))return;this.inventory[this.selected]={id,n:ITEMS[id].stack,...(ITEMS[id].durability?{dur:ITEMS[id].durability}:{})};}
  reachable(x,y){
    const p=this.player,dx=x+.5-(p.x+p.w/2),dy=y+.5-(p.y+.7),dist=Math.hypot(dx,dy);
    if(x<0||x>=W||y<0||y>=H||dist>5)return false;
    for(let step=.15;step<dist-.5;step+=.15){const xx=p.x+p.w/2+dx*step/dist,yy=p.y+.7+dy*step/dist;if(Math.floor(xx)===x&&Math.floor(yy)===y)break;if(this.solid(xx,yy))return false;}
    return true;
  }
  wear(){if(this.mode==='creative')return;const slot=this.held();if(slot?.dur&&--slot.dur<=0){this.notify(`${ITEMS[slot.id].name} 已损坏`);this.inventory[this.selected]=null;}}
  drop(id,n,x,y,dur){if(n>0)this.drops.push({id,n,x,y,w:.3,h:.3,vx:(this.rng()-.5)*2,vy:-3,age:0,...(dur?{dur}:{})});}
  mine(x,y,dt){
    x=Math.floor(x);y=Math.floor(y);const block=BLOCKS[this.get(x,y)],tool=ITEMS[this.held()?.id];
    if(!block||this.get(x,y)===0||!this.reachable(x,y)||!Number.isFinite(block.hard)){this.mining=null;return;}
    const key=`${x},${y}`;if(this.mining?.key!==key)this.mining={key,x,y,progress:0};
    const correct=tool?.tool===block.tool,harvest=!block.tier||(correct&&tool.tier>=block.tier);
    const seconds=this.mode==='creative'?.12:Math.max(.08,block.hard*(harvest?1.5:5)/(correct?tool.speed:1));
    this.mining.progress+=dt/seconds;
    if(this.mining.progress<1)return;
    const id=this.get(x,y);this.set(x,y,0);this.wear();this.exhaustion+=.025;
    if(this.mode!=='creative'&&harvest){
      if(id===6){if(this.rng()<.12)this.drop('apple',1,x+.35,y+.35);else if(this.rng()<.3)this.drop('stick',1,x+.35,y+.35);}
      else{const drop=block.drop===undefined?block.id:block.drop;if(drop)this.drop(drop,1,x+.35,y+.35);}
    }
    const furnace=this.furnaces[key];if(furnace){if(furnace.input)this.drop(furnace.input,1,x,y);if(furnace.output)this.drop(furnace.output,furnace.count,x,y);delete this.furnaces[key];}
    this.mining=null;
  }
  place(x,y){
    x=Math.floor(x);y=Math.floor(y);const slot=this.held(),item=ITEMS[slot?.id];
    if(!item?.block||!this.reachable(x,y)||![0,17].includes(this.get(x,y)))return false;
    if(![[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([xx,yy])=>this.solid(xx,yy)))return false;
    const rect={x,y,w:1,h:1};if(item.solid!==false&&(overlap(rect,this.player)||this.mobs.some(m=>overlap(rect,m))))return false;
    this.set(x,y,item.block);if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;return true;
  }
  eat(){const slot=this.held(),item=ITEMS[slot?.id];if(!item?.food||this.player.food>=20)return false;this.player.food=Math.min(20,this.player.food+item.food);if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;this.notify('补充了饱食度');return true;}
  smelt(input){
    const station=this.nearBlock(14),out={raw_iron:'iron_ingot',sand:'glass',porkchop:'cooked_porkchop'}[input];
    if(!station||!out||!this.count(input))return false;
    const f=this.furnaces[station.key]??={fuel:0,input:null,output:null,count:0,progress:0};
    if(f.input||f.output&&f.output!==out||f.count>=64)return false;
    if(f.fuel<10){const fuel=['coal','oak_planks','oak_log','stick'].find(id=>this.count(id)>0);if(!fuel){this.notify('需要煤炭、木板、原木或木棍作为燃料');return false;}this.remove(fuel,1);f.fuel+=fuel==='coal'?80:fuel==='stick'?10:15;}
    this.remove(input,1);f.input=input;f.result=out;f.progress=0;return true;
  }
  collectSmelt(){const station=this.nearBlock(14),f=station&&this.furnaces[station.key];if(!f?.output)return;const rest=this.add(f.output,f.count);f.count=rest;if(!rest)f.output=null;}
  makeMob(type,x,y){return{type,x,y,w:type==='pig'?.95:.65,h:type==='pig'?.85:1.8,vx:0,vy:0,ground:false,health:type==='pig'?10:20,clock:0,face:1,hurt:0};}
  damage(amount,reason){const p=this.player;if(this.mode==='creative'||p.invuln>0||p.health<=0)return;p.health=Math.max(0,p.health-amount);p.invuln=1;if(!p.health){this.deathReason=reason;for(const s of this.inventory)if(s)this.drop(s.id,s.n,p.x,p.y,s.dur);this.inventory.fill(null);this.notify('你倒下了，物品掉落在原地');}}
  respawn(){const p=this.player;Object.assign(p,{...this.spawn,vx:0,vy:0,health:20,food:20,invuln:3});while(this.collides(p)&&p.y>1)p.y--;this.mining=null;}
  attack(x,y){if(this.attackCooldown>0)return false;const p=this.player;const mob=this.mobs.find(m=>x>=m.x-.4&&x<=m.x+m.w+.4&&y>=m.y-.3&&y<=m.y+m.h+.3&&Math.hypot(m.x-p.x,m.y-p.y)<3.5&&this.reachable(Math.floor(m.x),Math.floor(m.y)));if(!mob)return false;
    this.attackCooldown=.55;mob.health-=ITEMS[this.held()?.id]?.damage??1;mob.hurt=.25;mob.vx=(mob.x>p.x?1:-1)*6;mob.vy=-3;this.wear();if(mob.health<=0){if(mob.type==='pig')this.drop('porkchop',2,mob.x,mob.y);this.mobs.splice(this.mobs.indexOf(mob),1);}return true;
  }
  move(e,dt,fallDamage=false){
    e.ground=false;const inWater=this.get(e.x+e.w/2,e.y+e.h*.65)===17;
    e.vy=Math.min(inWater?3:22,e.vy+(inWater?7:25)*dt);
    const dx=e.vx*dt,steps=Math.max(1,Math.ceil(Math.abs(dx)/.2));
    for(let s=0;s<steps;s++){e.x+=dx/steps;if(this.collides(e)){e.x-=dx/steps;e.vx=0;break;}}
    const dy=e.vy*dt,ys=Math.max(1,Math.ceil(Math.abs(dy)/.2));
    for(let s=0;s<ys;s++){e.y+=dy/ys;if(this.collides(e)){e.y-=dy/ys;if(e.vy>0){e.ground=true;if(fallDamage&&e.vy>12.5&&!inWater)this.damage(Math.ceil((e.vy*e.vy/50)-3),'摔落');}e.vy=0;break;}}
    return inWater;
  }
  night(){return (this.time%DAY)/DAY>.54&&(this.time%DAY)/DAY<.96;}
  update(dt,controls={}){
    if(this.player.health<=0)return;
    const p=this.player;this.time+=dt;this.elapsed+=dt;this.attackCooldown=Math.max(0,this.attackCooldown-dt);p.invuln=Math.max(0,p.invuln-dt);
    const water=this.get(p.x+p.w/2,p.y+1)===17,dir=(controls.right?1:0)-(controls.left?1:0),speed=water?2.5:controls.sprint&&p.food>6?5.6:4.3;
    p.vx=dir*speed;if(dir){p.face=dir;this.exhaustion+=dt*(controls.sprint?.11:.025);}
    if(controls.jump&&(p.ground||water||this.mode==='creative')){p.vy=this.mode==='creative'?-7:water?-4.8:-8.8;if(p.ground)this.exhaustion+=.05;}
    this.move(p,dt,true);
    if(this.mode!=='creative'){
      if(this.exhaustion>=1){p.food=Math.max(0,p.food-1);this.exhaustion-=1;}
      this.regen+=dt;if(this.regen>=4){this.regen=0;if(p.food>=18&&p.health<20){p.health++;this.exhaustion+=.6;}else if(p.food===0&&p.health>1)this.damage(1,'饥饿');}
    }
    for(const d of this.drops){d.age+=dt;this.move(d,dt);d.vx*=.97;if(d.age>.4&&Math.hypot(d.x-p.x,d.y-p.y-.7)<1.7){d.n=this.add(d.id,d.n,d.dur);}}
    this.drops=this.drops.filter(d=>d.n>0&&d.age<300);
    for(const f of Object.values(this.furnaces))if(f.input&&f.fuel>0){f.progress+=dt;f.fuel=Math.max(0,f.fuel-dt);if(f.progress>=10){f.output=f.result;f.count++;f.input=null;f.progress=0;}}
    this.mobClock+=dt;
    if(this.mobClock>9){this.mobClock=0;if(this.night()&&this.mobs.filter(m=>m.type==='zombie').length<9){const x=Math.floor(clamp(p.x+(this.rng()<.5?-1:1)*(15+this.rng()*15),2,W-3)),y=this.surface[x]-2;if(!this.nearTorch(x,y,7))this.mobs.push(this.makeMob('zombie',x,y));}}
    for(const m of this.mobs){
      m.clock+=dt;m.hurt=Math.max(0,m.hurt-dt);
      if(!m.hurt){const chase=m.type==='zombie'&&Math.abs(m.x-p.x)<26;if(chase){m.vx=Math.sign(p.x-m.x)*1.45;m.face=Math.sign(m.vx)||1;}else if(m.clock>3){m.clock=0;m.vx=(this.rng()<.5?0:this.rng()<.5?-1:1)*.7;m.face=Math.sign(m.vx)||m.face;}}
      if(m.ground&&m.vx&&this.solid(m.x+(m.vx>0?m.w+.2:-.2),m.y+m.h-.2))m.vy=-8;
      this.move(m,dt);
      if(m.type==='zombie'){
        if(this.mode!=='creative'&&overlap(p,m))this.damage(3,'僵尸');
        if(!this.night()&&m.y<this.surface[Math.floor(clamp(m.x,0,W-1))]+1)m.health-=dt*2;
      }
    }
    this.mobs=this.mobs.filter(m=>m.health>0&&Math.abs(m.x-p.x)<95);
    this.gravityClock+=dt;if(this.gravityClock>.16){this.gravityClock=0;for(let y=Math.min(H-4,Math.floor(p.y)+20);y>Math.max(0,p.y-20);y--)for(let x=Math.max(0,Math.floor(p.x)-22);x<Math.min(W,p.x+22);x++)if(this.get(x,y)===7&&[0,17].includes(this.get(x,y+1))&&!overlap({x,y:y+1,w:1,h:1},p)){this.set(x,y,0);this.set(x,y+1,7);}}
  }
  nearTorch(x,y,r){for(let yy=Math.max(0,Math.floor(y-r));yy<=Math.min(H-1,y+r);yy++)for(let xx=Math.max(0,Math.floor(x-r));xx<=Math.min(W-1,x+r);xx++)if(this.get(xx,yy)===16&&Math.hypot(xx-x,yy-y)<r)return true;return false;}
  serialize(){return{version:1,seed:this.seed,mode:this.mode,blocks:Array.from(this.blocks),surface:Array.from(this.surface),spawn:this.spawn,player:this.player,inventory:this.inventory,selected:this.selected,time:this.time,elapsed:this.elapsed,drops:this.drops,mobs:this.mobs,furnaces:this.furnaces,exhaustion:this.exhaustion};}
  static restore(data){
    if(!data||data.version!==1||typeof data.seed!=='string'||data.seed.length>100||!['survival','creative'].includes(data.mode))throw Error('存档格式不受支持');
    if(!Array.isArray(data.blocks)||data.blocks.length!==W*H||data.blocks.some(v=>!Number.isInteger(v)||v<0||v>=BLOCKS.length))throw Error('世界方块数据损坏');
    if(!Array.isArray(data.inventory)||data.inventory.length!==36||data.inventory.some(s=>s&&(!ITEMS[s.id]||!Number.isInteger(s.n)||s.n<1||s.n>ITEMS[s.id].stack||ITEMS[s.id].durability&&(!Number.isInteger(s.dur)||s.dur<1||s.dur>ITEMS[s.id].durability))))throw Error('背包数据损坏');
    const p=data.player;if(!p||![p.x,p.y,p.health,p.food].every(Number.isFinite)||p.x<0||p.x>W-1||p.y< -20||p.y>H-2||p.health<0||p.health>20||p.food<0||p.food>20)throw Error('玩家数据损坏');
    if(!Number.isFinite(data.time)||data.time<0||!Number.isFinite(data.elapsed)||data.elapsed<0)throw Error('时间数据损坏');
    const w=new World(data.seed,data.mode);w.blocks=Uint8Array.from(data.blocks);w.player={...w.player,x:p.x,y:p.y,health:p.health,food:p.food};w.inventory=structuredClone(data.inventory);w.time=data.time;w.elapsed=data.elapsed;w.selected=Number.isInteger(data.selected)?clamp(data.selected,0,8):0;w.exhaustion=Number.isFinite(data.exhaustion)?clamp(data.exhaustion,0,1):0;
    w.drops=[];w.mobs=[];
    if(Array.isArray(data.drops))for(const d of data.drops.slice(0,1000)){if(ITEMS[d.id]&&Number.isFinite(d.x)&&Number.isFinite(d.y)&&d.x>=0&&d.x<W&&d.y>=0&&d.y<H&&Number.isInteger(d.n)&&d.n>0&&d.n<=64){w.drop(d.id,d.n,d.x,d.y,ITEMS[d.id].durability?clamp(Math.floor(d.dur)||1,1,ITEMS[d.id].durability):undefined);}}
    if(Array.isArray(data.mobs))for(const m of data.mobs.slice(0,40)){if(['pig','zombie'].includes(m.type)&&Number.isFinite(m.x)&&Number.isFinite(m.y)&&m.x>=0&&m.x<W&&m.y>=0&&m.y<H&&Number.isFinite(m.health)&&m.health>0){const mob=w.makeMob(m.type,m.x,m.y);mob.health=Math.min(mob.health,m.health);w.mobs.push(mob);}}
    if(data.furnaces&&typeof data.furnaces==='object')for(const [key,f] of Object.entries(data.furnaces).slice(0,W*H)){
      if(!/^\d{1,3},\d{1,3}$/.test(key))continue;const [x,y]=key.split(',').map(Number);if(w.get(x,y)!==14||!f)continue;
      const outputs={raw_iron:'iron_ingot',sand:'glass',porkchop:'cooked_porkchop'};
      if(f.input&&!outputs[f.input]||f.output&&!Object.values(outputs).includes(f.output)||!Number.isFinite(f.fuel)||!Number.isFinite(f.progress)||!Number.isInteger(f.count))continue;
      w.furnaces[key]={fuel:clamp(f.fuel,0,80),progress:clamp(f.progress,0,10),count:clamp(f.count,0,64),input:f.input||null,result:outputs[f.input]||null,output:f.output||null};
    }
    while(w.collides(w.player)&&w.player.y>0)w.player.y--;
    return w;
  }
}

if(typeof document!=='undefined') boot();

async function boot(){
  const $=s=>document.querySelector(s),canvas=$('#world'),ctx=canvas.getContext('2d',{alpha:false});
  const textureBase=new URL('textures/',import.meta.url),images={},tinted={};
  let world=new World('ZFSN OVERWORLD'),playing=false,viewW=innerWidth,viewH=innerHeight,tile=32,camera={x:30,y:30},last=performance.now(),accumulator=0,hudClock=0,saveClock=0,toastTimer,swap=-1,aim=null,mouseDown=false,touchMine=false,inventorySignature='',deadShown=false;
  const keys=new Set(),heldTouches=new Map(),SAVE='zfsn.minecraft2d.v1',coarse=matchMedia('(pointer:coarse)').matches;
  const dialogs=[...document.querySelectorAll('dialog')];
  const paused=()=>!playing||dialogs.some(d=>d.open);
  const notify=text=>{const node=$('#toast');node.textContent=text;node.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('show'),2600);};
  function bindWorld(next){world=next;world.notify=notify;inventorySignature='';swap=-1;deadShown=false;aim=null;keys.clear();mouseDown=false;touchMine=false;}
  async function loadImages(){
    const manifest=await fetch(new URL('manifest.json',textureBase)).then(r=>{if(!r.ok)throw Error('贴图索引无法读取');return r.json();});
    await Promise.all(Object.keys(manifest).map(name=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{images[name]=image;resolve();};image.onerror=()=>reject(Error(`贴图加载失败：${name}`));image.src=new URL(`${name}.png?v=${manifest[name].slice(0,8)}`,textureBase).href;})));
    for(const [name,color] of [['oak_leaves','#6caa3c'],['grass_block_side_overlay','#79b64b'],['water_still','#3d82c7']]){const layer=document.createElement('canvas');layer.width=16;layer.height=16;const c=layer.getContext('2d');c.drawImage(images[name],0,0,16,16,0,0,16,16);c.globalCompositeOperation='source-atop';c.fillStyle=color;c.fillRect(0,0,16,16);c.globalCompositeOperation='multiply';c.drawImage(images[name],0,0,16,16,0,0,16,16);c.globalCompositeOperation='destination-in';c.drawImage(images[name],0,0,16,16,0,0,16,16);tinted[name]=layer;}
  }
  function resize(){viewW=innerWidth;viewH=innerHeight;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(viewW*dpr);canvas.height=Math.round(viewH*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);ctx.imageSmoothingEnabled=false;tile=viewW<650?26:viewW<1100?30:34;}
  addEventListener('resize',resize);resize();
  function sprite(name,x,y,w,h=w){const image=tinted[name]||images[name];if(image)ctx.drawImage(image,0,0,Math.min(16,image.width),Math.min(16,image.height),Math.round(x),Math.round(y),Math.ceil(w),Math.ceil(h));}
  function block(id,x,y,size=tile){const name=BLOCKS[id].id;sprite(name,x,y,size);if(id===1)sprite('grass_block_side_overlay',x,y,size);}
  function skin(mob,isPlayer=false){
    const image=images[isPlayer?'steve':mob.type];if(!image)return;
    const x=(mob.x-camera.x)*tile,y=(mob.y-camera.y)*tile,scale=tile/16;
    ctx.save();ctx.translate(Math.round(x+mob.w*tile/2),Math.round(y));if(mob.face<0)ctx.scale(-1,1);
    if(mob.hurt>0||isPlayer&&mob.invuln>.2&&Math.floor(mob.invuln*12)%2)ctx.globalAlpha=.55;
    const part=(sx,sy,sw,sh,dx,dy,dw,dh)=>ctx.drawImage(image,sx,sy,sw,sh,dx*scale,dy*scale,dw*scale,dh*scale);
    const stride=Math.sin(world.elapsed*10)*Math.min(1,Math.abs(mob.vx))*2;
    if(mob.type==='pig'&&!isPlayer){part(28,8,10,8,-7,3,12,8);part(8,8,8,8,3,0,8,8);part(4,20,4,6,-5,9+stride*.3,3,5);part(4,20,4,6,3,9-stride*.3,3,5);}
    else{part(4,20,4,12,-4,17,4,11+stride*.4);part(4,20,4,12,0,17,4,11-stride*.4);part(20,20,8,12,-4,7,8,11);part(44,20,4,12,2,8,4,11);part(8,8,8,8,-4,0,8,8);}
    ctx.restore();
  }
  function render(){
    const p=world.player;
    const desiredX=playing?p.x+p.w/2-viewW/tile*.5:49-viewW/tile*.52;
    const desiredY=playing?p.y+p.h/2-viewH/tile*.47:world.surface[49]-viewH/tile*.48;
    camera.x=clamp(desiredX,0,Math.max(0,W-viewW/tile));camera.y=clamp(desiredY,-15,H-viewH/tile);
    const phase=(world.time%DAY)/DAY,light=world.night()?.18:phase>.45?.18+.82*clamp((.54-phase)/.09,0,1):phase>.96?.18+.82*(phase-.96)/.04:1;
    const sky=ctx.createLinearGradient(0,0,0,viewH);sky.addColorStop(0,light>.5?'#6fa3b3':'#101b38');sky.addColorStop(1,light>.5?'#d2d5b4':'#3d4b61');ctx.fillStyle=sky;ctx.fillRect(0,0,viewW,viewH);
    ctx.fillStyle=world.night()?'#e9e9d8':'#fff1b1';const sunX=viewW*(.15+phase*.7),sunY=100+Math.sin(phase*Math.PI*2)*60;ctx.fillRect(sunX,sunY,34,34);
    // Distant landscape silhouettes are geometry, foreground uses original textures.
    for(let layer=0;layer<3;layer++){ctx.fillStyle=light>.5?['#88a6a0','#6a8982','#486f62'][layer]:['#223448','#203440','#1e3536'][layer];ctx.beginPath();ctx.moveTo(0,viewH);for(let sx=0;sx<=viewW+12;sx+=12){const xx=sx/tile+camera.x*(.12+layer*.13);const yy=(49-camera.y)*tile+Math.sin(xx*.1+layer*3)*(55+layer*15)-95+layer*35;ctx.lineTo(sx,yy);}ctx.lineTo(viewW,viewH);ctx.fill();}
    const minX=Math.max(0,Math.floor(camera.x)),maxX=Math.min(W-1,Math.ceil(camera.x+viewW/tile)),minY=Math.max(0,Math.floor(camera.y)),maxY=Math.min(H-1,Math.ceil(camera.y+viewH/tile));
    const torches=[];
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      const id=world.get(x,y),sx=(x-camera.x)*tile,sy=(y-camera.y)*tile;
      if(y>world.surface[x]+2){ctx.fillStyle='#302e29';ctx.fillRect(Math.floor(sx),Math.floor(sy),tile+1,tile+1);if(!id){ctx.globalAlpha=.12;sprite('stone',sx,sy,tile);ctx.globalAlpha=1;}}
      if(id){if(id===17)ctx.globalAlpha=.7;block(id,sx,sy);ctx.globalAlpha=1;if(id===16)torches.push({x,y});if(id===14&&world.furnaces[`${x},${y}`]?.input)sprite('furnace_front_on',sx,sy,tile);}
    }
    for(const d of world.drops)if(d.x>=minX-1&&d.x<=maxX+1){sprite(d.id,(d.x-camera.x)*tile,(d.y-camera.y)*tile+Math.sin(world.elapsed*3+d.x)*2,tile*.48);}
    for(const m of world.mobs)if(m.x>=minX-2&&m.x<=maxX+2)skin(m);
    if(playing)skin(p,true);
    // Tile darkness with a small player halo and stronger torch light.
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      let darkness=Math.max(1-light,clamp((y-world.surface[x]-1)*.1,0,.96));
      if(playing){const d=Math.hypot(x-p.x,y-p.y);if(d<4)darkness=Math.min(darkness,.3+d*.15);}
      for(const t of torches){const d=Math.hypot(t.x-x,t.y-y);if(d<7)darkness=Math.min(darkness,d*.12);}
      if(darkness>.02){ctx.fillStyle=`rgba(4,8,18,${darkness})`;ctx.fillRect(Math.floor((x-camera.x)*tile),Math.floor((y-camera.y)*tile),tile+1,tile+1);}
    }
    if(playing&&aim&&!paused()){
      const x=Math.floor(aim.x),y=Math.floor(aim.y),reachable=world.reachable(x,y),sx=Math.floor((x-camera.x)*tile),sy=Math.floor((y-camera.y)*tile);
      ctx.strokeStyle=reachable?'#f5f2d6':'#ed8178';ctx.lineWidth=1.5;ctx.strokeRect(sx+.75,sy+.75,tile-1.5,tile-1.5);
      if(world.mining){sprite(`destroy_stage_${Math.min(9,Math.floor(world.mining.progress*10))}`,(world.mining.x-camera.x)*tile,(world.mining.y-camera.y)*tile,tile);}
    }
    if(playing&&p.invuln>.8){ctx.fillStyle='#b01f1819';ctx.fillRect(0,0,viewW,viewH);}
  }
  function icon(id){const img=document.createElement('img');img.src=new URL(`${id}.png`,textureBase).href;img.alt='';return img;}
  function slotNode(slot,i,hotbar=false){const button=document.createElement('button');button.className='slot'+(hotbar&&i===world.selected?' selected':'')+(!hotbar&&swap===i?' swap':'');button.setAttribute('aria-label',`${hotbar?'快捷栏':'背包'} ${i+1}${slot?`，${ITEMS[slot.id].name} × ${slot.n}`:'，空'}`);button.title=slot?ITEMS[slot.id].name:'空格子';
    if(slot){button.append(icon(slot.id));const count=document.createElement('span');count.className='count';count.textContent=slot.n>1?slot.n:'';button.append(count);if(slot.dur){const bar=document.createElement('div');bar.className='durability';const fill=document.createElement('i');fill.style.width=`${slot.dur/ITEMS[slot.id].durability*100}%`;bar.append(fill);button.append(bar);}}
    if(hotbar){const number=document.createElement('span');number.className='number';number.textContent=i+1;button.append(number);button.onclick=()=>{world.selected=i;hud(true);};}
    else button.onclick=()=>{const s=world.inventory[i];$('#slot-description').textContent=s?`${ITEMS[s.id].name} × ${s.n}${s.dur?` · 耐久 ${s.dur} / ${ITEMS[s.id].durability}`:''}`:'空格子';if(swap<0)swap=i;else{[world.inventory[i],world.inventory[swap]]=[world.inventory[swap],world.inventory[i]];swap=-1;}inventory();hud(true);};return button;
  }
  function hud(force=false){
    const signature=JSON.stringify([world.inventory,world.selected,Math.ceil(world.player.health),Math.ceil(world.player.food)]);
    if(force||signature!==inventorySignature){inventorySignature=signature;$('#hotbar').replaceChildren(...world.inventory.slice(0,9).map((s,i)=>slotNode(s,i,true)));$('#item-name').textContent=ITEMS[world.held()?.id]?.name||'空手';
      for(const [selector,value,prefix,empty] of [['#health',world.player.health,'heart','container'],['#hunger',world.player.food,'food','empty']]){$(selector).setAttribute('aria-label',`${selector==='#health'?'生命':'饥饿'} ${Math.ceil(value)} / 20`);$(selector).replaceChildren(...Array.from({length:10},(_,i)=>icon(`${prefix}_${value>=i*2+2?'full':value>i*2?'half':empty}`)));}
    }
    $('#coordinates').textContent=`X ${Math.floor(world.player.x)} · Y ${H-Math.floor(world.player.y)} · ${world.mode==='creative'?'创造':'生存'}`;
    $('#clock').textContent=`第 ${Math.floor(world.time/DAY)+1} 天 · ${world.night()?'夜晚':'白昼'}`;
    $('#biome').textContent=world.player.y>60?'UNDERGROUND / 地底':'OVERWORLD / 主世界';
    const b=aim&&BLOCKS[world.get(aim.x,aim.y)];$('#target-label').textContent=b&&b.id!=='air'?`${b.name}${world.reachable(Math.floor(aim.x),Math.floor(aim.y))?'':' · 超出触及范围'}`:'';
  }
  function inventory(){
    $('#slots').replaceChildren(...world.inventory.map((s,i)=>slotNode(s,i)));
    const table=world.nearBlock(13),furnace=world.nearBlock(14);
    $('#station-status').textContent=world.mode==='creative'?'创造模式 · 点击右侧物品放入当前快捷栏':`${table?'✓ 附近有工作台':'手工合成 · 高级配方需要附近有工作台'}${furnace?' · ✓ 附近有熔炉':''}`;
    const recipes=$('#recipes');recipes.replaceChildren();$('#recipe-title').textContent=world.mode==='creative'?'创造物品栏':'配方书';
    if(world.mode==='creative')for(const [id,item] of Object.entries(ITEMS)){if(['bedrock','water_still'].includes(id))continue;const button=document.createElement('button');button.className='recipe';button.append(icon(id));const label=document.createElement('span');label.textContent=item.name;button.append(label);button.onclick=()=>{world.giveCreative(id);inventory();hud(true);};recipes.append(button);}
    else for(const recipe of RECIPES){const button=document.createElement('button');button.className='recipe';button.disabled=!world.canCraft(recipe);button.append(icon(recipe.out));const label=document.createElement('span'),small=document.createElement('small');label.textContent=`${ITEMS[recipe.out].name} × ${recipe.n}`;small.textContent=Object.entries(recipe.needs).map(([id,n])=>`${ITEMS[id].name} ${world.count(id)}/${n}`).join(' · ');label.append(small);button.append(label);if(recipe.station&&!table){const tag=document.createElement('b');tag.textContent='需工作台';button.append(tag);}button.onclick=()=>{world.craft(recipe);inventory();hud(true);};recipes.append(button);}
    const f=furnace&&world.furnaces[furnace.key];$('#furnace-status').textContent=!furnace?'靠近放置的熔炉后可以冶炼。':f?.input?`冶炼中 ${Math.floor(f.progress/10*100)}% · 关闭背包后继续运转`:f?.output?`${ITEMS[f.output].name} × ${f.count} 等待领取`:`就绪 · 剩余燃料 ${Math.floor(f?.fuel||0)} 秒`;
    document.querySelectorAll('[data-smelt]').forEach(b=>b.disabled=!furnace||!!f?.input||!world.count(b.dataset.smelt));$('#collect-smelt').disabled=!f?.output;
  }
  function save(){try{localStorage.setItem(SAVE,JSON.stringify(world.serialize()));$('#save-status').textContent=`已保存 · ${new Date().toLocaleTimeString('zh-CN')}。存档在当前浏览器中。`;return true;}catch{$('#save-status').textContent='保存失败：浏览器存储空间不足或被禁用，请导出存档。';notify('自动保存不可用，请在菜单导出存档');return false;}}
  function clearInput(){keys.clear();heldTouches.clear();mouseDown=false;touchMine=false;world.mining=null;}
  function openDialog(dialog){clearInput();if(!dialog.open)dialog.showModal();}
  function begin(next){dialogs.forEach(d=>d.close());bindWorld(next);playing=true;$('#start-screen').hidden=true;$('#hud').hidden=false;$('#touch-controls').hidden=!coarse;canvas.focus();hud(true);save();}
  $('#new-world').onsubmit=e=>{e.preventDefault();let hasSave=false;try{hasSave=!!localStorage.getItem(SAVE);}catch{}if(hasSave&&!confirm('创建新世界会替换当前浏览器存档。请先继续游戏并导出需要保留的世界。仍要创建吗？'))return;const seed=$('#seed').value.trim()||String(Date.now());begin(new World(seed,document.querySelector('[name=mode]:checked').value));notify('先挖一块原木，按 E 合成木板和工作台');};
  try{$('#continue').hidden=!localStorage.getItem(SAVE);}catch{}
  $('#continue').onclick=()=>{try{begin(World.restore(JSON.parse(localStorage.getItem(SAVE))));notify('欢迎回来，世界已恢复');}catch(e){notify(`无法读取存档：${e.message}，可导入备份`);}};
  document.querySelectorAll('[data-close]').forEach(button=>button.onclick=()=>button.closest('dialog').close());
  dialogs.forEach(d=>d.addEventListener('close',()=>{clearInput();canvas.focus();}));
  $('#inventory-button').onclick=()=>{if(playing){inventory();openDialog($('#inventory-dialog'));}};
  $('#pause-button').onclick=()=>{if(playing){save();openDialog($('#pause-dialog'));}};
  $('#help-button').onclick=()=>openDialog($('#help-dialog'));
  $('#resume').onclick=()=>$('#pause-dialog').close();$('#save-button').onclick=()=>{if(save())notify('世界已保存');};
  $('#return-title').onclick=()=>{save();$('#pause-dialog').close();playing=false;$('#start-screen').hidden=false;$('#hud').hidden=true;$('#touch-controls').hidden=true;$('#continue').hidden=false;};
  $('#export-button').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(world.serialize())],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`zfsn-world-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  ['#import-button','#start-import'].forEach(id=>$(id).onclick=()=>$('#import-file').click());
  $('#import-file').onchange=async e=>{const file=e.target.files[0];e.target.value='';if(!file)return;try{if(file.size>3_000_000)throw Error('存档文件超过 3 MB');const next=World.restore(JSON.parse(await file.text()));let hasSave=false;try{hasSave=!!localStorage.getItem(SAVE);}catch{}if(hasSave&&!confirm('导入会替换当前浏览器中的世界，是否继续？'))return;begin(next);notify('存档导入成功');}catch(error){notify(`导入失败：${error.message}`);}};
  $('#fullscreen-button').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('#game').requestFullscreen();}catch{notify('当前浏览器不支持全屏，请使用横屏游玩');}};
  $('#respawn').onclick=()=>{world.respawn();$('#death-dialog').close();deadShown=false;save();};
  $('#death-dialog').addEventListener('cancel',e=>e.preventDefault());
  document.querySelectorAll('[data-smelt]').forEach(b=>b.onclick=()=>{world.smelt(b.dataset.smelt);inventory();hud(true);});$('#collect-smelt').onclick=()=>{world.collectSmelt();inventory();hud(true);};
  function use(){if(paused())return;if(world.eat()){hud(true);return;}if(world.nearBlock(14)||world.nearBlock(13)){inventory();openDialog($('#inventory-dialog'));}else notify('手持食物可以进食；靠近工作台或熔炉可以交互');}
  addEventListener('keydown',e=>{
    if(e.target.matches('input,select,textarea'))return;
    if(e.key==='Escape'){if(playing&&!dialogs.some(d=>d.open)){e.preventDefault();save();openDialog($('#pause-dialog'));}return;}
    if(!playing)return;
    if(e.code==='KeyE'&&!e.repeat){e.preventDefault();if($('#inventory-dialog').open)$('#inventory-dialog').close();else if(!paused()){inventory();openDialog($('#inventory-dialog'));}return;}
    if(paused())return;
    if(['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.code))e.preventDefault();keys.add(e.code);
    if(/^Digit[1-9]$/.test(e.code)){world.selected=Number(e.code.slice(-1))-1;hud(true);}
    if(e.code==='KeyF'&&!e.repeat)use();
  });
  addEventListener('keyup',e=>keys.delete(e.code));addEventListener('blur',()=>{clearInput();if(playing&&!paused()){save();openDialog($('#pause-dialog'));}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing){clearInput();save();if(!paused())openDialog($('#pause-dialog'));}});
  addEventListener('pagehide',()=>{if(playing)save();});
  function aimEvent(e){const r=canvas.getBoundingClientRect();aim={x:(e.clientX-r.left)/tile+camera.x,y:(e.clientY-r.top)/tile+camera.y};}
  canvas.addEventListener('pointermove',e=>{if(!paused())aimEvent(e);});
  canvas.addEventListener('pointerdown',e=>{if(paused())return;aimEvent(e);canvas.focus();if(e.pointerType==='touch'){return;}if(e.button===0){mouseDown=true;canvas.setPointerCapture(e.pointerId);}if(e.button===2){world.place(aim.x,aim.y);hud(true);}});
  canvas.addEventListener('pointerup',()=>{mouseDown=false;world.mining=null;});canvas.addEventListener('pointercancel',clearInput);canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('wheel',e=>{if(!paused()){e.preventDefault();world.selected=(world.selected+Math.sign(e.deltaY)+9)%9;hud(true);}},{passive:false});
  document.querySelectorAll('[data-hold]').forEach(b=>{b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);heldTouches.set(e.pointerId,b.dataset.hold);};const release=e=>heldTouches.delete(e.pointerId);b.onpointerup=release;b.onpointercancel=release;b.onlostpointercapture=release;});
  $('#touch-place').onclick=()=>{if(aim&&!paused()){world.place(aim.x,aim.y);hud(true);}};$('#touch-use').onclick=use;
  function frame(now){
    const dt=Math.min((now-last)/1000,.1);last=now;
    if(!paused()){
      accumulator+=dt;const touch=new Set(heldTouches.values());const input={left:keys.has('KeyA')||keys.has('ArrowLeft')||touch.has('left'),right:keys.has('KeyD')||keys.has('ArrowRight')||touch.has('right'),jump:keys.has('Space')||keys.has('KeyW')||keys.has('ArrowUp')||touch.has('jump'),sprint:keys.has('ShiftLeft')};
      while(accumulator>=1/60){world.update(1/60,input);if(aim&&(mouseDown||touch.has('mine'))){if(!world.attack(aim.x,aim.y))world.mine(aim.x,aim.y,1/60);}else world.mining=null;accumulator-=1/60;}
      saveClock+=dt;if(saveClock>20){saveClock=0;save();}
      if(world.player.health<=0&&!deadShown){deadShown=true;$('#death-text').textContent=`${world.deathReason||'冒险途中'} · 掉落位置 X ${Math.floor(world.player.x)} / Y ${H-Math.floor(world.player.y)}。掉落物保留 5 分钟游戏时间。`;openDialog($('#death-dialog'));save();}
    }else accumulator=0;
    hudClock+=dt;if(hudClock>.12){hudClock=0;if(playing)hud();}
    render();requestAnimationFrame(frame);
  }
  try{await loadImages();}catch(e){notify(e.message);$('#new-world button').disabled=true;$('#continue').disabled=true;}
  bindWorld(world);requestAnimationFrame(frame);
}
