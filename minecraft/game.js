import {CATALOG} from './catalog.js?v=dcbd02b6';
/* Standalone 2D sandbox. Distances are blocks; simulation uses fixed 60 Hz steps.
 * No server calls, accounts, game-client code, or third-party runtime required. */
// Simulation time is in SECONDS, not frames: update(1 / 60) advances 1/60 s.
// A full day therefore takes 72,000 simulation steps (20 minutes of active play).
// 世界尺寸。384×144 → 640×160 → 4096×256（32 屏宽、8 屏高，104 万格）。
// 改这两个数字必须同步改存档版本（World.restore 会做尺寸迁移）。
export const W = 4096, H = 256, DAY = 20 * 60;
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
  {id:'stone_bricks',name:'石砖',hard:1.5,tool:'pickaxe',tier:1},
  {id:'sandstone',name:'砂岩',hard:.8,tool:'pickaxe',tier:1},
  {id:'iron_block',name:'铁块',hard:5,tool:'pickaxe',tier:2},
  {id:'diamond_block',name:'钻石块',hard:5,tool:'pickaxe',tier:3},
  {id:'coal_block',name:'煤炭块',hard:5,tool:'pickaxe',tier:1},
  {id:'smooth_stone',name:'平滑石头',hard:2,tool:'pickaxe',tier:1},
];
// Preserve all existing block IDs. New catalogue blocks are append-only in sorted ID order.
for(const entry of CATALOG)if(entry.cube&&!BLOCKS.some(b=>b.id===entry.id)){
  const wood=/planks|log|wood|stem|hyphae/.test(entry.id);
  BLOCKS.push({id:entry.id,name:entry.name,hard:wood?2:1.5,tool:wood?'axe':'pickaxe',tier:wood?0:1});
}
export const ITEMS = Object.fromEntries(BLOCKS.slice(1).map((b,i)=>[b.id,{...b,block:i+1,stack:64}]));
Object.assign(ITEMS,{
  charcoal:{name:'木炭'},stick:{name:'木棍'},coal:{name:'煤炭'},raw_iron:{name:'粗铁'},iron_ingot:{name:'铁锭'},diamond:{name:'钻石'},
  apple:{name:'苹果',food:4},porkchop:{name:'生猪排',food:3},cooked_porkchop:{name:'熟猪排',food:8},
  beef:{name:'生牛肉',food:3},cooked_beef:{name:'牛排',food:8},chicken:{name:'生鸡肉',food:2},cooked_chicken:{name:'熟鸡肉',food:6},mutton:{name:'生羊肉',food:2},cooked_mutton:{name:'熟羊肉',food:6},feather:{name:'羽毛'},leather:{name:'皮革'},egg:{name:'鸡蛋'},bucket:{name:'桶',stack:16},water_bucket:{name:'水桶',stack:1},
});
for (const [material,tier,speed,durability] of [['wooden',1,2,59],['stone',2,4,131],['iron',3,6,250],['diamond',4,8,1561]]) {
  for (const [tool,name] of [['pickaxe','镐'],['axe','斧'],['sword','剑'],['shovel','锹']]) {
    ITEMS[`${material}_${tool}`]={name:({wooden:'木',stone:'石',iron:'铁',diamond:'钻石'})[material]+name,tool,tier,speed,durability,stack:1,damage:tool==='sword'?tier+3:tool==='axe'?tier+2:2};
  }
}
for(const entry of CATALOG){
  if(!ITEMS[entry.id])ITEMS[entry.id]={name:entry.name,catalogOnly:true};
  ITEMS[entry.id].category=entry.category;ITEMS[entry.id].cubeIcon=entry.cube;
  if(/sword|bow|helmet|chestplate|leggings|boots|shield|trident/.test(entry.id))ITEMS[entry.id].category='combat';
  if(/crafting_table|furnace|chest$|barrel|anvil|enchanting_table|loom|smithing_table|cartography_table|stonecutter/.test(entry.id))ITEMS[entry.id].category='functional';
}
for(const [mat,tier,speed,durability]of [['golden',1,12,32],['netherite',5,9,2031]])for(const tool of ['pickaxe','axe','sword','shovel']){
  const item=ITEMS[`${mat}_${tool}`];if(item)Object.assign(item,{catalogOnly:false,tool,tier,speed,durability,stack:1,damage:tool==='sword'?tier+3:tool==='axe'?tier+2:2});
}
for(const [id,food]of Object.entries({bread:5,carrot:3,potato:1,baked_potato:5,beetroot:1,cookie:2,melon_slice:2,sweet_berries:2,glow_berries:2,dried_kelp:1,cod:2,cooked_cod:5,salmon:2,cooked_salmon:6,rabbit:3,cooked_rabbit:5,golden_carrot:6}))if(ITEMS[id])Object.assign(ITEMS[id],{food,catalogOnly:false});
for(const mob of ['pig','cow','sheep','chicken','zombie'])if(ITEMS[mob+'_spawn_egg'])Object.assign(ITEMS[mob+'_spawn_egg'],{mob,catalogOnly:false});
/* ── 原版堆叠上限 ──────────────────────────────────────────────
   绝大多数物品是 64，这里只判定「原版就是 1」的那几类。
   ★ 上面 47~59 行虽然给工具写死了 stack:1，但两轮循环只覆盖
     pickaxe/axe/sword/shovel × 6 种材质，且完全没有盔甲 ——
     剩下的 hoe、盔甲、弓弩、盾、鞘翅等 catalogOnly 物品会落到默认 64，
     创造栏拿一次就是 64 个钻石胸甲，背包里也能叠成一摞。
   ★ 判定按 id 模式而不是 category：catalog 的分类有污染
     （bowl 被分成 equipment，waxed_* 铜块也在 equipment 里），
     按 category 判定会把这堆可堆叠方块一起误伤成 1。 */
const STACK_ONE=new Set([
  'bow','crossbow','trident','shield','elytra','fishing_rod',
  'carrot_on_a_stick','warped_fungus_on_a_stick','shears','flint_and_steel',
  'saddle','totem_of_undying','cake','writable_book',
]);
function defaultStack(id){
  if(STACK_ONE.has(id))return 1;
  if(/_(sword|axe|pickaxe|shovel|hoe)$/.test(id))return 1;                 // 工具与武器
  if(/_(helmet|chestplate|leggings|boots|horse_armor)$/.test(id))return 1; // 盔甲（含马铠、海龟壳）
  if(/^(potion|splash_potion|lingering_potion)$/.test(id))return 1;        // 药水原版也叠不了
  if(/^music_disc_/.test(id))return 1;
  if(/(^|_)(boat|minecart|bed|shulker_box|stew|soup)$/.test(id))return 1;  // 船/矿车/床/潜影盒/汤
  if(/_bucket$/.test(id))return 1;                                        // 空桶 16 已在上面单独设过
  return 64;
}
for (const [id,item] of Object.entries(ITEMS)) {item.id=id;item.stack??=defaultStack(id);}
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
    RECIPES.push({out:`${material}_${tool}`,n:1,needs:{[ingredient]:amount,stick:sticks},station:true});
  }
}
RECIPES.push(
  {out:'torch',n:4,needs:{charcoal:1,stick:1}},
  {out:'stone_bricks',n:4,needs:{stone:4}},
  {out:'sandstone',n:1,needs:{sand:4}},
);
for(const [block,item] of [['iron_block','iron_ingot'],['diamond_block','diamond'],['coal_block','coal']]){
  RECIPES.push({out:block,n:1,needs:{[item]:9},station:true},{out:item,n:9,needs:{[block]:1}});
}
for(const wood of ['spruce','birch','jungle','acacia','dark_oak','mangrove','cherry']){
  if(ITEMS[wood+'_log']&&ITEMS[wood+'_planks'])RECIPES.push({out:wood+'_planks',n:4,needs:{[wood+'_log']:1}},{out:'stick',n:4,needs:{[wood+'_planks']:2}});
}
const FUELS={coal:80,charcoal:80,coal_block:800,oak_planks:15,oak_log:15,stick:5};
const material=b=>b?.id==='glass'?'glass':b?.id==='sand'?'sand':b?.id==='dirt'?'gravel':b?.tool==='axe'?'wood':b?.tool==='pickaxe'?'stone':'grass';
const SMELTS={potato:'baked_potato',cod:'cooked_cod',salmon:'cooked_salmon',rabbit:'cooked_rabbit',oak_log:'charcoal',cobblestone:'stone',stone:'smooth_stone',raw_iron:'iron_ingot',sand:'glass',porkchop:'cooked_porkchop',beef:'cooked_beef',chicken:'cooked_chicken',mutton:'cooked_mutton'};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
function hash(s){let n=2166136261;for(const c of String(s)) n=Math.imul(n^c.charCodeAt(0),16777619);return n>>>0;}
function random(seed){let a=seed>>>0;return()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296;};}
/* 存档压缩：blocks / natural / water 都是 W*H = 1048576 长的数组（4096×256）。
   直接 JSON 出来每个数字至少 2 个字符（逗号+数字）→ 一份 2MB 以上，
   自动保存每 20 秒现算一次会明显卡顿。RLE（值,重复次数）之后地形类数据
   通常只剩几 KB。 */
function rle(arr){
  const out=[];let run=arr[0]|0,count=1;
  for(let i=1;i<arr.length;i++){
    const v=arr[i]|0;
    if(v===run&&count<65535)count++;
    else{out.push(run,count);run=v;count=1;}
  }
  out.push(run,count);
  return out;
}
function unrle(flat,length,Type=Uint16Array){
  if(!Array.isArray(flat)||flat.length%2)throw Error('存档方块压缩数据损坏');
  const out=new Type(length);let o=0;
  for(let i=0;i<flat.length;i+=2){
    const v=flat[i],n=flat[i+1];
    if(!Number.isInteger(v)||v<0||v>65535||!Number.isInteger(n)||n<1||o+n>length)throw Error('存档方块压缩数据损坏');
    out.fill(v,o,o+n);o+=n;
  }
  if(o!==length)throw Error('存档方块压缩长度损坏');
  return out;
}
export function generate(seed){
  const rng=random(hash(seed)), blocks=new Uint16Array(W*H), surface=new Int16Array(W);
  // natural[i]=1 表示这一格是「世界自带的树木」。玩家可以穿过去，也挖得动；
  // 一旦玩家动过（挖掉/自己放回去），这一位就清 0，方块恢复成实心。
  const natural=new Uint8Array(W*H);
  let elevation=52;
  for(let x=0;x<W;x++){
    elevation=clamp(elevation+(rng()-.5)*1.6,44,60);
    const top=Math.round(elevation+Math.sin(x*.045)*4+Math.sin(x*.12)*1.5);surface[x]=top;
    for(let y=top;y<H;y++) blocks[y*W+x]=y>H-3?4:y===top?1:y<top+4?2:3;
  }
  // Random walk caves: veins and caverns remain reproducible for the same seed.
  for(let cave=0;cave<Math.round(W*.2);cave++){
    let x=rng()*W,y=68+rng()*(H-76),angle=rng()*Math.PI*2;
    for(let step=0;step<35+rng()*80;step++){
      angle+=(rng()-.5)*.8;x+=Math.cos(angle)*1.6;y=clamp(y+Math.sin(angle),65,H-5);
      const radius=1+rng()*2;
      for(let yy=Math.floor(y-radius);yy<=y+radius;yy++)for(let xx=Math.floor(x-radius);xx<=x+radius;xx++){
        if(xx>0&&xx<W-1&&yy>surface[xx]+5&&yy<H-3&&(xx-x)**2+(yy-y)**2<radius*radius) blocks[yy*W+xx]=0;
      }
    }
  }
  for(let y=62;y<H-3;y++)for(let x=1;x<W-1;x++){
    if(blocks[y*W+x]!==3)continue;
    const r=rng();blocks[y*W+x]=y>106&&r<.013?10:y>68&&r<.038?9:r<.075?8:3;
  }
  // 湖泊：先按两岸岸线定一个统一水位，把盆地挖到水位以下再注水。
  // 以前是「直接铺一层矩形水面」，于是水会浮在山坡上，水面和地形对不上，
  // 这就是「水的生成乱七八糟」的来源。现在水位一定齐着两岸，水面即地表。
  for(let x=24;x<W-24;x+=52+Math.floor(rng()*30)){
    if(Math.abs(x-40)<18)continue;
    const radius=4+Math.floor(rng()*4), lx=x-radius, rx=x+radius;
    if(lx<2||rx>=W-2)continue;
    const level=Math.max(surface[lx],surface[rx]);      // 水面与岸同高，不会漫出去
    const depth=3+Math.floor(rng()*3);
    for(let xx=lx+1;xx<rx;xx++){
      const s0=surface[xx], t=1-((x-xx)/radius)**2, dig=Math.max(1,Math.round(depth*Math.sqrt(Math.max(0,t))));
      for(let y=level;y<s0;y++)blocks[y*W+xx]=0;          // 水位以上多余的土削平
      const bottom=level+dig, top=Math.min(s0,level);      // 水从天然地表或水位的最低处开始
      for(let y=top;y<bottom;y++)blocks[y*W+xx]=17;        // 水体
      for(let y=bottom;y<bottom+2&&y<H-3;y++)blocks[y*W+xx]=7; // 湖底沙子
      surface[xx]=top;                                     // 水面就是这一列的地表
    }
  }
  // 橡树。树叶用菱形，树干竖直 —— 和原版小橡树一个形状。
  for(let x=8;x<W-8;x+=9+Math.floor(rng()*11)){
    const y=surface[x];
    if(blocks[y*W+x]!==1)continue;                     // 只长在草地上（湖面/沙地不长）
    if(Math.abs(x-40)<4)continue;                       // 出生点留空
    const height=4+Math.floor(rng()*3);
    for(let yy=y-height-2;yy<y-height+2;yy++)for(let xx=x-2;xx<=x+2;xx++){
      if(Math.abs(xx-x)+Math.abs(yy-(y-height))<4&&blocks[yy*W+xx]===0){blocks[yy*W+xx]=6;natural[yy*W+xx]=1;}
    }
    for(let yy=y-height;yy<y;yy++){blocks[yy*W+x]=5;natural[yy*W+x]=1;}
  }
  return{blocks,surface,natural};
}

export class World {
  constructor(seed='ZFSN',mode='survival'){
    this.seed=String(seed);this.mode=mode;const terrain=generate(this.seed);this.blocks=terrain.blocks;this.surface=terrain.surface;
    this.natural=terrain.natural;
    this.spawn={x:40,y:this.surface[40]-2};this.player={...this.spawn,w:.65,h:1.8,vx:0,vy:0,ground:false,health:20,food:20,invuln:0,face:1,crouch:false,swing:0,swingDur:.26};
    this.inventory=Array(36).fill(null);this.craftGrid=Array(4).fill(null);
    // 工作台 3×3 与背包 2×2 是两个独立容器（原版就是这样，互不串味）
    this.tableGrid=Array(9).fill(null);
    this.selected=0;this.time=120;this.elapsed=0;this.drops=[];this.mobs=[];this.furnaces={};this.mining=null;this.attackCooldown=0;this.exhaustion=0;this.regen=0;this.mobClock=0;this.gravityClock=0;this.deathReason='';this.revision=0;this.notify=()=>{};
    // 天气：clear / rain / thunder。rain 会压暗天空并下粒子，thunder 额外打闪电。
    this.weather='clear';this.weatherTimer=0;this.lightning=0;this.rainDrops=[];
    this.rng=random(hash(seed)^0xabcd);this.sound=()=>{};this.water=new Uint8Array(W*H);this.waterSources=new Set();this.fluidClock=0;this.stepClock=0;this.ambientClock=0;this.wasInWater=false;
    for(let i=0;i<this.blocks.length;i++)if(this.blocks[i]===17){this.water[i]=8;if(i<W||this.blocks[i-W]!==17)this.waterSources.add(i);}
    if(mode==='creative') ['grass_block_side','dirt','stone','oak_log','oak_planks','glass','torch','crafting_table_front','furnace_front'].forEach(id=>this.add(id,64));
    // 生物铺满整张地图，而不是只挤在出生点附近
    for(let i=0;i<128;i++){
      const type=['pig','cow','sheep','chicken'][i%4];let x=18+i*Math.floor((W-40)/128);
      for(let retry=0;retry<14;retry++,x++){if(x<2||x>=W-2)break;if(this.get(x,this.surface[x])===1&&this.get(x,this.surface[x]-1)===0){const mob=this.makeMob(type,x,0);mob.y=this.surface[x]-mob.h;if(!this.collides(mob)){this.mobs.push(mob);break;}}}
    }
    /* ★ 让水先流到稳态再开玩。
       湖泊的水面格全是「8 级水源」，而 stepWater 的 BFS 会从水源横向扩散，
       所以刚生成的世界每跑一帧水面都会再宽一点 —— 表现为「进游戏时湖在长大」，
       而且不同时刻读到的水量都不一样（测试里同一份种子 337 / 434 两种结果）。
       先在这里空跑几轮，把稳态固化进初始地形。 */
    for(let i=0;i<6;i++)this.stepWater();
  }
  get(x,y){x=Math.floor(x);y=Math.floor(y);return x<0||x>=W||y>=H?4:y<0?0:this.blocks[y*W+x];}
  set(x,y,id){if(x>=0&&x<W&&y>=0&&y<H){const i=y*W+x;this.blocks[i]=id;if(this.natural)this.natural[i]=0;if(this.water){this.water[i]=id===17?8:0;if(id!==17)this.waterSources.delete(i);}this.revision++;}}
  setWaterSource(x,y,on=true){const i=y*W+x;if(x<0||x>=W||y<0||y>=H)return;this.set(x,y,on?17:0);if(on)this.waterSources.add(i);else this.waterSources.delete(i);}
  /* 水流：MC 式的 0–8 级流体。每 0.2 秒重算一次。
   * 从所有水源（8 级）出发做 BFS：能往下就往下给满级（落水柱），
   * 否则横向扩散并逐格衰减。横向扩散有前提 —— 目标格下方必须能托住水，
   * 否则水会横着长到悬崖外，变成悬空的水板。
   */
  stepWater(){
    if(this.fluidStableRevision===this.revision)return;
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
    if(changed)this.revision++;else this.fluidStableRevision=this.revision;
  }
  /* 自然生成的树木（原木 id=5 / 树叶 id=6）不参与碰撞 —— 玩家能直接走过去，
     这就是用户要的「自然生成的树可以自由穿过」。玩家自己放下的原木/树叶
     走路时会立刻把 natural 清 0，所以它们是正常实体方块。 */
  isThru(x,y){
    const fx=Math.floor(x),fy=Math.floor(y);
    if(fx<0||fx>=W||fy<0||fy>=H)return false;
    const id=this.blocks[fy*W+fx];
    return (id===5||id===6)&&this.natural[fy*W+fx]===1;
  }
  solid(x,y){const id=this.get(x,y);return id!==0&&BLOCKS[id].solid!==false&&!this.isThru(x,y);}
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
  // 只按「材料种类 + 数量」匹配，不看摆放形状（简化，但 2×2 能出的配方
  // 在 3×3 里也成立，3×3 专属配方在 2×2 里数量不够自然匹配不上）。
  // station 参数：station:true 的配方（镐子/熔炉/桶）只在工作台 3×3 里成立。
  recipeIn(grid,station=false){
    const map={};for(const s of grid)if(s)map[s.id]=(map[s.id]||0)+1;
    const keys=Object.keys(map);
    if(!keys.length)return null;
    return RECIPES.find(r=>(station||!r.station)&&Object.keys(r.needs).length===keys.length&&keys.every(id=>map[id]===r.needs[id]))||null;
  }
  findGridRecipe(){return this.recipeIn(this.craftGrid,false);}
  findTableRecipe(){return this.recipeIn(this.tableGrid,true);}
  takeRecipe(grid,station=false){
    const recipe=this.recipeIn(grid,station);if(!recipe)return false;
    const before=structuredClone(this.inventory);
    if(this.add(recipe.out,recipe.n)){this.inventory=before;this.notify('背包已满，先腾出一个格子');return false;}
    // 按配方数量扣减，不是整格清空：合成格允许同类叠加，一次全清会吞掉多余材料。
    for(const[id,need]of Object.entries(recipe.needs)){
      let left=need;
      for(let i=0;i<grid.length&&left>0;i++){
        const s=grid[i];
        if(s?.id!==id)continue;
        const use=Math.min(left,s.n);
        s.n-=use;left-=use;
        if(s.n<=0)grid[i]=null;
      }
    }this.sound('click',this.player.x,.4);
    this.notify(`合成了 ${ITEMS[recipe.out].name} × ${recipe.n}`);return true;
  }
  takeGridRecipe(){return this.takeRecipe(this.craftGrid,false);}
  takeTableRecipe(){return this.takeRecipe(this.tableGrid,true);}
  reachable(x,y){
    const p=this.player,dx=x+.5-(p.x+p.w/2),dy=y+.5-(p.y+.7),dist=Math.hypot(dx,dy);
    if(x<0||x>=W||y<0||y>=H||dist>5)return false;
    for(let step=.15;step<dist-.5;step+=.15){const xx=p.x+p.w/2+dx*step/dist,yy=p.y+.7+dy*step/dist;if(Math.floor(xx)===x&&Math.floor(yy)===y)break;if(this.solid(xx,yy))return false;}
    return true;
  }
  wear(){if(this.mode==='creative')return;const slot=this.held();if(slot?.dur&&--slot.dur<=0){this.notify(`${ITEMS[slot.id].name} 已损坏`);this.sound('break_tool',this.player.x,.6);this.inventory[this.selected]=null;}}
  /** 触发一次挥臂（放置/攻击/吃东西/挖穿最后一下）。
   *  ★ 已经在挥的时候不重置：连点鼠标会把动作永久卡在第一帧，
   *    表现成「手一直在最高点抖」。让它自然播完更接近原版。 */
  swing(dur=.26){const p=this.player;if(p.swing>0)return;p.swing=p.swingDur=dur;}
  drop(id,n,x,y,dur){if(n>0)this.drops.push({id,n,x,y,w:.3,h:.3,vx:(this.rng()-.5)*2,vy:-3,age:0,...(dur?{dur}:{})});}
  mine(x,y,dt){
    x=Math.floor(x);y=Math.floor(y);const block=BLOCKS[this.get(x,y)],tool=ITEMS[this.held()?.id];
    if(!block||this.get(x,y)===0||!this.reachable(x,y)||!Number.isFinite(block.hard)){this.mining=null;return;}
    const key=`${x},${y}`;if(this.mining?.key!==key)this.mining={key,x,y,progress:0,swingT:0};
    // 挖掘是「按住」的连续动作，挥臂相位单独计时（不能用 progress：不同方块硬度不同，
    // 用 progress 当相位会让石头挥得慢、泥土挥得快）
    this.mining.swingT=(this.mining.swingT||0)+dt;
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
    this.mining=null;this.swing();   // 挖穿的收尾动作
  }
  place(x,y){
    x=Math.floor(x);y=Math.floor(y);const slot=this.held(),item=ITEMS[slot?.id];
    if(item?.mob&&this.reachable(x,y)&&!this.solid(x,y)){const mob=this.makeMob(item.mob,x,y);if(this.collides(mob))return false;this.mobs.push(mob);if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;this.swing();return true;}
    if(slot?.id==='water_bucket'&&this.reachable(x,y)&&[0,17].includes(this.get(x,y))){this.setWaterSource(x,y);if(this.mode!=='creative')this.inventory[this.selected]={id:'bucket',n:1};this.sound('splash',x,.6);this.swing();return true;}
    if(slot?.id==='bucket'&&this.reachable(x,y)&&this.waterSources.has(y*W+x)){this.setWaterSource(x,y,false);if(this.mode!=='creative'){if(slot.n===1)this.inventory[this.selected]={id:'water_bucket',n:1};else{slot.n--;if(this.add('water_bucket'))this.drop('water_bucket',1,this.player.x,this.player.y);}}this.sound('splash',x,.5);this.swing();return true;}
    if(!item?.block||!this.reachable(x,y)||![0,17].includes(this.get(x,y)))return false;
    if(![[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([xx,yy])=>this.solid(xx,yy)))return false;
    const rect={x,y,w:1,h:1};if(item.solid!==false&&(overlap(rect,this.player)||this.mobs.some(m=>overlap(rect,m))))return false;
    this.set(x,y,item.block);this.sound('dig_'+material(item),x,.5);if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;this.swing();return true;
  }
  eat(){const slot=this.held(),item=ITEMS[slot?.id];if(!item?.food||this.player.food>=20)return false;this.player.food=Math.min(20,this.player.food+item.food);if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;this.notify('补充了饱食度');this.sound('eat',this.player.x,.6);this.swing();return true;}
  smelt(input){
    const station=this.nearBlock(14),out=SMELTS[input];
    if(!station||!out||!this.count(input))return false;
    const f=this.furnaces[station.key]??={fuel:0,input:null,output:null,count:0,progress:0};
    if(f.input||f.output&&f.output!==out||f.count>=64)return false;
    // Reserve the input first: a single log cannot be both the ingredient and its fuel.
    const needed=Math.max(0,10-f.fuel),plan=[];let supplied=0;
    for(const [id,seconds] of Object.entries(FUELS)){
      const available=this.count(id)-(id===input?1:0);
      const n=Math.min(Math.max(0,available),Math.ceil(Math.max(0,needed-supplied)/seconds));
      if(n){plan.push([id,n]);supplied+=n*seconds;}
    }
    if(supplied<needed){this.notify('燃料不足：可用煤炭、木炭、木材或两根木棍');return false;}
    for(const [id,n] of plan)this.remove(id,n);
    f.fuel+=supplied;
    this.remove(input,1);f.input=input;f.result=out;f.progress=0;return true;
  }
  collectSmelt(){const station=this.nearBlock(14),f=station&&this.furnaces[station.key];if(!f?.output)return;const rest=this.add(f.output,f.count);f.count=rest;if(!rest)f.output=null;}
  makeMob(type,x,y){const size={pig:[1.05,.95,10],cow:[1.2,1.4,10],sheep:[1.1,1.25,8],chicken:[.55,.8,4],zombie:[.65,1.8,20]}[type]||[.65,1.8,20];return{type,x,y,w:size[0],h:size[1],vx:0,vy:0,ground:false,health:size[2],clock:0,face:1,yaw:.65,hurt:0};}
  damage(amount,reason){const p=this.player;if(this.mode==='creative'||p.invuln>0||p.health<=0)return;p.health=Math.max(0,p.health-amount);p.invuln=1;this.sound('hurt',p.x,.6);if(!p.health){this.deathReason=reason;for(const s of this.inventory)if(s)this.drop(s.id,s.n,p.x,p.y,s.dur);this.inventory.fill(null);this.notify('你倒下了，物品掉落在原地');}}
  respawn(){const p=this.player;Object.assign(p,{...this.spawn,vx:0,vy:0,health:20,food:20,invuln:3});while(this.collides(p)&&p.y>1)p.y--;this.mining=null;}
  attack(x,y){if(this.attackCooldown>0)return false;const p=this.player;const mob=this.mobs.find(m=>x>=m.x-.4&&x<=m.x+m.w+.4&&y>=m.y-.3&&y<=m.y+m.h+.3&&Math.hypot(m.x-p.x,m.y-p.y)<3.5&&this.reachable(Math.floor(m.x),Math.floor(m.y)));if(!mob)return false;
    this.attackCooldown=.55;this.swing(.3);mob.health-=ITEMS[this.held()?.id]?.damage??1;mob.hurt=.25;this.sound(mob.type,mob.x,.65);mob.vx=(mob.x>p.x?1:-1)*6;mob.vy=-3;this.wear();if(mob.health<=0){const loot={pig:[['porkchop',2]],cow:[['beef',2],['leather',1]],sheep:[['mutton',2],['white_wool',1]],chicken:[['chicken',1],['feather',1]]}[mob.type]||[];for(const [id,n] of loot)this.drop(id,n,mob.x,mob.y);this.mobs.splice(this.mobs.indexOf(mob),1);}return true;
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
  /* 蹲下：身高 1.8 → 1.5，速度降到 30%，而且不会走出方块边缘（原版行为：
     蹲在方块边上不会掉下去）。y 是「头顶」，所以蹲下要把 y 加 0.3 让脚底不动。 */
  setCrouch(on){
    const p=this.player;
    if(on===p.crouch)return;
    if(on){
      p.crouch=true;p.h=1.5;p.y+=.3;
    }else{
      // 头顶没空间就站不起来（原版会一直保持着蹲姿）
      if(this.collides({x:p.x,y:p.y-.3,w:p.w,h:1.8}))return;
      p.crouch=false;p.h=1.8;p.y-=.3;
    }
  }
  footSupported(e,x=e.x+e.w/2,y=e.y+e.h+.06){return this.solid(x,y)||this.solid(x-.02,y)||this.solid(x+.02,y);}
  update(dt,controls={}){
    if(this.player.health<=0)return;
    const p=this.player;this.time+=dt;this.elapsed+=dt;this.attackCooldown=Math.max(0,this.attackCooldown-dt);p.invuln=Math.max(0,p.invuln-dt);
    p.swing=Math.max(0,p.swing-dt);
    this.weatherTimer-=dt;
    if(this.weatherTimer<=0){
      this.weatherTimer=200+this.rng()*260;
      if(this.weather==='clear'&&this.rng()<.34)this.weather='rain';
      else if(this.weather==='rain')this.weather=this.rng()<.28?'thunder':'clear';
      else if(this.weather==='thunder')this.weather='rain';
    }
    if(this.weather==='thunder'&&this.rng()<dt*.1)this.lightning=.3;
    this.lightning=Math.max(0,this.lightning-dt);
    const water=this.get(p.x+p.w/2,p.y+1)===17;
    let dir=(controls.right?1:0)-(controls.left?1:0);
    const sprinting=!!controls.sprint&&!p.crouch&&p.food>6;
    let speed=p.crouch?(water?1.2:1.35):water?2.5:sprinting?5.6:4.3;
    if(dir){p.face=dir;this.exhaustion+=dt*(p.crouch?.012:sprinting?.11:.025);}
    // 蹲在方块边缘时朝外走会停住，不会掉下去
    if(p.crouch&&p.ground&&dir&&!this.footSupported(p,dir>0?p.x+p.w+.04:p.x-.04,))dir=0;
    p.vx=dir*speed;
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
      /* ★ 远处的生物「挂起」，不模拟也不删除（原版就是这样：出了模拟距离只是冻住）。
         以前这里在末尾按「距玩家 95 格」直接 filter 掉，世界放大后
         等于一走开就把大半张图的动物清空 —— 玩家永远只能在身边看到零星几只。 */
      if(Math.abs(m.x-p.x)>64){m.vx=0;continue;}
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
    this.mobs=this.mobs.filter(m=>m.health>0&&m.x>-8&&m.x<W+8);
    this.gravityClock+=dt;if(this.gravityClock>.16){this.gravityClock=0;for(let y=Math.min(H-4,Math.floor(p.y)+20);y>Math.max(0,p.y-20);y--)for(let x=Math.max(0,Math.floor(p.x)-22);x<Math.min(W,p.x+22);x++)if(this.get(x,y)===7&&[0,17].includes(this.get(x,y+1))&&!overlap({x,y:y+1,w:1,h:1},p)){this.set(x,y,0);this.set(x,y+1,7);}}
  }
  nearTorch(x,y,r){for(let yy=Math.max(0,Math.floor(y-r));yy<=Math.min(H-1,y+r);yy++)for(let xx=Math.max(0,Math.floor(x-r));xx<=Math.min(W-1,x+r);xx++)if(this.get(xx,yy)===16&&Math.hypot(xx-x,yy-y)<r)return true;return false;}
  serialize(){
    return{
      version:4,width:W,height:H,
      blocks:rle(this.blocks),natural:rle(this.natural),water:rle(this.water),
      waterSources:[...this.waterSources],seed:this.seed,mode:this.mode,
      surface:Array.from(this.surface),spawn:this.spawn,player:this.player,
      inventory:this.inventory,selected:this.selected,time:this.time,elapsed:this.elapsed,
      weather:this.weather,drops:this.drops,mobs:this.mobs,furnaces:this.furnaces,
      exhaustion:this.exhaustion,craftGrid:this.craftGrid,tableGrid:this.tableGrid,
    };
  }
  static restore(data){
    if(!data||![1,2,3,4].includes(data.version)||typeof data.seed!=='string'||data.seed.length>100||!['survival','creative'].includes(data.mode))throw Error('存档格式不受支持');
    const p=data.player;
    if(!p||![p.x,p.y,p.health,p.food].every(Number.isFinite)||p.health<0||p.health>20||p.food<0||p.food>20)throw Error('玩家数据损坏');
    // ★ 数量上限这里故意放宽到 64（而不是 ITEMS[id].stack）：
    //   旧版本的装备是可以叠 64 的（现在改成 1），线上玩家手里可能存着这种档。
    //   按新上限严格校验会直接抛错 → 整个玩家数据被丢弃。放宽后由下面第 483 行
    //   的 clamp 截到新上限，最多损失超出部分，不会丢整档。
    //   历史上任何物品都不可能超过 64，所以 64 作为「明显非法」的判据是安全的。
    if(!Array.isArray(data.inventory)||data.inventory.length!==36||data.inventory.some(s=>s&&(!ITEMS[s.id]||!Number.isInteger(s.n)||s.n<1||s.n>64||ITEMS[s.id].durability&&(!Number.isInteger(s.dur)||s.dur<1||s.dur>ITEMS[s.id].durability))))throw Error('背包数据损坏');
    if(!Number.isFinite(data.time)||data.time<0||!Number.isFinite(data.elapsed)||data.elapsed<0)throw Error('时间数据损坏');
    const w=new World(data.seed,data.mode);
    const readGrid=(value,len)=>{
      const out=Array(len).fill(null);
      if(!Array.isArray(value))return out;
      for(let i=0;i<len&&i<value.length;i++){
        const s=value[i];if(!s||!ITEMS[s.id]||!Number.isInteger(s.n)||s.n<1)continue;
        out[i]={id:s.id,n:clamp(s.n,1,ITEMS[s.id].stack),...(s.dur?{dur:clamp(Math.floor(s.dur),1,ITEMS[s.id].durability||1)}:{})};
      }
      return out;
    };
    /* 世界尺寸在 v3 从 384×144 放大到 640×160，旧存档的方块数组长度必然对不上。
       这时候不报错、也不丢东西：用同一个 seed 重新生成地形，把背包、时间、
       玩家位置、熔炉这些「玩家的东西」搬过去。等于世界变大了，家当还在。 */
    const oldW=data.version===4?data.width:(data.surface?.length||384);
    const oldH=data.version===4?data.height:(oldW===640?160:144);
    if(!Number.isInteger(oldW)||!Number.isInteger(oldH)||oldW<1||oldW>W||oldH<1||oldH>H)throw Error('存档地图尺寸无效');
    const size=oldW*oldH;
    const read=(a,Type=Uint16Array)=>data.version>=3?unrle(a,size,Type):Type.from(a||[]);
    const blocks=read(data.blocks),natural=data.natural?read(data.natural,Uint8Array):new Uint8Array(size),water=data.water?read(data.water,Uint8Array):new Uint8Array(size);
    if(blocks.length!==size||blocks.some(id=>id>=BLOCKS.length))throw Error('存档方块数据损坏');
    for(let y=0;y<oldH;y++){
      w.blocks.set(blocks.subarray(y*oldW,(y+1)*oldW),y*W);
      w.natural.set(natural.subarray(y*oldW,(y+1)*oldW),y*W);
      w.water.set(water.subarray(y*oldW,(y+1)*oldW),y*W);
    }
    for(const i of w.waterSources)if(i%W<oldW&&Math.floor(i/W)<oldH)w.waterSources.delete(i);
    if(Array.isArray(data.waterSources))for(const i of data.waterSources){
      const x=i%oldW,y=Math.floor(i/oldW);if(Number.isInteger(i)&&i>=0&&y<oldH&&w.get(x,y)===17)w.waterSources.add(y*W+x);
    }
    for(let x=0;x<oldW;x++)if(Number.isInteger(data.surface?.[x]))w.surface[x]=clamp(data.surface[x],0,H-1);
    if(data.spawn&&Number.isFinite(data.spawn.x)&&Number.isFinite(data.spawn.y))w.spawn={x:clamp(data.spawn.x,0,W-1),y:clamp(data.spawn.y,0,H-2)};
    w.migrated=oldW!==W||oldH!==H;w.fluidStableRevision=-1;
    Object.assign(w.player,{x:clamp(p.x,0,W-1),y:clamp(p.y,-20,H-2),health:p.health,food:p.food,crouch:false});
    /* ★ 背包不能直接 structuredClone：装备的堆叠上限从 64 改成了 1，
       线上老档里可能存着「32 个钻石胸甲一摞」这种（当时合法）。
       这里按新上限拆开 —— 原格留到上限，多出来的逐个 add 到空格，
       放不下的才丢弃。既不会因为一格超限就丢掉整档，也不会让 32 个胸甲
       继续挤在同一格里（那样背包 UI 会显示成一个没有角标的怪格子）。 */
    const overflow=[];
    w.inventory=Array(36).fill(null);
    for(let i=0;i<36;i++){
      const s=data.inventory[i];if(!s)continue;
      const lim=ITEMS[s.id].stack;
      w.inventory[i]={id:s.id,n:Math.min(s.n,lim),...(s.dur?{dur:s.dur}:{})};
      if(s.n>lim)overflow.push({id:s.id,n:s.n-lim,dur:s.dur});
    }
    for(const o of overflow)w.add(o.id,o.n,o.dur);
    w.craftGrid=readGrid(data.craftGrid,4);w.tableGrid=readGrid(data.tableGrid,9);
    w.time=data.time;w.elapsed=data.elapsed;
    w.selected=Number.isInteger(data.selected)?clamp(data.selected,0,8):0;
    w.exhaustion=Number.isFinite(data.exhaustion)?clamp(data.exhaustion,0,1):0;
    w.weather=['clear','rain','thunder'].includes(data.weather)?data.weather:'clear';
    w.drops=[];w.mobs=w.migrated?w.mobs.filter(m=>m.x>=oldW):[];
    if(Array.isArray(data.drops))for(const d of data.drops.slice(0,1000)){if(ITEMS[d.id]&&Number.isFinite(d.x)&&Number.isFinite(d.y)&&d.x>=0&&d.x<W&&d.y>=0&&d.y<H&&Number.isInteger(d.n)&&d.n>0&&d.n<=64){w.drop(d.id,d.n,d.x,d.y,ITEMS[d.id].durability?clamp(Math.floor(d.dur)||1,1,ITEMS[d.id].durability):undefined);}}
    if(Array.isArray(data.mobs))for(const m of data.mobs.slice(0,512)){if(['pig','cow','sheep','chicken','zombie'].includes(m.type)&&Number.isFinite(m.x)&&Number.isFinite(m.y)&&m.x>=0&&m.x<W&&m.y>=0&&m.y<H&&Number.isFinite(m.health)&&m.health>0){const mob=w.makeMob(m.type,m.x,m.y);mob.health=Math.min(mob.health,m.health);w.mobs.push(mob);}}
    if(data.furnaces&&typeof data.furnaces==='object')for(const [key,f] of Object.entries(data.furnaces).slice(0,W*H)){
      if(!/^\d{1,4},\d{1,3}$/.test(key))continue;const [x,y]=key.split(',').map(Number);if(w.get(x,y)!==14||!f)continue;
      const outputs=SMELTS;
      if(f.input&&!outputs[f.input]||f.output&&!Object.values(outputs).includes(f.output)||!Number.isFinite(f.fuel)||!Number.isFinite(f.progress)||!Number.isInteger(f.count))continue;
      w.furnaces[key]={fuel:clamp(f.fuel,0,809),progress:clamp(f.progress,0,10),count:clamp(f.count,0,64),input:f.input||null,result:outputs[f.input]||null,output:f.output||null};
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
/** 史蒂夫的右臂角度（弧度，绕 X 轴，负值=向前抬）。
 *  swing 为 null 时走普通走路摆臂；否则是 0..1 的挥击进度，走一条「抬起→落下」的正弦。
 *  ★ 这个函数被 entityMesh 和 drawEntity 两边用：手上物品要挂到手臂末端，
 *    两边算出的角度必须完全一致，否则挥手时物品会跟手脱开。
 *  ★ 静止时留 -0.3 的前倾：手臂完全垂着的话，手上的物品会正正压在大腿上，
 *    看起来像贴在腿上而不是握着。 */
const ARM_REST=-0.3, ARM_LIFT=1.42;
export function steveArmAngle(time=0,velocity=0,swing=null){
  const walk=Math.sin(time*9)*Math.min(1,Math.abs(velocity)/2)*.65;
  if(swing!=null)return ARM_REST-Math.sin(swing*Math.PI)*ARM_LIFT;
  return ARM_REST+walk;
}
/** 手臂在模型坐标系里的两个关节点：肩 [-6,24,0]、手 [-6,12,0]（长度 12）。
 *  ★ 为什么是 x=-6 而不是 +6：yaw≈0.95 时 rot() 把 +x 转到「负 z」＝远离镜头，
 *    -x 才是朝向观众的那条手臂（它的贴图 [40,16] 也正是原版 64×64 布局里的「右臂」）。
 *    动错了那条的话，手臂在挥、但被身体挡着看不见，手上的物品也会被躯干盖住。 */
const STEVE_ARM={x:-6,shoulder:24,len:12};
/** 手在模型坐标系里的位置（已绕肩旋转）。 */
export function steveHand(a){
  return{x:STEVE_ARM.x,y:STEVE_ARM.shoulder-STEVE_ARM.len*Math.cos(a),z:-STEVE_ARM.len*Math.sin(a)};
}

export function entityMesh(type,time=0,velocity=0,swing=null){
  const boxes=[],walk=Math.sin(time*9)*Math.min(1,Math.abs(velocity)/2)*.65;
  const box=(texture,uv,center,size,angle=0,pivot=center)=>boxes.push({texture,uv,center,size,angle,pivot});
  if(type==='steve'||type==='zombie'){
    const zombie=type==='zombie',armSwing=zombie?-1.35:0;
    // 右手（朝镜头那条，x=-6）：拿东西、挖、打都用这只手。
    // ★ 必须无条件走 steveArmAngle：物品的位置也是它算的，两处走不同分支
    //   就会出现「手臂在 0、物品按 -0.3 摆」——手和物品错开半个手臂。
    const rightArm=zombie?armSwing:steveArmAngle(time,velocity,swing);
    box(type,[0,0],[0,28,0],[8,8,8]);
    box(type,[16,16],[0,18,0],[8,12,4]);
    box(type,[0,16],[-2,6,0],[4,12,4],walk,[-2,12,0]);
    box(type,zombie?[0,16]:[16,48],[2,6,0],[4,12,4],-walk,[2,12,0]);
    // 僵尸两条手臂都平举，贴图都在 (40,16)。以前左臂取的是 (0,16)，
    // 那是腿的位置，于是僵尸身上会多出一截腿肉。
    box(type,[40,16],[-6,18,0],[4,12,4],rightArm,[-6,24,0]);
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

// Tool pixels are extruded into a thin model. The handle grip is anchored in the palm,
// with a fixed scale in model units rather than an oversized inventory icon.
export function toolVertex(u,v,depth,angle){
  const du=(u-4.5)*.75,dv=(12.5-v)*.75,c=Math.SQRT1_2;
  const y=-10+(dv-du)*c,z=(du+dv)*c;
  return {x:STEVE_ARM.x+depth,y:STEVE_ARM.shoulder+y*Math.cos(angle)-z*Math.sin(angle),z:y*Math.sin(angle)+z*Math.cos(angle)};
}
const toolFaceCache=new WeakMap();
function toolFaces(img){
  if(toolFaceCache.has(img))return toolFaceCache.get(img);
  const canvas=document.createElement('canvas');canvas.width=canvas.height=16;
  const c=canvas.getContext('2d',{willReadFrequently:true});c.drawImage(img,0,0,16,16);
  const data=c.getImageData(0,0,16,16).data;
  const opaque=(x,y)=>x>=0&&y>=0&&x<16&&y<16&&data[(y*16+x)*4+3]>0;
  const faces=[];
  for(const d of [-.45,.45])faces.push({vertices:[[0,0,d],[16,0,d],[16,16,d],[0,16,d]],uv:[0,0,16,16],shade:0,cutout:true});
  for(let y=0;y<16;y++)for(let x=0;x<16;x++)if(opaque(x,y)){
    const edges=[[-1,0,x,y,x,y+1],[1,0,x+1,y,x+1,y+1],[0,-1,x,y,x+1,y],[0,1,x,y+1,x+1,y+1]];
    for(const [dx,dy,a,b,e,f]of edges)if(!opaque(x+dx,y+dy))faces.push({vertices:[[a,b,-.45],[e,f,-.45],[e,f,.45],[a,b,.45]],uv:[x,y,1,1],shade:.24});
  }
  toolFaceCache.set(img,faces);return faces;
}

/** 把一只生物画到画布上。cx = 身体中线屏幕 x，groundY = 脚底屏幕 y。
 *  hold（可选）= {id, swing}：把物品画在右手上，swing 是 0..1 的挥击进度（null=不挥）。 */
export function drawEntity(ctx,images,mob,time,cx,groundY,heightPx,yaw,hold=null){
  const parts=entityMesh(mob.type||'steve',time,mob.vx||0,hold?hold.swing:null);
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
  // ── 手上的物品 ──
  // 不走立方体那套：物品在 MC 里本来就是一张 16×16 的平面图。
  // 位置直接取「手臂末端再往外延伸 25%」，所以挥手时自然跟着手臂走；
  // 旋转角用肩→手两点的屏幕向量反推，比套用三维角度近似准得多。
  const proj=(x,y,z)=>{const r=rot(x,y,z);return{x:cx+r.x*scale,y:groundY-(r.y-lo)*scale,z:r.z};};
  const holdImg=hold?(hold.img||images[hold.id]):null;
  if(holdImg && ITEMS[hold.id]?.tool){
    const angle=steveArmAngle(time,mob.vx||0,hold.swing);
    for(const face of toolFaces(holdImg)){
      const q=face.vertices.map(([u,v,d])=>{const h=toolVertex(u,v,d,angle);return proj(h.x,h.y,h.z);});
      faces.push({q,uv:face.uv,shade:face.shade,cutout:face.cutout,image:holdImg,depth:q.reduce((n,p)=>n+p.z,0)/4});
    }
  }else if(holdImg){
    const a=steveArmAngle(time,mob.vx||0,hold.swing);
    const hand=steveHand(a);
    const sh=proj(STEVE_ARM.x,STEVE_ARM.shoulder,0);
    const hd=proj(hand.x,STEVE_ARM.shoulder+(hand.y-STEVE_ARM.shoulder)*1.12,hand.z*1.12);
    faces.push({sprite:holdImg,x:hd.x,y:hd.y,size:11*scale,
      ang:Math.atan2(hd.y-sh.y,hd.x-sh.x)-Math.PI/2,depth:hd.z+.01});
  }
  faces.sort((a,b)=>a.depth-b.depth);
  const hurt=(mob.hurt||0)>0;
  for(const f of faces){
    if(f.sprite){
      ctx.save();ctx.translate(f.x,f.y);ctx.rotate(f.ang);
      const s=f.size,img=f.sprite;
      ctx.drawImage(img,0,0,img.width,img.height,-s/2,-s/2,s,s);
      if(hurt){ctx.globalCompositeOperation='source-atop';ctx.fillStyle='rgba(255,64,64,.42)';
        ctx.fillRect(-s/2,-s/2,s,s);ctx.globalCompositeOperation='source-over';}
      ctx.restore();continue;
    }
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
    if(hurt&&!f.cutout){ctx.fillStyle='rgba(255,64,64,.42)';ctx.fillRect(0,0,w,h);}
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
  let panelSig='';                   // 上一次「背包面板」渲染时的内容指纹（见 hud 末尾）
  let heldItem=null;                 // 手上拿着的物品（独立栈，跟随鼠标）
  let drag=null;                     // 拖拽状态 {button,slots:[]}
  let press=null;                    // 按下未松开 {area,index,button,x,y}
  let dragStarted=false;
  let sprintHeld=false,lastDirCode='',lastDirAt=0;
  let audioReady=false;let enhancedLight=localStorage.getItem('zfsn.mc.light')!=='off';
  // 雨滴粒子的存储放在这里：resize() 在天空模块之前就会被调用一次，
  // 如果数组声明在下面，那次调用会撞上 TDZ。
  const rainDrops=[];
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
    invSignature='';deadShown=false;aim=null;keys.clear();heldTouches.clear();mouseDown=false;touchMine=false;
    heldItem=null;drag=null;press=null;dragStarted=false;
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
    seedRain();
  }
  addEventListener('resize',resize);resize();

  /* 所有方块、明暗层、选中框都用同一套整数像素坐标（camX/camY 是唯一取整点），
     并且都画 tile+1 宽来盖住缩放造成的亚像素缝。以前贴图用 Math.round、
     阴影用 Math.floor，差 1px 就是那道细缝。 */
  const pendingTextures=new Set();
  function ensureTexture(id){
    if(!id||images[id]||pendingTextures.has(id))return;
    pendingTextures.add(id);const img=new Image();img.onload=()=>{images[id]=img;};
    img.src=new URL(`${id}.png`,textureBase).href;
  }
  function spriteAt(name,sx,sy,w,h,srcY=0){
    const image=tinted[name]||images[name];if(!image){ensureTexture(name);return;}
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

  /* 明暗层：把每格的暗度写进一张「一格一像素」的小图，再放大贴上去。
     放大时开双线性插值 → 就是 MC 的平滑光照：格与格之间渐变过渡，
     而不是一块块硬边方格。为了让边缘也正确插值，小图四周多留 1 圈
     padding（取最近格的值），否则最外圈会被拉出一圈亮边。

     另：这里绝不能沿用早期的「逐格 fillRect(tile+1) 半透明黑」，
     相邻两格重叠 1px 会被叠两次，整片地形浮出网格状暗线 ——
     那正是用户说的「方块之间对不齐」。 */
  const shadeCanvas=document.createElement('canvas');
  const shadeCtx=shadeCanvas.getContext('2d');
  let shadeData=null;
  function drawShade(minX,minY,maxX,maxY,torches,p,light){
    const cols=maxX-minX+1,rows=maxY-minY+1;
    if(cols<=0||rows<=0)return;
    const pad=1,cw=cols+pad*2,ch=rows+pad*2;
    if(shadeCanvas.width!==cw||shadeCanvas.height!==ch){
      shadeCanvas.width=cw;shadeCanvas.height=ch;shadeData=null;
    }
    if(!shadeData)shadeData=shadeCtx.createImageData(cw,ch);
    const data=shadeData.data;
    let any=false;
    for(let j=0;j<ch;j++)for(let i=0;i<cw;i++){
      const x=clamp(minX+i-pad,minX,maxX),y=clamp(minY+j-pad,minY,maxY);
      let darkness=Math.max(1-light,clamp((y-world.surface[x]-1)*.1,0,.96));
      if(playing){const d=Math.hypot(x-p.x,y-p.y);if(d<4.2)darkness=Math.min(darkness,.26+d*.16);}
      for(const t of torches){const d=Math.hypot(t.x-x,t.y-y);if(d<7.5)darkness=Math.min(darkness,Math.max(.02,d*.115));}
      const o=(j*cw+i)*4;
      const a=Math.round(clamp(darkness,0,1)*255);
      data[o]=4;data[o+1]=8;data[o+2]=18;data[o+3]=a;
      if(a>4)any=true;
    }
    if(!any)return;
    shadeCtx.putImageData(shadeData,0,0);
    ctx.save();
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(shadeCanvas,(minX-pad)*tile-camX,(minY-pad)*tile-camY,cw*tile,ch*tile);
    ctx.restore();
  }

  /* ── 天空 ──────────────────────────────────────────────────────
     原版 MC 的天空是三件事：竖直渐变（天顶色→地平线色）、方形太阳/月亮、
     缓慢横移的像素云。以前这里是「渐变 + 三层山剪影」，看着像插画不像 MC。
     配色取自 Java 版 overworld，按一天中的相位插值。 */
  const SKY_KEYS=[
    {t:0.000,top:[0x5c,0x8c,0xe8],bot:[0xd9,0x9a,0x74]},   // 日出
    {t:0.060,top:[0x6f,0xa0,0xf5],bot:[0xc9,0xdd,0xff]},
    {t:0.250,top:[0x78,0xa7,0xff],bot:[0xcb,0xe4,0xff]},   // 正午
    {t:0.440,top:[0x76,0xa4,0xfa],bot:[0xc4,0xd9,0xf7]},
    {t:0.500,top:[0x3b,0x45,0x86],bot:[0xf0,0x8a,0x4c]},   // 日落
    {t:0.545,top:[0x14,0x18,0x3a],bot:[0x3a,0x30,0x52]},
    {t:0.600,top:[0x0a,0x0b,0x1c],bot:[0x12,0x16,0x30]},   // 夜
    {t:0.900,top:[0x0a,0x0b,0x1c],bot:[0x12,0x16,0x30]},
    {t:0.955,top:[0x2a,0x2f,0x5e],bot:[0x8a,0x5e,0x6a]},
    {t:1.000,top:[0x5c,0x8c,0xe8],bot:[0xd9,0x9a,0x74]},
  ];
  const lerpCurve=(a,b,k)=>[Math.round(a[0]+(b[0]-a[0])*k),Math.round(a[1]+(b[1]-a[1])*k),Math.round(a[2]+(b[2]-a[2])*k)];
  const cssRGB=c=>`rgb(${c[0]},${c[1]},${c[2]})`;
  function skyPair(phase){
    let a=SKY_KEYS[0],b=SKY_KEYS[SKY_KEYS.length-1];
    for(let i=0;i<SKY_KEYS.length-1;i++)if(phase>=SKY_KEYS[i].t&&phase<=SKY_KEYS[i+1].t){a=SKY_KEYS[i];b=SKY_KEYS[i+1];break;}
    const k=clamp((phase-a.t)/Math.max(1e-6,b.t-a.t),0,1);
    return{top:lerpCurve(a.top,b.top,k),bot:lerpCurve(a.bot,b.bot,k)};
  }
  // 云的形状：几坨 12px 方块拼成的像素云。远景，不跟相机移动，只匀速横飘。
  const CLOUD_UNIT=12,CLOUD_SPAN=2600,clouds=[];
  {const r=random(0xC10D5);
   for(let i=0;i<10;i++){
     const blocks=[[0,0,6+Math.floor(r()*5),2]];
     if(r()<.75)blocks.push([2+Math.floor(r()*2),-1,3+Math.floor(r()*2),1]);
     if(r()<.55)blocks.push([5+Math.floor(r()*2),1,3,1]);
     clouds.push({x:r()*CLOUD_SPAN,y:.03+r()*.3,blocks});
   }}
  let cloudOffset=0;
  function drawClouds(alpha){
    const span=CLOUD_SPAN;
    for(const c of clouds){
      const x=((c.x-cloudOffset)%span+span)%span-380;
      if(x>viewW+380)continue;
      const baseY=Math.round(viewH*c.y);
      ctx.fillStyle=`rgba(255,255,255,${alpha})`;
      for(const[bx,by,bw,bh]of c.blocks)ctx.fillRect(Math.round(x+bx*CLOUD_UNIT),baseY+by*CLOUD_UNIT,bw*CLOUD_UNIT,bh*CLOUD_UNIT);
      // 云底压一条极淡的灰，避免整块纯白糊成一片
      ctx.fillStyle=`rgba(198,208,224,${alpha*.36})`;
      for(const[bx,by,bw,bh]of c.blocks)ctx.fillRect(Math.round(x+bx*CLOUD_UNIT),baseY+(by+bh-1)*CLOUD_UNIT+CLOUD_UNIT-3,bw*CLOUD_UNIT,3);
    }
  }
  function drawCelestial(kind,sx,sy,alpha){
    if(kind==='sun'){
      const glow=ctx.createRadialGradient(sx+15,sy+15,5,sx+15,sy+15,74);
      glow.addColorStop(0,`rgba(255,250,214,${.46*alpha})`);
      glow.addColorStop(1,'rgba(255,250,214,0)');
      ctx.fillStyle=glow;ctx.fillRect(sx-60,sy-60,150,150);
      ctx.fillStyle=`rgba(255,251,214,${alpha})`;ctx.fillRect(sx,sy,30,30);
      ctx.fillStyle=`rgba(255,255,255,${alpha})`;ctx.fillRect(sx+6,sy+6,18,18);
    }else{
      const glow=ctx.createRadialGradient(sx+11,sy+11,4,sx+11,sy+11,56);
      glow.addColorStop(0,`rgba(220,230,255,${.24*alpha})`);
      glow.addColorStop(1,'rgba(220,230,255,0)');
      ctx.fillStyle=glow;ctx.fillRect(sx-46,sy-46,114,114);
      ctx.fillStyle=`rgba(233,238,255,${alpha})`;ctx.fillRect(sx,sy,22,22);
      ctx.fillStyle=`rgba(198,206,232,${alpha})`;
      ctx.fillRect(sx+4,sy+5,5,5);ctx.fillRect(sx+12,sy+11,6,5);ctx.fillRect(sx+6,sy+14,4,4);
    }
  }
  function seedRain(){
    rainDrops.length=0;
    const n=Math.round(clamp(viewW*viewH/5200,90,420));
    for(let i=0;i<n;i++)rainDrops.push({x:Math.random()*viewW*1.3-viewW*.15,y:Math.random()*viewH,l:9+Math.random()*15,s:640+Math.random()*460});
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
    // 天气：下雨压暗压灰，雷暴更重
    const storm=world.weather==='rain'?.42:world.weather==='thunder'?.62:0;
    const pair=skyPair(phase);
    const gray=c=>[Math.round(c[0]+(150-c[0])*storm*.55),Math.round(c[1]+(155-c[1])*storm*.55),Math.round(c[2]+(165-c[2])*storm*.55)];
    const dim=c=>[Math.round(c[0]*(1-storm*.42)),Math.round(c[1]*(1-storm*.42)),Math.round(c[2]*(1-storm*.38))];
    const sky=ctx.createLinearGradient(0,0,0,viewH);
    sky.addColorStop(0,cssRGB(dim(gray(pair.top))));
    sky.addColorStop(1,cssRGB(dim(gray(pair.bot))));
    ctx.fillStyle=sky;ctx.fillRect(0,0,viewW,viewH);

    // 太阳 0→0.5 走一趟，月亮 0.5→1 走一趟，弧线顶点在相位中点
    const sunUp=phase<.5;
    if(sunUp){
      const k=phase/.5,sx=viewW*(.06+.88*k)-15,sy=viewH*(.60-Math.sin(Math.PI*k)*.50);
      drawCelestial('sun',Math.round(sx),Math.round(sy),clamp(1-storm*.85,0,1));
    }else{
      const k=(phase-.5)/.5,mx=viewW*(.06+.88*k)-11,my=viewH*(.60-Math.sin(Math.PI*k)*.50);
      drawCelestial('moon',Math.round(mx),Math.round(my),clamp(.35+light,0,1));
    }
    drawClouds(clamp(.86-storm*.34,0,1)*(light>.5?1:.42));
    // 极淡的远景雾山：MC 里视野尽头的地形会被雾吞成天空色，删掉纯天空又太空。
    for(let layer=0;layer<2;layer++){
      const fade=ctx.createLinearGradient(0,viewH*.42,0,viewH);
      const base=dim(gray(pair.bot));
      fade.addColorStop(0,`rgba(${base[0]},${base[1]},${base[2]},0)`);
      fade.addColorStop(1,`rgba(${Math.round(base[0]*.82)},${Math.round(base[1]*.86)},${Math.round(base[2]*.9)},${.5-layer*.16})`);
      ctx.fillStyle=fade;ctx.beginPath();ctx.moveTo(0,viewH);
      for(let sx=0;sx<=viewW+12;sx+=14){
        const xx=sx/tile+camera.x*(.1+layer*.12);
        const yy=(49-camera.y)*tile+Math.sin(xx*.09+layer*2.7)*(60+layer*22)-118+layer*46;
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
      // 挥臂相位：挖掘时连续循环，其余动作（放置/攻击/吃东西）播一次性动画
      const swingPhase=world.mining?((world.mining.swingT||0)*2.4)%1
                      :(p.swing>0?1-p.swing/p.swingDur:null);
      // 贴图要过一遍 tinted：树叶在原版是灰度图靠生物群系染色，直接取 images 会是一坨灰
      const heldId=world.held()?.id;
      drawEntity(ctx,images,{...p,type:'steve'},world.elapsed,pc,py,p.h*tile,p.face>0?0.95:-0.95,
        {id:heldId,img:heldId?(tinted[heldId]||images[heldId]):null,swing:swingPhase});
      ctx.globalAlpha=1;
    }

    // 明暗：一次整片贴图，和方块共用 camX/camY，没有重叠也就没有缝
    drawShade(minX,minY,maxX,maxY,torches,p,light);

    if(enhancedLight){
      ctx.save();ctx.globalCompositeOperation='screen';
      for(const t of torches){const x=(t.x+.5)*tile-camX,y=(t.y+.4)*tile-camY,r=tile*2.4;
        const glow=ctx.createRadialGradient(x,y,0,x,y,r);glow.addColorStop(0,'rgba(255,174,70,.2)');glow.addColorStop(1,'rgba(255,130,30,0)');ctx.fillStyle=glow;ctx.fillRect(x-r,y-r,r*2,r*2);}
      ctx.globalCompositeOperation='source-over';const vignette=ctx.createRadialGradient(viewW/2,viewH/2,viewH*.2,viewW/2,viewH/2,Math.max(viewW,viewH)*.7);
      vignette.addColorStop(0,'transparent');vignette.addColorStop(1,'rgba(12,20,40,.22)');ctx.fillStyle=vignette;ctx.fillRect(0,0,viewW,viewH);ctx.restore();
    }
    // 雨幕：纯视觉，画在方块与实体之上，不参与光照
    if(world.weather!=='clear'){
      const slant=world.weather==='thunder'?6:4;
      ctx.save();
      ctx.strokeStyle=world.weather==='thunder'?'rgba(178,202,240,.60)':'rgba(162,188,224,.48)';
      ctx.lineWidth=2;ctx.beginPath();
      for(const d of rainDrops){ctx.moveTo(d.x,d.y);ctx.lineTo(d.x+slant,d.y+d.l);}
      ctx.stroke();ctx.restore();
    }
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
    if(world.lightning>0){ctx.fillStyle=`rgba(224,236,255,${(world.lightning*.62).toFixed(3)})`;ctx.fillRect(0,0,viewW,viewH);}
  }

  // ── 槽位 ──────────────────────────────────────────────────────
  function iconImg(id){ensureTexture(id);const img=document.createElement('img');img.src=new URL(ITEMS[id]?.cubeIcon?`../icons/${id}.png`:`${id}.png`,textureBase).href;img.alt='';img.draggable=false;return img;}
  function slotNode(stack,area,index,hotbar){
    // ★ 存档里出现当前版本不认识的 id 时不能硬崩：slotNode 一旦抛错，
    //   hud() 已经把 invSignature 写掉了、inventory() 也只画到一半 ——
    //   表现就是「快捷栏/背包卡在旧内容不动」。这里降级成空格。
    if(stack&&!ITEMS[stack.id])stack=null;
    const b=document.createElement('button');
    b.type='button';b.className='slot';
    b.setAttribute('aria-label',stack?`${ITEMS[stack.id].name} × ${stack.n}`:'空');
    // 名字挂到 data-tip 上，由统一的 tooltip 显示（原版那种深紫框）。
    // 不用原生 title：浏览器要悬停约 1 秒才弹，而且样式是系统菜单风，和原版差太远。
    if(stack)b.dataset.tip=ITEMS[stack.id].name;
    if(hotbar){
      b.style.position='absolute';b.style.left=(6+40*index)+'px';b.style.top='6px';
      b.onclick=()=>{world.selected=index;showItemName();hud(true);};
    }else{
      // 容器里的格子走 pointerdown/pointerup 那一套（拖拽、右键、分堆），不用 onclick：
      // onclick 只能表达「点了一下」，表达不了按下-拖动-松开。
      b.dataset.area=area;b.dataset.index=index;
    }
    if(stack){
      b.append(iconImg(stack.id));
      if(stack.n>1){const c=document.createElement('span');c.className='count';c.textContent=stack.n;b.append(c);}
      if(stack.dur){const bar=document.createElement('div');bar.className='dur';const fill=document.createElement('i');fill.style.width=`${stack.dur/ITEMS[stack.id].durability*100}%`;bar.append(fill);b.append(bar);}
    }
    return b;
  }

  /* ── 物品栏交互（按原版手感实现）──────────────────────────────────
     关键：手上拿的东西以前只是「标记原槽位」，物品还留在格子里 ——
     所以既画不出跟随鼠标的手持物品，也没法拆栈。现在手上是独立的一叠
     heldItem，拿起来时槽位真的空了。这样才能做到：
       左键点       拿起整叠 / 全部放下 / 同类合并 / 异类交换
       右键点       拿起一半（向上取整）/ 放下一个
       左键长按拖   经过的每格各放一个，松开时把剩余均分给这些格子
       右键长按拖   经过的每格各放一个，剩余留在手上 */
  const heldCursor=$('#held-cursor');
  let craftMode='inv';
  const gridRef=()=>craftMode==='table'?world.tableGrid:world.craftGrid;
  const stackAt=(area,index)=>area==='inv'?world.inventory[index]:gridRef()[index];
  const setStack=(area,index,stack)=>{if(area==='inv')world.inventory[index]=stack;else gridRef()[index]=stack;};
  const stackLimit=id=>ITEMS[id]?.stack??64;
  // ★ 合成格每格只能放 1 个（原版 SlotCrafting 的堆叠上限就是 1）。
  //   recipeIn() 数的是「有几格放着该物品」，一格堆 12 个木板永远凑不出需要 3 格的镐子。
  const slotLimit=(area,id)=>area==='grid'?1:stackLimit(id);
  let pointerPos={x:innerWidth/2,y:innerHeight/2};

  /* 背包面板「画的是什么」的指纹。面板是打开时一次性渲染的：
     捡起地上的东西、/give、吃东西、熔炉取产物、死亡重生、读档 —— 这些都只改
     world.inventory，不会重画面板。于是面板里的快捷栏一行会和屏幕底部那条
     快捷栏对不上（用户截图就是这种「两处内容不一样」）。
     hud() 每 120ms 都在跑，顺手拿这个指纹比一下就能把面板补画回来。 */
  const panelSignature=()=>JSON.stringify([world.inventory,craftMode,world.craftGrid,world.tableGrid,heldItem]);

  function renderHeld(){
    heldCursor.replaceChildren();
    if(!heldItem){heldCursor.hidden=true;return;}
    heldCursor.hidden=false;
    heldCursor.style.left=pointerPos.x+'px';heldCursor.style.top=pointerPos.y+'px';
    heldCursor.append(iconImg(heldItem.id));
    if(heldItem.n>1){const c=document.createElement('span');c.className='count';c.textContent=heldItem.n;heldCursor.append(c);}
    const dur=ITEMS[heldItem.id]?.durability;
    if(heldItem.dur&&dur){
      const bar=document.createElement('div');bar.className='dur';
      const fill=document.createElement('i');fill.style.width=`${heldItem.dur/dur*100}%`;
      bar.append(fill);heldCursor.append(bar);
    }
  }
  function pickAll(area,index){
    const stack=stackAt(area,index);if(!stack)return false;
    heldItem={...stack};setStack(area,index,null);return true;
  }
  function pickHalf(area,index){
    const stack=stackAt(area,index);if(!stack)return false;
    const take=Math.ceil(stack.n/2);
    heldItem={id:stack.id,n:take,...(stack.dur?{dur:stack.dur}:{})};
    const left=stack.n-take;
    setStack(area,index,left>0?{...stack,n:left}:null);
    return true;
  }
  function canDropOne(area,index){
    if(!heldItem)return false;
    const t=stackAt(area,index);
    return !t||(t.id===heldItem.id&&t.n<slotLimit(area,t.id));
  }
  function dropOne(area,index){
    if(!canDropOne(area,index))return false;
    const t=stackAt(area,index);
    if(!t)setStack(area,index,{id:heldItem.id,n:1,...(heldItem.dur?{dur:heldItem.dur}:{})});
    else setStack(area,index,{...t,n:t.n+1});
    if(--heldItem.n<=0)heldItem=null;
    return true;
  }
  // 单击（按下后没拖动就松开）
  function clickSlot(area,index,button){
    const target=stackAt(area,index);
    if(button===2){
      if(!heldItem){if(target)pickHalf(area,index);}
      else dropOne(area,index);
      return;
    }
    if(!heldItem){if(target)pickAll(area,index);return;}
    // 合成格每格 1 个：左键点空格就是「放一个」，点满格就是交换
    if(area==='grid'){
      if(dropOne(area,index))return;
      setStack(area,index,heldItem);heldItem=target;return;
    }
    if(!target){setStack(area,index,heldItem);heldItem=null;return;}
    if(target.id===heldItem.id){
      const room=stackLimit(target.id)-target.n;
      if(room<=0){setStack(area,index,heldItem);heldItem=target;return;}
      const move=Math.min(room,heldItem.n);
      setStack(area,index,{...target,n:target.n+move});
      heldItem.n-=move;
      if(heldItem.n<=0)heldItem=null;
      return;
    }
    setStack(area,index,heldItem);   // 异类交换
    heldItem=target;
  }
  function applyDrag(area,index){
    if(!drag||!heldItem)return;
    const key=`${area}:${index}`;
    if(drag.slots.includes(key))return;
    if(!dropOne(area,index))return;
    drag.slots.push(key);
  }
  function syncInv(){renderHeld();inventory();hud(true);}
  // 关闭界面时手上的东西不能凭空消失：先塞回背包，塞不下就掉在脚边
  function returnHeld(){
    if(!heldItem)return;
    const item=heldItem;heldItem=null;
    const rest=world.add(item.id,item.n,item.dur);
    if(rest>0){
      world.drop(item.id,rest,world.player.x+.2,world.player.y+.5,item.dur);
      notify('背包满了，手上的物品掉在脚边');
    }
    renderHeld();
  }

  /* ── 物品名提示框 ──────────────────────────────────────────────
     原版行为：鼠标移到格子上立刻出名字，不延迟、跟手走、贴边翻到另一侧。
     ★ 宿主必须按「当前有没有打开的 dialog」动态切换，理由同 #held-cursor：
       showModal() 的 dialog 在浏览器 top layer，外面再高的 z-index 也盖不住它。
     ★ 也不能塞进 .inv-root —— 那个容器窄屏下带 zoom，fixed 坐标会跟着缩放。 */
  const tipEl=$('#mc-tooltip');
  let tipHostEl=null,tipText='';
  function tipHost(){
    const host=document.querySelector('dialog[open]')||$('#game');
    if(tipHostEl!==host){host.append(tipEl);tipHostEl=host;}
  }
  function tipShow(text){
    if(!text)return;
    tipHost();
    if(tipText!==text){
      tipText=text;
      // 原版 tooltip 是一行一个元素，这里用 \n 分隔多行（第二行起是灰色说明）
      tipEl.replaceChildren(...text.split('\n').map((line,i)=>{
        const d=document.createElement('div');
        if(i)d.className='tip-sub';
        d.textContent=line;
        return d;
      }));
    }
    tipEl.hidden=false;
    tipMove(pointerPos.x,pointerPos.y);        // 首次显示时就摆到位，不等下一次 pointermove
  }
  function tipHide(){tipEl.hidden=true;tipText='';}
  function tipMove(x,y){
    if(tipEl.hidden)return;
    const w=tipEl.offsetWidth,h=tipEl.offsetHeight,pad=8;
    let left=x+14,top=y+16;
    if(left+w>innerWidth-pad)left=x-14-w;      // 贴右边就翻到指针左侧
    if(top+h>innerHeight-pad)top=y-12-h;       // 贴底边就翻到指针上方
    tipEl.style.left=Math.max(pad,left)+'px';
    tipEl.style.top=Math.max(pad,top)+'px';
  }
  document.addEventListener('pointerover',e=>{
    // 触屏没有悬停：点击时浏览器照样会补一个 pointerover，不挡住的话名字会闪一下
    if(e.pointerType==='touch'){tipHide();return;}
    const el=e.target.closest?.('[data-tip]');
    if(el)tipShow(el.dataset.tip);else tipHide();
  },true);
  document.addEventListener('pointerout',e=>{
    const el=e.target.closest?.('[data-tip]');
    if(!el)return;
    // 在父子元素之间移动也会触发 pointerout，只有真的离开带提示的元素才隐藏
    if(e.relatedTarget?.closest?.('[data-tip]')!==el)tipHide();
  },true);
  addEventListener('scroll',tipHide,true);

  document.addEventListener('pointerdown',e=>{
    const el=e.target.closest?.('.slot[data-area]');
    if(!el||!$('#inventory-dialog').open)return;
    if(e.button!==0&&e.button!==2)return;
    e.preventDefault();
    tipHide();                                 // 按住开始拖塔时别让名字挡着
    press={area:el.dataset.area,index:Number(el.dataset.index),button:e.button,x:e.clientX,y:e.clientY};
    dragStarted=false;drag=null;
  },true);
  addEventListener('pointermove',e=>{
    pointerPos={x:e.clientX,y:e.clientY};
    if(heldItem){heldCursor.style.left=e.clientX+'px';heldCursor.style.top=e.clientY+'px';}
    tipMove(e.clientX,e.clientY);
    if(!press)return;
    if(!dragStarted){
      const slot=document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.slot[data-area]');
      const same=slot&&slot.dataset.area===press.area&&Number(slot.dataset.index)===press.index;
      if(Math.hypot(e.clientX-press.x,e.clientY-press.y)<6&&(same||!slot))return;
      // 进入拖拽模式：手上先有东西才开始
      if(!heldItem){
        const got=press.button===0?pickAll(press.area,press.index):pickHalf(press.area,press.index);
        if(!got)return;
      }
      dragStarted=true;drag={button:press.button,slots:[]};
      applyDrag(press.area,press.index);
      syncInv();
      // 不 return：第一次触发时指针可能已经跨到别的格子了，下面那段还要处理它
    }
    const slot=document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.slot[data-area]');
    if(slot){applyDrag(slot.dataset.area,Number(slot.dataset.index));syncInv();}
  });
  function endPointer(){
    if(!press)return;
    const started=dragStarted,info=press;
    press=null;dragStarted=false;
    if(started&&drag){
      if(drag.button===0&&heldItem&&drag.slots.length){
        // 左键拖拽松开：剩余按顺序循环均分给经过的格子
        let i=0,fails=0;
        while(heldItem&&fails<drag.slots.length){
          const [area,index]=drag.slots[i%drag.slots.length].split(':');
          if(dropOne(area,Number(index)))fails=0;else fails++;
          i++;
        }
      }
      // 右键拖拽：剩下的留在手上（原版就是这样）
      drag=null;
      syncInv();
      return;
    }
    drag=null;
    clickSlot(info.area,info.index,info.button);
    syncInv();
  }
  addEventListener('pointerup',endPointer);
  addEventListener('pointercancel',()=>{press=null;drag=null;dragStarted=false;syncInv();});
  addEventListener('blur',()=>{press=null;drag=null;dragStarted=false;});


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
    /* ★ 面板内容变了就补画（指纹在 inventory() 末尾写，所以不会重复渲染）：
       - 拖动中（press）不重画，否则按下时的那个 DOM 会被换掉，拖拽高亮会闪；
       - 只补画「背包」这一个 dialog，熔炉/暂停那些各有各的刷新路径。 */
    if(!press&&$('#inventory-dialog').open&&panelSig!==panelSignature())inventory();
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

  // ── 背包（2×2）/ 工作台（3×3）─────────────────────────────────
  // 两者共用同一个 dialog：换面板贴图、换格子数、换网格容器即可。
  // 复制一套 DOM 只会多一份要同步维护的坐标。
  // 点产物格取货。材料按「每格 1 个」扣 —— recipeIn() 数的是「有几格放着
  // 该物品」，扣的时候也必须一格一个，否则从同一格扣 3 个就吞材料了。
  function takeResult(){
    const recipe=craftMode==='table'?world.findTableRecipe():world.findGridRecipe();
    if(!recipe)return;
    const out={id:recipe.out,n:recipe.n};
    if(heldItem){
      if(heldItem.id!==out.id||heldItem.n+out.n>stackLimit(out.id))return;
      heldItem.n+=out.n;
    }else heldItem={...out};
    const grid=gridRef();
    for(const[id,need]of Object.entries(recipe.needs)){
      let left=need;
      for(let i=0;i<grid.length&&left>0;i++){
        const s=grid[i];
        if(s?.id===id){s.n-=1;left-=1;if(s.n<=0)grid[i]=null;}
      }
    }
    world.sound('click',world.player.x,.4);
    syncInv();
  }

  function inventory(mode){
    // 切换 2×2 / 3×3 时手上的东西要收回去，否则会指向另一个容器的越界下标
    if(mode&&mode!==craftMode){returnHeld();craftMode=mode;}
    const isTable=craftMode==='table';
    const panel=$('.inv-panel');
    if(panel)panel.classList.toggle('is-table',isTable);
    const player=$('#inv-player');
    if(player)player.hidden=isTable;
    const grid=gridRef();
    $('#slots').replaceChildren(...Array.from({length:27},(_,i)=>slotNode(world.inventory[9+i],'inv',9+i,false)));
    $('#inv-hotbar').replaceChildren(...Array.from({length:9},(_,i)=>slotNode(world.inventory[i],'inv',i,false)));
    $('#craft-grid').replaceChildren(...Array.from({length:isTable?9:4},(_,i)=>slotNode(grid[i],'grid',i,false)));
    const result=isTable?world.findTableRecipe():world.findGridRecipe();
    const out=$('#craft-result');
    out.replaceChildren();
    if(result){
      const b=document.createElement('button');
      b.type='button';b.className='slot';
      b.append(iconImg(result.out));
      if(result.n>1){const c=document.createElement('span');c.className='count';c.textContent=result.n;b.append(c);}
      b.dataset.tip=`取得 ${ITEMS[result.out].name}`;
      b.onclick=takeResult;
      out.append(b);
    }
    const table=world.nearBlock(13),furnace=world.nearBlock(14);
    // 生存模式要的是原版 176×166 背包：只有 2×2 合成格 + 物品栏，没有侧边列表。
    // 创造模式才需要物品来源，那块列表只在创造模式露出来。
    const creative=world.mode==='creative';
    document.querySelector('.recipe-panel').hidden=true;
    $('#inventory-dialog').classList.toggle('creative',creative&&!isTable);
    $('#inventory-dialog').classList.toggle('personal',creativeTab==='inventory');
    $('#creative-browser').hidden=!creative||isTable;
    $('#slot-description').textContent=heldItem?`${ITEMS[heldItem.id].name} × ${heldItem.n}`:'';
    renderHeld();if(creative&&!isTable)renderCreative();
    panelSig=panelSignature();   // 记下「这一帧画的是什么」，hud() 靠它判断要不要补画
  }
  let creativeTab='building',creativeRow=0;
  const categories=[['building','建筑方块','bricks'],['colored','染色方块','red_wool'],['nature','自然方块','grass_block'],['functional','功能方块','crafting_table'],['redstone','红石方块','redstone'],['search','搜索','compass'],['equipment','工具与实用物品','diamond_pickaxe'],['combat','战斗用品','diamond_sword'],['food','食物与饮品','apple'],['ingredients','原材料','iron_ingot'],['spawn','刷怪蛋','pig_spawn_egg'],['inventory','生存物品栏','chest']];
  function renderCreative(){
    $('#inventory-dialog').classList.toggle('personal',creativeTab==='inventory');
    for(const [sel,entries]of [['#creative-tabs-top',categories.slice(0,6)],['#creative-tabs-bottom',categories.slice(6)]]){
      const tabs=$(sel);tabs.replaceChildren();
      for(const [id,name,icon]of entries){const b=document.createElement('button');b.type='button';b.dataset.tip=name;b.setAttribute('aria-label',name);b.setAttribute('role','tab');b.setAttribute('aria-selected',String(id===creativeTab));b.append(iconImg(icon));b.onclick=()=>{creativeTab=id;creativeRow=0;inventory();if(id==='search')$('#creative-search').focus();};tabs.append(b);}
    }
    $('#creative-title').textContent=categories.find(x=>x[0]===creativeTab)?.[1]||'';
    const search=$('#creative-search');search.hidden=creativeTab!=='search';
    const query=search.value.trim().toLowerCase();
    const entries=Object.entries(ITEMS).filter(([id,item])=>!['water_still','bedrock'].includes(id)&&(creativeTab==='search'?(id.includes(query)||item.name.toLowerCase().includes(query)):(item.category||'ingredients')===creativeTab));
    const max=Math.max(0,Math.ceil(entries.length/9)-5);creativeRow=clamp(creativeRow,0,max);
    const grid=$('#creative-grid');grid.replaceChildren();
    for(let i=0;i<45;i++){
      const b=document.createElement('button');b.type='button';b.className='slot';const entry=entries[creativeRow*9+i];
      if(entry){const[id,item]=entry;b.append(iconImg(id));
        // 多行：主行是名字，副行用 \n 分隔（原版收藏物品也是这么显示的）
        b.dataset.tip=item.name+(item.catalogOnly?'\n收藏物品 · 特殊机制尚未实现':'');
        b.setAttribute('aria-label',item.name);b.onclick=()=>{returnHeld();heldItem={id,n:item.stack,...(item.durability?{dur:item.durability}:{})};renderHeld();};}
      else b.disabled=true;grid.append(b);
    }
    $('#creative-hotbar').replaceChildren(...world.inventory.slice(0,9).map((s,i)=>slotNode(s,'inv',i,false)));
    const scroll=$('#creative-scroll');scroll.max=max;scroll.value=creativeRow;scroll.disabled=max===0;
  }
  $('#creative-search').oninput=()=>{creativeRow=0;renderCreative();};
  $('#creative-scroll').oninput=e=>{creativeRow=Number(e.target.value);renderCreative();};
  $('#creative-grid').onwheel=e=>{e.preventDefault();creativeRow+=Math.sign(e.deltaY);renderCreative();};
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
      if(id){node.append(iconImg(id));node.dataset.tip=ITEMS[id].name;}
      else delete node.dataset.tip;
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
  function openDialog(dialog){clearInput();closeChat();if(!dialog.open)dialog.showModal();}
  function begin(next){
    dialogs.forEach(d=>d.close());
    bindWorld(next);playing=true;
    $('#start-screen').hidden=true;$('#hud').hidden=false;
    $('#chat').hidden=false;
    $('#touch-controls').hidden=!coarse;
    canvas.focus();hud(true);showItemName();save();
    pushChat(`世界已生成：${world.seed} · 输入 /help 查看指令`,'system');
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
  dialogs.forEach(d=>d.addEventListener('close',()=>{
    clearInput();returnHeld();
    press=null;drag=null;dragStarted=false;
    canvas.focus();
  }));
  // 原版背包没有「完成」按钮，按 E 或点界面外关闭。生存模式下配方书面板（含那个
  // 完成按钮）是隐藏的，所以必须补上「点界面外关闭」，否则手机端进去就出不来。
  $('#inventory-dialog').addEventListener('click',(e)=>{
    if(e.target===e.currentTarget)e.currentTarget.close();
  });
  $('#help-button').onclick=()=>openDialog($('#help-dialog'));
  $('#close-inventory').onclick=()=>$('#inventory-dialog').close();
  $('#close-furnace').onclick=()=>$('#furnace-dialog').close();
  $('#resume').onclick=()=>$('#pause-dialog').close();
  $('#save-button').onclick=()=>{if(save())notify('世界已保存');};
  $('#return-title').onclick=()=>{
    save();$('#pause-dialog').close();playing=false;closeChat();
    $('#start-screen').hidden=false;$('#hud').hidden=true;$('#touch-controls').hidden=true;$('#chat').hidden=true;
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
  const lightButton=$('#light-button');const lightLabel=()=>lightButton.textContent='柔和光影：'+(enhancedLight?'开':'关');lightLabel();lightButton.onclick=()=>{enhancedLight=!enhancedLight;localStorage.setItem('zfsn.mc.light',enhancedLight?'on':'off');lightLabel();};
  $('#collect-smelt').onclick=()=>{world.collectSmelt();furnaceUI();hud(true);};

  function use(){
    if(paused())return;
    if(world.eat()){hud(true);return;}
    if(world.nearBlock(14)){openFurnace();return;}
    if(world.nearBlock(13)){inventory('table');openDialog($('#inventory-dialog'));return;}
    notify('手持食物可以进食；靠近工作台或熔炉可以交互');
  }

  // ── 聊天 / 指令 ────────────────────────────────────────────────
  const chatRoot=$('#chat'),chatLog=$('#chat-log'),chatBar=$('#chat-bar'),chatInput=$('#chat-input');
  let chatOpen=false;const sentHistory=[];let historyPos=0;

  function pushChat(text,cls=''){
    const line=document.createElement('div');
    line.className='chat-line'+(cls?' '+cls:'');
    line.textContent=text;
    chatLog.append(line);
    while(chatLog.childElementCount>200)chatLog.firstElementChild.remove();
    setTimeout(()=>line.classList.add('expired'),7000);chatLog.scrollTop=chatLog.scrollHeight;
  }
  function openChat(prefill=''){
    if(!playing||chatOpen)return;
    chatOpen=true;clearInput();chatRoot.classList.add('open');chatLog.scrollTop=chatLog.scrollHeight;historyPos=sentHistory.length;
    chatRoot.hidden=false;chatBar.hidden=false;
    chatInput.value=prefill;
    chatInput.focus();
    chatInput.setSelectionRange(prefill.length,prefill.length);
  }
  function closeChat(){
    if(!chatOpen)return;
    chatOpen=false;chatRoot.classList.remove('open');chatBar.hidden=true;chatInput.value='';
    chatInput.blur();canvas.focus();
  }
  function sendChat(raw){
    const text=raw.trim();
    if(!text)return;
    if(text.startsWith('/'))runCommand(text.slice(1));
    else pushChat(`<你> ${text}`);
  }
  function runCommand(body){
    const parts=body.trim().split(/\s+/).filter(Boolean);
    const name=(parts.shift()||'').toLowerCase();
    const arg=(i,def='')=>String(parts[i]??def).toLowerCase();
    const ok=msg=>pushChat(msg,'system');
    const err=msg=>pushChat(msg,'error');
    const p=world.player;
    switch(name){
      case '':case 'help':case '?':
        ok('/gamemode <survival|creative|0|1>  切换游戏模式');
        ok('/weather <clear|rain|thunder>  切换天气');
        ok('/time <set|add> <day|noon|night|midnight|0-24000>  调整时间');
        ok('/tp <x> [y]  传送；/spawn 回到出生点');
        ok('/give <物品id> [数量]  给予物品；/clear 清空背包');
        ok('/kill 自杀；/seed 查看种子；/debug 开关调试信息');
        break;
      case 'gamemode':case 'gm':{
        const v=arg(0);
        const mode=['1','c','creative','创造'].includes(v)?'creative':['0','s','survival','生存'].includes(v)?'survival':null;
        if(!mode){err('用法：/gamemode <survival|creative>');break;}
        world.mode=mode;
        if(mode==='survival'){p.health=Math.max(1,p.health);p.food=20;}
        ok(`游戏模式已切换为 ${mode==='creative'?'创造模式':'生存模式'}`);
        hud(true);break;
      }
      case 'weather':{
        const v=arg(0);
        const w=['clear','sun','晴'].includes(v)?'clear':['rain','下雨'].includes(v)?'rain':['thunder','storm','雷暴'].includes(v)?'thunder':null;
        if(!w){err('用法：/weather <clear|rain|thunder>');break;}
        world.weather=w;world.weatherTimer=240+Math.random()*240;
        ok(`天气已切换为 ${({clear:'晴朗',rain:'下雨',thunder:'雷暴'})[w]}`);
        break;
      }
      case 'time':{
        const sub=arg(0),val=arg(1),base=Math.floor(world.time/DAY)*DAY;
        const marks={day:.08,noon:.25,sunset:.47,dusk:.53,night:.70,midnight:.75,sunrise:.97};
        if(sub==='set'){
          if(marks[val]!==undefined)world.time=base+marks[val]*DAY;
          else if(/^\d+(\.\d+)?$/.test(val))world.time=base+clamp(Number(val),0,24000)/24000*DAY;
          else{err('用法：/time set <day|noon|night|midnight|0-24000>');break;}
          ok('时间已设置');
        }else if(sub==='add'){
          const n=Number(val);
          if(!Number.isFinite(n)){err('用法：/time add <秒数>');break;}
          world.time+=n;ok(`时间前进了 ${n} 秒`);
        }else err('用法：/time <set|add> ...');
        break;
      }
      case 'tp':{
        const x=Number(parts[0]),rawY=parts[1];
        if(!Number.isFinite(x)){err('用法：/tp <x> [y]（y 用 F3 里显示的数值）');break;}
        const px=clamp(x,1,W-2);
        let py;
        if(rawY!==undefined&&Number.isFinite(Number(rawY)))py=clamp(H-Number(rawY),-10,H-2);
        else{
          py=null;
          for(let yy=1;yy<H-2;yy++)if(world.solid(px,yy)){py=yy-p.h-.2;break;}
          if(py===null)py=world.surface[Math.floor(px)]-2;
        }
        p.x=px;p.y=py;p.vx=0;p.vy=0;
        ok(`已传送到 X ${px.toFixed(1)} / Y ${(H-py).toFixed(1)}`);
        break;
      }
      case 'spawn':p.x=world.spawn.x;p.y=world.spawn.y;p.vx=0;p.vy=0;ok('已回到出生点');break;
      case 'give':{
        const id=(parts[0]||'').toLowerCase(),item=ITEMS[id];
        if(!item){err(`没有叫「${id}」的物品。试试 oak_log / stone / cobblestone / diamond_pickaxe`);break;}
        const want=clamp(Math.floor(Number(parts[1])||1),1,item.stack*36);
        const rest=world.add(id,want);
        ok(`已给予 ${item.name} × ${want-rest}${rest?`（背包满了，还剩 ${rest} 个没放下）`:''}`);
        hud(true);break;
      }
      case 'clear':world.inventory.fill(null);ok('背包已清空');hud(true);break;
      case 'kill':
        if(world.mode==='creative'){err('创造模式下不会死亡');break;}
        world.damage(100,'被 /kill 处死');break;
      case 'seed':ok(`世界种子：${world.seed}`);break;
      case 'day':world.time=Math.floor(world.time/DAY)*DAY+.25*DAY;ok('已是白天');break;
      case 'night':world.time=Math.floor(world.time/DAY)*DAY+.70*DAY;ok('已是夜晚');break;
      case 'debug':debugOn=!debugOn;$('#debug').hidden=!debugOn;if(debugOn)hud(true);ok(`调试信息 ${debugOn?'开':'关'}`);break;
      default:err(`未知指令 /${name}，输入 /help 查看可用指令`);
    }
  }
  // 输入框自己吃掉键盘事件，否则会冒泡到游戏那边触发移动、切换快捷栏
  chatInput.addEventListener('keydown',e=>{
    e.stopPropagation();
    if(e.key==='Enter'){const value=chatInput.value;if(value.trim()){sentHistory.push(value);if(sentHistory.length>100)sentHistory.shift();}closeChat();sendChat(value);}
    else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();historyPos=clamp(historyPos+(e.key==='ArrowUp'?-1:1),0,sentHistory.length);chatInput.value=sentHistory[historyPos]||'';}
    else if(e.key==='Escape'){e.preventDefault();closeChat();}
  });
  chatInput.addEventListener('keyup',e=>e.stopPropagation());
  chatInput.addEventListener('keypress',e=>e.stopPropagation());

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
      else if(!paused()){inventory('inv');openDialog($('#inventory-dialog'));}
      return;
    }
    if(paused())return;
    // 聊天：T 打开发言，/ 打开并预填斜杠
    if(e.code==='KeyT'&&!e.repeat){e.preventDefault();openChat('');return;}
    if((e.key==='/'||e.code==='Slash')&&!e.repeat){e.preventDefault();openChat('/');return;}
    if(['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.code))e.preventDefault();
    keys.add(e.code);
    // 疾跑：双击同一个方向键（MC 的经典手感）。不能用 Ctrl —— Ctrl+W = 关标签页。
    if(!e.repeat&&['KeyA','KeyD','ArrowLeft','ArrowRight'].includes(e.code)){
      const now=performance.now();
      if(e.code===lastDirCode&&now-lastDirAt<330)sprintHeld=true;
      lastDirCode=e.code;lastDirAt=now;
    }
    if(/^Digit[1-9]$/.test(e.code)){world.selected=Number(e.code.slice(-1))-1;hud(true);showItemName();}
    if(e.code==='KeyF'&&!e.repeat)use();
  });
  addEventListener('keyup',e=>{
    keys.delete(e.code);
    if(['KeyA','KeyD','ArrowLeft','ArrowRight'].includes(e.code)){sprintHeld=false;lastDirCode='';}
  });
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
      if(id===13){inventory('table');openDialog($('#inventory-dialog'));return;}
      world.place(aim.x,aim.y);hud(true);return;
    }
    mouseDown=true;canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup',()=>{mouseDown=false;world.mining=null;});
  canvas.addEventListener('pointercancel',clearInput);
  // 右键菜单：整个游戏区域一律屏蔽。
  // 以前只在 canvas 上挡，于是「背包里右键拿一半」「熔炉右键」还会弹出浏览器菜单，
  // 直接盖住界面，右键放置也常被它打断。绑在 #game 上靠冒泡就能覆盖所有 dialog
  // （dialog 走 top layer 但 DOM 位置没变，事件仍按 DOM 树冒泡）。
  // 只放行输入框：聊天、种子、创造栏搜索里右键粘贴是正常需求。
  $('#game').addEventListener('contextmenu',e=>{
    if(e.target.closest?.('input,textarea'))return;
    e.preventDefault();
  });
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
  $('#touch-inventory').onclick=()=>{if(playing){inventory('inv');openDialog($('#inventory-dialog'));}};

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
        // 原版 Shift 是蹲下（不是疾跑）。疾跑改成双击同一个方向键，
        // 不用 Ctrl —— 浏览器里 Ctrl+W 会直接关掉标签页。
        crouch:keys.has('ShiftLeft')||keys.has('ShiftRight')||touch.has('crouch'),
        sprint:sprintHeld,
      };
      world.setCrouch(!!input.crouch);
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
    // 云永远在飘（连标题画面也在飘），雨只在没暂停时下
    cloudOffset=(cloudOffset+dt*7)%CLOUD_SPAN;
    if(world.weather!=='clear'&&!paused()){
      const mul=world.weather==='thunder'?1.55:1;
      for(const d of rainDrops){
        d.y+=d.s*mul*dt;d.x+=d.s*.2*mul*dt;
        if(d.y>viewH+40){d.y=-40-Math.random()*90;d.x=Math.random()*viewW*1.3-viewW*.15;}
        if(d.x>viewW+50)d.x-=viewW+100;
      }
    }
    hudClock+=dt;
    if(hudClock>.12){
      hudClock=0;
      if(playing)hud();
      if($('#furnace-dialog').open)furnaceUI();   // 只刷熔炉进度，背包按操作刷新
      if($('#inventory-dialog').open&&craftMode!=='table')drawInvPlayer();
    }
    render();
    requestAnimationFrame(frame);
  }

  try{await loadImages();}
  catch(e){notify(e.message);playBtn.disabled=true;continueBtn.disabled=true;}
  bindWorld(world);
  // 给验证脚本留一个只读探针（不影响游戏本身）
  window.zfsnMC={get world(){return world;},audio,images,drawEntity,entityMesh,W,H,steveArmAngle,steveHand,
    /* 目录与数据表：探针要断言「原版目录接进来了」只能从这里读，
       它们是模块内 const，页面上没有别的入口。 */
    CATALOG,get blocks(){return BLOCKS;},get items(){return ITEMS;},get recipes(){return RECIPES;},
    get playing(){return playing;},get held(){return heldItem;},get chatOpen(){return chatOpen;},runCommand,refreshInv(){inventory();hud(true);},
    /* 世界坐标 → 屏幕像素。探针要靠它把鼠标精确点到某个方块上，
       不然只能靠猜屏幕位置（相机跟随玩家，位置一直在变）。 */
    screenOf(wx,wy){return{x:Math.round(wx*tile-camX),y:Math.round(wy*tile-camY)};},
    get view(){return{camX,camY,tile};}};
  requestAnimationFrame(frame);
}
