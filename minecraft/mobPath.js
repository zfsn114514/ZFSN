/* 2D 格点 A*：可走 / 跳 1 格 / 游泳 / 攀爬 / 危险代价。
 * 纯逻辑；环境只暴露 solid/fluid/danger/climbable。路径缓存和每 tick 预算集中在此。 */
import * as M from './mobConstants.js';

const key=(x,y)=>`${x},${y}`;
const heuristic=(a,b)=>Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
class MinHeap{
  constructor(){this.a=[];}
  get size(){return this.a.length;}
  push(v){const a=this.a;a.push(v);let i=a.length-1;while(i){const p=(i-1)>>1;if(a[p].f<=v.f)break;a[i]=a[p];i=p;}a[i]=v;}
  pop(){const a=this.a;if(!a.length)return null;const root=a[0],last=a.pop();if(a.length){let i=0;while(true){let l=i*2+1,r=l+1;if(l>=a.length)break;let c=r<a.length&&a[r].f<a[l].f?r:l;if(a[c].f>=last.f)break;a[i]=a[c];i=c;}a[i]=last;}return root;}
}

export function nodePassable(env,x,y,height=2){
  for(let dy=0;dy<Math.max(1,Math.ceil(height));dy++)if(env.solid(x,y-dy))return false;
  return true;
}
export function nodeDanger(env,x,y){
  if(env.danger?.(x,y))return true;
  const fluid=env.fluid?.(x,y);
  return fluid==='lava'||fluid==='fire'||fluid==='cactus';
}
export function standable(env,x,y,height=2,movement='walk'){
  if(!nodePassable(env,x,y,height))return false;
  const fluid=env.fluid?.(x,y);
  if(fluid==='water')return movement==='swim'||movement==='amphibious'||movement==='walk';
  if(movement==='swim')return false;
  return !!env.solid(x,y+1);
}

/** env: solid(x,y), fluid(x,y), danger(x,y), climbable(x,y), revision. */
export function findPath(env,start,goal,opts={}){
  const movement=opts.movement||'walk',height=opts.height||2,maxNodes=opts.maxNodes||M.PATH_MAX_NODES;
  const budgetMs=opts.budgetMs??M.PATH_BUDGET_MS,now=opts.now||(()=>globalThis.performance?.now?.()??Date.now());
  const t0=now(),maxDrop=opts.maxDrop??M.PATH_MAX_DROP;
  const s={x:Math.floor(start.x),y:Math.floor(start.y)},g={x:Math.floor(goal.x),y:Math.floor(goal.y)};
  if(!nodePassable(env,s.x,s.y,height))return {path:[],complete:false,nodes:0,ms:now()-t0,reason:'startBlocked'};
  const open=new MinHeap(),came=new Map(),cost=new Map(),closed=new Set();
  const sk=key(s.x,s.y);cost.set(sk,0);open.push({...s,f:heuristic(s,g),g:0});
  let best={...s,f:heuristic(s,g),g:0},visited=0,budgetExceeded=false;
  const reconstruct=(node)=>{
    const path=[{x:node.x,y:node.y,jump:!!node.jump,swim:!!node.swim}];let k=key(node.x,node.y);
    while(came.has(k)){const prev=came.get(k);path.push({x:prev.x,y:prev.y,jump:!!prev.jump,swim:!!prev.swim});k=key(prev.x,prev.y);}
    return path.reverse();
  };
  while(open.size&&visited<maxNodes){
    if((visited&31)===0&&now()-t0>budgetMs){budgetExceeded=true;break;}
    const cur=open.pop(),ck=key(cur.x,cur.y);if(closed.has(ck))continue;closed.add(ck);visited++;
    if(heuristic(cur,best)<heuristic(cur,g)&&heuristic(cur,g)<heuristic(best,g))best=cur;
    if(cur.x===g.x&&Math.abs(cur.y-g.y)<=1){best=cur;return {path:reconstruct(cur),complete:true,nodes:visited,ms:now()-t0,budgetExceeded:false};}
    const candidates=[];
    const water=env.fluid?.(cur.x,cur.y)==='water';
    if(water||movement==='swim'||movement==='amphibious'){
      for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1]])candidates.push({x:cur.x+dx,y:cur.y+dy,base:dy===0?M.PATH_SWIM_COST:1,swim:true});
    }
    if(!water&&movement!=='swim'){
      for(const dx of [-1,1]){
        candidates.push({x:cur.x+dx,y:cur.y,base:1});
        candidates.push({x:cur.x+dx,y:cur.y-1,base:M.PATH_JUMP_COST,jump:true});
        for(let drop=1;drop<=maxDrop;drop++)candidates.push({x:cur.x+dx,y:cur.y+drop,base:1+drop*.35});
      }
      if(movement==='climb'||env.climbable?.(cur.x,cur.y))for(const dy of [-1,1])candidates.push({x:cur.x,y:cur.y+dy,base:1.2,jump:true});
    }
    for(const n of candidates){
      if(n.x<(opts.minX??-1000000)||n.x>(opts.maxX??1000000)||n.y<(opts.minY??0)||n.y>(opts.maxY??255))continue;
      const fluid=env.fluid?.(n.x,n.y);
      const valid=n.swim?(nodePassable(env,n.x,n.y,height)&&fluid==='water'):standable(env,n.x,n.y,height,movement);
      if(!valid)continue;
      if(n.jump&&Math.abs(n.x-cur.x)===1&&env.solid(cur.x,cur.y-1))continue;
      const danger=nodeDanger(env,n.x,n.y);
      if(danger&&movement!=='amphibious'&&!opts.allowDanger)continue;
      const nk=key(n.x,n.y);if(closed.has(nk))continue;
      const ng=cur.g+n.base+(danger?M.PATH_DANGER_COST:0);
      if(ng>=(cost.get(nk)??Infinity))continue;
      const next={...n,g:ng,f:ng+heuristic(n,g)};cost.set(nk,ng);came.set(nk,cur);open.push(next);
    }
  }
  return {path:reconstruct(best),complete:false,nodes:visited,ms:now()-t0,budgetExceeded,reason:budgetExceeded?'budget':visited>=maxNodes?'nodeLimit':'unreachable'};
}

export class Pathfinder{
  constructor(env,opts={}){this.env=env;this.opts=opts;this.cache=new Map();this.lastMs=0;this.requests=0;this.cacheHits=0;}
  request(start,goal,opts={}){
    const movement=opts.movement||'walk',height=opts.height||2;
    const k=`${Math.floor(start.x)},${Math.floor(start.y)}>${Math.floor(goal.x)},${Math.floor(goal.y)}:${movement}:${height}:${this.env.revision??0}`;
    const hit=this.cache.get(k);this.requests++;
    if(hit){this.cacheHits++;return {...hit,path:hit.path.map(p=>({...p})),cacheHit:true};}
    const result=findPath(this.env,start,goal,{...this.opts,...opts,movement,height});
    this.lastMs=result.ms;
    if(this.cache.size>=M.PATH_CACHE_LIMIT)this.cache.delete(this.cache.keys().next().value);
    this.cache.set(k,{...result,path:result.path.map(p=>({...p}))});
    return result;
  }
  clear(){this.cache.clear();}
}

export function followPath(mob,path,speedPps,opts={}){
  if(!path?.length)return {vx:0,jump:false,done:true};
  let i=mob.pathIndex||0;
  if(i>=path.length){mob.path=[];mob.pathIndex=0;return {vx:0,jump:false,done:true};}
  const feet=mob.y+mob.h,cx=mob.x+mob.w/2;
  let node=path[i],dx=node.x+.5-cx,dy=node.y-feet;
  if(Math.abs(dx)<.35&&Math.abs(dy)<1.1){i++;mob.pathIndex=i;if(i>=path.length)return {vx:0,jump:false,done:true};node=path[i];dx=node.x+.5-cx;}
  return {vx:Math.sign(dx)*speedPps,jump:!!node.jump&&mob.ground,done:false,node};
}
