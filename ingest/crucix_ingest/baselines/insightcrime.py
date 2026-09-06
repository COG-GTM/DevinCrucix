"""InSight Crime — weekly crawl of Mexico / US-Mexico border publications.

InSight Crime runs WordPress and publishes the public REST API (verified live;
robots.txt contains only commented-out rules). Tag ids (verified): 549 mexico,
652 us-mexico-border, 567 mexico-groups (criminal-group profiles), 544
mexico-personalities. We store:

  * ``criminal_group_profile`` / ``criminal_personality_profile`` — one row per
    profile page (cartel structure reference; value = null, metadata carries URL,
    excerpt and last-modified so analysts can see when a profile changed);
  * ``mexico_publications_weekly`` — count of Mexico/border publications per ISO week.

Full-text ingestion of the same articles (NER etc.) is done by the regular feed
pipeline via the ``insightcrime`` source-registry entry.
"""

from __future__ import annotations

import html
import json
import re
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from typing import Any

from .base import BaselineLoader, BaselineRecord, LoadResult, register

API = "https://insightcrime.org/wp-json/wp/v2/posts"
TAG_MEXICO, TAG_BORDER, TAG_GROUPS, TAG_PERSONALITIES = 549, 652, 567, 544
_TAG_RE = re.compile(r"<[^>]+>")


def _clean(s: str) -> str:
    return html.unescape(_TAG_RE.sub("", s or "")).strip()


def _week_bounds(d: date) -> tuple[str, str]:
    start = d - timedelta(days=d.weekday())
    return start.isoformat(), (start + timedelta(days=6)).isoformat()


def profiles_to_records(posts: list[dict], series: str, source_url: str, version: str) -> list[BaselineRecord]:
    out = []
    for p in posts:
        if not isinstance(p, dict) or not p.get("link"):
            continue
        modified = str(p.get("modified_gmt") or p.get("date_gmt") or "")[:10]
        published = str(p.get("date_gmt") or "")[:10]
        if not modified:
            continue
        title = _clean((p.get("title") or {}).get("rendered", ""))
        out.append(
            BaselineRecord(
                series=series,
                region_type="national",
                region_code="MX",
                region_name=title[:200] or "profile",
                country="MX",
                period_start=published or modified,
                period_end=modified,
                value=None,
                unit="profile",
                source_url=str(p["link"]),
                source_version=version,
                metadata={
                    "title": title[:200],
                    "excerpt": _clean((p.get("excerpt") or {}).get("rendered", ""))[:500],
                    "modified": modified,
                    "post_id": p.get("id"),
                    "tags": p.get("tags", []),
                },
            )
        )
    return out


def weekly_counts(posts: list[dict], source_url: str, version: str) -> list[BaselineRecord]:
    counts: dict[str, dict] = {}
    for p in posts:
        raw = str(p.get("date_gmt") or "")[:10]
        try:
            d = date.fromisoformat(raw)
        except ValueError:
            continue
        ws, we = _week_bounds(d)
        e = counts.setdefault(ws, {"end": we, "n": 0, "border": 0})
        e["n"] += 1
        if TAG_BORDER in (p.get("tags") or []):
            e["border"] += 1
    return [
        BaselineRecord(
            "mexico_publications_weekly",
            "national",
            "MX",
            "Mexico",
            "MX",
            ws,
            e["end"],
            float(e["n"]),
            "articles",
            source_url,
            version,
            {"border_tagged": e["border"]},
        )
        for ws, e in counts.items()
    ]


@register
class InsightCrimeLoader(BaselineLoader):
    dataset = "insight_crime"
    name = "InSight Crime — Mexico organized crime publications & criminal group profiles"
    source_url = "https://insightcrime.org/mexico-organized-crime-news/"
    refresh_schedule = "weekly"
    notes = "Weekly crawl via public WordPress REST API: profile index (cartel structure reference) + weekly publication counts."

    def _get(self, params: dict) -> tuple[list | None, str | None, str]:
        url = f"{API}?{urllib.parse.urlencode(params)}"
        res = self.http.fetch(url, accept="application/json", max_bytes=30_000_000)
        if not res.ok:
            return None, f"HTTP {res.status}", url
        try:
            data = json.loads(res.body.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None, "invalid json", url
        if not isinstance(data, list):
            return None, "unexpected payload", url
        self.save_artifact(url, res.body, res.etag, res.last_modified, suffix=".json")
        return data, None, url

    def _all_pages(self, params: dict, max_pages: int = 6) -> tuple[list[dict], str | None, str]:
        rows: list[dict] = []
        url = ""
        for page in range(1, max_pages + 1):
            data, err, url = self._get({**params, "page": page, "per_page": 100})
            if err:
                # WordPress returns 400 when paging past the end.
                if rows and err.startswith("HTTP 400"):
                    return rows, None, url
                return rows, err, url
            page_rows = data or []
            rows.extend(page_rows)
            if len(page_rows) < 100:
                break
        return rows, None, url

    def load(self) -> LoadResult:
        version = datetime.now(timezone.utc).strftime("%G-W%V")
        errors = []
        records: list[BaselineRecord] = []

        groups, err, url = self._all_pages({"tags": TAG_GROUPS, "_fields": "id,link,date_gmt,modified_gmt,title,excerpt,tags"})
        if err and not groups:
            if "403" in err:
                return LoadResult(self.dataset, "blocked", error=f"groups: {err}")
            errors.append(f"groups: {err}")
        records += profiles_to_records(groups, "criminal_group_profile", url, version)

        people, err, url = self._all_pages({"tags": TAG_PERSONALITIES, "_fields": "id,link,date_gmt,modified_gmt,title,excerpt,tags"})
        if err and not people:
            errors.append(f"personalities: {err}")
        records += profiles_to_records(people, "criminal_personality_profile", url, version)

        after = (datetime.now(timezone.utc) - timedelta(weeks=13)).strftime("%Y-%m-%dT%H:%M:%S")
        recent, err, url = self._all_pages(
            {"tags": f"{TAG_MEXICO},{TAG_BORDER}", "after": after, "_fields": "id,link,date_gmt,title,tags"}, max_pages=10
        )
        if err and not recent:
            errors.append(f"recent: {err}")
        records += weekly_counts(recent, url, version)

        if not records:
            return LoadResult(self.dataset, "error", error="; ".join(errors) or "no data")
        n = self.upsert_records(records)
        detail: dict[str, Any] = {"group_profiles": len(groups), "personality_profiles": len(people), "recent_posts": len(recent)}
        if errors:
            detail["partial_errors"] = errors
        return LoadResult(self.dataset, "updated", records=n, version=version, detail=detail)
