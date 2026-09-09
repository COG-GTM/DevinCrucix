"""SQLite migrations, registry seeding/upsert/poll-health, and anomaly detection on synthetic series."""

from __future__ import annotations

import json
import sqlite3
from datetime import date, timedelta

import pytest

from crucix_ingest.anomaly import (
    densify_monthly,
    detect_baseline_anomalies,
    detect_news_anomalies,
    evaluate_region_series,
    list_anomalies,
)
from crucix_ingest.baselines.base import BaselineRecord
from crucix_ingest.baselines.fra import FraLoader
from crucix_ingest.db import COLUMN_MIGRATIONS, SCHEMA_VERSION, Database, utcnow
from crucix_ingest.registry import (
    CONTENT_POLICIES,
    FEED_TYPES,
    RELIABILITY_VALUES,
    get_source,
    list_sources,
    load_seed,
    record_poll,
    seed_registry,
    set_enabled,
    upsert_source,
    validate_source,
)

from .conftest import make_source

# --------------------------------------------------------------------------- migrations


def test_fresh_database_has_full_schema_and_version(db):
    tables = {r["name"] for r in db.query("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {
        "meta",
        "sources",
        "articles",
        "article_aliases",
        "article_regions",
        "poll_log",
        "baseline_datasets",
        "baseline_records",
        "baseline_artifacts",
        "anomalies",
    } <= tables
    assert db.query_one("SELECT value FROM meta WHERE key='schema_version'")["value"] == str(SCHEMA_VERSION)
    cols = {r["name"] for r in db.query("PRAGMA table_info(articles)")}
    assert {
        "violence_score",
        "violence_terms_json",
        "is_violence",
        "paywalled",
        "text",
        "translation_text",
        "translation_is_machine",
        "entities_json",
    } <= cols
    assert db.query_one("PRAGMA journal_mode")[0] == "wal"
    assert db.query_one("PRAGMA foreign_keys")[0] == 1


def test_existing_v1_database_is_migrated_additively(tmp_path):
    path = tmp_path / "old.sqlite3"
    Database(path).close()
    raw = sqlite3.connect(path)
    for table, column, _ in COLUMN_MIGRATIONS:
        raw.execute(f"ALTER TABLE {table} DROP COLUMN {column}")
    raw.execute(
        "INSERT INTO sources (slug, outlet_name, feed_url, feed_type, language, country_of_publication, region_tag, reliability, "
        "source_type, discovery_date, discovery_method, phase, enabled, created_at, updated_at) "
        "VALUES ('old','Old','https://old.example/feed','rss','en','US','tag','established-media','newspaper','2026-01-01','x',1,1,'t','t')"
    )
    raw.execute("UPDATE meta SET value='1' WHERE key='schema_version'")
    raw.commit()
    raw.close()
    db = Database(path)
    for table, column, _ in COLUMN_MIGRATIONS:
        assert column in {r["name"] for r in db.query(f"PRAGMA table_info({table})")}
    row = db.query_one("SELECT content_policy FROM sources WHERE slug='old'")
    assert row["content_policy"] == "full"  # default applied to pre-existing rows
    assert db.query_one("SELECT value FROM meta WHERE key='schema_version'")["value"] == str(SCHEMA_VERSION)
    Database(path).close()  # re-open is idempotent


def test_transaction_rolls_back_on_error(db):
    with pytest.raises(sqlite3.IntegrityError):
        with db.transaction() as cur:
            cur.execute("INSERT INTO meta(key, value) VALUES ('k', 'v')")
            cur.execute("INSERT INTO meta(key, value) VALUES ('k', 'v2')")
    assert db.query_one("SELECT value FROM meta WHERE key='k'") is None


# --------------------------------------------------------------------------- registry


def test_seed_file_is_valid_and_covers_every_requested_outlet():
    seed = load_seed()
    slugs = {s["slug"] for s in seed}
    assert len(slugs) == len(seed)
    outlets = " ".join(s["outlet_name"].lower() for s in seed)
    for outlet in (
        "border report",
        "el paso times",
        "el paso matters",
        "krgv",
        "valleycentral",
        "laredo morning times",
        "express-news",
        "texas tribune",
        "el mañana",
        "zeta",
        "proceso",
        "milenio",
        "borderland beat",
    ):
        assert outlet in outlets, outlet
    for s in seed:
        assert s["feed_type"] in FEED_TYPES and s["reliability"] in RELIABILITY_VALUES and s["content_policy"] in CONTENT_POLICIES
        assert s["phase"] in (1, 2, 3)
        assert s["feed_url"].startswith("https://") or s["feed_type"] == "unresolved"
        assert s["discovery_date"] and s["discovery_method"]
    bb = next(s for s in seed if "borderland" in s["slug"])
    assert bb["source_type"] == "citizen-aggregated" and bb["reliability"] == "citizen-aggregated" and bb["language"] == "en"
    for slug_frag in ("zeta", "proceso", "milenio", "manana"):
        s = next(s for s in seed if slug_frag in s["slug"])
        assert s["language"] == "es" and s["country_of_publication"] == "MX" and s["phase"] == 2, slug_frag
    # publisher terms that prohibit crawling are represented as data, never worked around
    restricted = [s for s in seed if s["content_policy"] == "metadata_only" or not s["enabled"]]
    assert restricted and all(s["notes"] for s in restricted)
    assert all(s["enabled"] == 0 for s in seed if s["feed_type"] == "unresolved")


def test_seed_registry_is_idempotent_and_preserves_operator_edits(db):
    n = seed_registry(db)
    assert n == len(load_seed()) and seed_registry(db) == 0
    slug = load_seed()[0]["slug"]
    assert set_enabled(db, slug, False)
    seed_registry(db)
    assert get_source(db, slug)["enabled"] == 0
    assert not set_enabled(db, "does-not-exist", True)
    assert len(list_sources(db, enabled_only=True)) == len([s for s in load_seed() if s["enabled"]]) - 1


def test_upsert_source_validates_and_preserves_poll_state(db, server):
    src = upsert_source(db, make_source(server))
    record_poll(
        db,
        src["id"],
        started_at=utcnow(),
        status="ok",
        http_status=200,
        items_total=5,
        items_new=5,
        error=None,
        etag='"e1"',
        last_modified=None,
    )
    updated = upsert_source(db, make_source(server, outlet_name="Renamed", notes="changed"))
    assert updated["id"] == src["id"] and updated["outlet_name"] == "Renamed"
    assert updated["etag"] == '"e1"' and updated["items_seen_total"] == 5 and updated["last_status"] == "ok"
    for bad in (
        {"slug": "Bad Slug"},
        {"language": "eng"},
        {"country_of_publication": "usa"},
        {"feed_type": "scrape"},
        {"reliability": "trust-me"},
        {"feed_url": "ftp://x/feed"},
        {"content_policy": "stealth"},
        {"phase": 4},
    ):
        with pytest.raises(ValueError):
            validate_source(make_source(server, **bad))


def test_record_poll_health_semantics(db, server):
    src = upsert_source(db, make_source(server))
    sid = src["id"]
    record_poll(
        db,
        sid,
        started_at=utcnow(),
        status="error",
        http_status=500,
        items_total=0,
        items_new=0,
        error="boom",
        etag=None,
        last_modified=None,
    )
    record_poll(
        db,
        sid,
        started_at=utcnow(),
        status="blocked",
        http_status=403,
        items_total=0,
        items_new=0,
        error="HTTP 403",
        etag=None,
        last_modified=None,
    )
    s = get_source(db, "testoutlet")
    assert s["consecutive_errors"] == 2 and s["last_error"] == "HTTP 403" and s["last_success_at"] is None
    record_poll(
        db,
        sid,
        started_at=utcnow(),
        status="empty",
        http_status=200,
        items_total=0,
        items_new=0,
        error=None,
        etag=None,
        last_modified="Sun, 06 Sep 2026 00:00:00 GMT",
    )
    s = get_source(db, "testoutlet")
    assert s["last_status"] == "empty" and s["consecutive_errors"] == 0 and s["last_error"] is None and s["last_success_at"]
    assert s["last_modified"].startswith("Sun")
    record_poll(
        db,
        sid,
        started_at=utcnow(),
        status="not_modified",
        http_status=304,
        items_total=0,
        items_new=0,
        error=None,
        etag=None,
        last_modified=None,
    )
    assert get_source(db, "testoutlet")["last_modified"].startswith("Sun")  # COALESCE keeps validators
    assert db.query_one("SELECT COUNT(*) AS n FROM poll_log WHERE source_id=?", (sid,))["n"] == 4


# --------------------------------------------------------------------------- news anomalies


def _flat_series(end: date, weeks: int, per_day: int) -> dict[str, int]:
    return {(end - timedelta(days=i)).isoformat(): per_day for i in range(7 * (weeks + 1))}


def test_evaluate_region_series_flags_spike_not_baseline():
    end = date(2026, 9, 6)
    daily = _flat_series(end, 8, 1)
    assert evaluate_region_series(daily, end, 8, 2.5, 3) is None
    for i in range(7):
        daily[(end - timedelta(days=i)).isoformat()] = 5
    res = evaluate_region_series(daily, end, 8, 2.5, 3)
    assert res and res["observed"] == 35 and res["baseline_mean"] == 7.0 and res["baseline_n"] == 8
    assert res["z_score"] > 2.5 and res["severity"] == "critical"  # 5x baseline
    assert res["window_start"] == "2026-08-31" and res["window_end"] == "2026-09-06"
    assert len(res["weekly_history"]) == 8


def test_evaluate_region_series_poisson_floor_and_min_count():
    end = date(2026, 9, 6)
    daily = {end.isoformat(): 2}  # no history at all, 2 events
    assert evaluate_region_series(daily, end, 8, 2.5, 3) is None  # below min_count
    daily = {end.isoformat(): 3}
    res = evaluate_region_series(daily, end, 8, 2.5, 3)
    assert res and res["z_score"] == 3.0  # (3-0)/sqrt(max(0,1)) — sparse regions cannot go infinite


def _insert_article(db, *, published: str, violence: int, region: str, url: str) -> int:
    now = utcnow()
    aid = db.execute(
        """INSERT INTO articles (source_id, dedup_key, url, canonical_url, title, language, country_of_publication, reliability,
                                 source_type, region_tag, published_at, discovered_at, fetch_status, is_violence, violence_score,
                                 created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, 'en', 'US', 'established-media', 'newspaper', 'us-tx-border', ?, ?, 'fetched', ?, ?, ?, ?)""",
        ("url:" + url, url, url, "t " + url, published, now, violence, 9.0 if violence else 0.0, now, now),
    )
    db.execute(
        "INSERT INTO article_regions (article_id, region_code, region_type, region_name, country) VALUES (?, ?, 'county', 'Webb County', 'US')",
        (aid, region),
    )
    return aid


def test_detect_news_anomalies_persists_and_lists(db, settings, server):
    upsert_source(db, make_source(server))
    as_of = date(2026, 9, 6)
    for w in range(1, 9):  # one violent story per week in Webb County for 8 weeks
        d = as_of - timedelta(days=7 * w)
        _insert_article(db, published=d.isoformat(), violence=1, region="48479", url=f"https://x/hist{w}")
    for i in range(6):
        day = (as_of - timedelta(days=i)).isoformat()
        _insert_article(db, published=day, violence=1, region="48479", url=f"https://x/spike{i}")  # spike this week
        _insert_article(db, published=day, violence=0, region="48479", url=f"https://x/nv{i}")  # non-violent never counts
        _insert_article(db, published=day, violence=1, region="99999", url=f"https://x/unknown{i}")  # unknown region ignored
    found = detect_news_anomalies(db, settings, as_of=as_of)
    assert len(found) == 1
    a = found[0]
    assert a["metric"] == "violence_reporting_7d" and a["region_code"] == "48479" and a["region_name"] == "Webb County"
    assert a["observed"] == 6 and a["baseline_mean"] == 1.0 and len(a["article_ids"]) == 6
    listed = list_anomalies(db, since="2026-09-01")
    assert len(listed) == 1 and listed[0]["article_ids"] == a["article_ids"] and listed[0]["detail"]["history"] == [1.0] * 8
    detect_news_anomalies(db, settings, as_of=as_of)  # re-run upserts, no duplicates
    assert db.query_one("SELECT COUNT(*) AS n FROM anomalies")["n"] == 1
    assert list_anomalies(db, since="2027-01-01") == []


# --------------------------------------------------------------------------- baseline anomalies


def test_densify_monthly_fills_gaps_with_zero_only_up_to_latest_published():
    recs = [
        {"period_start": "2026-01-01", "value": 2.0, "region_code": "x"},
        {"period_start": "2026-04-01", "value": 5.0, "region_code": "x"},
    ]
    dense = densify_monthly(recs, "2026-05-01")
    assert [(r["period_start"], r["value"]) for r in dense] == [
        ("2026-01-01", 2.0),
        ("2026-02-01", 0.0),
        ("2026-03-01", 0.0),
        ("2026-04-01", 5.0),
        ("2026-05-01", 0.0),
    ]
    assert dense[1]["region_code"] == "x"


@pytest.mark.parametrize(
    "dataset,series,region",
    [
        ("sesnsp_municipal", "homicidio_doloso", ("municipality", "28027", "Nuevo Laredo", "MX")),
        ("cbp_encounters", "encounters", ("cbp_aor", "laredo_field_office", "Laredo Field Office", "US")),
        ("fra_rail_incidents", "rail_equipment_incidents", ("county", "48479", "Webb County", "US")),
    ],
)
def test_detect_baseline_anomalies_on_each_configured_series(db, settings, client, dataset, series, region):
    loader = FraLoader(db, settings, client)
    loader.dataset = dataset  # reuse the generic upsert path for any dataset name
    loader.ensure_registered()
    rtype, code, name, country = region
    months = [f"{2024 + (m // 12)}-{(m % 12) + 1:02d}-01" for m in range(24)]
    recs = [
        BaselineRecord(series, rtype, code, name, country, ps, ps, 10.0 + (i % 3), "n", "https://src", "v") for i, ps in enumerate(months)
    ]
    recs[-1].value = 60.0
    quiet = [BaselineRecord(series, rtype, "quiet", "Quiet", country, ps, ps, 10.0, "n", "https://src", "v") for ps in months]
    loader.upsert_records(recs + quiet)
    found = detect_baseline_anomalies(db, settings, dataset, series)
    assert len(found) == 1
    a = found[0]
    assert a["metric"] == f"{dataset}:{series}" and a["region_code"] == code and a["observed"] == 60.0
    assert a["window_start"] == months[-1] and a["baseline_n"] == 23 and a["severity"] == "critical"
    assert json.loads(db.query_one("SELECT detail_json FROM anomalies")["detail_json"])["history"] == [float(r.value) for r in recs[-13:-1]]
    recs[-1].value = 11.0  # revision downward: re-run keeps the stored row consistent
    loader.upsert_records(recs)
    assert detect_baseline_anomalies(db, settings, dataset, series) == []


def test_detect_baseline_anomalies_requires_history(db, settings, client):
    loader = FraLoader(db, settings, client)
    loader.ensure_registered()
    recs = [
        BaselineRecord("rail_equipment_incidents", "county", "48479", "Webb", "US", f"2026-0{m}-01", f"2026-0{m}-01", v, "n", "u", "v")
        for m, v in zip(range(1, 6), [1, 1, 1, 1, 50])
    ]
    loader.upsert_records(recs)
    assert detect_baseline_anomalies(db, settings, "fra_rail_incidents", "rail_equipment_incidents") == []  # < 7 months
