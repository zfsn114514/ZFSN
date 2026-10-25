/* Safe, shared appearance settings. The classic layout is always the fallback. */
(function () {
  'use strict';
  var isPreview = new URLSearchParams(location.search).get('appearance-preview') === '1';
  var themes = ['classic','cyberpunk','nightcity','deepdive','eldenring'];
  function themeDefaults(theme) {
    if (theme === 'eldenring') return { theme: theme, accent: '#d8b46a', background: '#0a0805', motion: true };
    if (theme === 'deepdive') return { theme: theme, accent: '#ff6a63', background: '#100b10', motion: true };
    if (theme === 'nightcity') return { theme: theme, accent: '#ff4d5c', background: '#070d16', motion: true };
    return theme === 'cyberpunk'
      ? { theme: 'cyberpunk', accent: '#f3e600', background: '#080c12', motion: true }
      : { theme: 'classic', accent: '#ff2d4a', background: '#07070b', motion: true };
  }
  function defaults(theme) { return normalize(themeDefaults(theme)); }
  function normalize(value) {
    var result = themeDefaults(value && value.theme);
    if (value && /^#[0-9a-f]{6}$/i.test(value.accent || '')) result.accent = value.accent;
    if (value && /^#[0-9a-f]{6}$/i.test(value.background || '')) result.background = value.background;
    if (value && typeof value.motion === 'boolean') result.motion = value.motion;
    if(window.ZFSNSiteSettings) Object.assign(result, window.ZFSNSiteSettings.normalizeSite(value || {}));
    return result;
  }
  function syncBrand(){
    var theme = document.documentElement.dataset.theme || 'classic';
    var active = theme === 'nightcity' ? document.getElementById('nightcity-theme')
      : theme === 'deepdive' ? document.getElementById('deepdive-theme')
      : theme === 'eldenring' ? document.getElementById('eldenring-theme') : null;
    var ready = !active || !!active.sheet;
    document.querySelectorAll('.deepdive-logo').forEach(function(logo){logo.hidden = !ready || theme !== 'deepdive';});
    document.querySelectorAll('.nightcity-logo').forEach(function(logo){logo.hidden = !ready || theme !== 'nightcity';});
    document.querySelectorAll('.eldenring-logo').forEach(function(logo){logo.hidden = !ready || theme !== 'eldenring';});
    document.querySelectorAll('.name-text').forEach(function(label){label.hidden = ready && (theme === 'deepdive' || theme === 'nightcity' || theme === 'eldenring');});
    if (active && !ready) active.addEventListener('load', syncBrand, {once:true});
  }
  document.addEventListener('DOMContentLoaded',syncBrand);
  function apply(value) {
    var settings = normalize(value);
    var root = document.documentElement;
    var stylesheet = document.getElementById('cyberpunk-theme');
    if (!stylesheet) return;
    stylesheet.media = settings.theme === 'cyberpunk' ? 'all' : 'not all';
    var gameStylesheet = document.getElementById('nightcity-theme');
    if (gameStylesheet) gameStylesheet.media = settings.theme === 'nightcity' ? 'all' : 'not all';
    var deepStylesheet = document.getElementById('deepdive-theme');
    if (deepStylesheet) deepStylesheet.media = settings.theme === 'deepdive' ? 'all' : 'not all';
    var eldenStylesheet = document.getElementById('eldenring-theme');
    if (eldenStylesheet) eldenStylesheet.media = settings.theme === 'eldenring' ? 'all' : 'not all';
    root.dataset.theme = settings.theme;
    root.dataset.motion = settings.motion ? 'on' : 'off';
    root.style.setProperty('--bg', settings.background);
    root.style.setProperty('--c1', settings.accent);
    root.style.setProperty('--signal', settings.accent);
    if (settings.theme === 'classic') root.style.setProperty('--red', settings.accent);
    else root.style.removeProperty('--red');
    root.style.setProperty('--site-logo-size', settings.logoSize + 'px');
    root.style.setProperty('--site-avatar-size', settings.avatarSize + 'px');
    var backgroundImage = settings.backgroundImage;
    if (/^\/?(?:api\/)?media\//.test(backgroundImage) && window.ZFSN) backgroundImage = (window.ZFSN.getBase() || '') + '/' + backgroundImage.replace(/^\/+/, '');
    root.style.setProperty('--site-background-image', backgroundImage ? 'url("' + backgroundImage + '")' : 'none');
    root.dataset.customBackground = settings.backgroundImage ? 'on' : 'off';
    root.dataset.danmaku = settings.danmaku ? 'on' : 'off';
    document.querySelectorAll('.nav button[data-go] > span, .game-main-menu a[data-go] > span').forEach(function(label){
      var key = label.parentElement.dataset.go;
      if (settings.menu && settings.menu[key]) label.textContent = settings.menu[key];
    });
    syncBrand();
    document.dispatchEvent(new CustomEvent('zfsn:appearance', { detail: settings }));
  }
  var preferenceKey = 'zfsn_visitor_theme_v1';
  var preferred = null;
  try { preferred = localStorage.getItem(preferenceKey); } catch (_) {}
  if (!themes.includes(preferred)) preferred = null;
  var site = defaults('classic');
  function effective(){
    if (!preferred || isPreview) return site;
    var palette = themeDefaults(preferred);
    return Object.assign({}, site, {theme:palette.theme, accent:palette.accent, background:palette.background});
  }
  function setSite(value){ site = normalize(value); apply(effective()); }
  function chooseTheme(theme){
    if (theme !== null && !themes.includes(theme)) return;
    preferred = theme;
    try { if (theme) localStorage.setItem(preferenceKey,theme); else localStorage.removeItem(preferenceKey); } catch (_) {}
    apply(effective());
  }
  window.ZFSNAppearance = { defaults: defaults, normalize: normalize, apply: apply, isPreview: isPreview,
    setSite:setSite, chooseTheme:chooseTheme, preference:function(){return preferred;}, siteTheme:function(){return site.theme;} };
  if (!isPreview) {
    if (preferred) apply(effective());
    window.addEventListener('storage',function(event){
      if (event.key !== preferenceKey && event.key !== null) return;
      preferred = themes.includes(event.newValue) ? event.newValue : null;
      apply(effective());
    });
  }
  if (isPreview) {
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent || !event.data || event.data.type !== 'zfsn:appearance-preview') return;
      apply(event.data.settings);
    });
  }
})();
