/* 群系生成规则、群体生成、分类上限、和平清理与消失。纯逻辑。 */
import { MOBS, isHostile } from './mobRegistry.js';
import * as M from './mobConstants.js';
import { isPersistent } from './mobComponents.js';

export function spawnCapKey(rec){return rec.spawnCap||rec.category;}
export function capFor(rec){return M.SPAWN_CAPS[spawnCapKey(rec)]??-1;}
export function countSpawnCaps(mobs,playerX,range=128){
  const counts={};
  for(const mob of mobs){
    if(mob.dying||Math.abs(mob.x-playerX)>range)continue;
    const rec=MOBS[mob.type];if(!rec)continue;
    const key=spawnCapKey(rec);counts[key]=(counts[key]||0)+1;
  }
  return counts;
}
export function belowCap(rec,mobs,playerX,groupSize=1){
  const cap=capFor(rec);if(cap<0)return true;
  const count=countSpawnCaps(mobs,playerX)[spawnCapKey(rec)]||0;
  return count+groupSize<=cap;
}

/** ctx: biome, light, night, underground, onBlock, inWater, dimension, distance,
 * difficulty, structures:Set, sleeplessTicks, hasStructure(id). */
export function canSpawnAt(rec,ctx){
  const r=rec.spawnRules;
  if(!r?.enabled||ctx.difficulty==='peaceful'&&isHostile(rec.id))return false;
  if((r.dimension||'overworld')!==(ctx.dimension||'overworld'))return false;
  if(r.biomes?.length&&!r.biomes.includes(ctx.biome))return false;
  if(ctx.light>r.lightMax||ctx.light<r.lightMin)return false;
  if(r.timeOfDay==='night'&&!ctx.night||r.timeOfDay==='day'&&ctx.night)return false;
  if(r.underground&&!ctx.underground)return false;
  if(r.onBlocks?.length&&!r.inWater&&!r.onBlocks.includes(ctx.onBlock))return false;
  if(!!r.inWater!==!!ctx.inWater&&r.inWater!==undefined)return false;
  if(isHostile(rec.id)&&ctx.distance<=M.HOSTILE_MIN_SPAWN_DISTANCE)return false;
  if(r.structureOnly&&!(ctx.structures?.has(ctx.biome)||ctx.hasStructure?.(ctx.biome)))return false;
  if(r.sleepless&&(ctx.sleeplessTicks||0)<M.PHANTOM_SLEEPLESS_TICKS)return false;
  return true;
}

export function weightedChoice(entries,rng=Math.random){
  let total=0;for(const e of entries)total+=Math.max(0,e.weight||0);
  if(total<=0)return null;let roll=rng()*total;
  for(const e of entries){roll-=Math.max(0,e.weight||0);if(roll<0)return e;}
  return entries[entries.length-1]||null;
}

export function eligibleMobs(ctx,ids=null){
  const out=[];
  for(const [id,rec] of Object.entries(MOBS)){
    if(ids&&!ids.includes(id))continue;
    if(canSpawnAt(rec,ctx))out.push({id,rec,weight:rec.spawnRules.weight});
  }
  return out;
}

/** 一次 pack 生成计划，不直接写世界。positions 由调用方提供候选点。 */
export function planSpawnGroup(ctx,positions,rng=Math.random,mobs=[]){
  const candidates=eligibleMobs(ctx);
  const picked=weightedChoice(candidates,rng);if(!picked)return [];
  const [lo,hi]=picked.rec.spawnRules.groupSize||[1,1];
  const groupSize=lo+Math.floor(rng()*(hi-lo+1));
  if(!belowCap(picked.rec,mobs,ctx.playerX??ctx.x,groupSize))return [];
  const out=[];
  for(const pos of positions){
    if(out.length>=groupSize)break;
    const local={...ctx,x:pos.x,y:pos.y,biome:pos.biome??ctx.biome,light:pos.light??ctx.light,onBlock:pos.onBlock??ctx.onBlock,inWater:pos.inWater??ctx.inWater,distance:pos.distance??ctx.distance};
    if(canSpawnAt(picked.rec,local))out.push({type:picked.id,x:pos.x,y:pos.y,group:groupSize,variantContext:{cold:['snowy_plains','taiga'].includes(local.biome)}});
  }
  return out;
}

export function shouldDespawn(mob,distance,rng=Math.random,difficulty='normal'){
  if(isPersistent(mob))return false;
  if(difficulty==='peaceful'&&isHostile(mob.type))return true;
  if(distance>M.HOSTILE_DESPAWN_DISTANCE)return true;
  if(isHostile(mob.type)&&distance>M.HOSTILE_RANDOM_DESPAWN_DISTANCE)return rng()<M.HOSTILE_RANDOM_DESPAWN_CHANCE;
  return false;
}

export function peacefulFilter(mobs,difficulty){
  if(difficulty!=='peaceful')return mobs;
  return mobs.filter(m=>!isHostile(m.type)||isPersistent(m)&&m.customName);
}

export function initialSpawnPlan({chunks,contextFor,positionsFor,rng=Math.random,mobs=[]}){
  const out=[];
  for(const chunk of chunks){
    const ctx=contextFor(chunk);
    const positions=positionsFor(chunk).slice(0,M.SPAWN_ATTEMPTS_PER_CYCLE);
    out.push(...planSpawnGroup(ctx,positions,rng,[...mobs,...out]));
  }
  return out;
}
