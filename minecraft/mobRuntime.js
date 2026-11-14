/* game.js 与纯逻辑生物层之间的适配器。
 * 只依赖 World 的公开接口；AI、寻路、成长计时均可脱离渲染测试。 */
import { MOBS } from './mobRegistry.js';
import * as M from './mobConstants.js';
import * as K from './combat.js';
import { tickMobAI } from './mobGoals.js';
import { Pathfinder, followPath } from './mobPath.js';
import { growTick } from './mobComponents.js';

export class MobRuntime{
  constructor(world){
    this.world=world;this.pathUsedMs=0;this.lastTick=-1;
    this.pathfinder=new Pathfinder({
      solid:(x,y)=>world.solid(x,y),
      fluid:(x,y)=>{const id=world.get(x,y);return id===17?'water':world.fluidGet(x,y)?.type===1?'lava':null;},
      danger:(x,y)=>world.touchingCactus({x,y,w:1,h:1}),
      climbable:(x,y)=>world.solid(x-1,y)||world.solid(x+1,y),
      get revision(){return world.revision;},
    });
  }
  inWater(m){return this.world.get(m.x+m.w/2,m.y+m.h*.55)===17;}
  resolveEntity(id){if(id==='player')return this.world.player;return this.world.mobs.find(m=>m.id===id)||null;}
  speed(m,scale=1){return (MOBS[m.type]?.speedPps||1)*scale;}
  followRange(m){return MOBS[m.type]?.followRange||16;}
  envFor(mob){
    const w=this.world,runtime=this;
    return {
      mob,w,world:w,mobs:w.mobs,player:w.player,tick:w.tickCount,rng:()=>w.rng(),difficulty:w.difficulty,
      night:w.night(),weather:w.weather,heldItem:w.held()?.id||null,
      inWater:m=>runtime.inWater(m),resolveEntity:id=>runtime.resolveEntity(id),
      speed:(m,s)=>runtime.speed(m,s),followRange:m=>runtime.followRange(m),
      lineOfSight:(a,b)=>w.lineOfSight(a,b),exposedToSky:m=>{
        for(let y=Math.floor(m.y)-1;y>=0;y--)if(w.solid(Math.floor(m.x+m.w/2),y))return false;
        return true;
      },
      findShelter:m=>{
        const x=Math.floor(m.x);for(const dir of [-1,1])for(let d=2;d<10;d++){const nx=x+dir*d,gy=w.groundAt(nx);if(w.solid(nx,gy-3))return {x:nx,y:gy-1,w:1,h:1};}
        return null;
      },
      findDoor:(m,breaking)=>w.findMobDoor?.(m,breaking)||null,
      findGoalBlock:(m,type,range)=>w.findMobGoalBlock?.(m,type,range)||null,
      vibrationTarget:m=>w.findVibrationTarget?.(m)||null,
      navigate:(m,target,scale)=>runtime.navigate(m,target,scale),
      emit:action=>w.mobAction(action),
    };
  }
  beginTick(){this.pathUsedMs=0;}
  navigate(m,target,speedScale=1){
    const rec=MOBS[m.type],speed=this.speed(m,speedScale);
    if(!target)return {vx:0,jump:false};
    if(rec.movementType==='fly'||rec.movementType==='swim'||rec.movementType==='amphibious'||rec.movementType==='teleport'){
      m.face=target.x>=m.x?1:-1;
      return {vx:Math.sign(target.x-m.x)*speed,jump:false};
    }
    const dx=target.x-m.x,dy=(target.y+target.h)-(m.y+m.h);
    if(Math.abs(dx)>3&&m.repathTicks<=0&&this.pathUsedMs<M.PATH_BUDGET_MS){
      const start={x:m.x+m.w/2,y:m.y+m.h},goal={x:target.x+(target.w||1)/2,y:target.y+(target.h||1)};
      const result=this.pathfinder.request(start,goal,{movement:rec.movementType,height:m.h,budgetMs:Math.max(.05,M.PATH_BUDGET_MS-this.pathUsedMs),maxDrop:rec.movementType==='hop'?4:3});
      this.pathUsedMs+=result.ms||0;m.path=result.path;m.pathIndex=0;m.pathComplete=result.complete;
      m.repathTicks=Math.abs(m.x-this.world.player.x)>32?M.PATH_FAR_REPATH_TICKS:M.PATH_REPATH_TICKS;
    }
    if(m.path?.length){
      const out=followPath(m,m.path,speed);if(!out.done)return out;
    }
    m.face=dx>=0?1:-1;
    const aheadX=m.x+(dx>0?m.w+.15:-.15),feet=m.y+m.h;
    const jump=m.ground&&(this.world.solid(aheadX,feet-.2)||dy<-.8);
    return {vx:Math.sign(dx)*speed,jump};
  }
  tickCommon(m){
    const w=this.world,rec=MOBS[m.type];if(!rec||m.dying)return;
    m.clock+=M.TICK_RATE?1/20:.05;m.hurt=Math.max(0,(m.hurt||0)-.05);
    m.panic=Math.max(0,(m.panic||0)-1);m.targetMemory=Math.max(0,(m.targetMemory||0)-1);
    if(m.attackTimer>0)m.attackTimer--;if(m.shootTimer>0)m.shootTimer--;if(m.repathTicks>0)m.repathTicks--;
    K.tickHurt(m);
    const growth=growTick(m);if(growth.grewUp)w.mobAction({type:'growUp',mob:m});
    if(rec.components?.eggLaying&&m.ageTicks>=0&&--m.eggTimer<=0){m.eggTimer=M.CHICKEN_EGG_MIN_TICKS+Math.floor(w.rng()*(M.CHICKEN_EGG_MAX_TICKS-M.CHICKEN_EGG_MIN_TICKS));w.mobAction({type:'layEgg',mob:m});}
    if(rec.components?.growInto){m.transformTicks=(m.transformTicks??M.BABY_GROW_TICKS)-1;if(m.transformTicks<=0)w.mobAction({type:'transform',mob:m,into:rec.components.growInto});}
    if(rec.components?.airDamage){
      if(this.inWater(m))m.airTicks=0;else if(++m.airTicks>=M.FISH_AIR_DAMAGE_INTERVAL){m.airTicks=0;w.mobAction({type:'selfDamage',mob:m,amount:2,reason:'离水窒息'});}
    }
    if(m.stingTicks>0&&--m.stingTicks===0)w.mobAction({type:'selfDamage',mob:m,amount:999,reason:'蜇针脱落'});
    if(m.rolledUp>0)m.rolledUp--;
    if(rec.components?.inflate){m.inflated=Math.abs(m.x-w.player.x)<3;if(m.inflated&&Math.abs(m.x-w.player.x)<1.2)w.mobAction({type:'poison',mob:m,target:w.player});}
    if(rec.components?.playDead&&m.hurt>0&&w.rng()<.1)m.playingDead=M.AXOLOTL_PLAY_DEAD_TICKS;
    if(m.playingDead>0){m.playingDead--;m.vx=0;if(m.playingDead===0)m.health=Math.min(m.maxHealth,m.health+4);}
    if(m.type==='wither'){
      if(w.tickCount%M.WITHER_REGEN_INTERVAL===0)m.health=Math.min(m.maxHealth,m.health+1);
      m.armor=m.health<=m.maxHealth*M.WITHER_ARMOR_THRESHOLD?4:rec.armor;
      m.projectileImmune=m.health<=m.maxHealth*M.WITHER_ARMOR_THRESHOLD;
    }
    if(rec.components?.snowTrail&&m.ground&&w.tickCount%10===0)w.mobAction({type:'snowTrail',mob:m});
    if(rec.components?.heat&&w.tickCount%40===0&&!['snowy_plains','taiga'].includes(w.biomeAt(m.x)))w.mobAction({type:'selfDamage',mob:m,amount:1,reason:'高温'});
    if(rec.components?.split){const size=m.size??2;m.maxHealth=size===2?16:size===1?4:1;}
    tickMobAI(m,this.envFor(m));
  }
}
