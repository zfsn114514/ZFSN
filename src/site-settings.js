// Shared by Worker and browser: typed, backward-compatible site settings.
export const siteDefaults = { logoSize: 470, avatarSize: 200, backgroundImage: '', danmaku: true,
  menu: { home: '首页', works: '作品', bili: 'B站', steam: '游戏', guest: '留言' } };
export function normalizeSite(value = {}, strict = false) {
  const result = { ...siteDefaults, menu: { ...siteDefaults.menu } };
  const bad = () => { throw new Error('站点设置格式错误'); };
  for (const [key, min, max] of [['logoSize',80,720],['avatarSize',64,320]]) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key]<min || value[key]>max) { if(strict)bad(); continue; }
    result[key]=value[key];
  }
  if (value.danmaku !== undefined) { if(typeof value.danmaku==='boolean')result.danmaku=value.danmaku;else if(strict)bad(); }
  if(value.backgroundImage !== undefined) {
    if(typeof value.backgroundImage !== 'string'){if(strict)bad();return result;}
    const url = value.backgroundImage;
    if(url.length<=800 && (!url || /^(?:https:\/\/[^\s"'()\\<>]+|\/?assets\/[a-zA-Z0-9_./%-]+|\/?(?:api\/)?media\/[a-zA-Z0-9_./%-]+)$/.test(url)) && !url.includes('..')) result.backgroundImage=url;
    else if(strict)bad();
  }
  if(value.menu !== undefined) {
    if(!value.menu || typeof value.menu!=='object' || Array.isArray(value.menu)){if(strict)bad();}
    else for(const key of Object.keys(result.menu)){
      if(value.menu[key]===undefined)continue;
      if(typeof value.menu[key]!=='string' || !value.menu[key].trim() || value.menu[key].length>16 || /[\x00-\x1f<>]/.test(value.menu[key])){if(strict)bad();continue;}
      result.menu[key]=value.menu[key].trim();
    }
  }
  return result;
}
