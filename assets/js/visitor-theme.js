(function(){
  'use strict';
  var appearance=window.ZFSNAppearance;
  if(!appearance||appearance.isPreview)return;
  var names={classic:'经典红黑',cyberpunk:'赛博朋克终端',nightcity:'2077 游戏主菜单'};
  var trigger=document.createElement('button');trigger.id='visitor-theme-toggle';trigger.type='button';
  trigger.innerHTML='<span aria-hidden="true">◈</span> 切换风格';trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls','visitor-theme-panel');
  var panel=document.createElement('dialog');panel.id='visitor-theme-panel';panel.setAttribute('aria-labelledby','visitor-theme-title');
  panel.innerHTML='<div class="vt-heading"><div><small>PERSONAL APPEARANCE</small><h2 id="visitor-theme-title">选择你的界面风格</h2></div><button type="button" class="vt-close" aria-label="关闭风格选择">×</button></div><p>只改变你在此浏览器中的显示，不影响其他访客。</p><div class="vt-options"></div><div class="vt-foot" role="status"></div>';
  var options=panel.querySelector('.vt-options');
  var choices=[{id:'default',title:'跟随站点默认',desc:'使用站长设置的主题与颜色'},
    {id:'classic',title:names.classic,desc:'居中布局 · 柔和圆角 · 红色高亮'},
    {id:'cyberpunk',title:names.cyberpunk,desc:'切角面板 · 黄色与青色 · 终端风格'},
    {id:'nightcity',title:names.nightcity,desc:'游戏主菜单 · 暗红侧栏 · 锋利标志'}];
  choices.forEach(function(choice){
    var button=document.createElement('button');button.type='button';button.className='vt-option';button.dataset.theme=choice.id;
    button.innerHTML='<span class="vt-swatch" aria-hidden="true"></span><span><strong></strong><small></small></span><span class="vt-check" aria-hidden="true">✓</span>';
    button.querySelector('strong').textContent=choice.title;button.querySelector('small').textContent=choice.desc;
    button.addEventListener('click',function(){appearance.chooseTheme(choice.id==='default'?null:choice.id);panel.close();trigger.focus();});options.append(button);
  });
  function render(){
    var chosen=appearance.preference()||'default';
    options.querySelectorAll('button').forEach(function(button){button.setAttribute('aria-pressed',String(button.dataset.theme===chosen));});
    panel.querySelector('.vt-foot').textContent='站点默认：'+names[appearance.siteTheme()]+' · 选择即时生效';
    trigger.setAttribute('aria-label','切换网页风格，当前'+(chosen==='default'?'跟随站点默认':names[chosen]));
  }
  trigger.addEventListener('click',function(){render();panel.showModal();panel.querySelector('[aria-pressed=true]').focus();});
  panel.querySelector('.vt-close').addEventListener('click',function(){panel.close();});
  panel.addEventListener('click',function(event){if(event.target!==panel)return;var r=panel.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)panel.close();});
  document.addEventListener('zfsn:appearance',render);
  document.body.append(trigger,panel);render();
})();
