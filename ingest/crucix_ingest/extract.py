"""Article text extraction (trafilatura preferred, news-please fallback) and paywall detection.

Paywall policy: we never attempt to bypass. If a page signals restricted access we
discard any fetched HTML/text and keep only headline, feed summary, URL and timestamp.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime

from .feeds import strip_html
from .logging_utils import log_event

logger = logging.getLogger(__name__)

try:  # optional heavy dependency
    import trafilatura  # type: ignore
except Exception:  # pragma: no cover - import guard
    trafilatura = None  # type: ignore[assignment]

try:  # optional heavy dependency
    from newsplease import NewsPlease  # type: ignore
except Exception:  # pragma: no cover - import guard
    NewsPlease = None

MIN_ARTICLE_CHARS = 300

_JSONLD_RE = re.compile(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", re.IGNORECASE | re.DOTALL)
_PAYWALL_MARKERS = (
    'isaccessibleforfree":false',
    'isaccessibleforfree": false',
    'isaccessibleforfree":"false"',
    '"contentprotectionstate":"premium"',
    '"ispremium":true',
    '"premium":true',
    "subscriber-only",
    "subscriber_only",
    "subscribers-only",
    "meter-wall",
    "metered-paywall",
    'id="paywall"',
    'class="paywall',
    "data-paywall",
    "tp-modal",
    "piano-paywall",
    "regwall",
    '"paywall":true',
    '"paywalled":true',
    "contenido exclusivo para suscriptores",
    "solo para suscriptores",
)
_PAYWALL_TEXT_RE = re.compile(
    r"(subscribe to (continue|read|keep reading)|to continue reading|already a subscriber|"
    r"this (article|content) is (for|available to) subscribers|suscr[ií]bete para (seguir|continuar)|"
    r"contenido exclusivo para suscriptores|inicia sesi[oó]n para continuar)",
    re.IGNORECASE,
)
_CANONICAL_RE = re.compile(r"<link[^>]+rel=[\"']canonical[\"'][^>]+href=[\"']([^\"']+)[\"']", re.IGNORECASE)
_CANONICAL_RE2 = re.compile(r"<link[^>]+href=[\"']([^\"']+)[\"'][^>]+rel=[\"']canonical[\"']", re.IGNORECASE)
_HTML_LANG_RE = re.compile(r"<html[^>]+lang=[\"']([a-zA-Z]{2})", re.IGNORECASE)


@dataclass
class ExtractionResult:
    text: str | None
    method: str  # trafilatura | news-please | none
    title: str | None = None
    author: str | None = None
    date: str | None = None
    language: str | None = None
    canonical_url: str | None = None
    paywalled: bool = False
    paywall_signals: list[str] = field(default_factory=list)


def _jsonld_blocks(html: str) -> list[dict]:
    out: list[dict] = []
    for m in _JSONLD_RE.finditer(html):
        raw = m.group(1).strip()
        if not raw or len(raw) > 500_000:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                out.append(node)
                for v in node.values():
                    if isinstance(v, (dict, list)):
                        stack.append(v)
            elif isinstance(node, list):
                stack.extend(node)
    return out


def detect_paywall(html: str, extracted_text: str | None, http_status: int = 200) -> list[str]:
    """Return the list of paywall signals found (empty list == no paywall detected)."""
    signals: list[str] = []
    if http_status in (401, 402):
        signals.append(f"http_{http_status}")
    lowered = html[:400_000].lower()
    for node in _jsonld_blocks(html):
        val = node.get("isAccessibleForFree")
        if val is False or (isinstance(val, str) and val.strip().lower() == "false"):
            signals.append("jsonld:isAccessibleForFree=false")
            break
    for marker in _PAYWALL_MARKERS:
        if marker in lowered:
            signals.append(f"marker:{marker[:40]}")
            break
    text = extracted_text or ""
    if len(text) < 1200 and _PAYWALL_TEXT_RE.search(text[:2000] or strip_html(html[-30_000:])):
        signals.append("text:subscription_prompt")
    return signals


def _extract_trafilatura(html: str, url: str) -> ExtractionResult | None:
    if trafilatura is None:
        return None
    try:
        text = trafilatura.extract(
            html,
            url=url,
            include_comments=False,
            include_tables=False,
            favor_precision=True,
            deduplicate=True,
            output_format="txt",
        )
        meta = trafilatura.extract_metadata(html, default_url=url)
    except Exception as e:  # pragma: no cover - library failure path
        log_event(logger, "trafilatura_error", logging.WARNING, url=url[:300], error=str(e)[:200])
        return None
    if not text or len(text.strip()) < MIN_ARTICLE_CHARS:
        return None
    return ExtractionResult(
        text=text.strip(),
        method="trafilatura",
        title=getattr(meta, "title", None) if meta else None,
        author=getattr(meta, "author", None) if meta else None,
        date=getattr(meta, "date", None) if meta else None,
        language=None,
    )


def _extract_newsplease(html: str, url: str) -> ExtractionResult | None:
    if NewsPlease is None:
        return None
    try:
        article = NewsPlease.from_html(html, url=url)
    except Exception as e:  # pragma: no cover - library failure path
        log_event(logger, "newsplease_error", logging.WARNING, url=url[:300], error=str(e)[:200])
        return None
    text = getattr(article, "maintext", None)
    if not text or len(text.strip()) < MIN_ARTICLE_CHARS:
        return None
    date = getattr(article, "date_publish", None)
    return ExtractionResult(
        text=text.strip(),
        method="news-please",
        title=getattr(article, "title", None),
        author=", ".join(getattr(article, "authors", None) or []) or None,
        date=(date.isoformat() if isinstance(date, datetime) else str(date)) if date else None,
        language=getattr(article, "language", None),
    )


def extract_article(html: str, url: str, http_status: int = 200) -> ExtractionResult:
    canonical = None
    m = _CANONICAL_RE.search(html[:200_000]) or _CANONICAL_RE2.search(html[:200_000])
    if m:
        canonical = m.group(1).strip()[:2048]
    lang_m = _HTML_LANG_RE.search(html[:20_000])
    html_lang = lang_m.group(1).lower() if lang_m else None

    result = _extract_trafilatura(html, url) or _extract_newsplease(html, url)
    if result is None:
        result = ExtractionResult(text=None, method="none")
    result.canonical_url = canonical
    if not result.language:
        result.language = html_lang

    signals = detect_paywall(html, result.text, http_status=http_status)
    if signals:
        result.paywalled = True
        result.paywall_signals = signals
        result.text = None
        result.method = "none"
    return result


def extract_from_html_fragment(fragment: str) -> str | None:
    """Plain text from feed/API-provided HTML content (no page fetch involved)."""
    if not fragment:
        return None
    text = None
    if trafilatura is not None:
        try:
            text = trafilatura.extract(f"<html><body>{fragment}</body></html>", include_comments=False, output_format="txt")
        except Exception:
            text = None
    if not text:
        text = strip_html(fragment)
    text = (text or "").strip()
    return text or None
