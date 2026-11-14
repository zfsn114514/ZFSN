/* 通用 AI Goal / TargetGoal 系统。纯逻辑，渲染与 Canvas 不可见。
 * Goal 之间按 priority + flag 调度；targetGoals 独立管理仇恨。
 * 世界副作用通过 env.emit(action) 交给 game.js，便于 Node 测试。 */
import { MOBS, attackFor } from './mobRegistry.js';
import * as M from './mobConstants.js';
import { canBreed } from './mobComponents.js';

const F=M.GOAL_FLAG;
const TYPE_FLAGS={
  Float:F.MOVE|F.JUMP,Panic:F.MOVE,RandomStroll:F.MOVE,LookAtPlayer:F.LOOK,RandomLookAround:F.LOOK,
  MeleeAttack:F.MOVE|F.LOOK|F.ATTACK,RangedAttack:F.MOVE|F.LOOK|F.ATTACK,FleeFromEntity:F.MOVE,
  FollowOwner:F.MOVE,SitWhenOrdered:F.MOVE,BreedWithPartner:F.MOVE,TemptByItem:F.MOVE|F.LOOK,
  FollowParent:F.MOVE,AvoidSun:F.MOVE,BreakDoor:F.MOVE|F.ATTACK,OpenDoor:F.MOVE,
  MoveToBlock:F.MOVE,EatBlock:F.MOVE,Teleport:F.MOVE,SwimUp:F.MOVE|F.JUMP,SwimDown:F.MOVE,
  FlyAround:F.MOVE|F.JUMP,Explode:F.MOVE|F.ATTACK,Stare:F.TARGET,Sleep:F.MOVE,
  HurtByTarget:F.TARGET,NearestAttackableTarget:F.TARGET,DefendVillage:F.TARGET,
};
const dist=(a,b)=>Math.hypot((a.x+a.w/2)-(b.x+b.w/2),(a.y+a.h/2)-(b.y+b.h/2));
const horizontal=(a,b)=>Math.abs((a.x+a.w/2)-(b.x+b.w/2));
const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
const living=e=>e&&(e.health??1)>0&&!e.dying;

export class Goal{
  constructor(spec,mob,env){Object.assign(this,spec);this.spec=spec;this.mob=mob;this.env=env;this.flags=spec.flags??TYPE_FLAGS[spec.type]??0;this.state=mob.goalStates[spec.type]??={};}
  canUse(){return true;}
  canContinue(){return this.canUse();}
  start(){}
  tick(){}
  stop(){}
  isInterruptible(){return this.interruptible!==false;}
}

export class GoalScheduler{
  constructor(mob,env,specs){
    this.mob=mob;this.env=env;this.goals=specs.map(s=>createGoal(s,mob,env)).sort((a,b)=>a.priority-b.priority);
    this.active=new Set();
  }
  tick(){
    const selected=new Set(),used=new Set();
    for(const goal of this.goals){
      const running=this.active.has(goal);
      const usable=running?goal.canContinue():goal.canUse();
      if(!usable)continue;
      let conflict=false;
      for(const other of selected)if((goal.flags&other.flags)!==0){conflict=true;break;}
      if(conflict)continue;
      selected.add(goal);
      for(const flag of Object.values(F))if(goal.flags&flag)used.add(flag);
      if(!running)goal.start();
    }
    for(const old of this.active)if(!selected.has(old))old.stop();
    this.active=selected;
    for(const goal of this.active)goal.tick();
    this.mob.activeGoals=[...this.active].map(g=>g.type);
    return this.mob.activeGoals;
  }
  stopAll(){for(const g of this.active)g.stop();this.active.clear();this.mob.activeGoals=[];}
}

class FloatGoal extends Goal{
  canUse(){return this.env.inWater(this.mob)&&this.mob.movementType!=='fly'&&!this.mob.sitting;}
  tick(){this.mob.vy=Math.min(this.mob.vy,-M.MOB_SWIM_UP_SPEED);}
}
class PanicGoal extends Goal{
  canUse(){return (this.mob.panic||0)>0&&!this.mob.tamed;}
  start(){this.state.ticks=Math.max(this.mob.panic,M.MOB_HURT_PANIC_TICKS);if(this.rollUp)this.mob.rolledUp=M.ARMADILLO_ROLL_TICKS;}
  tick(){
    const from=this.env.resolveEntity(this.mob.lastAttackerId)||this.env.player;
    const dir=Math.sign(this.mob.x-from.x)||this.mob.face||1;
    this.mob.vx=dir*this.env.speed(this.mob,1.8);
    if(this.ink&&this.state.ticks===Math.max(this.mob.panic,M.MOB_HURT_PANIC_TICKS))this.env.emit({type:'ink',mob:this.mob});
  }
  stop(){this.mob.panic=0;}
}
class RandomStrollGoal extends Goal{
  canUse(){return !this.mob.sitting&&!this.mob.riderId&&this.mob.movementType!=='fly'&&this.mob.movementType!=='stationary'&&this.mob.movementType!=='swim'||this.env.inWater(this.mob)&&!this.mob.sitting;}
  start(){this.state.until=0;this.state.dir=0;}
  tick(){
    const s=this.state,e=this.env;
    if(e.tick>=s.until){s.until=e.tick+40+Math.floor(e.rng()*61);const r=e.rng();s.dir=r<.35?0:r<.675?-1:1;s.swimDir=e.rng()<.5?-1:1;}
    this.mob.vx=s.dir*e.speed(this.mob,.55);
    if(e.inWater(this.mob))this.mob.vy=(s.swimDir||1)*e.speed(this.mob,.25);
    if(s.dir)this.mob.face=s.dir;
  }
}
class LookAtPlayerGoal extends Goal{
  canUse(){const p=this.env.player;return !p.creative&&horizontal(this.mob,p)<(this.range||6)&&Math.abs(this.mob.y-p.y)<6;}
  tick(){this.mob.face=this.env.player.x>=this.mob.x?1:-1;this.mob.lookTarget='player';}
}
class RandomLookAroundGoal extends Goal{
  canUse(){return !this.mob.lookTarget;}
  tick(){if(this.env.tick>=(this.state.next||0)){this.state.next=this.env.tick+30+Math.floor(this.env.rng()*70);this.mob.face=this.env.rng()<.5?-1:1;}}
  stop(){this.mob.lookTarget=null;}
}

function targetOf(goal){return goal.env.resolveEntity(goal.mob.targetId);}
function navigate(goal,target,speedScale=1){
  const out=goal.env.navigate(goal.mob,target,speedScale);
  if(out&&Number.isFinite(out.vx))goal.mob.vx=out.vx;
  if(out?.jump&&goal.mob.ground)goal.mob.vy=-M.MOB_JUMP_SPEED;
  return out;
}
class MeleeAttackGoal extends Goal{
  canUse(){const t=targetOf(this);return living(t)&&dist(this.mob,t)<=this.env.followRange(this.mob)*1.5;}
  canContinue(){const t=targetOf(this);return living(t)&&dist(this.mob,t)<=this.env.followRange(this.mob)*2;}
  tick(){
    const m=this.mob,t=targetOf(this);if(!t)return;
    const d=dist(m,t);
    if(this.style==='dive'){m.vy=Math.min(8,m.vy+1.2);navigate(this,t,1.6);}
    else if(this.style==='ram'&&d<12&&d>3){m.vx=Math.sign(t.x-m.x)*this.env.speed(m,2.2);}
    else if(d>Math.max(m.w,t.w)*.75)navigate(this,t,1);
    else m.vx*=.5;
    if(m.attackTimer<=0&&(overlap(m,t)||d<Math.max(1.1,(m.w+t.w)*.55))){
      m.attackTimer=this.cooldown||M.MOB_ATTACK_COOLDOWN;
      this.env.emit({type:'melee',mob:m,target:t,damage:attackFor(MOBS[m.type],this.env.difficulty),effect:this.effect,sting:this.sting,eatTarget:this.eatTarget,style:this.style});
      if(this.sting)m.stingTicks=M.BEE_DEATH_AFTER_STING_TICKS;
    }
  }
}
class RangedAttackGoal extends Goal{
  canUse(){const t=targetOf(this);return living(t)&&dist(this.mob,t)<=this.env.followRange(this.mob)*1.5;}
  canContinue(){return this.canUse();}
  tick(){
    const m=this.mob,t=targetOf(this);if(!t)return;
    const d=dist(m,t),min=this.minRange??3,max=this.maxRange??this.env.followRange(m);
    if(m.movementType!=='fly'&&m.movementType!=='stationary'){
      if(d>max)navigate(this,t,1);
      else if(d<min)m.vx=Math.sign(m.x-t.x||1)*this.env.speed(m,.9);
      else m.vx*=.6;
    }
    m.face=t.x>=m.x?1:-1;
    if(m.shootTimer<=0&&d>=Math.min(1,min)&&d<=max&&(this.projectile==='sonic_boom'||this.env.lineOfSight(m,t))){
      m.shootTimer=Array.isArray(this.cooldown)?this.cooldown[0]+Math.floor(this.env.rng()*(this.cooldown[1]-this.cooldown[0]+1)):(this.cooldown||M.MOB_ATTACK_COOLDOWN*2);
      this.env.emit({type:'projectile',mob:m,target:t,projectile:this.projectile,damage:this.damage||attackFor(MOBS[m.type],this.env.difficulty),effect:this.effect,homing:this.homing,bypassArmor:this.bypassArmor,burst:this.burst||1,summon:this.summon,heads:this.heads||1});
    }
  }
}
class FleeFromEntityGoal extends Goal{
  canUse(){
    if(this.target==='rain')return this.env.weather==='rain';
    if(this.unlessTamed&&this.mob.tamed)return false;
    if(this.unlessTempted&&this.mob.tempted)return false;
    return !!this.findThreat();
  }
  findThreat(){
    const e=this.env,m=this.mob,range=this.range||8;
    if(this.target==='player'&&horizontal(m,e.player)<range&&!e.player.creative)return e.player;
    const types=this.types||(this.target&&this.target!=='player'?[this.target]:[]);
    return e.mobs.find(o=>o!==m&&living(o)&&dist(m,o)<range&&(types.includes(o.type)||this.target==='hostile'&&MOBS[o.type]?.category==='hostile'));
  }
  tick(){const threat=this.findThreat();if(threat){const dir=Math.sign(this.mob.x-threat.x)||1;this.mob.vx=dir*this.env.speed(this.mob,1.8);}}
}
class FollowOwnerGoal extends Goal{
  canUse(){return this.mob.tamed&&!this.mob.sitting&&this.mob.ownerId==='player'&&!this.mob.riderId&&dist(this.mob,this.env.player)>M.FOLLOW_OWNER_STOP;}
  tick(){const d=dist(this.mob,this.env.player);if(d>M.FOLLOW_OWNER_RANGE)this.env.emit({type:'teleportToOwner',mob:this.mob});else navigate(this,this.env.player,1.2);}
}
class SitWhenOrderedGoal extends Goal{
  canUse(){return !!this.mob.sitting;}
  tick(){this.mob.vx=0;this.mob.path=[];}
}
class BreedWithPartnerGoal extends Goal{
  canUse(){const m=this.mob;return m.loveTicks>0&&m.breedCooldown<=0&&this.env.mobs.some(o=>canBreed(m,o));}
  tick(){
    const m=this.mob,partner=this.env.mobs.filter(o=>canBreed(m,o)).sort((a,b)=>dist(m,a)-dist(m,b))[0];
    if(!partner)return;
    if(dist(m,partner)>M.BREED_RANGE)navigate(this,partner,.8);
    else{m.vx=0;this.env.emit({type:'breed',mob:m,partner});}
  }
}
class TemptByItemGoal extends Goal{
  canUse(){const items=this.items||MOBS[this.mob.type].food||[];return items.includes(this.env.heldItem)&&dist(this.mob,this.env.player)<M.TEMPT_RANGE;}
  start(){this.mob.tempted=true;}
  tick(){this.mob.tempted=true;navigate(this,this.env.player,.8);}
  stop(){this.mob.tempted=false;}
}
class FollowParentGoal extends Goal{
  canUse(){return (this.mob.ageTicks??0)<0;}
  tick(){
    const m=this.mob,parent=this.env.mobs.filter(o=>o!==m&&o.type===m.type&&(o.ageTicks??0)>=0).sort((a,b)=>dist(m,a)-dist(m,b))[0];
    if(parent&&dist(m,parent)<M.BABY_FOLLOW_RANGE&&dist(m,parent)>2)navigate(this,parent,.8);
  }
}
class AvoidSunGoal extends Goal{
  canUse(){const m=this.mob,rec=MOBS[m.type];return !this.env.night&&rec?.tags?.includes('undead')&&!['husk','drowned','wither_skeleton'].includes(m.type)&&this.env.exposedToSky(m);}
  tick(){const shelter=this.env.findShelter?.(this.mob);if(shelter)navigate(this,shelter,1.2);else this.mob.vx=(this.mob.face||1)*this.env.speed(this.mob,1.1);}
}
class BreakDoorGoal extends Goal{
  canUse(){return this.env.difficulty==='hard'&&targetOf(this)&&this.env.findDoor?.(this.mob,true);}
  tick(){const door=this.env.findDoor(this.mob,true);if(door)navigate(this,door,1);if(door&&dist(this.mob,door)<1.5)this.env.emit({type:'breakDoor',mob:this.mob,door});}
}
class OpenDoorGoal extends Goal{
  canUse(){return !!this.env.findDoor?.(this.mob,false);}
  tick(){const door=this.env.findDoor(this.mob,false);if(door&&dist(this.mob,door)<1.5)this.env.emit({type:'openDoor',mob:this.mob,door});else if(door)navigate(this,door,1);}
}
class MoveToBlockGoal extends Goal{
  canUse(){this.targetBlock=this.env.findGoalBlock?.(this.mob,this.block,this.range||16);return !!this.targetBlock;}
  tick(){if(!this.targetBlock)return;navigate(this,this.targetBlock,.8);if(dist(this.mob,this.targetBlock)<1.5)this.env.emit({type:'moveToBlock',mob:this.mob,block:this.block,target:this.targetBlock});}
}
class EatBlockGoal extends Goal{
  canUse(){return this.env.tick>=(this.state.next||0)&&this.env.findGoalBlock?.(this.mob,this.block,this.range||4);}
  start(){this.state.next=this.env.tick+(this.interval||1200);}
  tick(){const m=this.mob;this.state.next=this.env.tick+(this.interval||1200);this.env.emit({type:'eatBlock',mob:m,block:this.block});}
}

class TeleportGoal extends Goal{
  canUse(){const m=this.mob;return this.env.tick>=(this.state.next||0)&&(this.env.inWater(m)||m.hurt>0||targetOf(this)&&dist(m,targetOf(this))>(this.range||16));}
  tick(){this.state.next=this.env.tick+M.ENDERMAN_TELEPORT_INTERVAL;this.env.emit({type:'teleport',mob:this.mob,target:targetOf(this),range:this.range||16});}
}
class SwimGoal extends Goal{
  canUse(){return this.env.inWater(this.mob);}
  tick(){const dir=this.type==='SwimUp'?-1:1;this.mob.vy=dir*this.env.speed(this.mob,.35);}
}
class FlyAroundGoal extends Goal{
  canUse(){return !this.mob.sitting;}
  start(){this.state.next=0;this.state.dx=0;this.state.dy=0;}
  tick(){
    const m=this.mob,e=this.env,s=this.state,rec=MOBS[m.type];
    if(rec?.components?.ellipseArena&&m.arena){
      const angle=(e.tick%M.ENDER_DRAGON_PERIOD_TICKS)/M.ENDER_DRAGON_PERIOD_TICKS*Math.PI*2;
      const tx=m.arena.cx+Math.cos(angle)*M.ENDER_DRAGON_ARENA_RX,ty=m.arena.cy+Math.sin(angle)*M.ENDER_DRAGON_ARENA_RY;
      s.dx=Math.sign(tx-m.x);s.dy=Math.sign(ty-m.y);
    }else if(e.tick>=s.next){s.next=e.tick+30+Math.floor(e.rng()*60);s.dx=e.rng()*2-1;s.dy=e.rng()*2-1;}
    m.vx+=(s.dx*e.speed(m,1)-m.vx)*Math.min(1,M.MOB_FLY_ACCEL/20);
    m.vy+=(s.dy*e.speed(m,.7)-m.vy)*Math.min(1,M.MOB_FLY_ACCEL/20);
    m.vx*=M.MOB_FLY_DRAG;m.vy*=M.MOB_FLY_DRAG;
    const sp=Math.hypot(m.vx,m.vy);if(sp>M.MOB_FLY_MAX_SPEED){m.vx*=M.MOB_FLY_MAX_SPEED/sp;m.vy*=M.MOB_FLY_MAX_SPEED/sp;}
  }
}
class ExplodeGoal extends Goal{
  canUse(){return living(targetOf(this))||this.mob.fuse>0;}
  tick(){
    const m=this.mob,t=targetOf(this);if(!t&&m.fuse<=0)return;
    const d=t?dist(m,t):Infinity;
    if(m.fuse>0){
      m.fuse--;m.vx*=.4;
      if(t&&horizontal(m,t)>(this.cancelRange||7)){m.fuse=-1;return;}
      if(m.fuse===0)this.env.emit({type:'explode',mob:m,radius:this.radius||3,charged:m.charged});
    }else{
      navigate(this,t,1);
      if(d<(this.radius||3)+1){m.fuse=this.fuse||30;this.env.emit({type:'fuse',mob:m});}
    }
  }
}
class StareGoal extends Goal{
  canUse(){return false;} // 是目标触发器，不占普通 goal 调度
  tick(){}
  check(){
    const m=this.mob,p=this.env.player;
    if(p.creative||dist(m,p)>(this.range||32)||!this.env.lineOfSight(m,p))return false;
    const toward=Math.sign(m.x-p.x);return p.face===toward;
  }
}
class SleepGoal extends Goal{
  canUse(){const m=this.mob;if(m.type==='villager')return this.env.night;if(m.type==='fox')return !this.env.night;if(m.type==='bat')return !this.env.night&&this.env.findGoalBlock?.(m,'ceiling',4);return false;}
  tick(){this.mob.sleeping=true;this.mob.vx=0;if(this.hang)this.mob.hanging=true;}
  stop(){this.mob.sleeping=false;this.mob.hanging=false;}
}

class HurtByTargetGoal extends Goal{
  canUse(){return !!this.mob.lastAttackerId&&this.mob.targetMemory>0;}
  tick(){
    const m=this.mob;m.targetId=m.lastAttackerId;
    if(MOBS[m.type]?.components?.callHelp||MOBS[m.type]?.components?.packHelp){
      if(!this.state.called){this.state.called=true;this.env.emit({type:'callHelp',mob:m,attackerId:m.lastAttackerId,range:M.CALL_HELP_RANGE});}
    }
  }
  stop(){this.state.called=false;}
}
class NearestAttackableTargetGoal extends Goal{
  canUse(){return !this.mob.targetId||!living(this.env.resolveEntity(this.mob.targetId))||this.mob.targetMemory<=0;}
  tick(){
    const m=this.mob,e=this.env;let found=null;
    if(this.target==='player'){
      if(!e.player.creative&&(!this.nightOnly||e.night||m.aggro)&&(!this.nearBaby||e.mobs.some(o=>o.type===m.type&&(o.ageTicks??0)<0))&&dist(m,e.player)<=e.followRange(m))found=e.player;
    }else if(this.target==='ownerAttacker')found=e.resolveEntity(m.ownerTargetId);
    else if(this.target==='hostile')found=e.mobs.filter(o=>MOBS[o.type]?.category==='hostile'&&living(o)&&dist(m,o)<=e.followRange(m)).sort((a,b)=>dist(m,a)-dist(m,b))[0];
    else if(this.target==='aquatic')found=e.mobs.filter(o=>MOBS[o.type]?.category==='aquatic'&&living(o)&&dist(m,o)<=e.followRange(m)).sort((a,b)=>dist(m,a)-dist(m,b))[0];
    else if(this.target==='small_slime')found=e.mobs.filter(o=>['slime','magma_cube'].includes(o.type)&&(o.size??0)===0&&living(o)&&dist(m,o)<=e.followRange(m)).sort((a,b)=>dist(m,a)-dist(m,b))[0];
    else if(this.target==='vibration')found=e.vibrationTarget?.(m);
    if(found){m.targetId=found.id||'player';m.targetMemory=M.TARGET_MEMORY_TICKS;}
  }
}
class DefendVillageGoal extends NearestAttackableTargetGoal{
  canUse(){return true;}
  tick(){
    const m=this.mob,e=this.env;
    const village=e.mobs.find(o=>o.type==='villager'&&dist(m,o)<24);
    const foe=e.mobs.filter(o=>MOBS[o.type]?.category==='hostile'&&living(o)&&dist(village||m,o)<24).sort((a,b)=>dist(m,a)-dist(m,b))[0];
    if(foe){m.targetId=foe.id;m.targetMemory=M.TARGET_MEMORY_TICKS;}
  }
}

const CLASSES={Float:FloatGoal,Panic:PanicGoal,RandomStroll:RandomStrollGoal,LookAtPlayer:LookAtPlayerGoal,RandomLookAround:RandomLookAroundGoal,MeleeAttack:MeleeAttackGoal,RangedAttack:RangedAttackGoal,FleeFromEntity:FleeFromEntityGoal,FollowOwner:FollowOwnerGoal,SitWhenOrdered:SitWhenOrderedGoal,BreedWithPartner:BreedWithPartnerGoal,TemptByItem:TemptByItemGoal,FollowParent:FollowParentGoal,AvoidSun:AvoidSunGoal,BreakDoor:BreakDoorGoal,OpenDoor:OpenDoorGoal,MoveToBlock:MoveToBlockGoal,EatBlock:EatBlockGoal,HurtByTarget:HurtByTargetGoal,NearestAttackableTarget:NearestAttackableTargetGoal,DefendVillage:DefendVillageGoal,Teleport:TeleportGoal,SwimUp:SwimGoal,SwimDown:SwimGoal,FlyAround:FlyAroundGoal,Explode:ExplodeGoal,Stare:StareGoal,Sleep:SleepGoal};
export function createGoal(spec,mob,env){const Cls=CLASSES[spec.type];if(!Cls)throw Error(`未实现的 AI goal ${spec.type}`);return new Cls(spec,mob,env);}

export function tickMobAI(mob,env){
  const rec=MOBS[mob.type];if(!rec)return [];
  if(!mob._goalScheduler){
    mob._goalScheduler=new GoalScheduler(mob,env,rec.aiGoals);
    mob._targetScheduler=new GoalScheduler(mob,env,rec.targetGoals);
  }
  mob._goalScheduler.env=env;mob._targetScheduler.env=env;
  for(const g of mob._goalScheduler.goals)g.env=env;for(const g of mob._targetScheduler.goals)g.env=env;
  const stare=mob._goalScheduler.goals.find(g=>g.type==='Stare');
  if(stare?.check()){mob.targetId='player';mob.targetMemory=M.TARGET_MEMORY_TICKS;}
  mob._targetScheduler.tick();
  return mob._goalScheduler.tick();
}

export function clearMobAI(mob){mob._goalScheduler?.stopAll();mob._targetScheduler?.stopAll();delete mob._goalScheduler;delete mob._targetScheduler;}
