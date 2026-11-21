// Dashboard page renderer: seed stripping, locale injection and the mtime/size/locale cache.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createDashboardRenderer } from '../lib/dashboard-html.mjs';

const TEMPLATE = '<html><head><title>x</title></head><body>\nlet D = {"seed":1};\n</body></html>';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'crucix-dash-'));
  const path = join(dir, 'jarvis.html');
  writeFileSync(path, TEMPLATE);
  return { dir, path };
}

test('strips the inject seed and injects the locale, escaping </script>', () => {
  const { dir, path } = setup();
  try {
    const render = createDashboardRenderer(path, () => ({ a: '</script>' }));
    const html = render();
    assert.match(html, /^let D = null;$/m);
    assert.ok(!html.includes('"seed"'));
    assert.ok(html.includes('<script>window.__CRUCIX_LOCALE__ = {"a":"<\\/script>"};</script>\n</head>'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('serves the cached page until the template or locale changes', () => {
  const { dir, path } = setup();
  try {
    let locale = { lang: 'en' };
    let localeCalls = 0;
    const render = createDashboardRenderer(path, () => { localeCalls++; return locale; });
    const first = render();
    assert.equal(render(), first);
    assert.equal(localeCalls, 2);

    writeFileSync(path, TEMPLATE.replace('<title>x</title>', '<title>changed</title>'));
    assert.ok(render().includes('<title>changed</title>'));

    const later = new Date(Date.now() + 5000);
    writeFileSync(path, TEMPLATE.replace('<title>x</title>', '<title>y</title>'));
    utimesSync(path, later, later);
    assert.ok(render().includes('<title>y</title>'));

    locale = { lang: 'fr' };
    assert.ok(render().includes('{"lang":"fr"}'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
