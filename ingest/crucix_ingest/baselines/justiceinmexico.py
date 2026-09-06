"""Justice in Mexico (University of San Diego) — quarterly release check.

The site exposes the public WordPress REST API with a custom ``publication`` post
type (verified live). We search it for the annual *Organized Crime and Violence in
Mexico* report, record each edition as a reference row (year, URL, attached PDF
links) and flag new editions. The report is narrative/PDF, so `value` is null;
the row is a versioned pointer for analysts, not a numeric series.
"""

from __future__ import annotations

import html
import json
import re
import urllib.parse
from datetime import datetime, timezone

from .base import BaselineLoader, BaselineRecord, LoadResult, register

API_URL = "https://justiceinmexico.org/wp-json/wp/v2/publication"
SEARCH_TERMS = ["organized crime and violence in mexico", "ocvm"]
_PDF_RE = re.compile(r'href="([^"]+\.pdf[^"]*)"', re.IGNORECASE)
_YEAR_RE = re.compile(r"\b(20\d\d)\b")
_TAG_RE = re.compile(r"<[^>]+>")


def parse_publications(payload: list[dict], source_url: str) -> list[BaselineRecord]:
    out: dict[str, BaselineRecord] = {}
    for post in payload:
        if not isinstance(post, dict):
            continue
        title_raw = post.get("title", {})
        title = html.unescape(_TAG_RE.sub("", title_raw.get("rendered", "") if isinstance(title_raw, dict) else str(title_raw))).strip()
        if "organized crime and violence" not in title.lower():
            continue
        years = _YEAR_RE.findall(title)
        if not years:
            continue
        year = max(years)
        content = post.get("content", {})
        content_html = content.get("rendered", "") if isinstance(content, dict) else ""
        pdfs = sorted({html.unescape(u) for u in _PDF_RE.findall(content_html or "")})[:10]
        link = str(post.get("link") or source_url)
        published = str(post.get("date_gmt") or post.get("date") or "")[:10] or f"{year}-01-01"
        out[year] = BaselineRecord(
            series="ocvm_annual_report",
            region_type="national",
            region_code="MX",
            region_name="Mexico",
            country="MX",
            period_start=f"{year}-01-01",
            period_end=f"{year}-12-31",
            value=None,
            unit="report",
            source_url=link,
            source_version=f"ocvm-{year}",
            metadata={"title": title[:200], "published": published, "pdf_links": pdfs, "post_id": post.get("id")},
        )
    return list(out.values())


@register
class JusticeInMexicoLoader(BaselineLoader):
    dataset = "justice_in_mexico_ocvm"
    name = "Justice in Mexico — Organized Crime and Violence in Mexico (annual report)"
    source_url = "https://justiceinmexico.org/publications/"
    refresh_schedule = "quarterly"
    notes = "Quarterly check for new editions via the site's public WordPress REST API; stores edition pointers and PDF links."

    def load(self) -> LoadResult:
        before = {
            r["source_version"]
            for r in self.db.query("SELECT DISTINCT source_version FROM baseline_records WHERE dataset = ?", (self.dataset,))
        }
        records: dict[str, BaselineRecord] = {}
        last_err = None
        for term in SEARCH_TERMS:
            url = f"{API_URL}?{urllib.parse.urlencode({'search': term, 'per_page': 50})}"
            res = self.http.fetch(url, accept="application/json")
            if not res.ok:
                last_err = f"HTTP {res.status}"
                continue
            try:
                payload = json.loads(res.body.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                last_err = "invalid json"
                continue
            if not isinstance(payload, list):
                last_err = "unexpected payload"
                continue
            self.save_artifact(url, res.body, res.etag, res.last_modified, suffix=".json")
            for rec in parse_publications(payload, url):
                records[rec.source_version or rec.period_start] = rec
        if not records:
            status = "blocked" if last_err and "403" in last_err else "error"
            return LoadResult(self.dataset, status, error=last_err or "no publications matched")
        n = self.upsert_records(records.values())
        new_editions = sorted(set(records) - before)
        latest = max(records)
        status = "updated" if new_editions else "unchanged"
        return LoadResult(
            self.dataset,
            status,
            records=n,
            version=latest,
            detail={
                "editions": sorted(records),
                "new_editions": new_editions,
                "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            },
        )
