/* Browser acceptance: a natural seed, empty survival inventory, real input.
 * npm install --prefix <temporary-directory> playwright
 * PLAYWRIGHT_MODULE=<temporary-directory>/node_modules/playwright node tools/dev/check_mc_survival.cjs
 * Optional MC_URL, MC_OUT. Tests use isolated browser contexts, not personal saves. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const URL=process.env.MC_URL||'http://localhost:88/minecraft/';
const OUT=path.resolve(process.env.MC_OUT||'.tmp-mc/acceptance');
const SAVE='zfsn.minecraft2d.v1';
const evidence=[];
const count=(s,id)=>s.inventory.reduce((n,v)=>n+(v?.id===id?v.n:0),0);
const record=(step,value)=>{evidence.push({step,...value});console.log('PASS',step,JSON.stringify(value));};

(async()=>{
  fs.mkdirSync(OUT,{recursive:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  let page;
  try{
    const context=await browser.newContext({viewport:{width:1280,height:800}});page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(URL);await page.waitForFunction(()=>document.querySelector('#world').width>0);
    await page.locator('#seed').fill('1');await page.locator('#new-world button').click();
    await page.waitForFunction(()=>!document.querySelector('#hud').hidden);
    await page.waitForTimeout(700);
    async function snapshot(){
      assert.equal(await page.locator('dialog[open]').count(),0,'close other dialogs before observing saved state');
      await page.locator('#pause-button').click();
      const data=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),SAVE);
      assert.ok(data?.player&&data?.blocks,'save must contain actual world state');
      await page.locator('#resume').click();await page.waitForTimeout(80);return data;
    }
    function point(s,x,y){const tile=34;const cx=Math.max(0,Math.min(384-1280/tile,s.player.x+s.player.w/2-1280/tile*.5)),cy=Math.max(-15,Math.min(144-800/tile,s.player.y+s.player.h/2-800/tile*.47));return{x:(x+.5-cx)*tile,y:(y+.5-cy)*tile};}
    async function hold(code,ms){await page.keyboard.down(code);await page.waitForTimeout(ms);await page.keyboard.up(code);await page.waitForTimeout(150);}
    async function mine(s,x,y,ms){
      const p=point(s,x,y);await page.mouse.move(p.x,p.y);await page.waitForTimeout(150);
      const label=await page.locator('#target-label').textContent();assert.ok(label&&!label.includes('超出'),`target ${x},${y}: ${label}`);
      await page.mouse.down();await page.waitForTimeout(ms);await page.mouse.up();await page.waitForTimeout(600);
      const next=await snapshot();assert.equal(next.blocks[y*384+x],0,`block ${x},${y} must actually be removed`);return next;
    }
    async function craft(id,uiName,times=1){
      await page.keyboard.press('KeyE');await page.locator('#inventory-dialog').waitFor({state:'visible'});
      for(let i=0;i<times;i++)await page.locator('#recipes .recipe').filter({hasText:new RegExp('^'+uiName+' ×')}).click();
      await page.keyboard.press('Escape');const s=await snapshot();assert.ok(count(s,id)>0,`crafted ${id} must be in inventory`);return s;
    }
    async function select(s,id){let index=s.inventory.findIndex(v=>v?.id===id);assert.ok(index>=0,`missing ${id}`);
      if(index>=9){await page.keyboard.press('KeyE');await page.locator('#slots .slot').nth(index).click();await page.locator('#slots .slot').nth(8).click();await page.keyboard.press('Escape');index=8;}
      await page.locator('#hotbar .slot').nth(index).click();await page.waitForTimeout(100);
      assert.equal(await page.locator('#item-name').textContent(),s.inventory.find(v=>v?.id===id)?({wooden_pickaxe:'木镐',crafting_table_front:'工作台',furnace_front:'熔炉',dirt:'泥土'})[id]:undefined);
    }
    async function place(s,id,x,y){await select(s,id);const p=point(s,x,y);await page.mouse.click(p.x,p.y,{button:'right'});await page.waitForTimeout(180);return snapshot();}
    let s=await snapshot();assert.equal(s.inventory.filter(Boolean).length,0);record('empty survival start',{seed:s.seed,mode:s.mode});
    await hold('KeyD',540);s=await snapshot();
    // This natural seed has its first tree at x=43, ground y=48.
    for(const y of [47,46,45])s=await mine(s,43,y,3250);
    await page.keyboard.down('Space');await hold('KeyD',450);await page.keyboard.up('Space');await page.waitForTimeout(900);s=await snapshot();
    assert.ok(count(s,'oak_log')>=3,`logs=${count(s,'oak_log')}, player=${JSON.stringify(s.player)}, drops=${JSON.stringify(s.drops)}`);record('chop tree / collect logs',{oak_log:count(s,'oak_log')});
    s=await craft('oak_planks','橡木木板',3);assert.equal(count(s,'oak_planks'),12);assert.equal(count(s,'oak_log'),0);
    record('planks',{oak_planks:count(s,'oak_planks'),oak_log:count(s,'oak_log')});
    s=await craft('crafting_table_front','工作台');assert.equal(count(s,'oak_planks'),8);
    s=await place(s,'crafting_table_front',41,48);assert.equal(s.blocks[48*384+41],13);assert.equal(count(s,'crafting_table_front'),0);
    await page.keyboard.press('KeyE');assert.match(await page.locator('#station-status').textContent(),/附近有工作台/);await page.keyboard.press('Escape');
    record('place workbench',{block:s.blocks[48*384+41],remainingTable:count(s,'crafting_table_front')});
    s=await craft('stick','木棍');s=await craft('wooden_pickaxe','木镐');assert.equal(count(s,'oak_planks'),3);assert.equal(count(s,'stick'),2);
    await select(s,'wooden_pickaxe');record('wood pickaxe',{pickaxe:count(s,'wooden_pickaxe'),planks:count(s,'oak_planks'),sticks:count(s,'stick')});
    // Recover the workbench and carry it into the mine, as a player would.
    s=await mine(s,41,48,4100);
    await hold('KeyA',340);await page.waitForTimeout(700);s=await snapshot();
    assert.equal(count(s,'crafting_table_front'),1,'recover the portable workbench');
    // Dig down naturally: dirt first, then eight stone blocks. Player falls into
    // each excavated block and collects its drop; no fixture inventory is injected.
    for(let attempt=0;count(s,'cobblestone')<8&&attempt<18;attempt++){
      s=await snapshot();const x=Math.floor(s.player.x+s.player.w/2),y=Math.floor(s.player.y+s.player.h+.05),id=s.blocks[y*384+x];
      assert.ok([1,2,3,8].includes(id),`unexpected shaft block ${id} at ${x},${y}`);
      s=await mine(s,x,y,id===8?2450:1450);
    }
    assert.ok(count(s,'cobblestone')>=8);record('stone mining',{cobblestone:count(s,'cobblestone'),pickDurability:s.inventory.find(v=>v?.id==='wooden_pickaxe')?.dur,position:s.player.y});
    const alcoveX=Math.floor(s.player.x)-1,alcoveY=Math.floor(s.player.y+s.player.h)-1;
    s=await mine(s,alcoveX,alcoveY,1450);
    s=await place(s,'crafting_table_front',alcoveX,alcoveY);assert.equal(s.blocks[alcoveY*384+alcoveX],13);
    const stoneBefore=count(s,'cobblestone');
    s=await craft('furnace_front','熔炉');assert.equal(count(s,'cobblestone'),stoneBefore-8);record('craft furnace',{furnace:count(s,'furnace_front'),cobblestoneBefore:stoneBefore,cobblestoneAfter:count(s,'cobblestone')});
    await page.keyboard.press('KeyE');await page.screenshot({path:path.join(OUT,'survival-furnace.png')});await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);fs.writeFileSync(path.join(OUT,'survival-evidence.json'),JSON.stringify(evidence,null,2));
  }catch(error){if(page)await page.screenshot({path:path.join(OUT,'survival-failure.png')}).catch(()=>{});throw error;}
  finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
