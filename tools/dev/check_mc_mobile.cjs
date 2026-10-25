/* Touch-input acceptance in Chromium device emulation; no user save is touched.
 * Set PLAYWRIGHT_MODULE to an installed playwright module, as in check_mc_survival.cjs.
 */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const URL=process.env.MC_URL||'http://localhost:88/minecraft/';
const OUT=path.resolve(process.env.MC_OUT||'.tmp-mc/acceptance');
const SAVE='zfsn.minecraft2d.v1';
(async()=>{
  fs.mkdirSync(OUT,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true});const results=[];
  try{
    for(const width of [375,390]){
      const context=await browser.newContext({viewport:{width,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
      const page=await context.newPage(),cdp=await context.newCDPSession(page),errors=[];page.on('pageerror',e=>errors.push(e.message));
      try{
        await page.goto(URL);await page.waitForTimeout(500);
        assert.equal(await page.locator('#continue').isVisible(),false,'fresh browser must not offer Continue without a save');
        await page.screenshot({path:path.join(OUT,`mobile-${width}-title.png`)});
        await page.locator('#seed').fill('1');await page.locator('#new-world button').tap();await page.waitForFunction(()=>!document.querySelector('#hud').hidden);await page.waitForTimeout(600);
        assert.equal(await page.locator('#touch-controls').isVisible(),true,'real coarse-pointer context must expose touch controls');
        async function snapshot(){await page.locator('#pause-button').tap();const s=await page.evaluate(key=>JSON.parse(localStorage.getItem(key)),SAVE);await page.locator('#resume').tap();await page.waitForTimeout(100);return s;}
        async function touchHold(selector,ms){const r=await page.locator(selector).boundingBox();assert.ok(r&&r.width>=44&&r.height>=44,'touch target must be at least 44px');
          const x=r.x+r.width/2,y=r.y+r.height/2;
          await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y,id:1}]});await page.waitForTimeout(ms);
          await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await page.waitForTimeout(300);
        }
        let s=await snapshot(),before=s.player.x;
        await touchHold('[data-hold="right"]',240);s=await snapshot();assert.ok(s.player.x>before+.3,`movement must change position: ${before} -> ${s.player.x}`);
        const movedX=s.player.x;
        const x=Math.floor(s.player.x+s.player.w/2),y=Math.floor(s.player.y+s.player.h+.05),tile=26;
        const cameraX=s.player.x+s.player.w/2-width/tile*.5,cameraY=s.player.y+s.player.h/2-844/tile*.47;
        await page.touchscreen.tap((x+.5-cameraX)*tile,(y+.5-cameraY)*tile);await page.waitForTimeout(200);
        const target=await page.locator('#target-label').textContent();assert.ok(target&&!target.includes('超出'),`touch must select a reachable block: ${target}`);
        await page.screenshot({path:path.join(OUT,`mobile-${width}-target.png`)});
        const dirtBefore=s.inventory.reduce((n,v)=>n+(v?.id==='dirt'?v.n:0),0);
        await touchHold('[data-hold="mine"]',1400);await page.waitForTimeout(500);s=await snapshot();
        const dirtAfter=s.inventory.reduce((n,v)=>n+(v?.id==='dirt'?v.n:0),0);
        assert.equal(s.blocks[y*384+x],0,'the touched block must really be gone');assert.ok(dirtAfter>dirtBefore,`mining must collect dirt: ${dirtBefore} -> ${dirtAfter}`);
        const layout=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth,controls:[...document.querySelectorAll('#touch-controls button')].map(b=>{const r=b.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})}));
        assert.ok(layout.scroll<=width,'no horizontal overflow');assert.ok(layout.controls.every(r=>r.x>=0&&r.x+r.width<=width&&r.y+r.height<=844),'all touch buttons must fit the screen');
        await page.locator('#inventory-button').tap();assert.ok(await page.locator('#slots .slot[aria-label*="泥土"]').count()>0);await page.screenshot({path:path.join(OUT,`mobile-${width}-inventory.png`)});await page.locator('#inventory-dialog [data-close]').tap();
        assert.deepEqual(errors,[]);const result={width,movement:{before,after:movedX},target,dirtBefore,dirtAfter,layout};results.push(result);console.log('PASS mobile',JSON.stringify(result));
      }catch(e){await page.screenshot({path:path.join(OUT,`mobile-${width}-failure.png`)}).catch(()=>{});throw e;}
      finally{await context.close();}
    }
    fs.writeFileSync(path.join(OUT,'mobile-evidence.json'),JSON.stringify(results,null,2));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
