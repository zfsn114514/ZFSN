/* Run with PLAYWRIGHT_MODULE pointing to an installed playwright-core package. */
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright-core');
const http=require('http'),fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),output=process.env.STUDIO_SCREENSHOTS||'/tmp/zfsn-studio';fs.mkdirSync(output,{recursive:true});
let settings={theme:'nightcity',accent:'#ff4d5c',background:'#070d16',motion:true};
let works=[{id:'aaaaaaaa',title:'植物大战老马',desc:'## 创作故事',images:['assets/avatar.jpg'],cover:'assets/avatar.jpg',tag:'游戏',files:[],order:0},{id:'bbbbbbbb',title:'夜之城摄影',desc:'城市记录',images:[],files:[],order:1}];
let postedOrder,uploadCount=0;
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp'};
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://local'),name=decodeURIComponent(url.pathname);
 if(name.startsWith('/api/')){
  let raw='';for await(const chunk of req)raw+=chunk;let body={};try{body=JSON.parse(raw)}catch{}
  let data={ok:true,items:[],count:0,has_content:false};
  if(name==='/api/health')data={ok:true};
  if(name==='/api/admin/check')data={ok:true,valid:true,exp:Date.now()+3600000};
  if(name==='/api/admin/stats')data={ok:true,messages:12,works:works.length,regions:[],sessions:1};
  if(name==='/api/works'&&req.method==='GET')data={ok:true,items:works};
  if(name==='/api/works'&&req.method==='POST'){const item={...body,id:'cccccccc'};works.push(item);data={ok:true,item};}
  if(name==='/api/admin/works/order'){postedOrder=body.ids;works.sort((a,b)=>postedOrder.indexOf(a.id)-postedOrder.indexOf(b.id));}
  if(name==='/api/appearance')data={ok:true,settings};
  if(name==='/api/admin/appearance'){settings=body;data={ok:true,settings};}
  if(name==='/api/upload'){uploadCount++;data={ok:true,files:[{path:'assets/avatar.jpg',name:'cover.jpg',size:2000}]};}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data));return;
 }
 const file=path.resolve(root,'.'+(name.endsWith('/')?name+'index.html':name));
 if(!file.startsWith(root+'/')||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end();}
 res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;let browser;try{
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('zfsn_admin_token','fixture-session'));
 await context.route('https://www.zfsnnb.dpdns.org/**',route=>route.fulfill({contentType:'application/json',body:'{"ok":true,"items":[]}'}));
 await page.goto(base+'/admin/');await page.waitForSelector('#app.on');
 await page.locator('[data-tab=work]').click();await page.waitForTimeout(450);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(output,'admin-dashboard.png')});await page.locator('#add-work').click();
 await page.locator('#w-title').fill('自动草稿测试');await page.locator('#w-desc').fill('## 草稿正文\n\n不会发布到前台。');
 await page.waitForFunction(()=>document.querySelector('#draft-status').textContent.includes('草稿已保存'));
 await page.locator('#w-cancel').click();await page.reload();await page.waitForSelector('#app.on');await page.locator('[data-tab=work]').click();
 await page.getByRole('button',{name:'继续编辑'}).first().click();assert.equal(await page.locator('#w-title').inputValue(),'自动草稿测试');
 assert((await page.locator('#w-desc').inputValue()).includes('草稿正文'));
 await page.locator('#w-file').setInputFiles({name:'fixture.jpg',mimeType:'image/jpeg',buffer:fs.readFileSync(path.join(root,'assets/avatar.jpg'))});
 await page.waitForSelector('.crop-thumb');await page.locator('.crop-thumb').first().click();await page.waitForFunction(()=>!document.querySelector('[data-crop=save]').disabled);
 await page.locator('[data-crop=zoom]').fill('1.5');await page.locator('[data-crop=save]').click();await page.waitForFunction(()=>!document.querySelector('.crop-dialog').open);
 assert.equal(uploadCount,2);assert.equal(await page.locator('#w-thumbs>.thumb').count(),2);
 await page.screenshot({path:path.join(output,'work-editor.png'),fullPage:true});
 await page.locator('#w-save').click();await page.waitForFunction(()=>document.querySelector('#work-form').classList.contains('hide'));
 assert(works.some(w=>w.title==='自动草稿测试'&&w.images.length===2));assert.equal(await page.getByRole('button',{name:'继续编辑'}).count(),0);
 await page.locator('#wlist>.it').nth(1).getByRole('button',{name:'↑',exact:true}).click();await page.locator('#work-order-save').click();await page.waitForFunction(()=>document.querySelector('#toast').textContent.includes('顺序已保存'));assert.equal(postedOrder[0],'bbbbbbbb');
 await page.locator('#wlist>.it').first().dragTo(page.locator('#wlist>.it').last());await page.locator('#work-order-save').click();await page.waitForTimeout(150);assert.notEqual(postedOrder[0],'bbbbbbbb');
 await page.locator('[data-tab=appearance]').click();await page.waitForFunction(()=>document.querySelector('#appearance-preview').getAttribute('src')!=='about:blank');
 await page.locator('#site-logo-size').fill('600');await page.locator('#site-avatar-size').fill('260');await page.locator('#site-menu-bili').fill('视频档案');await page.locator('#site-background-image').fill('assets/avatar.jpg');await page.locator('#site-danmaku').uncheck();
 await page.locator('#appearance-save').click();await page.waitForFunction(()=>document.querySelector('#appearance-status').textContent.includes('已保存'));
 assert.equal(settings.logoSize,600);assert.equal(settings.avatarSize,260);assert.equal(settings.menu.bili,'视频档案');assert.equal(settings.danmaku,false);
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(output,'site-settings.png')});
 await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(output,'admin-mobile.png')});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/');await page.waitForFunction(()=>document.documentElement.dataset.theme==='nightcity');
 assert.equal(await page.locator('.nav [data-go=bili]>span').textContent(),'视频档案');assert.equal(await page.locator('.avatar-stage').evaluate(el=>Math.round(el.getBoundingClientRect().width)),260);
 await page.locator('.game-main-menu [data-go=bili]').click();await page.waitForFunction(()=>document.body.dataset.page==='bili');
 await page.locator('.nav [data-go=steam]').click();await page.locator('.nav [data-go=guest]').click();await page.locator('.nav [data-go=works]').click();
 await page.waitForFunction(()=>document.body.dataset.page==='works'&&!document.body.dataset.switching);
 assert.equal(await page.locator('.page.active').count(),1);assert.equal(await page.locator('#wipe').evaluate(el=>getComputedStyle(el).pointerEvents),'none');
 await page.evaluate(()=>ZFSNAppearance.apply({...ZFSNAppearance.defaults('classic'),motion:false}));await page.locator('.nav [data-go=bili]').click();await page.waitForFunction(()=>document.body.dataset.page==='bili'&&!document.body.dataset.switching);assert.equal(await page.locator('#wipe').evaluate(el=>getComputedStyle(el).display),'none');
 // Visitor themes stay local, survive refresh and never replace owner settings.
 await page.locator('#visitor-theme-toggle').click();await page.locator('.vt-option[data-theme=classic]').click();
 assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'classic');
 assert.equal(await page.evaluate(()=>document.body.dataset.page),'bili');
 await page.reload();await page.waitForFunction(()=>window.ZFSN&&document.documentElement.dataset.theme==='classic');
 await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>ZFSNAppearance.preference()),'classic');
 assert.equal(await page.locator('.nav [data-go=bili]>span').textContent(),'视频档案');
 assert.equal(settings.theme,'nightcity');
 const peer=await page.context().newPage();await peer.goto(base+'/');await peer.waitForFunction(()=>window.ZFSN&&document.documentElement.dataset.theme==='classic');
 await peer.locator('#visitor-theme-toggle').click();await peer.locator('.vt-option[data-theme=cyberpunk]').click();
 await page.waitForFunction(()=>document.documentElement.dataset.theme==='cyberpunk');await peer.close();
 const preview=await page.context().newPage();await preview.goto(base+'/?appearance-preview=1');await preview.waitForFunction(()=>window.ZFSNAppearance);assert.equal(await preview.locator('#visitor-theme-toggle').count(),0);
 await preview.evaluate(()=>ZFSNAppearance.apply(ZFSNAppearance.defaults('nightcity')));assert.equal(await preview.evaluate(()=>document.documentElement.dataset.theme),'nightcity');await preview.close();
 await page.locator('#visitor-theme-toggle').click();await page.locator('.vt-option[data-theme=default]').click();
 assert.equal(await page.evaluate(()=>ZFSNAppearance.preference()),null);assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'nightcity');
 await page.setViewportSize({width:390,height:844});await page.locator('#visitor-theme-toggle').click();
 await page.waitForTimeout(100);const bounds=await page.locator('#visitor-theme-panel').boundingBox();assert(bounds.x>=0&&bounds.x+bounds.width<=390&&bounds.y>=0&&bounds.y+bounds.height<=844);
 await page.screenshot({path:path.join(output,'visitor-theme-mobile.png')});await page.keyboard.press('Escape');assert.equal(await page.locator('#visitor-theme-panel').evaluate(el=>el.open),false);
 await page.setViewportSize({width:1440,height:1000});await page.locator('#visitor-theme-toggle').click();await page.screenshot({path:path.join(output,'visitor-theme-desktop.png')});await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);console.log('PASS drafts survive reload; crop keeps originals; publish, ordering, site settings, mobile, rapid navigation and persistent visitor themes');
}finally{if(browser)await browser.close();server.close();}})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
