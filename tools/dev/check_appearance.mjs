import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/index.js';
import { appearanceDefaults, validateAppearance } from '../../src/appearance.js';

function database() {
  let saved = null;
  return { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() {
        if (sql.includes('FROM sessions')) return values[0] === 'test-session' ? { exp: Date.now() + 60000 } : null;
        if (sql.includes("k = 'appearance'")) return saved ? { v: saved } : null;
        throw new Error('unexpected query: ' + sql);
      },
      async run() {
        assert(sql.includes("VALUES ('appearance', ?)")); saved = values[0]; return { success: true };
      }
    };
  } };
}

test('appearance defaults to the original theme and accepts only safe typed settings', () => {
  assert.equal(appearanceDefaults().theme, 'classic');
  assert.equal(appearanceDefaults().accent, '#ff2d4a');
  assert.equal(validateAppearance(appearanceDefaults('nightcity')).theme, 'nightcity');
  assert.equal(validateAppearance(appearanceDefaults('deepdive')).theme, 'deepdive');
  assert.equal(validateAppearance(appearanceDefaults('eldenring')).theme, 'eldenring');
  assert.equal(appearanceDefaults('eldenring').accent, '#d8b46a');
  assert.equal(appearanceDefaults('eldenring').background, '#0a0805');
  for (const value of [null, {}, { theme: 'custom-css', accent: '#fff000', background: '#000000', motion: true }, { theme: 'classic', accent: 'red;display:none', background: '#000000', motion: true }, { theme: 'classic', accent: '#ffffff', background: '#000000', motion: 'true' }]) {
    assert.throws(() => validateAppearance(value));
  }
});

test('public appearance reading, authenticated updates, validation and restoration', async () => {
  const env = { DB: database(), TZ_OFFSET: 8 };
  const get = () => worker.fetch(new Request('https://www.zfsnnb.dpdns.org/api/appearance'), env, {});
  const save = (settings, token) => worker.fetch(new Request('https://www.zfsnnb.dpdns.org/api/admin/appearance', {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { 'X-Admin-Token': token } : {}) }, body: JSON.stringify(settings)
  }), env, {});
  assert.deepEqual((await (await get()).json()).settings, appearanceDefaults());
  assert.equal((await save(appearanceDefaults())).status, 401);
  assert.equal((await save({ theme: 'classic', accent: 'url(javascript:evil)' }, 'test-session')).status, 400);
  assert.deepEqual((await (await get()).json()).settings, appearanceDefaults());
  const settings = { theme: 'cyberpunk', accent: '#ABCDEF', background: '#010203', motion: false };
  assert.equal((await save(settings, 'test-session')).status, 200);
  assert.deepEqual((await (await get()).json()).settings, validateAppearance(settings));
  assert.equal((await save(appearanceDefaults('nightcity'), 'test-session')).status, 200);
  assert.equal((await (await get()).json()).settings.theme, 'nightcity');
  assert.equal((await save(appearanceDefaults('deepdive'), 'test-session')).status, 200);
  assert.equal((await (await get()).json()).settings.theme, 'deepdive');
  assert.equal((await save(appearanceDefaults('eldenring'), 'test-session')).status, 200);
  assert.equal((await (await get()).json()).settings.theme, 'eldenring');
  assert.equal((await save(appearanceDefaults(), 'test-session')).status, 200);
  assert.deepEqual((await (await get()).json()).settings, appearanceDefaults());
});

test('site settings roundtrip and reject unsafe or out-of-range values', () => {
  const settings = { ...appearanceDefaults('nightcity'), logoSize: 620, avatarSize: 280, backgroundImage: 'assets/avatar.jpg', danmaku: false, menu: { home: '入口', works: '作品档案', bili: '投稿', steam: '游戏库', guest: '通讯' } };
  assert.deepEqual(validateAppearance(settings), settings);
  for (const patch of [{logoSize:721},{avatarSize:1},{danmaku:'true'},{backgroundImage:'javascript:alert(1)'},{backgroundImage:'https://x/evil")'},{menu:{home:'<script>'}}]) assert.throws(()=>validateAppearance({...settings,...patch}));
});

test('browser and Worker use identical site setting validation',()=>{
 const source=readFileSync(new URL('../../src/site-settings.js',import.meta.url),'utf8').replace('export const siteDefaults','const siteDefaults').replace('export function normalizeSite','function normalizeSite');
 assert.equal(readFileSync(new URL('../../assets/js/site-settings-browser.js',import.meta.url),'utf8'),'(function(){\n'+source+'\nwindow.ZFSNSiteSettings={normalizeSite,siteDefaults};\n})();\n');
});
