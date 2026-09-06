// Keeps dashboard/public/jarvis.html's PANEL_CAPTIONS in step with the panel titles
// actually rendered, in both directions: a renamed/added panel without a caption fails,
// and a caption for a panel that no longer exists fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(here, '..', 'dashboard', 'public', 'jarvis.html'), 'utf8');

// Panels that deliberately carry no caption.
const NO_CAPTION = new Set(['how to read status']);

function normalizeTitle(raw) {
  return raw
    .replace(/\$\{shDot\([^}]*\)\}/g, '')
    .replace(/\$\{t\('[^']+','([^']+)'\)\}/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+—.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function renderedTitles() {
  const titles = new Set();
  for (const m of html.matchAll(/<h3>([\s\S]*?)<\/h3>/g)) {
    if (/\$\{title\}/.test(m[1])) continue; // offPanel template, titles collected below
    const t = normalizeTitle(m[1]);
    if (t && !t.includes('${')) titles.add(t);
  }
  for (const m of html.matchAll(/offPanel\('([^']+)'/g)) titles.add(normalizeTitle(m[1]));
  for (const m of html.matchAll(/offPanel\(t\('[^']+','([^']+)'\)/g)) titles.add(normalizeTitle(m[1]));
  return titles;
}

function captionKeys() {
  const block = html.match(/const PANEL_CAPTIONS=\{([\s\S]*?)\n\};/);
  assert.ok(block, 'PANEL_CAPTIONS block present');
  return new Set([...block[1].matchAll(/^\s+'([^']+)':/gm)].map(m => m[1]));
}

test('every rendered panel title has a caption (or is explicitly exempt)', () => {
  const titles = renderedTitles();
  const keys = captionKeys();
  const missing = [...titles].filter(t => !keys.has(t) && !NO_CAPTION.has(t));
  assert.deepEqual(missing, [], `panels without a caption: ${missing.join(', ')}`);
});

test('every caption key matches a rendered panel title', () => {
  const titles = renderedTitles();
  const keys = captionKeys();
  const stale = [...keys].filter(k => !titles.has(k));
  assert.deepEqual(stale, [], `captions for panels that are not rendered: ${stale.join(', ')}`);
});

test('control total: the panel set is what we expect', () => {
  const titles = renderedTitles();
  assert.equal(titles.size, 33, [...titles].sort().join(' | '));
});

test('map legend is derived from the layer registry, not a hand-typed list', () => {
  assert.doesNotMatch(html, /leg-item/, 'old static legend markup removed');
  assert.match(html, /D\.situation\?\.map\?\.layers/);
  assert.doesNotMatch(html, /toggleFlights/, 'flight toggle replaced by layer chips');
});
