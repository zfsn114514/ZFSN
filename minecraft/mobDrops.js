/* 生物掉落与经验：纯逻辑，不生成世界掉落物。调用方负责走现有 drop/xp_orb。 */
import { MOBS } from './mobRegistry.js';
import { COOKED_DROPS } from './mobConstants.js';

const int=(rng,min,max)=>min+Math.floor(rng()*(max-min+1));
const variantItem=(mob,id)=>{
  if(id!=='white_wool'||!mob.variant)return id;
  return `${mob.variant}_wool`;
};

/** 返回 [[itemId,count],...]。opts: burned, looting, playerKill, chargedCreeper,
 * skeletonKill, ramming, brushing, grewUp, firstDragonKill. */
export function rollMobDrops(mob,opts={}){
  const rng=opts.rng||Math.random,rec=MOBS[mob.type||mob.id];
  if(!rec||(mob.ageTicks??0)<0)return [];
  const out=[],looting=Math.max(0,opts.looting||0);
  for(const d of rec.drops){
    if(d.playerOnly&&!opts.playerKill)continue;
    if(d.chargedCreeperOnly&&!opts.chargedCreeper)continue;
    if(d.skeletonKillOnly&&!opts.skeletonKill)continue;
    if(d.whenRamming&&!opts.ramming)continue;
    if(d.onBrush&&!opts.brushing)continue;
    if(d.onGrowUp&&!opts.grewUp)continue;
    if(d.firstKillOnly&&opts.firstDragonKill===false)continue;
    if(d.whenNotSheared&&mob.sheared)continue;
    if(d.onlySize!==undefined&&(mob.size??0)!==d.onlySize)continue;
    if(d.requiresHeld&&mob.heldItem!==d.item)continue;
    if(d.captainOnly&&!mob.captain)continue;
    const chance=Math.min(1,(d.chance??1)+looting*(d.lootingChance??0));
    if(rng()>=chance)continue;
    const min=d.min,max=d.max+looting*(d.looting??0);
    const n=int(rng,min,max);
    if(n<=0)continue;
    let id=variantItem(mob,d.item);
    if(opts.burned)id=COOKED_DROPS[id]||id;
    out.push([id,n]);
  }
  return out;
}

export function rollMobXp(mob,opts={}){
  const rng=opts.rng||Math.random,rec=MOBS[mob.type||mob.id];
  if(!rec||(mob.ageTicks??0)<0)return 0;
  if(mob.type==='ender_dragon'&&opts.firstDragonKill===false)return rec.xpRepeat;
  if(rec.components?.split){
    const size=mob.size??2;
    return size===2?4:size===1?2:1;
  }
  if(Array.isArray(rec.xp))return int(rng,rec.xp[0],rec.xp[1]);
  return rec.xp||0;
}

export function mergeDrops(entries){
  const map=new Map();
  for(const [id,n] of entries)map.set(id,(map.get(id)||0)+n);
  return [...map];
}
