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
  {id:'white_wool',name:'白色羊毛',hard:.8},
];
export const ITEMS = Object.fromEntries(BLOCKS.slice(1).map((b,i)=>[b.id,{...b,block:i+1,stack:64}]));
Object.assign(ITEMS,{
  stick:{name:'木棍'},coal:{name:'煤炭'},raw_iron:{name:'粗铁'},iron_ingot:{name:'铁锭'},diamond:{name:'钻石'},
  apple:{name:'苹果',food:4},porkchop:{name:'生猪排',food:3},cooked_porkchop:{name:'熟猪排',food:8},
  beef:{name:'生牛肉',food:3},cooked_beef:{name:'牛排',food:8},chicken:{name:'生鸡肉',food:2},cooked_chicken:{name:'熟鸡肉',food:6},mutton:{name:'生羊肉',food:2},cooked_mutton:{name:'熟羊肉',food:6},feather:{name:'羽毛'},leather:{name:'皮革'},egg:{name:'鸡蛋'},bucket:{name:'桶',stack:16},water_bucket:{name:'水桶',stack:1},
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
  {out:'bucket',n:1,needs:{iron_ingot:3},station:true},
];
for(const [material,ingredient] of [['wooden','oak_planks'],['stone','cobblestone'],['iron','iron_ingot'],['diamond','diamond']]) {
  for(const [tool,amount,sticks] of [['pickaxe',3,2],['axe',3,2],['sword',2,1],['shovel',1,2]]) {
    if(material==='diamond'&&tool!=='pickaxe') continue;
    RECIPES.push({out:`${material}_${tool}`,n:1,needs:{[ingredient]:amount,stick:sticks},station:true});
  }
}
const material=b=>b?.id==='glass'?'glass':b?.id==='sand'?'sand':b?.id==='dirt'?'gravel':b?.tool==='axe'?'wood':b?.tool==='pickaxe'?'stone':'grass';
const SMELTS={raw_iron:'iron_ingot',sand:'glass',porkchop:'cooked_porkchop',beef:'cooked_beef',chicken:'cooked_chicken',mutton:'cooked_mutton'};
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
  // 湖泊：先按两岸岸线定一个统一水位，把盆地挖到水位以下再注水。
  // 以前是「直接铺一层矩形水面」，于是水会浮在山坡上，水面和地形对不上，
  // 这就是「水的生成乱七八糟」的来源。现在水位一定齐着两岸，水面即地表。
  for(let x=16;x<W-16;x+=32+Math.floor(rng()*22)){
    if(Math.abs(x-40)<18)continue;
    const radius=4+Math.floor(rng()*4), lx=x-radius, rx=x+radius;
    if(lx<2||rx>=W-2)continue;
    const level=Math.max(surface[lx],surface[rx]);      // 水面与岸同高，不会漫出去
    const depth=3+Math.floor(rng()*3);
    for(let xx=lx+1;xx<rx;xx++){
      const s0=surface[xx], t=1-((xx-x)/radius)**2, dig=Math.max(1,Math.round(depth*Math.sqrt(Math.max(0,t))));
      for(let y=level;y<s0;y++)blocks[y*W+xx]=0;          // 水位以上多余的土削平
      const bottom=level+dig, top=Math.min(s0,level);      // 水从天然地表或水位的最低处开始
      for(let y=top;y<bottom;y++)blocks[y*W+xx]=17;        // 水体
      for(let y=bottom;y<bottom+2&&y<H-3;y++)blocks[y*W+xx]=7; // 湖底沙子
      surface[xx]=top;                                     // 水面就是这一列的地表
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
    this.inventory=Array(36).fill(null);this.craftGrid=Array(4).fill(null);this.selected=0;this.time=120;this.elapsed=0;this.drops=[];this.mobs=[];this.furnaces={};this.mining=null;this.attackCooldown=0;this.exhaustion=0;this.regen=0;this.mobClock=0;this.gravityClock=0;this.deathReason='';this.revision=0;this.notify=()=>{};
    this.rng=random(hash(seed)^0xabcd);this.sound=()=>{};this.water=new Uint8Array(W*H);this.waterSources=new Set();this.fluidClock=0;this.stepClock=0;this.ambientClock=0;this.wasInWater=false;
    for(let i=0;i<this.blocks.length;i++)if(this.blocks[i]===17){this.water[i]=8;if(i<W||this.blocks[i-W]!==17)this.waterSources.add(i);}
    if(mode==='creative') ['grass_block_side','dirt','stone','oak_log','oak_planks','glass','torch','crafting_table_front','furnace_front'].forEach(id=>this.add(id,64));
    for(let i=0;i<16;i++){
      const type=['pig','cow','sheep','chicken'][i%4];let x=25+i*18;
      for(let retry=0;retry<12;retry++,x++){if(this.get(x,this.surface[x])===1&&this.get(x,this.surface[x]-1)===0){const mob=this.makeMob(type,x,0);mob.y=this.surface[x]-mob.h;if(!this.collides(mob)){this.mobs.push(mob);break;}}}
    }
  }
  get(x,y){x=Math.floor(x);y=Math.floor(y);return x<0||x>=W||y>=H?4:y<0?0:this.blocks[y*W+x];}
  set(x,y,id){if(x>=0&&x<W&&y>=0&&y<H){const i=y*W+x;this.blocks[i]=id;if(this.water){this.water[i]=id===17?8:0;if(id!==17)this.waterSources.delete(i);}this.revision++;}}
  setWaterSource(x,y,on=true){const i=y*W+x;if(x<0||x>=W||y<0||y>=H)return;this.set(x,y,on?17:0);if(on)this.waterSources.add(i);else this.waterSources.delete(i);}
  /* 水流：MC 式的 0–8 级流体。每 0.2 秒重算一次。
   * 从所有水源（8 级）出发做 BFS：能往下就往下给满级（落水柱），
   * 否则横向扩散并逐格衰减。横向扩散有前提 —— 目标格下方必须能托住水，
   * 否则水会横着长到悬崖外，变成悬空的水板。
   */
  stepWater(){
    const size=W*H, next=new Uint8Array(size), queue=[];
    for(const i of this.waterSources)if(this.blocks[i]===17){next[i]=8;queue.push(i);}
    for(let head=0;head<queue.length;head++){
      const i=queue[head],lv=next[i],x=i%W,y=(i/W)|0;
      if(y+1<H){
        const d=i+W;
        if((this.blocks[d]===0||this.blocks[d]===17)&&next[d]<8){next[d]=8;queue.push(d);}
      }
      if(lv>1){
        const lv2=lv-1;
        for(const dx of [-1,1]){
          const nx=x+dx;if(nx<0||nx>=W)continue;
          const n=i+dx;
          if(this.blocks[n]!==0&&this.blocks[n]!==17)continue;
          if(next[n]>=lv2)continue;
          // 目标格能不能「托住」水：下面要么是实体，要么已经有水。
          // 下面是空的且还没水，说明水会直接落下去，这一格就不该横向铺开。
          if(y+1<H){
            const below=n+W,bb=this.blocks[below];
            const holds=(bb!==0&&bb!==17)||bb===17||next[below]>0||this.water[below]>0;
            if(!holds)continue;
          }
          next[n]=lv2;queue.push(n);
        }
      }
    }
    let changed=false;
    for(let i=0;i<size;i++){
      const want=next[i];
      if(want){
        if(this.blocks[i]!==17||this.water[i]!==want){this.blocks[i]=17;this.water[i]=want;changed=true;}
      }else if(this.blocks[i]===17){
        this.blocks[i]=0;this.water[i]=0;changed=true;
      }
    }
    if(changed)this.revision++;
  }
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
    this.notify(`合成了 ${ITEMS[recipe.out].name} × ${recipe.n}`);this.sound('click',this.player.x,.4);return true;
  }
  giveCreative(id){if(this.mode!=='creative'||!ITEMS[id]||['bedrock','water_still'].includes(id))return;this.inventory[this.selected]={id,n:ITEMS[id].stack,...(ITEMS[id].durability?{dur:ITEMS[id].durability}:{})};}
  /* 2×2 合成网格：只认不需要工作台的配方，也就是「拿着就能做」的那几个。
     木板 / 木棍 / 工作台 / 火把 都在这条线上，正好是开局要用的。*/
  gridNeeds(){const map={};for(const s of this.craftGrid)if(s)map[s.id]=(map[s.id]||0)+1;return map;}
  findGridRecipe(){
    const need=this.gridNeeds(),keys=Object.keys(need);
    if(!keys.length)return null;
    return RECIPES.find(r=>!r.station&&Object.keys(r.needs).length===keys.length&&keys.every(id=>need[id]===r.needs[id]))||null;
  }
  takeGridRecipe(){
    const recipe=this.findGridRecipe();if(!recipe)return false;
    const before=structuredClone(this.inventory);
    if(this.add(recipe.out,recipe.n)){this.inventory=before;this.notify('背包已满，先腾出一个格子');return false;}
    this.craftGrid=Array(4).fill(null);this.sound('click',this.player.x,.4);
    this.notify(`合成了 ${ITEMS[recipe.out].name} × ${recipe.n}`);return true;
  }
  reachable(x,y){
    const p=this.player,dx=x+.5-(p.x+p.w/2),dy=y+.5-(p.y+.7),dist=Math.hypot(dx,dy);
    if(x<0||x>=W||y<0||y>=H||dist>5)return false;
    for(let step=.15;step<dist-.5;step+=.15){const xx=p.x+p.w/2+dx*step/dist,yy=p.y+.7+dy*step/dist;if(Math.floor(xx)===x&&Math.floor(yy)===y)break;if(this.solid(xx,yy))return false;}
    return true;
  }
  wear(){if(this.mode==='creative')return;const slot=this.held();if(slot?.dur&&--slot.dur<=0){this.notify(`${ITEMS[slot.id].name} 已损坏`);this.sound('break_tool',this.player.x,.6);this.inventory[this.selected]=null;}}
  drop(id,n,x,y,dur){if(n>0)this.drops.push({id,n,x,y,w:.3,h:.3,vx:(this.rng()-.5)*2,vy:-3,age:0,...(dur?{dur}:{})});}
  mine(x,y,dt){
    x=Math.floor(x);y=Math.floor(y);const block=BLOCKS[this.get(x,y)],tool=ITEMS[this.held()?.id];
    if(!block||this.get(x,y)===0||!this.reachable(x,y)||!Number.isFinite(block.hard)){this.mining=null;return;}
    const key=`${x},${y}`;if(this.mining?.key!==key)this.mining={key,x,y,progress:0};
    const correct=tool?.tool===block.tool,harvest=!block.tier||(correct&&tool.tier>=block.tier);
    const seconds=this.mode==='creative'?.12:Math.max(.08,block.hard*(harvest?1.5:5)/(correct?tool.speed:1));
    this.mining.progress+=dt/seconds;this.mining.soundClock=(this.mining.soundClock||0)+dt;
    if(this.mining.soundClock>.23){this.mining.soundClock=0;this.sound('dig_'+material(block),x,.22);}
    if(this.mining.progress<1)return;
    const id=this.get(x,y);this.set(x,y,0);this.wear();this.exhaustion+=.025;this.sound('dig_'+material(block),x,.6);
    if(this.mode!=='creative'&&harvest){
      if(id===6){if(this.rng()<.12)this.drop('apple',1,x+.35,y+.35);else if(this.rng()<.3)this.drop('stick',1,x+.35,y+.35);}
      else{const drop=block.drop===undefined?block.id:block.drop;if(drop)this.drop(drop,1,x+.35,y+.35);}
    }
    const furnace=this.furnaces[key];if(furnace){if(furnace.input)this.drop(furnace.input,1,x,y);if(furnace.output)this.drop(furnace.output,furnace.count,x,y);delete this.furnaces[key];}
    this.mining=null;
  }
  place(x,y){
    x=Math.floor(x);y=Math.floor(y);const slot=this.held(),item=ITEMS[slot?.id];
    if(slot?.id==='water_bucket'&&this.reachable(x,y)&&[0,17].includes(this.get(x,y))){this.setWaterSource(x,y);if(this.mode!=='creative')this.inventory[this.selected]={id:'bucket',n:1};this.sound('splash',x,.6);return true;}
    if(slot?.id==='bucket'&&this.reachable(x,y)&&this.waterSources.has(y*W+x)){this.setWaterSource(x,y,false);if(this.mode!=='creative'){if(slot.n===1)this.inventory[this.selected]={id:'water_bucket',n:1};else{slot.n--;if(this.add('water_bucket'))this.drop('water_bucket',1,this.player.x,this.player.y);}}this.sound('splash',x,.5);return true;}
    if(!item?.block||!this.reachable(x,y)||![0,17].includes(this.get(x,y)))return false;
    if(![[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([xx,yy])=>this.solid(xx,yy)))return false;
    const rect={x,y,w:1,h:1};if(item.solid!==false&&(overlap(rect,this.player)||this.mobs.some(m=>overlap(rect,m))))return false;
    this.set(x,y,item.block);this.sound('dig_'+material(item),x,.5);if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;return true;
  }
  eat(){const slot=this.held(),item=ITEMS[slot?.id];if(!item?.food||this.player.food>=20)return false;this.player.food=Math.min(20,this.player.food+item.food);if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;this.notify('补充了饱食度');this.sound('eat',this.player.x,.6);return true;}
  smelt(input){
    const station=this.nearBlock(14),out=SMELTS[input];
    if(!station||!out||!this.count(input))return false;
    const f=this.furnaces[station.key]??={fuel:0,input:null,output:null,count:0,progress:0};
    if(f.input||f.output&&f.output!==out||f.count>=64)return false;
    if(f.fuel<10){const fuel=['coal','oak_planks','oak_log','stick'].find(id=>this.count(id)>0);if(!fuel){this.notify('需要煤炭、木板、原木或木棍作为燃料');return false;}this.remove(fuel,1);f.fuel+=fuel==='coal'?80:fuel==='stick'?10:15;}
    this.remove(input,1);f.input=input;f.result=out;f.progress=0;return true;
  }
  collectSmelt(){const station=this.nearBlock(14),f=station&&this.furnaces[station.key];if(!f?.output)return;const rest=this.add(f.output,f.count);f.count=rest;if(!rest)f.output=null;}
  makeMob(type,x,y){const size={pig:[1.05,.95,10],cow:[1.2,1.4,10],sheep:[1.1,1.25,8],chicken:[.55,.8,4],zombie:[.65,1.8,20]}[type]||[.65,1.8,20];return{type,x,y,w:size[0],h:size[1],vx:0,vy:0,ground:false,health:size[2],clock:0,face:1,yaw:.65,hurt:0};}
  damage(amount,reason){const p=this.player;if(this.mode==='creative'||p.invuln>0||p.health<=0)return;p.health=Math.max(0,p.health-amount);p.invuln=1;this.sound('hurt',p.x,.6);if(!p.health){this.deathReason=reason;for(const s of this.inventory)if(s)this.drop(s.id,s.n,p.x,p.y,s.dur);this.inventory.fill(null);this.notify('你倒下了，物品掉落在原地');}}
  respawn(){const p=this.player;Object.assign(p,{...this.spawn,vx:0,vy:0,health:20,food:20,invuln:3});while(this.collides(p)&&p.y>1)p.y--;this.mining=null;}
  attack(x,y){if(this.attackCooldown>0)return false;const p=this.player;const mob=this.mobs.find(m=>x>=m.x-.4&&x<=m.x+m.w+.4&&y>=m.y-.3&&y<=m.y+m.h+.3&&Math.hypot(m.x-p.x,m.y-p.y)<3.5&&this.reachable(Math.floor(m.x),Math.floor(m.y)));if(!mob)return false;
    this.attackCooldown=.55;mob.health-=ITEMS[this.held()?.id]?.damage??1;mob.hurt=.25;this.sound(mob.type,mob.x,.65);mob.vx=(mob.x>p.x?1:-1)*6;mob.vy=-3;this.wear();if(mob.health<=0){const loot={pig:[['porkchop',2]],cow:[['beef',2],['leather',1]],sheep:[['mutton',2],['white_wool',1]],chicken:[['chicken',1],['feather',1]]}[mob.type]||[];for(const [id,n] of loot)this.drop(id,n,mob.x,mob.y);this.mobs.splice(this.mobs.indexOf(mob),1);}return true;
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
    this.move(p,dt,true);this.fluidClock+=dt;if(this.fluidClock>=.2){this.fluidClock-=.2;this.stepWater();}
    if(water&&!this.wasInWater)this.sound('splash',p.x,.5);this.wasInWater=water;
    this.stepClock+=Math.abs(p.vx)*dt;if(this.stepClock>1.7&&p.ground){this.stepClock=0;this.sound('step_'+material(BLOCKS[this.get(p.x+p.w/2,p.y+p.h+.1)]),p.x,.38);}
    this.ambientClock+=dt;if(this.ambientClock>5){this.ambientClock=0;const nearby=this.mobs.filter(m=>Math.abs(m.x-p.x)<14);if(nearby.length){const m=nearby[Math.floor(this.rng()*nearby.length)];this.sound(m.type,m.x,.32);}if(water)this.sound('water',p.x,.22);}
    if(this.mode!=='creative'){
      if(this.exhaustion>=1){p.food=Math.max(0,p.food-1);this.exhaustion-=1;}
      this.regen+=dt;if(this.regen>=4){this.regen=0;if(p.food>=18&&p.health<20){p.health++;this.exhaustion+=.6;}else if(p.food===0&&p.health>1)this.damage(1,'饥饿');}
    }
    for(const d of this.drops){d.age+=dt;this.move(d,dt);d.vx*=.97;if(d.age>.4&&Math.hypot(d.x-p.x,d.y-p.y-.7)<1.7){const before=d.n;d.n=this.add(d.id,d.n,d.dur);if(d.n<before)this.sound('pickup',p.x,.35);}}
    this.drops=this.drops.filter(d=>d.n>0&&d.age<300);
    for(const f of Object.values(this.furnaces))if(f.input&&f.fuel>0){f.progress+=dt;f.fuel=Math.max(0,f.fuel-dt);if(f.progress>=10){f.output=f.result;f.count++;f.input=null;f.progress=0;}}
    this.mobClock+=dt;
    if(this.mobClock>9){this.mobClock=0;if(this.night()&&this.mobs.filter(m=>m.type==='zombie').length<9){const x=Math.floor(clamp(p.x+(this.rng()<.5?-1:1)*(15+this.rng()*15),2,W-3)),y=this.surface[x]-2;if(!this.nearTorch(x,y,7))this.mobs.push(this.makeMob('zombie',x,y));}}
    for(const m of this.mobs){
      m.clock+=dt;m.hurt=Math.max(0,m.hurt-dt);
      // 转身动画：模型 yaw 朝朝向插值，而不是瞬间翻转贴图
      const wantYaw=m.face>0?0.95:-0.95;
      m.yaw=(m.yaw??wantYaw)+(wantYaw-(m.yaw??wantYaw))*Math.min(1,dt*9);
      if(!m.hurt){const chase=m.type==='zombie'&&Math.abs(m.x-p.x)<26;if(chase){m.vx=Math.sign(p.x-m.x)*1.45;m.face=Math.sign(m.vx)||1;}else if(m.clock>3){m.clock=0;m.vx=(this.rng()<.5?0:this.rng()<.5?-1:1)*.7;m.face=Math.sign(m.vx)||m.face;}}
      if(m.ground&&m.vx&&this.solid(m.x+(m.vx>0?m.w+.2:-.2),m.y+m.h-.2))m.vy=-8;
      if(this.get(m.x+m.w/2,m.y+m.h*.7)===17)m.vy=-2.3;
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
  serialize(){return{version:2,water:Array.from(this.water),waterSources:[...this.waterSources],seed:this.seed,mode:this.mode,blocks:Array.from(this.blocks),surface:Array.from(this.surface),spawn:this.spawn,player:this.player,inventory:this.inventory,selected:this.selected,time:this.time,elapsed:this.elapsed,drops:this.drops,mobs:this.mobs,furnaces:this.furnaces,exhaustion:this.exhaustion};}
  static restore(data){
    if(!data||![1,2].includes(data.version)||typeof data.seed!=='string'||data.seed.length>100||!['survival','creative'].includes(data.mode))throw Error('存档格式不受支持');
    if(!Array.isArray(data.blocks)||data.blocks.length!==W*H||data.blocks.some(v=>!Number.isInteger(v)||v<0||v>=BLOCKS.length))throw Error('世界方块数据损坏');
    if(!Array.isArray(data.inventory)||data.inventory.length!==36||data.inventory.some(s=>s&&(!ITEMS[s.id]||!Number.isInteger(s.n)||s.n<1||s.n>ITEMS[s.id].stack||ITEMS[s.id].durability&&(!Number.isInteger(s.dur)||s.dur<1||s.dur>ITEMS[s.id].durability))))throw Error('背包数据损坏');
    const p=data.player;if(!p||![p.x,p.y,p.health,p.food].every(Number.isFinite)||p.x<0||p.x>W-1||p.y< -20||p.y>H-2||p.health<0||p.health>20||p.food<0||p.food>20)throw Error('玩家数据损坏');
    if(!Number.isFinite(data.time)||data.time<0||!Number.isFinite(data.elapsed)||data.elapsed<0)throw Error('时间数据损坏');
    const w=new World(data.seed,data.mode);w.blocks=Uint8Array.from(data.blocks);w.player={...w.player,x:p.x,y:p.y,health:p.health,food:p.food};w.inventory=structuredClone(data.inventory);w.time=data.time;w.elapsed=data.elapsed;w.selected=Number.isInteger(data.selected)?clamp(data.selected,0,8):0;w.exhaustion=Number.isFinite(data.exhaustion)?clamp(data.exhaustion,0,1):0;
    w.water=new Uint8Array(W*H);w.waterSources=new Set();
    const validWater=Array.isArray(data.water)&&data.water.length===W*H&&data.water.every(v=>Number.isInteger(v)&&v>=0&&v<=8);
    for(let i=0;i<w.blocks.length;i++)if(w.blocks[i]===17){w.water[i]=validWater?Math.max(1,data.water[i]):8;if(!validWater&&(i<W||w.blocks[i-W]!==17))w.waterSources.add(i);}
    if(validWater&&Array.isArray(data.waterSources))for(const i of data.waterSources)if(Number.isInteger(i)&&i>=0&&i<W*H&&w.blocks[i]===17)w.waterSources.add(i);
    w.drops=[];w.mobs=[];
    if(Array.isArray(data.drops))for(const d of data.drops.slice(0,1000)){if(ITEMS[d.id]&&Number.isFinite(d.x)&&Number.isFinite(d.y)&&d.x>=0&&d.x<W&&d.y>=0&&d.y<H&&Number.isInteger(d.n)&&d.n>0&&d.n<=64){w.drop(d.id,d.n,d.x,d.y,ITEMS[d.id].durability?clamp(Math.floor(d.dur)||1,1,ITEMS[d.id].durability):undefined);}}
    if(Array.isArray(data.mobs))for(const m of data.mobs.slice(0,40)){if(['pig','cow','sheep','chicken','zombie'].includes(m.type)&&Number.isFinite(m.x)&&Number.isFinite(m.y)&&m.x>=0&&m.x<W&&m.y>=0&&m.y<H&&Number.isFinite(m.health)&&m.health>0){const mob=w.makeMob(m.type,m.x,m.y);mob.health=Math.min(mob.health,m.health);w.mobs.push(mob);}}
    if(data.furnaces&&typeof data.furnaces==='object')for(const [key,f] of Object.entries(data.furnaces).slice(0,W*H)){
      if(!/^\d{1,3},\d{1,3}$/.test(key))continue;const [x,y]=key.split(',').map(Number);if(w.get(x,y)!==14||!f)continue;
      const outputs=SMELTS;
      if(f.input&&!outputs[f.input]||f.output&&!Object.values(outputs).includes(f.output)||!Number.isFinite(f.fuel)||!Number.isFinite(f.progress)||!Number.isInteger(f.count))continue;
      w.furnaces[key]={fuel:clamp(f.fuel,0,80),progress:clamp(f.progress,0,10),count:clamp(f.count,0,64),input:f.input||null,result:outputs[f.input]||null,output:f.output||null};
    }
    while(w.collides(w.player)&&w.player.y>0)w.player.y--;
    return w;
  }
}

// ── 实体模型 ─────────────────────────────────────────────────────
// 每个肢体都是一个带贴图的立方体，UV 用 Java 版的 box-UV 网。
// 渲染时逐面做背面剔除 + 深度排序，再正投影（绕 Y 转朝向、绕 X 微俯）。
// 这才是「立体生物」：以前 render() 走的是扁平的 skin()，把皮肤图上的
// 几个矩形硬拼在一起，所以猪会断成两截，别的生物根本看不出是什么。
export function entityMesh(type,time=0,velocity=0){
  const boxes=[],walk=Math.sin(time*9)*Math.min(1,Math.abs(velocity)/2)*.65;
  const box=(texture,uv,center,size,angle=0,pivot=center)=>boxes.push({texture,uv,center,size,angle,pivot});
  if(type==='steve'||type==='zombie'){
    const zombie=type==='zombie',armSwing=zombie?-1.35:0;
    box(type,[0,0],[0,28,0],[8,8,8]);
    box(type,[16,16],[0,18,0],[8,12,4]);
    box(type,[0,16],[-2,6,0],[4,12,4],walk,[-2,12,0]);
    box(type,zombie?[0,16]:[16,48],[2,6,0],[4,12,4],-walk,[2,12,0]);
    // 僵尸两条手臂都平举，贴图都在 (40,16)。以前左臂取的是 (0,16)，
    // 那是腿的位置，于是僵尸身上会多出一截腿肉。
    box(type,[40,16],[-6,18,0],[4,12,4],zombie?armSwing:-walk,[-6,24,0]);
    box(type,zombie?[40,16]:[32,48],[6,18,0],[4,12,4],zombie?armSwing:walk,[6,24,0]);
    if(!zombie)box(type,[32,0],[0,28,0],[8.5,8.5,8.5]);   // 帽子/外套层
  }else if(type==='chicken'){
    box('chicken_mob',[0,9],[0,8,0],[6,8,6]);
    box('chicken_mob',[0,0],[0,13,4],[4,6,3]);
    box('chicken_mob',[14,0],[0,12,6.5],[4,2,2]);
    box('chicken_mob',[14,4],[0,10,6],[2,2,2]);
    for(const side of [-1,1]){
      box('chicken_mob',[26,0],[side*2,2.5,0],[3,5,3],walk*side,[side*2,5,0]);
      box('chicken_mob',[24,13],[side*3.5,8,0],[1,4,6]);
    }
  }else{
    const pig=type==='pig',cow=type==='cow',leg=pig?6:12;
    const body=pig?[10,16,8]:cow?[12,18,10]:[8,16,6],cy=leg+body[2]/2;
    box(type,pig||!cow?[28,8]:[18,4],[0,cy,0],body,Math.PI/2);
    box(type,[0,0],[0,cy+2,body[1]/2+2],pig?[8,8,8]:cow?[8,8,6]:[6,6,8]);
    if(pig)box(type,[16,16],[0,cy+1,body[1]/2+6.5],[4,3,1]);
    for(const side of [-1,1])for(const end of [-1,1]){
      const hip=[side*(body[0]/2-2),leg,end*(body[1]/2-3)];
      box(type,[0,16],[hip[0],leg/2,hip[2]],[4,leg,4],walk*side*end,hip);
    }
    // 羊毛层要包住身体；高度必须让 UV 网落在 64×32 之内，否则会读到图外
    if(type==='sheep')box('sheep_fur',[28,8],[0,cy,0],[10,16,8],Math.PI/2);
    if(cow)for(const side of [-1,1])box(type,[22,0],[side*5,cy+6,body[1]/2+1],[1,3,1]);
  }
  return boxes;
}

/** 模型在 y 方向的实际范围（用于把脚底对齐地面、按体型缩放）。 */
export function meshBounds(parts){
  let lo=Infinity,hi=-Infinity;
  for(const b of parts){
    const [cx,cy,cz]=b.center,[sx,sy,sz]=b.size,a=b.angle,[,py,pz]=b.pivot,ca=Math.cos(a),sa=Math.sin(a);
    for(const s of [-1,1])for(const t of [-1,1]){
      const yy=cy+s*sy/2-py,zz=cz+t*sz/2-pz;
      const y=py+yy*ca-zz*sa;
      if(y<lo)lo=y;if(y>hi)hi=y;
    }
  }
  return{lo,hi,height:Math.max(1,hi-lo)};
}

/** 把一只生物画到画布上。cx = 身体中线屏幕 x，groundY = 脚底屏幕 y。 */
export function drawEntity(ctx,images,mob,time,cx,groundY,heightPx,yaw){
  const parts=entityMesh(mob.type||'steve',time,mob.vx||0);
  if(!parts.length)return 0;
  const{lo,hi}=meshBounds(parts);
  const scale=heightPx/Math.max(1,hi-lo);
  const cy=Math.cos(yaw),sy=Math.sin(yaw),pitch=.16,cp=Math.cos(pitch),sp=Math.sin(pitch);
  const rot=(x,y,z)=>{const X=x*cy+z*sy,Z=-x*sy+z*cy;return{x:X,y:y*cp-Z*sp,z:Z*cp+y*sp};};
  const faces=[];
  for(const b of parts){
    const image=images[b.texture];if(!image)continue;
    const[bx,by,bz]=b.center,[dx,dy,dz]=b.size,[u,v]=b.uv,ca=Math.cos(b.angle),sa=Math.sin(b.angle),pv=b.pivot;
    const pt=(x,y,z)=>{
      const yy=y-pv[1],zz=z-pv[2];
      const r=rot(x,pv[1]+yy*ca-zz*sa,pv[2]+yy*sa+zz*ca);
      return{x:cx+r.x*scale,y:groundY-(r.y-lo)*scale,z:r.z};
    };
    const x0=bx-dx/2,x1=bx+dx/2,y0=by-dy/2,y1=by+dy/2,z0=bz-dz/2,z1=bz+dz/2;
    const quads=[
      [[[x0,y1,z1],[x1,y1,z1],[x1,y0,z1],[x0,y0,z1]],[u+dz,v+dz,dx,dy],[0,0,1],.05],
      [[[x1,y1,z0],[x0,y1,z0],[x0,y0,z0],[x1,y0,z0]],[u+dz+dx+dz,v+dz,dx,dy],[0,0,-1],.24],
      [[[x1,y1,z1],[x1,y1,z0],[x1,y0,z0],[x1,y0,z1]],[u+dz+dx,v+dz,dz,dy],[1,0,0],.17],
      [[[x0,y1,z0],[x0,y1,z1],[x0,y0,z1],[x0,y0,z0]],[u,v+dz,dz,dy],[-1,0,0],.17],
      [[[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]],[u+dz,v,dx,dz],[0,1,0],0],
      [[[x0,y0,z1],[x1,y0,z1],[x1,y0,z0],[x0,y0,z0]],[u+dz+dx,v,dx,dz],[0,-1,0],.3],
    ];
    for(const[verts,uv,n,shade]of quads){
      if(rot(n[0],n[1],n[2]).z<=1e-4)continue;          // 背面剔除
      const q=verts.map(vv=>pt(vv[0],vv[1],vv[2]));
      faces.push({q,uv,shade,image,depth:(q[0].z+q[1].z+q[2].z+q[3].z)/4});
    }
  }
  faces.sort((a,b)=>a.depth-b.depth);
  const hurt=(mob.hurt||0)>0;
  for(const f of faces){
    const[p0,p1,,p3]=f.q,img=f.image;
    let[u,v,w,h]=f.uv;
    // UV 越界就裁到图内：羊的羊毛层、僵尸的平举手臂都可能踩到边缘，
    // 不裁的话浏览器会画出一大块被拉伸的杂色。
    if(u<0){w+=u;u=0;}if(v<0){h+=v;v=0;}
    if(u+w>img.width)w=img.width-u;
    if(v+h>img.height)h=img.height-v;
    if(w<=0||h<=0)continue;
    ctx.save();
    ctx.transform((p1.x-p0.x)/w,(p1.y-p0.y)/w,(p3.x-p0.x)/h,(p3.y-p0.y)/h,p0.x,p0.y);
    ctx.drawImage(img,u,v,w,h,0,0,w,h);
    if(f.shade){ctx.fillStyle=`rgba(0,0,0,${f.shade})`;ctx.fillRect(0,0,w,h);}
    if(hurt){ctx.fillStyle='rgba(255,64,64,.42)';ctx.fillRect(0,0,w,h);}
    ctx.restore();
  }
  return faces.length;
}

// 取音效原始字节。
// ★ 为什么要重试：IDM（Internet Download Manager）这类下载器的浏览器接管会把
//   audio/ogg 的响应改写成「204 No Content + 空体 + Pragma/Cache-Control: no-cache」，
//   而 204 属于 2xx，r.ok 仍为 true —— 只看状态码会以为下载成功，decodeAudioData 随后报
//   "Unable to decode audio data"，表现为整局游戏静音。同一 URL 用 Node/curl 直连是
//   200 + 完整字节，所以问题只在浏览器侧。
//   带 Range 的请求不在接管名单里（媒体加载器就走这条路），能拿到真实字节。
async function fetchSoundBytes(url){
  const tries=[null,{Range:'bytes=0-'}];
  for(const headers of tries){
    try{
      const r=await fetch(url,headers?{headers}:undefined);
      if(!r.ok)continue;
      const buf=await r.arrayBuffer();
      if(buf.byteLength>0)return buf;
    }catch{}
  }
  throw Error('sound fetch failed');
}

class GameAudio {
  constructor(){this.context=null;this.buffers=new Map();this.last=new Map();this.manifest=null;this.volume=.65;this.played=0;this.failed=0;}
  async unlock(){try{if(!this.context){this.context=new AudioContext();this.gain=this.context.createGain();this.gain.gain.value=this.volume;this.gain.connect(this.context.destination);this.manifest=await fetch(new URL('sounds/manifest.json',import.meta.url)).then(r=>r.json());}await this.context.resume();}catch{this.failed++;}}
  async play(group,pan=0,volume=.5){
    if(!this.context||this.context.state!=='running'||!this.manifest?.[group]||this.volume===0)return;
    const now=this.context.currentTime;if(now-(this.last.get(group)??-10)<.075)return;this.last.set(group,now);
    const list=this.manifest[group],name=list[Math.floor(Math.random()*list.length)];
    try{
      if(!this.buffers.has(name)){
        // 失败的 promise 不能留在缓存里，否则这个音效永久哑掉
        const job=fetchSoundBytes(new URL('sounds/'+name,import.meta.url).href)
          .then(data=>this.context.decodeAudioData(data))
          .catch(error=>{this.buffers.delete(name);throw error;});
        this.buffers.set(name,job);
      }
      const buffer=await this.buffers.get(name);const source=this.context.createBufferSource(),gain=this.context.createGain(),stereo=this.context.createStereoPanner();
      source.buffer=buffer;source.playbackRate.value=.94+Math.random()*.12;gain.gain.value=volume;stereo.pan.value=clamp(pan,-1,1);source.connect(gain).connect(stereo).connect(this.gain);source.start();this.played++;
    }catch(error){this.failed++;this.lastError=String(error&&error.message||error);}
  }
  setVolume(value){this.volume=clamp(value,0,1);if(this.gain)this.gain.gain.value=this.volume;}
}

if(typeof document!=='undefined') boot();

async function boot(){
  const $=s=>document.querySelector(s);
  const canvas=$('#world'),ctx=canvas.getContext('2d',{alpha:false});
  const textureBase=new URL('textures/',import.meta.url),images={},tinted={};
  const audio=new GameAudio();

  let world=new World('ZFSN OVERWORLD'),playing=false,viewW=innerWidth,viewH=innerHeight,tile=32;
  let camera={x:30,y:30},camX=0,camY=0;
  let last=performance.now(),accumulator=0,hudClock=0,saveClock=0,titleClock=0;
  let toastTimer,itemNameTimer,aim=null,mouseDown=false,touchMine=false,invSignature='',deadShown=false,debugOn=false;
  let swap=null;                     // 正在搬运的槽位 {area,index}
  let audioReady=false;
  const keys=new Set(),heldTouches=new Map();
  const SAVE='zfsn.minecraft2d.v1',coarse=matchMedia('(pointer:coarse)').matches;
  const dialogs=[...document.querySelectorAll('dialog')];
  const paused=()=>!playing||dialogs.some(d=>d.open);

  const notify=text=>{
    const node=$('#toast');node.textContent=text;node.classList.add('show');
    clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.classList.remove('show'),2600);
  };

  // ── 音频：GameAudio 以前写了但从来没实例化过，world.sound 一直是空函数，
  //    所以整个游戏一点声音都没有。这里把它接上，等第一次用户交互再解锁。
  function ensureAudio(){
    if(audioReady)return;audioReady=true;
    audio.unlock().catch(()=>{});
  }
  addEventListener('pointerdown',ensureAudio,{capture:true});
  addEventListener('keydown',ensureAudio,{capture:true});

  function bindWorld(next){
    world=next;world.notify=notify;world.sound=(group,pan,vol)=>audio.play(group,pan,vol);
    invSignature='';swap=null;deadShown=false;aim=null;keys.clear();heldTouches.clear();mouseDown=false;touchMine=false;
  }

  // ── 贴图 ──────────────────────────────────────────────────────
  async function loadImages(){
    const manifest=await fetch(new URL('manifest.json',textureBase)).then(r=>{if(!r.ok)throw Error('贴图索引无法读取');return r.json();});
    await Promise.all(Object.keys(manifest).map(name=>new Promise((resolve,reject)=>{
      const image=new Image();
      image.onload=()=>{images[name]=image;resolve();};
      image.onerror=()=>reject(Error(`贴图加载失败：${name}`));
      image.src=new URL(`${name}.png?v=${manifest[name].slice(0,8)}`,textureBase).href;
    })));
    // 树叶和草方块侧面在原版里是灰度的，靠游戏内的生物群系染色。
    for(const [name,color] of [['oak_leaves','#6caa3c'],['grass_block_side_overlay','#79b64b']]){
      const layer=document.createElement('canvas');layer.width=16;layer.height=16;
      const c=layer.getContext('2d');
      c.drawImage(images[name],0,0,16,16,0,0,16,16);
      c.globalCompositeOperation='source-atop';c.fillStyle=color;c.fillRect(0,0,16,16);
      c.globalCompositeOperation='multiply';c.drawImage(images[name],0,0,16,16,0,0,16,16);
      c.globalCompositeOperation='destination-in';c.drawImage(images[name],0,0,16,16,0,0,16,16);
      tinted[name]=layer;
    }
    // ★ 水也一样：原版 water_still.png 本身几乎是灰白的，蓝色是渲染时乘上去的
    //   生物群系水色。不染色的话水看起来像玻璃。
    tinted.water_still=tintSheet(images.water_still,'#3f76e4');
  }
  function tintSheet(image,hex){
    const c=document.createElement('canvas');c.width=image.width;c.height=image.height;
    const g=c.getContext('2d');
    g.drawImage(image,0,0);
    g.globalCompositeOperation='multiply';g.fillStyle=hex;g.fillRect(0,0,c.width,c.height);
    g.globalCompositeOperation='destination-in';g.drawImage(image,0,0);
    return c;
  }

  function resize(){
    viewW=innerWidth;viewH=innerHeight;
    const dpr=Math.min(devicePixelRatio||1,2);
    canvas.width=Math.round(viewW*dpr);canvas.height=Math.round(viewH*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.imageSmoothingEnabled=false;
    tile=viewW<650?26:viewW<1100?30:34;
  }
  addEventListener('resize',resize);resize();

  /* 所有方块、明暗层、选中框都用同一套整数像素坐标（camX/camY 是唯一取整点），
     并且都画 tile+1 宽来盖住缩放造成的亚像素缝。以前贴图用 Math.round、
     阴影用 Math.floor，差 1px 就是那道细缝。 */
  function spriteAt(name,sx,sy,w,h,srcY=0){
    const image=tinted[name]||images[name];if(!image)return;
    const sw=Math.min(16,image.width),sh=Math.min(16,image.height);
    ctx.drawImage(image,0,srcY,sw,sh,sx,sy,w,h);
  }
  function drawBlock(id,sx,sy){
    spriteAt(BLOCKS[id].id,sx,sy,tile+1,tile+1);
    if(id===1)spriteAt('grass_block_side_overlay',sx,sy,tile+1,tile+1);
  }
  const WFRAMES=32;
  function drawWater(sx,sy,level,falling){
    const frame=Math.floor(world.elapsed*2)%WFRAMES;
    const full=tile+1, h=falling?full:Math.max(4,Math.round(full*Math.max(1,level)/8));
    const sheet=tinted.water_still||images.water_still;
    ctx.globalAlpha=.84;
    ctx.drawImage(sheet,0,frame*16,16,16,sx,sy+full-h,full,h);
    ctx.globalAlpha=1;
  }

  /* 明暗层：以前是逐格 fillRect(tile+1) 画半透明黑，相邻两格重叠 1px，
     那 1px 被叠了两次 → 整片地形上浮出一层网格状的细缝。
     现在把每格的暗度写进一张「一格一像素」的小图，再用最近邻放大贴上去：
     一次绘制，天然没有重叠，也没有缝。 */
  const shadeCanvas=document.createElement('canvas');
  const shadeCtx=shadeCanvas.getContext('2d');
  let shadeData=null;
  function drawShade(minX,minY,maxX,maxY,torches,p,light){
    const cols=maxX-minX+1,rows=maxY-minY+1;
    if(cols<=0||rows<=0)return;
    if(shadeCanvas.width!==cols||shadeCanvas.height!==rows){
      shadeCanvas.width=cols;shadeCanvas.height=rows;shadeData=null;
    }
    if(!shadeData)shadeData=shadeCtx.createImageData(cols,rows);
    const data=shadeData.data;
    let any=false;
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      let darkness=Math.max(1-light,clamp((y-world.surface[x]-1)*.1,0,.96));
      if(playing){const d=Math.hypot(x-p.x,y-p.y);if(d<4)darkness=Math.min(darkness,.3+d*.15);}
      for(const t of torches){const d=Math.hypot(t.x-x,t.y-y);if(d<7)darkness=Math.min(darkness,d*.12);}
      const o=((y-minY)*cols+(x-minX))*4;
      const a=Math.round(clamp(darkness,0,1)*255);
      data[o]=4;data[o+1]=8;data[o+2]=18;data[o+3]=a;
      if(a>4)any=true;
    }
    if(!any)return;
    shadeCtx.putImageData(shadeData,0,0);
    ctx.save();ctx.imageSmoothingEnabled=false;
    ctx.drawImage(shadeCanvas,minX*tile-camX,minY*tile-camY,cols*tile,rows*tile);
    ctx.restore();
  }

  // ── 画面 ──────────────────────────────────────────────────────
  function render(){
    const p=world.player;
    const desiredX=playing?p.x+p.w/2-viewW/tile*.5:49-viewW/tile*.52+Math.sin(titleClock*.16)*3.2;
    const desiredY=playing?p.y+p.h/2-viewH/tile*.47:world.surface[49]-viewH/tile*.48;
    camera.x=clamp(desiredX,0,Math.max(0,W-viewW/tile));
    camera.y=clamp(desiredY,-15,H-viewH/tile);
    camX=Math.round(camera.x*tile);camY=Math.round(camera.y*tile);

    const phase=(world.time%DAY)/DAY;
    const light=world.night()?.18:phase>.45?.18+.82*clamp((.54-phase)/.09,0,1):phase>.96?.18+.82*(phase-.96)/.04:1;
    const sky=ctx.createLinearGradient(0,0,0,viewH);
    sky.addColorStop(0,light>.5?'#6fa3b3':'#101b38');
    sky.addColorStop(1,light>.5?'#d2d5b4':'#3d4b61');
    ctx.fillStyle=sky;ctx.fillRect(0,0,viewW,viewH);

    ctx.fillStyle=world.night()?'#e9e9d8':'#fff1b1';
    ctx.fillRect(viewW*(.15+phase*.7),100+Math.sin(phase*Math.PI*2)*60,34,34);

    for(let layer=0;layer<3;layer++){
      ctx.fillStyle=light>.5?['#88a6a0','#6a8982','#486f62'][layer]:['#223448','#203440','#1e3536'][layer];
      ctx.beginPath();ctx.moveTo(0,viewH);
      for(let sx=0;sx<=viewW+12;sx+=12){
        const xx=sx/tile+camera.x*(.12+layer*.13);
        const yy=(49-camera.y)*tile+Math.sin(xx*.1+layer*3)*(55+layer*15)-95+layer*35;
        ctx.lineTo(sx,yy);
      }
      ctx.lineTo(viewW,viewH);ctx.fill();
    }

    const minX=Math.max(0,Math.floor(camera.x)),maxX=Math.min(W-1,Math.ceil(camera.x+viewW/tile));
    const minY=Math.max(0,Math.floor(camera.y)),maxY=Math.min(H-1,Math.ceil(camera.y+viewH/tile));
    const torches=[],waterCells=[];
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      const sx=x*tile-camX,sy=y*tile-camY,id=world.get(x,y);
      if(y>world.surface[x]+2){ctx.fillStyle='#302e29';ctx.fillRect(sx,sy,tile+1,tile+1);}
      if(id===17){waterCells.push([sx,sy,x,y]);continue;}
      if(!id)continue;
      drawBlock(id,sx,sy);
      if(id===16)torches.push({x,y});
      if(id===14&&world.furnaces[`${x},${y}`]?.input)spriteAt('furnace_front_on',sx,sy,tile+1,tile+1);
    }
    for(const[sx,sy,x,y]of waterCells)drawWater(sx,sy,world.water[y*W+x]||8,world.get(x,y-1)===17);

    for(const d of world.drops)if(d.x>=minX-1&&d.x<=maxX+1)
      spriteAt(d.id,Math.round(d.x*tile-camX),Math.round(d.y*tile-camY+Math.sin(world.elapsed*3+d.x)*2),Math.round(tile*.46),Math.round(tile*.46));

    for(const m of world.mobs)if(m.x>=minX-2&&m.x<=maxX+2){
      const mc=Math.round((m.x+m.w/2)*tile-camX),gy=Math.round((m.y+m.h)*tile-camY);
      drawEntity(ctx,images,m,world.elapsed,mc,gy,m.h*tile,m.yaw??0.95);
    }
    if(playing){
      if(p.invuln>.2&&Math.floor(p.invuln*12)%2)ctx.globalAlpha=.45;
      const pc=Math.round((p.x+p.w/2)*tile-camX),py=Math.round((p.y+p.h)*tile-camY);
      drawEntity(ctx,images,{...p,type:'steve'},world.elapsed,pc,py,p.h*tile,p.face>0?0.95:-0.95);
      ctx.globalAlpha=1;
    }

    // 明暗：一次整片贴图，和方块共用 camX/camY，没有重叠也就没有缝
    drawShade(minX,minY,maxX,maxY,torches,p,light);

    if(playing&&aim){
      const x=Math.floor(aim.x),y=Math.floor(aim.y);
      ctx.strokeStyle=world.reachable(x,y)?'rgba(0,0,0,.65)':'rgba(190,60,60,.65)';
      ctx.lineWidth=2;
      ctx.strokeRect(x*tile-camX+1,y*tile-camY+1,tile-1,tile-1);
      if(world.mining){
        spriteAt(`destroy_stage_${Math.min(9,Math.floor(world.mining.progress*10))}`,world.mining.x*tile-camX,world.mining.y*tile-camY,tile+1,tile+1);
      }
    }
    if(playing&&p.invuln>.8){ctx.fillStyle='rgba(176,31,24,.14)';ctx.fillRect(0,0,viewW,viewH);}
  }

  // ── 槽位 ──────────────────────────────────────────────────────
  function iconImg(id){const img=document.createElement('img');img.src=new URL(`${id}.png`,textureBase).href;img.alt='';img.draggable=false;return img;}
  function slotNode(stack,area,index,hotbar){
    const b=document.createElement('button');
    b.type='button';b.className='slot';
    const label=stack?`${ITEMS[stack.id].name} × ${stack.n}`:'空';
    b.setAttribute('aria-label',label);
    if(hotbar){b.style.position='absolute';b.style.left=(6+40*index)+'px';b.style.top='6px';}
    if(swap&&swap.area===area&&swap.index===index)b.style.background='rgba(255,255,255,.35)';
    if(stack){
      b.append(iconImg(stack.id));
      if(stack.n>1){const c=document.createElement('span');c.className='count';c.textContent=stack.n;b.append(c);}
      if(stack.dur){const bar=document.createElement('div');bar.className='dur';const fill=document.createElement('i');fill.style.width=`${stack.dur/ITEMS[stack.id].durability*100}%`;bar.append(fill);b.append(bar);}
      b.title=ITEMS[stack.id].name;
    }
    b.onclick=hotbar?()=>{world.selected=index;showItemName();hud(true);}:()=>clickSlot(area,index);
    return b;
  }
  const stackAt=(area,index)=>area==='inv'?world.inventory[index]:world.craftGrid[index];
  const setStack=(area,index,stack)=>{if(area==='inv')world.inventory[index]=stack;else world.craftGrid[index]=stack;};
  function clickSlot(area,index){
    if(swap&&swap.area===area&&swap.index===index){swap=null;inventory();return;}
    const here=stackAt(area,index);
    if(!swap){
      if(here){swap={area,index};$('#slot-description').textContent=`已拿起 ${ITEMS[here.id].name} × ${here.n}，再点一个格子放下`;}
      inventory();return;
    }
    const from=stackAt(swap.area,swap.index),dest=stackAt(area,index);
    if(from&&dest&&from.id===dest.id&&ITEMS[from.id].stack>1){
      const room=ITEMS[from.id].stack-dest.n;
      if(room>0){const move=Math.min(room,from.n);dest.n+=move;from.n-=move;}
      setStack(swap.area,swap.index,from.n>0?from:null);
    }else{
      setStack(swap.area,swap.index,dest);
      setStack(area,index,from);
    }
    swap=null;$('#slot-description').textContent='点两个格子可以交换物品。';
    inventory();hud(true);
  }

  function showItemName(){
    const node=$('#item-name');
    node.textContent=ITEMS[world.held()?.id]?.name||'';
    node.classList.add('show');
    clearTimeout(itemNameTimer);
    itemNameTimer=setTimeout(()=>node.classList.remove('show'),1800);
  }

  // ── HUD ───────────────────────────────────────────────────────
  function hud(force=false){
    const p=world.player;
    const signature=JSON.stringify([world.inventory,world.selected,Math.ceil(p.health),Math.ceil(p.food)]);
    if(force||signature!==invSignature){
      invSignature=signature;
      const bar=$('#hotbar');
      bar.replaceChildren(...world.inventory.slice(0,9).map((s,i)=>slotNode(s,'inv',i,true)));
      let sel=bar.querySelector('#hotbar-selection');
      if(!sel){sel=document.createElement('div');sel.id='hotbar-selection';bar.append(sel);}
      sel.style.left=`${40*world.selected-2}px`;
      for(const[selector,value,prefix,empty]of[['#health',p.health,'heart','container'],['#hunger',p.food,'food','empty']]){
        const node=$(selector);
        node.replaceChildren(...Array.from({length:10},(_,i)=>{
          const full=value>=i*2+2,half=!full&&value>i*2;
          const el=document.createElement('i');
          el.style.backgroundImage=`url(${new URL(`${prefix}_${full?'full':half?'half':empty}.png`,textureBase).href})`;
          return el;
        }));
      }
    }
    if(debugOn){
      const b=aim&&BLOCKS[world.get(Math.floor(aim.x),Math.floor(aim.y))];
      $('#debug').textContent=
        `方块世界 2D  60Hz\n`+
        `X ${p.x.toFixed(2)}  Y ${(H-p.y).toFixed(2)}\n`+
        `时间 ${world.night()?'夜晚':'白昼'}  第 ${Math.floor(world.time/DAY)+1} 天\n`+
        `模式 ${world.mode==='creative'?'创造':'生存'}\n`+
        `目标 ${b&&b.id!=='air'?b.name:'—'}\n`+
        `生物 ${world.mobs.length}  掉落物 ${world.drops.length}`;
    }
  }

  // 背包左上角那块在原版里是玩家模型预览，贴图本身是空的，
  // 不画东西就是一个黑洞。这里用同一套 3D 模型把玩家画进去。
  const invPlayer=$('#inv-player'),invCtx=invPlayer.getContext('2d');
  function drawInvPlayer(){
    const dpr=Math.min(devicePixelRatio||1,2),w=96*dpr,h=128*dpr;
    if(invPlayer.width!==w||invPlayer.height!==h){invPlayer.width=w;invPlayer.height=h;}
    invCtx.setTransform(dpr,0,0,dpr,0,0);
    invCtx.imageSmoothingEnabled=false;
    invCtx.clearRect(0,0,96,128);
    drawEntity(invCtx,images,{...world.player,type:'steve'},world.elapsed,48,126,118,.62);
  }

  // ── 背包 / 配方书 ─────────────────────────────────────────────
  function inventory(){
    $('#slots').replaceChildren(...Array.from({length:27},(_,i)=>slotNode(world.inventory[9+i],'inv',9+i,false)));
    $('#inv-hotbar').replaceChildren(...Array.from({length:9},(_,i)=>slotNode(world.inventory[i],'inv',i,false)));
    $('#craft-grid').replaceChildren(...Array.from({length:4},(_,i)=>slotNode(world.craftGrid[i],'grid',i,false)));
    const result=world.findGridRecipe();
    const out=$('#craft-result');
    out.replaceChildren();
    if(result){
      const b=document.createElement('button');
      b.type='button';b.className='slot';b.style.position='relative';
      b.append(iconImg(result.out));
      const c=document.createElement('span');c.className='count';c.textContent=result.n;b.append(c);
      b.title=`合成 ${ITEMS[result.out].name}`;
      b.onclick=()=>{if(world.takeGridRecipe()){inventory();hud(true);}};
      out.append(b);
    }
    const table=world.nearBlock(13),furnace=world.nearBlock(14);
    $('#station-status').textContent=world.mode==='creative'?'创造模式：点物品直接放进快捷栏'
      :`${table?'✓ 附近有工作台':'附近没有工作台'}${furnace?' · ✓ 附近有熔炉':''}`;
    const list=$('#recipes');list.replaceChildren();
    $('#recipe-title').textContent=world.mode==='creative'?'创造物品栏':'配方书';
    if(world.mode==='creative'){
      for(const[id,item]of Object.entries(ITEMS)){
        if(['bedrock','water_still'].includes(id))continue;
        list.append(recipeRow(id,item.name,'点击放入快捷栏',false,()=>{world.giveCreative(id);inventory();hud(true);}));
      }
    }else{
      for(const recipe of RECIPES){
        const need=Object.entries(recipe.needs).map(([id,n])=>`${ITEMS[id].name} ${world.count(id)}/${n}`).join(' · ');
        list.append(recipeRow(recipe.out,`${ITEMS[recipe.out].name} × ${recipe.n}`,need,!world.canCraft(recipe),()=>{world.craft(recipe);inventory();hud(true);}));
      }
    }
  }
  function recipeRow(icon,title,sub,disabled,onclick){
    const b=document.createElement('button');
    b.type='button';b.className='recipe';b.disabled=disabled;b.onclick=onclick;
    b.append(iconImg(icon));
    const span=document.createElement('span');
    span.textContent=title;
    const small=document.createElement('small');small.textContent=sub;span.append(small);
    b.append(span);
    return b;
  }

  // ── 熔炉 ──────────────────────────────────────────────────────
  function furnaceUI(){
    const near=world.nearBlock(14),f=near&&world.furnaces[near.key];
    const put=(sel,id)=>{
      const node=$(sel);node.replaceChildren();
      if(id)node.append(iconImg(id));
    };
    put('#furnace-input',f?.input||null);
    put('#furnace-fuel',f?.fuel>0?'coal':null);
    put('#furnace-output',f?.output||null);
    $('#furnace-flame').classList.toggle('on',!!(f&&f.fuel>0));
    $('#furnace-progress').style.width=f?`${clamp(f.progress/10,0,1)*100}%`:'0%';
    $('#furnace-status').textContent=!near?'靠近放置的熔炉才能使用。'
      :f?.output?`${ITEMS[f.output].name} × ${f.count}，点「取出产物」`
      :f?.input?`正在冶炼… 燃料还剩 ${Math.floor(f.fuel)} 秒`
      :`就绪 · 放入矿石和燃料`;
    document.querySelectorAll('[data-smelt]').forEach(b=>{b.disabled=!near||!!f?.input||!world.count(b.dataset.smelt);});
    $('#collect-smelt').disabled=!f?.output;
  }
  function openFurnace(){
    if(!world.nearBlock(14)){notify('附近没有熔炉，先合成并放置一个');return;}
    furnaceUI();openDialog($('#furnace-dialog'));
  }

  // ── 存档 ──────────────────────────────────────────────────────
  function save(){
    try{
      localStorage.setItem(SAVE,JSON.stringify(world.serialize()));
      $('#save-status').textContent=`已保存 · ${new Date().toLocaleTimeString('zh-CN')}`;
      return true;
    }catch{
      $('#save-status').textContent='保存失败：浏览器存储空间不足或被禁用，请导出存档。';
      notify('自动保存不可用，请导出存档');return false;
    }
  }

  function clearInput(){keys.clear();heldTouches.clear();mouseDown=false;touchMine=false;world.mining=null;}
  function openDialog(dialog){clearInput();if(!dialog.open)dialog.showModal();}
  function begin(next){
    dialogs.forEach(d=>d.close());
    bindWorld(next);playing=true;
    $('#start-screen').hidden=true;$('#hud').hidden=false;
    $('#touch-controls').hidden=!coarse;
    canvas.focus();hud(true);showItemName();save();
  }

  // ── 标题画面 ──────────────────────────────────────────────────
  const playBtn=$('#play'),continueBtn=$('#continue'),newForm=$('#new-world');
  playBtn.onclick=()=>{playBtn.hidden=true;continueBtn.hidden=true;$('.menu-buttons').hidden=true;newForm.hidden=false;newForm.querySelector('#seed').focus();};
  $('#cancel-new').onclick=()=>{newForm.hidden=true;$('.menu-buttons').hidden=false;playBtn.hidden=false;refreshContinue();};
  try{refreshContinue();}catch{}
  function refreshContinue(){
    let has=false;try{has=!!localStorage.getItem(SAVE);}catch{}
    continueBtn.hidden=!has;
    $('#title-status').textContent=has?'检测到本地存档':'非官方同人作品';
  }
  newForm.onsubmit=e=>{
    e.preventDefault();
    let hasSave=false;try{hasSave=!!localStorage.getItem(SAVE);}catch{}
    if(hasSave&&!confirm('创建新世界会替换当前存档，确定吗？'))return;
    const seed=$('#seed').value.trim()||String(Date.now());
    begin(new World(seed,document.querySelector('[name=mode]:checked').value));
    notify(coarse?'先挖一块原木，点「背包」合成木板和工作台':'先挖一块原木，按 E 合成木板和工作台');
  };
  continueBtn.onclick=()=>{
    try{begin(World.restore(JSON.parse(localStorage.getItem(SAVE))));notify('欢迎回来，世界已恢复');}
    catch(e){notify(`无法读取存档：${e.message}`);}
  };

  // ── 菜单按钮 ──────────────────────────────────────────────────
  document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
  dialogs.forEach(d=>d.addEventListener('close',()=>{clearInput();canvas.focus();}));
  $('#help-button').onclick=()=>openDialog($('#help-dialog'));
  $('#close-inventory').onclick=()=>$('#inventory-dialog').close();
  $('#close-furnace').onclick=()=>$('#furnace-dialog').close();
  $('#resume').onclick=()=>$('#pause-dialog').close();
  $('#save-button').onclick=()=>{if(save())notify('世界已保存');};
  $('#return-title').onclick=()=>{
    save();$('#pause-dialog').close();playing=false;
    $('#start-screen').hidden=false;$('#hud').hidden=true;$('#touch-controls').hidden=true;
    newForm.hidden=true;$('.menu-buttons').hidden=false;playBtn.hidden=false;refreshContinue();
  };
  $('#export-button').onclick=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(world.serialize())],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`zfsn-world-${Date.now()}.json`;a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  $('#import-button').onclick=()=>$('#import-file').click();
  $('#import-file').onchange=async e=>{
    const file=e.target.files[0];e.target.value='';if(!file)return;
    try{
      if(file.size>3_000_000)throw Error('存档文件超过 3 MB');
      const next=World.restore(JSON.parse(await file.text()));
      let hasSave=false;try{hasSave=!!localStorage.getItem(SAVE);}catch{}
      if(hasSave&&!confirm('导入会替换当前世界，是否继续？'))return;
      begin(next);notify('存档导入成功');
    }catch(error){notify(`导入失败：${error.message}`);}
  };
  $('#fullscreen-button').onclick=async()=>{
    try{if(document.fullscreenElement)await document.exitFullscreen();else await $('#game').requestFullscreen();}
    catch{notify('当前浏览器不支持全屏');}
  };
  $('#respawn').onclick=()=>{world.respawn();$('#death-dialog').close();deadShown=false;save();};
  $('#death-dialog').addEventListener('cancel',e=>e.preventDefault());
  document.querySelectorAll('[data-smelt]').forEach(b=>b.onclick=()=>{world.smelt(b.dataset.smelt);furnaceUI();hud(true);});
  $('#collect-smelt').onclick=()=>{world.collectSmelt();furnaceUI();hud(true);};

  function use(){
    if(paused())return;
    if(world.eat()){hud(true);return;}
    if(world.nearBlock(14)){openFurnace();return;}
    if(world.nearBlock(13)){inventory();openDialog($('#inventory-dialog'));return;}
    notify('手持食物可以进食；靠近工作台或熔炉可以交互');
  }

  // ── 键盘 ──────────────────────────────────────────────────────
  addEventListener('keydown',e=>{
    if(e.target.matches('input,select,textarea'))return;
    if(e.code==='F3'){e.preventDefault();debugOn=!debugOn;$('#debug').hidden=!debugOn;if(debugOn)hud(true);return;}
    if(e.key==='Escape'){
      if(playing&&!dialogs.some(d=>d.open)){e.preventDefault();save();openDialog($('#pause-dialog'));}
      return;
    }
    if(!playing)return;
    if(e.code==='KeyE'&&!e.repeat){
      e.preventDefault();
      if($('#inventory-dialog').open)$('#inventory-dialog').close();
      else if(!paused()){inventory();openDialog($('#inventory-dialog'));}
      return;
    }
    if(paused())return;
    if(['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.code))e.preventDefault();
    keys.add(e.code);
    if(/^Digit[1-9]$/.test(e.code)){world.selected=Number(e.code.slice(-1))-1;hud(true);showItemName();}
    if(e.code==='KeyF'&&!e.repeat)use();
  });
  addEventListener('keyup',e=>keys.delete(e.code));
  addEventListener('blur',()=>{clearInput();if(playing&&!paused()){save();openDialog($('#pause-dialog'));}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&playing){clearInput();save();if(!paused())openDialog($('#pause-dialog'));}});
  addEventListener('pagehide',()=>{if(playing)save();});

  // ── 鼠标 / 触摸 ───────────────────────────────────────────────
  function aimEvent(e){
    const r=canvas.getBoundingClientRect();
    aim={x:(e.clientX-r.left)/tile+camX/tile,y:(e.clientY-r.top)/tile+camY/tile};
  }
  canvas.addEventListener('pointermove',e=>{if(!paused())aimEvent(e);});
  canvas.addEventListener('pointerdown',e=>{
    if(paused())return;
    aimEvent(e);canvas.focus();
    if(e.pointerType==='touch'&&e.button!==2)return;
    if(e.button===2){
      const bx=Math.floor(aim.x),by=Math.floor(aim.y),id=world.get(bx,by);
      if(id===14){openFurnace();return;}
      if(id===13){inventory();openDialog($('#inventory-dialog'));return;}
      world.place(aim.x,aim.y);hud(true);return;
    }
    mouseDown=true;canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup',()=>{mouseDown=false;world.mining=null;});
  canvas.addEventListener('pointercancel',clearInput);
  canvas.addEventListener('contextmenu',e=>e.preventDefault());
  canvas.addEventListener('wheel',e=>{
    if(!paused()){e.preventDefault();world.selected=(world.selected+Math.sign(e.deltaY)+9)%9;hud(true);showItemName();}
  },{passive:false});

  document.querySelectorAll('[data-hold]').forEach(b=>{
    b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);heldTouches.set(e.pointerId,b.dataset.hold);};
    const release=e=>heldTouches.delete(e.pointerId);
    b.onpointerup=release;b.onpointercancel=release;b.onlostpointercapture=release;
  });
  $('#touch-place').onclick=()=>{if(aim&&!paused()){world.place(aim.x,aim.y);hud(true);}};
  $('#touch-use').onclick=use;
  $('#touch-inventory').onclick=()=>{if(playing){inventory();openDialog($('#inventory-dialog'));}};

  // ── 主循环 ────────────────────────────────────────────────────
  function frame(now){
    const dt=Math.min((now-last)/1000,.1);last=now;titleClock+=dt;
    if(!paused()){
      accumulator+=dt;
      const touch=new Set(heldTouches.values());
      const input={
        left:keys.has('KeyA')||keys.has('ArrowLeft')||touch.has('left'),
        right:keys.has('KeyD')||keys.has('ArrowRight')||touch.has('right'),
        jump:keys.has('Space')||keys.has('KeyW')||keys.has('ArrowUp')||touch.has('jump'),
        sprint:keys.has('ShiftLeft'),
      };
      while(accumulator>=1/60){
        world.update(1/60,input);
        if(aim&&(mouseDown||touch.has('mine'))){
          if(!world.attack(aim.x,aim.y))world.mine(aim.x,aim.y,1/60);
        }else world.mining=null;
        accumulator-=1/60;
      }
      saveClock+=dt;if(saveClock>20){saveClock=0;save();}
      if(world.player.health<=0&&!deadShown){
        deadShown=true;
        $('#death-text').textContent=`${world.deathReason||'冒险途中'} · 掉落位置 X ${Math.floor(world.player.x)} / Y ${H-Math.floor(world.player.y)}`;
        openDialog($('#death-dialog'));save();
      }
    }else accumulator=0;
    hudClock+=dt;
    if(hudClock>.12){
      hudClock=0;
      if(playing)hud();
      if($('#furnace-dialog').open)furnaceUI();   // 只刷熔炉进度，背包按操作刷新
      if($('#inventory-dialog').open)drawInvPlayer();
    }
    render();
    requestAnimationFrame(frame);
  }

  try{await loadImages();}
  catch(e){notify(e.message);playBtn.disabled=true;continueBtn.disabled=true;}
  bindWorld(world);
  // 给验证脚本留一个只读探针（不影响游戏本身）
  window.zfsnMC={get world(){return world;},audio,images,drawEntity,entityMesh,get playing(){return playing;}};
  requestAnimationFrame(frame);
}
