import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import worker from '../../src/index.js';

const sources = ['assets/js/app.js', 'admin/index.html'];
for (const file of sources) {
  test(`${file}: local preview can reach Cloudflare; online stays same-origin`, () => {
    const source = fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
    const start = source.indexOf('function apiCandidates(){');
    const end = source.indexOf('\n  }', start) + 4;
    assert(start >= 0 && end > start);
    const fn = source.slice(start, end);
    for (const [href, expected] of [
      ['http://localhost:5500', ['', 'https://www.zfsnnb.dpdns.org']],
      ['http://192.168.0.100:88', ['', 'https://www.zfsnnb.dpdns.org']],
      ['http://192.168.0.100:89', ['']],
      ['http://127.0.0.1:8080', ['', 'https://www.zfsnnb.dpdns.org']],
      ['http://[::1]:8787', ['', 'https://www.zfsnnb.dpdns.org']],
      ['https://localhost:443', ['', 'https://www.zfsnnb.dpdns.org']],
      ['https://www.zfsnnb.dpdns.org', ['']],
      ['https://unrelated.example', ['']],
      ['file:///tmp/index.html', []]
    ]) {
      const actual = vm.runInNewContext(fn + ';apiCandidates()', { location: new URL(href) });
      assert.deepEqual(Array.from(actual), expected, href);
    }
  });
}

for (const origin of ['http://192.168.0.100:88', 'http://localhost:5500', 'http://127.0.0.1:8080', 'http://[::1]:8787', 'https://www.zfsnnb.dpdns.org']) {
  test(`CORS supports health, admin preflight and errors from ${origin}`, async () => {
    const url = 'https://www.zfsnnb.dpdns.org/api/health';
    const health = await worker.fetch(new Request(url, { headers: { Origin: origin } }), {}, {});
    assert.equal(health.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(health.headers.get('Access-Control-Allow-Credentials'), null);
    assert.equal((await health.json()).runtime, 'cloudflare-workers');
    const preflight = await worker.fetch(new Request(url.replace('health', 'admin/login'), {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-admin-token' }
    }), {}, {});
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Admin-Token/);
    assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /PUT, DELETE/);
    const error = await worker.fetch(new Request(url.replace('health', 'nonexistent'), { headers: { Origin: origin } }), {}, {});
    assert.equal(error.status, 404);
    assert.equal(error.headers.get('Access-Control-Allow-Origin'), origin);
    assert.match(error.headers.get('Vary'), /Origin/);
  });
}
for (const origin of ['https://evil.example', 'http://localhost.evil.example', 'null', 'file://', 'http://192.168.1.2:5500', 'http://192.168.0.100:89', 'https://192.168.0.100:88', 'http://192.168.0.100.evil.example:88']) {
  test(`CORS does not grant access to ${origin}`, async () => {
    const response = await worker.fetch(new Request('https://www.zfsnnb.dpdns.org/api/health', { method: 'OPTIONS', headers: { Origin: origin } }), {}, {});
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  });
}
