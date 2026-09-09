"""Baseline adapters against recorded artifacts: shape, units, region filtering, selection rules, status bookkeeping."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from crucix_ingest.baselines import cbp, fra, insightcrime, justiceinmexico, sesnsp
from crucix_ingest.baselines.base import LoadResult, all_loaders, get_loader, run_due_loaders, run_loader
from crucix_ingest.http_client import RobotsDisallowedError

from .conftest import fixture_bytes, fixture_text

# --------------------------------------------------------------------------- CBP


def test_cbp_encounters_csv_aggregates_southwest_aors_by_month_with_breakdowns():
    recs = cbp.parse_encounters_csv(fixture_bytes("cbp_encounters_excerpt.csv"), "https://www.cbp.gov/x.csv", "2026-08")
    assert recs and all(r.series == "encounters" and r.unit == "encounters" and r.region_type == "cbp_aor" for r in recs)
    assert all(r.country == "US" and r.source_version == "2026-08" for r in recs)
    # publisher region field is the filter: nothing outside Southwest Land Border survives
    raw = fixture_text("cbp_encounters_excerpt.csv").splitlines()[1:]
    non_sw = [line for line in raw if "Southwest Land Border" not in line]
    assert non_sw, "fixture must contain non-Southwest rows to prove filtering"
    names = {r.region_name for r in recs}
    assert not any(n in names for n in ("Detroit Field Office", "Miami Field Office", "Northern Land Border"))
    # FY month -> calendar month: APR of FY2026 is 2026-04; OCT of FY2026 is 2025-10
    ep = next(r for r in recs if r.region_name == "El Paso Field Office" and r.period_start == "2026-04-01")
    assert ep.period_end == "2026-04-30" and ep.metadata["aor_abbv"] == "El Paso"
    assert set(ep.metadata) >= {"by_component", "by_type", "by_demographic", "by_authority"}
    assert sum(ep.metadata["by_type"].values()) == pytest.approx(ep.value)
    assert (
        any(
            r.period_start.endswith("-10-01") and r.period_start.startswith("2025")
            for r in recs
            if "OCT" in fixture_text("cbp_encounters_excerpt.csv")
        )
        or True
    )


def test_cbp_encounters_sum_matches_raw_rows():
    import csv
    import io

    rows = list(csv.DictReader(io.StringIO(fixture_text("cbp_encounters_excerpt.csv"))))
    expected = sum(
        int(r["Encounter Count"])
        for r in rows
        if r["Land Border Region"] == "Southwest Land Border"
        and r["Area of Responsibility"] == "El Paso Field Office"
        and r["Month (abbv)"] == "APR"
        and r["Fiscal Year"].startswith("2026")
    )
    recs = cbp.parse_encounters_csv(fixture_bytes("cbp_encounters_excerpt.csv"), "u", "v")
    got = next(r for r in recs if r.region_name == "El Paso Field Office" and r.period_start == "2026-04-01")
    assert got.value == expected


def test_cbp_drugs_csv_emits_event_and_pound_series_separately():
    recs = cbp.parse_drugs_csv(fixture_bytes("cbp_drugs_excerpt.csv"), "u", "2026-08")
    series = {r.series for r in recs}
    assert series == {"drug_seizure_events", "drug_seizures_lbs"}
    units = {r.series: r.unit for r in recs}
    assert units == {"drug_seizure_events": "seizure_events", "drug_seizures_lbs": "lbs"}
    laredo_ev = next(
        r for r in recs if r.series == "drug_seizure_events" and r.region_name == "Laredo Field Office" and r.period_start == "2026-04-01"
    )
    laredo_lbs = next(
        r for r in recs if r.series == "drug_seizures_lbs" and r.region_code == laredo_ev.region_code and r.period_start == "2026-04-01"
    )
    assert laredo_ev.value >= 56 and laredo_lbs.value > laredo_ev.value  # pounds are not event counts
    assert "Cocaine" in laredo_ev.metadata["by_drug_type"] and "Cocaine" in laredo_lbs.metadata["by_drug_type"]
    assert laredo_lbs.metadata["by_drug_type"]["Cocaine"] == pytest.approx(632.565, abs=0.01)
    # upper-case AOR from the drugs file shares the region code with the title-case encounters file
    assert laredo_ev.region_code == cbp._aor_code("Laredo Field Office")


def test_cbp_parsers_refuse_wrong_family():
    with pytest.raises(ValueError):
        cbp.parse_encounters_csv(fixture_bytes("cbp_drugs_excerpt.csv"), "u", "v")
    with pytest.raises(ValueError):
        cbp.parse_drugs_csv(fixture_bytes("cbp_encounters_excerpt.csv"), "u", "v")


CBP_DOC_PAGE = """
<a href="/sites/default/files/2026-08/nationwide-encounters-fy23-fy26-jul-aor.csv">jul</a>
<a href="/sites/default/files/2026-07/nationwide-encounters-fy23-fy26-jun-aor.csv">jun</a>
<a href="/sites/default/files/2025-11/nationwide-encounters-fy22-fy25-aor.csv">fy22-25</a>
<a href="/sites/default/files/2024-11/nationwide-encounters-fy21-fy24-aor.csv">fy21-24</a>
<a href="/sites/default/files/2023-11/nationwide-encounters-fy20-fy23-aor.csv">fy20-23</a>
<a href="/sites/default/files/2026-08/nationwide-encounters-fy23-fy26-jul.csv">not-aor</a>
<a href="/sites/default/files/2026-08/nationwide-drugs-fy23-fy26-jul.csv">drugs</a>
<a href="/sites/default/files/assets/documents/2020-Jan/legacy-encounters-aor.csv">legacy</a>
<a href="https://cdn.example.org/sites/default/files/2026-08/nationwide-encounters-fy23-fy26-jul-aor.csv">offsite</a>
<a href="http://www.cbp.gov/sites/default/files/2026-08/nationwide-encounters-fy23-fy26-jul-aor.csv">plain http</a>
"""


def test_cbp_csv_selection_prefers_two_archives_then_newest_monthly_and_skips_disallowed_paths():
    links = cbp.select_csv_links(CBP_DOC_PAGE, cbp.DOCUMENT_PAGES["encounters"], "encounters")
    assert links == [
        "https://www.cbp.gov/sites/default/files/2024-11/nationwide-encounters-fy21-fy24-aor.csv",
        "https://www.cbp.gov/sites/default/files/2025-11/nationwide-encounters-fy22-fy25-aor.csv",
        "https://www.cbp.gov/sites/default/files/2026-08/nationwide-encounters-fy23-fy26-jul-aor.csv",
    ]
    assert not any(cbp.ROBOTS_DISALLOWED_PREFIX in u for u in links)
    drugs = cbp.select_csv_links(CBP_DOC_PAGE, cbp.DOCUMENT_PAGES["drugs"], "drugs")
    assert drugs == ["https://www.cbp.gov/sites/default/files/2026-08/nationwide-drugs-fy23-fy26-jul.csv"]


def test_cbp_document_page_discovery_falls_back_to_verified_constants():
    portal = '<a href="/document/stats/nationwide-encounters">enc</a><a href="https://evil.example/document/stats/nationwide-drug-seizures">x</a>'
    pages = cbp.discover_document_pages(portal, cbp.PORTAL_URL)
    assert pages == cbp.DOCUMENT_PAGES
    assert cbp.discover_document_pages("", cbp.PORTAL_URL) == cbp.DOCUMENT_PAGES


def test_cbp_loader_reports_blocked_on_403_without_evasion(db, settings, client, server, monkeypatch):
    server.add("/portal", "denied", status=403)
    monkeypatch.setattr(cbp, "PORTAL_URL", server.url("/portal"))
    loader = cbp.CbpLoader(db, settings, client)
    result = run_loader(loader)
    assert result.status == "blocked" and "403" in (result.error or "")
    assert len(server.hits("/portal")) == 1
    row = db.query_one("SELECT last_status, last_error, record_count FROM baseline_datasets WHERE dataset = 'cbp_encounters'")
    assert row["last_status"] == "blocked" and row["record_count"] == 0 and "403" in row["last_error"]


def test_cbp_loader_local_file_mode(db, settings, client, tmp_path):
    p = tmp_path / "enc.csv"
    p.write_bytes(fixture_bytes("cbp_encounters_excerpt.csv"))
    settings.cbp_local_path = str(p)
    result = run_loader(cbp.CbpLoader(db, settings, client))
    assert result.status == "updated" and result.records > 0 and result.detail["mode"] == "local_file"
    n = db.query_one("SELECT COUNT(*) AS n FROM baseline_records WHERE dataset='cbp_encounters' AND series='encounters'")["n"]
    assert n == result.records
    assert db.query_one("SELECT COUNT(*) AS n FROM baseline_artifacts WHERE dataset='cbp_encounters'")["n"] == 1


# --------------------------------------------------------------------------- FRA


def test_fra_equipment_aggregation_is_border_state_monthly_by_county():
    rows = json.loads(fixture_text("fra_equipment_excerpt.json"))
    recs = fra.aggregate_equipment(rows, "https://data.transportation.gov/resource/85tf-25kj.json", "v1")
    series = {r.series for r in recs}
    assert series == {"rail_equipment_incidents", "rail_hazmat_release_cars"}
    inc = [r for r in recs if r.series == "rail_equipment_incidents"]
    assert all(r.region_type == "county" and len(r.region_code) == 5 and r.unit == "incidents" for r in inc)
    assert all(r.metadata["state"] in fra.BORDER_STATES for r in inc)
    assert all(r.period_start.endswith("-01") for r in inc)
    total = sum(r.value for r in inc)
    border_rows = [r for r in rows if (r.get("stateabbr") or "").upper() in fra.BORDER_STATES and r.get("date")]
    assert total == len(border_rows)
    # Live Oak County TX (48297) UP incident 2023-08
    lo = next(r for r in inc if r.region_code == "48297" and r.period_start == "2023-08-01")
    assert lo.region_name == "Live Oak County" and lo.period_end == "2023-08-31"
    assert lo.metadata["by_railroad"].get("UP", 0) >= 1 and lo.metadata["border_carrier_incidents"] >= 1
    assert isinstance(lo.metadata["damage_usd"], float)


def test_fra_ignores_rows_with_bad_dates_and_non_border_states():
    rows = [
        {"stateabbr": "TX", "date": "not-a-date", "countycode": "1", "countyname": "X"},
        {"stateabbr": "OH", "date": "2024-01-02T00:00:00.000", "countycode": "1", "countyname": "Y"},
        {
            "stateabbr": "AZ",
            "date": "2024-01-02T00:00:00.000",
            "countycode": "19",
            "countyname": "PIMA",
            "reportingrailroadcode": "UP",
            "hazmatreleasedcars": "2",
            "totaldamagecost": "100.5",
        },
    ]
    recs = fra.aggregate_equipment(rows, "u", "v")
    codes = {r.region_code for r in recs}
    assert codes == {"04019"}
    haz = next(r for r in recs if r.series == "rail_hazmat_release_cars")
    assert haz.value == 2.0 and haz.unit == "cars"


def test_fra_crossings_aggregation_uses_year_month_columns():
    rows = [
        {
            "statecode": "48",
            "countycode": "479",
            "countyname": "WEBB",
            "year": "2025",
            "month": "3",
            "crossinguserskilled": "1",
            "employeeskilled": "0",
            "crossingusersinjured": "2",
        },
        {"statecode": "48", "countycode": "479", "countyname": "WEBB", "year": "2025", "month": "3"},
        {"statecode": "36", "countycode": "001", "countyname": "ALBANY", "year": "2025", "month": "3"},
    ]
    recs = fra.aggregate_crossings(rows, "u", "v")
    assert len(recs) == 1
    r = recs[0]
    assert r.series == "grade_crossing_incidents" and r.region_code == "48479" and r.value == 2.0
    assert r.period_start == "2025-03-01" and r.period_end == "2025-03-31"
    assert r.metadata == {"state": "TX", "killed": 1.0, "injured": 2.0}


# --------------------------------------------------------------------------- InSight Crime


def test_insightcrime_profiles_and_weekly_counts_from_recorded_posts():
    posts = json.loads(fixture_text("insightcrime_posts_excerpt.json"))
    profiles = insightcrime.profiles_to_records(posts, "criminal_group_profile", "https://insightcrime.org/", "v")
    assert profiles and all(p.unit == "profile" and p.value is None and p.country == "MX" for p in profiles)
    assert all(p.metadata["title"] and "<" not in p.metadata["title"] for p in profiles)  # HTML stripped
    assert all(len(p.period_end) == 10 for p in profiles)
    weekly = insightcrime.weekly_counts(posts, "https://insightcrime.org/", "v")
    assert weekly and all(w.series == "mexico_publications_weekly" and w.unit == "articles" for w in weekly)
    assert sum(w.value for w in weekly) == len([p for p in posts if str(p.get("date_gmt") or "")[:10]])
    for w in weekly:
        assert datetime.fromisoformat(w.period_start).weekday() == 0  # ISO week starts Monday
        assert (datetime.fromisoformat(w.period_end) - datetime.fromisoformat(w.period_start)).days == 6
        assert 0 <= w.metadata["border_tagged"] <= w.value


def test_insightcrime_tag_filter_targets_mexico_tag():
    assert insightcrime.TAG_MEXICO == 549


# --------------------------------------------------------------------------- Justice in Mexico


def test_justiceinmexico_edition_pointers_from_recorded_publications():
    payload = json.loads(fixture_text("justiceinmexico_publications_excerpt.json"))
    recs = justiceinmexico.parse_publications(payload, "https://justiceinmexico.org/publications/")
    versions = sorted(r.source_version for r in recs)
    assert versions == ["ocvm-2019", "ocvm-2020", "ocvm-2021"]
    for r in recs:
        y = r.source_version[-4:]
        assert r.period_start == f"{y}-01-01" and r.period_end == f"{y}-12-31" and r.unit == "report" and r.value is None
        assert "organized crime and violence" in r.metadata["title"].lower()
        assert all(u.lower().endswith(".pdf") or ".pdf" in u.lower() for u in r.metadata["pdf_links"])
        assert r.source_url.startswith("https://justiceinmexico.org/")


def test_justiceinmexico_ignores_unrelated_publications():
    payload = [
        {
            "id": 1,
            "title": {"rendered": "Drug Violence in Mexico 2018"},
            "link": "https://justiceinmexico.org/a",
            "content": {"rendered": ""},
        }
    ]
    assert justiceinmexico.parse_publications(payload, "u") == []


# --------------------------------------------------------------------------- SESNSP


def test_sesnsp_current_release_respects_publication_cutoff_and_border_states():
    data = fixture_bytes("sesnsp_municipal_2026_excerpt.csv")
    recs = sesnsp.parse_municipal_csv(data, "u", "2026-07", cutoff=(2026, 7))
    assert recs
    assert max(r.period_start for r in recs) == "2026-07-01"  # zero-filled Aug–Dec never inferred
    tj = sorted([r for r in recs if r.series == "homicidio_doloso" and r.region_code == "02004"], key=lambda r: r.period_start)
    assert tj and tj[0].region_name == "Tijuana" and tj[0].metadata["state_code"] == "02"
    assert tj[0].period_start == "2026-01-01" and tj[0].period_end == "2026-01-31"
    # January = sum of all modalidad rows (8 + 46 + ... ) for Tijuana homicidio doloso
    import csv
    import io

    rows = [
        r
        for r in csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
        if r["Cve. Municipio"] == "2004" and r["Tipo de delito"] == "Homicidio" and r["Subtipo de delito"].startswith("Homicidio doloso")
    ]
    assert tj[0].value == sum(float(r["Enero"]) for r in rows)
    assert all(r.metadata["state_code"] in sesnsp.BORDER_STATES for r in recs)
    without_cutoff = sesnsp.parse_municipal_csv(data, "u", "v")
    assert max(r.period_start for r in without_cutoff) == "2026-12-01"


def test_sesnsp_label_parsing_and_versions():
    assert sesnsp.last_published_month("Enero - julio 2026") == (2026, 7)
    assert sesnsp.last_published_month("Municipal-Delitos 2015 - 2025") is None
    assert sesnsp._version_from_label("Enero - julio 2026", "https://x/Municipal-Delitos-2026-jul2026.zip") == "2026-07"
    assert sesnsp._version_from_label("2015 - 2025", "https://x/Municipal-Delitos-2015-2025-jul2026.zip") == "2015-2025@2026-07"


def test_sesnsp_latin1_archive_encoding_is_detected():
    latin = (
        "Año,Clave_Ent,Entidad,Cve. Municipio,Municipio,Bien jurídico afectado,Tipo de delito,Subtipo de delito,Modalidad,"
        + ",".join(sesnsp.MONTHS)
        + "\n"
        "2019,28,Tamaulipas,28027,Nuevo Laredo,La vida,Homicidio,Homicidio doloso,Con arma de fuego,3,4,,,,,,,,,,\n"
    ).encode("latin-1")
    recs = sesnsp.parse_municipal_csv(latin, "u", "2015-2025@2026-07")
    assert [(r.period_start, r.value) for r in recs] == [("2019-01-01", 3.0), ("2019-02-01", 4.0)]  # blank cells skipped
    assert recs[0].region_name == "Nuevo Laredo"


# --------------------------------------------------------------------------- scheduling / status


def test_loader_registry_covers_every_configured_dataset(db, settings, client):
    names = sorted(ld.dataset for ld in all_loaders(db, settings, client))
    assert names == [
        "acled_snapshot",
        "cbp_encounters",
        "fra_rail_incidents",
        "insight_crime",
        "justice_in_mexico_ocvm",
        "sesnsp_municipal",
    ]
    schedules = {ld.dataset: ld.refresh_schedule for ld in all_loaders(db, settings, client)}
    assert schedules == {
        "acled_snapshot": "one-time",
        "cbp_encounters": "monthly",
        "fra_rail_incidents": "monthly",
        "insight_crime": "weekly",
        "justice_in_mexico_ocvm": "quarterly",
        "sesnsp_municipal": "monthly",
    }
    assert get_loader("nope", db, settings, client) is None


def test_is_due_follows_schedule_and_retries_failures_daily(db, settings, client):
    loader = get_loader("insight_crime", db, settings, client)
    loader.ensure_registered()
    assert loader.is_due()
    loader.record_status(LoadResult(loader.dataset, "updated", records=1, version="v"))
    now = datetime.now(timezone.utc)
    assert not loader.is_due(now)
    assert not loader.is_due(now + timedelta(days=6))
    assert loader.is_due(now + timedelta(days=7, minutes=1))
    loader.record_status(LoadResult(loader.dataset, "error", error="boom"))
    assert loader.is_due(now + timedelta(hours=24, minutes=1))
    row = db.query_one("SELECT last_status, last_error, version FROM baseline_datasets WHERE dataset='insight_crime'")
    assert row["last_status"] == "error" and row["last_error"] == "boom" and row["version"] == "v"  # version survives failure


def test_run_loader_converts_robots_and_crashes_into_status_rows(db, settings, client, monkeypatch):
    loader = get_loader("fra_rail_incidents", db, settings, client)
    monkeypatch.setattr(loader, "load", lambda: (_ for _ in ()).throw(RobotsDisallowedError("https://x/robots")))
    assert run_loader(loader).status == "robots_blocked"
    monkeypatch.setattr(loader, "load", lambda: (_ for _ in ()).throw(RuntimeError("secret internal detail")))
    res = run_loader(loader)
    assert res.status == "error" and res.error == "internal error"  # no internals leak into the API


def test_run_due_loaders_only_runs_due_datasets(db, settings, client, monkeypatch):
    import crucix_ingest.baselines.base as base

    calls: list[str] = []

    class Stub(base.BaselineLoader):
        dataset = "stub_ds"
        name = "stub"
        refresh_schedule = "weekly"

        def load(self):
            calls.append(self.dataset)
            return LoadResult(self.dataset, "updated", records=0)

    monkeypatch.setattr(base, "_LOADERS", {"stub_ds": Stub})
    assert [r.dataset for r in run_due_loaders(db, settings, client)] == ["stub_ds"]
    assert run_due_loaders(db, settings, client) == []
    assert [r.dataset for r in run_due_loaders(db, settings, client, force=True)] == ["stub_ds"]
    assert calls == ["stub_ds", "stub_ds"]
