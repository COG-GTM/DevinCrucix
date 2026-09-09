"""Deterministic, cross-source deduplication keys."""

from __future__ import annotations

import hashlib
import re
import unicodedata
import urllib.parse
from collections.abc import Iterable

TRACKING_PARAMS_PREFIXES = ("utm_", "fbclid", "gclid", "mc_", "ref", "source", "ito", "ns_", "cmpid", "__twitter_impression", "s_", "spm")
_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def canonicalize_url(url: str) -> str:
    """Lower-case scheme/host, drop fragments, tracking params, default ports, trailing slashes, and mobile/AMP markers."""
    parsed = urllib.parse.urlsplit(url.strip())
    scheme = (parsed.scheme or "https").lower()
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    if host.startswith("amp."):
        host = host[4:]
    if host.startswith("m.") and host.count(".") >= 2:
        host = host[2:]
    port = parsed.port
    if port and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        host = f"{host}:{port}"
    path = re.sub(r"/+", "/", parsed.path or "/")
    path = re.sub(r"/amp/?$", "/", path)
    path = re.sub(r"\.amp\.html$", ".html", path)
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    if path.endswith("/index.html"):
        path = path[: -len("/index.html")] or "/"
    query_pairs = [
        (k, v)
        for k, v in urllib.parse.parse_qsl(parsed.query, keep_blank_values=False)
        if not k.lower().startswith(TRACKING_PARAMS_PREFIXES) and k.lower() not in {"output", "outputtype", "amp", "share"}
    ]
    query = urllib.parse.urlencode(sorted(query_pairs)) if query_pairs else ""
    return urllib.parse.urlunsplit((scheme, host, path, query, ""))


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower()
    value = _PUNCT_RE.sub(" ", value)
    return _WS_RE.sub(" ", value).strip()


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def url_key(url: str) -> str:
    return "url:" + sha256_hex(canonicalize_url(url))


def guid_key(source_slug: str, guid: str | None) -> str | None:
    if not guid:
        return None
    g = guid.strip()
    if not g:
        return None
    if g.startswith(("http://", "https://")):
        return url_key(g)
    return "guid:" + sha256_hex(f"{source_slug}|{g}")


def title_date_key(title: str, published_at: str | None) -> str | None:
    norm = normalize_text(title)
    if len(norm) < 15 or not published_at:
        return None
    return "td:" + sha256_hex(f"{norm}|{published_at[:10]}")


def content_key(text: str | None, title: str | None = None) -> str | None:
    """Body-hash key. A leading line equal to the headline is dropped so re-headlined wire copy still matches."""
    if not text:
        return None
    if title:
        first, _, rest = text.strip().partition("\n")
        if rest and normalize_text(first) == normalize_text(title):
            text = rest
    norm = normalize_text(text)
    if len(norm) < 200:
        return None
    return "txt:" + sha256_hex(norm)


def candidate_keys(source_slug: str, url: str, guid: str | None, title: str, published_at: str | None) -> list[str]:
    keys = [url_key(url)]
    for k in (guid_key(source_slug, guid), title_date_key(title, published_at)):
        if k and k not in keys:
            keys.append(k)
    return keys


def unique(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for i in items:
        if i not in seen:
            seen.add(i)
            out.append(i)
    return out
