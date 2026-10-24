import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../assets/js/app.js', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../../admin/index.html', import.meta.url), 'utf8');
function extract(text, name) {
  const start = text.indexOf('function ' + name + '(');
  assert(start >= 0, name);
  const end = text.indexOf('\n  }', start);
  return text.slice(start, end + 4);
}

test('Worker media paths resolve for same-origin and remote APIs without duplicate declarations', () => {
  assert.equal((source.match(/function mediaUrl\(/g) || []).length, 1);
  const fn = extract(source, 'mediaUrl');
  for (const base of ['', 'https://www.zfsnnb.dpdns.org']) {
    const ctx = vm.createContext({ API_BASE: base });
    vm.runInContext(fn, ctx);
    for (const path of ['media/works/video/test.mp4', '/media/works/video/test.mp4', '\\media\\works\\video\\test.mp4', '/api/media/messages/abc/0.png']) {
      const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
      assert.equal(ctx.mediaUrl(path), base + '/' + normalized);
    }
    for (const path of ['https://cdn.example/x.mp4', '//cdn.example/x.png', 'data:image/png;base64,AA', 'blob:https://example/id', '']) {
      assert.equal(ctx.mediaUrl(path), path);
    }
  }
});

test('KV covers and gallery images use API host; checked-in images stay local', () => {
  const ctx = vm.createContext({ API_BASE: 'https://www.zfsnnb.dpdns.org', placeholder: () => 'placeholder' });
  vm.runInContext(extract(source, 'mediaUrl') + '\n' + extract(source, 'imgPath'), ctx);
  for (const path of ['media/works/image/a.png', '/media/works/image/a.png', '/api/media/messages/id/0.png']) {
    assert.equal(ctx.imgPath(path, 0), 'https://www.zfsnnb.dpdns.org/' + path.replace(/^\/+/, ''));
  }
  assert.equal(ctx.imgPath('assets/works/a.jpg', 0), 'assets/works/a.jpg');
  assert.equal(ctx.imgPath('D:\\ZFSNwebsite\\assets\\works\\a.jpg', 0), 'assets/works/a.jpg');
  assert.equal(ctx.imgPath('https://cdn.example/image.png', 0), 'https://cdn.example/image.png');
});

test('Admin previews resolve root-relative KV media and keep absolute URLs intact', () => {
  const start = admin.indexOf('function mUrl(');
  const fn = admin.slice(start, admin.indexOf('\n}', start) + 2);
  const ctx = vm.createContext({ API_BASE: 'https://www.zfsnnb.dpdns.org' });
  vm.runInContext(fn, ctx);
  assert.equal(ctx.mUrl('/media/works/a.png'), 'https://www.zfsnnb.dpdns.org/media/works/a.png');
  assert.equal(ctx.mUrl('media/works/a.mp4'), 'https://www.zfsnnb.dpdns.org/media/works/a.mp4');
  assert.equal(ctx.mUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png');
});

test('Bilibili observer appends only on the active page and never moves the viewport', () => {
  let callback, appended = 0;
  const marker = source.indexOf('  // 触底加载更多');
  const end = source.indexOf('  // 排序 / 搜索绑定', marker);
  const context = {
    current: 'home', vShown: 24, VID_VIEW: new Array(108),
    document: { createElement: () => ({ style: {} }) },
    vgrid: { parentNode: { appendChild() {} } },
    window: { IntersectionObserver: true },
    IntersectionObserver: function (cb) { callback = cb; this.observe = () => {}; },
    appendVideos: () => { appended++; }
  };
  vm.runInNewContext(source.slice(marker, end), context);
  callback([{ isIntersecting: true }]); assert.equal(appended, 0);
  context.current = 'bili'; callback([{ isIntersecting: false }]); assert.equal(appended, 0);
  callback([{ isIntersecting: true }]); assert.equal(appended, 1);
  context.vShown = 108; callback([{ isIntersecting: true }]); assert.equal(appended, 1);
});
