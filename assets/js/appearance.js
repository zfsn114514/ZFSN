/* Safe, shared appearance settings. The classic layout is always the fallback. */
(function () {
  'use strict';
  var isPreview = new URLSearchParams(location.search).get('appearance-preview') === '1';
  function themeDefaults(theme) {
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
  function apply(value) {
    var settings = normalize(value);
    var root = document.documentElement;
    var stylesheet = document.getElementById('cyberpunk-theme');
    if (!stylesheet) return;
    stylesheet.media = settings.theme === 'cyberpunk' ? 'all' : 'not all';
    var gameStylesheet = document.getElementById('nightcity-theme');
    if (gameStylesheet) gameStylesheet.media = settings.theme === 'nightcity' ? 'all' : 'not all';
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
    document.dispatchEvent(new CustomEvent('zfsn:appearance', { detail: settings }));
  }
  window.ZFSNAppearance = { defaults: defaults, normalize: normalize, apply: apply, isPreview: isPreview };
  if (isPreview) {
    window.addEventListener('message', function (event) {
      if (event.source !== window.parent || !event.data || event.data.type !== 'zfsn:appearance-preview') return;
      apply(event.data.settings);
    });
  }
})();
