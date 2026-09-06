"""Baseline/anomaly engine.

For every border region we count violence-tagged articles per UTC day, build a
trailing baseline (default 8 weeks, excluding the current window) and flag windows
whose 7-day count is far above the baseline (z-score on weekly totals, with a
minimum absolute count so single-article regions never alarm).

Structured baselines (SESNSP homicides, CBP encounters, FRA incidents) are compared
the same way month-over-month against their own trailing history.
"""

from __future__ import annotations

import json
import logging
import math
from datetime import date, datetime, timedelta, timezone

from .config import Settings
from .db import Database, utcnow
from .geo import default_gazetteer
from .logging_utils import log_event

logger = logging.getLogger(__name__)

WINDOW_DAYS = 7


def _mean_std(values: list[float]) -> tuple[float, float]:
    if not values:
        return 0.0, 0.0
    n = len(values)
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / (n - 1) if n > 1 else 0.0
    return mean, math.sqrt(var)


def _severity(z: float, observed: float, mean: float) -> str:
    if z >= 5 or (mean > 0 and observed >= mean * 4):
        return "critical"
    if z >= 3.5:
        return "elevated"
    return "watch"


def daily_violence_counts(db: Database, since: date, until: date) -> dict[str, dict[str, int]]:
    """{region_code: {YYYY-MM-DD: count}} for violence-tagged articles, deduplicated per article."""
    rows = db.query(
        """SELECT ar.region_code, substr(COALESCE(a.published_at, a.discovered_at), 1, 10) AS day, COUNT(DISTINCT a.id) AS n
           FROM articles a JOIN article_regions ar ON ar.article_id = a.id
           WHERE a.is_violence = 1
             AND substr(COALESCE(a.published_at, a.discovered_at), 1, 10) >= ?
             AND substr(COALESCE(a.published_at, a.discovered_at), 1, 10) <= ?
           GROUP BY ar.region_code, day""",
        (since.isoformat(), until.isoformat()),
    )
    out: dict[str, dict[str, int]] = {}
    for r in rows:
        out.setdefault(r["region_code"], {})[r["day"]] = int(r["n"])
    return out


def evaluate_region_series(
    daily: dict[str, int],
    window_end: date,
    baseline_weeks: int,
    z_threshold: float,
    min_count: int,
) -> dict | None:
    """Compare the trailing 7-day window against the preceding `baseline_weeks` weekly totals."""
    window_start = window_end - timedelta(days=WINDOW_DAYS - 1)
    observed = sum(daily.get((window_start + timedelta(days=i)).isoformat(), 0) for i in range(WINDOW_DAYS))
    weekly: list[float] = []
    for w in range(1, baseline_weeks + 1):
        ws = window_start - timedelta(days=WINDOW_DAYS * w)
        weekly.append(float(sum(daily.get((ws + timedelta(days=i)).isoformat(), 0) for i in range(WINDOW_DAYS))))
    mean, std = _mean_std(weekly)
    # Poisson floor keeps sparse regions from producing infinite z-scores.
    effective_std = max(std, math.sqrt(max(mean, 1.0)))
    z = (observed - mean) / effective_std if effective_std > 0 else 0.0
    result = {
        "window_start": window_start.isoformat(),
        "window_end": window_end.isoformat(),
        "observed": observed,
        "baseline_mean": round(mean, 3),
        "baseline_std": round(std, 3),
        "baseline_n": len(weekly),
        "z_score": round(z, 3),
        "weekly_history": weekly,
    }
    if observed >= min_count and z >= z_threshold and observed > mean:
        result["severity"] = _severity(z, observed, mean)
        return result
    return None


def detect_news_anomalies(db: Database, settings: Settings, as_of: date | None = None) -> list[dict]:
    as_of = as_of or datetime.now(timezone.utc).date()
    lookback_days = WINDOW_DAYS * (settings.anomaly_baseline_weeks + 1)
    counts = daily_violence_counts(db, as_of - timedelta(days=lookback_days), as_of)
    gaz = default_gazetteer()
    found: list[dict] = []
    for code, daily in counts.items():
        region = gaz.get(code)
        if region is None:
            continue
        res = evaluate_region_series(daily, as_of, settings.anomaly_baseline_weeks, settings.anomaly_z_threshold, settings.anomaly_min_count)
        if not res:
            continue
        article_rows = db.query(
            """SELECT DISTINCT a.id FROM articles a JOIN article_regions ar ON ar.article_id = a.id
               WHERE ar.region_code = ? AND a.is_violence = 1
                 AND substr(COALESCE(a.published_at, a.discovered_at), 1, 10) BETWEEN ? AND ?
               ORDER BY a.id DESC LIMIT 50""",
            (code, res["window_start"], res["window_end"]),
        )
        record = {
            "metric": "violence_reporting_7d",
            "region_type": region.type,
            "region_code": region.code,
            "region_name": region.name,
            "country": region.country,
            **res,
            "article_ids": [int(r["id"]) for r in article_rows],
        }
        _store_anomaly(db, record)
        found.append(record)
    log_event(logger, "news_anomaly_scan", regions_scanned=len(counts), anomalies=len(found), as_of=as_of.isoformat())
    return found


def detect_baseline_anomalies(db: Database, settings: Settings, dataset: str, series: str, months: int = 24) -> list[dict]:
    """Month-over-history anomaly scan for a structured baseline series (per region)."""
    rows = db.query(
        """SELECT region_type, region_code, region_name, country, period_start, value
           FROM baseline_records WHERE dataset = ? AND series = ? AND value IS NOT NULL
           ORDER BY region_code, period_start""",
        (dataset, series),
    )
    by_region: dict[str, list] = {}
    for r in rows:
        by_region.setdefault(r["region_code"], []).append(r)
    found: list[dict] = []
    for code, recs in by_region.items():
        recs = recs[-(months + 1):]
        if len(recs) < 7:
            continue
        latest = recs[-1]
        history = [float(x["value"]) for x in recs[:-1]]
        mean, std = _mean_std(history)
        effective_std = max(std, math.sqrt(max(mean, 1.0)))
        observed = float(latest["value"])
        z = (observed - mean) / effective_std if effective_std else 0.0
        if observed >= settings.anomaly_min_count and z >= settings.anomaly_z_threshold and observed > mean:
            record = {
                "metric": f"{dataset}:{series}",
                "region_type": latest["region_type"],
                "region_code": code,
                "region_name": latest["region_name"],
                "country": latest["country"],
                "window_start": latest["period_start"],
                "window_end": latest["period_start"],
                "observed": observed,
                "baseline_mean": round(mean, 3),
                "baseline_std": round(std, 3),
                "baseline_n": len(history),
                "z_score": round(z, 3),
                "severity": _severity(z, observed, mean),
                "article_ids": [],
                "weekly_history": history[-12:],
            }
            _store_anomaly(db, record)
            found.append(record)
    log_event(logger, "baseline_anomaly_scan", dataset=dataset, series=series, regions=len(by_region), anomalies=len(found))
    return found


def _store_anomaly(db: Database, rec: dict) -> None:
    with db.transaction() as cur:
        cur.execute(
            """INSERT INTO anomalies (detected_at, metric, region_type, region_code, region_name, country, window_start, window_end,
                                      observed, baseline_mean, baseline_std, baseline_n, z_score, severity, article_ids_json, detail_json)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(metric, region_code, window_start) DO UPDATE SET
                 detected_at=excluded.detected_at, window_end=excluded.window_end, observed=excluded.observed,
                 baseline_mean=excluded.baseline_mean, baseline_std=excluded.baseline_std, baseline_n=excluded.baseline_n,
                 z_score=excluded.z_score, severity=excluded.severity, article_ids_json=excluded.article_ids_json,
                 detail_json=excluded.detail_json""",
            (
                utcnow(), rec["metric"], rec["region_type"], rec["region_code"], rec["region_name"], rec["country"],
                rec["window_start"], rec["window_end"], rec["observed"], rec["baseline_mean"], rec["baseline_std"],
                rec["baseline_n"], rec["z_score"], rec["severity"], json.dumps(rec.get("article_ids", [])),
                json.dumps({"history": rec.get("weekly_history", [])}),
            ),
        )


def list_anomalies(db: Database, limit: int = 100, since: str | None = None) -> list[dict]:
    limit = max(1, min(int(limit), 500))
    if since:
        rows = db.query("SELECT * FROM anomalies WHERE window_end >= ? ORDER BY z_score DESC, detected_at DESC LIMIT ?", (since, limit))
    else:
        rows = db.query("SELECT * FROM anomalies ORDER BY detected_at DESC, z_score DESC LIMIT ?", (limit,))
    out = []
    for r in rows:
        d = dict(r)
        d["article_ids"] = json.loads(d.pop("article_ids_json") or "[]")
        d["detail"] = json.loads(d.pop("detail_json") or "{}")
        out.append(d)
    return out
