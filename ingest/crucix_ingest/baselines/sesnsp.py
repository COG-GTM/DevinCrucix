"""SESNSP municipal crime incidence (Mexico) — monthly.

Source page: https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva
The page links a zip (hosted on the SSPC SharePoint tenant, anonymous share link)
named like ``RNID-Delitos_Municipal-<year>-<mon><year>.zip`` containing one CSV with
columns: Año, Clave_Ent, Entidad, Cve. Municipio, Municipio, Bien jurídico afectado,
Tipo de delito, Subtipo de delito, Modalidad, Enero..Diciembre (verified Aug-2026 release).

We keep the six border states and a small set of violence series, aggregated per
municipality-month. No registration is required.
"""

from __future__ import annotations

import csv
import html
import io
import re
import zipfile
from collections.abc import Iterable
from datetime import date
from typing import IO

from .base import BaselineLoader, BaselineRecord, LoadResult, register


class _Chained(io.RawIOBase):
    """Binary stream that replays an already-consumed prefix before the underlying stream."""

    def __init__(self, prefix: bytes, rest: IO[bytes]):
        self._prefix = prefix
        self._rest = rest

    def readable(self) -> bool:
        return True

    def readinto(self, b: bytearray | memoryview) -> int:  # type: ignore[override]
        n = len(b)
        if self._prefix:
            chunk, self._prefix = self._prefix[:n], self._prefix[n:]
            b[: len(chunk)] = chunk
            return len(chunk)
        chunk = self._rest.read(n)
        b[: len(chunk)] = chunk
        return len(chunk)

PAGE_URL = "https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva"
BORDER_STATES = {"02": "Baja California", "05": "Coahuila", "08": "Chihuahua", "19": "Nuevo León", "26": "Sonora", "28": "Tamaulipas"}
MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"]
SERIES = {
    ("Homicidio", "Homicidio doloso"): "homicidio_doloso",
    ("Feminicidio", "Feminicidio"): "feminicidio",
    ("Secuestro", None): "secuestro",
    ("Extorsión", None): "extorsion",
    ("Narcomenudeo", None): "narcomenudeo",
    ("Robo", "Robo de vehículo automotor"): "robo_vehiculo",
    ("Lesiones", "Lesiones dolosas"): "lesiones_dolosas",
}
_LINK_RE = re.compile(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")
_MONTH_ABBR = {"ene": 1, "feb": 2, "mar": 3, "abr": 4, "may": 5, "jun": 6, "jul": 7, "ago": 8, "sep": 9, "oct": 10, "nov": 11, "dic": 12}


_MONTH_NAMES = {m.lower(): i for i, m in enumerate(MONTHS, start=1)}


def _municipal_delitos_links(page_html: str) -> list[tuple[str, str, list[int]]]:
    out: list[tuple[str, str, list[int]]] = []
    for m in _LINK_RE.finditer(page_html):
        url = html.unescape(m.group(1))
        label = html.unescape(_TAG_RE.sub("", m.group(2))).replace("\xa0", " ").strip()
        low = label.lower()
        if "municipal" not in low or "delitos" not in low or "víctimas" in low or "victimas" in low or "tablero" in low:
            continue
        years = [int(y) for y in re.findall(r"(20\d\d)", label)]
        if years:
            out.append((url, label, years))
    return out


def find_municipal_link(page_html: str) -> tuple[str, str] | None:
    """Return (url, label) of the current-year *Fuero común - Delitos* municipal dataset link."""
    best: tuple[int, str, str] | None = None
    for url, label, years in _municipal_delitos_links(page_html):
        if len(set(years)) != 1:  # single-year release, e.g. "Enero - julio 2026"
            continue
        if best is None or years[0] > best[0]:
            best = (years[0], url, label)
    return (best[1], best[2]) if best else None


def find_historical_link(page_html: str) -> tuple[str, str] | None:
    """Return (url, label) of the multi-year municipal archive (e.g. "2015 - 2025 ... municipal")."""
    best: tuple[int, str, str] | None = None
    for url, label, years in _municipal_delitos_links(page_html):
        if len(set(years)) < 2 or min(years) < 2015:  # the 2011-2017 file uses the older methodology
            continue
        if best is None or max(years) > best[0]:
            best = (max(years), url, label)
    return (best[1], best[2]) if best else None


def last_published_month(label: str) -> tuple[int, int] | None:
    """"Enero - julio 2026" -> (2026, 7). None when the label is a multi-year range."""
    years = [int(y) for y in re.findall(r"(20\d\d)", label)]
    if len(set(years)) != 1:
        return None
    months = [_MONTH_NAMES[w] for w in re.findall(r"[a-záéíóú]+", label.lower()) if w in _MONTH_NAMES]
    return (years[0], max(months)) if months else None


def _series_for(tipo: str, subtipo: str) -> str | None:
    for (t, s), name in SERIES.items():
        if tipo == t and (s is None or subtipo.startswith(s)):
            return name
    return None


def _detect_encoding(sample: bytes) -> str:
    """Current-year releases are UTF-8 (BOM); the 2015+ archive CSV is Latin-1."""
    try:
        sample.decode("utf-8")
        return "utf-8-sig"
    except UnicodeDecodeError:
        return "latin-1"


def parse_municipal_csv(
    data: bytes | IO[bytes], source_url: str, version: str, states: Iterable[str] = tuple(BORDER_STATES),
    cutoff: tuple[int, int] | None = None,
) -> list[BaselineRecord]:
    """``cutoff=(year, month)`` drops cells after the last published month (the release CSV carries
    zero-filled columns for months not yet reported). Accepts bytes or a binary stream so the
    ~400 MB archive CSV can be parsed straight out of the zip."""
    raw: IO[bytes] = io.BytesIO(data) if isinstance(data, bytes) else data
    sample = raw.read(65_536)
    encoding = _detect_encoding(sample)
    buffered = io.BufferedReader(_Chained(sample, raw))
    reader = csv.DictReader(io.TextIOWrapper(buffered, encoding=encoding, newline=""))
    states = set(states)
    agg: dict[tuple[str, str, str], dict] = {}
    for row in reader:
        ent = (row.get("Clave_Ent") or "").zfill(2)
        if ent not in states:
            continue
        series = _series_for(row.get("Tipo de delito", ""), row.get("Subtipo de delito", ""))
        if not series:
            continue
        try:
            year = int(row.get("Año") or 0)
        except ValueError:
            continue
        mun_code = (row.get("Cve. Municipio") or "").strip().zfill(5)
        mun_name = (row.get("Municipio") or "").strip()
        for i, month in enumerate(MONTHS, start=1):
            if cutoff and (year, i) > cutoff:
                continue
            cell = (row.get(month) or "").strip()
            if cell == "":
                continue
            try:
                val = float(cell.replace(",", ""))
            except ValueError:
                continue
            key = (series, mun_code, f"{year:04d}-{i:02d}-01")
            entry = agg.setdefault(key, {"value": 0.0, "name": mun_name, "state": row.get("Entidad", ""), "ent": ent})
            entry["value"] += val
    records: list[BaselineRecord] = []
    for (series, mun_code, period_start), entry in agg.items():
        y, m = int(period_start[:4]), int(period_start[5:7])
        last_day = (date(y + (m // 12), (m % 12) + 1, 1) - date.resolution) if m < 12 else date(y, 12, 31)
        records.append(BaselineRecord(
            series=series, region_type="municipality", region_code=mun_code, region_name=entry["name"], country="MX",
            period_start=period_start, period_end=last_day.isoformat(), value=entry["value"], unit="incidents",
            source_url=source_url, source_version=version,
            metadata={"state": entry["state"], "state_code": entry["ent"], "fuero": "comun"},
        ))
    return records


def _version_from_label(label: str, url: str) -> str:
    """``2026-07`` for the current-year release, ``2015-2025@2026-07`` for the archive published alongside it."""
    m = re.search(r"([a-z]{3})(20\d\d)\.zip", url, re.IGNORECASE)
    release = f"{m.group(2)}-{_MONTH_ABBR.get(m.group(1).lower(), 0):02d}" if m else re.sub(r"\s+", " ", label)[:60]
    years = sorted({int(y) for y in re.findall(r"(20\d\d)", label)})
    if len(years) > 1:
        return f"{years[0]}-{years[-1]}@{release}"
    return release


@register
class SesnspLoader(BaselineLoader):
    dataset = "sesnsp_municipal"
    name = "SESNSP Incidencia Delictiva Municipal (Fuero Común)"
    source_url = PAGE_URL
    refresh_schedule = "monthly"
    notes = "Monthly municipal crime counts, border states only. Open data, no registration. Primary Mexico-side violence baseline."

    def load(self) -> LoadResult:
        page = self.http.fetch(PAGE_URL, accept="text/html")
        if not page.ok:
            return LoadResult(self.dataset, "blocked" if page.status in (401, 403) else "error", error=f"landing page HTTP {page.status}")
        page_html = page.text()
        current = find_municipal_link(page_html)
        if not current:
            return LoadResult(self.dataset, "error", error="municipal dataset link not found on landing page")
        historical = find_historical_link(page_html)
        results = []
        for link in (historical, current):
            if link:
                results.append(self._load_file(*link))
        failed = [r for r in results if r.status in ("error", "blocked")]
        if failed:
            return failed[0]
        updated = [r for r in results if r.status == "updated"]
        version = results[-1].version
        detail = {"files": [r.detail for r in results]}
        if not updated:
            return LoadResult(self.dataset, "unchanged", version=version, detail=detail)
        return LoadResult(self.dataset, "updated", records=sum(r.records for r in updated), version=version, detail=detail)

    def _load_file(self, url: str, label: str) -> LoadResult:
        dl_url = url + ("&" if "?" in url else "?") + "download=1"
        # SharePoint anonymous share links set a session cookie on the first hop. The tenant's
        # robots.txt is a blanket Disallow aimed at crawlers; the zip is the agency's own published
        # open-data artifact, fetched under the audited dataset_download allowlist (see config).
        res = self.http.fetch(
            dl_url, accept="application/zip,application/octet-stream,*/*", allow_cookies=True,
            max_bytes=200_000_000, dataset_download=True,
        )
        if not res.ok:
            return LoadResult(self.dataset, "blocked" if res.status in (401, 403) else "error", error=f"download HTTP {res.status}", detail={"label": label})
        version = _version_from_label(label, res.final_url)
        digest, _ = self.save_artifact(res.final_url, res.body, res.etag, res.last_modified, suffix=".zip")
        if self.known_artifact(res.final_url, digest) and self.db.query_one(
                "SELECT 1 FROM baseline_records WHERE dataset = ? AND source_version = ? LIMIT 1", (self.dataset, version)):
            return LoadResult(self.dataset, "unchanged", version=version, detail={"label": label})
        try:
            with zipfile.ZipFile(io.BytesIO(res.body)) as zf:
                csvs = [i for i in zf.infolist() if i.filename.lower().endswith(".csv")]
                if not csvs:
                    return LoadResult(self.dataset, "error", error="zip contains no CSV", detail={"label": label})
                info = max(csvs, key=lambda i: i.file_size)  # archives also ship per-year xlsx + a README pdf
                with zf.open(info) as fh:
                    records = parse_municipal_csv(fh, res.final_url, version, cutoff=last_published_month(label))
        except zipfile.BadZipFile:
            return LoadResult(self.dataset, "error", error="downloaded artifact is not a zip", detail={"label": label})
        n = self.upsert_records(records)
        return LoadResult(self.dataset, "updated", records=n, version=version, detail={"label": label, "csv": info.filename})
