"""Common contract for baseline dataset loaders.

A loader is responsible for one dataset. It knows its refresh cadence, how to
discover/download the latest publication, and how to normalise it into
:class:`BaselineRecord` rows. Everything else (scheduling, persistence, status
bookkeeping, artifact hashing) is handled here so loaders stay small.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ..config import Settings
from ..db import Database, utcnow
from ..http_client import PoliteHttpClient, RobotsDisallowedError
from ..logging_utils import log_event

logger = logging.getLogger(__name__)

SCHEDULE_HOURS = {"weekly": 7 * 24, "monthly": 30 * 24, "quarterly": 91 * 24, "one-time": 10**6}


@dataclass
class BaselineRecord:
    series: str
    region_type: str
    region_code: str
    region_name: str
    country: str
    period_start: str  # YYYY-MM-DD
    period_end: str  # YYYY-MM-DD
    value: float | None
    unit: str
    source_url: str
    source_version: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class LoadResult:
    dataset: str
    status: str  # updated | unchanged | blocked | error | skipped
    records: int = 0
    version: str | None = None
    error: str | None = None
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "dataset": self.dataset,
            "status": self.status,
            "records": self.records,
            "version": self.version,
            "error": self.error,
            "detail": self.detail,
        }


class BaselineLoader:
    dataset: str = ""
    name: str = ""
    source_url: str = ""
    refresh_schedule: str = "monthly"
    notes: str = ""

    def __init__(self, db: Database, settings: Settings, http: PoliteHttpClient):
        self.db = db
        self.settings = settings
        self.http = http

    # -- to implement -----------------------------------------------------
    def load(self) -> LoadResult:  # pragma: no cover - abstract
        raise NotImplementedError

    # -- helpers ----------------------------------------------------------
    @property
    def refresh_interval_hours(self) -> int:
        return SCHEDULE_HOURS.get(self.refresh_schedule, 30 * 24)

    def ensure_registered(self) -> None:
        with self.db.transaction() as cur:
            cur.execute(
                """INSERT INTO baseline_datasets (dataset, name, source_url, refresh_schedule, refresh_interval_hours, notes)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(dataset) DO UPDATE SET name=excluded.name, source_url=excluded.source_url,
                     refresh_schedule=excluded.refresh_schedule, refresh_interval_hours=excluded.refresh_interval_hours,
                     notes=excluded.notes""",
                (self.dataset, self.name, self.source_url, self.refresh_schedule, self.refresh_interval_hours, self.notes),
            )

    def is_due(self, now: datetime | None = None) -> bool:
        row = self.db.query_one("SELECT last_checked_at, last_status FROM baseline_datasets WHERE dataset = ?", (self.dataset,))
        if row is None or not row["last_checked_at"]:
            return True
        if self.refresh_schedule == "one-time" and row["last_status"] == "updated":
            return False
        last = datetime.fromisoformat(row["last_checked_at"])
        now = now or datetime.now(timezone.utc)
        interval = timedelta(hours=self.refresh_interval_hours)
        if row["last_status"] in ("error", "blocked", "robots_blocked"):
            interval = min(interval, timedelta(hours=24))  # retry failures daily
        return now - last >= interval

    def artifact_dir(self) -> Path:
        d = Path(self.settings.snapshot_dir) / "baselines" / self.dataset
        d.mkdir(parents=True, exist_ok=True)
        return d

    def known_artifact(self, url: str, sha256: str) -> bool:
        return (
            self.db.query_one("SELECT 1 FROM baseline_artifacts WHERE dataset = ? AND url = ? AND sha256 = ?", (self.dataset, url, sha256))
            is not None
        )

    def save_artifact(
        self, url: str, body: bytes, etag: str | None = None, last_modified: str | None = None, suffix: str = ".bin"
    ) -> tuple[str, Path]:
        digest = hashlib.sha256(body).hexdigest()
        path = self.artifact_dir() / f"{digest[:24]}{suffix}.gz"
        if not path.exists():
            with gzip.open(path, "wb") as fh:
                fh.write(body)
        with self.db.transaction() as cur:
            cur.execute(
                """INSERT OR IGNORE INTO baseline_artifacts (dataset, url, path, sha256, bytes, etag, last_modified, retrieved_at)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (self.dataset, url[:2048], str(path), digest, len(body), etag, last_modified, utcnow()),
            )
        return digest, path

    def upsert_records(self, records: Iterable[BaselineRecord]) -> int:
        now = utcnow()
        n = 0
        with self.db.transaction() as cur:
            for r in records:
                cur.execute(
                    """INSERT INTO baseline_records (dataset, series, region_type, region_code, region_name, country, period_start,
                                                     period_end, value, unit, metadata_json, source_url, source_version, retrieved_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(dataset, series, region_type, region_code, period_start) DO UPDATE SET
                         period_end=excluded.period_end, value=excluded.value, unit=excluded.unit, region_name=excluded.region_name,
                         metadata_json=excluded.metadata_json, source_url=excluded.source_url,
                         source_version=excluded.source_version, retrieved_at=excluded.retrieved_at""",
                    (
                        self.dataset,
                        r.series,
                        r.region_type,
                        r.region_code,
                        r.region_name[:200],
                        r.country,
                        r.period_start,
                        r.period_end,
                        r.value,
                        r.unit,
                        json.dumps(r.metadata, ensure_ascii=False, default=str)[:4000],
                        r.source_url[:2048],
                        r.source_version,
                        now,
                    ),
                )
                n += 1
        return n

    def record_status(self, result: LoadResult) -> None:
        now = utcnow()
        count_row = self.db.query_one("SELECT COUNT(*) AS n FROM baseline_records WHERE dataset = ?", (self.dataset,))
        with self.db.transaction() as cur:
            if result.status == "updated":
                cur.execute(
                    """UPDATE baseline_datasets SET last_checked_at=?, last_updated_at=?, last_status=?, last_error=NULL,
                              version=COALESCE(?, version), record_count=? WHERE dataset=?""",
                    (now, now, result.status, result.version, int(count_row["n"]) if count_row else 0, self.dataset),
                )
            else:
                cur.execute(
                    """UPDATE baseline_datasets SET last_checked_at=?, last_status=?, last_error=?, record_count=? WHERE dataset=?""",
                    (now, result.status, (result.error or "")[:500] or None, int(count_row["n"]) if count_row else 0, self.dataset),
                )
        log_event(logger, "baseline_load", **result.to_dict())


# ---------------------------------------------------------------------------
# loader registry
# ---------------------------------------------------------------------------
_LOADERS: dict[str, Callable[[Database, Settings, PoliteHttpClient], BaselineLoader]] = {}


def register(cls):
    _LOADERS[cls.dataset] = cls
    return cls


def all_loaders(db: Database, settings: Settings, http: PoliteHttpClient) -> list[BaselineLoader]:
    _import_builtin_loaders()
    return [factory(db, settings, http) for factory in _LOADERS.values()]


def get_loader(name: str, db: Database, settings: Settings, http: PoliteHttpClient) -> BaselineLoader | None:
    _import_builtin_loaders()
    factory = _LOADERS.get(name)
    return factory(db, settings, http) if factory else None


def run_loader(loader: BaselineLoader) -> LoadResult:
    loader.ensure_registered()
    try:
        result = loader.load()
    except RobotsDisallowedError as e:
        log_event(logger, "baseline_robots_blocked", logging.WARNING, dataset=loader.dataset, url=str(e)[:300])
        result = LoadResult(dataset=loader.dataset, status="robots_blocked", error="robots.txt disallows artifact URL")
    except Exception as e:
        log_event(
            logger,
            "baseline_loader_crashed",
            logging.ERROR,
            dataset=loader.dataset,
            error_type=type(e).__name__,
            error=str(e)[:300],
        )
        result = LoadResult(dataset=loader.dataset, status="error", error="internal error")
    loader.record_status(result)
    return result


def run_due_loaders(db: Database, settings: Settings, http: PoliteHttpClient, force: bool = False) -> list[LoadResult]:
    results = []
    for loader in all_loaders(db, settings, http):
        loader.ensure_registered()
        if force or loader.is_due():
            results.append(run_loader(loader))
    return results


def _import_builtin_loaders() -> None:
    # Importing is idempotent; never short-circuit on a partially populated registry
    # (a caller may have imported one loader module directly before asking for all of them).
    from . import acled, cbp, fra, insightcrime, justiceinmexico, sesnsp  # noqa: F401
