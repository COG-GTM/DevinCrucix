"""CBP Enforcement Statistics — Southwest border encounters and drug seizures by sector / field office.

Discovery chain (all pages fetched with the fixed crawler UA under normal robots enforcement):

  portal   https://www.cbp.gov/newsroom/stats/cbp-public-data-portal
    └─ links to document pages, e.g. /document/stats/nationwide-encounters and
       /document/stats/nationwide-drug-seizures
         └─ each lists CSVs under /sites/default/files/<YYYY-MM>/... (monthly refresh) plus
            legacy files under /sites/default/files/assets/documents/ (robots-disallowed; skipped).

Observed CSV shapes (matched case/space-insensitively; the parser refuses files missing the
essential columns rather than guessing):

  nationwide-encounters-*-aor.csv
    Fiscal Year, Month Grouping, Month (abbv), Component, Land Border Region, Area of
    Responsibility, AOR (Abbv), Demographic, Citizenship, Title of Authority, Encounter Type,
    Encounter Count
  nationwide-drugs-*.csv
    FY, Month (abbv), Component, Region, Land Filter, Area of Responsibility, Drug Type,
    Count of Event, Sum Qty (lbs)

``Fiscal Year``/``FY`` is ``2026 (FYTD)`` for the in-progress year — the leading 4 digits are used.
The southwest filter uses the publisher's own region column (``Southwest Land Border`` /
``Southwest Border``), never a hand-typed AOR list.

cbp.gov sits behind a WAF that returns HTTP 403 to some clients/networks. In that case the loader
reports ``blocked`` — it never retries with a different identity — and an operator can drop a
manually downloaded CSV at ``INGEST_CBP_LOCAL_PATH`` which is parsed with full provenance.
"""

from __future__ import annotations

import calendar
import csv
import html
import io
import re
from collections.abc import Sequence
from datetime import date
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from .base import BaselineLoader, BaselineRecord, LoadResult, register

PORTAL_URL = "https://www.cbp.gov/newsroom/stats/cbp-public-data-portal"
DASHBOARD_URL = "https://www.cbp.gov/newsroom/stats/southwest-land-border-encounters"
CBP_HOST = "www.cbp.gov"
# Document pages the portal links to. Discovered from the portal HTML at runtime; these constants are the
# verified fallback if the portal page changes its link text but the document pages remain.
DOCUMENT_PAGES = {
    "encounters": "https://www.cbp.gov/document/stats/nationwide-encounters",
    "drugs": "https://www.cbp.gov/document/stats/nationwide-drug-seizures",
}
ROBOTS_DISALLOWED_PREFIX = "/sites/default/files/assets/documents/"
_HREF_RE = re.compile(r'href="([^"]+)"', re.IGNORECASE)
_DATED_DIR_RE = re.compile(r"/sites/default/files/(\d{4}-\d{2})/([^/?#]+\.csv)$", re.IGNORECASE)
_FILE_FAMILY = {
    "encounters": re.compile(r"^nationwide-encounters-.*-aor\.csv$", re.IGNORECASE),
    "drugs": re.compile(r"^nationwide-drugs-.*\.csv$", re.IGNORECASE),
}
_FY_RE = re.compile(r"(\d{4})")
MONTHS = {"OCT": 10, "NOV": 11, "DEC": 12, "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6, "JUL": 7, "AUG": 8, "SEP": 9}
# Monthly in-year files carry a month token (…-fy23-fy26-jul-aor.csv); completed multi-year files do not (…-fy22-fy25-aor.csv).
_MONTHLY_FILE_RE = re.compile(r"-fy\d{2}-fy\d{2}-(?:oct|nov|dec|jan|feb|mar|apr|may|jun|jul|aug|sep)(?:[-_.]|$)", re.IGNORECASE)
MAX_ARCHIVE_FILES = 2  # most recent completed multi-year files, for baseline depth
MAX_CSV_BYTES = 300_000_000


def _norm(s: str) -> str:
    return re.sub(r"[^a-z]", "", s.lower())


def _col(headers: Sequence[str], *candidates: str) -> str | None:
    normed = {_norm(h): h for h in headers}
    for c in candidates:
        if _norm(c) in normed:
            return normed[_norm(c)]
    return None


def _fiscal_year(raw: str | None) -> int | None:
    m = _FY_RE.search(raw or "")
    return int(m.group(1)) if m else None


def _fy_month_to_date(fy: int, mon: str) -> date | None:
    m = MONTHS.get(mon.strip().upper()[:3])
    if not m:
        return None
    year = fy - 1 if m >= 10 else fy
    return date(year, m, 1)


def _month_end(d: date) -> date:
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


def _num(raw: str | None) -> float | None:
    try:
        return float((raw or "").replace(",", "").strip())
    except ValueError:
        return None


def _aor_code(name: str) -> str:
    """Stable region code shared by both CSV families (they differ in case and abbreviation use)."""
    return re.sub(r"[^A-Z0-9]+", "_", name.upper()).strip("_")[:40]


def _aor_name(raw: str) -> str:
    name = re.sub(r"\s+", " ", raw.strip())
    return name.title().replace(" Of ", " of ") if name.isupper() else name


def _publication_version(url: str) -> str | None:
    m = _DATED_DIR_RE.search(urlsplit(url).path)
    return m.group(1) if m else None


def _bump(d: dict[str, float], key: str, n: float) -> None:
    d[key] = d.get(key, 0.0) + n


def _top(d: dict[str, float], n: int = 12) -> dict[str, float]:
    return dict(sorted(d.items(), key=lambda kv: -kv[1])[:n])


def parse_encounters_csv(data: bytes, source_url: str, version: str) -> list[BaselineRecord]:
    """Southwest Land Border encounters aggregated to (AOR, month); breakdowns kept in metadata."""
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig", errors="replace")))
    headers = reader.fieldnames or []
    c_fy = _col(headers, "Fiscal Year", "FY")
    c_mon = _col(headers, "Month (abbv)", "Month")
    c_region = _col(headers, "Land Border Region", "Region")
    c_aor = _col(headers, "Area of Responsibility")
    c_abbv = _col(headers, "AOR (Abbv)")
    c_count = _col(headers, "Encounter Count")
    c_component = _col(headers, "Component")
    c_type = _col(headers, "Encounter Type")
    c_demo = _col(headers, "Demographic")
    c_auth = _col(headers, "Title of Authority")
    if not (c_fy and c_mon and c_region and c_aor and c_count):
        raise ValueError("CBP encounters CSV missing essential columns (fiscal year / month / region / AOR / count)")
    agg: dict[tuple[str, str], dict] = {}
    for row in reader:
        if "southwest" not in (row.get(c_region) or "").lower():
            continue
        fy = _fiscal_year(row.get(c_fy))
        d = _fy_month_to_date(fy, row.get(c_mon) or "") if fy else None
        n = _num(row.get(c_count))
        name = _aor_name(row.get(c_aor) or "")
        if not d or n is None or not name:
            continue
        e = agg.setdefault(
            (_aor_code(name), d.isoformat()),
            {
                "name": name,
                "abbv": (row.get(c_abbv) or "").strip() if c_abbv else "",
                "value": 0.0,
                "by_component": {},
                "by_type": {},
                "by_demographic": {},
                "by_authority": {},
            },
        )
        e["value"] += n
        _bump(e["by_component"], (row.get(c_component) or "unknown").strip() if c_component else "unknown", n)
        if c_type:
            _bump(e["by_type"], (row.get(c_type) or "unknown").strip(), n)
        if c_demo:
            _bump(e["by_demographic"], (row.get(c_demo) or "unknown").strip(), n)
        if c_auth:
            _bump(e["by_authority"], (row.get(c_auth) or "unknown").strip(), n)
    out = []
    for (code, ps), e in agg.items():
        d = date.fromisoformat(ps)
        out.append(
            BaselineRecord(
                "encounters",
                "cbp_aor",
                code,
                e["name"],
                "US",
                ps,
                _month_end(d).isoformat(),
                e["value"],
                "encounters",
                source_url,
                version,
                {
                    "aor_abbv": e["abbv"],
                    "by_component": _top(e["by_component"]),
                    "by_type": _top(e["by_type"]),
                    "by_demographic": _top(e["by_demographic"]),
                    "by_authority": _top(e["by_authority"]),
                },
            )
        )
    return out


def parse_drugs_csv(data: bytes, source_url: str, version: str) -> list[BaselineRecord]:
    """Southwest Border drug seizures → two series per (AOR, month): seizure events and pounds seized."""
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig", errors="replace")))
    headers = reader.fieldnames or []
    c_fy = _col(headers, "FY", "Fiscal Year")
    c_mon = _col(headers, "Month (abbv)", "Month")
    c_region = _col(headers, "Region", "Land Border Region")
    c_aor = _col(headers, "Area of Responsibility")
    c_type = _col(headers, "Drug Type")
    c_events = _col(headers, "Count of Event")
    c_lbs = _col(headers, "Sum Qty (lbs)")
    c_component = _col(headers, "Component")
    if not (c_fy and c_mon and c_region and c_aor and c_type and (c_events or c_lbs)):
        raise ValueError("CBP drugs CSV missing essential columns (FY / month / region / AOR / drug type / count)")
    agg: dict[tuple[str, str], dict] = {}
    for row in reader:
        if "southwest" not in (row.get(c_region) or "").lower():
            continue
        fy = _fiscal_year(row.get(c_fy))
        d = _fy_month_to_date(fy, row.get(c_mon) or "") if fy else None
        name = _aor_name(row.get(c_aor) or "")
        if not d or not name:
            continue
        events = _num(row.get(c_events)) if c_events else None
        lbs = _num(row.get(c_lbs)) if c_lbs else None
        drug = (row.get(c_type) or "unknown").strip()
        component = (row.get(c_component) or "unknown").strip() if c_component else "unknown"
        e = agg.setdefault(
            (_aor_code(name), d.isoformat()),
            {"name": name, "events": 0.0, "lbs": 0.0, "events_by_drug": {}, "lbs_by_drug": {}, "by_component": {}},
        )
        if events is not None:
            e["events"] += events
            _bump(e["events_by_drug"], drug, events)
            _bump(e["by_component"], component, events)
        if lbs is not None:
            e["lbs"] += lbs
            _bump(e["lbs_by_drug"], drug, lbs)
    out = []
    for (code, ps), e in agg.items():
        pe = _month_end(date.fromisoformat(ps)).isoformat()
        if c_events:
            out.append(
                BaselineRecord(
                    "drug_seizure_events",
                    "cbp_aor",
                    code,
                    e["name"],
                    "US",
                    ps,
                    pe,
                    e["events"],
                    "seizure_events",
                    source_url,
                    version,
                    {"by_drug_type": _top(e["events_by_drug"]), "by_component": _top(e["by_component"])},
                )
            )
        if c_lbs:
            out.append(
                BaselineRecord(
                    "drug_seizures_lbs",
                    "cbp_aor",
                    code,
                    e["name"],
                    "US",
                    ps,
                    pe,
                    round(e["lbs"], 3),
                    "lbs",
                    source_url,
                    version,
                    {"by_drug_type": {k: round(v, 3) for k, v in _top(e["lbs_by_drug"]).items()}},
                )
            )
    return out


PARSERS = {"encounters": parse_encounters_csv, "drugs": parse_drugs_csv}


def select_csv_links(page_html: str, page_url: str, family: str) -> list[str]:
    """CSV links of one file family from a CBP document page, in load order.

    Only ``/sites/default/files/<YYYY-MM>/`` paths on www.cbp.gov are considered; the legacy
    ``assets/documents`` tree is robots-disallowed and skipped. Returns the ``MAX_ARCHIVE_FILES``
    most recent completed multi-year files (oldest first) followed by the single newest monthly
    file, so the latest revision is loaded last and wins on upsert.
    """
    pattern = _FILE_FAMILY[family]
    found: dict[str, tuple[str, str]] = {}
    for href in _HREF_RE.findall(page_html):
        url = urljoin(page_url, html.unescape(href))
        parts = urlsplit(url)
        if parts.scheme != "https" or parts.netloc.lower() != CBP_HOST or parts.path.startswith(ROBOTS_DISALLOWED_PREFIX):
            continue
        m = _DATED_DIR_RE.search(parts.path)
        if not m or not pattern.match(m.group(2)):
            continue
        clean = f"https://{CBP_HOST}{parts.path}"
        found[clean] = (m.group(1), m.group(2).lower())
    ordered = [url for url, _ in sorted(found.items(), key=lambda kv: kv[1])]
    archives = [u for u in ordered if not _MONTHLY_FILE_RE.search(u)]
    monthly = [u for u in ordered if _MONTHLY_FILE_RE.search(u)]
    return archives[-MAX_ARCHIVE_FILES:] + monthly[-1:]


def discover_document_pages(portal_html: str, portal_url: str) -> dict[str, str]:
    pages = dict(DOCUMENT_PAGES)
    for href in _HREF_RE.findall(portal_html):
        url = urljoin(portal_url, html.unescape(href))
        parts = urlsplit(url)
        if parts.netloc.lower() != CBP_HOST or not parts.path.startswith("/document/stats/"):
            continue
        slug = parts.path.rsplit("/", 1)[-1].lower()
        if slug == "nationwide-encounters":
            pages["encounters"] = f"https://{CBP_HOST}{parts.path}"
        elif slug == "nationwide-drug-seizures":
            pages["drugs"] = f"https://{CBP_HOST}{parts.path}"
    return pages


@register
class CbpLoader(BaselineLoader):
    dataset = "cbp_encounters"
    name = "CBP Enforcement Statistics — Southwest border encounters and drug seizures by sector/field office"
    source_url = PORTAL_URL
    refresh_schedule = "monthly"
    notes = (
        "Monthly. Follows the CBP Public Data Portal to its document pages and loads the published nationwide "
        "encounters (AOR) and drug-seizure CSVs; reports `blocked` (never evades) when the site WAF returns 403. "
        "Operator-downloaded CSV supported via INGEST_CBP_LOCAL_PATH."
    )

    def _parse_any(self, data: bytes, src: str, version: str) -> list[BaselineRecord]:
        errors = []
        for family, parser in PARSERS.items():
            try:
                return parser(data, src, version)
            except ValueError as e:
                errors.append(f"{family}: {e}")
        raise ValueError("; ".join(errors))

    def _load_local(self, path: Path) -> LoadResult:
        data = path.read_bytes()
        version = f"local-{date.today().isoformat()}"
        src = f"file://{path.name}"
        try:
            records = self._parse_any(data, src, version)
        except ValueError as e:
            return LoadResult(self.dataset, "error", error=str(e)[:400])
        digest, _ = self.save_artifact(src, data, suffix=".csv")
        n = self.upsert_records(records)
        return LoadResult(self.dataset, "updated", records=n, version=version, detail={"mode": "local_file", "sha256": digest})

    def load(self) -> LoadResult:
        if self.settings.cbp_local_path:
            p = Path(self.settings.cbp_local_path)
            if p.is_file():
                return self._load_local(p)
            return LoadResult(self.dataset, "error", error="INGEST_CBP_LOCAL_PATH does not point to a file")

        portal = self.http.fetch(PORTAL_URL, accept="text/html")
        if portal.status == 403:
            return LoadResult(
                self.dataset,
                "blocked",
                error="cbp.gov returned HTTP 403 to the crawler; supply INGEST_CBP_LOCAL_PATH with a manually downloaded CSV",
            )
        pages = discover_document_pages(portal.text() if portal.ok else "", PORTAL_URL)

        total = 0
        loaded: list[str] = []
        errors: list[str] = []
        newest_version: str | None = None
        blocked = False
        for family, page_url in pages.items():
            page = self.http.fetch(page_url, accept="text/html")
            if page.status == 403:
                blocked = True
                errors.append(f"{family}: document page HTTP 403")
                continue
            if not page.ok:
                errors.append(f"{family}: document page HTTP {page.status} {page.error or ''}".strip())
                continue
            links = select_csv_links(page.text(), page_url, family)
            if not links:
                errors.append(f"{family}: no dated CSV links on {page_url}")
                continue
            for link in links:
                res = self.http.fetch(link, accept="text/csv,*/*", max_bytes=MAX_CSV_BYTES)
                fname = link.rsplit("/", 1)[-1]
                if res.status == 403:
                    blocked = True
                if not res.ok:
                    errors.append(f"{fname}: HTTP {res.status} {res.error or ''}".strip())
                    continue
                digest, _ = self.save_artifact(res.final_url, res.body, res.etag, res.last_modified, suffix=".csv")
                version = _publication_version(link) or digest[:12]
                try:
                    records = PARSERS[family](res.body, res.final_url, version)
                except ValueError as e:
                    errors.append(f"{fname}: {e}")
                    continue
                total += self.upsert_records(records)
                loaded.append(link)
                newest_version = max(newest_version or "", version)
        if not loaded:
            status = "blocked" if blocked else "error"
            return LoadResult(self.dataset, status, error="; ".join(errors)[:400] or "no CBP CSV loaded", detail={"pages": pages})
        return LoadResult(
            self.dataset, "updated", records=total, version=newest_version, detail={"files": loaded, "errors": errors, "pages": pages}
        )
