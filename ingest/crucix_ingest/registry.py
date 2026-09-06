"""Source registry: the outlet list lives in the `sources` table, seeded once from JSON."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from .config import PACKAGE_DIR
from .db import Database, row_to_dict, utcnow
from .logging_utils import log_event

logger = logging.getLogger(__name__)

SEED_PATH = PACKAGE_DIR / "data" / "sources.seed.json"

FEED_TYPES = {"rss", "atom", "news_sitemap", "wp_api", "unresolved"}
RELIABILITY_VALUES = {"established-media", "independent-media", "citizen-aggregated", "ngo-research", "government"}
# full: fetch article pages (robots permitting) and store raw HTML + text.
# metadata_only: the publisher's terms of use prohibit robots/scraping of the site; we consume only the
#   syndication feed / news sitemap it publishes and never request article pages.
CONTENT_POLICIES = {"full", "metadata_only"}
# Poll outcomes. Successful statuses reset error state; degraded statuses increment ``consecutive_errors``.
POLL_SUCCESS_STATUSES = frozenset({"ok", "empty", "not_modified"})
DEGRADED_SOURCE_STATUSES = frozenset({"error", "blocked", "robots_blocked"})
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
LANG_RE = re.compile(r"^[a-z]{2}$")
COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
TAG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

SOURCE_FIELDS = (
    "slug",
    "outlet_name",
    "feed_url",
    "feed_type",
    "language",
    "country_of_publication",
    "region_tag",
    "reliability",
    "source_type",
    "discovery_date",
    "discovery_method",
    "terms_url",
    "notes",
    "phase",
    "enabled",
    "content_policy",
)


def validate_source(src: dict[str, Any]) -> dict[str, Any]:
    """Whitelist-validate a source definition before it touches the database."""
    out: dict[str, Any] = {}
    slug = str(src.get("slug", ""))
    if not SLUG_RE.match(slug):
        raise ValueError("invalid slug")
    out["slug"] = slug
    name = str(src.get("outlet_name", "")).strip()
    if not 1 <= len(name) <= 120:
        raise ValueError("invalid outlet_name")
    out["outlet_name"] = name
    url = str(src.get("feed_url", "")).strip()
    if not url.startswith(("http://", "https://")) or len(url) > 2048:
        raise ValueError("invalid feed_url")
    out["feed_url"] = url
    feed_type = str(src.get("feed_type", "rss"))
    if feed_type not in FEED_TYPES:
        raise ValueError("invalid feed_type")
    out["feed_type"] = feed_type
    lang = str(src.get("language", "")).lower()
    if not LANG_RE.match(lang):
        raise ValueError("invalid language")
    out["language"] = lang
    country = str(src.get("country_of_publication", "")).upper()
    if not COUNTRY_RE.match(country):
        raise ValueError("invalid country_of_publication")
    out["country_of_publication"] = country
    region = str(src.get("region_tag", ""))
    if not TAG_RE.match(region):
        raise ValueError("invalid region_tag")
    out["region_tag"] = region
    reliability = str(src.get("reliability", ""))
    if reliability not in RELIABILITY_VALUES:
        raise ValueError("invalid reliability")
    out["reliability"] = reliability
    source_type = str(src.get("source_type", ""))
    if not TAG_RE.match(source_type):
        raise ValueError("invalid source_type")
    out["source_type"] = source_type
    disc = str(src.get("discovery_date", ""))
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", disc):
        raise ValueError("invalid discovery_date")
    out["discovery_date"] = disc
    out["discovery_method"] = str(src.get("discovery_method", ""))[:255]
    terms = str(src.get("terms_url", ""))[:2048]
    if terms and not terms.startswith(("http://", "https://")):
        raise ValueError("invalid terms_url")
    out["terms_url"] = terms
    out["notes"] = str(src.get("notes", ""))[:1000]
    phase = int(src.get("phase", 1))
    if phase not in (1, 2, 3):
        raise ValueError("invalid phase")
    out["phase"] = phase
    out["enabled"] = 1 if int(src.get("enabled", 1)) else 0
    policy = str(src.get("content_policy", "full"))
    if policy not in CONTENT_POLICIES:
        raise ValueError("invalid content_policy")
    out["content_policy"] = policy
    return out


def load_seed(path: Path = SEED_PATH) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return [validate_source(s) for s in data.get("sources", [])]


def seed_registry(db: Database, path: Path = SEED_PATH) -> int:
    """Insert any seed sources not already present. Existing rows are never overwritten."""
    inserted = 0
    now = utcnow()
    for src in load_seed(path):
        with db.transaction() as cur:
            cur.execute(
                """INSERT OR IGNORE INTO sources
                   (slug, outlet_name, feed_url, feed_type, language, country_of_publication, region_tag,
                    reliability, source_type, discovery_date, discovery_method, terms_url, notes, phase, enabled,
                    content_policy, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    src["slug"],
                    src["outlet_name"],
                    src["feed_url"],
                    src["feed_type"],
                    src["language"],
                    src["country_of_publication"],
                    src["region_tag"],
                    src["reliability"],
                    src["source_type"],
                    src["discovery_date"],
                    src["discovery_method"],
                    src["terms_url"],
                    src["notes"],
                    src["phase"],
                    src["enabled"],
                    src["content_policy"],
                    now,
                    now,
                ),
            )
            inserted += cur.rowcount
    if inserted:
        log_event(logger, "registry_seeded", inserted=inserted)
    return inserted


def upsert_source(db: Database, src: dict[str, Any]) -> dict[str, Any]:
    """Create or update a registry entry (validated). Polling state is preserved."""
    clean = validate_source(src)
    now = utcnow()
    with db.transaction() as cur:
        cur.execute(
            """INSERT INTO sources
               (slug, outlet_name, feed_url, feed_type, language, country_of_publication, region_tag,
                reliability, source_type, discovery_date, discovery_method, terms_url, notes, phase, enabled,
                content_policy, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(slug) DO UPDATE SET
                 outlet_name=excluded.outlet_name, feed_url=excluded.feed_url, feed_type=excluded.feed_type,
                 language=excluded.language, country_of_publication=excluded.country_of_publication,
                 region_tag=excluded.region_tag, reliability=excluded.reliability, source_type=excluded.source_type,
                 discovery_date=excluded.discovery_date, discovery_method=excluded.discovery_method,
                 terms_url=excluded.terms_url, notes=excluded.notes, phase=excluded.phase, enabled=excluded.enabled,
                 content_policy=excluded.content_policy, updated_at=excluded.updated_at""",
            (
                clean["slug"],
                clean["outlet_name"],
                clean["feed_url"],
                clean["feed_type"],
                clean["language"],
                clean["country_of_publication"],
                clean["region_tag"],
                clean["reliability"],
                clean["source_type"],
                clean["discovery_date"],
                clean["discovery_method"],
                clean["terms_url"],
                clean["notes"],
                clean["phase"],
                clean["enabled"],
                clean["content_policy"],
                now,
                now,
            ),
        )
    log_event(logger, "registry_upsert", slug=clean["slug"])
    return get_source(db, clean["slug"])  # type: ignore[return-value]


def get_source(db: Database, slug: str) -> dict[str, Any] | None:
    if not SLUG_RE.match(slug or ""):
        return None
    return row_to_dict(db.query_one("SELECT * FROM sources WHERE slug = ?", (slug,)))


def list_sources(db: Database, enabled_only: bool = False) -> list[dict[str, Any]]:
    sql = "SELECT * FROM sources"
    if enabled_only:
        sql += " WHERE enabled = 1 AND feed_type != 'unresolved'"
    sql += " ORDER BY phase, outlet_name, slug"
    return [row_to_dict(r) for r in db.query(sql)]  # type: ignore[misc]


def set_enabled(db: Database, slug: str, enabled: bool) -> bool:
    if not SLUG_RE.match(slug or ""):
        return False
    with db.transaction() as cur:
        cur.execute("UPDATE sources SET enabled = ?, updated_at = ? WHERE slug = ?", (1 if enabled else 0, utcnow(), slug))
        changed = cur.rowcount > 0
    if changed:
        log_event(logger, "registry_set_enabled", slug=slug, enabled=enabled)
    return changed


def record_poll(
    db: Database,
    source_id: int,
    *,
    started_at: str,
    status: str,
    http_status: int | None,
    items_total: int,
    items_new: int,
    error: str | None,
    etag: str | None,
    last_modified: str | None,
) -> None:
    """Persist poll outcome. Empty successful polls are tracked separately from healthy ones,
    and a successful poll clears stale error state."""
    now = utcnow()
    with db.transaction() as cur:
        cur.execute(
            """INSERT INTO poll_log (source_id, started_at, finished_at, status, http_status, items_total, items_new, error)
               VALUES (?,?,?,?,?,?,?,?)""",
            (source_id, started_at, now, status, http_status, items_total, items_new, (error or "")[:500] or None),
        )
        if status in POLL_SUCCESS_STATUSES:
            cur.execute(
                """UPDATE sources SET last_polled_at=?, last_success_at=?, last_status=?, last_error=NULL,
                          last_http_status=?, consecutive_errors=0, items_seen_total=items_seen_total+?,
                          etag=COALESCE(?, etag), last_modified=COALESCE(?, last_modified), updated_at=?
                   WHERE id=?""",
                (now, now, status, http_status, items_new, etag, last_modified, now, source_id),
            )
        else:
            cur.execute(
                """UPDATE sources SET last_polled_at=?, last_status=?, last_error=?, last_http_status=?,
                          consecutive_errors=consecutive_errors+1, updated_at=?
                   WHERE id=?""",
                (now, status, (error or "")[:500] or None, http_status, now, source_id),
            )
