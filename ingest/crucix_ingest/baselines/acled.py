"""ACLED — optional one-time baseline snapshot (deprioritized).

ACLED's free registered access is capped at a handful of downloads per year, so it
cannot be polled. If an analyst manually downloads an export (CSV or XLSX-converted
CSV) and sets ``INGEST_ACLED_SNAPSHOT_PATH``, this loader ingests it exactly once,
aggregating events and fatalities per admin2 (municipality/county) per month for the
US–Mexico border region. It never contacts acleddata.com.

Expected columns (standard ACLED export): event_date, event_type, sub_event_type,
country, admin1, admin2, fatalities. Files missing them are rejected.
"""

from __future__ import annotations

import csv
import io
import re
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path

from ..geo import default_gazetteer
from .base import BaselineLoader, BaselineRecord, LoadResult, register

BORDER_ADMIN1 = {
    "Mexico": {"Baja California", "Sonora", "Chihuahua", "Coahuila", "Nuevo Leon", "Nuevo León", "Tamaulipas"},
    "United States": {"California", "Arizona", "New Mexico", "Texas"},
}
VIOLENT_EVENT_TYPES = {"Battles", "Violence against civilians", "Explosions/Remote violence"}


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    return re.sub(r"\s+", " ", "".join(c for c in s if not unicodedata.combining(c)).lower()).strip()


def _parse_date(raw: str) -> date | None:
    raw = (raw or "").strip()
    for fmt in ("%Y-%m-%d", "%d %B %Y", "%d-%B-%Y", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def _region_code(country: str, admin1: str, admin2: str) -> tuple[str, str]:
    gaz = default_gazetteer()
    want_country = "MX" if country == "Mexico" else "US"
    target = _fold(admin2)
    for region in gaz.all():
        if region.country != want_country:
            continue
        base = _fold(re.sub(r"\s*\(.*\)$", "", region.name)).replace(" county", "")
        if base == target.replace(" county", ""):
            return region.code, region.type
    return f"acled:{_fold(admin1)}/{target}", "municipality" if want_country == "MX" else "county"


def parse_acled_csv(data: bytes, source_url: str, version: str) -> list[BaselineRecord]:
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    headers = {h.lower(): h for h in (reader.fieldnames or [])}
    needed = ["event_date", "event_type", "country", "admin1", "admin2", "fatalities"]
    if any(n not in headers for n in needed):
        raise ValueError("ACLED export missing required columns: " + ", ".join(n for n in needed if n not in headers))
    agg: dict[tuple[str, str], dict] = {}
    for row in reader:
        country = (row[headers["country"]] or "").strip()
        admin1 = (row[headers["admin1"]] or "").strip()
        if country not in BORDER_ADMIN1 or admin1 not in BORDER_ADMIN1[country]:
            continue
        d = _parse_date(row[headers["event_date"]])
        if not d:
            continue
        admin2 = (row[headers["admin2"]] or "").strip()
        code, rtype = _region_code(country, admin1, admin2)
        ps = d.replace(day=1).isoformat()
        try:
            fat = float(row[headers["fatalities"]] or 0)
        except ValueError:
            fat = 0.0
        e = agg.setdefault(
            (code, ps),
            {
                "name": admin2 or admin1,
                "country": "MX" if country == "Mexico" else "US",
                "type": rtype,
                "events": 0,
                "violent": 0,
                "fatalities": 0.0,
                "by_type": {},
            },
        )
        e["events"] += 1
        et = (row[headers["event_type"]] or "").strip()
        e["by_type"][et] = e["by_type"].get(et, 0) + 1
        if et in VIOLENT_EVENT_TYPES:
            e["violent"] += 1
        e["fatalities"] += fat
    out = []
    for (code, ps), e in agg.items():
        d = date.fromisoformat(ps)
        end = (date(d.year + (d.month // 12), (d.month % 12) + 1, 1) - timedelta(days=1)) if d.month < 12 else date(d.year, 12, 31)
        meta = {"by_type": e["by_type"], "admin_name": e["name"]}
        out.append(
            BaselineRecord(
                "acled_violent_events",
                e["type"],
                code,
                e["name"],
                e["country"],
                ps,
                end.isoformat(),
                float(e["violent"]),
                "events",
                source_url,
                version,
                meta,
            )
        )
        out.append(
            BaselineRecord(
                "acled_fatalities",
                e["type"],
                code,
                e["name"],
                e["country"],
                ps,
                end.isoformat(),
                e["fatalities"],
                "fatalities",
                source_url,
                version,
                {},
            )
        )
    return out


@register
class AcledLoader(BaselineLoader):
    dataset = "acled_snapshot"
    name = "ACLED — one-time manually downloaded baseline snapshot (optional)"
    source_url = "https://acleddata.com/"
    refresh_schedule = "one-time"
    notes = "Deprioritized. Ingested once from INGEST_ACLED_SNAPSHOT_PATH; never fetched automatically (download cap on free access)."

    def load(self) -> LoadResult:
        if not self.settings.acled_snapshot_path:
            return LoadResult(self.dataset, "skipped", error="INGEST_ACLED_SNAPSHOT_PATH not set (optional dataset)")
        p = Path(self.settings.acled_snapshot_path)
        if not p.is_file():
            return LoadResult(self.dataset, "error", error="INGEST_ACLED_SNAPSHOT_PATH does not point to a file")
        data = p.read_bytes()
        digest, _ = self.save_artifact(f"file://{p.name}", data, suffix=".csv")
        if self.known_artifact(f"file://{p.name}", digest) and self.db.query_one(
            "SELECT 1 FROM baseline_records WHERE dataset = ? LIMIT 1", (self.dataset,)
        ):
            return LoadResult(self.dataset, "unchanged", version=digest[:12])
        try:
            records = parse_acled_csv(data, f"file://{p.name}", digest[:12])
        except ValueError as e:
            return LoadResult(self.dataset, "error", error=str(e))
        n = self.upsert_records(records)
        return LoadResult(self.dataset, "updated", records=n, version=digest[:12], detail={"file": p.name, "sha256": digest})
