// Dependency-free RSS 2.0 / Atom parser for public news and alert feeds.
// Returns plain-text fields (tags stripped, entities decoded). Callers must
// still HTML-escape before inserting into the dashboard.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// CDATA payloads are literal (no entity decoding); everything else is entity-encoded XML text.
function cdataInner(raw) {
  const v = String(raw || '').trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdata ? { text: cdata[1].trim(), cdata: true } : { text: v, cdata: false };
}

function tagText(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  if (!m) return '';
  const { text, cdata } = cdataInner(m[1]);
  return (cdata ? text : decodeEntities(text)).trim();
}

// Attribute values may be double- or single-quoted (Blogger emits single quotes).
function attr(xml, tag, name) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = xml.match(re);
  return m ? decodeEntities(m[1] ?? m[2]) : '';
}

function atomLink(entry) {
  return attr(entry, `link\\b(?=[^>]*rel=["']alternate["'])`, 'href') || attr(entry, 'link', 'href') || '';
}

function toIso(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function isNewsSitemap(xmlText) {
  return /<urlset[\s>]/i.test(String(xmlText || '')) && /<news:news[\s>]/i.test(String(xmlText || ''));
}

// Google News sitemap (<urlset> with <news:news> blocks): the publisher-advertised
// equivalent of a headline feed for sites that do not expose RSS/Atom. Items carry
// title, canonical URL and publication date only; keywords become categories.
export function parseNewsSitemap(xmlText) {
  const text = String(xmlText || '');
  const items = [];
  const re = /<url(?:\s[^>]*)?>([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const x = m[1];
    if (!/<news:news[\s>]/i.test(x)) continue;
    const loc = tagText(x, 'loc');
    items.push({
      title: stripTags(tagText(x, 'news:title')),
      link: loc,
      guid: loc,
      published: toIso(tagText(x, 'news:publication_date') || tagText(x, 'lastmod')),
      description: '',
      rawDescription: '',
      categories: [...x.matchAll(/<news:keywords>([\s\S]*?)<\/news:keywords>/gi)].map(k => stripTags(k[1])).filter(Boolean),
      publication: stripTags(tagText(x, 'news:name')) || null,
      language: tagText(x, 'news:language') || null,
    });
  }
  return items;
}

// Parse an RSS 2.0, Atom or Google News sitemap document into normalized items.
export function parseFeed(xmlText) {
  const text = String(xmlText || '');
  if (isNewsSitemap(text)) return parseNewsSitemap(text);
  const items = [];
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const re = isAtom ? /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi : /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const x = m[1];
    const rawDesc = isAtom ? (tagText(x, 'summary') || tagText(x, 'content')) : (tagText(x, 'description') || tagText(x, 'content:encoded'));
    items.push({
      title: stripTags(tagText(x, 'title')),
      link: isAtom ? atomLink(x) : (tagText(x, 'link') || attr(x, 'link', 'href')),
      guid: isAtom ? tagText(x, 'id') : tagText(x, 'guid'),
      published: toIso(isAtom ? (tagText(x, 'published') || tagText(x, 'updated')) : (tagText(x, 'pubDate') || tagText(x, 'dc:date'))),
      description: stripTags(rawDesc),
      rawDescription: rawDesc,
      categories: [...x.matchAll(/<category\b[^>]*(?:term=(?:"([^"]*)"|'([^']*)')[^>]*\/?>|>([\s\S]*?)<\/category>)/gi)]
        .map(c => stripTags(c[1] || c[2] || cdataInner(c[3]).text)).filter(Boolean),
    });
  }
  return items;
}

// Feed-level metadata (title, lastBuildDate/updated).
export function feedMeta(xmlText) {
  const text = String(xmlText || '');
  if (isNewsSitemap(text)) return { title: '', updated: null };
  const head = text.split(/<(?:item|entry)[\s>]/i)[0];
  return {
    title: stripTags(tagText(head, 'title')),
    updated: toIso(tagText(head, 'lastBuildDate') || tagText(head, 'updated') || tagText(head, 'pubDate')),
  };
}
