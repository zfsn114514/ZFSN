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
  assert.deepEqual((await (await get()).json()).settings, { ...settings, accent: '#abcdef' });
  assert.equal((await save(appearanceDefaults('nightcity'), 'test-session')).status, 200);
  assert.equal((await (await get()).json()).settings.theme, 'nightcity');
  assert.equal((await save(appearanceDefaults(), 'test-session')).status, 200);
  assert.deepEqual((await (await get()).json()).settings, appearanceDefaults());
});
