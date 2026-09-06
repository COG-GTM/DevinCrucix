"""Feed parsers: RSS 2.0, Atom, Google News sitemaps, and WordPress REST API.

Every parser returns a list of :class:`FeedItem` with identical shape so the
poller does not care how an outlet publishes.
"""

from __future__ import annotations

import html
import json
import re
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

MAX_TITLE_LEN = 512
MAX_SUMMARY_LEN = 4000
MAX_ITEMS = 500

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "content": "http://purl.org/rss/1.0/modules/content/",
    "dc": "http://purl.org/dc/elements/1.1/",
    "sm": "http://www.sitemaps.org/schemas/sitemap/0.9",
    "news": "http://www.google.com/schemas/sitemap-news/0.9",
    "media": "http://search.yahoo.com/mrss/",
}

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_DOCTYPE_RE = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)


class FeedParseError(ValueError):
    pass


@dataclass
class FeedItem:
    url: str
    title: str
    guid: str | None = None
    summary: str = ""
    published_at: str | None = None  # ISO-8601 UTC
    updated_at: str | None = None
    content_html: str | None = None  # full content when the feed/API carries it
    language: str | None = None
    categories: list[str] = field(default_factory=list)
    publisher_tags: list[str] = field(default_factory=list)
    author: str | None = None


def strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = _TAG_RE.sub(" ", value)
    text = html.unescape(text)
    return _WS_RE.sub(" ", text).strip()


def parse_datetime(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        dt = None
    if dt is None:
        candidate = value.replace("Z", "+00:00")
        try:
            dt = datetime.fromisoformat(candidate)
        except ValueError:
            m = re.match(r"^(\d{4}-\d{2}-\d{2})$", candidate)
            if not m:
                return None
            dt = datetime.fromisoformat(candidate + "T00:00:00+00:00")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def _clean_title(value: str | None) -> str:
    return strip_html(value)[:MAX_TITLE_LEN]


def _clean_summary(value: str | None) -> str:
    return strip_html(value)[:MAX_SUMMARY_LEN]


def _safe_xml_root(body: bytes) -> ET.Element:
    if _DOCTYPE_RE.search(body[:4096]):
        raise FeedParseError("XML with DOCTYPE/ENTITY declarations is rejected")
    try:
        return ET.fromstring(body)
    except ET.ParseError as e:
        raise FeedParseError(f"XML parse error: {e}") from e


def _text(el: ET.Element | None) -> str | None:
    if el is None:
        return None
    return (el.text or "").strip() or None


def detect_feed_type(body: bytes, content_type: str = "") -> str:
    head = body[:2048].lstrip().lower()
    if head.startswith(b"{") or head.startswith(b"["):
        return "wp_api"
    if b"<feed" in head and b"http://www.w3.org/2005/atom" in head:
        return "atom"
    if b"<urlset" in head:
        return "news_sitemap"
    if b"<rss" in head or b"<rdf:rdf" in head:
        return "rss"
    if "json" in content_type:
        return "wp_api"
    return "rss"


def parse_feed(body: bytes, feed_type: str, base_url: str = "") -> list[FeedItem]:
    if feed_type == "rss":
        return parse_rss(body)
    if feed_type == "atom":
        return parse_atom(body)
    if feed_type == "news_sitemap":
        return parse_news_sitemap(body)
    if feed_type == "wp_api":
        return parse_wp_api(body)
    raise FeedParseError(f"Unsupported feed type: {feed_type}")


def parse_rss(body: bytes) -> list[FeedItem]:
    root = _safe_xml_root(body)
    if root.tag.lower().endswith("feed"):
        return parse_atom(body)
    channel = root.find("channel")
    if channel is None:
        raise FeedParseError("RSS document has no <channel>")
    lang = _text(channel.find("language"))
    items: list[FeedItem] = []
    for it in channel.findall("item")[:MAX_ITEMS]:
        link = _text(it.find("link"))
        guid_el = it.find("guid")
        guid = _text(guid_el)
        is_permalink = guid_el is not None and guid_el.get("isPermaLink", "true").lower() != "false"
        if not link and guid and is_permalink and guid.startswith("http"):
            link = guid
        title = _clean_title(_text(it.find("title")))
        if not link or not title:
            continue
        content_encoded = _text(it.find("content:encoded", NS))
        items.append(
            FeedItem(
                url=link,
                title=title,
                guid=guid,
                summary=_clean_summary(_text(it.find("description"))),
                published_at=parse_datetime(_text(it.find("pubDate")) or _text(it.find("dc:date", NS))),
                content_html=content_encoded,
                language=lang[:8] if lang else None,
                categories=[c for c in (_text(x) for x in it.findall("category")) if c][:20],
                author=_text(it.find("dc:creator", NS)) or _text(it.find("author")),
            )
        )
    return items


def parse_atom(body: bytes) -> list[FeedItem]:
    root = _safe_xml_root(body)
    ns = {"a": NS["atom"]}
    lang = root.get("{http://www.w3.org/XML/1998/namespace}lang")
    items: list[FeedItem] = []
    for entry in root.findall("a:entry", ns)[:MAX_ITEMS]:
        link = None
        for link_el in entry.findall("a:link", ns):
            rel = link_el.get("rel", "alternate")
            if rel == "alternate" and link_el.get("href"):
                link = link_el.get("href")
                if (link_el.get("type") or "").startswith("text/html"):
                    break
        title = _clean_title(_text(entry.find("a:title", ns)))
        if not link or not title:
            continue
        content_el = entry.find("a:content", ns)
        content_html = None
        if content_el is not None:
            content_html = content_el.text or "".join(ET.tostring(c, encoding="unicode") for c in content_el)
        author_el = entry.find("a:author/a:name", ns)
        items.append(
            FeedItem(
                url=link,
                title=title,
                guid=_text(entry.find("a:id", ns)),
                summary=_clean_summary(_text(entry.find("a:summary", ns)) or content_html),
                published_at=parse_datetime(_text(entry.find("a:published", ns)) or _text(entry.find("a:updated", ns))),
                updated_at=parse_datetime(_text(entry.find("a:updated", ns))),
                content_html=content_html,
                language=lang[:8] if lang else None,
                categories=[term for term in (c.get("term") for c in entry.findall("a:category", ns)) if term][:20],
                author=_text(author_el),
            )
        )
    return items


MAX_CHILD_SITEMAPS = 3


def is_sitemap_index(body: bytes) -> bool:
    return b"<sitemapindex" in body[:2048].lstrip().lower()


def parse_sitemap_index(body: bytes, base_url: str) -> list[str]:
    """Child sitemap URLs of a ``<sitemapindex>``, newest ``lastmod`` first, same host as the index only."""
    root = _safe_xml_root(body)
    host = urlsplit(base_url).netloc.lower()
    children: list[tuple[str, str]] = []
    for sm in root.findall("sm:sitemap", NS):
        loc = _text(sm.find("sm:loc", NS))
        if not loc or not loc.startswith(("http://", "https://")) or urlsplit(loc).netloc.lower() != host:
            continue
        children.append((_text(sm.find("sm:lastmod", NS)) or "", loc[:2048]))
    children.sort(key=lambda c: c[0], reverse=True)
    return [loc for _, loc in children[:MAX_CHILD_SITEMAPS]]


def parse_news_sitemap(body: bytes) -> list[FeedItem]:
    root = _safe_xml_root(body)
    items: list[FeedItem] = []
    for url_el in root.findall("sm:url", NS)[:MAX_ITEMS]:
        loc = _text(url_el.find("sm:loc", NS))
        news = url_el.find("news:news", NS)
        if not loc or news is None:
            continue
        title = _clean_title(_text(news.find("news:title", NS)))
        if not title:
            continue
        pub = news.find("news:publication", NS)
        lang = _text(pub.find("news:language", NS)) if pub is not None else None
        keywords = _text(news.find("news:keywords", NS)) or ""
        items.append(
            FeedItem(
                url=loc,
                title=title,
                guid=loc,
                summary="",
                published_at=parse_datetime(_text(news.find("news:publication_date", NS))),
                updated_at=parse_datetime(_text(url_el.find("sm:lastmod", NS))),
                language=lang[:8] if lang else None,
                categories=[k.strip() for k in keywords.split(",") if k.strip()][:20],
            )
        )
    return items


def parse_wp_api(body: bytes) -> list[FeedItem]:
    """WordPress REST API ``/wp-json/wp/v2/posts?_embed=1`` payload."""
    try:
        data = json.loads(body.decode("utf-8", errors="replace"))
    except json.JSONDecodeError as e:
        raise FeedParseError(f"JSON parse error: {e}") from e
    if isinstance(data, dict):
        if "code" in data and "message" in data:
            raise FeedParseError(f"WP API error: {str(data.get('code'))[:80]}")
        data = data.get("posts") or data.get("items") or []
    if not isinstance(data, list):
        raise FeedParseError("WP API payload is not a list")
    items: list[FeedItem] = []
    for post in data[:MAX_ITEMS]:
        if not isinstance(post, dict):
            continue
        link = post.get("link")
        title_raw = post.get("title")
        title = _clean_title(title_raw.get("rendered") if isinstance(title_raw, dict) else title_raw)
        if not isinstance(link, str) or not title:
            continue
        excerpt = post.get("excerpt")
        content = post.get("content")
        content_html = content.get("rendered") if isinstance(content, dict) else None
        published = post.get("date_gmt") or post.get("date")
        modified = post.get("modified_gmt") or post.get("modified")
        categories: list[str] = []
        tags: list[str] = []
        embedded = post.get("_embedded") or {}
        for group in embedded.get("wp:term", []) if isinstance(embedded, dict) else []:
            for term in group or []:
                if not isinstance(term, dict) or not term.get("name"):
                    continue
                name = strip_html(str(term["name"]))[:160]
                if term.get("taxonomy") == "category":
                    categories.append(name)
                elif term.get("taxonomy") == "post_tag":
                    tags.append(name)
        author = None
        for a in embedded.get("author", []) if isinstance(embedded, dict) else []:
            if isinstance(a, dict) and a.get("name"):
                author = str(a["name"])[:160]
                break
        guid_raw = post.get("guid")
        guid = guid_raw.get("rendered") if isinstance(guid_raw, dict) else (str(post["id"]) if "id" in post else None)
        items.append(
            FeedItem(
                url=link,
                title=title,
                guid=guid,
                summary=_clean_summary(excerpt.get("rendered") if isinstance(excerpt, dict) else excerpt),
                published_at=parse_datetime(
                    published + ("Z" if published and "T" in published and not re.search(r"[+-]\d\d:\d\d$|Z$", published) else "")
                    if published
                    else None
                ),
                updated_at=parse_datetime(
                    modified + ("Z" if modified and "T" in modified and not re.search(r"[+-]\d\d:\d\d$|Z$", modified) else "")
                    if modified
                    else None
                ),
                content_html=content_html,
                categories=categories[:20],
                publisher_tags=tags[:40],
                author=author or (str(post.get("author_name"))[:160] if post.get("author_name") else None),
            )
        )
    return items
