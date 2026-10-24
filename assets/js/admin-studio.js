/* Work publishing helpers; unpublished drafts stay in this browser. */
window.ZFSNAdminStudio = function(ctx){
  'use strict';
  const $=s=>document.querySelector(s), form=$('#work-form');
  let timer, opening=false, dirty=false, key='', orderDirty=false;
  const status=$('#draft-status');
  const storageKey=()=> 'zfsn_work_drafts_v1:'+ctx.namespace();
  function drafts(){try{const data=JSON.parse(localStorage.getItem(storageKey())||'{}');if(!data||typeof data!=='object'||Array.isArray(data))return {};const safe={};Object.keys(data).forEach(id=>{try{validDraft({item:data[id].item});if(Number.isFinite(data[id].time))safe[id]=data[id];}catch{}});return safe;}catch{return {};}}
  function write(value){localStorage.setItem(storageKey(),JSON.stringify(value));}
  function visible(){return !form.classList.contains('hide');}
  function saveDraft(){
    clearTimeout(timer);
    if(!visible()||opening)return;
    const item=ctx.read();
    if(!item.title&&!item.desc&&!item.images.length&&!item.video&&!item.files.length)return;
    if(!key)key=item.id||'new-'+Date.now()+'-'+Math.random().toString(16).slice(2,8);
    try {const list=drafts();list[key]={item:item,time:Date.now()};write(list);dirty=false;status.textContent='草稿已保存 · '+new Date().toLocaleTimeString();renderDrafts();}
    catch(e){dirty=true;status.textContent='草稿保存失败，请导出备份：'+e.message;}
  }
  function changed(){if(opening||!visible())return;dirty=true;status.textContent='正在保存草稿…';clearTimeout(timer);timer=setTimeout(saveDraft,600);}
  function renderDrafts(){
    const box=$('#work-drafts');box.replaceChildren();
    const list=drafts();
    Object.keys(list).sort((a,b)=>list[b].time-list[a].time).forEach(id=>{
      const row=document.createElement('div');row.className='draft-item';
      const title=document.createElement('span');title.textContent=(list[id].item.title||'未命名作品')+' · '+new Date(list[id].time).toLocaleString();
      const restore=document.createElement('button');restore.className='btn sm';restore.textContent='继续编辑';
      restore.onclick=()=>{ctx.open(list[id].item);key=id;status.textContent='已恢复本地草稿；点击发布后才会更新网站。';};
      const remove=document.createElement('button');remove.className='btn sm';remove.textContent='删除草稿';
      remove.onclick=()=>{const current=drafts();delete current[id];try{write(current);if(key===id)key='';renderDrafts();}catch(e){ctx.toast(e.message,'bad');}};
      row.append(title,restore,remove);box.append(row);
    });
    if(!box.childElementCount)box.textContent='暂无草稿，开始编辑后自动保存。';
  }
  form.addEventListener('input',changed);
  $('#draft-save').onclick=saveDraft;
  $('.tabs button[data-tab=work]').addEventListener('click',renderDrafts);
  $('#draft-export').onclick=()=>{
    saveDraft();const blob=new Blob([JSON.stringify({version:1,item:ctx.read()},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='ZFSN-work-draft-'+Date.now()+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  function validDraft(value){
    const item=value&&value.item;if(!item||typeof item!=='object')throw new Error('不是有效作品草稿');
    for(const [name,max] of [['title',60],['tag',24],['desc',50000],['link',500]])if(typeof item[name]!=='string'||item[name].length>max)throw new Error('草稿字段无效：'+name);
    const safe=p=>typeof p==='string'&&p.length<=800&&/^(https?:\/\/|\/?(?:assets|media|api\/media)\/)/i.test(p)&&!/[<>\x00-\x1f]/.test(p);
    if(!Array.isArray(item.images)||item.images.length>30||!item.images.every(safe)||!Array.isArray(item.files)||item.files.length>10||!item.files.every(f=>f&&safe(f.path)&&typeof f.name==='string'))throw new Error('草稿媒体路径无效');
    if(item.video&&!safe(item.video)||item.cover&&!safe(item.cover))throw new Error('草稿封面或视频路径无效');
    if(item.id&&!/^[a-f0-9]{8,32}$/.test(item.id))throw new Error('草稿作品编号无效');
    return item;
  }
  $('#draft-import').onchange=async function(){try{const file=this.files[0];if(!file)return;if(file.size>200000)throw new Error('草稿文件不能超过 200KB');const item=validDraft(JSON.parse(await file.text()));ctx.open(item);changed();saveDraft();ctx.toast('草稿已导入，尚未发布','ok');}catch(e){ctx.toast(e.message,'bad');}finally{this.value='';}};
  window.addEventListener('beforeunload',e=>{if(dirty)saveDraft();if(dirty||orderDirty){e.preventDefault();e.returnValue='';}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&dirty)saveDraft();});

  // Explicit save after ordering; existing records and interaction IDs are retained.
  const list=$('#wlist'),orderButton=$('#work-order-save');let moving;
  function markOrder(){orderDirty=true;orderButton.disabled=false;}
  function decorateWorks(){
    Array.from(list.children).forEach((row,index)=>{
      if(!row.classList.contains('it')||row.dataset.studio)return;
      row.dataset.studio='1';row.dataset.workId=row.querySelector('[data-edit]')?.dataset.edit;row.draggable=true;
      const actions=row.querySelector('.act');if(!actions)return;
      for(const [label,direction] of [['↑',-1],['↓',1]]){const button=document.createElement('button');button.type='button';button.className='btn sm';button.textContent=label;button.title=direction<0?'上移作品':'下移作品';button.onclick=()=>{const target=direction<0?row.previousElementSibling:row.nextElementSibling;if(!target)return;list.insertBefore(row,direction<0?target:target.nextElementSibling);markOrder();};actions.prepend(button);}
      row.addEventListener('dragstart',e=>{moving=row;e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',row.dataset.workId);row.classList.add('dragging');});
      row.addEventListener('dragend',()=>{moving=null;row.classList.remove('dragging');});
      row.addEventListener('dragover',e=>{if(moving&&moving!==row){e.preventDefault();e.dataTransfer.dropEffect='move';}});
      row.addEventListener('drop',e=>{if(!moving||moving===row)return;e.preventDefault();const after=e.clientY>row.getBoundingClientRect().top+row.offsetHeight/2;list.insertBefore(moving,after?row.nextSibling:row);markOrder();});
    });
  }
  new MutationObserver(decorateWorks).observe(list,{childList:true});decorateWorks();
  orderButton.onclick=async()=>{orderButton.disabled=true;try{const ids=Array.from(list.children).map(x=>x.dataset.workId).filter(Boolean);await ctx.api('/api/admin/works/order',{method:'POST',body:JSON.stringify({ids})});orderDirty=false;ctx.toast('作品顺序已保存','ok');await ctx.refresh();}catch(e){orderButton.disabled=false;ctx.toast(e.message,'bad');}};

  // Album drag ordering and a non-destructive crop (the original image remains).
  const thumbs=$('#w-thumbs');let imageMoving=-1;
  function decorateImages(){Array.from(thumbs.children).forEach((thumb,index)=>{
    if(thumb.dataset.studio)return;thumb.dataset.studio='1';thumb.draggable=true;
    const crop=document.createElement('button');crop.type='button';crop.className='crop-thumb';crop.textContent='裁剪封面';crop.onclick=e=>{e.stopPropagation();openCrop(index);};thumb.append(crop);
    thumb.ondragstart=e=>{imageMoving=index;e.dataTransfer.setData('text/plain',String(index));e.dataTransfer.effectAllowed='move';};
    thumb.ondragover=e=>{if(imageMoving>=0)e.preventDefault();};
    thumb.ondrop=e=>{if(imageMoving<0)return;e.preventDefault();e.stopPropagation();const images=ctx.read().images;const [image]=images.splice(imageMoving,1);images.splice(index,0,image);imageMoving=-1;ctx.setImages(images);};thumb.ondragend=()=>imageMoving=-1;
  });}
  new MutationObserver(decorateImages).observe(thumbs,{childList:true});decorateImages();
  const dialog=document.createElement('dialog');dialog.className='crop-dialog';dialog.setAttribute('aria-label','裁剪封面');
  dialog.innerHTML='<h2>裁剪封面</h2><p>调整构图后生成新封面，原图保留在相册中。</p><canvas width="960" height="540"></canvas><div class="crop-controls"><label>比例<select data-crop="ratio"><option value="1.7777778">16 : 9 横版</option><option value="1">1 : 1 方形</option><option value="0.75">3 : 4 竖版</option></select></label><label>缩放<input data-crop="zoom" type="range" min="1" max="3" step="0.01" value="1"></label><label>水平位置<input data-crop="x" type="range" min="-100" max="100" value="0"></label><label>垂直位置<input data-crop="y" type="range" min="-100" max="100" value="0"></label></div><div class="frow"><button class="btn primary" data-crop="save">生成并上传封面</button><button class="btn" data-crop="cancel">取消</button><span role="status" data-crop="status"></span></div>';
  document.body.append(dialog);const find=name=>dialog.querySelector('[data-crop='+name+']'),canvas=dialog.querySelector('canvas');let source,cropBusy=false;
  function draw(){if(!source)return;const ratio=Number(find('ratio').value);canvas.height=Math.round(960/ratio);const scale=Math.max(canvas.width/source.width,canvas.height/source.height)*Number(find('zoom').value);const width=source.width*scale,height=source.height*scale;const x=(canvas.width-width)/2-(width-canvas.width)*Number(find('x').value)/200,y=(canvas.height-height)/2-(height-canvas.height)*Number(find('y').value)/200;const g=canvas.getContext('2d');g.clearRect(0,0,canvas.width,canvas.height);g.drawImage(source,x,y,width,height);}
  async function openCrop(index){
    if(ctx.read().images.length>=30){ctx.toast('相册已满，请先移除一张图片','bad');return;}
    dialog.showModal();source=null;find('status').textContent='加载原图…';find('save').disabled=true;
    find('zoom').value='1';find('x').value=find('y').value='0';
    const image=new Image();image.crossOrigin='anonymous';image.onload=()=>{source=image;draw();find('save').disabled=false;find('status').textContent='';};image.onerror=()=>{find('status').textContent='原图加载失败，请检查图片地址或跨域配置。';};image.src=ctx.url(ctx.read().images[index]);
  }
  dialog.querySelectorAll('input,select').forEach(input=>input.oninput=draw);
  find('cancel').onclick=()=>{if(!cropBusy)dialog.close();};dialog.addEventListener('cancel',e=>{if(cropBusy)e.preventDefault();});
  find('save').onclick=async()=>{if(!source||cropBusy)return;cropBusy=true;find('save').disabled=find('cancel').disabled=true;find('status').textContent='正在生成并上传…';try{const blob=await new Promise((resolve,reject)=>{try{canvas.toBlob(b=>b?resolve(b):reject(new Error('生成封面失败')),'image/jpeg',.9);}catch(e){reject(e);}});const result=await ctx.upload(new File([blob],'cover-crop-'+Date.now()+'.jpg',{type:'image/jpeg'}));const path=result?.files?.[0]?.path;if(!path)throw new Error('后端没有返回封面地址');ctx.setImages([path,...ctx.read().images]);saveDraft();dialog.close();ctx.toast('新封面已生成，原图已保留','ok');}catch(e){find('status').textContent='失败：'+e.message;}finally{cropBusy=false;find('save').disabled=find('cancel').disabled=false;}};

  const theme=$('#console-theme');let savedTheme;try{savedTheme=localStorage.getItem('zfsn_console_theme');}catch{}
  theme.value=['classic','cyberpunk','nightcity'].includes(savedTheme)?savedTheme:'nightcity';
  function applyTheme(){document.documentElement.dataset.consoleTheme=theme.value;try{localStorage.setItem('zfsn_console_theme',theme.value);}catch{}}
  theme.onchange=applyTheme;applyTheme();renderDrafts();
  return {changed,saveDraft,renderDrafts,beforeOpen(){saveDraft();opening=true;clearTimeout(timer);},opened(){opening=false;dirty=false;key=ctx.read().id||'';status.textContent='修改后自动保存草稿；发布前可继续调整。';},published(){clearTimeout(timer);try{const list=drafts();delete list[key];write(list);}catch{}dirty=false;key='';renderDrafts();}};
};
