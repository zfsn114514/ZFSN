/* 命名、拴绳、驯服、繁殖、成长、骑乘、背包、交易等通用组件。纯逻辑。 */
import { MOBS } from './mobRegistry.js';
import * as M from './mobConstants.js';

let nextId=1;
export function resetMobIds(value=1){nextId=Math.max(1,value|0);}
export function isBaby(mob){return (mob.ageTicks??0)<0;}
export function isTamed(mob){return !!mob.tamed;}
export function isPersistent(mob){
  const rec=MOBS[mob.type];
  return !!(mob.customName||mob.tamed||mob.leashedTo||mob.persistent||rec?.category==='passive'||rec?.category==='neutral'||rec?.category==='utility');
}

export function chooseVariant(rec,rng=Math.random,context={}){
  if(rec.id==='fox'&&context.cold)return 'snow';
  if(rec.id==='frog'&&context.cold)return 'cold';
  if(rec.id==='panda'&&context.weak)return 'weak';
  const list=rec.variants||[];
  if(!list.length)return null;
  const total=list.reduce((s,v)=>s+(v.weight??1),0);
  if(total<=0)return list[0].id;
  let roll=rng()*total;
  for(const v of list){roll-=v.weight??1;if(roll<0)return v.id;}
  return list[list.length-1].id;
}

export function createMobState(type,x,y,opts={}){
  const rec=MOBS[type];
  if(!rec)throw Error(`未注册的生物 ${type}`);
  const rng=opts.rng||Math.random;
  const size=opts.size??rec.size??1;
  const scale=rec.components?.split?2**size:1;
  const baby=!!opts.baby&&rec.babyVariant;
  const health=rec.components?.split?(size===2?16:size===1?4:1):rec.randomHealth?Math.round(rec.randomHealth[0]+rng()*(rec.randomHealth[1]-rec.randomHealth[0])):rec.maxHealth;
  const variant=opts.variant??chooseVariant(rec,rng,opts);
  const mob={
    id:opts.id??`mob.${nextId++}`,type,x,y,w:rec.hitbox.w*scale*(baby?M.BABY_SCALE:1),h:rec.hitbox.h*scale*(baby?M.BABY_SCALE:1),
    vx:0,vy:0,ground:false,health,maxHealth:health,clock:0,face:1,yaw:.95,hurt:0,panic:0,
    invulnerableTicks:0,lastDamage:0,knockbackResistance:rec.knockbackResistance,armor:rec.armor,
    armorToughness:rec.armorToughness,armorKBR:0,absorption:0,deathTime:0,hurtTime:0,attackTimer:0,
    shootTimer:Math.floor(rng()*20),fuse:-1,onFire:0,fireTimer:0,size,variant,marking:null,
    ageTicks:baby?-M.BABY_GROW_TICKS:0,loveTicks:0,breedCooldown:0,tamed:false,tameProgress:0,
    ownerId:null,sitting:false,customName:null,leashedTo:null,mountId:null,riderId:null,saddled:false,
    chest:rec.components?.chest?Array(15).fill(null):null,heldItem:null,mouthItem:null,
    sheared:false,woolColor:variant,eggTimer:M.CHICKEN_EGG_MIN_TICKS+Math.floor(rng()*(M.CHICKEN_EGG_MAX_TICKS-M.CHICKEN_EGG_MIN_TICKS)),
    home:opts.home?{...opts.home}:null,path:[],pathIndex:0,repathTicks:0,goalStates:{},activeGoals:[],targetId:null,
    targetMemory:0,aggro:false,persistent:opts.persistent??(rec.category==='passive'||rec.category==='neutral'||rec.category==='utility'),
    spawnedByEgg:!!opts.spawnedByEgg,spawnTick:opts.tick??0,dimension:opts.dimension||'overworld',
    airTicks:0,statusEffects:{},cooldowns:{},sleepTicks:0,stingTicks:0,playingDead:0,
    bossPhase:0,arena:rec.components?.ellipseArena?{cx:x,cy:y}:null,
  };
  if(rec.markings?.length)mob.marking=rec.markings[Math.floor(rng()*rec.markings.length)];
  if(rec.randomAttributes){mob.moveSpeed=rec.randomAttributes.speed[0]+rng()*(rec.randomAttributes.speed[1]-rec.randomAttributes.speed[0]);mob.jumpPower=rec.randomAttributes.jump[0]+rng()*(rec.randomAttributes.jump[1]-rec.randomAttributes.jump[0]);}
  return mob;
}

export function feedMob(mob,itemId,opts={}){
  const rec=MOBS[mob.type];
  if(!rec)return {ok:false,reason:'unknown'};
  if(isBaby(mob)&&rec.food?.includes(itemId)){
    const remaining=-mob.ageTicks;
    mob.ageTicks=Math.min(0,mob.ageTicks+Math.max(1,Math.floor(remaining*M.BABY_FEED_ACCEL)));
    return {ok:true,action:'grow'};
  }
  if(rec.components?.taming&&rec.tameFood?.includes(itemId)&&!mob.tamed)return tameMob(mob,itemId,opts);
  if(rec.breedable&&rec.food?.includes(itemId)){
    if(mob.breedCooldown>0)return {ok:false,reason:'cooldown'};
    mob.loveTicks=M.LOVE_TICKS;return {ok:true,action:'love'};
  }
  if(mob.health<mob.maxHealth&&rec.tameFood?.includes(itemId)){
    mob.health=Math.min(mob.maxHealth,mob.health+2);return {ok:true,action:'heal'};
  }
  return {ok:false,reason:'notFood'};
}

export function growTick(mob){
  if(mob.ageTicks<0){
    mob.ageTicks++;
    if(mob.ageTicks===0){
      const rec=MOBS[mob.type];
      mob.w/=M.BABY_SCALE;mob.h/=M.BABY_SCALE;
      return {grewUp:true,drops:rec.drops.some(d=>d.onGrowUp)};
    }
  }
  if(mob.loveTicks>0)mob.loveTicks--;
  if(mob.breedCooldown>0)mob.breedCooldown--;
  return {grewUp:false};
}

export function canBreed(a,b){
  return !!a&&!!b&&a!==b&&a.type===b.type&&MOBS[a.type]?.breedable&&!isBaby(a)&&!isBaby(b)&&a.loveTicks>0&&b.loveTicks>0&&a.breedCooldown<=0&&b.breedCooldown<=0;
}
export function breedPair(a,b,opts={}){
  if(!canBreed(a,b))return null;
  const rng=opts.rng||Math.random;
  const x=opts.x??((a.x+b.x)/2),y=opts.y??((a.y+b.y)/2);
  const baby=createMobState(a.type,x,y,{baby:true,rng,persistent:true});
  if(a.variant&&b.variant){
    if(a.type==='sheep'&&a.variant===b.variant)baby.variant=a.variant;
    else baby.variant=rng()<.5?a.variant:b.variant;
    baby.woolColor=baby.variant;
  }
  if(a.tamed&&b.tamed){baby.tamed=true;baby.ownerId=a.ownerId;}
  a.loveTicks=b.loveTicks=0;a.breedCooldown=b.breedCooldown=M.BREED_COOLDOWN_TICKS;
  baby.parentIds=[a.id,b.id];
  return {baby,xp:M.BREED_XP_MIN+Math.floor(rng()*(M.BREED_XP_MAX-M.BREED_XP_MIN+1))};
}

export function tameMob(mob,itemId,opts={}){
  const rec=MOBS[mob.type],rng=opts.rng||Math.random;
  if(!rec?.tameable||mob.tamed||!rec.tameFood?.includes(itemId))return {ok:false,reason:'cannotTame'};
  if(rec.components?.horseArmor||['horse','donkey','mule','llama','trader_llama'].includes(mob.type)){
    mob.tameProgress=Math.min(M.HORSE_TEMPER_MAX,mob.tameProgress+M.HORSE_TEMPER_PER_RIDE);
    if(mob.tameProgress<M.HORSE_TEMPER_MAX&&rng()>mob.tameProgress/M.HORSE_TEMPER_MAX)return {ok:false,action:'buck',progress:mob.tameProgress};
  }else{
    const chance=mob.type==='wolf'?M.WOLF_TAME_CHANCE:mob.type==='cat'?M.CAT_TAME_CHANCE:M.PARROT_TAME_CHANCE;
    if(rng()>=chance)return {ok:false,action:'notYet'};
  }
  mob.tamed=true;mob.ownerId=opts.ownerId??'player';mob.persistent=true;mob.sitting=false;
  if(rec.tamedHealth){const ratio=mob.health/mob.maxHealth;mob.maxHealth=rec.tamedHealth;mob.health=Math.max(1,Math.round(rec.tamedHealth*ratio));}
  return {ok:true,action:'tamed',ownerId:mob.ownerId};
}

export function setSitting(mob,value){if(!mob.tamed)return false;mob.sitting=!!value;if(mob.sitting)mob.path=[];return true;}
export function nameMob(mob,name){mob.customName=String(name||'').slice(0,64)||null;mob.persistent=isPersistent(mob);return mob.customName;}
export function attachLeash(mob,targetId){if(targetId!=null&&!MOBS[mob.type]?.components?.leash)return false;mob.leashedTo=targetId;mob.persistent=isPersistent(mob);return true;}
export function tickLeash(mob,anchor){
  if(mob.leashedTo==null)return {ok:true};
  if(!anchor){mob.leashedTo=null;return {ok:false,dropLead:true};}
  const dist=Math.hypot(anchor.x-mob.x,anchor.y-mob.y);
  if(dist>M.LEASH_MAX_DISTANCE){mob.leashedTo=null;return {ok:false,dropLead:true};}
  return {ok:true,distance:dist};
}

export function mount(mob,riderId='player'){
  if(!MOBS[mob.type]?.rideable||mob.riderId||mob.mountId||isBaby(mob))return false;
  if(MOBS[mob.type].components?.saddle&&!mob.saddled&&mob.type!=='skeleton_horse'&&mob.type!=='zombie_horse')return false;
  if(MOBS[mob.type].tameable&&!mob.tamed&&mob.type!=='skeleton_horse'&&mob.type!=='zombie_horse')return false;
  mob.riderId=riderId;mob.sitting=false;mob.path=[];return true;
}
export function dismount(mob){const rider=mob.riderId;mob.riderId=null;return rider;}
export function driveMount(mob,controls={},water=false){
  const rec=MOBS[mob.type];
  if(!mob.riderId||!rec?.rideable)return {vx:0,jump:false};
  const dir=(controls.right?1:0)-(controls.left?1:0);
  const speed=rec.speedPps*(water?M.MOUNT_WATER_SPEED_SCALE:1);
  const jump=!!controls.jump&&mob.ground;
  if(jump)mob.vy=-(mob.jumpPower?6+mob.jumpPower*6:M.RIDE_JUMP_SPEED);
  if(mob.type==='camel'&&controls.dash)mob.vx=dir*M.CAMEL_DASH_SPEED;
  else mob.vx=dir*speed;
  if(Math.abs(mob.vx)>.01)mob.face=mob.vx>0?1:-1;
  return {vx:mob.vx,jump,dash:mob.type==='camel'&&controls.dash};
}

export const PROFESSION_TRADES=Object.freeze({
  farmer:[{give:['wheat',20],get:['emerald',1],xp:2},{give:['emerald',1],get:['bread',6],xp:2}],
  fisherman:[{give:['string',20],get:['emerald',1],xp:2},{give:['emerald',1],get:['cooked_cod',6],xp:2}],
  butcher:[{give:['chicken',14],get:['emerald',1],xp:2},{give:['emerald',1],get:['cooked_porkchop',5],xp:2}],
  armorer:[{give:['coal',15],get:['emerald',1],xp:2},{give:['emerald',5],get:['iron_helmet',1],xp:5}],
  librarian:[{give:['paper',24],get:['emerald',1],xp:2},{give:['emerald',9],get:['bookshelf',1],xp:5}],
  weaponsmith:[{give:['coal',15],get:['emerald',1],xp:2},{give:['emerald',3],get:['iron_axe',1],xp:5}],
  toolsmith:[{give:['coal',15],get:['emerald',1],xp:2},{give:['emerald',1],get:['stone_pickaxe',1],xp:5}],
  cleric:[{give:['rotten_flesh',32],get:['emerald',1],xp:2},{give:['emerald',1],get:['redstone',2],xp:2}],
  none:[{give:['emerald',1],get:['bread',3],xp:1}],
});
export function tradeOffers(mob){
  if(!MOBS[mob.type]?.components?.trading)return [];
  const key=mob.type==='wandering_trader'?'none':(mob.variant||'none');
  const trades=PROFESSION_TRADES[key]||PROFESSION_TRADES.none;
  return trades.map((t,i)=>({...t,id:`${mob.id}.trade.${i}`,uses:mob.tradeUses?.[i]||0,maxUses:12,level:1}));
}
export function performTrade(mob,tradeId,have,consume){
  const offer=tradeOffers(mob).find(t=>t.id===tradeId);
  if(!offer||offer.uses>=offer.maxUses)return {ok:false,reason:'unavailable'};
  if((have(offer.give[0])||0)<offer.give[1])return {ok:false,reason:'missingInput'};
  consume(offer.give[0],offer.give[1]);
  mob.tradeUses??={};mob.tradeUses[tradeId.split('.').pop()]=(mob.tradeUses[tradeId.split('.').pop()]||0)+1;
  mob.tradeXp=(mob.tradeXp||0)+offer.xp;
  return {ok:true,get:offer.get,xp:offer.xp,restockAfter:2400};
}

export function serializeMob(mob){
  const rec=MOBS[mob.type];
  if(!rec||!isPersistent(mob))return null;
  return {
    id:mob.id,type:mob.type,x:mob.x,y:mob.y,w:mob.w,h:mob.h,health:mob.health,maxHealth:mob.maxHealth,
    variant:mob.variant,marking:mob.marking,ageTicks:mob.ageTicks,loveTicks:mob.loveTicks,breedCooldown:mob.breedCooldown,
    ownerId:mob.ownerId,tamed:mob.tamed,tameProgress:mob.tameProgress,sitting:mob.sitting,customName:mob.customName,
    leashedTo:mob.leashedTo,saddled:mob.saddled,chest:mob.chest,heldItem:mob.heldItem,mouthItem:mob.mouthItem,
    sheared:mob.sheared,woolColor:mob.woolColor,size:mob.size,home:mob.home,persistent:true,
    tradeUses:mob.tradeUses,tradeXp:mob.tradeXp,eggTimer:mob.eggTimer,dimension:mob.dimension,
  };
}
export function restoreMobState(data){
  const rec=MOBS[data?.type];
  if(!rec||![data.x,data.y,data.health].every(Number.isFinite)||data.health<=0)return null;
  const mob=createMobState(data.type,data.x,data.y,{id:data.id,variant:data.variant,baby:data.ageTicks<0,size:data.size,persistent:true});
  const allowed=['w','h','health','maxHealth','marking','ageTicks','loveTicks','breedCooldown','ownerId','tamed','tameProgress','sitting','customName','leashedTo','saddled','chest','heldItem','mouthItem','sheared','woolColor','home','tradeUses','tradeXp','eggTimer','dimension'];
  for(const k of allowed)if(data[k]!==undefined)mob[k]=data[k];
  mob.health=Math.min(Math.max(0,mob.health),Math.max(1,mob.maxHealth));
  return mob;
}
