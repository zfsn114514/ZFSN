/* Safe, shared appearance settings. The classic layout is always the fallback. */
(function () {
  'use strict';
  var isPreview = new URLSearchParams(location.search).get('appearance-preview') === '1';
  function defaults(theme) {
    return theme === 'cyberpunk'
      ? { theme: 'cyberpunk', accent: '#f3e600', background: '#080c12', motion: true }
      : { theme: 'classic', accent: '#ff2d4a', background: '#07070b', motion: true };
  }
  function normalize(value) {
    var result = defaults(value && value.theme);
    if (value && /^#[0-9a-f]{6}$/i.test(value.accent || '')) result.accent = value.accent;
    if (value && /^#[0-9a-f]{6}$/i.test(value.background || '')) result.background = value.background;
    if (value && typeof value.motion === 'boolean') result.motion = value.motion;
    return result;
  }
  function apply(value) {
    var settings = normalize(value);
    var root = document.documentElement;
    var stylesheet = document.getElementById('cyberpunk-theme');
    if (!stylesheet) return;
    stylesheet.media = settings.theme === 'cyberpunk' ? 'all' : 'not all';
    root.dataset.theme = settings.theme;
    root.dataset.motion = settings.motion ? 'on' : 'off';
    root.style.setProperty('--bg', settings.background);
    root.style.setProperty('--c1', settings.accent);
    root.style.setProperty('--signal', settings.accent);
    if (settings.theme === 'classic') root.style.setProperty('--red', settings.accent);
    else root.style.removeProperty('--red');
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
