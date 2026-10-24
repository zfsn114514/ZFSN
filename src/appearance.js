export function appearanceDefaults(theme = 'classic') {
  return theme === 'cyberpunk'
    ? { theme, accent: '#f3e600', background: '#080c12', motion: true }
    : { theme: 'classic', accent: '#ff2d4a', background: '#07070b', motion: true };
}

export function validateAppearance(value) {
  if (!value || !['classic', 'cyberpunk'].includes(value.theme) ||
      !/^#[0-9a-f]{6}$/i.test(value.accent) || !/^#[0-9a-f]{6}$/i.test(value.background) ||
      typeof value.motion !== 'boolean') {
    throw new Error('请选择有效主题、六位颜色值和动效开关');
  }
  return { theme: value.theme, accent: value.accent.toLowerCase(), background: value.background.toLowerCase(), motion: value.motion };
}
