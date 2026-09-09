// Article text-of-record extraction for the Border Watch slice. Dependency-free and
// deliberately conservative: it keeps the publisher's paragraphs verbatim (no
// summarising), drops obvious page furniture, and reports HOW the text was obtained
// so provenance is explicit. Paywalled pages are detected, never bypassed.

import { decodeEntities } from './rss.mjs';

const BLOCK_TAGS = 'p|div|br|li|h[1-6]|blockquote|section|article|figcaption|tr';
const BOILERPLATE = /^(sign up|subscribe|read more|related|advertisement|share this|email this|copyright|©|all rights reserved|click here|follow us|download the|watch:|photo:|credit:|the texas tribune thanks|disclosure:|this article originally appeared|correction:)/i;
const PAYWALL_MARKERS = /(subscribe to (continue|read|keep reading)|subscribers? only|this (article|story|content) is (for|available to) (paid )?subscribers|already a subscriber|unlock this (article|story)|start your (free )?trial to (read|continue)|you have reached your (article|free) limit)/i;

// Convert an HTML fragment (e.g. WordPress `content.rendered`) to paragraph text.
export function htmlToText(html) {
  let s = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|form|button|nav|aside|footer|header)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  return s.split(/\n+/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

// Paragraphs that look like body copy rather than navigation or promo furniture.
export function bodyParagraphs(text, { minLen = 40 } = {}) {
  return String(text || '').split('\n')
    .map(l => l.trim())
    .filter(l => l.length >= minLen && !BOILERPLATE.test(l) && /[.!?…"”]$|[a-z]\)?$/i.test(l));
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const list = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
      for (const node of list) if (node && typeof node === 'object') out.push(node);
    } catch { /* ignore malformed blocks */ }
  }
  return out;
}

function firstAttr(html, re) {
  const m = re.exec(html);
  return m ? decodeEntities(m[1]).trim() : '';
}

export function canonicalUrlFrom(html) {
  return firstAttr(html, /<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i)
    || firstAttr(html, /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']canonical["']/i)
    || firstAttr(html, /<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
}

// CMS body containers (Blogger `post-body`, WordPress `entry-content`, schema.org articleBody).
// These are <div>s, so the slice is closed by depth-counting rather than a lazy regex.
const BODY_CONTAINER_OPEN = /<(div|section)\b[^>]*(?:class=["'][^"']*\b(?:post-body|entry-content|article-body|story-body|articleBody)\b[^"']*["']|itemprop=["']articleBody["'])[^>]*>/i;

export function bodyContainer(html) {
  const src = String(html || '');
  const open = BODY_CONTAINER_OPEN.exec(src);
  if (!open) return '';
  const tag = open[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = open.index + open[0].length;
  let depth = 1;
  let m;
  while ((m = re.exec(src)) !== null) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return src.slice(open.index, m.index + m[0].length);
  }
  return '';
}

// Returns { text, title, canonical, paywalled, method, paragraphs }
export function extractArticle(html) {
  const src = String(html || '');
  const ld = jsonLdBlocks(src);
  const article = ld.find(n => /Article$/i.test(String(n['@type'] || '')) || (Array.isArray(n['@type']) && n['@type'].some(t => /Article$/i.test(t))));
  const notFree = article && (article.isAccessibleForFree === false || article.isAccessibleForFree === 'False');
  const canonical = canonicalUrlFrom(src) || (article?.mainEntityOfPage?.['@id'] || article?.url || '');
  const title = firstAttr(src, /<meta\b[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || (article?.headline ? String(article.headline) : '')
    || decodeEntities(firstAttr(src, /<title[^>]*>([\s\S]*?)<\/title>/i));

  if (article?.articleBody && String(article.articleBody).trim().length > 200) {
    const paragraphs = bodyParagraphs(String(article.articleBody).replace(/\s*\n\s*/g, '\n'), { minLen: 1 });
    return { text: paragraphs.join('\n\n'), title, canonical, paywalled: Boolean(notFree), method: 'jsonld', paragraphs: paragraphs.length };
  }

  const articleTag = /<article\b[\s\S]*?<\/article>/i.exec(src)?.[0];
  const bodyDiv = articleTag ? '' : bodyContainer(src);
  const container = articleTag
    || bodyDiv
    || /<main\b[\s\S]*?<\/main>/i.exec(src)?.[0]
    || /<body\b[\s\S]*<\/body>/i.exec(src)?.[0]
    || src;
  const paragraphs = bodyParagraphs(htmlToText(container));
  const text = paragraphs.join('\n\n');
  const paywalled = Boolean(notFree) || (text.length < 600 && PAYWALL_MARKERS.test(htmlToText(src)));
  const method = articleTag ? 'article-tag' : bodyDiv ? 'body-container' : 'paragraphs';
  return { text, title, canonical, paywalled, method, paragraphs: paragraphs.length };
}
