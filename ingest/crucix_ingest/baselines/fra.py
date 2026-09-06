"""FRA rail accident/incident data (US DOT Socrata open data) — monthly.

Datasets (data.transportation.gov, no key required; column names verified live):
  * 85tf-25kj  Rail Equipment Accident/Incident Data (FRA Form 54)
  * 7wn6-i5b9  Highway-Rail Grade Crossing Accident/Incident Data (FRA Form 57)

We pull the four border states, aggregate per county-month, and keep a per-railroad
breakdown so UP / BNSF / CPKC border corridors can be isolated.
"""

from __future__ import annotations

import json
import urllib.parse
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone

from .base import BaselineLoader, BaselineRecord, LoadResult, register

SOCRATA_BASE = "https://data.transportation.gov/resource"
EQUIPMENT_DATASET = "85tf-25kj"
CROSSING_DATASET = "7wn6-i5b9"
BORDER_STATES = {"TX": "48", "NM": "35", "AZ": "04", "CA": "06"}
STATE_CODES = {"48": "TX", "35": "NM", "04": "AZ", "06": "CA"}
BORDER_RAILROADS = {"UP", "BNSF", "KCS", "KCSM", "CPKC", "CPRS", "TXPF", "TM"}
PAGE_SIZE = 5000
LOOKBACK_MONTHS = 36


def _month_bounds(d: date) -> tuple[str, str]:
    start = d.replace(day=1)
    if start.month == 12:
        end = date(start.year, 12, 31)
    else:
        end = date(start.year, start.month + 1, 1) - timedelta(days=1)
    return start.isoformat(), end.isoformat()


def _to_float(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _county_fips(state_fips: str, county_code: str) -> str:
    return f"{state_fips}{str(county_code or '').strip().zfill(3)}"


def aggregate_equipment(rows: list[dict], source_url: str, version: str) -> list[BaselineRecord]:
    agg: dict[tuple[str, str], dict] = {}
    for r in rows:
        state = (r.get("stateabbr") or "").upper()
        if state not in BORDER_STATES:
            continue
        raw_date = r.get("date") or ""
        try:
            d = datetime.fromisoformat(raw_date.replace("Z", "")).date()
        except ValueError:
            continue
        period_start, period_end = _month_bounds(d)
        code = _county_fips(BORDER_STATES[state], r.get("countycode") or "")
        key = (code, period_start)
        e = agg.setdefault(
            key,
            {
                "name": f"{(r.get('countyname') or '').title()} County",
                "state": state,
                "period_end": period_end,
                "incidents": 0,
                "killed": 0.0,
                "injured": 0.0,
                "hazmat_released_cars": 0.0,
                "damage_usd": 0.0,
                "border_carrier_incidents": 0,
                "by_railroad": defaultdict(int),
                "by_type": defaultdict(int),
            },
        )
        e["incidents"] += 1
        e["killed"] += _to_float(r.get("totalpersonskilled"))
        e["injured"] += _to_float(r.get("totalpersonsinjured"))
        e["hazmat_released_cars"] += _to_float(r.get("hazmatreleasedcars"))
        e["damage_usd"] += _to_float(r.get("totaldamagecost"))
        rr = (r.get("reportingrailroadcode") or "").upper()
        if rr in BORDER_RAILROADS:
            e["border_carrier_incidents"] += 1
        e["by_railroad"][rr or "UNKNOWN"] += 1
        e["by_type"][(r.get("accidenttype") or "unknown")[:60]] += 1
    out: list[BaselineRecord] = []
    for (code, period_start), e in agg.items():
        meta = {
            "state": e["state"],
            "by_railroad": dict(e["by_railroad"]),
            "by_type": dict(e["by_type"]),
            "killed": e["killed"],
            "injured": e["injured"],
            "hazmat_released_cars": e["hazmat_released_cars"],
            "damage_usd": round(e["damage_usd"], 2),
            "border_carrier_incidents": e["border_carrier_incidents"],
        }
        out.append(
            BaselineRecord(
                "rail_equipment_incidents",
                "county",
                code,
                e["name"],
                "US",
                period_start,
                e["period_end"],
                float(e["incidents"]),
                "incidents",
                source_url,
                version,
                meta,
            )
        )
        out.append(
            BaselineRecord(
                "rail_hazmat_release_cars",
                "county",
                code,
                e["name"],
                "US",
                period_start,
                e["period_end"],
                e["hazmat_released_cars"],
                "cars",
                source_url,
                version,
                {"state": e["state"]},
            )
        )
    return out


def aggregate_crossings(rows: list[dict], source_url: str, version: str) -> list[BaselineRecord]:
    agg: dict[tuple[str, str], dict] = {}
    for r in rows:
        state_code = str(r.get("statecode") or "").zfill(2)
        state = STATE_CODES.get(state_code)
        if not state:
            continue
        try:
            y, m = int(r.get("year") or 0), int(r.get("month") or 0)
            d = date(y, m, 1)
        except (TypeError, ValueError):
            continue
        period_start, period_end = _month_bounds(d)
        code = _county_fips(state_code, r.get("countycode") or "")
        key = (code, period_start)
        e = agg.setdefault(
            key,
            {
                "name": f"{(r.get('countyname') or '').title()} County",
                "state": state,
                "period_end": period_end,
                "incidents": 0,
                "killed": 0.0,
                "injured": 0.0,
            },
        )
        e["incidents"] += 1
        e["killed"] += _to_float(r.get("crossinguserskilled")) + _to_float(r.get("employeeskilled"))
        e["injured"] += _to_float(r.get("crossingusersinjured"))
    return [
        BaselineRecord(
            "grade_crossing_incidents",
            "county",
            code,
            e["name"],
            "US",
            ps,
            e["period_end"],
            float(e["incidents"]),
            "incidents",
            source_url,
            version,
            {"state": e["state"], "killed": e["killed"], "injured": e["injured"]},
        )
        for (code, ps), e in agg.items()
    ]


@register
class FraLoader(BaselineLoader):
    dataset = "fra_rail_incidents"
    name = "FRA Rail Accident/Incident Data (Form 54 + Form 57)"
    source_url = f"https://data.transportation.gov/d/{EQUIPMENT_DATASET}"
    refresh_schedule = "monthly"
    notes = "US DOT Socrata open data; border states TX/NM/AZ/CA aggregated per county-month with railroad breakdown (UP, BNSF, CPKC)."

    def _page(self, dataset: str, where: str, order: str, offset: int) -> tuple[list | None, str | None, str]:
        params = {"$where": where, "$order": order, "$limit": PAGE_SIZE, "$offset": offset}
        url = f"{SOCRATA_BASE}/{dataset}.json?{urllib.parse.urlencode(params)}"
        res = self.http.fetch(url, accept="application/json", max_bytes=100_000_000)
        if not res.ok:
            return None, f"HTTP {res.status}", url
        try:
            return json.loads(res.body.decode("utf-8")), None, url
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            return None, f"json error {str(e)[:100]}", url

    def _fetch_all(self, dataset: str, where: str, order: str) -> tuple[list[dict], str | None]:
        rows: list[dict] = []
        offset = 0
        while True:
            page, err, _ = self._page(dataset, where, order, offset)
            if err:
                return rows, err
            page = page or []
            rows.extend(page)
            if len(page) < PAGE_SIZE or offset > 200_000:
                return rows, None
            offset += PAGE_SIZE

    def load(self) -> LoadResult:
        since = (datetime.now(timezone.utc).date().replace(day=1) - timedelta(days=LOOKBACK_MONTHS * 31)).replace(day=1)
        version = datetime.now(timezone.utc).strftime("%Y-%m")
        states_sql = ",".join(f"'{s}'" for s in BORDER_STATES)
        eq_rows, err = self._fetch_all(
            EQUIPMENT_DATASET, f"date >= '{since.isoformat()}T00:00:00' AND stateabbr in({states_sql})", "date ASC"
        )
        if err and not eq_rows:
            return LoadResult(self.dataset, "blocked" if "403" in err else "error", error=f"equipment dataset: {err}")
        codes_sql = ",".join(f"'{c}'" for c in STATE_CODES)
        cr_rows, err2 = self._fetch_all(CROSSING_DATASET, f"year >= '{since.year}' AND statecode in({codes_sql})", "year ASC, month ASC")
        eq_url = f"{SOCRATA_BASE}/{EQUIPMENT_DATASET}.json"
        cr_url = f"{SOCRATA_BASE}/{CROSSING_DATASET}.json"
        records = aggregate_equipment(eq_rows, eq_url, version)
        records += aggregate_crossings(cr_rows, cr_url, version)
        n = self.upsert_records(records)
        self.save_artifact(eq_url, json.dumps(eq_rows).encode("utf-8"), suffix=".json")
        detail = {"equipment_rows": len(eq_rows), "crossing_rows": len(cr_rows), "since": since.isoformat()}
        if err2:
            detail["crossing_error"] = err2
        return LoadResult(self.dataset, "updated", records=n, version=version, detail=detail)
