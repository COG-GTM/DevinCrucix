"""SQLite persistence. All queries are parameterized."""

from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  outlet_name TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  feed_type TEXT NOT NULL,            -- rss | atom | news_sitemap | wp_api
  language TEXT NOT NULL,             -- ISO 639-1
  country_of_publication TEXT NOT NULL, -- ISO 3166-1 alpha-2
  region_tag TEXT NOT NULL,
  reliability TEXT NOT NULL,          -- established-media | independent-media | citizen-aggregated | ngo-research | government
  source_type TEXT NOT NULL,          -- newspaper | broadcast | nonprofit-newsroom | magazine | citizen-aggregated | research
  discovery_date TEXT NOT NULL,
  discovery_method TEXT NOT NULL DEFAULT '',
  terms_url TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  phase INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  content_policy TEXT NOT NULL DEFAULT 'full', -- full | metadata_only (publisher terms forbid article crawling)
  etag TEXT,
  last_modified TEXT,
  last_polled_at TEXT,
  last_success_at TEXT,
  last_status TEXT,
  last_error TEXT,
  last_http_status INTEGER,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  items_seen_total INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_log (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL,               -- ok | empty | not_modified | error | blocked | robots_blocked | disabled
  http_status INTEGER,
  items_total INTEGER NOT NULL DEFAULT 0,
  items_new INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_poll_log_source ON poll_log(source_id, started_at);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  dedup_key TEXT NOT NULL UNIQUE,
  guid TEXT,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  discovered_at TEXT NOT NULL,
  fetched_at TEXT,
  language TEXT NOT NULL,
  country_of_publication TEXT NOT NULL,
  reliability TEXT NOT NULL,
  source_type TEXT NOT NULL,
  region_tag TEXT NOT NULL,
  paywalled INTEGER NOT NULL DEFAULT 0,
  fetch_status TEXT NOT NULL,         -- fetched | paywalled | robots_disallowed | fetch_error | not_fetched | skipped | metadata_only
  fetch_error TEXT,
  extraction_method TEXT NOT NULL DEFAULT 'none', -- trafilatura | news-please | wp_api | feed-only | none
  raw_html_path TEXT,
  raw_html_sha256 TEXT,
  text TEXT,                          -- original-language text: the source of record
  text_hash TEXT,
  text_language TEXT,
  translation_text TEXT,              -- derived machine translation, never replaces `text`
  translation_engine TEXT,
  translation_model TEXT,
  translation_is_machine INTEGER NOT NULL DEFAULT 1,
  translated_at TEXT,
  entities_json TEXT NOT NULL DEFAULT '[]',
  entity_source_language TEXT,        -- language the NER ran on (always original)
  ner_model TEXT,
  border_regions_json TEXT NOT NULL DEFAULT '[]',
  violence_score REAL NOT NULL DEFAULT 0,
  violence_terms_json TEXT NOT NULL DEFAULT '[]', -- matched lexicon terms, for explainability
  is_violence INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id, published_at);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
CREATE INDEX IF NOT EXISTS idx_articles_text_hash ON articles(text_hash);
CREATE INDEX IF NOT EXISTS idx_articles_canonical ON articles(canonical_url);

CREATE TABLE IF NOT EXISTS article_aliases (
  alias_key TEXT PRIMARY KEY,         -- alternate dedup keys (guid, alt URL, title+date)
  article_id INTEGER NOT NULL REFERENCES articles(id)
);

CREATE TABLE IF NOT EXISTS article_regions (
  article_id INTEGER NOT NULL REFERENCES articles(id),
  region_code TEXT NOT NULL,
  region_type TEXT NOT NULL,
  region_name TEXT NOT NULL,
  country TEXT NOT NULL,
  PRIMARY KEY (article_id, region_code)
);
CREATE INDEX IF NOT EXISTS idx_article_regions_region ON article_regions(region_code);

CREATE TABLE IF NOT EXISTS baseline_datasets (
  dataset TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  refresh_schedule TEXT NOT NULL,     -- weekly | monthly | quarterly | one-time
  refresh_interval_hours INTEGER NOT NULL,
  last_checked_at TEXT,
  last_updated_at TEXT,
  last_status TEXT,
  last_error TEXT,
  version TEXT,
  record_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS baseline_records (
  id INTEGER PRIMARY KEY,
  dataset TEXT NOT NULL REFERENCES baseline_datasets(dataset),
  series TEXT NOT NULL,
  region_type TEXT NOT NULL,          -- county | municipality | state | sector | national | organization
  region_code TEXT NOT NULL,
  region_name TEXT NOT NULL,
  country TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  value REAL,
  unit TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_url TEXT NOT NULL,
  source_version TEXT,
  retrieved_at TEXT NOT NULL,
  UNIQUE (dataset, series, region_type, region_code, period_start)
);
CREATE INDEX IF NOT EXISTS idx_baseline_records_lookup ON baseline_records(dataset, series, region_code, period_start);

CREATE TABLE IF NOT EXISTS baseline_artifacts (
  id INTEGER PRIMARY KEY,
  dataset TEXT NOT NULL,
  url TEXT NOT NULL,
  path TEXT,
  sha256 TEXT,
  bytes INTEGER,
  etag TEXT,
  last_modified TEXT,
  retrieved_at TEXT NOT NULL,
  UNIQUE (dataset, url, sha256)
);

CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY,
  detected_at TEXT NOT NULL,
  metric TEXT NOT NULL,
  region_type TEXT NOT NULL,
  region_code TEXT NOT NULL,
  region_name TEXT NOT NULL,
  country TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  observed REAL NOT NULL,
  baseline_mean REAL NOT NULL,
  baseline_std REAL NOT NULL,
  baseline_n INTEGER NOT NULL,
  z_score REAL NOT NULL,
  severity TEXT NOT NULL,             -- watch | elevated | critical
  article_ids_json TEXT NOT NULL DEFAULT '[]',
  detail_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (metric, region_code, window_start)
);
CREATE INDEX IF NOT EXISTS idx_anomalies_detected ON anomalies(detected_at);
"""

# Additive column migrations for databases created by earlier schema versions: (table, column, DDL).
COLUMN_MIGRATIONS: tuple[tuple[str, str, str], ...] = (
    ("sources", "content_policy", "TEXT NOT NULL DEFAULT 'full'"),
    ("articles", "violence_terms_json", "TEXT NOT NULL DEFAULT '[]'"),
)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Database:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=30)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._conn.execute("PRAGMA busy_timeout=30000")
        self._init_schema()

    def _init_schema(self) -> None:
        with self.transaction() as cur:
            cur.executescript(SCHEMA)
            for table, column, ddl in COLUMN_MIGRATIONS:
                cols = {r["name"] for r in cur.execute(f"PRAGMA table_info({table})").fetchall()}  # noqa: S608 - constant
                if column not in cols:
                    cur.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")  # noqa: S608 - constant
            cur.execute(
                "INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)",
                ("schema_version", str(SCHEMA_VERSION)),
            )

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Cursor]:
        with self._lock:
            cur = self._conn.cursor()
            try:
                yield cur
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise
            finally:
                cur.close()

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        with self._lock:
            cur = self._conn.execute(sql, tuple(params))
            try:
                return cur.fetchall()
            finally:
                cur.close()

    def query_one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params: Iterable[Any] = ()) -> int:
        with self.transaction() as cur:
            cur.execute(sql, tuple(params))
            return cur.lastrowid or 0

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def rows_to_dicts(rows: Iterable[sqlite3.Row], json_fields: Iterable[str] = ()) -> list[dict[str, Any]]:
    fields = tuple(json_fields)
    out: list[dict[str, Any]] = []
    for r in rows:
        d = row_to_dict(r, fields)
        if d is not None:
            out.append(d)
    return out


def row_to_dict(row: sqlite3.Row | None, json_fields: Iterable[str] = ()) -> dict[str, Any] | None:
    if row is None:
        return None
    data = dict(row)
    for f in json_fields:
        raw = data.get(f)
        if isinstance(raw, str):
            try:
                data[f] = json.loads(raw)
            except json.JSONDecodeError:
                data[f] = None
    return data
