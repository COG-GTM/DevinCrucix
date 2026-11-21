import { readFileSync, statSync } from 'fs';

// Renders the Jarvis dashboard page (~1 MB) and caches it; the cache is rebuilt only when the
// template's mtime or size changes or getLocale() returns a different locale object.
export function createDashboardRenderer(htmlPath, getLocale) {
  let cache = null;
  return function renderDashboardHtml() {
    const { mtimeMs, size } = statSync(htmlPath);
    const locale = getLocale();
    if (cache && cache.mtimeMs === mtimeMs && cache.size === size && cache.locale === locale) return cache.html;

    let html = readFileSync(htmlPath, 'utf-8');

    // Never ship an inject.mjs seed in server mode; the page renders only live data.
    html = html.replace(/^let D = \{.*\};\s*$/m, 'let D = null;');

    // Inject locale data into the HTML
    const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${JSON.stringify(locale).replace(/<\/script>/gi, '<\\/script>')};</script>`;
    html = html.replace('</head>', `${localeScript}\n</head>`);

    cache = { mtimeMs, size, locale, html };
    return html;
  };
}
