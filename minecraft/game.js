import {CATALOG} from './catalog.js?v=dcbd02b6';
import * as C from './config.js';
import {
  EMPTY, Container, Slot, DragSession, stack as makeStack, sameStack,
  buildPlayerSlots, buildTableSlots, LAYOUT, ARMOR_PARTS, armorPartOf,
  normalizeRecipes, matchRecipe, consumeForCraft,
} from './inventory.js';
import {createIconRenderer, resolveFaces, iconKind, BLOCK_FACES} from './icons.js';
import {ICON_IDS} from './icons/index.js';
import * as K from './combat.js';
import {FluidEngine, packFluid, unpackFluid, fluidPushVector, setFluidBlocks,
        WATER as FLUID_WATER, LAVA as FLUID_LAVA} from './fluids.js';
/* ── 地形生成（纯逻辑层）─────────────────────────────────────────────
 * worldgen/ 目录不依赖游戏、不碰 DOM，Node 的 node:test 可以直接 import，
 * 所以生成算法（地形/群系/洞穴/矿石/植被/结构）与渲染完全分离。
 * worldbridge.js 负责把 worldgen 的「方块名 + 调色板 + y 向上」翻译成
 * 游戏这一侧的「BLOCKS 下标 + y 向下」。 */
import {WorldGen} from './worldgen/worldgen.js';
import {CHUNK_W, WORLD_HEIGHT as WG_WORLD_HEIGHT, WORLDGEN_VERSION, SAFE_X,
        resolveWorldType} from './worldgen/constants.js';
import {buildPalette, paletteHash, toGameY, toWgY,
        WG_EXTRA_BLOCKS, WG_DECOR, WG_THIN_LAYER} from './worldbridge.js';
import {MOBS, MOB_ITEM_PLACEHOLDERS, isHostile} from './mobRegistry.js';
import * as M from './mobConstants.js';
import {createMobState, serializeMob, restoreMobState, resetMobIds, feedMob, breedPair,
        tameMob, setSitting, nameMob, attachLeash, mount, dismount, driveMount,
        tradeOffers, performTrade} from './mobComponents.js';
import {rollMobDrops, rollMobXp} from './mobDrops.js';
import {planSpawnGroup, shouldDespawn} from './mobSpawn.js';
import {MobRuntime} from './mobRuntime.js';
/* Standalone 2D sandbox. Distances are blocks; simulation runs at a fixed 20 TPS.
 * No server calls, accounts, game-client code, or third-party runtime required. */
// 模拟时间以秒累计（update(dt) 把 dt 加进 time/elapsed），但物理一律在
// 固定 20 TPS 的 tick() 里推进：每 tick 50ms，与真实帧率无关。
// 一昼夜 72,000 步 → 20 分钟（活跃游玩）。
// 世界尺寸。384×144 → 640×160 → 4096×256（32 屏宽、8 屏高，104 万格）。
// 改这两个数字必须同步改存档版本（World.restore 会做尺寸迁移）。
export const W = 4096, H = 256, DAY = 20 * 60;
/* 原版数值统一从 config.js 取，这里只做别名，方便阅读 */
const TICK = C.TICK, TICK_RATE = C.TICK_RATE;
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
/* ── 流体方块：追加在 CATALOG 之后，绝不移动既有方块 id（老存档兼容） ──
 * 岩浆/黑曜石不进 CATALOG（目录里的方块会被当成普通可合成方块），这里手动注册。
 * 方块索引在加载后才确定，所以运行期用 id 查表，不写死数字。 */
BLOCKS.push({id:'lava',name:'岩浆',solid:false,hard:Infinity});
BLOCKS.push({id:'obsidian',name:'黑曜石',hard:3,tool:'pickaxe',tier:3});
/* ── 地形生成需要的非整方块（草、花、仙人掌、铁轨、箱子…）─────────────
 * 目录脚本只把「整方块」加进 BLOCKS（上面那个 CATALOG 循环），
 * 而草/花/蘑菇/铁轨在原版里不是整方块，只进了 ITEMS —— 地形生成要往世界里
 * 写它们，所以必须补进 BLOCKS。
 * ★ 全部追加在表尾：既有方块下标一个不动 → 老存档的方块 id 仍然有效。 */
for(const b of WG_EXTRA_BLOCKS)if(!BLOCKS.some(x=>x.id===b.id))BLOCKS.push({...b});
/* ── worldgen 调色板 ↔ 游戏方块表 的对应 ────────────────────────────────
 * 调色板 = worldgen 的 61 个方块名 + 其余游戏方块的 id。
 * 索引语义必须稳定（存档、跨区块写入都依赖它），所以顺序固定、内容变化时
 * 指纹会变（存档头里存指纹，用来判断老存档还能不能直接读）。 */
const WG_BRIDGE = buildPalette(BLOCKS);
const WG_PALETTE_ID = WG_BRIDGE.palette;
const WG_NAME_TO_ID = WG_BRIDGE.nameToId;
const WG_TO_BLOCK = WG_BRIDGE.toBlock;      // 调色板下标 → BLOCKS 下标
const WG_BLOCK_TO_NAME = WG_BRIDGE.toName;  // BLOCKS 下标 → worldgen 名
const WG_PALETTE_HASH = paletteHash(WG_PALETTE_ID);
const CACTUS_ID=BLOCKS.findIndex(b=>b.id==='cactus');
const WATER_ID = 17;                                          // 既有水面方块 id（勿改，老档依赖）
/* 流体状态的稀疏键：y 恒在 0~255，所以 x*256+y 对任意（正负）x 都唯一。 */
const FLUID_KEY=(x,y)=>x*256+y;
/* 有生物模型的被动生物（目录里 76 个刷怪蛋只有这几种真能刷出来）。 */
const SPAWNABLE_MOBS=new Set(['pig','cow','sheep','chicken']);
const LAVA_ID = BLOCKS.findIndex(b=>b.id==='lava');
const OBSIDIAN_ID = BLOCKS.findIndex(b=>b.id==='obsidian');
const COBBLE_ID = BLOCKS.findIndex(b=>b.id==='cobblestone');
setFluidBlocks({water:WATER_ID, lava:LAVA_ID, obsidian:OBSIDIAN_ID, cobblestone:COBBLE_ID, stone:3});
/** 可被流体冲掉并掉落物品的方块（火把/花草/雪层等）；实心方块流体进不去。 */
const FLUID_REPLACEABLE = new Set([16]);
/* 地形生成带出来的装饰（草、花、蕨、雪层、铁轨…）同样能被水冲掉。
   否则水会「灌进草里」，草却还立在那儿。 */
for(let i=0;i<BLOCKS.length;i++){
  const id=BLOCKS[i].id;
  if(WG_DECOR.has(id)||WG_THIN_LAYER.has(id))FLUID_REPLACEABLE.add(i);
}
export const ITEMS = Object.fromEntries(BLOCKS.slice(1).map((b,i)=>[b.id,{...b,block:i+1,stack:64}]));
Object.assign(ITEMS,{
  charcoal:{name:'木炭'},stick:{name:'木棍'},coal:{name:'煤炭'},raw_iron:{name:'粗铁'},iron_ingot:{name:'铁锭'},diamond:{name:'钻石'},
  apple:{name:'苹果',food:4},porkchop:{name:'生猪排',food:3},cooked_porkchop:{name:'熟猪排',food:8},
  beef:{name:'生牛肉',food:3},cooked_beef:{name:'牛排',food:8},chicken:{name:'生鸡肉',food:2},cooked_chicken:{name:'熟鸡肉',food:6},mutton:{name:'生羊肉',food:2},cooked_mutton:{name:'熟羊肉',food:6},feather:{name:'羽毛'},leather:{name:'皮革'},egg:{name:'鸡蛋'},bucket:{name:'桶',stack:16},water_bucket:{name:'水桶',stack:1},lava_bucket:{name:'岩浆桶',stack:1},
});
for (const [material,tier,speed,durability] of [['wooden',1,2,59],['stone',2,4,131],['iron',3,6,250],['diamond',4,8,1561]]) {
  for (const [tool,name] of [['pickaxe','镐'],['axe','斧'],['sword','剑'],['shovel','锹']]) {
    const w=K.weaponStats({tool,id:`${material}_${tool}`});
    ITEMS[`${material}_${tool}`]={name:({wooden:'木',stone:'石',iron:'铁',diamond:'钻石'})[material]+name,tool,tier,speed,durability,stack:1,
      damage:tool==='sword'?tier+3:tool==='axe'?tier+2:2,attackDamage:w.attackDamage,attackSpeed:w.attackSpeed};
  }
}
for(const entry of CATALOG){
  if(!ITEMS[entry.id])ITEMS[entry.id]={name:entry.name,catalogOnly:true};
  ITEMS[entry.id].category=entry.category;ITEMS[entry.id].cubeIcon=entry.cube;
  /* 方块图标的三面贴图声明（见 icons.js）：{top,bottom,left,right,overlay,tint}。
     名字对不上时 resolveFaces 会按 _side/_top/_front 的命名规则退化。 */
  if(entry.cube)ITEMS[entry.id].faces=resolveFaces(entry.id);
  if(/sword|bow|helmet|chestplate|leggings|boots|shield|trident/.test(entry.id))ITEMS[entry.id].category='combat';
  if(/crafting_table|furnace|chest$|barrel|anvil|enchanting_table|loom|smithing_table|cartography_table|stonecutter/.test(entry.id))ITEMS[entry.id].category='functional';
}
for(const b of BLOCKS)b.faces=resolveFaces(b.id);
for(const b of BLOCKS)if(ITEMS[b.id])ITEMS[b.id].faces=b.faces;
for(const [mat,tier,speed,durability]of [['golden',1,12,32],['netherite',5,9,2031]])for(const tool of ['pickaxe','axe','sword','shovel']){
  const item=ITEMS[`${mat}_${tool}`];if(item){const w=K.weaponStats({tool,id:`${mat}_${tool}`});Object.assign(item,{catalogOnly:false,tool,tier,speed,durability,stack:1,
    damage:tool==='sword'?tier+3:tool==='axe'?tier+2:2,attackDamage:w.attackDamage,attackSpeed:w.attackSpeed});}
}
for(const [id,food]of Object.entries({bread:5,carrot:3,potato:1,baked_potato:5,beetroot:1,cookie:2,melon_slice:2,sweet_berries:2,glow_berries:2,dried_kelp:1,cod:2,cooked_cod:5,salmon:2,cooked_salmon:6,rabbit:3,cooked_rabbit:5,golden_carrot:6}))if(ITEMS[id])Object.assign(ITEMS[id],{food,catalogOnly:false});
/* 生物掉落需要的物品若目录没有，补明确占位；不静默删除掉落。 */
for(const [id,name] of Object.entries(MOB_ITEM_PLACEHOLDERS))if(!ITEMS[id])ITEMS[id]={id,name,catalogOnly:false,mobPlaceholder:true};
for(const mob of Object.keys(MOBS))if(ITEMS[mob+'_spawn_egg'])Object.assign(ITEMS[mob+'_spawn_egg'],{mob,catalogOnly:false});
/* 目录里其余刷怪蛋保留明确提示（多为尚未要求的新版本生物）。 */
for(const id of Object.keys(ITEMS))if(/_spawn_egg$/.test(id)&&!ITEMS[id].mob)ITEMS[id].spawnEgg=true;
/* ── 原版堆叠上限 ──────────────────────────────────────────────
   绝大多数物品是 64，这里只判定「原版就是 1」的那几类。
   ★ 上面 47~59 行虽然给工具写死了 stack:1，但两轮循环只覆盖
     pickaxe/axe/sword/shovel × 6 种材质，且完全没有盔甲 ——
     剩下的 hoe、盔甲、弓弩、盾、鞘翅等 catalogOnly 物品会落到默认 64，
     创造栏拿一次就是 64 个钻石胸甲，背包里也能叠成一摞。
   ★ 判定按 id 模式而不是 category：catalog 的分类有污染
     （bowl 被分成 equipment，waxed_* 铜块也在 equipment 里），
     按 category 判定会把这堆可堆叠方块一起误伤成 1。 */
/* 敌对生物类型表（第 9 节）：决定生成规则、经验值、是否受和平难度保护。 */
const HOSTILE_TYPES=['zombie','skeleton','creeper','spider'];
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

/* 盔甲与弓的原版耐久。以前这些 id 没有 durability 字段：穿戴后磨不了损、
   存档往返也会把耐久丢掉（restore 只在 ITEMS.durability 存在时才保留 dur）。 */
const ARMOR_DURABILITY={
  leather:{helmet:55,chestplate:80,leggings:75,boots:65},
  chainmail:{helmet:165,chestplate:240,leggings:225,boots:195},
  gold:{helmet:77,chestplate:112,leggings:105,boots:91},
  golden:{helmet:77,chestplate:112,leggings:105,boots:91},
  iron:{helmet:165,chestplate:240,leggings:225,boots:195},
  diamond:{helmet:363,chestplate:528,leggings:495,boots:429},
  netherite:{helmet:407,chestplate:592,leggings:555,boots:481},
  turtle:{helmet:275},
};
for(const[id,item]of Object.entries(ITEMS)){
  if(item.durability)continue;
  const m=id.match(/^(leather|chainmail|golden|gold|iron|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/);
  if(m)item.durability=ARMOR_DURABILITY[m[1]][m[2]];
  else if(id==='bow')item.durability=384;
  else if(id==='crossbow')item.durability=465;
  else if(id==='trident')item.durability=250;
  else if(id==='shield')item.durability=336;
  else if(id==='elytra')item.durability=432;
  else if(id==='fishing_rod')item.durability=64;
  else if(id==='flint_and_steel')item.durability=64;
  else if(id==='shears')item.durability=238;
}

/* ── 盔甲 ──
   每件护甲的防御点数（原版数值）。damage() 按 4%/点减伤，上限 80%。 */
const ARMOR_SLOT_POINTS={
  leather:{helmet:1,chestplate:3,leggings:2,boots:1},
  chainmail:{helmet:2,chestplate:5,leggings:4,boots:1},
  gold:{helmet:2,chestplate:5,leggings:3,boots:1},
  golden:{helmet:2,chestplate:5,leggings:3,boots:1},
  iron:{helmet:2,chestplate:6,leggings:5,boots:2},
  diamond:{helmet:3,chestplate:8,leggings:6,boots:3},
  netherite:{helmet:3,chestplate:8,leggings:6,boots:3},
  turtle:{helmet:2},
};
function armorSlotPoints(id){
  const m=id.match(/^(leather|chainmail|golden|gold|iron|diamond|netherite|turtle)_/);
  const part=id.match(/_(helmet|chestplate|leggings|boots)$/);
  return m&&part?(ARMOR_SLOT_POINTS[m[1]]?.[part[1]]??0):0;
}
/* 盔甲部位 → 穿戴模型层贴图（tools/import_minecraft_extras.py 导出的
   原版 models/armor/*_layer_*）。layer_1 覆盖头/胸/靴，layer_2 是护腿。 */
function armorTexture(id,part){
  const m=id.match(/^(leather|chainmail|golden|gold|iron|diamond|netherite|turtle)_/);
  if(!m)return null;
  const mat=m[1]==='golden'?'gold':m[1];
  return `armor/${mat}_${part==='leggings'?2:1}`;
}
/* ── 可投掷物品（右键抛出，和箭共用一套实体数组） ──
   kind 同时是贴图名（icons 里就有 snowball/egg/ender_pearl…）。
   damage=0 的（雪球/鸡蛋）只造成击退，不扣血 —— 和原版一致。 */
const THROWABLE={
  snowball:{speed:21,damage:0},
  egg:{speed:21,damage:0,hatch:.125},
  ender_pearl:{speed:19,damage:0,teleport:true},
  experience_bottle:{speed:19,damage:0},
  firework_rocket:{speed:15,damage:0,grav:6},
  fire_charge:{speed:17,damage:2},
  splash_potion:{speed:17,damage:4,splash:true},
  lingering_potion:{speed:17,damage:3,splash:true},
};
/* 模块级：boot 里的 partOf 在闭包里，World 的方法用这个 */
function armorPart(id){const m=String(id).match(/_(helmet|chestplate|leggings|boots)$/);return m?m[1]:null;}

/* ── 配方 ──────────────────────────────────────────────────────
 * 两种写法并存：
 *   {needs:{id:数量}}               无序，只比材料总数（1 个原木 → 4 木板）
 *   {pattern:[...], key:{X:id}}     有序，支持平移与左右镜像（工具、火把…）
 * 有序配方会自动补出 needs，所以配方书/一键合成/旧存档逻辑全都照旧。
 */
export const RECIPES = normalizeRecipes([
  {out:'oak_planks',n:4,needs:{oak_log:1}},
  {out:'stick',n:4,pattern:['P','P'],key:{P:'oak_planks'}},
  {out:'crafting_table_front',n:1,pattern:['PP','PP'],key:{P:'oak_planks'}},
  {out:'torch',n:4,pattern:['C','S'],key:{C:'coal',S:'stick'}},
  {out:'furnace_front',n:1,pattern:['CCC','C C','CCC'],key:{C:'cobblestone'},station:true},
  {out:'bucket',n:1,pattern:['I I',' I '],key:{I:'iron_ingot'},station:true},
  {out:'torch',n:4,pattern:['C','S'],key:{C:'charcoal',S:'stick'}},
  {out:'stone_bricks',n:4,pattern:['SS','SS'],key:{S:'stone'}},
  {out:'sandstone',n:1,pattern:['SS','SS'],key:{S:'sand'}},
]);
/* 工具：原版的经典摆法 */
const TOOL_SHAPES = {
  pickaxe: ['XXX',' S ',' S '],
  axe:     ['XX','XS',' S'],
  sword:   ['X','X','S'],
  shovel:  ['X','S','S'],
};
for(const [material,ingredient] of [['wooden','oak_planks'],['stone','cobblestone'],['iron','iron_ingot'],['diamond','diamond']]) {
  for(const [tool,pattern] of Object.entries(TOOL_SHAPES)) {
    RECIPES.push(normalizeRecipes([{out:`${material}_${tool}`,n:1,pattern,key:{X:ingredient,S:'stick'},station:true}])[0]);
  }
}
for(const [block,item] of [['iron_block','iron_ingot'],['diamond_block','diamond'],['coal_block','coal']]){
  RECIPES.push(normalizeRecipes([{out:block,n:1,pattern:['XXX','XXX','XXX'],key:{X:item},station:true}])[0],{out:item,n:9,needs:{[block]:1}});
}
for(const wood of ['spruce','birch','jungle','acacia','dark_oak','mangrove','cherry']){
  if(ITEMS[wood+'_log']&&ITEMS[wood+'_planks'])RECIPES.push({out:wood+'_planks',n:4,needs:{[wood+'_log']:1}},{out:'stick',n:4,pattern:['P','P'],key:{P:wood+'_planks'}});
}
const FUELS={coal:80,charcoal:80,coal_block:800,oak_planks:15,oak_log:15,stick:5};
/* 合成残留物（原版 crafting remainder）：桶装材料合成后留下空容器 */
const CRAFT_REMAINDER={water_bucket:'bucket',lava_bucket:'bucket',milk_bucket:'bucket',honey_bottle:'glass_bottle'};
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
/* ── 旧版扁平世界生成器 ─────────────────────────────────────────────
 * 已由 worldgen/ 纯逻辑层取代（见文件顶部 import）。旧实现是「随机游走地表 +
 * 随机游走洞穴 + 逐格撒矿」，同种子可复现但没有群系/高度连续性，也撑不起无限世界。
 * 保留注释里的思路说明，实际生成一律走 WorldGen（分块、按需加载、顺序无关）。
 */
export class World {
  constructor(seed='ZFSN',mode='survival',options={}){
    this.seed=String(seed);this.mode=mode;
    /* 世界类型：默认 / 超平坦 / 巨大群系；结构与洞穴可以单独关掉（创建世界界面）。 */
    this.worldType=resolveWorldType(options.worldType,options);
    this.worldTypeKey=this.worldType.id;
    /* ── 分块式世界 ───────────────────────────────────────────────────
     * 存储交给纯逻辑层 worldgen/：X 轴按需生成/卸载（安全范围 ±2^25），
     * Y 固定 0~255。这一层只做「坐标 + 方块表」的翻译：
     *   · 游戏的 y 向下（0 是天空、255 是基岩），worldgen 的 y 向上（0 是基岩）
     *     → 每次跨层访问翻一次（见 worldbridge.js 的 toWgY/toGameY）
     *   · worldgen 用调色板下标，游戏用 BLOCKS 下标
     *     → WG_TO_BLOCK（调色板→游戏）/ WG_BLOCK_TO_NAME（游戏→调色板）
     * 生成是「同种子 + 同坐标 = 同结果」，与区块生成顺序无关（规格书 §1/§12）。 */
    this.wg=new WorldGen(this.seed,this.worldType,{palette:WG_PALETTE_ID,nameToId:WG_NAME_TO_ID});
    /* 流体状态：只存「与默认态不同」的格子（默认：水=源块、量 8）。
     * 无限世界里开不起一整张 W*H 的表，所以按坐标稀疏存。
     * 天然生成的水/岩浆全是源块（见 worldgen 的 buildColumn），天然稳定。 */
    this.fluidMap=new Map();
    /* 旧存档导入时保留原地形高度（迁移区不能被新算法改外观）。 */
    this.legacySurface=null;
    const sp=this.wg.findSpawn();
    this.spawn={x:sp.x,y:toGameY(sp.y)-2};
    /* ★ 玩家速度 vx/vy 的单位是「格/tick」，不是格/秒 —— 物理跑在固定 20 TPS 的
       tick() 里（见 tickPlayer）。这样「每 tick vy *= 0.6」这类原版数值可以
       照抄，也不会因为帧率不同而手感不同。 */
    this.player={...this.spawn,w:.65,h:1.8,vx:0,vy:0,ground:false,health:20,maxHealth:20,food:20,saturation:5,exhaustion:0,
      absorption:0,invulnerableTicks:0,lastDamage:0,knockbackResistance:0,deathTime:0,onFire:0,
      armorPoints:0,armorToughness:0,armorKBR:0,
      invuln:0,face:1,crouch:false,swing:0,swingDur:.26,
      flying:false,pvy:0,px:this.spawn.x,py:this.spawn.y,
      armor:{helmet:null,chestplate:null,leggings:null,boots:null},
      ticksSinceLastAttack:99,lastHeldId:null,strength:1,sprintLockTicks:0,
      shieldRaised:false,shieldTicks:0,shieldCooldown:0,shieldHeld:false,
      eating:0,eatItem:null,level:0,xp:0,airTicks:0,drownTicks:0,
      /* 创造模式玩家无敌（虚空除外）：伤害管线 combat.js 直接读这个标记。
         ★ 必须在创建时就写好 —— 之前漏写导致创造模式玩家照样掉血。 */
      creative:mode==='creative'};
    this.inventory=Array(36).fill(null);this.craftGrid=Array(4).fill(null);
    this.offhand=null;
    /* 挖掘状态机：进度绑定在「正在挖哪一格」上，而不是「鼠标按着」这个状态。
       blockHitDelay 用 tick 计数（5 tick = 0.25 秒）。 */
    this.breakState={pos:null,progress:0,hitDelay:0};
    this.isBreaking=false;
    this.tickAcc=0;      // 未消化的秒数（update → tick 的累加器）
    this.tickCount=0;    // 已执行的 tick 数（双击空格/疾跑都用它判窗口）
    this.alpha=0;        // 0..1，渲染插值用
    this.lastSpaceTick=-999;
    // 工作台 3×3 与背包 2×2 是两个独立容器（原版就是这样，互不串味）
    this.tableGrid=Array(9).fill(null);
    this.selected=0;this.time=120;this.elapsed=0;this.drops=[];this.mobs=[];this.particles=[];this.furnaces={};this.attackCooldown=0;this.difficulty=C.DEFAULT_DIFFICULTY;this.regenTimer=0;this.starveTimer=0;this.mobClock=0;this.gravityClock=0;this.deathReason='';this.keepInventory=false;this.revision=0;this.shake=0;this.notify=()=>{};
    this.autoStep=false;   // 自动跳跃（上台阶辅助），默认关；由 UI 层按本地设置打开
    this.arrows=[];this.drawBow=null;   // 弓：拉弓状态 {t} 与空中/插住的箭
    // 天气：clear / rain / thunder。rain 会压暗天空并下粒子，thunder 额外打闪电。
    this.weather='clear';this.weatherTimer=0;this.lightning=0;this.rainDrops=[];
    this.rng=random(hash(seed)^0xabcd);this.sound=()=>{};
    this.W=W;this.H=H;    // fluids.js 适配器契约：引擎要用 world.W 计算格索引
    this.fluidEngine=new FluidEngine();this.fluidEngine.attach(this);
    this.stepClock=0;this.ambientClock=0;this.wasInWater=false;this.wasInFluid=false;
    /* ★ 天然生成的水/岩浆已经是「源方块」，默认态就是源头、量 8，
     *   所以不需要像旧版那样扫全图 104 万格做预热（那会卡住开局好几秒）。
     *   只有玩家改动过的流体格才需要进 fluidMap，也才需要唤醒调度。 */
    this.scanFluidBoundaries();
    this.mobRuntime=new MobRuntime(this);
    this.spawnedChunks=new Set();this.vibrations=[];
    this.player.sleeplessTicks=0;
    if(mode==='creative') ['grass_block_side','dirt','stone','oak_log','oak_planks','glass','torch','crafting_table_front','furnace_front'].forEach(id=>this.add(id,64));
    /* 生物按群系刷怪表生成（规格书 §2.5）：只挑该群系 mobs 里有的种类，
       且必须站在该群系的地面上。世界是无尽的，所以只铺玩家附近这一段。 */
    this.spawnInitialMobs();
  }
  /* ── 方块读写 ────────────────────────────────────────────────────────
   * 坐标系：游戏是 2D 侧视，y 向下（y=0 天空，y=255 基岩）；
   * worldgen 是 y 向上（y=0 基岩）。跨层访问一律经 toWgY/toGameY 换算。 */
  get(x,y){
    x=Math.floor(x);y=Math.floor(y);
    if(y<0)return 0;                 // 天空之上：空气
    if(y>=H)return 4;                // 基岩之下：当作基岩
    if(x<-SAFE_X||x>SAFE_X)return 4; // 超出整数安全范围：挡住
    return WG_TO_BLOCK[this.wg.getIndex(x,toWgY(y))];
  }
  /* 通用方块写入。★ 任何方块变化后都会唤醒相邻流体重新计算（任务书 2.），
     放置流体方块则按源头写入并调度自身。 */
  set(x,y,id){
    x=Math.floor(x);y=Math.floor(y);
    if(y<0||y>=H)return;
    if(x<-SAFE_X||x>SAFE_X)return;
    const name=WG_BLOCK_TO_NAME[id];
    if(!name)return;
    this.wg.set(x,toWgY(y),name);   // 写区块 + 标记「玩家改过」+ 清 natural
    const key=FLUID_KEY(x,y);
    if(id===WATER_ID||id===LAVA_ID){
      this.fluidMap.set(key,packFluid({type:id===LAVA_ID?FLUID_LAVA:FLUID_WATER,amount:8,falling:false,isSource:true}));
      this.fluidEngine.schedule(this,x,y,this.fluidEngine.tickDelay(id===LAVA_ID?FLUID_LAVA:FLUID_WATER,this));
    }else this.fluidMap.delete(key);
    this.revision++;
    this.fluidEngine.notifyBlockChanged(this,x,y);
  }
  /* 批量写方块（调试/测试用）：直接写区块，不触发流体调度。 */
  setRaw(x,y,id){
    x=Math.floor(x);y=Math.floor(y);
    if(y<0||y>=H)return;
    const name=WG_BLOCK_TO_NAME[id];
    if(!name)return;
    this.wg.set(x,toWgY(y),name);
  }
  /* 这一列的地表高度（游戏坐标，y 向下）。等价于旧版的 world.surface[x]。 */
  surfaceAt(x){
    x=Math.floor(x);
    if(this.legacySurface&&this.legacySurface.has(x))return this.legacySurface.get(x);
    return toGameY(this.wg.terrain.surfaceY(x));
  }
  /* 实际地面（河流/湖泊会把地表切低，所以它可能比 surfaceAt 更靠下）。 */
  groundAt(x){ return toGameY(this.wg.terrain.groundY(Math.floor(x))); }
  /* 那一列的群系 id（调试面板 / 刷怪表用）。 */
  biomeAt(x){ return this.wg.biomeAt(Math.floor(x)); }
  /* 水面高度（-1 表示这一列没有水）。 */
  waterSurfaceAt(x){ return toGameY(this.wg.terrain.waterSurfaceY(Math.floor(x))); }
  /* 流体格的水量（渲染时用来画水面高度；默认源块 = 8）。 */
  fluidAmount(x,y){
    const f=this.fluidGet(x,y);
    return f?f.amount:0;
  }
  /* 开局的生物：按群系刷怪表选种类，站在该群系的地面上。
     只铺玩家附近一段（±64 格）—— 世界是无限的，没必要铺满整张图。 */
  spawnInitialMobs(){
    const p=this.player,cx0=Math.floor((p.x-64)/CHUNK_W),cx1=Math.floor((p.x+64)/CHUNK_W);
    for(let cx=cx0;cx<=cx1;cx++){
      const chunk=this.wg.getChunk(cx);
      const bx=Math.floor(chunk.x0+this.rng()*(chunk.x1-chunk.x0+1)),biome=this.wg.biomeAt(bx);
      if(!biome)continue;
      const positions=[];
      for(let i=0;i<3;i++){
        const x=Math.floor(chunk.x0+this.rng()*(chunk.x1-chunk.x0+1)),gy=this.groundAt(x),ground=this.get(x,gy);
        const water=biome.isOcean||this.get(x,gy-1)===WATER_ID;
        positions.push({x,y:water?gy-2:gy,biome:biome.id,light:15,onBlock:WG_BLOCK_TO_NAME[ground]||BLOCKS[ground]?.id,inWater:water,distance:Math.abs(x-p.x)});
      }
      const ctx={biome:biome.id,light:15,night:false,underground:false,onBlock:positions[0]?.onBlock,inWater:!!biome.isOcean,dimension:'overworld',distance:0,difficulty:this.difficulty,playerX:p.x,sleeplessTicks:0};
      for(const plan of planSpawnGroup(ctx,positions,()=>this.rng(),this.mobs)){
        const mob=this.makeMob(plan.type,plan.x,plan.y,plan.variantContext);
        if(!MOBS[plan.type].spawnRules.inWater)mob.y=plan.y-mob.h;
        if(!this.collides(mob)){mob.spawnedByWorld=true;this.mobs.push(mob);}
      }
      this.spawnedChunks.add(cx);
    }
  }
  /* 兼容旧调用：on=true 倒源头，on=false 舀走（仅源头，流动态留给舀桶逻辑）。 */
  setWaterSource(x,y,on=true){
    x=Math.floor(x);y=Math.floor(y);
    if(y<0||y>=H||x<-SAFE_X||x>SAFE_X)return;
    if(on)this.fluidEngine.pour(this,x,y,FLUID_WATER);
    else this.fluidEngine.scoop(this,x,y);
  }
  /* ── fluids.js 适配器：World 把自己的存储翻译成引擎要的最小接口 ──────
     纯逻辑（扩散/交互/调度）全部在 fluids.js，这里只做读写与分类。 */
  fluidGet(x,y){
    x=Math.floor(x);y=Math.floor(y);
    if(y<0||y>=H)return null;
    if(x<-SAFE_X||x>SAFE_X)return null;
    const id=this.get(x,y);
    if(id!==WATER_ID&&id!==LAVA_ID)return null;
    const v=this.fluidMap.get(FLUID_KEY(x,y));
    if(v!==undefined)return unpackFluid(v);
    /* 没有记录 = 默认态：源块、量 8（天然生成的水/岩浆都是源块）。 */
    return {type:id===LAVA_ID?FLUID_LAVA:FLUID_WATER,amount:8,falling:false,isSource:true};
  }
  fluidSet(x,y,cell){
    if(y<0||y>=H)return;
    if(x<-SAFE_X||x>SAFE_X)return;
    if(!cell){
      const id=this.get(x,y);
      if(id===WATER_ID||id===LAVA_ID)this.set(x,y,0);
      this.fluidMap.delete(FLUID_KEY(x,y));
    }else{
      this.set(x,y,cell.type===FLUID_LAVA?LAVA_ID:WATER_ID);
      this.fluidMap.set(FLUID_KEY(x,y),packFluid(cell));
    }
    this.revision++;
  }
  fluidSetBlock(x,y,id){this.set(x,y,id);}
  fluidSolid(x,y){
    if(y<0||y>=H)return true;
    if(x<-SAFE_X||x>SAFE_X)return true;
    const id=this.get(x,y);
    if(id===WATER_ID||id===LAVA_ID)return false;
    const b=BLOCKS[id];
    return b?b.solid!==false:true;
  }
  fluidBlocking(){return false;}                   // 本作暂无门/告示牌类 BLOCKING 方块
  fluidReplaceable(x,y){
    if(y<0||y>=H)return false;
    return FLUID_REPLACEABLE.has(this.get(x,y));
  }
  fluidIsAir(x,y){
    if(y<0||y>=H)return false;
    return this.get(x,y)===0;
  }
  /* 被流体冲掉的可替换方块：按掉落规则掉成物品（火把 → torch …） */
  fluidDropItem(x,y){
    const id=this.get(x,y);
    if(!id)return;
    const b=BLOCKS[id];
    const drop=b.drop===undefined?b.id:b.drop;
    if(drop)this.drop(drop,1,x+.35,y+.35);
    this.blockParticles(id,x+.5,y+.5);
  }
  /* 嘶嘶：白烟 + 音效（水与岩浆交互时由引擎调用） */
  fluidSizzle(x,y){
    this.particle('smoke',x+.5,y+.35,8,{color:'#e8e8e8',spread:.5,speed:1.6,lift:3.2,gravity:-.6,life:.55,size:.09});
    this.sound('splash',x,.4);
  }
  getDimension(){return 'overworld';}
  /** 生成/读档用：唤醒「玩家改动过的流体格」及其邻居。
   *  ★ 天然生成的水/岩浆全是源方块（见 worldgen 的 buildColumn），天然稳定，
   *    不用像旧版那样扫全图 104 万格做预热 —— 那会卡住开局好几秒。 */
  scanFluidBoundaries(){
    for(const key of this.fluidMap.keys()){
      const x=Math.floor(key/256),y=key-x*256;
      const f=this.fluidGet(x,y);
      if(!f)continue;
      this.fluidEngine.schedule(this,x,y,this.fluidEngine.tickDelay(f.type,this));
      this.fluidEngine.scheduleNeighbors(this,x,y);
    }
  }
  /* 自然生成的树木（原木 id=5 / 树叶 id=6）不参与碰撞 —— 玩家能直接走过去，
     这就是用户要的「自然生成的树可以自由穿过」。玩家自己放下的原木/树叶
     走路时会立刻把 natural 清 0，所以它们是正常实体方块。 */
  isThru(x,y){
    const fx=Math.floor(x),fy=Math.floor(y);
    if(fy<0||fy>=H||fx<-SAFE_X||fx>SAFE_X)return false;
    return this.wg.naturalAt(fx,toWgY(fy))===1;
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
  /* 哪只手有盾：主手优先。副手盾只在「主手物品没有可使用动作」时接管右键 ——
     原版也是这样：副手举盾不影响主手吃东西/放方块/用刷怪蛋。 */
  mainHandUsable(){
    const slot=this.held(),item=ITEMS[slot?.id];
    if(!item)return false;
    if(item.block||item.mob||item.food||item.potion||armorPartOf(slot.id)||THROWABLE[slot.id])return true;
    return ['bucket','water_bucket','lava_bucket','milk_bucket','honey_bottle',
            'flint_and_steel','bone_meal','clock','compass'].includes(slot.id)
      || slot.id.startsWith('music_disc_');
  }
  shieldHand(){
    if(this.held()?.id==='shield')return 'main';
    if(this.offhand?.id==='shield'&&!this.mainHandUsable())return 'offhand';
    return null;
  }
  nearBlock(id,radius=3){const p=this.player;for(let y=Math.floor(p.y)-radius;y<p.y+p.h+radius;y++)for(let x=Math.floor(p.x)-radius;x<p.x+radius;x++)if(this.get(x,y)===id)return{x,y,key:`${x},${y}`};return null;}
  canCraft(recipe){return(!recipe.station||this.nearBlock(13)||this.mode==='creative')&&Object.entries(recipe.needs).every(([id,n])=>this.count(id)>=n);}
  craft(recipe){
    if(!this.canCraft(recipe))return false;
    const before=structuredClone(this.inventory);for(const [id,n] of Object.entries(recipe.needs))this.remove(id,n);
    if(this.add(recipe.out,recipe.n)){this.inventory=before;this.notify('背包已满，先腾出一个格子');return false;}
    this.notify(`合成了 ${ITEMS[recipe.out].name} × ${recipe.n}`);this.sound('click',this.player.x,.4);return true;
  }
  giveCreative(id){if(this.mode!=='creative'||!ITEMS[id]||['bedrock','water_still','lava'].includes(id))return;this.inventory[this.selected]={id,n:ITEMS[id].stack,...(ITEMS[id].durability?{dur:ITEMS[id].durability}:{})};}
  /* 2×2 合成网格：只认不需要工作台的配方，也就是「拿着就能做」的那几个。
     木板 / 木棍 / 工作台 / 火把 都在这条线上，正好是开局要用的。*/
  /* 网格 → 配方。有序配方按形状匹配（允许平移、允许左右镜像），
     无序配方只比每种材料的总数。station=false 时排除需要工作台的配方。 */
  recipeIn(grid,station=false){
    if(!grid?.length)return null;
    const w=grid.length>=9?3:2;
    return matchRecipe(RECIPES,grid,w,w,{station,mirror:true});
  }
  findGridRecipe(){return this.recipeIn(this.craftGrid,false);}
  findTableRecipe(){return this.recipeIn(this.tableGrid,true);}
  takeRecipe(grid,station=false){
    const recipe=this.recipeIn(grid,station);if(!recipe)return false;
    const w=grid.length>=9?3:2;
    const before=grid.slice();
    const out=consumeForCraft(grid,w,w,recipe,CRAFT_REMAINDER);
    if(!out||this.add(out.out,out.n)){
      for(let i=0;i<grid.length;i++)grid[i]=before[i];
      this.notify('背包已满，先腾出一个格子');return false;
    }
    this.sound('click',this.player.x,.4);
    this.notify(`合成了 ${ITEMS[out.out].name} × ${out.n}`);return true;
  }
  takeGridRecipe(){return this.takeRecipe(this.craftGrid,false);}
  takeTableRecipe(){return this.takeRecipe(this.tableGrid,true);}
  /* 交互距离：创造 5 格，生存 4.5 格（原版数值）。 */
  reach(){
    return this.mode==='creative'?C.REACH_CREATIVE:C.REACH_SURVIVAL;
  }
  reachable(x,y,reach){
    if(reach===undefined)reach=this.reach();
    const p=this.player,dx=x+.5-(p.x+p.w/2),dy=y+.5-(p.y+.7),dist=Math.hypot(dx,dy);
    if(x<0||x>=W||y<0||y>=H||dist>reach)return false;
    for(let step=.15;step<dist-.5;step+=.15){const xx=p.x+p.w/2+dx*step/dist,yy=p.y+.7+dy*step/dist;if(Math.floor(xx)===x&&Math.floor(yy)===y)break;if(this.solid(xx,yy))return false;}
    return true;
  }
  wear(){if(this.mode==='creative')return;const slot=this.held();if(slot?.dur&&--slot.dur<=0){this.notify(`${ITEMS[slot.id].name} 已损坏`);this.sound('break_tool',this.player.x,.6);this.inventory[this.selected]=null;}}
  /* 攻击磨损：剑每次 -1，其它工具 -2（原版耐久消耗）。 */
  wearAttack(){if(this.mode==='creative')return;const slot=this.held();if(!slot?.dur)return;const item=ITEMS[slot.id];const dec=item?.tool==='sword'?1:2;slot.dur-=dec;if(slot.dur<=0){this.notify(`${ITEMS[slot.id].name} 已损坏`);this.sound('break_tool',this.player.x,.6);this.inventory[this.selected]=null;}}
  /* 击退：生物的速度单位是「格/秒」，而击退公式（原版单位）是「格/tick」。
     统一换算：进公式前 ÷TICK_RATE，出公式后 ×TICK_RATE ——
     否则 0.4 的击退推力在生物身上只有 0.4 格/秒，
     根本抵不过它自己 1.45 格/秒的追击速度（会被「推着继续追」）。 */
  knockbackMob(mob,opts){
    const kb=K.knockback({x:mob.x,vx:mob.vx/TICK_RATE,vy:mob.vy/TICK_RATE,ground:mob.ground,
      knockbackResistance:mob.knockbackResistance,armorKBR:mob.armorKBR},opts);
    mob.vx=kb.vx*TICK_RATE;mob.vy=kb.vy*TICK_RATE;mob.face=kb.dir>0?1:-1;
    return kb;
  }
  /* 所有生物伤害统一走 combat.hurt：护甲、无敌帧、击退抗性、死亡都在同一入口。
   * 玩家攻击、箭、环境、其他生物攻击都必须调用这里，不再直接 health-=。 */
  hurtMob(mob,amount,opts={}){
    if(!mob||mob.dying)return {ignored:true};
    if(mob.projectileImmune&&opts.type==='projectile')return {ignored:true};
    const res=K.hurt(mob,amount,{...opts,difficulty:opts.difficulty??this.difficulty,peacefulHostile:opts.peacefulHostile??isHostile(mob.type)});
    if(res.ignored)return res;
    mob.hurt=.25;
    if(opts.type==='fire'||opts.type==='lava')mob.burned=true;
    if(opts.attackerId){mob.lastAttackerId=opts.attackerId;mob.targetMemory=M.TARGET_MEMORY_TICKS;mob.aggro=true;
      const rec=MOBS[mob.type];if(rec?.category==='hostile'||rec?.category==='neutral')mob.targetId=opts.attackerId;}
    if(opts.attackerId==='player')mob.killedByPlayer=true;
    if(opts.attackerX!==undefined&&opts.knockback!==false)this.knockbackMob(mob,{attackerX:opts.attackerX,sprint:opts.sprint||false,kbLevel:opts.kbLevel||0});
    if(MOBS[mob.type]?.category==='passive')mob.panic=M.MOB_HURT_PANIC_TICKS;
    this.hitParticles(mob.x+mob.w/2,mob.y+mob.h*.42,!!opts.crit);
    this.sound(mob.type,mob.x,.6);
    if(res.died||mob.health<=0)this.killMob(mob);
    return res;
  }
  /* 实体是否正贴着仙人掌（碰到就掉血）。 */
  touchingCactus(e){
    if(CACTUS_ID<0)return false;
    const x0=Math.floor(e.x),x1=Math.floor(e.x+e.w-.01),y0=Math.floor(e.y),y1=Math.floor(e.y+e.h-.01);
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++)if(this.get(x,y)===CACTUS_ID)return true;
    return false;
  }
  /* 玩家受伤：格/tick 约定，直接套公式即可。 */
  knockbackPlayer(player,opts){
    const kb=K.knockback(player,opts);
    player.vx=kb.vx;player.vy=kb.vy;
    return kb;
  }
  /* 击杀：进入 20 tick 的倒地动画，动画结束才消失并掉落。
   * ★ 提示词第 9 节：「生物死亡 20 tick 倒地动画后再消失并掉落」。
   *   以前是一击就把生物从数组里删掉 —— 玩家看不到「打倒了」，
   *   也看不到掉落实体凭空出现。 */
  killMob(mob){
    if(mob.dying||mob.health>0)return;
    mob.dying=true;mob.deathTicks=0;mob.deathMax=C.MOB_DEATH_TICKS;
    mob.vx=0;mob.vy=0;mob.panic=0;mob.face=mob.face||1;
    this.particle('death',mob.x+mob.w/2,mob.y+mob.h*.45,14,{color:'#f16a6a',spread:.75,speed:4,lift:4.2,gravity:8,life:.6});
    this.sound(mob.type,mob.x,.7);
  }
  /* 倒地动画结束：真正消失并掉落战利品 + 经验球。 */
  finishMobDeath(mob){
    const idx=this.mobs.indexOf(mob);if(idx>=0)this.mobs.splice(idx,1);
    const looting=mob.looting||0;
    for(const [id,n] of rollMobDrops(mob,{rng:()=>this.rng(),burned:mob.burned,looting,playerKill:mob.killedByPlayer,chargedCreeper:mob.killedByChargedCreeper,skeletonKill:mob.killedBySkeleton}))this.drop(id,n,mob.x,mob.y);
    if(mob.killedByPlayer){const xp=rollMobXp(mob,{rng:()=>this.rng()});if(xp>0)this.drop('xp_orb',xp,mob.x,mob.y);}
    const rec=MOBS[mob.type];
    if(rec?.components?.split&&(mob.size??2)>0){
      const childSize=mob.size-1,count=2+Math.floor(this.rng()*3);
      for(let i=0;i<count;i++){
        const child=this.makeMob(mob.type,mob.x+(this.rng()-.5),mob.y,{size:childSize});
        child.killedByPlayer=mob.killedByPlayer;this.mobs.push(child);
      }
    }
  }
  /* 两点之间是否无遮挡（骷髅开枪前要确认视线）。 */
  lineOfSight(a,b){
    const x0=a.x+a.w/2,y0=a.y+a.h/2,x1=b.x+b.w/2,y1=b.y+b.h/2;
    const dist=Math.hypot(x1-x0,y1-y0);if(dist<.01)return true;
    const steps=Math.ceil(dist/.25);
    for(let i=1;i<steps;i++){const t=i/steps;if(this.solid(x0+(x1-x0)*t,y0+(y1-y0)*t))return false;}
    return true;
  }
  /* 骷髅射箭：直接生成一支箭（不能用 spawnProjectile —— 那个从玩家位置出生）。 */
  skeletonShoot(m,p){
    const ox=m.x+m.w/2,oy=m.y+m.h*.6;
    const ang=Math.atan2((p.y+p.h*.5)-oy,(p.x+p.w/2)-ox);
    const speed=18,cs=Math.cos(ang),sn=Math.sin(ang);
    this.arrows.push({x:ox+cs*.6,y:oy+sn*.6,vx:cs*speed,vy:sn*speed,ang,age:0,stuck:false,dead:false,
      damage:C.MOB_ARROW_DAMAGE,grav:C.ARROW_GRAVITY*C.TICK_RATE*C.TICK_RATE,kind:'arrow',
      tex:'arrow_projectile',pickup:false,owner:'mob'});
    this.sound('shoot',m.x,.5);
  }
  /* 苦力怕爆炸：按距离衰减伤害 + 击退。
     ★ 只处理「对生物的伤害」，炸方块与范围破坏留给路线 2（explode）实现，
       这里不重复造，避免两条路线改同一段代码。
     ★ 爆炸伤害「受护甲影响」（提示词第 2 节把爆炸列在受护甲影响的一类里）。 */
  creeperExplode(m){
    const p=this.player;
    this.particle('explosion',m.x+m.w/2,m.y+m.h/2,20,{color:'#ff9a3c',spread:1.4,speed:5,lift:5,gravity:9,life:.5});
    this.sound('explode',m.x,.8);
    if(this.mode!=='creative'){
      const dist=Math.hypot((p.x+p.w/2)-(m.x+m.w/2),(p.y+p.h/2)-(m.y+m.h/2));
      if(dist<=C.CREEPER_RADIUS+1){
        const falloff=clamp(1-(dist-1)/C.CREEPER_RADIUS,0,1);
        const dmg=C.CREEPER_DAMAGE*falloff;
        if(dmg>0)this.damage(dmg,'苦力怕爆炸',{type:'explosion',attackerX:m.x});
        this.knockbackPlayer(p,{attackerX:m.x,sprint:false,kbLevel:1});
      }
    }
    const idx=this.mobs.indexOf(m);if(idx>=0)this.mobs.splice(idx,1);
  }
  /** 触发一次挥臂（放置/攻击/吃东西/挖穿最后一下）。
   *  ★ 已经在挥的时候不重置：连点鼠标会把动作永久卡在第一帧，
   *    表现成「手一直在最高点抖」。让它自然播完更接近原版。 */
  swing(dur=.26){const p=this.player;if(p.swing>0)return;p.swing=p.swingDur=dur;}
  /* 粒子只属于当次游玩画面，不写入存档。上限避免连锁挖矿或战斗拖慢手机。 */
  particle(kind,x,y,count=1,extra={}){
    const cap=Math.max(0,480-this.particles.length),n=Math.min(count,cap);
    for(let i=0;i<n;i++){
      const life=extra.life??(.32+this.rng()*.28);
      this.particles.push({kind,x:x+(this.rng()-.5)*(extra.spread??.25),y:y+(this.rng()-.5)*(extra.spread??.25),
        vx:extra.vx??(this.rng()-.5)*(extra.speed??2.6),vy:extra.vy??(-this.rng()*(extra.lift??2.6)),
        life,maxLife:life,size:extra.size??(.075+this.rng()*.085),id:extra.id,color:extra.color,gravity:extra.gravity??8,drag:extra.drag??.9,
        u:Math.floor(this.rng()*12),v:Math.floor(this.rng()*12)});
    }
  }
  blockParticles(id,x,y){this.particle('block',x,y,12,{id,spread:.78,speed:3.4,lift:3.5,gravity:11,life:.46});}
  hitParticles(x,y,critical=false){this.particle(critical?'crit':'hit',x,y,critical?8:5,{spread:.42,speed:critical?3.3:2.2,lift:3.4,gravity:5,life:.38,color:critical?'#60eaff':'#e64545'});}
  updateParticles(dt){
    for(const q of this.particles){q.life-=dt;q.vy+=(q.gravity??8)*dt;q.x+=q.vx*dt;q.y+=q.vy*dt;q.vx*=Math.pow(q.drag??.9,dt*60);}
    this.particles=this.particles.filter(q=>q.life>0&&q.y<H+3);
  }
  /* 镜头抖动衰减（每帧调用，指数回 0）。 */
  decayShake(dt){if(this.shake>0)this.shake=Math.max(0,this.shake-dt*2.4);}
  drop(id,n,x,y,dur){if(n>0)this.drops.push({id,n,x,y,w:.3,h:.3,vx:(this.rng()-.5)*2,vy:-3,age:0,...(dur?{dur}:{})});}
  /* ── 挖掘状态机 ─────────────────────────────────────────────────
   *
   * 旧实现的根本问题：进度挂在 this.mining 上、而 mining 只在「鼠标按着」时
   * 才存在；挖穿一块之后 this.mining=null，下一帧按住鼠标又新建一个
   * progress=0 的 —— 看起来正常，但只要鼠标在挖穿的那一帧已经移到别的方块
   * （或创造模式那种「一帧一格」），新坐标就直接吃到残留的进度/瞬时破坏，
   * 于是「拖着鼠标扫过去，一路方块全掉」。
   *
   * 现在的状态（与原版 ServerPlayerGameMode 对齐）：
   *   breakState.pos        正在挖的方块坐标（null = 没在挖）
   *   breakState.progress   0..1，绑定在 pos 上，换方块一定清零
   *   breakState.hitDelay   剩余的冷却 tick（松手也继续递减）
   *   isBreaking            鼠标左键是否按住（由 UI 层每 tick 写入）
   */
  /** 当前指向、且在交互距离内的方块；没有就返回 null。 */
  aimTarget(aim){
    if(!aim||!Number.isFinite(aim.x)||!Number.isFinite(aim.y))return null;
    const x=Math.floor(aim.x),y=Math.floor(aim.y);
    if(y<0||y>=H||x<0||x>=W)return null;
    const id=this.get(x,y);
    if(id===0)return null;
    if(!this.reachable(x,y))return null;
    return {x,y,id};
  }
  /** 创造模式手持剑不能挖方块（原版：剑只能打生物）。 */
  swordBlocksMining(){
    const s=this.held();
    return !!(s&&/_sword$/.test(s.id)&&!ITEMS[s.id]?.block);
  }
  /** 破坏成功后的收尾：掉粒子、掉落物、熔炉里的东西、工具耐久。
   *  drops=false 用在创造模式（不掉落、不磨损）。 */
  destroyBlock(x,y,drops=true){
    const id=this.get(x,y),block=BLOCKS[id];
    if(!id||!block)return;
    const key=`${x},${y}`;
    const tool=ITEMS[this.held()?.id];
    const correct=tool?.tool===block.tool;
    const harvest=!block.tier||(correct&&tool.tier>=block.tier);
    this.set(x,y,0);
    this.blockParticles(block.id,x+.5,y+.5);
    this.sound('dig_'+material(block),x,.6);
    if(drops&&this.mode!=='creative'){
      if(harvest){
        if(id===6){if(this.rng()<.12)this.drop('apple',1,x+.35,y+.35);else if(this.rng()<.3)this.drop('stick',1,x+.35,y+.35);}
        else{const drop=block.drop===undefined?block.id:block.drop;if(drop)this.drop(drop,1,x+.35,y+.35);}
      }
      this.wear();
    }
    const furnace=this.furnaces[key];if(furnace){if(furnace.input)this.drop(furnace.input,1,x,y);if(furnace.output)this.drop(furnace.output,furnace.count,x,y);delete this.furnaces[key];}
    this.player.exhaustion+=C.EXHAUSTION.mine;
    this.revision++;
  }
  /** 每个逻辑 tick 调一次。不管是「按住」「松开」还是「冷却」，都要调用，
   *  因为 blockHitDelay 必须在松手后继续自然递减。 */
  tickMining(aim){
    const bs=this.breakState;
    if(bs.hitDelay>0){bs.hitDelay--;return;}
    if(!this.isBreaking){bs.progress=0;bs.pos=null;return;}
    const target=this.aimTarget(aim);
    if(!target){bs.progress=0;bs.pos=null;return;}
    /* 换目标 = 从头开始。这一句就是「挖完泥土拖到石头上，石头立刻掉」的修复点。 */
    if(!bs.pos||bs.pos.x!==target.x||bs.pos.y!==target.y){
      bs.pos={x:target.x,y:target.y};
      bs.progress=0;
    }
    const block=BLOCKS[target.id];
    if(!Number.isFinite(block.hard)){bs.progress=0;return;}       // 基岩：永远挖不动

    /* 创造：第一次点击立即破坏，之后每 5 tick 破坏一个「当前指向」的方块 */
    if(this.mode==='creative'){
      if(this.swordBlocksMining())return;
      this.destroyBlock(target.x,target.y,false);
      this.swing();
      bs.progress=0;bs.pos=null;bs.hitDelay=C.BLOCK_HIT_DELAY;
      return;
    }

    /* 生存：每 tick 进度 += 破坏速度 / 硬度 / (能采集 ? 30 : 100) */
    const tool=ITEMS[this.held()?.id];
    const correct=tool?.tool===block.tool;
    const harvest=!block.tier||(correct&&tool.tier>=block.tier);
    let speed=correct?(tool.speed||1):C.TOOL_SPEED_HAND;
    /* 悬空挖得慢。用「脚下有没有方块」而不是只看 ground：ground 是上一 tick
       的碰撞结果，刚落地/刚读档时会有一 tick 的空窗，进度会莫名变慢。 */
    const airborne=!this.player.ground&&!this.footSupported(this.player);
    if(airborne)speed/=C.BREAK_AIRBORNE_PENALTY;
    if(this.get(this.player.x+this.player.w/2,this.player.y+.6)===17)speed/=C.BREAK_UNDERWATER_PENALTY;
    const hardness=Math.max(0,block.hard);
    if(hardness>0)bs.progress+=speed/hardness/(harvest?C.BREAK_DIVISOR_HARVEST:C.BREAK_DIVISOR_NO_HARVEST);
    else bs.progress=1;

    // 挥臂相位单独计时：不同硬度下挥动速度要一致
    this.swingT=(this.swingT||0)+TICK;
    if(this.swingT>.23){this.swingT=0;this.sound('dig_'+material(block),target.x,.22);}
    if(bs.progress<1-1e-9)return;      // 浮点累加：0.00333×300 会差一个 ulp

    this.destroyBlock(target.x,target.y,true);
    this.swing();
    bs.progress=0;bs.pos=null;bs.hitDelay=C.BLOCK_HIT_DELAY;
  }
  /** 松开左键 / 打开界面：立刻清空挖掘状态（hitDelay 不清，让它继续走）。 */
  stopMining(){
    this.isBreaking=false;
    this.breakState.progress=0;
    this.breakState.pos=null;
  }
  /* 兼容旧调用（tools/dev/test_minecraft.mjs 还在用 mine(x,y,1/60) 循环）：
     把秒数累加进 tick 队列，再按 20 TPS 逐个 tick 推进。 */
  mine(x,y,dt=1/60){
    this._mineAcc=(this._mineAcc||0)+dt;
    const aim={x:x+.5,y:y+.5};
    this.isBreaking=true;
    while(this._mineAcc>=TICK-1e-9){
      this._mineAcc-=TICK;
      this.tickMining(aim);
      if(this.breakState.hitDelay>0)break;    // 冷却中：等外部继续喂时间
    }
    this.isBreaking=false;
    return this.breakState.progress;
  }
  place(x,y){
    x=Math.floor(x);y=Math.floor(y);const slot=this.held(),item=ITEMS[slot?.id];
    /* 刷怪蛋：右键通常点在「地面方块」上（实心格），旧代码要求目标格是空气，
       于是所有刷怪蛋都静默失效。现在把生物放到目标方块顶面；点到空气时
       就放在该格里。再向上找最多 6 格，避免卡进天花板 / 其它实体。 */
    if(item?.mob&&this.reachable(x,y)){
      const mob=this.makeMob(item.mob,x,0,{spawnedByEgg:true});
      const baseY=this.solid(x,y)?y:y+1;
      mob.x=x;mob.y=baseY-mob.h;
      for(let i=0;i<6&&this.collides(mob);i++)mob.y-=1;
      if(this.collides(mob))return false;
      this.mobs.push(mob);
      if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;
      this.swing();return true;
    }
    /* ── 桶（任务书 5.）：倒源头 / 舀源头（流动态不可舀）／倒到异类流体触发转化。
       创造模式不消耗桶（桶保持原样），生存模式空桶↔满桶互换。 ── */
    const bucketTarget=(id)=>{const t=this.get(x,y);return this.reachable(x,y)&&(t===0||t===id||this.fluidReplaceable(x,y));};
    if(slot?.id==='water_bucket'&&bucketTarget(WATER_ID)){
      if(this.fluidReplaceable(x,y))this.fluidDropItem(x,y);
      this.fluidEngine.pour(this,x,y,FLUID_WATER);   // 倒到岩浆上 → 由引擎转化（黑曜石/圆石）
      this.particle('splash',x+.5,y+.4,10,{color:'#62b7ff',spread:.7,speed:2.8,lift:3.3,gravity:10,life:.42});
      if(this.mode!=='creative')this.inventory[this.selected]={id:'bucket',n:1};
      this.sound('splash',x,.6);this.swing();return true;
    }
    if(slot?.id==='lava_bucket'&&bucketTarget(LAVA_ID)){
      if(this.fluidReplaceable(x,y))this.fluidDropItem(x,y);
      this.fluidEngine.pour(this,x,y,FLUID_LAVA);
      this.particle('smoke',x+.5,y+.4,8,{color:'#e8e8e8',spread:.6,speed:2,lift:3.2,gravity:-.5,life:.5,size:.09});
      if(this.mode!=='creative')this.inventory[this.selected]={id:'bucket',n:1};
      this.sound('splash',x,.6);this.swing();return true;
    }
    if(slot?.id==='bucket'&&this.reachable(x,y)){
      const t=this.get(x,y);
      const fill=(fluidId,itemId)=>{this.fluidEngine.scoop(this,x,y);this.particle('splash',x+.5,y+.4,7,{color:fluidId===LAVA_ID?'#e8712a':'#62b7ff',spread:.6,speed:2.4,lift:2.7,gravity:10,life:.38});
        if(this.mode!=='creative'){if(slot.n===1)this.inventory[this.selected]={id:itemId,n:1};else{slot.n--;if(this.add(itemId))this.drop(itemId,1,this.player.x,this.player.y);}}
        this.sound('splash',x,.5);this.swing();return true;};
      if(t===WATER_ID)return fill(WATER_ID,'water_bucket');
      if(t===LAVA_ID)return fill(LAVA_ID,'lava_bucket');
    }
    /* 普通方块：可以直接放在水/岩浆格里（原版行为），放置成功后流体被替换 */
    if(!item?.block||!this.reachable(x,y)||![0,WATER_ID,LAVA_ID].includes(this.get(x,y)))return false;
    if(![[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([xx,yy])=>this.solid(xx,yy)))return false;
    const rect={x,y,w:1,h:1};if(item.solid!==false&&(overlap(rect,this.player)||this.mobs.some(m=>overlap(rect,m))))return false;
    this.set(x,y,item.block);this.sound('dig_'+material(item),x,.5);if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;this.swing();return true;
  }
  eat(){const slot=this.held(),item=ITEMS[slot?.id];if(!item?.food||this.player.food>=20)return false;this.player.food=Math.min(20,this.player.food+item.food);this.particle('crumb',this.player.x+this.player.w/2,this.player.y+this.player.h*.42,6,{id:slot.id,color:'#e3b35d',spread:.35,speed:2.1,lift:2.8,gravity:7,life:.34,size:.06});if(this.mode!=='creative'&&--slot.n<=0)this.inventory[this.selected]=null;this.notify('补充了饱食度');this.sound('eat',this.player.x,.6);this.swing();return true;}
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
  makeMob(type,x,y,opts={}){
    const m=createMobState(type,x,y,{rng:()=>this.rng(),tick:this.tickCount,...opts});
    const rec=MOBS[type];
    m.movementType=rec.movementType;m.dying=false;m.deathTicks=0;m.deathMax=M.MOB_DEATH_TICKS;
    m.aggro=false;m.white=false;m.burned=false;m.killedByPlayer=false;
    return m;
  }
  damage(amount,reason,opts={}){
    const p=this.player;
    opts.difficulty=opts.difficulty??this.difficulty??C.DEFAULT_DIFFICULTY;
    /* 盾牌格挡：仅近战/投射物、且来自玩家朝向一侧、举起满 5 tick。
       格挡本身也走统一伤害管线（opts.blocked），这样「被挡」同样会进入
       无敌帧、不会扣血，只额外触发盾牌耐久与斧击冷却。 */
    let blocked=false;
    if(!opts.void&&p.shieldRaised&&(opts.type==='melee'||opts.type==='projectile')){
      const attackerSide=(opts.attackerX??p.x)>=p.x?1:-1;
      blocked=K.shieldBlocks({raised:true,raisedTicks:p.shieldTicks,facing:p.face,attackerSide,type:opts.type});
      if(blocked){
        this.wearShield(K.shieldDurabilityLoss(amount));
        if(opts.weaponIsAxe)p.shieldCooldown=C.SHIELD_AXE_COOLDOWN;   // 斧击盾 → 100 tick 冷却
        this.sound('shield_block',p.x,.6);
      }
    }
    const before=K.hurt(p,amount,{...opts,blocked,shieldKnockback:blocked});
    if(before.ignored)return before;
    if(blocked){
      // 被挡：给一小份击退（原版举盾被击中也会被推动一点）
      const kb=this.knockbackPlayer(p,{attackerX:opts.attackerX??p.x,sprint:false,kbLevel:0});
      p.vx=kb.vx*.4;p.vy=kb.vy*.4;
      this.notify('挡住了攻击');
      return before;
    }
    if(p.eating>0){p.eating=0;p.eatItem=null;}   // 受伤打断进食
    K.addExhaustion(p,C.EXHAUSTION.hurt);     // 受伤消耗度 0.1
    if(before.armorWore)this.wearArmor(amount);
    this.hitParticles(p.x+p.w/2,p.y+p.h*.45,false);
    this.particle('hurt',p.x+p.w/2,p.y+p.h*.45,8,{color:'#ef3434',spread:.55,speed:3.2,lift:3.8,gravity:7,life:.46});
    this.sound('hurt',p.x,.6);
    /* 镜头抖动：受击时画面震一下（提示词第 5/12 节「玩家受击镜头抖动」） */
    this.shake=Math.min(1,(this.shake??0)+.55);
    if(p.health<=0){this.particle('death',p.x+p.w/2,p.y+p.h*.45,18,{color:'#ef3434',spread:.7,speed:4.2,lift:4.4,gravity:8,life:.65});this.deathReason=reason||'冒险途中';this.startDeath();}
    return before;
  }
  /* 玩家死亡：掉落物品（keepInventory 则保留）、掉落经验、进入 deathTime 动画 */
  startDeath(){
    const p=this.player;if(p.deathTime>0)return;
    p.deathTime=0.01;this.notify('你倒下了');
    if(!this.keepInventory){
      for(const s of this.inventory)if(s)this.drop(s.id,s.n,p.x,p.y,s.dur);
      this.inventory.fill(null);
      for(const[k,s]of Object.entries(p.armor))if(s)this.drop(s.id,1,p.x,p.y,s.dur);
      p.armor={helmet:null,chestplate:null,leggings:null,boots:null};this.recalcArmor();
      if(p.offhand)this.drop(p.offhand.id,p.offhand.n,p.x,p.y,p.offhand.dur);
      const xp=K.xpOnDeath(p.level);if(xp>0)this.drop('xp_orb',xp,p.x,p.y);
    }
  }
  /* 护甲数值重算：穿戴/脱下时调用，存成数值供伤害管线直接读。 */
  recalcArmor(){
    const s=K.armorStats(this.player.armor);
    this.player.armorPoints=s.points;this.player.armorToughness=s.toughness;this.player.armorKBR=s.kbr;
  }
  armorPoints(){return this.player.armorPoints;}
  /* 受伤时每件穿戴的护甲磨 max(1, floor(damage/4)) 点耐久 */
  wearArmor(amount){if(this.mode==='creative')return;
    const wear=K.armorWearAmount(amount);
    for(const[k,s]of Object.entries(this.player.armor)){
      if(!s?.dur)continue;
      s.dur-=wear;if(s.dur<=0){this.notify(`${ITEMS[s.id].name} 破碎了`);this.sound('break_tool',this.player.x,.5);this.player.armor[k]=null;this.recalcArmor();}
    }}
  /* 盾牌格挡后的耐久消耗：扣「正在举着的那面」——主手有盾就用主手，
     否则用副手。以前会在背包里随便找第一面盾，副手盾反而永远不磨损。 */
  wearShield(loss){
    if(this.mode==='creative')return;
    const main=this.held();
    const slot=main?.id==='shield'?main:(this.offhand?.id==='shield'?this.offhand:null);
    if(!slot?.dur)return;
    slot.dur-=loss;
    if(slot.dur<=0){
      this.notify('盾牌碎了');this.sound('break_tool',this.player.x,.5);
      if(slot===main)this.inventory[this.selected]=null;else this.offhand=null;
    }
  }
  /* ── 弓 ── */
  hasArrow(){return this.mode==='creative'||this.inventory.some(s=>s&&s.id==='arrow');}
  /* 抛射物的出生点：沿射线外移 0.8 格，若仍卡在方块里就再往外挪。
     ★ 以前箭是固定在 x+0.55（加玩家半宽 = 距中心 0.875 格）出生的：
       贴着墙、斜坡或半砖时出生点直接落在方块内部 → 第一帧就 stuck，
       而 stuck 又满足「1.5 格内自动拾取」→ 同一帧被收回背包，
       表现就是「箭一射出去立刻消失」。 */
  spawnProjectile(ang,prop){
    const p=this.player,ox=p.x+p.w/2,oy=p.y+p.h*.66;
    const cs=Math.cos(ang),sn=Math.sin(ang);
    let sx=ox+cs*.8,sy=oy+sn*.8;
    /* 出身体这 0.8 格若正好压在方块里（贴脸射墙 / 斜坡），沿射线让开一点。
       只让 0.45 格：再多就等于「穿墙射出去了」。剩下的交给第一步的碰撞检测 ——
       箭会插在墙面上，不再是「原地消失」。 */
    for(let i=0;i<3&&this.solid(sx,sy);i++){sx+=cs*.15;sy+=sn*.15;}
    return {x:sx,y:sy,vx:cs*prop.speed,vy:sn*prop.speed,ang,age:0,stuck:false,dead:false,
      damage:prop.damage??0,grav:prop.grav??22,kind:prop.kind,tex:prop.tex,
      pickup:!!prop.pickup,teleport:!!prop.teleport,splash:!!prop.splash,hatch:prop.hatch||0,
      owner:prop.owner||'mob'};   // owner='player' 的箭不会打中自己
  }
  /* 发射角度 = 光标相对胸口的方向。以前箭永远水平飞（只有一点点固定上抬），
     瞄哪儿都不影响弹道，抬头射箭会直接钻进脚前的土里。 */
  aimAngle(aim){
    const p=this.player,ox=p.x+p.w/2,oy=p.y+p.h*.66;
    if(aim&&Number.isFinite(aim.x)&&Number.isFinite(aim.y)){
      const dx=aim.x-ox,dy=aim.y-oy;
      if(Math.hypot(dx,dy)>.6)return Math.atan2(dy,dx);
    }
    return p.face>0?0:Math.PI;
  }
  shootBow(power,aim){
    if(!this.hasArrow())return false;
    power=clamp(power,0,1);
    const speed=K.arrowSpeed(power)*C.TICK_RATE;            // 格/tick → 格/sec（匹配投射物积分）
    /* 满蓄力 = 「暴击箭」：额外随机伤害（提示词第 10 节）。
       ★ 创造模式射出的箭不可拾取（原版创造模式不产箭、也捡不到）。 */
    let dmg=Math.max(1,K.arrowDamage(power));
    if(power>=1)dmg+=K.bowCritExtraDamage(()=>this.rng());
    const a=this.spawnProjectile(this.aimAngle(aim),{speed,kind:'arrow',tex:'arrow_projectile',
      pickup:this.mode!=='creative',owner:'player',
      damage:dmg,
      grav:C.ARROW_GRAVITY*C.TICK_RATE*C.TICK_RATE});        // 格/tick² → 格/sec²
    if(this.mode!=='creative'){
      const i=this.inventory.findIndex(s=>s&&s.id==='arrow');
      if(i<0)return false;
      if(--this.inventory[i].n<=0)this.inventory[i]=null;
    }
    this.arrows.push(a);this.swing(.25);this.wear();
    return true;
  }
  /* 投掷物的落地效果（箭不走这里：箭是插住等人捡） */
  impact(a){
    const p=this.player;
    if(a.teleport){
      /* 珍珠命中时坐标已经陷进方块里（撞的是表面再往里一步），
         直接按落点放玩家会和被撞的方块重叠 —— 必须向上找空位，
         否则「传送失败」而且什么都看不到。 */
      const x=clamp(a.x-p.w/2,0,W-1);
      let y=clamp(a.y-p.h,0,H-p.h);
      const free=(yy)=>!this.collides({x,y:yy,w:p.w,h:p.h});
      for(let i=0;i<12&&!free(y);i++)y-=0.25;
      if(!free(y))for(let i=0;i<12&&!free(y);i++)y+=0.25;
      if(free(y)){p.x=x;p.y=y;p.vx=0;p.vy=0;p.invuln=Math.max(p.invuln,.5);}
      this.sound('click',p.x,.6);return;
    }
    if(a.splash){
      this.particle('splash',a.x,a.y,16,{color:'#8e62ff',spread:1.1,speed:4.1,lift:4.2,gravity:8,life:.52});
      for(const m of this.mobs)if(Math.hypot(m.x-a.x,m.y-a.y)<3)this.hurtMob(m,a.damage,{type:'splash',attackerX:a.x,attackerId:a.owner==='player'?'player':undefined,crit:true});
      this.sound('splash',a.x,.7);return;
    }
    if(a.hatch&&this.rng()<a.hatch&&this.mobs.length<60){
      const m=this.makeMob('chicken',a.x,a.y);
      if(!this.collides(m))this.mobs.push(m);
    }
    this.sound('click',a.x,.4);
  }
  /* 消耗手上 1 个（或 replace 成别的物品）。创造模式不消耗。 */
  consumeHeld(n=1,replace=null){
    if(this.mode==='creative')return;
    const slot=this.held();if(!slot)return;
    slot.n-=n;
    if(slot.n<=0)this.inventory[this.selected]=replace?{id:replace,n:1}:null;
  }
  drinkPotion(){
    const p=this.player;
    const heal=Math.min(20-p.health,6);
    p.health+=heal;p.food=Math.min(20,p.food+2);
    this.consumeHeld(1);this.sound('eat',p.x,.6);this.swing();
    return heal>0?`喝下药水，恢复了 ${Math.ceil(heal/2)} 颗心`:'喝下药水，状态已经很好了';
  }
  throwItem(id,t,aim){
    const a=this.spawnProjectile(this.aimAngle(aim),{speed:t.speed,kind:id,tex:id,
      damage:t.damage,grav:t.grav,teleport:t.teleport,splash:t.splash,hatch:t.hatch});
    this.arrows.push(a);this.consumeHeld(1);this.swing(.25);
    return '';
  }
  /* ── 手持物品「使用」（右键 / F） ───────────────────────────────
     放置类（方块、刷怪蛋、水桶）由 place() 先试；这里负责「不放置方块、
     但原版右键有反应」的所有东西。返回给玩家看的提示，'' = 已经生效。 */
  useItem(aim){
    const slot=this.held(),item=ITEMS[slot?.id];
    if(!slot||!item)return '手上没有东西';
    const p=this.player,id=slot.id;
    const interacted=this.interactMob(id);
    if(interacted==='openTrade'){this.activeTradeMob=this.mobAt(p.x+p.face*.9,p.y+.7,4.2)?.id;return '';}
    if(interacted!=null)return interacted;
    if(item.food)return this.eat()?'':(p.food>=20?'你现在不饿，留着以后吃':'这个现在吃不下');
    if(id==='potion')return this.drinkPotion();
    if(id==='milk_bucket'){const h=Math.min(20-p.health,2);p.health+=h;this.consumeHeld(1,'bucket');this.sound('eat',p.x,.6);this.swing();return '喝下牛奶，清空状态并回复 1 颗心';}
    if(id==='honey_bottle'){p.food=Math.min(20,p.food+6);this.consumeHeld(1);this.sound('eat',p.x,.6);this.swing();return '喝下蜂蜜，补充了饱食度';}
    const t=THROWABLE[id];
    if(t)return this.throwItem(id,t,aim);
    const part=armorPart(id);
    if(part){
      if(p.armor[part])return `身上已经穿着${ITEMS[p.armor[part].id].name}，先去背包里脱下来`;
      p.armor[part]={id,n:1,...(slot.dur?{dur:slot.dur}:{})};
      this.recalcArmor();
      this.consumeHeld(1);this.sound('click',p.x,.5);
      return `穿上了${item.name}（护甲值 +${armorSlotPoints(id)}）`;
    }
    if(id==='shears'){
      const sheep=this.mobs.find(m=>m.type==='sheep'&&!m.sheared&&Math.abs(m.x-p.x)<2.6&&Math.abs(m.y-p.y)<2.5);
      if(!sheep)return '对着羊右键才能剪羊毛（先靠近它）';
      sheep.sheared=true;this.drop(`${sheep.variant||'white'}_wool`,1+Math.floor(this.rng()*3),sheep.x,sheep.y);
      this.sound('click',sheep.x,.6);this.swing();return '剪下了羊毛';
    }
    if(/^music_disc_/.test(id)){this.sound('click',p.x,.55);return `播放《${item.name}》`;}
    if(id==='clock')return `第 ${Math.floor(this.time/DAY)+1} 天 · ${this.night()?'夜晚':'白昼'}`;
    if(id==='compass'){
      const d=Math.round(Math.abs(this.spawn.x-p.x));
      return `出生点 X ${Math.round(this.spawn.x)}（在${this.spawn.x>p.x?'右':'左'}边 ${d} 格）；脚下 Y ${Math.round(H-p.y-p.h)}`;
    }
    if(id==='flint_and_steel')return '这个世界还没有可燃烧的方块，打火石暂时点不着';
    if(id==='bucket')return '对着水/岩浆的源头右键才能舀（流动态舀不了）';
    if(id==='water_bucket')return '对着空地或水面右键才能倒水';
    if(id==='lava_bucket')return '对着空地或岩浆面右键才能倒岩浆';
    if(item.spawnEgg)return `${item.name}：该生物已注册但主世界生成被关闭，请用创造模式刷怪蛋召唤`;
    if(/(^|_)(boat|minecart)$/.test(id))return '船和矿车需要水面或铁轨，本作暂不支持放置';
    if(id==='bone_meal')return '骨粉要对准树苗，本作暂不支持催熟';
    if(id==='shield')return '按住鼠标右键举盾格挡（斧击中会进入 5 秒冷却）';
    if(item.tool)return `${item.name}：左键对着方块挖、对着生物打`;
    if(item.block||item.mob)return '这个位置放不下（对着空地或水面右键）';    // place() 已经试过
    return `${item.name}是合成材料，不能直接使用`;
  }
  /* 进食：开始 32 tick 计时（实际推进在 tick() 里，p.eating 每 tick +1）。
     返回 true 表示「正在吃」已生效，useItem 据此不重复提示。 */
  eat(){
    const p=this.player,slot=this.held(),item=ITEMS[slot?.id];
    if(!slot||!item?.food)return false;
    if(!K.canEat(p,slot.id==='golden_apple'))return false;
    p.eating=1;p.eatItem=slot.id;this.swing(.4);return true;
  }
  /* 进食完成：写入饥饿/饱和度，消耗手上 1 个食物。 */
  finishEat(){
    const p=this.player,id=p.eatItem;if(!id){p.eating=0;return;}
    if(K.canEat(p,id==='golden_apple')){
      const f=C.FOODS[id];
      if(f)K.applyFood(p,f[0],f[1],{absorption:id==='golden_apple'?C.GOLDEN_APPLE_ABSORPTION:0});
    }
    this.consumeHeld(1);this.sound('eat',p.x,.6);
    p.eating=0;p.eatItem=null;this.swing();
  }
  /* 重生：重置生命/饥饿/护甲/冷却等战斗状态，并给 30 tick 的重生保护。 */
  respawn(){
    const p=this.player;
    Object.assign(p,{...this.spawn,vx:0,vy:0,health:p.maxHealth,food:20,saturation:5,exhaustion:0,absorption:0,
      invulnerableTicks:30,lastDamage:0,hurtTime:0,deathTime:0,onFire:0,
      ticksSinceLastAttack:99,lastHeldId:null,strength:1,sprintLockTicks:0,
      shieldRaised:false,shieldTicks:0,shieldCooldown:0,shieldHeld:false,
      eating:0,eatItem:null,invuln:1.5});
    this.regenTimer=0;this.starveTimer=0;
    while(this.collides(p)&&p.y>1)p.y--;
    this.stopMining();this.isBreaking=false;
  }
  /* 瞄准点命中的生物。
   * ★ 不能用 mobs.find(...)：数组顺序是「谁先被加进来」，站在两只怪中间时
   *   永远打中最先加入的那只。这里按「离瞄准点最近」挑，
   *   并且排除正在倒地（dying）的生物。 */
  mobAt(x,y,reach=Infinity){
    let best=null,bestD=Infinity;
    for(const m of this.mobs){
      if(m.health<=0||m.dying)continue;
      if(x<m.x-.4||x>m.x+m.w+.4||y<m.y-.3||y>m.y+m.h+.3)continue;
      if(Math.hypot(m.x-this.player.x,m.y-this.player.y)>=reach)continue;
      const d=Math.hypot(x-(m.x+m.w/2),y-(m.y+m.h/2));
      if(d<bestD){bestD=d;best=m;}
    }
    return best;
  }
  attack(x,y){
    const p=this.player;
    const ws=K.weaponStats(ITEMS[this.held()?.id]),cd=K.cooldownTicks(ws.attackSpeed);
    const strength=p.strength;                       // tick() 已算好当前强度 0~1
    const weapon=ITEMS[this.held()?.id];
    const weaponIsSword=!!weapon&&weapon.tool==='sword';
    const weaponIsAxe=!!weapon&&weapon.tool==='axe';
    const reach=this.mode==='creative'?C.CREATIVE_ENTITY_REACH:C.SURVIVAL_ENTITY_REACH;
    /* ★ 攻击冷却：提示词原话「攻击后（包括挥空）ticksSinceLastAttack = 0」。
       挥空（点了空气）也要清零 —— 挥了一次手，攻击强度就得重新攒。
       但「点方块挖矿」不算挥空：原版挖矿不动攻击冷却，
       所以点方块时不重置（否则挖一下就把蓄力清空，永远打不出满力）。 */
    const bx=Math.floor(x),by=Math.floor(y);
    const bid=this.get(bx,by);
    const blockTarget=!!(bid&&bid!==WATER_ID&&bid!==LAVA_ID&&this.reachable(bx,by));
    let mob=this.mobAt(x,y,reach);
    /* 生物与方块重叠时「优先近者」：只有当方块确实「挡在生物前面」，
       这一击才归挖矿 —— 不能隔着方块打到后面的怪。
       ★ 判定不能用「谁离玩家更近」：2D 侧视里生物脚下的地面方块
         天然更靠近玩家（瞄生物身体其实瞄在它脚下的地面上），
         那样会导致「瞄着怪却打在地上」。所以要同时满足：
           1) 方块与生物身体高度重叠（是障碍，不是它站的地面）；
           2) 方块水平方向确实更靠近玩家（差 0.5 格以上）。
         另外还有 reachable(mob) 保证视线中间没有墙。 */
    if(mob&&blockTarget&&this.reachable(Math.floor(mob.x),Math.floor(mob.y))){
      const ex=p.x+p.w/2;                        // 2D 侧视：y 是头顶，眼睛在 p.y+0.3 附近
      const mobCx=mob.x+mob.w/2,blockCx=bx+0.5;
      const overlapsY=by>=mob.y-0.3&&by+1<=mob.y+mob.h+0.3;
      const blockInFront=Math.abs(blockCx-ex)<Math.abs(mobCx-ex)-0.5;
      if(overlapsY&&blockInFront)mob=null;
    }
    if(!mob){
      if(!blockTarget){p.ticksSinceLastAttack=0;p.strength=0;}   // 挥空也要清冷却
      return false;
    }
    if(!this.reachable(Math.floor(mob.x),Math.floor(mob.y)))return false;
    p.ticksSinceLastAttack=0;p.strength=0;
    K.addExhaustion(p,C.EXHAUSTION.attack);           // 攻击消耗度 0.1（只有打中才扣）
    this.swing(.3);
    const crit=K.isCrit({strength,airborne:!p.ground,vy:p.vy,inWater:p.inWater,onLadder:false,sprinting:p.sprinting});
    const dmg=K.meleeDamage(ws.attackDamage,strength,crit);
    this.hurtMob(mob,dmg,{type:'melee',attackerX:p.x,attackerId:'player',crit,knockback:false});
    this.hitParticles(mob.x+mob.w/2,mob.y+mob.h*.42,crit);
    this.sound(mob.type,mob.x,.65);
    /* 击退：走统一公式（水平 ×0.5 + dir×kb，地面补竖直，乘 (1-kbr)），
       脸必须同一帧跟上，否则模型在受伤硬直里「倒着走」。 */
    this.knockbackMob(mob,{attackerX:p.x,sprint:p.sprinting,kbLevel:0});
    if(mob.type!=='zombie')mob.panic=C.PASSIVE_PANIC_TICKS;
    /* 疾跑攻击：命中后取消疾跑，玩家水平速度 ×0.6（原版行为）。 */
    if(p.sprinting){p.sprintLockTicks=C.SPRINT_ATTACK_LOCK_TICKS;K.sprintAttackEffect(p);}
    /* 横扫（仅剑、非暴击、在地面、未疾跑）：主目标周围「水平 1 格内」的其它
       生物受到 1 点伤害并带轻微击退，播放横扫动画；玩家额外消耗 0.1 消耗度。 */
    if(K.isSweep({strength,onGround:p.ground,sprinting:p.sprinting,crit,weaponIsSword})){
      for(const o of K.sweepTargets(this.mobs,mob,mob.x+mob.w/2,C.SWEEP_RADIUS)){
        this.hurtMob(o,C.SWEEP_DAMAGE,{type:'melee',attackerX:p.x,attackerId:'player',knockback:false});
        this.knockbackMob(o,{attackerX:p.x,sprint:false,kbLevel:0,kbStrength:C.SWEEP_KNOCKBACK});
        this.hitParticles(o.x+o.w/2,o.y+o.h*.42,false);
      }
      this.particle('sweep',p.x+p.w/2,p.y+p.h*.5,1,{spread:.2,speed:3,lift:0,gravity:0,life:.28,color:'#e8e8e8'});
      K.addExhaustion(p,C.SWEEP_EXHAUSTION);
    }
    this.wearAttack();
    this.isBreaking=false;this.stopMining();           // 攻击取消挖掘
    if(mob.health<=0)this.killMob(mob);
    return true;
  }
  /* 动态生成：敌对每 1 秒、水生每 5 秒、被动每 20 秒各做一次 pack 尝试；
   * 位置由群系刷怪表驱动，分类上限在 mobSpawn 统一检查。 */
  tickMobSpawning(){
    this.player.sleeplessTicks=(this.player.sleeplessTicks||0)+1;
    if(this.difficulty==='peaceful'){for(const m of this.mobs)if(isHostile(m.type))m.remove=true;}
    const p=this.player,cycle=this.tickCount%M.HOSTILE_SPAWN_INTERVAL;
    if(cycle!==0&&this.tickCount%200!==0&&this.tickCount%M.PASSIVE_SPAWN_INTERVAL!==0)return;
    const attempt=(kind)=>{
      const night=this.night(),horizontal=kind==='hostile'?M.HOSTILE_MIN_SPAWN_DISTANCE+4+Math.floor(this.rng()*24):8+Math.floor(this.rng()*48);
      const sign=this.rng()<.5?-1:1,cx=Math.floor(p.x+sign*horizontal),biome=this.wg.biomeAt(cx);
      if(!biome)return;
      const positions=[];
      for(let i=0;i<3;i++){
        const x=cx+Math.floor(this.rng()*9-4),gy=this.groundAt(x),inWater=biome.isOcean||biome.isRiver;
        const y=kind==='hostile'?this.surfaceAt(x)-2:kind==='aquatic'?gy-2:gy;
        positions.push({x,y,biome:biome.id,light:night?0:15,onBlock:WG_BLOCK_TO_NAME[this.get(x,gy)]||BLOCKS[this.get(x,gy)]?.id,inWater,distance:Math.abs(x-p.x)});
      }
      const ctx={biome:biome.id,light:positions[0]?.light??15,night,underground:false,onBlock:positions[0]?.onBlock,inWater:!!positions[0]?.inWater,dimension:'overworld',distance:horizontal,difficulty:this.difficulty,playerX:p.x,sleeplessTicks:p.sleeplessTicks};
      for(const plan of planSpawnGroup(ctx,positions,()=>this.rng(),this.mobs)){
        if(kind==='passive'&&Math.abs(plan.x-p.x)<8)continue;
        const mob=this.makeMob(plan.type,plan.x,plan.y,plan.variantContext);
        if(!MOBS[plan.type].spawnRules.inWater)mob.y=plan.y-mob.h;
        if(!this.collides(mob)&&this.mobs.length<M.MOB_MAX_COUNT){mob.spawnedByWorld=true;this.mobs.push(mob);}
      }
    };
    if(cycle===0)attempt('hostile');
    if(this.tickCount%200===0)attempt('aquatic');
    if(this.tickCount%M.PASSIVE_SPAWN_INTERVAL===0)attempt('passive');
  }
  /* 通用 AI 输出到世界行为的唯一入口。 */
  mobAction(a){
    const m=a.mob,p=this.player;
    switch(a.type){
      case 'melee':{
        if(a.target===p){
          const dmg=a.damage??1;
          const res=this.damage(dmg,MOBS[m.type]?.name||m.type,{type:'melee',attackerX:m.x,peacefulHostile:isHostile(m.type),weaponIsAxe:!!MOBS[m.type]?.components?.axe});
          if(res&&!res.ignored&&!res.blocked){const kb=this.knockbackPlayer(p,{attackerX:m.x,sprint:false,kbLevel:0});p.vx=kb.vx;p.vy=kb.vy;}
          if(a.effect)this.notify(a.effect==='hunger'?'你感到饥饿（2D 简化为即时伤害）':a.effect==='wither'?'你中了凋零效果（2D 简化为持续伤害）':'');
        }else if(a.target)this.hurtMob(a.target,a.damage??1,{type:'melee',attackerX:m.x,attackerId:m.id});
        if(a.effect==='wither'&&a.target)this.hurtMob(a.target,4,{type:'magic',attackerId:m.id,knockback:false});
        break;
      }
      case 'projectile':{
        for(let i=0;i<(a.burst||1);i++)this.spawnMobProjectile(m,a.target,a);
        if(a.summon==='vex'&&this.mobs.length<M.MOB_MAX_COUNT){const v=this.makeMob('vex',m.x+(this.rng()-.5)*2,m.y-1,{spawnedByWorld:false});v.targetId=a.target?.id||'player';this.mobs.push(v);}
        this.sound(a.projectile==='snowball'?'throw':'shoot',m.x,.45);
        break;
      }
      case 'guardianLaser':case 'sonicBoom':{
        const target=a.target===p?p:a.target;if(!target)break;
        if(target===p)this.damage(a.damage??5,MOBS[m.type]?.name||m.type,{type:a.type==='sonicBoom'?'sonic':'magic',attackerX:m.x,bypassArmor:a.type==='sonicBoom',peacefulHostile:true});
        else this.hurtMob(target,a.damage??5,{type:'magic',attackerX:m.x,attackerId:m.id,bypassArmor:a.type==='sonicBoom'});
        break;
      }
      case 'explode':this.creeperExplode(m,a.radius??3,a.charged);break;
      case 'fuse':this.sound('fuse',m.x,.5);break;
      case 'breed':{
        const result=breedPair(m,a.partner,{rng:()=>this.rng()});
        if(result){this.mobs.push(result.baby);this.particle('heart',(m.x+a.partner.x)/2,(m.y+a.partner.y)/2,8,{color:'#ff8fb0',spread:.6,speed:1.2,lift:2,gravity:0,life:.7,size:.07});this.drop('xp_orb',result.xp,m.x,m.y);}
        break;
      }
      case 'growUp':for(const [id,n] of rollMobDrops(m,{rng:()=>this.rng(),grewUp:true,playerKill:m.killedByPlayer}))this.drop(id,n,m.x,m.y);break;
      case 'layEgg':this.drop('egg',1,m.x,m.y);this.sound('chicken',m.x,.3);break;
      case 'eatBlock':{
        const gy=Math.floor(m.y+m.h+.05),below=this.get(Math.floor(m.x+m.w/2),gy);
        if(m.type==='sheep'&&below===1){this.set(Math.floor(m.x+m.w/2),gy,2);m.sheared=false;m.woolColor=m.variant;this.sound('sheep',m.x,.5);}
        else if(m.type==='sniffer')this.drop('torchflower_seeds',1,m.x,m.y);
        break;
      }
      case 'teleport':{
        const base=a.target||m,targetX=base.x+(this.rng()-.5)*(a.range||M.ENDERMAN_TELEPORT_RANGE)*2;let targetY=base.y;
        for(let i=0;i<8;i++){const x=Math.floor(targetX+(this.rng()-.5)*6),y=Math.floor(targetY+(this.rng()-.5)*4);if(!this.solid(x,y)&&!this.solid(x,y-1)&&this.solid(x,y+1)){this.particle('portal',m.x+m.w/2,m.y+m.h/2,8,{color:'#b44cff',spread:.5,speed:1.4,lift:1,gravity:0,life:.4,size:.08});m.x=x;m.y=y-1.8;m.vx=0;m.vy=0;this.particle('portal',m.x+m.w/2,m.y+m.h/2,8,{color:'#b44cff',spread:.5,speed:1.4,lift:1,gravity:0,life:.4,size:.08});break;}}
        break;
      }
      case 'teleportToOwner':m.x=p.x-p.face; m.y=p.y; m.vx=0;m.vy=0;this.sound('teleport',m.x,.4);break;
      case 'callHelp':for(const o of this.mobs){if(o!==m&&o.type===m.type&&!o.dying&&Math.hypot(o.x-m.x,o.y-m.y)<(a.range||M.CALL_HELP_RANGE)){o.targetId=a.attackerId;o.targetMemory=M.TARGET_MEMORY_TICKS;o.aggro=true;}}break;
      case 'ink':this.particle('ink',m.x,m.y,14,{color:'#1a1a22',spread:.8,speed:2,lift:1.2,gravity:.2,life:.8,size:.12});p.inkTicks=100;break;
      case 'poison':if(a.target===p){this.damage(2,'河豚',{type:'magic',attackerX:m.x,bypassArmor:true,peacefulHostile:false});p.poisonTicks=80;}break;
      case 'selfDamage':this.hurtMob(m,a.amount,{type:'magic',bypassArmor:true,knockback:false});break;
      case 'transform':{const f=this.makeMob(a.into,m.x,m.y,{persistent:true});this.mobs.push(f);m.remove=true;break;}
      case 'snowTrail':{const x=Math.floor(m.x),y=Math.floor(m.y+m.h+.05);if(!this.solid(x,y)&&this.get(x,y)===0&&['snowy_plains','taiga'].includes(this.biomeAt(x)))this.set(x,y,BLOCKS.findIndex(b=>b.id==='snow'));}break;
      case 'moveToBlock':break; // 普通 MoveToBlock 是驱动器，不靠副作用
    }
  }
  spawnMobProjectile(m,target,a){
    if(!target)return;
    const ox=m.x+m.w/2,oy=m.y+m.h*.6;
    const ang=Math.atan2(target.y+target.h*.5-oy,target.x+target.w*.5-ox);
    const speed=a.projectile==='wind_charge'?12:a.projectile==='small_fireball'?13:a.projectile==='fireball'?9:a.projectile==='snowball'?18:18;
    const kind=a.projectile==='arrow'?'arrow':a.projectile;
    const tex=a.projectile==='arrow'?'arrow_projectile':a.projectile==='snowball'?'snowball':a.projectile==='trident'?'trident':a.projectile==='wind_charge'?'wind_charge':a.projectile?.includes('fireball')?'fire_charge':a.projectile==='wither_skull'?'wither_skeleton_skull':a.projectile==='shulker_bullet'?'end_rod':a.projectile;
    const projectile={x:ox+Math.cos(ang)*.6,y:oy+Math.sin(ang)*.6,vx:Math.cos(ang)*speed,vy:Math.sin(ang)*speed,ang,age:0,stuck:false,dead:false,
      damage:a.damage??C.MOB_ARROW_DAMAGE,grav:a.projectile==='arrow'||a.projectile==='trident'?C.ARROW_GRAVITY*C.TICK_RATE*C.TICK_RATE:a.projectile==='shulker_bullet'?8:0,kind,tex,
      pickup:false,owner:'mob',effect:a.effect,homing:a.homing,explode:a.projectile==='fireball'||a.projectile==='wind_charge'||a.projectile==='wither_skull'};
    this.arrows.push(projectile);
    if(a.effect==='slowness')target.statusEffects=Object.assign({},target.statusEffects,{slowness:400});
    if(a.effect==='poison')target.statusEffects=Object.assign({},target.statusEffects,{poison:440});
  }
  findMobGoalBlock(m,type,range=16){
    const near=this.drops.filter(d=>d.id!=='xp_orb'&&Math.hypot(d.x-m.x,d.y-m.y)<range).sort((a,b)=>Math.hypot(a.x-m.x,a.y-m.y)-Math.hypot(b.x-m.x,b.y-m.y));
    if(type==='item'||type==='treasure')return near[0]||null;
    if(type==='home')return m.home||null;
    if(type==='village')return null;
    if(type==='ceiling')return {x:m.x,y:m.y-3,w:1,h:1};
    if(type==='grass_block')for(let yy=Math.floor(m.y-range);yy<m.y+2;yy++)for(let xx=Math.floor(m.x-range);xx<m.x+range;xx++)if(this.get(xx,yy)===1)return {x:xx,y:yy,w:1,h:1};
    return null;
  }
  findVibrationTarget(m){let best=null,bd=M.ENTITY_FREEZE_RANGE;for(const o of this.mobs){if(o===m||o.dying)continue;const d=Math.hypot(o.x-m.x,o.y-m.y);if(d<bd){bd=d;best=o;}}const d=Math.hypot(this.player.x-m.x,this.player.y-m.y);return d<bd?this.player:best;}
  interactMob(itemId){
    const p=this.player,m=this.mobAt(p.x+p.face*.9,p.y+.7,4.2);
    if(!m)return null;
    if(p.mountId===m.id){p.mountId=null;m.riderId=null;this.sound('click',p.x,.5);return '下坐骑';return;}
    const rec=MOBS[m.type];
    if(rec.rideable&&m.tamed&&m.saddled&&mount(m,'player')){p.mountId=m.id;return `骑上了${rec.name}`;}
    if(itemId==='lead'&&attachLeash(m,'player')){this.consumeHeld(1);return `拴住了${rec.name}`;}
    if(itemId==='name_tag'){nameMob(m,p.customMobName||'小伙伴');this.consumeHeld(1);this.sound('click',p.x,.5);return `命名为「${m.customName}」`;}
    if(itemId==='saddle'&&rec.components?.saddle){if(m.saddled)return '这只生物已经有鞍了';m.saddled=true;this.consumeHeld(1);this.sound('click',p.x,.5);return `给${rec.name}装上了鞍`;}
    if(itemId==='shears'&&m.type==='mooshroom'){this.drop('red_mushroom',5,m.x,m.y);const cow=this.makeMob('cow',m.x,m.y);cow.health=m.health;this.removeMob(m);this.mobs.push(cow);this.sound('sheep',m.x,.5);this.swing();return '剪下了蘑菇，蘑菇牛变回了牛';}
    if(itemId==='brush'&&m.type==='armadillo'){if((m.brushCooldown||0)>this.tickCount)return '这只犰狳还没长好鳞甲';m.brushCooldown=this.tickCount+200;this.drop('armadillo_scute',1,m.x,m.y);this.swing();return '刷下了一片犰狳鳞甲';}
    if(itemId==='milk_bucket'&&(m.type==='cow'||m.type==='mooshroom'||m.type==='goat')){return '挤了满满一桶奶';}
    if(itemId==='water_bucket'&&['cod','salmon','tropical_fish','pufferfish','axolotl','tadpole'].includes(m.type)){
      const bucket=`${m.type}_bucket`;this.removeMob(m);this.consumeHeld(1);this.add(bucket,1);this.sound('pickup',p.x,.5);return `把${rec.name}装进了桶里`;
    }
    const fed=feedMob(m,itemId,{rng:()=>this.rng(),ownerId:'player'});
    if(fed.ok){this.consumeHeld(1);this.particle('heart',m.x+m.w/2,m.y,4,{color:'#ff8fb0',spread:.35,speed:.8,lift:1,gravity:0,life:.6,size:.06});this.sound('eat',m.x,.4);return fed.action==='tamed'?`驯服了${rec.name}`:fed.action==='love'?`${rec.name}进入了繁殖状态`:fed.action==='grow'?`喂了${rec.name}，它长大了一点`:`${rec.name}回复了生命`;}
    if(fed.reason==='cooldown')return '它现在还不能繁殖';
    if(rec.components?.trading)return 'openTrade';
    return null;
  }
  removeMob(m){const i=this.mobs.indexOf(m);if(i>=0)this.mobs.splice(i,1);}
  summonMob(id,x=null,y=null,opts={}){
    const rec=MOBS[id];if(!rec)return null;
    x=Number.isFinite(x)?x:this.player.x+this.player.face*4;y=Number.isFinite(y)?y:this.groundAt(x)-rec.hitbox.h;
    const mob=this.makeMob(id,x,y,opts);
    mob.persistent=true;
    if(!this.collides(mob)){this.mobs.push(mob);return mob;}
    return null;
  }
  tickMountedPlayer(controls,water,inLava){
    const p=this.player,m=this.mobs.find(o=>o.id===p.mountId&&!o.dying&&o.health>0);
    if(!m){p.mountId=null;this.tickPlayer(controls,water,inLava);return;}
    driveMount(m,controls,water||this.get(m.x+m.w/2,m.y+m.h*.6)===LAVA_ID);
    p.face=m.face;p.vx=m.vx;p.vy=m.vy;p.x=m.x+m.w/2-p.w/2;p.y=m.y+m.h-p.h;p.flying=false;
    p.ground=m.ground;p.px=p.x;p.py=p.y;
  }
  move(e,dt,fallDamage=false,gravityScale=1){
    e.ground=false;
    const midId=this.get(e.x+e.w/2,e.y+e.h*.65);
    const inWater=midId===WATER_ID,inLava=midId===LAVA_ID;
    e.vy=Math.min(inLava?1.5:inWater?3:22,e.vy+(inLava?3:inWater?7:25)*dt*gravityScale);
    const dx=e.vx*dt,steps=Math.max(1,Math.ceil(Math.abs(dx)/.2));
    for(let s=0;s<steps;s++){e.x+=dx/steps;if(this.collides(e)){e.x-=dx/steps;e.vx=0;break;}}
    const dy=e.vy*dt,ys=Math.max(1,Math.ceil(Math.abs(dy)/.2));
    for(let s=0;s<ys;s++){e.y+=dy/ys;if(this.collides(e)){e.y-=dy/ys;if(e.vy>0){e.ground=true;if(fallDamage&&!inWater&&!inLava)this.fallDamageFrom(e.vy,25*dt);}e.vy=0;break;}}
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
  /* 蹲下时的「悬崖保护」：能不能往这个方向走。
   * 原版 Java 按 step_height(0.6) 判断，走不下 1 格台阶 —— 但那是 3D 视角，
   * 面前有台阶得跳一下。本作是 2D 侧视，走下 1 格台阶根本不需要跳，
   * 还按 0.6 卡的话，起伏地面上每遇到一个台阶就寸步难行（用户反馈：
   * 「还没走到方块边缘就站住了」）。
   *
   * 三种情况都放行，只剩「真的悬空」才拦：
   *   ① 同高度有支撑  → 平地，随便走
   *   ② 往下一格有支撑 → 1 格台阶，走下去（重力和碰撞自然会处理落差）
   *   ③ 往上一格有支撑 → 1 格台阶，走上去（由 movePlayer 的碰撞 + autoStep 决定
   *      能不能真的踩上去；开着「自动跳跃」就上得去，关着就跟站着走一样停在台阶前）
   *
   * ⚠ ③ 是关键：以前只判 ①②，于是「往上一格的台阶」被当成悬崖，
   *   蹲着走一遇到起伏地面就直接锁死方向（dir=0），寸步难行。
   *   本作是 2D 侧视、只能左右跳，没有绕路的可能，等于直接卡死。 */
  sneakSafe(e,x){
    const feet=e.y+e.h;                                  // 脚底所在行（+0.06 落进方块里）
    if(this.solid(x,feet+.06))return true;               // ① 同高度有地
    if(this.solid(x,feet+1.06))return true;             // ② 往下一格有地 → 1 格台阶，走下去
    if(this.solid(x,feet-.94))return true;               // ③ 往上一格有地 → 1 格台阶，走上去
    return false;                                        // 悬空 → 真悬崖，拦住
  }
  /* ── 固定 20 TPS 的模拟时钟 ─────────────────────────────────────
   * update(dt, controls) 是「真实时间」入口：把 dt 塞进累加器，按 50ms 一步
   * 逐个执行 tick()，剩下的零头留给渲染插值（alpha）。
   * 所有物理、倒计时、挖掘进度都在 tick() 里，单位统一是「格/tick」。
   * 以前是 update(1/60) 直接被帧率驱动，同一段代码在 30fps / 144fps 下手感
   * 不同，「5 tick 冷却」这种原版数值也没法表达。 */
  update(dt,controls={}){
    if(dt>0){this.time+=dt;this.elapsed+=dt;}
    this.tickAcc+=Math.max(0,dt);
    let steps=0;
    while(this.tickAcc>=TICK-1e-9&&steps++<8){this.tickAcc-=TICK;this.tick(controls);}
    if(this.tickAcc<0)this.tickAcc=0;
    this.alpha=clamp(this.tickAcc/TICK,0,1);
  }
  /* 分块流式加载：按玩家所在区块补齐 ±RENDER_DISTANCE 个区块，
     超出 UNLOAD_DISTANCE 的卸载（玩家改过的存进 savedChunks，存档时才会写出去）。
     纯逻辑在 worldgen/worldgen.js 的 update()，这里只转个手。 */
  streamChunks(){
    /* 时间片生成：每帧最多生成 WORLDGEN_BUDGET_MS 毫秒（规格书 §9）。
     * 记下本次耗时与生成数 → 调试面板显示「单帧生成 X ms / N 块」。 */
    const t0=(typeof performance!=='undefined'?performance.now():0);
    try{
      const made=this.wg.update(this.player.x);
      const t1=(typeof performance!=='undefined'?performance.now():0);
      this.genMs=t1-t0;this.genCount=made;
      return made;
    }
    catch(e){
      console.error('区块生成失败',e);
      this.genMs=0;this.genCount=0;return 0;
    }
  }
  tick(controls={}){
    const dt=TICK,p=this.player;
    this.tickCount++;
    p.px=p.x;p.py=p.y;
    this.updateParticles(dt);
    if(p.health<=0){this.isBreaking=false;this.stopMining();return;}
    // 战斗计时（每逻辑 tick 减 1）
    this.recalcArmor();                              // 护甲点数/韧性/击退抗性（穿戴可随时变化）
    K.tickHurt(p);                                   // 无敌帧 / 受击红闪
    /* 盾牌：按住右键举起；举起满 SHIELD_RAISE_TICKS(5) tick 才开始生效。
       斧击中盾牌会进入 SHIELD_AXE_COOLDOWN(100) tick 冷却，期间举盾无效。 */
    p.shieldHeld=!!controls.shield;
    if(p.shieldHeld&&p.shieldCooldown<=0){p.shieldRaised=true;p.shieldTicks=Math.min(20,p.shieldTicks+1);}
    else if(!p.shieldHeld){p.shieldRaised=false;p.shieldTicks=0;}
    if(p.shieldCooldown>0)p.shieldCooldown--;
    if(p.ticksSinceLastAttack<999)p.ticksSinceLastAttack++;
    const heldId=this.held()?.id??null;             // 切换手持物 → 攻击冷却清零
    if(heldId!==p.lastHeldId){p.lastHeldId=heldId;p.ticksSinceLastAttack=0;if(p.eating>0){p.eating=0;p.eatItem=null;}}
    if(p.eating>0){p.eating++;if(p.eating>=C.EAT_TICKS)this.finishEat();}
    const ws=K.weaponStats(ITEMS[this.held()?.id]),cd=K.cooldownTicks(ws.attackSpeed);
    p.strength=K.meleeStrength(p.ticksSinceLastAttack,cd);   // 供暴击/UI
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
    /* 流体本格判定：身体中心所在格。玩家物理需要知道在水里还是岩浆里。 */
    const centerId=this.get(p.x+p.w/2,p.y+1);
    const water=centerId===WATER_ID,inLava=centerId===LAVA_ID;
    p.inWater=water;p.inLava=inLava;
    if(p.mountId)this.tickMountedPlayer(controls,water,inLava);else this.tickPlayer(controls,water,inLava);
    /* 流体调度：每个逻辑 tick 处理到期的计划格（引擎内部按 triggerTick+seq 排序，
       受 MAX_UPDATES_PER_TICK 限流，积压顺延到下一 tick）。 */
    this.fluidEngine.process(this,this.tickCount);
    if((water||inLava)&&!this.wasInFluid){this.particle(water?'splash':'smoke',p.x+p.w/2,p.y+p.h*.65,10,water?{color:'#62b7ff',spread:.55,speed:2.8,lift:3.1,gravity:10,life:.4}:{color:'#e8e8e8',spread:.55,speed:2.2,lift:3.4,gravity:-.5,life:.5,size:.1});this.sound('splash',p.x,.5);}this.wasInFluid=water||inLava;
    this.stepClock+=Math.abs(p.vx)*20*dt;if(this.stepClock>1.7&&p.ground){this.stepClock=0;const under=BLOCKS[this.get(p.x+p.w/2,p.y+p.h+.1)];if(under?.id!=='water_still')this.particle('dust',p.x+p.w/2,p.y+p.h,2,{id:under?.id,color:under?.id==='grass_block_side'?'#8a7148':'#9b9b9b',spread:.28,speed:1.1,lift:1.2,gravity:6,life:.28,size:.055});this.sound('step_'+material(under),p.x,.38);}
    this.ambientClock+=dt;if(this.ambientClock>5){this.ambientClock=0;const nearby=this.mobs.filter(m=>Math.abs(m.x-p.x)<14);if(nearby.length){const m=nearby[Math.floor(this.rng()*nearby.length)];this.sound(m.type,m.x,.32);}if(water)this.sound('water',p.x,.22);}
    if(this.mode!=='creative'&&p.health>0){
      K.consumeExhaustion(p);                         // 消耗度满 4 档 → 先扣饱和再扣饥饿
      const plan=K.regenPlan(p);                      // 自然恢复节奏（饥饿≥18 / 满饱食）
      if(plan){
        this.regenTimer++;
        if(this.regenTimer>=plan.interval){
          this.regenTimer=0;
          if(p.health<20){
            p.health++;
            if(plan.exhaustion)p.exhaustion+=plan.exhaustion;                        // 慢速恢复：消耗度 6.0
            if(plan.saturation)p.saturation=Math.max(0,(p.saturation||0)-plan.saturation); // 快速恢复：按饱和度消耗
          }
        }
      }else this.regenTimer=0;
      if(p.food<=0){                                   // 饥饿 ≤0：每 80 tick 掉 1 点，但不低于难度血量下限
        this.starveTimer++;
        if(this.starveTimer>=C.STARVE_INTERVAL_TICKS){this.starveTimer=0;const dmg=K.starveDamage(p,this.difficulty);if(dmg>0)this.damage(dmg,'饥饿',{type:'starve',bypassArmor:true});}
      }else this.starveTimer=0;
      /* 溺水：头部在水里累计 300 tick（15 秒）后氧气耗尽，
         之后每 20 tick（1 秒）扣 2 点生命，伤害绕过护甲。
         ★ 2D 侧视里头顶在 p.y（身体往下延伸），所以取 p.y+0.3 附近。 */
      const headWater=this.get(p.x+p.w/2,p.y+0.3)===17;
      if(headWater){
        p.airTicks++;
        if(p.airTicks>C.DROWN_OXYGEN_TICKS){
          p.drownTicks++;
          if(p.drownTicks>=C.DROWN_INTERVAL_TICKS){p.drownTicks=0;this.damage(C.DROWN_DAMAGE,'溺水',{type:'drown',bypassArmor:true});}
        }
      }else{p.airTicks=0;p.drownTicks=0;}
      /* 岩浆：直接伤害（4 点/次，受无敌帧限制 → 实际每 20 tick 一次）+ 点燃 8 秒。
         火焰伤害绕过护甲（原版火焰属环境伤害，提示词第 2 节）。 */
      if(inLava){
        p.onFire=C.FIRE_DURATION_TICKS;               // 在岩浆里持续续着「着火」
        this.damage(C.FLUID.LAVA_DAMAGE,'岩浆',{type:'lava',bypassArmor:true});
      }
      /* 着火：每 20 tick 扣 1 点，持续 FIRE_DURATION_TICKS（8 秒）；入水熄灭。 */
      if(water)p.onFire=0;
      if(K.fireDamageTick(p))this.damage(C.FIRE_DAMAGE,'着火',{type:'fire',bypassArmor:true});
      /* 仙人掌：碰到就扣 1 点（★ 受护甲影响 —— 提示词第 2 节把仙人掌
         明确列在「受护甲影响」的一类里）。 */
      if(this.touchingCactus(p))this.damage(C.CACTUS_DAMAGE,'仙人掌',{type:'cactus'});
      /* 窒息：头部卡在实心方块里，每 10 tick 扣 1 点（绕过护甲）。
         ★ 2D 侧视里 p.y 是「头顶」（身体从 p.y 往下延伸到 p.y+p.h），
           所以判定点取头顶附近 p.y+0.3，不是 p.y+h*0.55（那是胸口）。 */
      if(this.solid(p.x+p.w/2,p.y+0.3)){
        if(K.suffocateDamageTick(p))this.damage(C.SUFFOCATE_DAMAGE,'窒息',{type:'suffocate',bypassArmor:true});
      }else p.suffocateTimer=0;
      /* 虚空：掉到世界底部以下 64 格，每 tick 扣 4 点（绕过护甲） */
      if(p.y>H+C.VOID_DEPTH)this.damage(C.VOID_DAMAGE_PER_TICK,'虚空',{type:'void',void:true,bypassArmor:true});
    }
    /* 同类掉落物在 1 格内自动合并（原版行为），否则一片方块会掉成一地小点 */
    if(this.drops.length>1&&this.drops.length<220){
      for(let i=0;i<this.drops.length;i++)for(let j=i+1;j<this.drops.length;j++){
        const a=this.drops[i],b=this.drops[j];
        if(!a.n||!b.n||a.id!==b.id)continue;
        if(a.n+b.n>C.MAX_STACK)continue;
        if(Math.hypot(a.x-b.x,a.y-b.y)>C.DROP_MERGE_RADIUS)continue;
        a.n+=b.n;b.n=0;
      }
    }
    for(const d of this.drops){
      d.px=d.x;d.py=d.y;d.age+=dt;this.move(d,dt);d.vx*=.97;
      /* 掉落物掉进岩浆 → 烧毁（原版行为），留一缕烟 */
      if(this.get(d.x,d.y)===LAVA_ID){d.n=0;this.particle('smoke',d.x,d.y,6,{color:'#e8e8e8',spread:.4,speed:1.4,lift:3,gravity:-.5,life:.5,size:.08});continue;}
      /* 刚丢出去的物品有 40 tick 的拾取延迟 —— 否则「丢一个」会立刻被自己吸回来 */
      if(d.pickupDelay>0){d.pickupDelay--;continue;}
      if(d.age>.4&&Math.hypot(d.x-p.x,d.y-p.y-.7)<1.7){
        /* 经验球不是物品：不能进背包，要直接加到经验值上（并处理升级）。 */
        if(d.id==='xp_orb'){const lv=K.applyXp(p,d.n);d.n=0;this.sound('pickup',p.x,.35);if(lv>0)this.notify(`升级了！现在是 ${p.level} 级`);}
        else{const before=d.n;d.n=this.add(d.id,d.n,d.dur);if(d.n<before){this.particle('pickup',d.x,d.y,5,{id:d.id,color:'#e8df78',spread:.22,speed:1.8,lift:2.4,gravity:3,life:.34,size:.06});this.sound('pickup',p.x,.35);}}
      }}
    this.drops=this.drops.filter(d=>d.n>0&&d.age<C.DROP_LIFETIME);
    /* ── 箭：抛物线飞行，插进方块后留在原地，玩家走近自动拾取；
       命中生物按伤害结算并击退（动物同样 panic 逃跑）。 ── */
    for(const a of this.arrows){
      a.age+=dt;
      if(a.stuck){
        /* ★ add() 返回的是「没塞进去的剩余量」，0 才是成功 ——
           写成 if(this.add(...)) 会在成功的帧继续留在数组里，
           接下来每一帧都再塞一支，玩家走过去一次就凭空多出 58 支箭。
         * ★ 只有箭能捡；而且要有 0.45 秒的缓冲期，否则贴脸射墙时
           「出生即卡住」的箭会在同一帧被吸回背包，看着像没射出去。 */
        if(a.pickup!==false&&a.age>.45&&Math.hypot(a.x-p.x,a.y-p.y-.9)<1.5&&!this.add('arrow',1)){a.dead=true;this.sound('pickup',p.x,.35);}
        continue;
      }
      a.vy+=(a.grav||C.ARROW_GRAVITY*C.TICK_RATE*C.TICK_RATE)*dt;
      a.vx*=C.ARROW_DRAG;          // 空气阻力（每 tick 轻微减速）
      const steps=Math.max(1,Math.ceil(Math.hypot(a.vx,a.vy)*dt/.2));
      for(let i=0;i<steps&&!a.stuck&&!a.dead;i++){
        const nx=a.x+a.vx*dt/steps,ny=a.y+a.vy*dt/steps;
        /* 命中玩家：走统一伤害管线（箭受护甲影响、盾牌能挡、创造模式免伤）。
           ★ 玩家自己的箭（owner='player'）不判自己 —— 出生点就在身上，
             否则一射出来就「打中自己」。 */
        if(a.owner!=='player'&&a.damage>0&&nx>=p.x-.15&&nx<=p.x+p.w+.15&&ny>=p.y&&ny<=p.y+p.h){
          const res=this.damage(a.damage,'箭矢',{type:'projectile',attackerX:a.x});
          if(res&&!res.ignored&&!res.blocked){
            const kb=this.knockbackPlayer(p,{attackerX:a.x,sprint:false,kbLevel:0});
            p.vx=kb.vx;p.vy=kb.vy;
          }
          a.dead=true;
          if(a.splash)this.impact(a);
          break;
        }
        const m=this.mobs.find(m=>m.health>0&&!m.dying&&nx>=m.x-.15&&nx<=m.x+m.w+.15&&ny>=m.y&&ny<=m.y+m.h);
        if(m){
          this.hurtMob(m,a.damage,{type:'projectile',attackerX:a.x,attackerId:a.owner==='player'?'player':undefined,crit:true,knockback:false});
          this.knockbackMob(m,{attackerX:a.x,sprint:false,kbLevel:0});
          this.sound(m.type,m.x,.6);a.dead=true;
          if(a.splash)this.impact(a);          // 喷溅药水打中生物也要溅射
          break;
        }
        if(this.solid(nx,ny)||this.get(nx,ny)===1){
          if(a.pickup!==false){                // 箭（默认）：插在方块上，留着等人来捡
            a.stuck=true;a.vx=0;a.vy=0;
            a.x-=Math.cos(a.ang)*.3;a.y-=Math.sin(a.ang)*.3;   // 往回退一点，箭头露在方块外
          }else{
            a.dead=true;
            this.impact(a);                    // 投掷物的一次性效果
          }
          break;
        }
        a.x=nx;a.y=ny;
        if(Math.abs(a.vx)+Math.abs(a.vy)>.5)a.ang=Math.atan2(a.vy,a.vx);
      }
      if(a.x<-4||a.x>W+4||a.y>H+4)a.dead=true;
    }
    this.arrows=this.arrows.filter(a=>!a.dead&&a.age<180);
    for(const f of Object.values(this.furnaces))if(f.input&&f.fuel>0){f.progress+=dt;f.fuel=Math.max(0,f.fuel-dt);if(f.progress>=10){f.output=f.result;f.count++;f.input=null;f.progress=0;}}
    this.tickMobSpawning();
    this.mobRuntime.beginTick();
    for(const m of [...this.mobs]){
      if(!this.mobs.includes(m))continue;
      const distance=Math.abs(m.x-p.x);
      if(shouldDespawn(m,distance,()=>this.rng(),this.difficulty)){m.remove=true;continue;}
      if(distance>M.ENTITY_FREEZE_RANGE){m.vx=0;m.px=m.x;m.py=m.y;continue;}
      m.px=m.x;m.py=m.y;
      if(m.dying){
        m.deathTicks++;m.vx=0;
        if(m.deathTicks>=m.deathMax){this.finishMobDeath(m);m.remove=true;}
        continue;
      }
      const rec=MOBS[m.type],mFireMid=this.get(m.x+m.w/2,m.y+m.h*.5);
      if(mFireMid===WATER_ID)m.onFire=0;
      else if(!this.night()&&rec?.tags?.includes('undead')&&!['husk','drowned','wither_skeleton'].includes(m.type)&&m.y<this.surfaceAt(Math.floor(m.x))+1)m.onFire=C.FIRE_DURATION_TICKS;
      if(K.fireDamageTick(m)){
        this.hurtMob(m,C.FIRE_DAMAGE,{type:'fire',bypassArmor:true,knockback:false});
        this.particle('fire',m.x+m.w/2,m.y+m.h*.3,1,{color:'#ff9a3c',spread:.5,speed:1.1,lift:2.4,gravity:-3,life:.34,size:.06});
      }else if(m.onFire>0&&this.rng()<.28)this.particle('fire',m.x+m.w/2,m.y+m.h*.25,1,{color:'#ffcf6a',spread:.4,speed:.8,lift:2.2,gravity:-2.6,life:.3,size:.05});
      const aiDue=distance<=M.AI_FULL_RANGE||(distance<=M.AI_LOW_RANGE?this.tickCount%M.AI_LOW_INTERVAL===0:this.tickCount%M.AI_FAR_INTERVAL===0);
      if(aiDue)this.mobRuntime.tickCommon(m);
      if(m.riderId==='player')driveMount(m,controls,this.get(m.x+m.w/2,m.y+m.h*.6)===WATER_ID);
      if(Math.abs(m.vx)>.12)m.face=m.vx>0?1:-1;
      const wantYaw=m.face>0?0.95:-0.95;
      m.yaw=(m.yaw??wantYaw)+(wantYaw-(m.yaw??wantYaw))*Math.min(1,dt*(m.hurt>0?20:9));
      if(m.ground&&m.vx&&rec?.movementType!=='hop'&&this.solid(m.x+(m.vx>0?m.w+.2:-.2),m.y+m.h-.2))m.vy=-M.MOB_JUMP_SPEED;
      if(rec?.movementType==='hop'&&m.ground&&Math.abs(m.vx)>.1)m.vy=-(m.jumpPower||M.MOB_HOP_SPEED);
      if(rec?.movementType==='climb'&&m.vx&&this.solid(m.x+(m.vx>0?m.w+.1:-.1),m.y+m.h*.5))m.vy=-M.MOB_CLIMB_SPEED;
      if(rec?.movementType==='stationary'){m.vx=0;m.vy=0;}
      const mMid=this.get(m.x+m.w/2,m.y+m.h*.7);
      if(mMid===LAVA_ID&&!rec?.immunities?.fire){m.vy=-1.5;this.hurtMob(m,C.FLUID.LAVA_DAMAGE,{type:'lava',bypassArmor:true,knockback:false});}
      this.move(m,dt,false,rec?.movementType==='fly'?0:rec?.components?.slowFall?0.25:1);
    }
    this.mobs=this.mobs.filter(m=>!m.remove&&(m.health>0||m.dying)&&Number.isFinite(m.x)&&Number.isFinite(m.y)&&m.y<H+64);
    this.gravityClock+=dt;if(this.gravityClock>.16){this.gravityClock=0;for(let y=Math.min(H-4,Math.floor(p.y)+20);y>Math.max(0,p.y-20);y--)for(let x=Math.max(0,Math.floor(p.x)-22);x<Math.min(W,p.x+22);x++)if(this.get(x,y)===7&&[0,WATER_ID,LAVA_ID].includes(this.get(x,y+1))&&!overlap({x,y:y+1,w:1,h:1},p)){this.set(x,y,0);this.set(x,y+1,7);}}
    /* 挖掘放最后：此时 ground / 位置 / 手持物都是本 tick 的最终状态 */
    this.isBreaking=!!controls.mine;
    this.tickMining(controls.aim);
  }

  /* ── 玩家物理（每 tick 一次，速度单位 = 格/tick） ───────────── */
  tickPlayer(controls,water,inLava=false){
    const p=this.player;
    const flying=!!p.flying;
    let dir=(controls.right?1:0)-(controls.left?1:0);
    const sprinting=!!controls.sprint&&!p.crouch&&p.food>6;
    /* 疾跑攻击后的「取消疾跑」需要锁住几 tick：
       否则同一个 tick 里 tickPlayer 又把 p.sprinting 置回 true，
       「取消疾跑」在画面上完全看不出来（只有速度 ×0.6 生效）。 */
    if(p.sprintLockTicks>0)p.sprintLockTicks--;
    p.sprinting=sprinting&&!p.shieldRaised&&p.sprintLockTicks<=0;   // 举盾时取消疾跑（原版行为）
    if(dir)p.face=dir;
    // 蹲着朝悬崖外走会停住，不会掉下去（飞行时不做这个判定）。
    // 判定用 sneakSafe：平地和 1 格台阶都放行，只有真悬崖才拦。
    // edgeStop：这种情况必须「立即停死」，走下面的平滑减速会滑出边缘。
    let edgeStop=false;
    if(!flying&&p.crouch&&p.ground&&dir&&!this.sneakSafe(p,dir>0?p.x+p.w+.04:p.x-.04)){dir=0;edgeStop=true;}

    let pps;                                     // 格/秒，最后统一换成 格/tick
    if(flying)pps=(sprinting?C.FLY_SPRINT_PPS:C.FLY_HORIZONTAL_PPS)*C.FLY_SPEED_SCALE;
    else if(p.crouch)pps=C.WALK_PPS*C.SNEAK_SCALE;
    else if(sprinting)pps=C.SPRINT_PPS;
    else pps=C.WALK_PPS;
    if(inLava&&!flying)pps*=.3;                                  // 岩浆减速更狠 [记忆]
    else if(water&&!flying)pps*=C.FLUID.WATER_SWIM_SPEED_SCALE;
    if(p.eating>0)pps*=C.EAT_SPEED_SCALE;           // 进食中减速（原版行为）
    if(this.drawBow)pps*=C.BOW_MOVE_SCALE;        // 拉弓时减速（原版行为）
    /* ★ 平滑加减速：以前 vx 每 tick 直接等于目标速度，起步/松手都是瞬间跳变，
       手感生硬。现在让 vx 向目标速度指数趋近（地面响应快、空中和飞行稍慢），
       稳态仍是原版极速（4.317/5.612 格/秒），但起步有加速、松手会滑行一小段。
       蹲边保护（edgeStop）依旧立即停，防止滑下方块边缘。 */
    const tvx=dir*pps/TICK_RATE;
    if(edgeStop)p.vx=0;
    else{
      const k=flying?0.3:(p.ground?0.45:0.25);
      p.vx+=(tvx-p.vx)*k;
      if(Math.abs(p.vx)<.005)p.vx=0;
    }
    /* 消耗度（提示词第 7 节）：只有疾跑消耗 —— 疾跑每格 0.1。
   ★ 走路 / 潜行不再额外扣（原版走路不消耗消耗度），
     否则站着不动、慢慢逛也会把饥饿耗光。 */
    if(p.sprinting&&dir&&!flying)p.exhaustion+=Math.abs(p.vx)*dt*C.EXHAUSTION.sprintPerBlock;

    /* ★ 符号约定：屏幕 y 轴向下为正。所以「向上」是负 vy，
       「重力」是 +GRAVITY。原版 wiki 里的 +Y 向上，抄数值时只翻符号。 */
    if(flying){
      /* 原版创造飞行：不受重力，空格上升 / Shift 下降 / 都不按就悬停。
         每 tick 先按 0.6 衰减再叠加加速度 → 稳态 0.15/(1-0.6)=0.375 格/tick
         = 7.5 格/秒；松手后速度每 tick 乘 0.6，平滑停住而不会下落。 */
      /* ★「下降」和「蹲下」是两件事：飞行时 Shift = 下降，不能同时把
         碰撞盒缩成 1.5 格（否则下降途中会卡在方块缝里）。
         所以 UI 层把 Shift 同时写进 descend 与 crouch，这里只读 descend。 */
      const up=(controls.jump?1:0)-(controls.descend?1:0);
      p.vy=p.vy*C.FLY_DRAG-up*C.FLY_ACCEL;
    }else if(inLava){
      /* 岩浆：不能跳跃式上浮，按住跳也只是缓慢往上挪；垂直阻力 ×0.5 [记忆] */
      p.vy=(p.vy+(controls.jump?C.FLUID.WATER_FLOAT*.5:C.FLUID.WATER_GRAVITY))*C.FLUID.LAVA_DRAG_V;
      p.vy=clamp(p.vy,-.12,.12);
    }else if(water){
      /* 水（Java 数值 [记忆]）：重力 0.02/tick、垂直阻力 ×0.8、按跳 +0.04 上浮。
         头部已出水面时给一次 -0.32 出水助推 —— 2D 里要从水面跳上岸（原版也有
         等效的出水判定），否则按 +0.04 的浮力永远爬不上岸。 */
      if(controls.jump){
        const headId=this.get(p.x+p.w/2,p.y+.4);
        if(p.ground)p.vy=-C.JUMP_VELOCITY;
        else if(headId!==WATER_ID)p.vy=-0.32;
        else p.vy=(p.vy+C.FLUID.WATER_FLOAT)*C.FLUID.WATER_DRAG_V;
      }else p.vy=(p.vy+C.FLUID.WATER_GRAVITY)*C.FLUID.WATER_DRAG_V;
      p.vy=clamp(p.vy,-0.32,C.WATER_TERMINAL/TICK_RATE);
    }else{
      /* 跳跃消耗度：普通跳跃 0.05，疾跑跳跃 0.2（提示词第 7 节）。 */
      if(controls.jump&&p.ground){p.vy=-C.JUMP_VELOCITY;p.exhaustion+=p.sprinting?C.EXHAUSTION.sprintJump:C.EXHAUSTION.jump;}
      p.vy+=C.GRAVITY;
      p.vy=Math.min(p.vy,C.TERMINAL_FALL/TICK_RATE);
    }
    /* 水流推动：按所在格流向加速（下落水柱向下推）[记忆 0.014]。
       3. 水平阻力由上面既有的指数趋近模型承担，不再叠加 ×0.8 以免双重衰减。 */
    if(!flying){
      const push=fluidPushVector(this,p.x+p.w/2,p.y+p.h*.6);
      if(push){p.vx+=push.vx;p.vy=clamp(p.vy+push.vy,-.6,.6);}
    }

    const wasGround=p.ground;
    this.movePlayer();
    /* 落地即取消飞行（原版：着地后 isFlying 变 false，接着就是正常重力）。
       只有「向下撞到地面」才算落地，上升途中擦到天花板不算。 */
    if(flying&&p.ground&&(p._landVy||0)>0){p.flying=false;p.vy=0;}
    if(!wasGround&&p.ground&&!flying)this.onLand();
  }
  /* 玩家的碰撞推进：与 move() 同样的分步逻辑，但速度是 格/tick，
     所以一步就是 vy 格，不再乘 dt。 */
  movePlayer(){
    const p=this.player;
    p.ground=false;p._landVy=0;
    const steps=Math.max(1,Math.ceil(Math.max(Math.abs(p.vx),Math.abs(p.vy))/.2));
    for(let s=0;s<steps;s++){
      if(p.vx){
        p.x+=p.vx/steps;
        if(this.collides(p)){
          p.x-=p.vx/steps;
          /* ★ 水平碰撞只把位置夹回去，不清零 vx：清零会让贴墙起跳的玩家
             在空中从 0 重新加速，脚抬到位了也没有水平推力翻上 1 格台面
             （原版是持续贴墙推挤、脚一过沿就滑上去）。vx 由 tickPlayer 的
             平滑加减速统一管理，松手自然会衰减。 */
          /* 上台阶：被 1 格高障碍挡住时，若抬高 1 格后整个碰撞盒不冲突，
             就踩上去（原版「自动跳跃」行为；这里以整格计）。
             默认关闭，可在暂停菜单或 /autostep 里开关；
             只在非飞行时生效，否则飞行撞墙也会被抬上去。 */
          let stepped=false;
          if(this.autoStep&&!p.flying){
            const lifted={x:p.x,y:p.y-1,w:p.w,h:p.h};
            if(!this.collides(lifted)){
              p.y-=1;
              p.x+=p.vx/steps;
              if(this.collides(p)){p.x-=p.vx/steps;p.y+=1;}
              else stepped=true;
            }
          }
        }
      }
      if(p.vy){
        p.y+=p.vy/steps;
        if(this.collides(p)){p.y-=p.vy/steps;if(p.vy>0){p.ground=true;p._landVy=p.vy;}p.vy=0;}
      }
    }
  }
  /* 摔落伤害：把落地竖直速度（格/tick）换算成坠落格数，再用统一公式
     damage = ceil(dist - FALL_SAFE_DISTANCE)。坠落伤害绕过护甲。 */
  fallDamageFrom(vy,gravityPerTick=C.GRAVITY){
    const dist=(vy*vy)/(2*(gravityPerTick||C.GRAVITY));
    const dmg=K.fallDamage(dist);
    if(dmg>0)this.damage(dmg,'摔落',{type:'fall',bypassArmor:true});
    return dmg;
  }
  /* 落地：竖直速度换算回坠落距离并结算摔落伤害（创造模式不受摔落伤害） */
  onLand(){
    const p=this.player,vy=Math.abs(p._landVy||0);
    p._landVy=0;
    if(this.mode==='creative')return;
    if(p.inWater||p.inLava)return;               // 入水/入岩浆清零摔落（原版行为）
    this.fallDamageFrom(vy,C.GRAVITY);
  }
  /* 双击空格：创造模式下切换飞行。返回 true 表示这次按下被「飞行切换」吃掉了。 */
  toggleFly(){
    const p=this.player;
    if(this.mode!=='creative')return false;
    const now=this.tickCount;
    const dbl=now-this.lastSpaceTick<=C.DOUBLE_TAP_TICKS;
    this.lastSpaceTick=now;
    if(!dbl)return false;
    p.flying=!p.flying;
    if(p.flying){p.vy=0;p.crouch=false;}
    else p.vy=0;
    this.lastSpaceTick=-999;                   // 用完就清，避免三连击再翻一次
    return true;
  }
  /* 切换游戏模式时强制关闭飞行（生存模式不能飞） */
  setMode(mode){
    this.mode=mode;
    /* 创造模式无敌标记要跟着模式走（伤害管线读 player.creative）。 */
    this.player.creative=(mode==='creative');
    if(mode!=='creative')this.player.flying=false;
  }
  nearTorch(x,y,r){for(let yy=Math.max(0,Math.floor(y-r));yy<=Math.min(H-1,y+r);yy++)for(let xx=Math.floor(x-r);xx<=Math.floor(x+r);xx++)if(this.get(xx,yy)===16&&Math.hypot(xx-x,yy-y)<r)return true;return false;}
  serialize(){
    return{
      /* v6：分块式存档。头部带生成算法版本与世界参数，
         身体只存「玩家改动过的区块」—— 没动过的区域读档时按同种子重新生成，
         结果与当初逐格一致（规格书 §1.1 / §10）。 */
      version:6,
      worldgenVersion:WORLDGEN_VERSION,
      paletteHash:WG_PALETTE_HASH,
      paletteLen:WG_PALETTE_ID.length,
      worldType:this.worldType,
      seed:this.seed,mode:this.mode,
      chunks:this.wg.serializeChanges(),
      /* 流体：只存「与默认态不同」的格子（默认=源块、量 8）。 */
      fluid:Object.fromEntries(this.fluidMap),
      fluidQueue:this.fluidEngine.serializeQueue(this),
      spawn:this.spawn,player:this.player,
      inventory:this.inventory,offhand:this.offhand,selected:this.selected,time:this.time,elapsed:this.elapsed,
      weather:this.weather,drops:this.drops,mobs:this.mobs.map(serializeMob).filter(Boolean),furnaces:this.furnaces,
      arrows:this.arrows.map(a=>({x:a.x,y:a.y,vx:a.vx,vy:a.vy,ang:a.ang,age:a.age,stuck:a.stuck,
        damage:a.damage,kind:a.kind,tex:a.tex,pickup:a.pickup,grav:a.grav})),
      craftGrid:this.craftGrid,tableGrid:this.tableGrid,
    };
  }
  static restore(data){
    if(!data||![1,2,3,4,5,6].includes(data.version)||typeof data.seed!=='string'||data.seed.length>100||!['survival','creative'].includes(data.mode))throw Error('存档格式不受支持');
    const p=data.player;
    if(!p||![p.x,p.y,p.health,p.food].every(Number.isFinite)||p.health<0||p.health>20||p.food<0||p.food>20)throw Error('玩家数据损坏');
    // ★ 数量上限这里故意放宽到 64（而不是 ITEMS[id].stack）：
    //   旧版本的装备是可以叠 64 的（现在改成 1），线上玩家手里可能存着这种档。
    //   按新上限严格校验会直接抛错 → 整个玩家数据被丢弃。放宽后由下面第 483 行
    //   的 clamp 截到新上限，最多损失超出部分，不会丢整档。
    //   历史上任何物品都不可能超过 64，所以 64 作为「明显非法」的判据是安全的。
    /* ★ 耐久校验允许缺失：盔甲/弓的 durability 是后来才补进 ITEMS 的，
       线上老档里「没有 dur 的铁头盔」是合法数据 —— 严格校验会把整档丢掉。
       缺失的一律按满耐久补齐（下面的拆格循环里做）。 */
    if(!Array.isArray(data.inventory)||data.inventory.length!==36||data.inventory.some(s=>s&&(!ITEMS[s.id]||!Number.isInteger(s.n)||s.n<1||s.n>64||ITEMS[s.id].durability&&s.dur!==undefined&&(!Number.isInteger(s.dur)||s.dur<1||s.dur>ITEMS[s.id].durability))))throw Error('背包数据损坏');
    if(!Number.isFinite(data.time)||data.time<0||!Number.isFinite(data.elapsed)||data.elapsed<0)throw Error('时间数据损坏');
    /* 世界类型：新档从头部恢复；老档没有这个字段 → 默认世界。 */
    const wt=data.version>=6&&data.worldType?data.worldType:{};
    const w=new World(data.seed,data.mode,{worldType:wt.id||'default',caves:wt.caves,structures:wt.structures});
    const readGrid=(value,len)=>{
      const out=Array(len).fill(null);
      if(!Array.isArray(value))return out;
      for(let i=0;i<len&&i<value.length;i++){
        const s=value[i];if(!s||!ITEMS[s.id]||!Number.isInteger(s.n)||s.n<1)continue;
        out[i]={id:s.id,n:clamp(s.n,1,ITEMS[s.id].stack),...(s.dur?{dur:clamp(Math.floor(s.dur),1,ITEMS[s.id].durability||1)}:{})};
      }
      return out;
    };
    if(data.version>=6){
      /* ── 新格式（v6）：分块式 ─────────────────────────────────────────
       * 只恢复「玩家改动过的区块」；其余区域按存档头的 worldgenVersion 重新生成。
       * 同种子 + 同坐标 = 同结果，所以未改动区域的外观和存档时一模一样。 */
      /* 调色板守卫：存档里存的是「调色板下标」，所以调色板只能在表尾追加，
         中间插入会让所有老存档的下标整体错位（读出来是别的方块）。
         → 指纹不同时先判断「存档里的调色板是不是当前调色板的前缀」：
           是 → 只是新增了方块，索引没动，安全读取；
           否 → 索引语义变了，明确报错，绝不静默读错（规格书 §1.1 / §10）。 */
      if(data.paletteHash&&data.paletteHash!==WG_PALETTE_HASH){
        const len=Number.isInteger(data.paletteLen)?data.paletteLen:0;
        const appendOnly=len>0&&len<=WG_PALETTE_ID.length&&paletteHash(WG_PALETTE_ID.slice(0,len))===data.paletteHash;
        if(!appendOnly)throw Error('存档的方块表版本与当前不一致，无法读取（请先更新游戏）');
      }
      w.wg.worldgenVersion=data.worldgenVersion??WORLDGEN_VERSION;
      w.wg.loadChanges(data.chunks);
      if(data.fluid)for(const [k,v] of Object.entries(data.fluid)){
        const key=Number(k);
        if(Number.isFinite(key)&&v>=0&&v<256)w.fluidMap.set(key,v|0);
      }
      if(data.fluidQueue)w.fluidEngine.restoreQueue(w,data.fluidQueue);
      else w.scanFluidBoundaries();
      if(data.spawn&&Number.isFinite(data.spawn.x)&&Number.isFinite(data.spawn.y))w.spawn={x:Math.floor(data.spawn.x),y:clamp(Math.floor(data.spawn.y),0,H-2)};
      w.migrated=false;
    }else{
      /* ── 旧格式迁移（v1~v5）──────────────────────────────────────────
       * 旧存档是「整张扁平地图」（y 向下：0 是天空）。这里把它整块导入成
       * 「已改动的区块」：玩家造的东西一样不少，迁移区的地形外观保持原样；
       * 迁移区之外用新算法重新生成（世界是无尽的，那边本来就是新地形）。
       * ★ 坐标要翻一次：旧存档 y 向下，worldgen y 向上 → wgY = 255 - gameY。 */
      const oldW=data.version>=4?data.width:(data.surface?.length||384);
      const oldH=data.version>=4?data.height:(oldW===640?160:144);
      if(!Number.isInteger(oldW)||!Number.isInteger(oldH)||oldW<1||oldW>W||oldH<1||oldH>H)throw Error('存档地图尺寸无效');
      const size=oldW*oldH;
      const read=(a,Type=Uint16Array)=>data.version>=3?unrle(a,size,Type):Type.from(a||[]);
      const blocks=read(data.blocks),natural=data.natural?read(data.natural,Uint8Array):new Uint8Array(size);
      const fluid=data.fluid?read(data.fluid,Uint8Array):null;
      if(blocks.length!==size||blocks.some(id=>id>=BLOCKS.length))throw Error('存档方块数据损坏');
      /* 翻 Y：旧第 y 行（y 向下）→ worldgen 第 (oldH-1-y) 行（y 向上）。
       * ★ 为什么是 oldH-1-y 而不是 H-1-y：
       *   最老的存档世界只有 144/160 行高（v1~v3），它自己的基岩在第 oldH-1 行。
       *   按 H-1-y 翻会把旧世界整体顶到天上、下面露出新生成的深洞；
       *   按 oldH-1-y 翻则是「旧世界的底对齐新世界的底」——
       *   v4/v5（oldH=256=H）时两者等价，最老的存档也能无缝接上。 */
      const flipBlocks=new Uint16Array(size),flipNatural=new Uint8Array(size);
      for(let y=0;y<oldH;y++){
        const dy=oldH-1-y;
        for(let x=0;x<oldW;x++){
          flipBlocks[dy*oldW+x]=blocks[y*oldW+x];
          flipNatural[dy*oldW+x]=natural[y*oldW+x];
        }
      }
      /* 旧世界第 y 行（y 向下）对应的「新游戏 y」（y 向下）= H-oldH+y。 */
      const oldYOffset=H-oldH;
      /* 旧方块 id（BLOCKS 下标）→ worldgen 调色板下标。 */
      const mapIndex=(id)=>{
        const name=WG_BLOCK_TO_NAME[id];
        if(!name)return -1;
        const p=WG_NAME_TO_ID.get(name);
        return p===undefined?-1:p;
      };
      w.wg.importLegacyMap(flipBlocks,flipNatural,oldW,oldH,mapIndex);
      /* 流体：旧档的水量表按原样搬过来（键是游戏坐标 x*256+y）。
       * ★ y 要加上 oldYOffset：旧世界比新世界矮时整体下移，坐标得跟着走。 */
      if(fluid)for(let y=0;y<oldH;y++)for(let x=0;x<oldW;x++){
        const v=fluid[y*oldW+x];
        if(!v)continue;
        const id=blocks[y*oldW+x];
        if(id===WATER_ID||id===LAVA_ID)w.fluidMap.set(x*256+(y+oldYOffset),v);
      }
      /* 旧地表高度：迁移区必须保持原样（否则那一段会和邻居对不上）。 */
      if(Array.isArray(data.surface)){
        w.legacySurface=new Map();
        for(let x=0;x<oldW;x++)if(Number.isInteger(data.surface[x]))
          w.legacySurface.set(x,clamp(data.surface[x]+oldYOffset,0,H-1));
      }
      if(data.spawn&&Number.isFinite(data.spawn.x)&&Number.isFinite(data.spawn.y))
        w.spawn={x:clamp(Math.floor(data.spawn.x),0,W-1),y:clamp(Math.floor(data.spawn.y)+oldYOffset,0,H-2)};
      w.migrated=true;
      w.legacyImport={width:oldW,height:oldH};
    }
    Object.assign(w.player,{x:clamp(p.x,0,W-1),y:clamp(p.y,-20,H-2),health:p.health,food:p.food,crouch:false});
    /* 穿着的盔甲逐部位校验：部位不匹配或当前版本不认识的 id 一律丢弃成空槽，
       耐久缺字段时按满耐久补 —— 老档没有 armor 字段就保持初始全空。 */
    const armorIn=data.player?.armor;
    if(armorIn&&typeof armorIn==='object'){
      const out={};
      for(const part of ['helmet','chestplate','leggings','boots']){
        const s=armorIn[part];
        const ok=s&&ITEMS[s.id]&&(`${s.id}`.endsWith(`_${part}`)||(part==='helmet'&&s.id==='turtle_helmet'));
        out[part]=ok?{id:s.id,n:1,...(ITEMS[s.id].durability?{dur:clamp(Number.isFinite(s.dur)?Math.floor(s.dur):ITEMS[s.id].durability,1,ITEMS[s.id].durability)}:{})}:null;
      }
      w.player.armor=out;
      w.recalcArmor();          // 读档后重算护甲点数/韧性/击退抗性
    }
    if(Array.isArray(data.arrows))for(const a of data.arrows.slice(0,256)){
      if([a.x,a.y,a.vx,a.vy,a.ang].every(Number.isFinite))w.arrows.push({x:a.x,y:a.y,vx:a.vx,vy:a.vy,ang:a.ang,age:Number.isFinite(a.age)?a.age:0,stuck:!!a.stuck,damage:Number.isFinite(a.damage)?a.damage:6,dead:false,
        kind:typeof a.kind==='string'?a.kind:'arrow',tex:typeof a.tex==='string'?a.tex:'arrow_projectile',
        pickup:a.pickup!==false,grav:Number.isFinite(a.grav)?a.grav:22});
    }
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
      const dur=ITEMS[s.id].durability?(Number.isInteger(s.dur)?s.dur:ITEMS[s.id].durability):undefined;
      w.inventory[i]={id:s.id,n:Math.min(s.n,lim),...(dur?{dur}:{})};
      if(s.n>lim)overflow.push({id:s.id,n:s.n-lim,dur});
    }
    for(const o of overflow)w.add(o.id,o.n,o.dur);
    w.craftGrid=readGrid(data.craftGrid,4);w.tableGrid=readGrid(data.tableGrid,9);
    /* 副手是后加的第 46 格：老档没有这个字段，缺省就是空手 */
    w.offhand=null;
    if(data.offhand&&ITEMS[data.offhand.id]&&Number.isInteger(data.offhand.n)&&data.offhand.n>0){
      const o=data.offhand,lim=ITEMS[o.id].stack;
      w.offhand={id:o.id,n:Math.min(o.n,lim),...(ITEMS[o.id].durability?{dur:Number.isInteger(o.dur)?clamp(o.dur,1,ITEMS[o.id].durability):ITEMS[o.id].durability}:{})};
    }
    w.time=data.time;w.elapsed=data.elapsed;
    w.selected=Number.isInteger(data.selected)?clamp(data.selected,0,8):0;
    w.exhaustion=Number.isFinite(data.exhaustion)?clamp(data.exhaustion,0,1):0;
    w.weather=['clear','rain','thunder'].includes(data.weather)?data.weather:'clear';
    /* 构造时按群系刷出来的生物先清掉，下面用存档里的 mobs 覆盖。
       （世界是无限的，不再有「只保留旧宽度以内的生物」这种限制。） */
    w.drops=[];w.mobs=[];
    if(Array.isArray(data.drops))for(const d of data.drops.slice(0,1000)){if(ITEMS[d.id]&&Number.isFinite(d.x)&&Number.isFinite(d.y)&&d.x>=0&&d.x<W&&d.y>=0&&d.y<H&&Number.isInteger(d.n)&&d.n>0&&d.n<=64){w.drop(d.id,d.n,d.x,d.y,ITEMS[d.id].durability?clamp(Math.floor(d.dur)||1,1,ITEMS[d.id].durability):undefined);}}
    if(Array.isArray(data.mobs)){resetMobIds(1);for(const m of data.mobs.slice(0,512)){if(MOBS[m.type]&&Number.isFinite(m.x)&&Number.isFinite(m.y)&&Number.isFinite(m.health)&&m.health>0){const mob=restoreMobState(m);if(mob)w.mobs.push(mob);}}}
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

/* ── 调试/测试用：世界状态快照 ────────────────────────────────────────
 * 世界改成无限分块之后没有「整张扁平数组」了，所以「跑一段模拟后状态有没有变」
 * 这类对比改用这个快照：已加载区块的方块 + 流体状态（按绝对坐标排序）。
 * 坐标是绝对的 → 两个世界的快照可以直接比。 */
export function worldSnapshot(world){
  const chunks=[...world.wg.chunks.entries()].sort((a,b)=>a[0]-b[0]);
  const parts=[];
  for(const [cx,c] of chunks)parts.push(cx+':'+Array.from(c.blocks).join(','));
  const fluid=[...world.fluidMap.entries()].sort((a,b)=>a[0]-b[0]).map(e=>e[0]+':'+e[1]).join(',');
  return { blocks:parts.join('|'), fluid, chunkCount:chunks.length };
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
/* ── 蹲姿（原版 Java 版「潜行」的模型姿态）────────────────────────
 * 原版 1.8 ModelBiped.setRotationAngles 里的潜行设定：
 *     bipedBody.rotateAngleX = 0.5F;        躯干前倾 0.5 rad
 *     bipedRightArm.rotateAngleX += 0.4F;   手臂再前摆 0.4 rad
 *     bipedRightLeg.rotationPointY = 9.0F;   腿的转轴从 y=12 下移到 9
 *     bipedRightLeg.rotationPointZ = 4.0F;   并后移到 4（所以屁股撅出去）
 *     bipedHead.rotationPointY = 1.0F;
 * 原版只有「腿转轴下移后移」，腿本身还是一根直棍子；本作是 2D 侧视，
 * 照抄那条只能看出躯干前倾，看不出「蹲」。所以把「转轴下移」换成真正的
 * 屈膝：大腿前抬、小腿后收，髋部随之下沉，蹲下去一眼能看出来。
 * 角度换算：本作 +z 朝镜头，原版 +z 朝后，所以前倾/前摆的符号与原版相反。 */
export const CROUCH={knee:.52,torso:.50,head:0,arm:.40};
/** 站立模型的高度（模型单位）：头 24~32，帽子层 32.25。
 *  蹲下时用它当缩放基准，模型的「零件大小」才不会跟着塌下去。 */
export const STEVE_REF_H=32.25;
/** 站立时人物模型的世界高度（格）。碰撞盒蹲下会缩到 1.5，
 *  但模型仍按站立比例画 —— 否则蹲下就成了「整个人被压扁」。 */
export const STEVE_STAND_H=1.8;
/** 手臂坐标系：肩点 + 角度。蹲下时肩点随躯干前倾前移，角度再多前摆 0.4。 */
export function armFrame(angle,crouch=false){
  if(!crouch)return{x:STEVE_ARM.x,y:STEVE_ARM.shoulder,z:0,ang:angle};
  const T=CROUCH.torso,hipY=12*Math.cos(CROUCH.knee);
  return{x:STEVE_ARM.x,y:hipY+12*Math.cos(T),z:12*Math.sin(T),ang:T+angle-CROUCH.arm};
}
/** 手在模型坐标系里的位置（已绕肩旋转）。 */
export function steveHand(a,crouch=false){
  const f=armFrame(a,crouch);
  return{x:f.x,y:f.y-STEVE_ARM.len*Math.cos(f.ang),z:f.z-STEVE_ARM.len*Math.sin(f.ang)};
}

/* ── 网格缓存（GC 长尾优化）────────────────────────────────────
   以前每帧对每个可见实体都重建整套 boxes 网格：75fps 下每秒产生数万个
   短命对象，minor GC 频繁停顿 2~5ms —— 表现正是「FPS 数字够高、玩起来
   却一顿一顿」。网格几何其实只由 (类型, 腿臂摆动值, 手臂角, 盔甲) 决定
   （time 只通过 sin(time*9) 进入），把这些标量量化成 key，命中就共享
   同一份只读数组。量化台阶：摆动 1/48 格、挥击 1/40、拉弓角 1/24 rad，
   肉眼不可辨。
   ⚠️ 返回值是跨帧共享的缓存，调用方（drawEntity 等）绝不可改写它。 */
const meshCache=new Map();
export function entityMesh(type,time=0,velocity=0,swing=null,armor=null,armOverride=null,crouch=false){
  const amp=Math.min(1,Math.abs(velocity)/2)*.65;
  const k=type+'\u0001'+Math.round(Math.sin(time*9)*amp*48)
    +'\u0001'+(swing==null?'-':Math.round(Math.sin(swing*Math.PI)*40))
    +'\u0001'+(armOverride==null?'-':Math.round(armOverride*24))
    +'\u0001'+(crouch?'C':'-')
    +'\u0001'+(armor?(armor.helmet?.id||'')+'_'+(armor.chestplate?.id||'')+'_'+(armor.leggings?.id||'')+'_'+(armor.boots?.id||''):'-');
  let boxes=meshCache.get(k);
  if(boxes)return boxes;
  if(meshCache.size>2000)meshCache.clear();
  boxes=buildEntityMesh(type,time,velocity,swing,armor,armOverride,crouch);
  meshCache.set(k,boxes);
  return boxes;
}
function buildEntityMesh(type,time=0,velocity=0,swing=null,armor=null,armOverride=null,crouch=false){
  const boxes=[],walk=Math.sin(time*9)*Math.min(1,Math.abs(velocity)/2)*.65;
  const box=(texture,uv,center,size,angle=0,pivot=center)=>boxes.push({texture,uv,center,size,angle,pivot});
  if(type==='steve'||type==='zombie'){
    const zombie=type==='zombie',armSwing=zombie?-1.35:0;
    // 右手（朝镜头那条，x=-6）：拿东西、挖、打都用这只手。
    // ★ 必须无条件走 steveArmAngle：物品的位置也是它算的，两处走不同分支
    //   就会出现「手臂在 0、物品按 -0.3 摆」——手和物品错开半个手臂。
    //   拉弓时走 armOverride（手臂随蓄力后拉），物品和手臂共用同一角度。
    const rightArm=zombie?armSwing:(armOverride!=null?armOverride:steveArmAngle(time,velocity,swing));
    if(crouch&&!zombie){
      /* ── 蹲姿：真蹲，不是把模型压扁 ──────────────────────────
       * 站姿：腿 0~12、躯干 12~24、头 24~32，手臂挂在肩(y=24)两侧。
       * 蹲姿（全部在模型坐标系里算好绝对位置，再以自身中心为轴）：
       *   髋部  hipY = 12cos(knee)  ← 屈膝后自然下沉
       *   大腿  绕髋转 (swing-knee)  ← 膝盖前抬
       *   小腿  绕膝转 (swing+knee)  ← 小腿后收，脚踩回地面
       *   躯干  绕髋前倾 torso（0.5 rad = 28.6°，抄原版 ModelBiped）
       *   头    完全继承躯干倾角（原版 bipedHead 不单独旋转），
       *         再按原版 rotationPointY=1.0 整体下移 1 个单位
       *   手臂  随躯干一起倾，再多前摆 arm（0.4 rad，抄原版）
       * 腿要拆成大腿/小腿两段，贴图按原区域对半切（uv 不变、只是分两半画），
       * 所以拆开后纹理映射跟没拆时一模一样。 */
      const K=CROUCH.knee,T=CROUCH.torso,HT=T+CROUCH.head;
      const hipY=12*Math.cos(K);
      const cT=Math.cos(T),sT=Math.sin(T),cH=Math.cos(HT),sH=Math.sin(HT);
      const legs=[],torso=[],head=[];
      for(const side of[-1,1]){
        const px=side*2, swing=side<0?walk:-walk;    // 右腿 x=-2，左腿 x=+2
        const thighA=swing-K, shinA=swing+K;
        const cA=Math.cos(thighA),sA=Math.sin(thighA);
        const cB=Math.cos(shinA),sB=Math.sin(shinA);
        const kneeY=hipY-6*cA, kneeZ=-6*sA;           // 膝盖位置
        const thighC=[px,hipY-3*cA,-3*sA];
        const shinC =[px,kneeY-3*cB,kneeZ-3*sB];
        const uv=side<0?[0,16]:[16,48];
        legs.push({uv,center:thighC,size:[4,6,4],angle:thighA,part:0});
        legs.push({uv:[uv[0],uv[1]+6],center:shinC,size:[4,6,4],angle:shinA,part:1});
      }
      const torsoC=[0,hipY+6*cT,6*sT];                // 躯干绕髋前倾
      const neckY=hipY+12*cT, neckZ=12*sT;
      /* 头：原版 bipedHead 没有独立旋转（继承躯干的 0.5 rad），
       * 只把头的转轴下移了 1 个单位（rotationPointY = 1.0F）。
         * 这里照抄：头沿躯干方向摆在顶端，再额外下移 1 个单位。 */
      const headC=[0,neckY+4*cH-1,neckZ+4*sH];
      for(const l of legs)box(type,l.uv,l.center,l.size,l.angle,l.center);
      box(type,[16,16],torsoC,[8,12,4],T,torsoC);
      box(type,[0,0],headC,[8,8,8],HT,headC);
      box(type,[32,0],headC,[8.5,8.5,8.5],HT,headC);   // 帽子/外套层
      // 手臂：肩点跟着躯干前移，角度再多前摆 0.4
      for(const side of[-1,1]){
        const px=side*6, ang=T+(side<0?rightArm:walk)-CROUCH.arm;
        const shY=hipY+12*cT, shZ=12*sT;
        const center=[px,shY-6*Math.cos(ang),shZ-6*Math.sin(ang)];
        box(type,side<0?[40,16]:[32,48],center,[4,12,4],ang,center);
      }
      if(armor){
        if(armor.helmet){
          ensureTexture(armorTexture(armor.helmet.id,'helmet'));
          box(armorTexture(armor.helmet.id,'helmet'),[0,0],headC,[9,9,9],HT,headC);
        }
        if(armor.chestplate){
          const t=armorTexture(armor.chestplate.id,'chestplate');ensureTexture(t);
          box(t,[16,16],torsoC,[8.5,12.5,4.5],T,torsoC);
          for(const side of[-1,1]){
            const px=side*6, ang=T+(side<0?rightArm:walk)-CROUCH.arm;
            const center=[px,hipY+12*cT-6*Math.cos(ang),12*sT-6*Math.sin(ang)];
            box(t,[40,16],center,[4.5,12.5,4.5],ang,center);
          }
        }
        if(armor.leggings){
          const t=armorTexture(armor.leggings.id,'leggings');ensureTexture(t);
          box(t,[16,16],torsoC,[8.5,12.5,4.5],T,torsoC);
          // 护腿贴图两条腿都用 (0,16)（和站姿一致），这里按大腿/小腿对半切
          for(const l of legs)box(t,l.part?[0,22]:[0,16],l.center,[4.5,6,4.5],l.angle,l.center);
        }
        if(armor.boots){
          const t=armorTexture(armor.boots.id,'boots');ensureTexture(t);
          // 靴子贴图两条腿都用 (0,0)（和站姿一致）
          for(const l of legs)box(t,l.part?[0,6]:[0,0],l.center,[4.75,6,4.75],l.angle,l.center);
        }
      }
      return boxes;
    }
    box(type,[0,0],[0,28,0],[8,8,8]);
    box(type,[16,16],[0,18,0],[8,12,4]);
    box(type,[0,16],[-2,6,0],[4,12,4],walk,[-2,12,0]);
    box(type,zombie?[0,16]:[16,48],[2,6,0],[4,12,4],-walk,[2,12,0]);
    // 僵尸两条手臂都平举，贴图都在 (40,16)。以前左臂取的是 (0,16)，
    // 那是腿的位置，于是僵尸身上会多出一截腿肉。
    box(type,[40,16],[-6,18,0],[4,12,4],rightArm,[-6,24,0]);
    box(type,zombie?[40,16]:[32,48],[6,18,0],[4,12,4],zombie?armSwing:walk,[6,24,0]);
    if(!zombie)box(type,[32,0],[0,28,0],[8.5,8.5,8.5]);   // 帽子/外套层
    // ── 穿着的盔甲（2D 侧视只画朝镜头的层）──
    // 尺寸在身体各部件上外扩 0.5（原版 CubeDeformation 同款），盖在贴图外层。
    if(armor&&type==='steve'){
      if(armor.helmet){
        ensureTexture(armorTexture(armor.helmet.id,'helmet'));
        box(armorTexture(armor.helmet.id,'helmet'),[0,0],[0,28,0],[9,9,9]);
      }
      if(armor.chestplate){
        const t=armorTexture(armor.chestplate.id,'chestplate');ensureTexture(t);
        box(t,[16,16],[0,18,0],[8.5,12.5,4.5]);
        box(t,[40,16],[-6,18,0],[4.5,12.5,4.5],rightArm,[-6,24,0]);   // 朝镜头的手臂跟着挥
        box(t,[40,16],[6,18,0],[4.5,12.5,4.5],walk,[6,24,0]);
      }
      if(armor.leggings){
        const t=armorTexture(armor.leggings.id,'leggings');ensureTexture(t);
        box(t,[16,16],[0,18,0],[8.5,12.5,4.5]);
        box(t,[0,16],[-2,6,0],[4.5,12,4.5],walk,[-2,12,0]);
        box(t,[0,16],[2,6,0],[4.5,12,4.5],-walk,[2,12,0]);
      }
      if(armor.boots){
        const t=armorTexture(armor.boots.id,'boots');ensureTexture(t);
        box(t,[0,0],[-2,6,0],[4.75,12,4.75],walk,[-2,12,0]);
        box(t,[0,0],[2,6,0],[4.75,12,4.75],-walk,[2,12,0]);
      }
    }
  }else if(type==='chicken'){
    box('chicken_mob',[0,9],[0,8,0],[6,8,6]);
    box('chicken_mob',[0,0],[0,13,4],[4,6,3]);
    box('chicken_mob',[14,0],[0,12,6.5],[4,2,2]);
    box('chicken_mob',[14,4],[0,10,6],[2,2,2]);
    for(const side of [-1,1]){
      box('chicken_mob',[26,0],[side*2,2.5,0],[3,5,3],walk*side,[side*2,5,0]);
      box('chicken_mob',[24,13],[side*3.5,8,0],[1,4,6]);
    }
  }else if(type==='creeper'){
    box('__missing_mob',[0,0],[0,12,0],[8,12,8]);
    box('__missing_mob',[0,0],[0,25,2],[8,8,8]);
    box('__missing_mob',[0,0],[0,8,6],[5,8,1],walk,[0,8,6]);
    box('__missing_mob',[0,0],[0,8,-6],[5,8,1],-walk,[0,8,-6]);
  }else{
    const rec=MOBS[type],model=rec?.model||'quadruped';
    if(model==='humanoid'||model==='villager'){
      const tall=rec?.hitbox?.h>2.2;
      box('__missing_mob',[0,0],[0,28,0],[8,8,8]);
      box('__missing_mob',[0,0],[0,18,0],[8,12,4]);
      box('__missing_mob',[0,0],[-2,6,0],[4,tall?14:12,4],walk,[-2,12,0]);
      box('__missing_mob',[0,0],[2,6,0],[4,tall?14:12,4],-walk,[2,12,0]);
      const arm=steveArmAngle(time,velocity,swing);
      box('__missing_mob',[0,0],[-6,18,0],[4,12,4],arm,[-6,24,0]);
      box('__missing_mob',[0,0],[6,18,0],[4,12,4],walk,[6,24,0]);
    }else if(model==='spider'){
      box('__missing_mob',[0,0],[0,8,0],[10,8,8]);
      box('__missing_mob',[0,0],[0,9,7],[7,6,6]);
      for(const side of [-1,1])for(const i of [-1,0,1]){
        const hip=[side*5,7,3-i*3];
        box('__missing_mob',[0,0],[hip[0]+side*2,5,hip[2]],[4,4,1],walk*side*(i||1),hip);
      }
    }else if(model==='fish'||model==='squid'){
      box('__missing_mob',[0,0],[0,8,0],[10,7,4]);
      box('__missing_mob',[0,0],[0,8,-6],[4,5,5],walk*.5,[0,8,-3]);
      box('__missing_mob',[0,0],[0,8,6],[3,4,3]);
    }else if(model==='bird'||model==='insect'){
      box('__missing_mob',[0,0],[0,10,0],[6,7,5]);
      box('__missing_mob',[0,0],[0,14,3],[5,5,5]);
      box('__missing_mob',[0,0],[-5,10,0],[7,3,3],walk*.8,[-3,10,0]);
      box('__missing_mob',[0,0],[5,10,0],[7,3,3],-walk*.8,[3,10,0]);
    }else if(model==='slime'){
      box('__missing_mob',[0,0],[0,6,0],[13,11,13]);
      box('__missing_mob',[0,0],[0,6,0],[10,8,10],0,[0,6,0]);
    }else if(model==='golem'){
      box('__missing_mob',[0,0],[0,24,0],[9,9,9]);
      box('__missing_mob',[0,0],[0,13,0],[10,13,6]);
      box('__missing_mob',[0,0],[-4,5,0],[4,10,4],walk,[-4,10,0]);
      box('__missing_mob',[0,0],[4,5,0],[4,10,4],-walk,[4,10,0]);
      box('__missing_mob',[0,0],[-8,16,0],[4,17,4],armOverride??armFrame(0).ang,[-8,24,0]);
      box('__missing_mob',[0,0],[8,16,0],[4,17,4],-(armOverride??armFrame(0).ang),[8,24,0]);
    }else if(model==='shulker'){
      box('__missing_mob',[0,0],[0,8,0],[8,8,8]);
      box('__missing_mob',[0,0],[0,5,3],[6,6,3]);
    }else if(model==='dragon'||model==='wither'){
      box('__missing_mob',[0,0],[0,12,0],[12,10,8]);
      box('__missing_mob',[0,0],[0,16,8],[8,7,7]);
      box('__missing_mob',[0,0],[-10,12,0],[11,3,3],walk*.6,[0,12,0]);
      box('__missing_mob',[0,0],[10,12,0],[11,3,3],-walk*.6,[0,12,0]);
      box('__missing_mob',[0,0],[-4,18,10],[4,4,4]);
      box('__missing_mob',[0,0],[4,18,10],[4,4,4]);
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
export function toolVertex(u,v,depth,angle,crouch=false){
  const du=(u-4.5)*.75,dv=(12.5-v)*.75,c=Math.SQRT1_2;
  const y=-10+(dv-du)*c,z=(du+dv)*c;
  const f=armFrame(angle,crouch),ca=Math.cos(f.ang),sa=Math.sin(f.ang);
  return {x:f.x+depth,y:f.y+y*ca-z*sa,z:f.z+y*sa+z*ca};
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
  const crouch=!!mob.crouch;
  const parts=entityMesh(mob.type||'steve',time,mob.vx||0,hold?hold.swing:null,mob.armor||null,hold?.draw??null,crouch);
  if(!parts.length)return 0;
  const{lo,hi}=meshBounds(parts);
  /* 蹲下时按「站姿模型高度」缩放：蹲姿网格本来就矮一截，
     再按它自己的高度缩放就会变成「整个人被压小」——正是要修的毛病。 */
  const scale=heightPx/Math.max(1,crouch?STEVE_REF_H:hi-lo);
  /* 蹲姿以「脚踝 y=0」对齐地面（不是网格最低点）：屈膝后小腿是斜的，
     盒子角会扎到地面以下 1 个单位，用网格最低点对齐会让整个人浮起来。
     站姿仍然用网格最低点，两套逻辑互不影响。 */
  const yRef=crouch?0:lo;
  const cy=Math.cos(yaw),sy=Math.sin(yaw),pitch=.16,cp=Math.cos(pitch),sp=Math.sin(pitch);
  const rot=(x,y,z)=>{const X=x*cy+z*sy,Z=-x*sy+z*cy;return{x:X,y:y*cp-Z*sp,z:Z*cp+y*sp};};
  const faces=[];
  for(const b of parts){
    const image=images[b.texture]||images.__missing_mob;if(!image)continue;
    const[bx,by,bz]=b.center,[dx,dy,dz]=b.size,[u,v]=b.uv,ca=Math.cos(b.angle),sa=Math.sin(b.angle),pv=b.pivot;
    const pt=(x,y,z)=>{
      const yy=y-pv[1],zz=z-pv[2];
      const r=rot(x,pv[1]+yy*ca-zz*sa,pv[2]+yy*sa+zz*ca);
      return{x:cx+r.x*scale,y:groundY-(r.y-yRef)*scale,z:r.z};
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
  const proj=(x,y,z)=>{const r=rot(x,y,z);return{x:cx+r.x*scale,y:groundY-(r.y-yRef)*scale,z:r.z};};
  const holdImg=hold?(hold.img||images[hold.id]):null;
  if(holdImg && ITEMS[hold.id]?.tool){
    const angle=hold.draw!=null?hold.draw:steveArmAngle(time,mob.vx||0,hold.swing);
    for(const face of toolFaces(holdImg)){
      const q=face.vertices.map(([u,v,d])=>{const h=toolVertex(u,v,d,angle,crouch);return proj(h.x,h.y,h.z);});
      faces.push({q,uv:face.uv,shade:face.shade,cutout:face.cutout,image:holdImg,depth:q.reduce((n,p)=>n+p.z,0)/4});
    }
  }else if(holdImg){
    const a=hold.draw!=null?hold.draw:steveArmAngle(time,mob.vx||0,hold.swing);
    const f=armFrame(a,crouch);
    const hand=steveHand(a,crouch);
    const sh=proj(f.x,f.y,f.z);
    const hd=proj(hand.x,f.y+(hand.y-f.y)*1.12,f.z+(hand.z-f.z)*1.12);
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

/* entityMesh（模块顶层纯函数）在画盔甲层时要按需加载 armor/*贴图，
   boot 启动时把真正的实现挂进来；node 测试环境里是 no-op。
   ★ 声明必须放在 boot() 调用之前 —— boot 的同步段就会经过这条路径，
   放后面会撞 TDZ（Cannot access 'ensureTexture' before initialization）。 */
let ensureTexture=()=>{};
/* 贴图到货后的回调：图标缓存要重算、面板要重画（否则第一次打开背包时
   贴图还没加载完，草方块会一直显示成回退的平面图）。 */
let onTexture=null;
if(typeof document!=='undefined') boot();

async function boot(){
  const $=s=>document.querySelector(s);
  const canvas=$('#world'),ctx=canvas.getContext('2d',{alpha:false});
  const textureBase=new URL('textures/',import.meta.url),images={},tinted={};
  const audio=new GameAudio();

  let world=new World('ZFSN OVERWORLD'),playing=false,viewW=innerWidth,viewH=innerHeight,tile=32;
  let camera={x:30,y:30},camX=0,camY=0;
  /* 视觉范围（泰拉瑞亚式缩放）：真正控制视野的是 tile（每格像素）。
     tile = baseTile * zoom；zoom=1 为默认档，按住 +/− 每帧平滑推拉 zoom。 */
  let zoom=1,zoomKey=0,baseTile=34;
  const ZOOM_MIN=0.5,ZOOM_MAX=3.0,ZOOM_RATE=1.1;
  /* 实测帧率：F3 调试面板显示。rAF 的上限=显示器刷新率，这个数字用来看「有没有掉帧」。 */
  let fpsCount=0,fpsElapsed=0,fpsValue=0;
  let renderDpr=1;
  let last=performance.now(),accumulator=0,hudClock=0,saveClock=0,titleClock=0;
  let toastTimer,itemNameTimer,aim=null,mouseDown=false,rightHeld=false,touchMine=false,invSignature='',deadShown=false,debugOn=false;
  /* 「每次点击才攻击」的一次性标记：HOLD_TO_ATTACK=false 时，
     按下左键只算「一次攻击意图」，消费掉就不再触发。
     ★ 必须是「点击」而不是「按住」：按住左键挖矿会每 tick 调 attack()，
       每次都把攻击冷却清零 → strength 永远是 0，满力攻击打不出来。 */
  let attackClick=false;
  let panelSig='';                   // 上一次「背包面板」渲染时的内容指纹（见 hud 末尾）
  let press=null;                    // 按下未松开 {g,button,x,y,shift}

  let lastClick={key:'',t:0};        // 双击收集同名的判定（endPointer）
  let sprintHeld=false,lastDirCode='',lastDirAt=0;
  let audioReady=false;let enhancedLight=localStorage.getItem('zfsn.mc.light')!=='off';
  // 雨滴粒子的存储放在这里：resize() 在天空模块之前就会被调用一次，
  // 如果数组声明在下面，那次调用会撞上 TDZ。
  const rainDrops=[];
  const keys=new Set(),heldTouches=new Map();
  // 视觉范围提示条（泰拉瑞亚式）：缩放时短暂显示在右上角
  const zoomHud=document.createElement('div');zoomHud.id='zoom-hud';
  Object.assign(zoomHud.style,{position:'fixed',right:'14px',top:'14px',padding:'4px 10px',
    background:'rgba(0,0,0,.55)',color:'#fff',font:'600 13px/1.4 system-ui,sans-serif',
    borderRadius:'6px',pointerEvents:'none',opacity:'0',transition:'opacity .25s',zIndex:'50'});
  document.body.appendChild(zoomHud);
  let zoomHudTimer;
  function showZoomHud(){zoomHud.textContent='视觉范围 ×'+zoom.toFixed(2);zoomHud.style.opacity='1';
    clearTimeout(zoomHudTimer);zoomHudTimer=setTimeout(()=>zoomHud.style.opacity='0',700);}
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
    next.autoStep=autoStep;   // 新世界/读档都套用本地「自动跳跃」偏好
    invSignature='';deadShown=false;aim=null;keys.clear();heldTouches.clear();mouseDown=false;touchMine=false;
    press=null;dragSession=null;dragPreview=null;screen=null;
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
    /* 未交付生物模型的统一占位：原版缺失资源方格（紫/黑棋盘），启动即生成，
       避免运行时懒加载闪烁；不会伪装成随便画的“已完成贴图”。 */
    const missing=document.createElement('canvas');missing.width=missing.height=64;
    const mg=missing.getContext('2d');
    for(let y=0;y<8;y++)for(let x=0;x<8;x++){mg.fillStyle=(x+y)%2?'#141414':'#9a2cc8';mg.fillRect(x*8,y*8,8,8);}
    images.__missing_mob=missing;
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
    /* 渲染精度是帧数的大头：世界是像素风 + 不开平滑的整数放大，
       dpr=1 观感几乎无差，每帧填充量却比 dpr=2 少 75%。
       想要更细腻：控制台 localStorage.setItem('zfsn.mc.dpr','1.5') 后刷新；
       上限封在物理 devicePixelRatio，再高只是白烧填充率。 */
    const dpr=Math.min(parseFloat(localStorage.getItem('zfsn.mc.dpr'))||1,devicePixelRatio||1);
    renderDpr=dpr;
    canvas.width=Math.round(viewW*dpr);canvas.height=Math.round(viewH*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.imageSmoothingEnabled=false;
    baseTile=viewW<650?26:viewW<1100?30:34;
    tile=baseTile*zoom;
    seedRain();
  }
  addEventListener('resize',resize);resize();

  /* 所有方块、明暗层、选中框都用同一套整数像素坐标（camX/camY 是唯一取整点），
     并且都画 tile+1 宽来盖住缩放造成的亚像素缝。以前贴图用 Math.round、
     阴影用 Math.floor，差 1px 就是那道细缝。 */
  const pendingTextures=new Set();
  ensureTexture=(id)=>{   // 赋值给模块级 let（见文件顶部说明）
    if(!id||images[id]||pendingTextures.has(id))return;
    pendingTextures.add(id);const img=new Image();img.onload=()=>{images[id]=img;if(onTexture)onTexture(id);};
    img.src=new URL(`${id}.png`,textureBase).href;
  };
  function spriteAt(name,sx,sy,w,h,srcY=0){
    const image=tinted[name]||images[name];if(!image){ensureTexture(name);return;}
    const sw=Math.min(16,image.width),sh=Math.min(16,image.height);
    ctx.drawImage(image,0,srcY,sw,sh,sx,sy,w,h);
  }

  /* ── 方块图标（等轴测立方体）────────────────────────────────────
     物品栏/快捷栏/创造栏/手持物/掉落物全都走这里，按物品 id 缓存。
     非整方块（火把、花草、门…）退回平面 item 贴图。 */
  const iconTint=new Map();
  /* ── 合成缺失的面贴图 ─────────────────────────────────────────
   * 资源包里只有「用得到的那一面」：草方块只有侧/叠加层，原木只有柱面，
   * 没有 grass_block_top / oak_log_top 这些单面图。缺了顶面就画不出立方体，
   * 所以这里用现有贴图合成两张关键的面（都带固定种子，结果可复现，只做一次）：
   *   grass_block_top：从草方块侧面里挑出真正的草色像素，拼一张 16×16 噪点草皮
   *   *_log_top      ：从对应 *_log 里取深浅两色画同心方环（原版年轮）
   * 其余缺失面交给 icons.js 的回退链（退到同方块别的面）。 */
  const synthCache=new Map();
  const synthRng=seed=>{let s=seed>>>0;return()=>((s=(s*1664525+1013904223)>>>0)/4294967296);};
  function synthFace(name){
    if(!name)return null;
    if(synthCache.has(name))return synthCache.get(name);
    let made=null;
    const cv=document.createElement('canvas');cv.width=16;cv.height=16;
    const g=cv.getContext('2d');
    if(name==='grass_block_top'){
      const pal=[];
      const src=images.grass_block_side;
      if(src&&src.width){
        const tmp=document.createElement('canvas');tmp.width=16;tmp.height=16;
        const tg=tmp.getContext('2d');tg.drawImage(src,0,0,16,16,0,0,16,16);
        const d=tg.getImageData(0,0,16,16).data;
        for(let i=0;i<256;i++){
          const p=i*4;
          if(d[p+3]>128&&d[p+1]>d[p]+18)pal.push([d[p],d[p+1],d[p+2]]);
        }
      }
      if(!pal.length)pal.push([116,180,74],[104,168,66],[124,190,82],[96,158,60]);
      const rnd=synthRng(0x6d2b79f5);
      for(let y=0;y<16;y++)for(let x=0;x<16;x++){
        const c=pal[Math.floor(rnd()*pal.length)];
        g.fillStyle=`rgb(${c[0]},${c[1]},${c[2]})`;g.fillRect(x,y,1,1);
      }
      made=cv;
    }else{
      const m=name.match(/^(.+)_log_top$/);
      const base=m&&images[m[1]+'_log'];
      if(base&&base.width){
        // 取柱面平均色，做两档明暗交替的同心方环
        const tmp=document.createElement('canvas');tmp.width=16;tmp.height=16;
        const tg=tmp.getContext('2d');tg.drawImage(base,0,0,16,16,0,0,16,16);
        const d=tg.getImageData(0,0,16,16).data;
        let r=0,gr=0,b=0,n=0;
        for(let i=0;i<256;i++){const p=i*4;if(d[p+3]>128){r+=d[p];gr+=d[p+1];b+=d[p+2];n++;}}
        if(n){
          r=Math.round(r/n);gr=Math.round(gr/n);b=Math.round(b/n);
          const light=`rgb(${Math.min(255,r+14)},${Math.min(255,gr+12)},${Math.min(255,b+8)})`;
          const dark=`rgb(${Math.max(0,r-18)},${Math.max(0,gr-16)},${Math.max(0,b-12)})`;
          for(let ring=0;ring<8;ring++){
            g.fillStyle=ring%2?dark:light;
            g.fillRect(ring,ring,16-ring*2,16-ring*2);
          }
          made=cv;
        }
      }
    }
    synthCache.set(name,made);
    return made;
  }
  function tintFor(name,color){
    const key=`${name}|${color}`;
    if(iconTint.has(key))return iconTint.get(key);
    const src=images[name]||synthFace(name);
    if(!src||!src.width)return null;
    const cv=tintSheet(src,color);
    iconTint.set(key,cv);
    return cv;
  }
  const icons=createIconRenderer({
    size:32,
    getTexture(name){
      const img=images[name];
      if(img&&img.width)return img;
      /* 资源包里没有的单面图（grass_block_top / *_log_top）现场合成 */
      const made=synthFace(name);
      if(made)return made;
      ensureTexture(name);
      return null;
    },
    tint:(name,color)=>tintFor(name,color),
    fallbackURL(id){
      return new URL(ITEMS[id]?.cubeIcon?`../icons/${id}.png`:`${id}.png`,textureBase).href;
    },
    onUpdate(){ try{ if($('#inventory-dialog').open)inventory(); hud(true); }catch{} },
  });
  onTexture=()=>icons.refresh();
  /* ── 图标取用优先级 ──────────────────────────────────────────
   * icons/ 下是「原版渲染好的成品图标」：顶面/侧面/底面各归各位，明暗也对。
   * 以前把它当成兜底，首选是 icons.js 现场合成的等轴测立方体——而合成用的
   * 是 textures/ 里的单张方块贴图（工作台存的就是它的正面），于是：
   *   · 工作台、熔炉这类「顶≠侧」的方块，顶面被贴成了侧面图；
   *   · 开物品栏时贴图还没到货 → 先用 icons/ 的正确图标 → 0.5 秒后贴图到货
   *     被合成图替换 → 用户看到图标「变了一次」。
   * 现在只要有成品图标就直接用，合成图退化为真正的兜底（贴图都没到的极少数）。
   */
  const iconImages=new Map();          // id -> Image（icons/ 下的成品图标）
  function ensureIcon(id){
    if(!id||iconImages.has(id))return;
    iconImages.set(id,null);           // 占位，避免重复发起请求
    const img=new Image();
    img.onload=()=>{iconImages.set(id,img);};
    img.src=new URL(`../icons/${id}.png`,textureBase).href;
  }
  /** 图标地址（给 <img> 用）。 */
  function iconURL(id){
    if(ICON_IDS.has(id))return new URL(`../icons/${id}.png`,textureBase).href;
    const item=ITEMS[id];
    if(!item)return new URL(`${id}.png`,textureBase).href;
    if(item.faces&&iconKind(id)!=='flat'){
      const url=icons.urlFor(id,item.faces);
      if(url)return url;
    }
    ensureTexture(id);
    return new URL(item.cubeIcon?`../icons/${id}.png`:`${id}.png`,textureBase).href;
  }
  /** 图标画布（给 canvas 画掉落物/手持物用），没有就返回 null。 */
  function iconCanvas(id){
    if(ICON_IDS.has(id)){
      const img=iconImages.get(id);
      if(img)return img;
      ensureIcon(id);                  // 首帧还没到货 → 退平面贴图，下一帧就对了
      return null;
    }
    const item=ITEMS[id];
    if(!item)return null;
    if(item.faces&&iconKind(id)!=='flat')return icons.canvasFor(id,item.faces);
    return null;
  }
  /* ── 群系染色（规格书 §2.4）────────────────────────────────────────────
   * 原版的草方块侧面和树叶是灰度图，颜色靠「生物群系」在运行时乘上去。
   * 旧实现只染了固定的两张（oak_leaves / grass_block_side_overlay），所有群系
   * 长得一模一样；现在按「贴图名 + 群系色」缓存染色画布：
   *   · 同一群系只染一次（缓存命中就不再画 canvas）；
   *   · 换群系自动换色；
   *   · 群系没给颜色就退回固定色（跟旧行为一致，不会画不出来）。 */
  const tintCache=new Map();
  let tintLastKey='',tintLastImg=null;
  function tintFor(name,hex,fallback){
    const color=hex||fallback;
    if(!color)return null;
    const key=name+'|'+color;
    /* 一次一格的「上一格」记忆：可见范围里同一贴图+同一群系色会连着出现几十次，
       省掉每格一次的字符串拼接（每帧几千次 → 每帧几千个临时字符串）。 */
    if(key===tintLastKey)return tintLastImg;
    const hit=tintCache.get(key);
    if(hit){tintLastKey=key;tintLastImg=hit;return hit;}
    const src=images[name];
    if(!src){ensureTexture(name);return null;}
    const cv=document.createElement('canvas');cv.width=src.width;cv.height=src.height;
    const g=cv.getContext('2d');
    g.drawImage(src,0,0);
    g.globalCompositeOperation='source-atop';g.fillStyle=color;g.fillRect(0,0,cv.width,cv.height);
    g.globalCompositeOperation='multiply';g.drawImage(src,0,0);
    g.globalCompositeOperation='destination-in';g.drawImage(src,0,0);
    tintCache.set(key,cv);
    tintLastKey=key;tintLastImg=cv;
    return cv;
  }
  /* 群系取色：草（草方块/草） / 树叶 / 水
   * ★ 群系查询要跑一遍气候噪声（4 组 1D fBm），逐格调用会很贵
   *   → 每帧按「列」缓存一次：可见范围内 100 来列，1 次/列，够用了。 */
  const biomeRow=new Map();
  function biomeOf(x){
    const k=Math.floor(x);
    let b=biomeRow.get(k);
    if(b===undefined){b=world.biomeAt(k)||null;biomeRow.set(k,b);}
    return b;
  }
  function biomeColor(x,kind){
    const b=biomeOf(x);
    if(!b)return null;
    return kind==='grass'?b.grassColor:kind==='foliage'?b.foliageColor:b.waterColor;
  }
  function drawTinted(name,hex,fallback,sx,sy,w,h){
    const img=tintFor(name,hex,fallback);
    if(!img){spriteAt(name,sx,sy,w,h);return;}
    ctx.drawImage(img,0,0,Math.min(16,img.width),Math.min(16,img.height),sx,sy,w,h);
  }

  /* ── 装饰 / 薄片方块的画法（规格书 §6）───────────────────────────────
   *  · plant：花草（草、蕨、蒲公英、虞美人、枯灌木、甘蔗、藤蔓…）
   *    原版贴图下半部分才有内容，上半是透明的 → 整格画，
   *    透明部分自然露出后面的方块，看起来就是「长在地上」。
   *  · thin：贴在格子下沿的一层（雪层、铁轨、睡莲）→ 只画下沿一条。 */
  const THIN_DRAW={
    snow:    {srcY:0, srcH:16, ratio:.17},
    rail:    {srcY:4, srcH:8,  ratio:.30},
    lily_pad:{srcY:4, srcH:8,  ratio:.30},
  };
  function drawDecor(name,sx,sy,x){
    const thin=THIN_DRAW[name];
    if(thin){
      const h=Math.max(3,Math.round(tile*thin.ratio));
      const img=images[name];
      if(!img){ensureTexture(name);return;}
      ctx.drawImage(img,0,thin.srcY,Math.min(16,img.width),Math.min(16,thin.srcH),
        sx,sy+tile+1-h,tile+1,h);
      return;
    }
    // 草/蕨这类按群系草色染色
    if(name==='short_grass'||name==='fern'||name==='vine'){
      drawTinted(name,biomeColor(x,'grass'),'#79b64b',sx,sy,tile+1,tile+1);
      return;
    }
    spriteAt(name,sx,sy,tile+1,tile+1);
  }

  function drawBlock(id,sx,sy,x){
    const name=BLOCKS[id].id;
    /* 装饰类：不是整方块，单独画 */
    if(WG_DECOR.has(name)||WG_THIN_LAYER.has(name)){drawDecor(name,sx,sy,x);return;}
    if(name.endsWith('_leaves')){
      drawTinted(name,biomeColor(x,'foliage'),'#77ab2f',sx,sy,tile+1,tile+1);
      return;
    }
    spriteAt(name,sx,sy,tile+1,tile+1);
    if(id===1){   // 草方块：侧面下半是土、上半是草 → 叠加层按群系草色染色
      drawTinted('grass_block_side_overlay',biomeColor(x,'grass'),'#79b64b',sx,sy,tile+1,tile+1);
    }
  }
  const WFRAMES=32;
  /* 流体视觉高度（任务书 7.）：height = amount/9；本格 falling 或上方有同类
     流体时为 1.0（贴满整格）。 */
  function fluidHeightAt(x,y){
    const f=world.fluidGet(x,y);
    if(!f)return 0;
    const above=world.fluidGet(x,y-1);
    if(f.falling||(above&&above.type===f.type))return C.FLUID.FALLING_HEIGHT;
    return f.amount/C.FLUID.HEIGHT_DIVISOR;
  }
  function drawFluid(sx,sy,x,y,id){
    const full=tile+1,f=world.fluidGet(x,y);
    if(!f)return;
    const hSelf=fluidHeightAt(x,y);
    if(hSelf<=0)return;
    /* 表面平滑：每格左右两个角点高度取「本格与相邻同类流体格高度的平均」。
       相邻为空取本格高度；相邻方块上方有同类流体则按满格参与平均。
       顶边画成斜线，避免阶梯状锯齿。 */
    const corner=(dx)=>{
      const nf=world.fluidGet(x+dx,y);
      if(nf&&nf.type===f.type)return (hSelf+fluidHeightAt(x+dx,y))/2;
      const na=world.fluidGet(x+dx,y-1);
      if(na&&na.type===f.type)return (hSelf+C.FLUID.FALLING_HEIGHT)/2;
      return hSelf;
    };
    const hL=clamp(corner(-1),.06,1),hR=clamp(corner(1),.06,1);
    ctx.save();ctx.beginPath();
    ctx.moveTo(sx,sy+full*(1-hL));
    ctx.lineTo(sx+full,sy+full*(1-hR));
    ctx.lineTo(sx+full,sy+full);
    ctx.lineTo(sx,sy+full);
    ctx.closePath();ctx.clip();
    if(id===LAVA_ID){
      /* 岩浆没有贴图：程序化熔岩 —— 不透明橙红底 + 随时间流动的亮纹
         （任务书 7. "没有动画纹理就用滚动偏移"），亮部即发光表现。 */
      const t=world.elapsed*.8;
      ctx.fillStyle='#c8430a';ctx.fillRect(sx,sy,full,full);
      ctx.fillStyle='#e06a1c';
      ctx.fillRect(sx,sy+((t*10+x*17)%full),full,Math.max(2,full*.16));
      ctx.fillStyle='#ffd23e';
      ctx.globalAlpha=.35+.25*Math.sin(t*2.3+x*.9+y*.7);
      ctx.fillRect(sx,sy+((t*16+y*29)%full),full,2);
      ctx.globalAlpha=1;
    }else{
      const frame=Math.floor(world.elapsed*2)%WFRAMES;
      /* 水的颜色跟群系走（沼泽是墨绿、丛林是青蓝、雪原是深蓝） */
      const sheet=tintFor('water_still',biomeColor(x,'water'),'#3f76e4')||images.water_still;
      ctx.globalAlpha=C.FLUID.WATER_ALPHA;
      ctx.drawImage(sheet,0,frame*16,16,16,sx,sy,full,full);
      ctx.globalAlpha=1;
    }
    ctx.restore();
  }
  function drawParticles(){
    ctx.save();ctx.imageSmoothingEnabled=false;
    for(const q of world.particles){
      const alpha=clamp(q.life/q.maxLife,0,1),sx=Math.round(q.x*tile-camX),sy=Math.round(q.y*tile-camY);
      const size=Math.max(2,Math.round(q.size*tile));
      if(q.kind==='block'||q.kind==='dust'){
        const img=tinted[q.id]||images[q.id];
        if(img){ctx.globalAlpha=alpha;ctx.drawImage(img,q.u,q.v,4,4,sx-size/2,sy-size/2,size,size);continue;}
      }
      if(q.kind==='pickup'&&q.id&&images[q.id]){
        ctx.globalAlpha=alpha;ctx.drawImage(images[q.id],0,0,images[q.id].width,images[q.id].height,sx-size,sy-size,size*2,size*2);continue;
      }
      ctx.globalAlpha=alpha;
      ctx.fillStyle=q.color||'#ffffff';
      if(q.kind==='crit'){ctx.fillRect(sx-size/2,sy-size*1.6,size,size*3);ctx.fillRect(sx-size*1.6,sy-size/2,size*3,size);}
      /* 横扫弧线：一段向前的白色弧形（提示词第 3 节「播放横扫动画」）。
         用描边的半圆画，弧度随剩余寿命从 1 收到 0 —— 挥过去又收回来。 */
      else if(q.kind==='sweep'){
        const k=clamp(q.life/q.maxLife,0,1);
        const r=tile*1.25*k;
        ctx.strokeStyle=q.color||'#e8e8e8';
        ctx.lineWidth=Math.max(2,tile*.14);
        ctx.beginPath();
        ctx.arc(sx,sy,r,-.9,.9);
        ctx.stroke();
      }
      else ctx.fillRect(sx-size/2,sy-size/2,size,size);
    }
    ctx.globalAlpha=1;ctx.restore();
  }

  /* 明暗层：把每格的暗度写进一张「一格一像素」的小图，再放大贴上去。
     放大时开双线性插值 → 就是 MC 的平滑光照：格与格之间渐变过渡，
     而不是一块块硬边方格。为了让边缘也正确插值，小图四周多留 1 圈
     padding（取最近格的值），否则最外圈会被拉出一圈亮边。

     另：这里绝不能沿用早期的「逐格 fillRect(tile+1) 半透明黑」，
     相邻两格重叠 1px 会被叠两次，整片地形浮出网格状暗线 ——
     那正是用户说的「方块之间对不齐」。 */
  /* 火把光晕贴图：预渲染一次，每帧只 drawImage。
     以前每个可见火把每帧都 createRadialGradient + fillRect，火把一多就掉帧。 */
  const glowCanvas=document.createElement('canvas');glowCanvas.width=glowCanvas.height=128;
  {const g=glowCanvas.getContext('2d');
   const rg=g.createRadialGradient(64,64,0,64,64,64);
   rg.addColorStop(0,'rgba(255,174,70,.2)');rg.addColorStop(1,'rgba(255,130,30,0)');
   g.fillStyle=rg;g.fillRect(0,0,128,128);}
  let vignetteGrad=null,vignetteKey='';
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
    /* 性能：内层是「可见格数 × 火把数」的热循环。先用坐标差做平方级
       快速剔除，命中才开平方 —— 火把插得多的时候能省掉一大半 Math.hypot。 */
    for(let j=0;j<ch;j++)for(let i=0;i<cw;i++){
      const x=clamp(minX+i-pad,minX,maxX),y=clamp(minY+j-pad,minY,maxY);
      let darkness=Math.max(1-light,clamp((y-world.surfaceAt(x)-1)*.1,0,.96));
      if(playing){const pdx=x-p.x,pdy=y-p.y,pd2=pdx*pdx+pdy*pdy;
        if(pd2<17.64){const d=Math.sqrt(pd2);darkness=Math.min(darkness,.26+d*.16);}}
      for(const t of torches){const dx=t.x-x;if(dx>7.5||dx<-7.5)continue;
        const dy=t.y-y;if(dy>7.5||dy<-7.5)continue;
        const d=Math.sqrt(dx*dx+dy*dy);if(d<7.5)darkness=Math.min(darkness,Math.max(.02,d*.115));}
      const o=(j*cw+i)*4;
      const a=Math.round(clamp(darkness,0,1)*255);
      data[o]=4;data[o+1]=8;data[o+2]=18;data[o+3]=a;
      if(a>4)any=true;
    }
    if(!any)return;
    shadeCtx.putImageData(shadeData,0,0);
    ctx.save();
    /* 放大 30 多倍时 'high' 的重型重采样对一张一格一像素的纯色小图毫无视觉
       收益，却慢好几倍 —— 注释要的「双线性插值」就是 'low' 的默认行为。 */
    ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='low';
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
    tile=baseTile*zoom;            // 每帧用最新缩放刷新每格像素，驱动视觉范围
    biomeRow.clear();              // 群系染色缓存：每帧重建（只按列算一次）
    const p=world.player;
    /* 渲染插值：逻辑固定 20 TPS，屏幕刷新率是 60/120/144 —— 直接把 tick 后的
       位置画出来会让移动一顿一顿。alpha = 累加器里剩余的 tick 比例，
       位置在「上一 tick」与「这一 tick」之间线性插值。 */
    const alpha=clamp(world.alpha||0,0,1);
    const lerp=(a,b)=>a+(b-a)*alpha;
    const rpx=lerp(p.px??p.x,p.x), rpy=lerp(p.py??p.y,p.y);
    const desiredX=playing?rpx+p.w/2-viewW/tile*.5:49-viewW/tile*.52+Math.sin(titleClock*.16)*3.2;
    const desiredY=playing?rpy+p.h/2-viewH/tile*.47:world.surfaceAt(49)-viewH/tile*.48;
    /* 世界在 X 方向是无限的 → 摄像机不再夹在 [0, W] 里（规格书 §1/§9）。
   超出 ±2^25（整数安全范围）时给一个边界提示，而不是无声地卡住。 */
    camera.x=Math.abs(desiredX)>SAFE_X?clamp(desiredX,-SAFE_X,SAFE_X):desiredX;
    camera.y=clamp(desiredY,-15,H-viewH/tile);
    /* 受击镜头抖动（提示词第 5/12 节）：world.shake 在受击时置高，
       每帧按随机方向偏移摄像机，指数衰减回 0。 */
    const shk=world.shake??0;
    if(shk>0){
      const amp=shk*6;
      camera.x+=(Math.random()-.5)*amp;
      camera.y+=(Math.random()-.5)*amp;
    }
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

    const minX=Math.floor(camera.x),maxX=Math.ceil(camera.x+viewW/tile);
    const minY=Math.max(0,Math.floor(camera.y)),maxY=Math.min(H-1,Math.ceil(camera.y+viewH/tile));
    const torches=[],waterCells=[];
    for(let y=minY;y<=maxY;y++)for(let x=minX;x<=maxX;x++){
      const sx=x*tile-camX,sy=y*tile-camY,id=world.get(x,y);
      if(y>world.surfaceAt(x)+2){ctx.fillStyle='#302e29';ctx.fillRect(sx,sy,tile+1,tile+1);}
      if(id===WATER_ID||id===LAVA_ID){waterCells.push([sx,sy,x,y,id]);continue;}
      if(!id)continue;
      drawBlock(id,sx,sy,x);
      if(id===16)torches.push({x,y});
      if(id===14&&world.furnaces[`${x},${y}`]?.input)spriteAt('furnace_front_on',sx,sy,tile+1,tile+1);
    }
    for(const[sx,sy,x,y,id]of waterCells)drawFluid(sx,sy,x,y,id);

    /* 掉落物：用同一套立方体图标，缩到约 0.25 格，上下浮动 + 轻微摇摆 */
    for(const d of world.drops)if(d.x>=minX-1&&d.x<=maxX+1){
      const dx=lerp(d.px??d.x,d.x),dy=lerp(d.py??d.y,d.y);
      const bob=Math.sin(world.elapsed*2.6+d.x*1.7)*tile*.05;
      const size=Math.round(tile*.5);
      const x=Math.round(dx*tile-camX+tile*.25-size/2),y=Math.round(dy*tile-camY+tile*.25-size/2+bob);
      const icon=iconCanvas(d.id);
      if(icon)ctx.drawImage(icon,x,y,size,size);
      else spriteAt(d.id,x,y,Math.round(size*.8),Math.round(size*.8));
    }

    // 弓/投掷物：贴图按飞行方向旋转；插住时保持最后角度
    for(const a of world.arrows)ensureTexture(a.tex||'arrow_projectile');
    for(const a of world.arrows){
      if(a.x<minX-2||a.x>maxX+2)continue;
      const img=images[a.tex||'arrow_projectile']||images.__missing_mob;
      const sx=Math.round(a.x*tile-camX),sy=Math.round(a.y*tile-camY);
      if(!img){continue;}
      ctx.save();ctx.translate(sx,sy);ctx.rotate(a.ang);ctx.imageSmoothingEnabled=false;
      ctx.drawImage(img,-tile*.45,-tile*.15,tile*.9,tile*.3);ctx.restore();
    }

    for(const m of world.mobs)if(m.x>=minX-2&&m.x<=maxX+2){
      const mx=lerp(m.px??m.x,m.x),my=lerp(m.py??m.y,m.y);
      const mc=Math.round((mx+m.w/2)*tile-camX),gy=Math.round((my+m.h)*tile-camY);
      /* 死亡倒地：20 tick 内绕脚底转 90° 躺下并淡出（提示词第 9 节
         「生物死亡 20 tick 倒地动画后再消失并掉落」）。 */
      if(m.dying){
        const k=Math.min(1,(m.deathTicks||0)/(m.deathMax||C.MOB_DEATH_TICKS));
        ctx.save();
        ctx.translate(mc,gy);ctx.rotate(k*Math.PI/2);
        ctx.globalAlpha=Math.max(.25,1-k*.65);
        drawEntity(ctx,images,m,world.elapsed,0,0,m.h*tile,m.yaw??0.95);
        ctx.restore();
        continue;
      }
      /* 苦力怕引信：膨胀 + 闪白（提示词第 9 节） */
      if(m.fuse>0){
        const f=1-m.fuse/C.CREEPER_FUSE_TICKS;
        const s=1+.22*Math.sin(f*Math.PI*4);
        ctx.save();
        ctx.translate(mc,gy);ctx.scale(s,s);
        drawEntity(ctx,images,m,world.elapsed,0,0,m.h*tile,m.yaw??0.95);
        ctx.restore();
        ctx.save();
        ctx.globalAlpha=.25+.35*Math.abs(Math.sin(f*Math.PI*6));
        ctx.globalCompositeOperation='lighter';
        ctx.fillStyle='#fff';
        ctx.fillRect(mc-m.w*tile*.55,gy-m.h*tile,m.w*tile*1.1,m.h*tile);
        ctx.restore();
        continue;
      }
      drawEntity(ctx,images,m,world.elapsed,mc,gy,m.h*tile,m.yaw??0.95);
      if(m.customName&&!m.dying){
        const label=String(m.customName);
        ctx.font='13px MCBitmap,monospace';ctx.textAlign='center';
        const w=ctx.measureText(label).width+8;
        ctx.fillStyle='rgba(0,0,0,.45)';ctx.fillRect(mc-w/2,gy-m.h*tile-22,w,16);
        ctx.fillStyle='#fff';ctx.fillText(label,mc,gy-m.h*tile-10);ctx.textAlign='left';
      }
    }
    const boss=world.mobs.find(m=>!m.dying&&(MOBS[m.type]?.components?.bossBar)&&Math.abs(m.x-p.x)<M.BOSS_BAR_RANGE);
    if(playing&&boss){
      const rec=MOBS[boss.type],bw=Math.min(360,viewW*.6),bx=(viewW-bw)/2,by=34;
      ctx.fillStyle='rgba(0,0,0,.45)';ctx.fillRect(bx-2,by-2,bw+4,18);
      ctx.fillStyle='#3b3b3b';ctx.fillRect(bx,by,bw,14);
      ctx.fillStyle='#d82a3a';ctx.fillRect(bx,by,bw*clamp(boss.health/boss.maxHealth,0,1),14);
      ctx.font='14px MCBitmap,monospace';ctx.textAlign='center';ctx.fillStyle='#fff';ctx.fillText(rec.name,viewW/2,by+12);ctx.textAlign='left';
    }
    if(playing){
      if(p.invuln>.2&&Math.floor(p.invuln*12)%2)ctx.globalAlpha=.45;
      else if(p.hurtTime>0&&Math.floor(p.hurtTime*6)%2)ctx.globalAlpha=.55;   // 受伤红闪
      const pc=Math.round((rpx+p.w/2)*tile-camX),py=Math.round((rpy+p.h)*tile-camY);
      // 挥臂相位：挖掘时连续循环，其余动作（放置/攻击/吃东西）播一次性动画
      const breaking=!!(world.breakState.pos&&world.isBreaking);
      const swingPhase=breaking?((world.swingT||0)*2.4)%1
                      :(p.swing>0?1-p.swing/p.swingDur:null);
      // 贴图要过一遍 tinted：树叶在原版是灰度图靠生物群系染色，直接取 images 会是一坨灰
      const heldId=world.held()?.id;
      /* 手持物：工具走原版三面贴图模型，其余（方块）用手上那套立方体图标 ——
         和物品栏里看到的是同一个图标，观感统一。 */
      const heldItem=ITEMS[heldId];
      let holdImg=heldId?(heldItem?.tool?(tinted[heldId]||images[heldId]):(iconCanvas(heldId)||tinted[heldId]||images[heldId])):null;
      let armOverride=null;
      if(world.drawBow&&heldId==='bow'){
        const power=Math.min(1,world.drawBow.ticks/C.BOW_CHARGE_TICKS);
        const frame=power<.3?'bow_pulling_0':power<.65?'bow_pulling_1':'bow_pulling_2';
        ensureTexture(frame);
        holdImg=images[frame]||holdImg;
        armOverride=-.3-.85*power;
      }
      /* ★ 走路动画修复：entityMesh/steveArmAngle 的 velocity 参数是按「格/秒」
         设计的（生物的 vx 就是格/秒，如僵尸 1.9），而玩家的 vx 是格/tick（≈0.2），
         直接传进去摆臂/摆腿幅度只剩一成，看起来就像没有走路动画。
         这里换算成格/秒再传；walking 4.317 → 满幅，潜行 1.3 → 半幅，符合观感。 */
      /* 蹲下时模型仍按站立高度画（STEVE_STAND_H）：碰撞盒缩到 1.5 是玩法，
         视觉上要的是「弯下去」而不是「整个人被压小」。drawEntity 内部
         也改用站姿基准高度缩放，两者配套才不会出现零件忽大忽小。 */
      drawEntity(ctx,images,{...p,type:'steve',vx:p.vx*TICK_RATE},world.elapsed,pc,py,
        (p.crouch?STEVE_STAND_H:p.h)*tile,p.face>0?0.95:-0.95,
        {id:heldId,img:holdImg,swing:swingPhase,draw:armOverride});
      ctx.globalAlpha=1;
    }

    // 明暗：一次整片贴图，和方块共用 camX/camY，没有重叠也就没有缝
    drawShade(minX,minY,maxX,maxY,torches,p,light);
    drawParticles();

    if(enhancedLight){
      ctx.save();ctx.globalCompositeOperation='screen';
      for(const t of torches){const x=(t.x+.5)*tile-camX,y=(t.y+.4)*tile-camY,r=tile*2.4;
        ctx.drawImage(glowCanvas,x-r,y-r,r*2,r*2);}
      /* 暗角渐变只跟窗口尺寸有关：缓存，resize 才重建 */
      const vKey=viewW+'x'+viewH;
      if(!vignetteGrad||vignetteKey!==vKey){vignetteKey=vKey;
        vignetteGrad=ctx.createRadialGradient(viewW/2,viewH/2,viewH*.2,viewW/2,viewH/2,Math.max(viewW,viewH)*.7);
        vignetteGrad.addColorStop(0,'transparent');vignetteGrad.addColorStop(1,'rgba(12,20,40,.22)');}
      ctx.fillStyle=vignetteGrad;ctx.fillRect(0,0,viewW,viewH);ctx.restore();
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
      /* 裂纹：stage = floor(progress*10)，只在「正在挖的这一格」上叠加。
         目标改变或松手时 breakState.pos/progress 已经清空，裂纹立刻消失。 */
      const bs=world.breakState;
      if(bs.pos&&bs.progress>0){
        const stage=Math.min(C.DESTROY_STAGES-1,Math.floor(bs.progress*C.DESTROY_STAGES));
        spriteAt(`destroy_stage_${stage}`,bs.pos.x*tile-camX,bs.pos.y*tile-camY,tile+1,tile+1);
      }
    }
    if(playing&&p.hurtTime>0){ctx.fillStyle=`rgba(176,31,24,${(.16*p.hurtTime/10).toFixed(3)})`;ctx.fillRect(0,0,viewW,viewH);}
    else if(playing&&p.invuln>.8){ctx.fillStyle='rgba(176,31,24,.14)';ctx.fillRect(0,0,viewW,viewH);}
    if(world.lightning>0){ctx.fillStyle=`rgba(224,236,255,${(world.lightning*.62).toFixed(3)})`;ctx.fillRect(0,0,viewW,viewH);}
  }

  // ── 槽位 ──────────────────────────────────────────────────────
  function iconImg(id){if(!ICON_IDS.has(id))ensureTexture(id);const img=document.createElement('img');img.src=iconURL(id);img.alt='';img.draggable=false;img.className='icon';return img;}
  /* ── 格子 DOM ──────────────────────────────────────────────────
     stack 要显示的栈；g 是「屏幕容器」里的全局下标（见 buildScreen）；
     hotbar=true 表示屏幕底部那条快捷栏（用 onclick 切换选中，不参与容器交互）。 */
  function slotNode(stack,g,hotbar){
    // ★ 存档里出现当前版本不认识的 id 时不能硬崩：slotNode 一旦抛错，
    //   hud() 已经把 invSignature 写掉了、inventory() 也只画到一半 ——
    //   表现就是「快捷栏/背包卡在旧内容不动」。这里降级成空格。
    if(stack&&!ITEMS[stack.id])stack=null;
    const b=document.createElement('button');
    b.type='button';b.className='slot';
    b.setAttribute('aria-label',stack?`${ITEMS[stack.id].name} × ${stack.n}`:'空');
    // 名字挂到 data-tip 上，由统一的 tooltip 显示（原版那种深紫框）。
    // 不用原生 title：浏览器要悬停约 1 秒才弹，而且样式是系统菜单风，和原版差太远。
    if(stack)b.dataset.tip=stackTip(stack);
    if(hotbar){
      b.style.position='absolute';b.style.left=(6+40*g)+'px';b.style.top='6px';
      b.onclick=()=>{world.selected=g;showItemName();hud(true);};
    }else if(g!==null&&g!==undefined){
      // 容器里的格子走 pointerdown/pointerup 那一套（拖拽、右键、分堆），不用 onclick：
      // onclick 只能表达「点了一下」，表达不了按下-拖动-松开。
      b.dataset.g=g;
    }
    if(stack)fillSlot(b,stack);
    return b;
  }
  /** 把物品图标、数量、耐久条画进格子。extra = 拖拽预览时「将会变成多少」。 */
  function fillSlot(b,stack,extra){
    b.append(iconImg(stack.id));
    const n=extra===undefined||extra===null?stack.n:extra;
    if(n>1){const c=document.createElement('span');c.className='count';c.textContent=n;b.append(c);}
    const max=ITEMS[stack.id]?.durability;
    if(stack.dur&&max){
      const bar=document.createElement('div');bar.className='dur';
      const fill=document.createElement('i');
      const k=clamp(stack.dur/max,0,1);
      fill.style.width=`${k*100}%`;
      fill.style.background=`hsl(${Math.round(k*120)},88%,45%)`;   // 绿 → 红
      bar.append(fill);b.append(bar);
    }
  }
  function stackTip(stack){
    const item=ITEMS[stack.id];
    if(!item)return '';
    let text=item.name;
    if(stack.dur&&item.durability)text+=`\n耐久 ${stack.dur} / ${item.durability}`;
    return text;
  }

  /* ── 物品栏交互：数据层 + 一层很薄的 UI 胶水 ─────────────────────
   *
   * 所有「点一下格子会发生什么」都交给 inventory.js 的 Container.click()：
   *   PICKUP / QUICK_MOVE / SWAP / CLONE / THROW / QUICK_CRAFT / PICKUP_ALL
   * 这里只做两件事：
   *   1. 把 world 里散落的数组拼成一个统一的「屏幕容器」（46 格 + 工作台 10 格）
   *   2. 把鼠标/键盘事件翻译成「哪个格子 + 哪个键 + 哪种模式」
   * 这样物品数量守恒、堆叠上限、盔甲槽规则都是纯数据逻辑，可以脱机测试。
   */
  const heldCursor=$('#held-cursor');
  let craftMode='inv';
  let screen=null;                       // {c:Container, table:bool, outIndex:number}
  let dragSession=null;                  // 拖拽中的 DragSession
  let dragPreview=null;                  // 拖拽均分预览：g → 最终数量
  let hoverG=null;                       // 鼠标当前悬停的格子（数字键/F 用）
  let skipDialogClose=false;             // 「点面板外丢东西」时不要顺手关界面
  const gridRef=()=>craftMode==='table'?world.tableGrid:world.craftGrid;
  const stackLimit=id=>ITEMS[id]?.stack??64;
  let pointerPos={x:innerWidth/2,y:innerHeight/2};

  function buildScreen(){
    const table=craftMode==='table';
    const keep=screen?.c?.cursor??null;          // 重开面板时手上的东西不能丢
    const slots=buildPlayerSlots({
      inventory:world.inventory,
      armor:world.player.armor,
      grid:world.craftGrid,
      offhand:{get value(){return world.offhand;},set value(v){world.offhand=v;}},
      output:()=>{const r=world.findGridRecipe();return r?{id:r.out,n:r.n}:null;},
    });
    if(table)slots.push(...buildTableSlots({
      grid:world.tableGrid,
      output:()=>{const r=world.findTableRecipe();return r?{id:r.out,n:r.n}:null;},
    }));
    const c=new Container(slots,{maxStack:id=>stackLimit(id)});
    c.cursor=keep;
    /* bound：槽位闭包捕获的对象引用。死亡（startDeath 整体替换 armor 对象）、
       读档（World.restore 换整个 world）都会让旧绑定失效，inventory() 靠它
       判断要不要重建屏幕。 */
    return {c,table,outIndex:table?LAYOUT.TABLE_OUTPUT:LAYOUT.OUTPUT,
      bound:[world.inventory,world.player.armor,world.craftGrid,world.tableGrid]};
  }
  function reScreen(){screen=buildScreen();return screen;}
  const cursor=()=>screen?.c?.cursor??null;
  function setCursor(v){if(screen)screen.c.cursor=v??null;}

  /* Shift+点击的落点。原版语义：
     快捷栏 → 主背包；主背包 → 快捷栏；盔甲/合成格 → 背包；装备自动穿上。 */
  function quickOrder(g){
    const slot=screen?.c?.slots[g];
    if(!slot)return [];
    const range=(a,b)=>Array.from({length:b-a+1},(_,i)=>a+i);
    const main=range(LAYOUT.MAIN,LAYOUT.MAIN_END);
    const hot=range(LAYOUT.HOTBAR,LAYOUT.HOTBAR_END);
    const bag=[...main,...hot];
    const st=slot.get();
    if(slot.tag==='inv'||slot.tag==='offhand'){
      const part=armorPartOf(st?.id);
      if(part){
        const ai=LAYOUT.ARMOR+ARMOR_PARTS.indexOf(part);
        if(screen.c.slots[ai]&&!screen.c.slots[ai].get())return [ai];
      }
      if(slot.tag==='offhand')return bag;
      return slot.meta<9?main:hot;
    }
    return bag;      // 盔甲槽 / 合成格 / 工作台合成格 → 回背包（主背包先，再快捷栏）
  }

  function renderHeld(){
    heldCursor.replaceChildren();
    const cur=cursor();
    if(!cur){heldCursor.hidden=true;return;}
    heldCursor.hidden=false;
    heldCursor.style.left=pointerPos.x+'px';heldCursor.style.top=pointerPos.y+'px';
    heldCursor.append(iconImg(cur.id));
    if(cur.n>1){const c=document.createElement('span');c.className='count';c.textContent=cur.n;heldCursor.append(c);}
    const max=ITEMS[cur.id]?.durability;
    if(cur.dur&&max){
      const bar=document.createElement('div');bar.className='dur';
      const fill=document.createElement('i');
      const k=clamp(cur.dur/max,0,1);
      fill.style.width=`${k*100}%`;fill.style.background=`hsl(${Math.round(k*120)},88%,45%)`;
      bar.append(fill);heldCursor.append(bar);
    }
  }
  function syncInv(){renderHeld();inventory();hud(true);}

  /* 统一的点击入口。返回是否发生状态变化。 */
  function doClick(g,button,mode,opts={}){
    if(!screen)return false;
    if(g===null||g===undefined){
      const changed=screen.c.click(null,button,mode,{quickOrder,craftAll,...opts});
      flushOutbox();
      return changed;
    }
    const slot=screen.c.slots[g];
    if(!slot)return false;
    if(slot.output){                       // 合成输出：能取不能放
      if(mode==='quick'){craftAll();return true;}
      if(mode==='pickup'){if(button===0)takeResult(g);return true;}
      return false;
    }
    const changed=screen.c.click(g,button,mode,{quickOrder,craftAll,...opts});
    flushOutbox();
    return changed;
  }
  function flushOutbox(){
    const out=screen?.c?.outbox;
    if(!out||!out.length)return;
    for(const s of out)throwStack(s);
    out.length=0;
  }
  /** 丢出的物品朝玩家面向抛出；40 tick 内不能被自己捡回（原版行为）。 */
  function throwStack(s){
    const p=world.player,dir=p.face||1;
    world.drops.push({
      id:s.id,n:s.n,x:p.x+p.w/2,y:p.y+.6,w:.3,h:.3,
      vx:dir*C.THROW_SPEED_PPS,vy:-3.2,age:0,pickupDelay:C.THROW_PICKUP_DELAY,
      ...(s.dur?{dur:s.dur}:{}),
    });
    world.sound('click',p.x,.4);
  }

  /* 取一次合成产物：光标为空或同类且放得下才取，材料每格扣 1 个。 */
  function takeResult(g){
    const table=!!screen?.table;
    const recipe=table?world.findTableRecipe():world.findGridRecipe();
    if(!recipe)return;
    const out={id:recipe.out,n:recipe.n};
    const cur=cursor();
    if(cur&&(!sameStack(cur,out)||cur.n+out.n>stackLimit(out.id)))return;
    const grid=table?world.tableGrid:world.craftGrid;
    const w=grid.length>=9?3:2;
    const before=grid.slice();
    const res=consumeForCraft(grid,w,w,recipe,CRAFT_REMAINDER);
    if(!res){for(let i=0;i<grid.length;i++)grid[i]=before[i];return;}
    setCursor(cur?{...cur,n:cur.n+out.n}:{...out});
    world.sound('click',world.player.x,.4);
    syncInv();
  }
  /* Shift+点击产物格：反复合成，直到材料不够或背包放不下 */
  function craftAll(){
    const take=()=>craftMode==='table'?world.takeTableRecipe():world.takeGridRecipe();
    let made=0,guard=0;
    while(guard++<64&&take())made++;
    notify(made?`一键合成了 ${made} 次`:'材料不够合成');
    syncInv();
  }

  /* 关闭界面时把光标/合成格里的东西塞回背包，塞不下的掉在脚边。
     顺序：光标 → 2×2 合成格 → 工作台 3×3。宁可掉在地上，也不能让物品凭空消失。 */
  function returnHeld(){
    if(!screen)return;
    const c=screen.c;
    const order=[
      ...Array.from({length:27},(_,i)=>LAYOUT.MAIN+i),
      ...Array.from({length:9},(_,i)=>LAYOUT.HOTBAR+i),
    ];
    const leftovers=[];
    const left=c.drainCursor(order);
    if(left)leftovers.push(left);
    for(const tag of ['grid','tgrid']){
      c.slots.forEach(slot=>{
        if(slot.tag!==tag)return;
        const s=slot.get();if(!s)return;
        slot.set(null);
        const rest=world.add(s.id,s.n,s.dur);
        if(rest>0)leftovers.push({...s,n:rest});
      });
    }
    for(const s of leftovers)world.drop(s.id,s.n,world.player.x+.2,world.player.y+.5,s.dur);
    if(leftovers.length)notify('背包满了，放不下的物品掉在脚边');
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

  /* ── 鼠标：按下 / 拖动 / 松开 ─────────────────────────────────────
     按下记一个 press，松开时才结算成一次点击；中途移动超过 6px 就转成拖拽。
     双击（250ms 内同一格）走 PICKUP_ALL。 */
  function gAt(x,y){
    const el=document.elementFromPoint(x,y)?.closest?.('.slot[data-g]');
    return el?Number(el.dataset.g):null;
  }
  document.addEventListener('pointerdown',e=>{
    if(!$('#inventory-dialog').open||!screen)return;
    if(e.button!==0&&e.button!==2)return;
    const el=e.target.closest?.('.slot[data-g]');
    if(!el){
      /* 点到面板外：手上有东西就丢出去（左键整堆 / 右键一个），空手才关界面 */
      if(e.target===$('#inventory-dialog')&&cursor()){
        e.preventDefault();e.stopPropagation();
        skipDialogClose=true;
        doClick(null,e.button,'throw_cursor');
        syncInv();
      }
      return;
    }
    e.preventDefault();
    tipHide();                                 // 按住开始拖塔时别让名字挡着
    press={g:Number(el.dataset.g),button:e.button,x:e.clientX,y:e.clientY,shift:e.shiftKey};
    dragSession=null;dragPreview=null;
  },true);

  addEventListener('pointermove',e=>{
    pointerPos={x:e.clientX,y:e.clientY};
    if(cursor()){heldCursor.style.left=e.clientX+'px';heldCursor.style.top=e.clientY+'px';}
    tipMove(e.clientX,e.clientY);
    if($('#inventory-dialog').open)hoverG=gAt(e.clientX,e.clientY);
    if(!press||!screen)return;
    if(!dragSession){
      const g=gAt(e.clientX,e.clientY);
      const sameG=g===press.g;
      if(Math.hypot(e.clientX-press.x,e.clientY-press.y)<6&&(sameG||g===null))return;
      if(!cursor())doClick(press.g,press.button,'pickup');   // 先把这一格「拿起来」
      if(!cursor())return;
      dragSession=new DragSession(screen.c,press.button,{creative:world.mode==='creative'});
      dragSession.begin(press.g);
    }
    const g=gAt(e.clientX,e.clientY);
    if(g!==null&&dragSession&&dragSession.pass(g)){
      dragPreview=dragSession.projection();
      syncInv();
    }
  });

  function endPointer(){
    if(!press)return;
    const info=press;press=null;
    hoverG=null;
    if(dragSession){
      dragSession.end();
      dragSession=null;dragPreview=null;
      syncInv();
      return;
    }
    /* 双击收集：必须拦在普通点击之前 —— 第二次点击时格子已经空了，
       走 clickSlot 会把手上的东西原样放回去，收集永远触发不了。 */
    const now=performance.now();
    const key=`${info.g}`;
    if(info.button===0&&!info.shift&&key===lastClick.key&&now-lastClick.t<C.DOUBLE_CLICK_MS){
      lastClick={key:'',t:0};
      if(cursor()){doClick(info.g,0,'pickup_all');syncInv();return;}
    }
    lastClick=info.button===0?{key,t:now}:{key:'',t:0};
    if(info.shift&&info.button===0){doClick(info.g,0,'quick');syncInv();return;}
    doClick(info.g,info.button,'pickup');
    syncInv();
  }
  addEventListener('pointerup',endPointer);
  addEventListener('pointercancel',()=>{press=null;dragSession=null;dragPreview=null;syncInv();});
  addEventListener('blur',()=>{press=null;dragSession=null;dragPreview=null;});

  /* 拖拽预览：把「松开后会变成多少」直接画在格子上（原版也有这个反馈） */
  function applyDragPreview(){
    if(!dragPreview||!screen)return;
    for(const [g,n] of dragPreview){
      const el=$(`.slot[data-g="${g}"]`);
      if(!el)continue;
      const cur=el.querySelector('.count');
      if(n>1){if(cur)cur.textContent=n;else{const c=document.createElement('span');c.className='count';c.textContent=n;el.append(c);}}
    }
  }

  /* Q / Ctrl+Q：丢掉悬停格里的东西。F：与副手互换。数字键：与快捷栏互换。 */
  function inventoryHotkey(code,ctrl){
    if(!$('#inventory-dialog').open||!screen)return false;
    if(code==='KeyQ'){
      const g=hoverG??press?.g;
      if(g===null||g===undefined)return false;
      doClick(g,0,'throw',{all:!!ctrl});
      syncInv();return true;
    }
    if(code==='KeyF'){
      const g=hoverG??press?.g;
      if(g===null||g===undefined)return false;
      doClick(g,0,'swap',{target:LAYOUT.OFFHAND});
      syncInv();return true;
    }
    const m=/^Digit([1-9])$/.exec(code);
    if(m){
      const target=LAYOUT.HOTBAR+Number(m[1])-1;
      /* 创造物品栏：鼠标停在某个物品上按 1~9 → 整堆放进对应快捷栏格（原版） */
      if(creativeHover&&ITEMS[creativeHover]&&$('#inventory-dialog').classList.contains('creative')){
        const item=ITEMS[creativeHover];
        const s={id:creativeHover,n:item.stack,...(item.durability?{dur:item.durability}:{})};
        setCursor(null);
        screen.c.slots[target].set(s);
        syncInv();return true;
      }
      const g=hoverG??press?.g;
      if(g===null||g===undefined)return false;
      if(g===target)return true;                       // 悬停的就是那个快捷栏格：无操作
      doClick(g,0,'swap',{target});
      syncInv();return true;
    }
    return false;
  }

  function showItemName(){
    const node=$('#item-name');
    node.textContent=ITEMS[world.held()?.id]?.name||'';
    node.classList.add('show');
    clearTimeout(itemNameTimer);
    itemNameTimer=setTimeout(()=>node.classList.remove('show'),C.ITEM_NAME_MS);
  }

  // ── HUD ───────────────────────────────────────────────────────
  function hud(force=false){
    const p=world.player;
    const signature=JSON.stringify([world.inventory,world.selected,Math.ceil(p.health),Math.ceil(p.food),
      p.armorPoints,Math.ceil(p.absorption),p.level,Math.round(p.xp)]);
    if(force||signature!==invSignature){
      invSignature=signature;
      const bar=$('#hotbar');
      bar.replaceChildren(...world.inventory.slice(0,9).map((s,i)=>slotNode(s,i,true)));
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
      /* 护甲条：每个图标 2 点护甲（原版就是 20 点 = 10 个图标），
         奇数时最后一个画成半透明。 */
      const armorIcons=Math.ceil(p.armorPoints/2);
      $('#armor').replaceChildren(...Array.from({length:armorIcons},(_,i)=>{
        const el=document.createElement('i');
        if(p.armorPoints%2&&i===armorIcons-1)el.className='half';
        return el;
      }));
      /* 吸收生命：金心（复用 heart_full 贴图，靠 CSS 滤镜染成金色） */
      const absorbHearts=Math.ceil(p.absorption/2);
      $('#absorption').replaceChildren(...Array.from({length:absorbHearts},()=>{
        const el=document.createElement('i');
        el.style.backgroundImage=`url(${new URL('heart_full.png',textureBase).href})`;
        return el;
      }));
      /* 经验条 */
      const xpBar=$('#xp-bar');
      xpBar.classList.toggle('lv',p.level>0);
      xpBar.firstElementChild.style.width=`${Math.max(0,Math.min(100,p.xp/K.xpToNext(p.level)*100)).toFixed(1)}%`;
    }
    combatHud();
    if(debugOn){
      const b=aim&&BLOCKS[world.get(Math.floor(aim.x),Math.floor(aim.y))];
      /* 世界生成信息（规格书 §9「调试信息」）：
       * 种子 / 世界类型 / 区块号 / 群系 / 温度 / 湿度 / 地表高度 /
       * 已加载区块数 / 待合并队列 / 单帧生成耗时。 */
      const cx=Math.floor(p.x/16);
      const bi=world.biomeAt(Math.floor(p.x))||{};
      const clim=world.wg.terrain.biome.smoothedClimate(Math.floor(p.x));
      const gy=world.groundAt(Math.floor(p.x));
      const wgt=world.worldType||{};
      const nearEdge=Math.abs(p.x)>SAFE_X*0.98;
      const mobDbg=world.mobs.filter(m=>!m.dying).sort((a,b)=>Math.abs(a.x-p.x)-Math.abs(b.x-p.x))[0];
      $('#debug').textContent=
        `方块世界 2D  ${fpsValue} FPS · 20 TPS\n`+
        `渲染 ${canvas.width}×${canvas.height}（dpr ${renderDpr}）\n`+
        `X ${p.x.toFixed(2)}  Y ${(H-p.y).toFixed(2)}\n`+
        `时间 ${world.night()?'夜晚':'白昼'}  第 ${Math.floor(world.time/DAY)+1} 天\n`+
        `模式 ${world.mode==='creative'?'创造':'生存'}  flying: ${p.flying}\n`+
        `目标 ${b&&b.id!=='air'?b.name:'—'}\n`+
        `生命 ${p.health.toFixed(1)}/${p.maxHealth}  护甲 ${p.armorPoints}  韧性 ${p.armorToughness}\n`+
        `饥饿 ${p.food}  饱和 ${p.saturation.toFixed(1)}  消耗度 ${p.exhaustion.toFixed(2)}\n`+
        `经验 ${p.level} 级 (${Math.floor(p.xp)}/${K.xpToNext(p.level)})  吸收 ${p.absorption}\n`+
        `攻击强度 ${(p.strength*100).toFixed(0)}%  冷却 ${p.ticksSinceLastAttack}t  无敌帧 ${p.invulnerableTicks}\n`+
        `难度 ${world.difficulty}  战斗版本 ${C.COMBAT_VERSION}\n`+
        `生物 ${world.mobs.length}  掉落物 ${world.drops.length}\n`+
        `最近生物 ${mobDbg?`${MOBS[mobDbg.type]?.name||mobDbg.type} HP ${mobDbg.health.toFixed(1)}/${mobDbg.maxHealth} goal ${(mobDbg.activeGoals||[]).join('+')||'—'} target ${mobDbg.targetId||'—'}`:'—'}\n`+
        `── 世界生成 ──\n`+
        `种子 ${world.seed}  类型 ${wgt.label||wgt.id||'默认'}\n`+
        `区块 ${cx}（${cx*16}~${cx*16+15}）  群系 ${bi.name||bi.id||'—'}\n`+
        `温度 ${(clim.temperature??0).toFixed(2)}  湿度 ${(clim.humidity??0).toFixed(2)}  地表高度 ${gy}\n`+
        `已加载区块 ${world.wg.chunks.size}  待合并 ${world.wg.pendingIn.size}\n`+
        `单帧生成 ${(world.genMs||0).toFixed(2)}ms / ${world.genCount||0} 块`+
        (nearEdge?`\n⚠ 已接近 X 轴极限 ±${SAFE_X}`:'');
    }
    /* ★ 面板内容变了就补画（指纹在 inventory() 末尾写，所以不会重复渲染）：
       - 拖动中（press）不重画，否则按下时的那个 DOM 会被换掉，拖拽高亮会闪；
       - 只补画「背包」这一个 dialog，熔炉/暂停那些各有各的刷新路径。 */
    if(!press&&$('#inventory-dialog').open&&panelSig!==panelSignature())inventory();
  }

  /* 攻击冷却遮罩 + 战斗状态提示：每帧更新（不参与 hud() 的 DOM 重建指纹，
     否则每 tick 都会重画整条快捷栏）。 */
  function combatHud(){
    const p=world.player;
    const cd=$('#hotbar-cooldown');
    const ws=K.weaponStats(ITEMS[world.held()?.id]),cdTicks=K.cooldownTicks(ws.attackSpeed);
    const left=Math.max(0,cdTicks-p.ticksSinceLastAttack);
    if(left>0&&cdTicks>0){
      cd.hidden=false;
      cd.style.left=`${40*world.selected}px`;
      cd.style.top=`${(1-left/cdTicks)*40}px`;
      cd.style.height=`${(left/cdTicks*40).toFixed(1)}px`;
    }else cd.hidden=true;
    const cs=$('#combat-status');
    const notes=[];
    if(p.shieldCooldown>0)notes.push(`盾牌冷却 ${(p.shieldCooldown/20).toFixed(1)}s`);
    else if(p.shieldRaised)notes.push('举盾中');
    if(p.strength>=1)notes.push('攻击已就绪');
    const text=notes.join(' · ');
    if(cs.textContent!==text)cs.textContent=text;
    cs.hidden=!notes.length;
    /* 生命条受伤闪白 / 低血量抖动 / 饥饿低时抖动（提示词第 12 节）。 */
    const hp=$('#health'),hg=$('#hunger');
    if(hp){
      hp.classList.toggle('hurt',p.hurtTime>0);
      hp.classList.toggle('low',p.health<6);
    }
    if(hg)hg.classList.toggle('low',p.food<=6);
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
  /* 面板内容指纹：捡东西、/give、吃东西、熔炉取产物…… 这些都只改 world，
     不会重画面板，导致面板里的快捷栏和屏幕底部那条对不上。 */
  const panelSignature=()=>JSON.stringify([world.inventory,world.offhand,craftMode,world.craftGrid,world.tableGrid,cursor(),world.player.armor]);

  function inventory(mode){
    // 切换 2×2 / 3×3 时手上的东西要收回去，否则会指向另一个容器的越界下标
    if(mode&&mode!==craftMode){returnHeld();craftMode=mode;screen=null;}
    /* ★ screen 不能每次渲染都重建：DragSession 在拖拽开始时记下当时的容器，
       若渲染中途换成新容器，end() 会把最终光标写进旧容器 —— 真正显示的光标
       停留在拖拽中途的旧值，格子却被填满了（物品凭空复制。复现：拿 64 个 →
       右键放 1 个 → 左键点击时手稍微一带拖过旁边一格 → 格子变满、手上的
       数量没扣够）。所以只在「打开面板 / 换合成模式 / 绑定对象被替换」时重建。 */
    const b=screen?.bound;
    if(b&&(b[0]!==world.inventory||b[1]!==world.player.armor||
           b[2]!==world.craftGrid||b[3]!==world.tableGrid))screen=null;
    if(!screen)reScreen();
    const isTable=craftMode==='table';
    const panel=$('.inv-panel');
    if(panel)panel.classList.toggle('is-table',isTable);
    const player=$('#inv-player');
    if(player)player.hidden=isTable;

    $('#slots').replaceChildren(...Array.from({length:27},(_,i)=>slotNode(world.inventory[9+i],LAYOUT.MAIN+i,false)));
    $('#inv-hotbar').replaceChildren(...Array.from({length:9},(_,i)=>slotNode(world.inventory[i],LAYOUT.HOTBAR+i,false)));
    const armorBox=$('#armor-slots');
    if(armorBox)armorBox.replaceChildren(...ARMOR_PARTS.map((part,i)=>{
      const s=world.player.armor[part];
      const b=slotNode(s,LAYOUT.ARMOR+i,false);
      if(!s)b.dataset.tip=`${({helmet:'头盔',chestplate:'胸甲',leggings:'护腿',boots:'靴子'})[part]}（Shift 点背包里的可自动穿上）`;
      return b;
    }));
    /* 副手栏（原版在玩家预览右下角）。工作台界面没有副手格 → 隐藏。
       格子仍然在容器里（LAYOUT.OFFHAND），所以 2×2 界面的 F 键互换在两种模式都有效。 */
    const offBox=$('#offhand-slot');
    if(offBox){
      offBox.hidden=isTable;
      if(isTable)offBox.replaceChildren();
      else{
        const b=slotNode(world.offhand,LAYOUT.OFFHAND,false);
        if(!world.offhand)b.dataset.tip='副手栏\n鼠标停在背包格按 F：与副手互换；也可以直接把物品拖进来';
        offBox.replaceChildren(b);
      }
    }
    const grid=gridRef();
    const gridStart=isTable?LAYOUT.TABLE_GRID:LAYOUT.GRID;
    const gridSize=isTable?9:4;
    $('#craft-grid').replaceChildren(...Array.from({length:gridSize},(_,i)=>slotNode(grid[i],gridStart+i,false)));
    /* 合成输出格：只读预览。点击取一次产物，Shift+点击一键合成。 */
    const result=isTable?world.findTableRecipe():world.findGridRecipe();
    const out=$('#craft-result');
    out.replaceChildren();
    if(result){
      const b=slotNode({id:result.out,n:result.n},screen.outIndex,false);
      b.dataset.tip=`取得 ${ITEMS[result.out].name}${result.n>1?` × ${result.n}`:''}\nShift+点击：一键合成`;
      out.append(b);
    }
    const creative=world.mode==='creative';
    document.querySelector('.recipe-panel').hidden=true;
    $('#inventory-dialog').classList.toggle('creative',creative&&!isTable);
    $('#inventory-dialog').classList.toggle('personal',creativeTab==='inventory');
    $('#creative-browser').hidden=!creative||isTable;
    const cur=cursor();
    $('#slot-description').textContent=cur?`${ITEMS[cur.id].name} × ${cur.n}`:'';
    renderHeld();if(creative&&!isTable)renderCreative();
    applyDragPreview();
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
    const entries=Object.entries(ITEMS).filter(([id,item])=>!['water_still','bedrock','lava'].includes(id)&&(creativeTab==='search'?(id.includes(query)||item.name.toLowerCase().includes(query)):(item.category||'ingredients')===creativeTab));
    const max=Math.max(0,Math.ceil(entries.length/9)-5);creativeRow=clamp(creativeRow,0,max);
    const grid=$('#creative-grid');grid.replaceChildren();
    for(let i=0;i<45;i++){
      const b=document.createElement('button');b.type='button';b.className='slot';const entry=entries[creativeRow*9+i];
      if(entry){const[id,item]=entry;b.append(iconImg(id));
        // 多行：主行是名字，副行用 \n 分隔（原版收藏物品也是这么显示的）
        b.dataset.tip=item.name+(item.catalogOnly?'\n收藏物品 · 特殊机制尚未实现':'');
        b.setAttribute('aria-label',item.name);
        b.dataset.creative=id;
        b.addEventListener('pointerdown',ev=>{ev.preventDefault();creativePick(id,ev.button,ev.shiftKey);});
        /* 数字键要能把「鼠标下面这个物品」整堆放进快捷栏，所以记下悬停的 id */
        b.addEventListener('pointerenter',()=>{creativeHover=id;});
        b.addEventListener('pointerleave',()=>{if(creativeHover===id)creativeHover=null;});}
      else b.disabled=true;grid.append(b);
    }
    $('#creative-hotbar').replaceChildren(...world.inventory.slice(0,9).map((s,i)=>slotNode(s,LAYOUT.HOTBAR+i,false)));
    const scroll=$('#creative-scroll');scroll.max=max;scroll.value=creativeRow;scroll.disabled=max===0;
  }
  /* 创造物品栏的取物规则（原版）：左键整堆、右键 1 个、Shift 直接进背包、
     中键复制整堆、点空白处销毁手上的物品。 */
  let creativeHover=null;
  function creativePick(id,button,shift){
    if(!screen||!ITEMS[id])return;
    const item=ITEMS[id];
    const full={id,n:item.stack,...(item.durability?{dur:item.durability}:{})};
    if(shift){
      const rest=world.add(id,item.stack);
      if(rest>0)notify('背包满了');
      syncInv();return;
    }
    if(button===2){
      const cur=cursor();
      if(cur&&cur.id===id&&cur.n<stackLimit(id))setCursor({...cur,n:cur.n+1});
      else setCursor({...full,n:1});
      renderHeld();return;
    }
    setCursor({...full});               // 左键 / 中键：整堆拿在手上
    renderHeld();
  }
  $('#creative-search').oninput=()=>{creativeRow=0;renderCreative();};
  $('#creative-scroll').oninput=e=>{creativeRow=Number(e.target.value);renderCreative();};
  $('#creative-grid').onwheel=e=>{e.preventDefault();creativeRow+=Math.sign(e.deltaY);renderCreative();};
  /* 垃圾桶：光标上有物品时点一下销毁（原版行为）。列表空白处同理。 */
  const destroyCursor=()=>{if(!cursor())return false;setCursor(null);syncInv();return true;};
  $('#creative-trash').onclick=()=>destroyCursor();
  $('#creative-panel').addEventListener('pointerdown',e=>{
    if(e.target.closest?.('.slot,button,input,label'))return;   // 点到格子/控件就交给它们
    destroyCursor();
  });
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

  // ── 村民交易：数据在 mobComponents，界面只做「付出 → 获得」。 ──
  function openTrade(mobId){
    const mob=world.mobs.find(m=>m.id===mobId&&!m.dying);
    if(!mob){notify('交易对象已经离开');return;}
    const offers=tradeOffers(mob);
    $('#trade-title').textContent=`与${MOBS[mob.type]?.name||mob.type}交易`;
    const root=$('#trade-offers');root.replaceChildren();
    for(const offer of offers){
      const row=document.createElement('div');row.className='trade-offer';
      const give=document.createElement('span');give.className='item';give.append(iconImg(offer.give[0]),document.createTextNode(` × ${offer.give[1]}`));
      const arrow=document.createElement('b');arrow.className='arrow';arrow.textContent='→';
      const get=document.createElement('span');get.className='item';get.append(iconImg(offer.get[0]),document.createTextNode(` × ${offer.get[1]}`));
      const button=document.createElement('button');button.className='mc-btn';button.textContent='交易';
      button.disabled=offer.uses>=offer.maxUses||world.count(offer.give[0])<offer.give[1];
      button.onclick=()=>{
        const result=performTrade(mob,offer.id,id=>world.count(id),(id,n)=>world.remove(id,n));
        if(!result.ok){notify(result.reason==='missingInput'?'背包里没有支付物品':'这笔交易不可用');return;}
        const rest=world.add(result.get[0],result.get[1]);if(rest)world.drop(result.get[0],rest,p.x,p.y);
        K.applyXp(p,result.xp);world.sound('pickup',p.x,.4);notify('交易成功');
        openTrade(mobId);hud(true);
      };
      row.append(give,arrow,get,button);root.append(row);
    }
    openDialog($('#trade-dialog'));
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

  function clearInput(){keys.clear();heldTouches.clear();mouseDown=false;rightHeld=false;touchMine=false;world.stopMining();}
  function openDialog(dialog){clearInput();closeChat();if(!dialog.open)dialog.showModal();}
  function begin(next){
    dialogs.forEach(d=>d.close());
    bindWorld(next);playing=true;
    $('#start-screen').hidden=true;$('#hud').hidden=false;
    $('#chat').hidden=false;
    $('#touch-controls').hidden=!coarse;
    canvas.focus();hud(true);showItemName();save();
    pushChat(`世界已生成：${world.seed} · 输入 /help 查看指令`,'system');
    /* 旧存档迁移提示（规格书 §1.1 / §10）：不能让玩家「莫名其妙地丢了地形」，
       也不能一声不响地换掉世界外观 —— 明确告诉他发生了什么。 */
    if(next.migrated){
      const imp=next.legacyImport||{};
      pushChat(`存档已从旧版本迁移：原地图 ${imp.width||'?'}×${imp.height||'?'} 格已整块保留，`+
               `该区域之外按新地形算法生成。`,'system');
      notify('存档已从旧版本迁移');
    }else if(next.wg?.worldgenVersion!=null&&next.wg.worldgenVersion!==WORLDGEN_VERSION){
      pushChat(`该存档使用地形生成版本 v${next.wg.worldgenVersion}，当前版本 v${WORLDGEN_VERSION}；`+
               `已生成区域保持原样。`,'system');
    }
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
    /* 世界类型 + 洞穴/结构开关（规格书 §10） */
    const worldType=(document.querySelector('[name=worldType]:checked')||{}).value||'default';
    const caves=!!document.querySelector('#opt-caves')?.checked;
    const structures=!!document.querySelector('#opt-structures')?.checked;
    begin(new World(seed,document.querySelector('[name=mode]:checked').value,{worldType,caves,structures}));
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
    press=null;dragSession=null;dragPreview=null;hoverG=null;screen=null;
    canvas.focus();
  }));
  // 原版背包没有「完成」按钮，按 E 或点界面外关闭。生存模式下配方书面板（含那个
  // 完成按钮）是隐藏的，所以必须补上「点界面外关闭」，否则手机端进去就出不来。
  $('#inventory-dialog').addEventListener('click',(e)=>{
    if(e.target!==e.currentTarget)return;
    if(skipDialogClose){skipDialogClose=false;return;}   // 刚才那一下是「丢弃」，不是关界面
    e.currentTarget.close();
  });
  $('#help-button').onclick=()=>openDialog($('#help-dialog'));
  /* 关背包：清掉创造栏的悬停记忆，否则下次打开时数字键还会往快捷栏塞物品 */
  $('#inventory-dialog').addEventListener('close',()=>{creativeHover=null;});
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
  /* ── 自动跳跃（上台阶辅助）：默认关闭。暂停菜单按钮 + /autostep 指令，
     偏好记在 localStorage，换世界/重开也保留。 ── */
  let autoStep=false;
  const autostepButton=$('#autostep-button');
  function setAutoStep(v,quiet=false){
    autoStep=!!v;
    try{localStorage.setItem('zfsn.mc.autostep',autoStep?'on':'off');}catch{}
    if(world)world.autoStep=autoStep;
    autostepButton.textContent='自动跳跃：'+(autoStep?'开':'关');
    if(!quiet)notify(autoStep?'自动跳跃：开（走近 1 格台阶会自动踩上去）':'自动跳跃：关');
  }
  setAutoStep(localStorage.getItem('zfsn.mc.autostep')==='on',true);
  autostepButton.onclick=()=>setAutoStep(!autoStep);
  $('#collect-smelt').onclick=()=>{world.collectSmelt();furnaceUI();hud(true);};

  /* 右键的完整语义：先试交互方块 → 再试放置 → 最后才是「使用物品」。
     以前只有前两步，所以创造栏里绝大多数东西（药水、雪球、唱片、盔甲…）
     右键全是静默无反应，玩家看不出是「不能用」还是「没实现」。 */
  function rightClick(){
    if(paused())return;
    /* 手持盾牌（或副手有盾、且主手物品没有可使用动作）时右键 = 举盾，
       不再放置方块 / 不触发「使用」。举盾是「按住」语义。 */
    if(world.shieldHand())return;
    if(aim){
      const bx=Math.floor(aim.x),by=Math.floor(aim.y),id=world.get(bx,by);
      if(id===14){openFurnace();return;}
      if(id===13){inventory('table');openDialog($('#inventory-dialog'));return;}
      if(world.place(aim.x,aim.y)){hud(true);return;}
    }
    use();
  }
  function use(){
    if(paused())return;
    if(world.activeTradeMob){openTrade(world.activeTradeMob);world.activeTradeMob=null;return;}
    const msg=world.useItem(aim);
    if(!msg){hud(true);return;}                    // 物品已经生效
    /* 物品没用上时，附近有台子就打开台子。
       以前是「先看台子」，于是拿着镐按 F 会直接开熔炉；
       现在反过来，但保留这个兜底 —— 否则站在熔炉前拿着石头按 F 只会得到
       「这是合成材料」的提示，反而进不去熔炉。 */
    if(world.nearBlock(14)){openFurnace();return;}
    if(world.nearBlock(13)){inventory('table');openDialog($('#inventory-dialog'));return;}
    hud(true);notify(msg);
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
        ok('/summon <生物id>  召唤任意已注册生物；/difficulty <peaceful|easy|normal|hard>');
        ok('/nametag <名字>  设置命名牌目标名；/autostep 开关自动跳跃');
        break;
      case 'gamemode':case 'gm':{
        const v=arg(0);
        const mode=['1','c','creative','创造'].includes(v)?'creative':['0','s','survival','生存'].includes(v)?'survival':null;
        if(!mode){err('用法：/gamemode <survival|creative>');break;}
        world.setMode(mode);          // 切到生存会强制关掉飞行（原版行为）
        if(mode==='survival'){p.health=Math.max(1,p.health);p.food=20;p.flying=false;}
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
          if(py===null)py=world.surfaceAt(Math.floor(px))-2;
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
      case 'summon':case 'spawnmob':{
        const id=arg(0);
        if(!MOBS[id]){err(`未知生物。可用：${Object.keys(MOBS).slice(0,12).join(' / ')} …（完整列表见 /summon 文档）`);break;}
        const mob=world.summonMob(id,p.x+p.face*4);
        if(mob){ok(`召唤了 ${MOBS[id].name}`);world.sound('click',p.x,.5);}
        else err('这里空间不足，换个位置召唤');
        break;
      }
      case 'difficulty':{
        const v=arg(0),d=['peaceful','easy','normal','hard'].includes(v)?v:null;
        if(!d){err('用法：/difficulty <peaceful|easy|normal|hard>');break;}
        world.difficulty=d;ok(`难度已切换为 ${d}`);
        break;
      }
      case 'nametag':{
        const value=parts.join(' ').trim();
        if(!value){err('用法：/nametag <名字>');break;}
        p.customMobName=value.slice(0,16);ok(`下次用命名牌会命名为「${p.customMobName}」`);break;
      }
      case 'autostep':case 'autojump':setAutoStep(!autoStep,true);ok(`自动跳跃 ${autoStep?'开':'关'}（也可在暂停菜单里切换）`);break;
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
    // 视觉范围缩放：按住 +/−（含小键盘 +/−）连续平滑变焦，松开即停
    if(e.code==='Equal'||e.code==='NumpadAdd'){zoomKey=1;e.preventDefault();return;}
    if(e.code==='Minus'||e.code==='NumpadSubtract'){zoomKey=-1;e.preventDefault();return;}
    if(e.code==='KeyE'&&!e.repeat){
      e.preventDefault();
      if($('#inventory-dialog').open)$('#inventory-dialog').close();
      else if(!paused()){inventory('inv');openDialog($('#inventory-dialog'));}
      return;
    }
    if(paused()){
      /* 背包开着时的快捷键：Q 丢弃、Ctrl+Q 丢整堆、F 换副手、1~9 与快捷栏互换。
         （原版这些键在容器界面里也是生效的，所以要在 paused 拦截之前处理。） */
      if($('#inventory-dialog').open&&!e.repeat&&inventoryHotkey(e.code,e.ctrlKey)){e.preventDefault();}
      return;
    }
    // 聊天：T 打开发言，/ 打开并预填斜杠
    if(e.code==='KeyT'&&!e.repeat){e.preventDefault();openChat('');return;}
    if((e.key==='/'||e.code==='Slash')&&!e.repeat){e.preventDefault();openChat('/');return;}
    if(['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.code))e.preventDefault();
    keys.add(e.code);
    /* 双击空格切换飞行（只在创造模式有效）。第一次按空格仍是普通跳跃，
       7 tick（350ms）内再按一次才翻转。这里用 tickCount 而不是 setTimeout，
       暂停时 tick 不走，判定窗口也不会被暂停菜单拖延。 */
    if(e.code==='Space'&&!e.repeat){
      const wasFlying=world.player.flying;
      if(world.toggleFly()){
        notify(world.player.flying?'飞行模式：开（空格 / W 上升，Shift / S 下降）':'飞行模式：关');
        if(world.player.flying&&wasFlying===false&&world.player.crouch)world.setCrouch(false);
      }
    }
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
      if(['Equal','NumpadAdd','Minus','NumpadSubtract'].includes(e.code))zoomKey=0;
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
    if(e.button===2){rightHeld=true;rightClick();return;}
    mouseDown=true;canvas.setPointerCapture(e.pointerId);
    /* 「每次点击才攻击」：记录一次攻击意图（下一 tick 消费掉）。 */
    attackClick=true;
  });
  /* 松开左键：立刻清空挖掘状态（进度归零、breakingPos 清空）。
     blockHitDelay 不清 —— 它要继续按 tick 自然递减。 */
  canvas.addEventListener('pointerup',()=>{mouseDown=false;rightHeld=false;world.stopMining();});
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
    b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);heldTouches.set(e.pointerId,b.dataset.hold);if(b.dataset.hold==='mine')attackClick=true;};
    const release=e=>heldTouches.delete(e.pointerId);
    b.onpointerup=release;b.onpointercancel=release;b.onlostpointercapture=release;
  });
  $('#touch-place').onclick=()=>{if(aim&&!paused()){world.place(aim.x,aim.y);hud(true);}};
  $('#touch-use').onclick=use;
  $('#touch-inventory').onclick=()=>{if(playing){inventory('inv');openDialog($('#inventory-dialog'));}};

  // ── 主循环 ────────────────────────────────────────────────────
  function frame(now){
    const dt=Math.min((now-last)/1000,.1);last=now;titleClock+=dt;
    fpsCount++;fpsElapsed+=dt;
    if(fpsElapsed>=.5){fpsValue=Math.round(fpsCount/fpsElapsed);fpsCount=0;fpsElapsed=0;}
    if(!paused()){
      accumulator+=dt;
      /* 分块流式加载：每帧最多生成 MAX_CHUNKS_PER_TICK 个区块（或用满
         WORLDGEN_BUDGET_MS 毫秒），超出 UNLOAD_DISTANCE 的区块卸载。
         放在帧循环而不是 tick 里 —— 区块生成是「画面需要」，不是「逻辑需要」。 */
      if(playing)world.streamChunks();
      // 视觉范围：按住 +/− 等比平滑推拉 zoom（每秒约 e^ZOOM_RATE 倍，松手即停）
      if(zoomKey){zoom=clamp(zoom*Math.exp(zoomKey*ZOOM_RATE*dt),ZOOM_MIN,ZOOM_MAX);showZoomHud();}
      const touch=new Set(heldTouches.values());
      const p=world.player;
      const input={
        left:keys.has('KeyA')||keys.has('ArrowLeft')||touch.has('left'),
        right:keys.has('KeyD')||keys.has('ArrowRight')||touch.has('right'),
        jump:keys.has('Space')||keys.has('KeyW')||keys.has('ArrowUp')||touch.has('jump'),
        /* 原版 Shift 是蹲下（不是疾跑）。飞行时 Shift 改作「下降」，所以这时
           不能同时蹲下，否则玩家一边下降一边把碰撞盒缩成 1.5 格。 */
        crouch:!p.flying&&(keys.has('ShiftLeft')||keys.has('ShiftRight')||touch.has('crouch')),
        /* 飞行下降：与 crouch 解耦，否则飞行时 Shift 会被 crouch 的 !flying 吃掉 */
        /* 创造飞行：S 也能下降（与 W=上升 对称）。S 不参与蹲下，避免地面误触。 */
        descend:keys.has('ShiftLeft')||keys.has('ShiftRight')||keys.has('KeyS')||touch.has('crouch'),
        sprint:sprintHeld,
        /* 举盾：按住右键且主手或副手拿着盾牌。 */
        shield:rightHeld&&!!world.shieldHand(),
        aim,          // 挖掘状态机在 tick 里取「当前指向的方块」
        mine:false,
      };
      world.setCrouch(!!input.crouch);
      /* 逻辑固定 20 TPS：剩下的零头留给渲染插值（world.alpha）。
         以前这里是 1/60，挖掘进度、冷却、物理全都跟着帧率漂。 */
      let steps=0;
      while(accumulator>=TICK&&steps++<6){
        accumulator-=TICK;
        /* 手持弓按住左键 = 拉弓（原版语义），松开发射 —— 与挖掘/攻击互斥。
           拉弓途中把弓切走（滚轮）就取消，不射箭不耗箭。 */
        const mineHeld=!!(aim&&(mouseDown||touch.has('mine')));
        const bowHeld=/^(bow|crossbow)$/.test(world.held()?.id||'');
        /* 攻击：HOLD_TO_ATTACK=false →「每次点击才攻击」（提示词第 3 节）；
           true → 按住左键，冷却好了自动再打（原版 1.9+ 的 hold-to-attack）。
           ★ 攻击与挖矿互斥：这一 tick 打了生物就不再挖方块。 */
        const wantAttack=C.HOLD_TO_ATTACK?mineHeld:attackClick;
        let attacking=false;
        if(world.drawBow&&!bowHeld)world.drawBow=null;
        if(world.drawBow){
          if(mineHeld)world.drawBow.ticks++;
          else{const power=Math.min(1,world.drawBow.ticks/C.BOW_CHARGE_TICKS);if(power>=C.BOW_MIN_CHARGE)world.shootBow(power,aim);world.drawBow=null;}
        }else if(mineHeld&&bowHeld&&world.hasArrow()){
          world.drawBow={ticks:0};
        }else if(wantAttack&&aim){
          attacking=world.attack(aim.x,aim.y);
          attackClick=false;                       // 一次点击只算一次攻击
        }
        input.mine=mineHeld&&!bowHeld&&!attacking;
        world.update(TICK,input);
      }
      saveClock+=dt;if(saveClock>20){saveClock=0;save();}
      if(world.player.health<=0&&!deadShown){
        deadShown=true;
        $('#death-text').textContent=`${world.deathReason||'冒险途中'} · 掉落位置 X ${Math.floor(world.player.x)} / Y ${H-Math.floor(world.player.y)} · 等级 ${world.player.level}`;
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
    if(playing)combatHud();      // 攻击冷却遮罩 / 战斗状态：每帧刷新
    world.decayShake(dt);     // 受击镜头抖动：每帧衰减
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
    /* 图标渲染器（探针要采样三面亮度，验证「顶面绿、侧面暗」） */
    icons,
    get playing(){return playing;},get held(){return cursor();},get chatOpen(){return chatOpen;},runCommand,refreshInv(){inventory();hud(true);},
    /* 世界坐标 → 屏幕像素。探针要靠它把鼠标精确点到某个方块上，
       不然只能靠猜屏幕位置（相机跟随玩家，位置一直在变）。 */
    screenOf(wx,wy){return{x:Math.round(wx*tile-camX),y:Math.round(wy*tile-camY)};},
    get view(){return{camX,camY,tile};},
    get zoom(){return zoom;},setZoom(v){zoom=clamp(v,ZOOM_MIN,ZOOM_MAX);tile=baseTile*zoom;}};
  requestAnimationFrame(frame);
}
