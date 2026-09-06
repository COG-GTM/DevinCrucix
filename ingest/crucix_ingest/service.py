"""Scheduler + read-only JSON API consumed by the Node/Express side of CRUCIX.

Endpoints (all GET, JSON, bound to 127.0.0.1 by default):
  /health                          service + per-source health (always HTTP 200)
  /sources                         registry with poll state
  /articles?limit=&since=&region=&violence=1&language=&source=
  /articles/<id>                   full record incl. text, translation, entities
  /anomalies?limit=&since=
  /baselines                       dataset refresh status
  /baselines/<dataset>/records?series=&region=&limit=
  /summary                         dashboard payload (counts, top regions, recent anomalies)
  POST /poll                       trigger an immediate sweep (loopback only)
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, urlparse

from . import __version__
from .anomaly import detect_baseline_anomalies, detect_news_anomalies, list_anomalies
from .baselines import run_due_loaders
from .config import Settings
from .db import Database, row_to_dict, rows_to_dicts
from .http_client import build_http_client
from .logging_utils import log_event
from .pipeline import Pipeline
from .registry import DEGRADED_SOURCE_STATUSES, SLUG_RE, list_sources, seed_registry

logger = logging.getLogger(__name__)

_INT_RE = re.compile(r"^\d{1,9}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$")
_CODE_RE = re.compile(r"^[A-Za-z0-9:_./ -]{1,64}$")
_LANG_RE = re.compile(r"^[a-z]{2}$")
_DATASET_RE = re.compile(r"^[a-z0-9_]{1,64}$")

BASELINE_ANOMALY_SERIES = [("sesnsp_municipal", "homicidio_doloso"), ("cbp_encounters", "encounters"), ("fra_rail_incidents", "rail_equipment_incidents")]


class IngestService:
    def __init__(self, settings: Settings, db: Database | None = None):
        self.settings = settings
        settings.ensure_dirs()
        self.db = db or Database(settings.db_path)
        seed_registry(self.db)
        self.http = build_http_client(settings)
        self.pipeline = Pipeline(self.db, settings, http=self.http)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.last_sweep: dict[str, Any] | None = None
        self.last_baseline_check: str | None = None
        self.started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # ---------------------------------------------------------------- work
    def sweep(self) -> dict[str, Any]:
        if not self._lock.acquire(blocking=False):
            return {"status": "busy"}
        try:
            t0 = time.monotonic()
            summaries = self.pipeline.poll_all()
            anomalies = detect_news_anomalies(self.db, self.settings)
            result = {
                "status": "ok",
                "finished_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "duration_ms": int((time.monotonic() - t0) * 1000),
                "sources": [s.to_dict() for s in summaries],
                "new_articles": sum(s.items_new for s in summaries),
                "anomalies": len(anomalies),
            }
            self.last_sweep = result
            log_event(logger, "sweep_complete", new_articles=result["new_articles"], anomalies=result["anomalies"], duration_ms=result["duration_ms"])
            return result
        finally:
            self._lock.release()

    def check_baselines(self, force: bool = False) -> list[dict[str, Any]]:
        results = run_due_loaders(self.db, self.settings, self.http, force=force)
        for dataset, series in BASELINE_ANOMALY_SERIES:
            if force or any(r.dataset == dataset and r.status == "updated" for r in results):
                detect_baseline_anomalies(self.db, self.settings, dataset, series)
        self.last_baseline_check = datetime.now(timezone.utc).isoformat(timespec="seconds")
        return [r.to_dict() for r in results]

    def run_scheduler(self) -> None:
        poll_every = self.settings.poll_interval_minutes * 60
        baseline_every = self.settings.baseline_check_interval_minutes * 60
        next_poll = 0.0
        next_baseline = 0.0
        log_event(logger, "scheduler_started", poll_interval_minutes=self.settings.poll_interval_minutes,
                  baseline_check_interval_minutes=self.settings.baseline_check_interval_minutes, user_agent=self.settings.user_agent)
        while not self._stop.is_set():
            now = time.monotonic()
            if now >= next_poll:
                try:
                    self.sweep()
                except Exception as e:  # keep the loop alive
                    log_event(logger, "sweep_failed", logging.ERROR, error=str(e)[:300])
                next_poll = time.monotonic() + poll_every
            if now >= next_baseline:
                try:
                    self.check_baselines()
                except Exception as e:
                    log_event(logger, "baseline_check_failed", logging.ERROR, error=str(e)[:300])
                next_baseline = time.monotonic() + baseline_every
            self._stop.wait(min(30.0, max(1.0, min(next_poll, next_baseline) - time.monotonic())))

    def stop(self) -> None:
        self._stop.set()

    # ---------------------------------------------------------------- queries
    def health(self) -> dict[str, Any]:
        sources = list_sources(self.db)
        degraded = [s["slug"] for s in sources if s["enabled"] and s["last_status"] in DEGRADED_SOURCE_STATUSES]
        datasets = rows_to_dicts(self.db.query("SELECT * FROM baseline_datasets ORDER BY dataset"))
        counts = self.db.query_one(
            "SELECT COUNT(*) AS articles, SUM(paywalled) AS paywalled, SUM(is_violence) AS violence, "
            "SUM(CASE WHEN language != 'en' THEN 1 ELSE 0 END) AS non_english FROM articles")
        return {
            "status": "ok",
            "version": __version__,
            "started_at": self.started_at,
            "poll_interval_minutes": self.settings.poll_interval_minutes,
            "user_agent": self.settings.user_agent,
            "ner_backend": self.pipeline.ner.backend,
            "translation_provider": self.settings.translation_provider,
            "sources_enabled": sum(1 for s in sources if s["enabled"]),
            "sources_degraded": degraded,
            "articles": dict(counts) if counts else {},
            "last_sweep": {k: v for k, v in (self.last_sweep or {}).items() if k != "sources"},
            "last_baseline_check": self.last_baseline_check,
            "baselines": [{k: d.get(k) for k in ("dataset", "refresh_schedule", "last_checked_at", "last_updated_at", "last_status", "last_error", "record_count", "version")} for d in datasets],
        }

    def sources(self) -> list[dict[str, Any]]:
        return list_sources(self.db)

    def articles(self, q: dict[str, str]) -> list[dict[str, Any]]:
        limit = _bounded_int(q.get("limit"), 50, 1, 500)
        where: list[str] = ["1=1"]
        params: list[Any] = []
        if q.get("since") and _DATE_RE.match(q["since"]):
            where.append("COALESCE(a.published_at, a.discovered_at) >= ?")
            params.append(q["since"])
        if q.get("region") and _CODE_RE.match(q["region"]):
            where.append("a.id IN (SELECT article_id FROM article_regions WHERE region_code = ?)")
            params.append(q["region"])
        if q.get("violence") == "1":
            where.append("a.is_violence = 1")
        if q.get("language") and _LANG_RE.match(q["language"]):
            where.append("a.language = ?")
            params.append(q["language"])
        if q.get("source") and SLUG_RE.match(q["source"]):
            where.append("s.slug = ?")
            params.append(q["source"])
        if q.get("paywalled") in ("0", "1"):
            where.append("a.paywalled = ?")
            params.append(int(q["paywalled"]))
        rows = self.db.query(
            f"""SELECT a.id, a.title, a.summary, a.url, a.canonical_url, a.published_at, a.discovered_at, a.language,
                       a.country_of_publication, a.reliability, a.source_type, a.region_tag, a.paywalled, a.fetch_status,
                       a.extraction_method, a.text_language, a.violence_score, a.is_violence, a.border_regions_json,
                       a.entities_json, a.translation_engine, s.slug AS source_slug, s.outlet_name,
                       (a.translation_text IS NOT NULL) AS has_translation, length(a.text) AS text_chars
                FROM articles a JOIN sources s ON s.id = a.source_id
                WHERE {' AND '.join(where)}
                ORDER BY COALESCE(a.published_at, a.discovered_at) DESC, a.id DESC LIMIT ?""",  # noqa: S608 - clauses are fixed strings
            params + [limit],
        )
        return rows_to_dicts(rows, json_fields=("border_regions_json", "entities_json"))

    def article(self, article_id: int) -> dict[str, Any] | None:
        row = self.db.query_one(
            "SELECT a.*, s.slug AS source_slug, s.outlet_name FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.id = ?",
            (article_id,))
        if not row:
            return None
        d = row_to_dict(row, json_fields=("border_regions_json", "entities_json"))
        assert d is not None
        d["translation"] = {
            "text": d.pop("translation_text"), "engine": d.pop("translation_engine"), "model": d.pop("translation_model"),
            "is_machine_translation": bool(d.pop("translation_is_machine")), "translated_at": d.pop("translated_at"),
            "label": "MACHINE TRANSLATION — derived field; original-language text is the source of record",
        } if d.get("translation_text") else None
        d["regions"] = [dict(r) for r in self.db.query("SELECT region_code, region_type, region_name, country FROM article_regions WHERE article_id = ?", (article_id,))]
        return d

    def baselines(self) -> list[dict[str, Any]]:
        return rows_to_dicts(self.db.query("SELECT * FROM baseline_datasets ORDER BY dataset"))

    def baseline_records(self, dataset: str, q: dict[str, str]) -> list[dict[str, Any]]:
        if not _DATASET_RE.match(dataset):
            return []
        limit = _bounded_int(q.get("limit"), 500, 1, 5000)
        where = ["dataset = ?"]
        params: list[Any] = [dataset]
        if q.get("series") and _DATASET_RE.match(q["series"]):
            where.append("series = ?")
            params.append(q["series"])
        if q.get("region") and _CODE_RE.match(q["region"]):
            where.append("region_code = ?")
            params.append(q["region"])
        if q.get("since") and _DATE_RE.match(q["since"]):
            where.append("period_start >= ?")
            params.append(q["since"][:10])
        rows = self.db.query(
            f"SELECT * FROM baseline_records WHERE {' AND '.join(where)} ORDER BY period_start DESC, region_code LIMIT ?",  # noqa: S608
            params + [limit])
        return rows_to_dicts(rows, json_fields=("metadata_json",))

    def summary(self) -> dict[str, Any]:
        now = datetime.now(timezone.utc)
        day_ago = (now - timedelta(days=1)).isoformat(timespec="seconds")
        week_ago = (now - timedelta(days=7)).isoformat(timespec="seconds")
        top_regions = self.db.query(
            """SELECT ar.region_code, ar.region_name, ar.country, COUNT(DISTINCT a.id) AS articles,
                      SUM(a.is_violence) AS violence
               FROM article_regions ar JOIN articles a ON a.id = ar.article_id
               WHERE COALESCE(a.published_at, a.discovered_at) >= ?
               GROUP BY ar.region_code ORDER BY violence DESC, articles DESC LIMIT 15""", (week_ago,))
        by_lang = self.db.query("SELECT language, COUNT(*) AS n, SUM(paywalled) AS paywalled FROM articles GROUP BY language")
        recent = self.articles({"limit": "40", "since": (now - timedelta(days=3)).isoformat(timespec="seconds")})
        return {
            "generated_at": now.isoformat(timespec="seconds"),
            "health": self.health(),
            "articles_24h": (self.db.query_one("SELECT COUNT(*) AS n FROM articles WHERE discovered_at >= ?", (day_ago,)) or {"n": 0})["n"],
            "violence_24h": (self.db.query_one("SELECT COUNT(*) AS n FROM articles WHERE discovered_at >= ? AND is_violence = 1", (day_ago,)) or {"n": 0})["n"],
            "by_language": [dict(r) for r in by_lang],
            "top_regions_7d": [dict(r) for r in top_regions],
            "anomalies": list_anomalies(self.db, limit=25, since=(now - timedelta(days=30)).date().isoformat()),
            "recent_articles": recent,
        }


def _bounded_int(raw: str | None, default: int, lo: int, hi: int) -> int:
    if raw is None or not _INT_RE.match(raw):
        return default
    return max(lo, min(hi, int(raw)))


def make_handler(service: IngestService):
    class Handler(BaseHTTPRequestHandler):
        server_version = "CrucixIngest/" + __version__
        sys_version = ""

        def log_message(self, fmt, *args):  # route to JSON logger
            log_event(logger, "http_request", method=self.command, path=self.path[:200], client=self.client_address[0])

        def _send(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'none'")
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            parsed = urlparse(self.path)
            q = {k: v[0][:256] for k, v in parse_qs(parsed.query, max_num_fields=20).items()}
            path = parsed.path.rstrip("/") or "/"
            try:
                if path == "/health":
                    return self._send(200, service.health())
                if path == "/sources":
                    return self._send(200, {"sources": service.sources()})
                if path == "/articles":
                    return self._send(200, {"articles": service.articles(q)})
                m = re.fullmatch(r"/articles/(\d{1,9})", path)
                if m:
                    art = service.article(int(m.group(1)))
                    return self._send(200, art) if art else self._send(404, {"error": "not found"})
                if path == "/anomalies":
                    since = q.get("since") if q.get("since") and _DATE_RE.match(q["since"]) else None
                    return self._send(200, {"anomalies": list_anomalies(service.db, _bounded_int(q.get("limit"), 100, 1, 500), since)})
                if path == "/baselines":
                    return self._send(200, {"datasets": service.baselines()})
                m = re.fullmatch(r"/baselines/([a-z0-9_]{1,64})/records", path)
                if m:
                    return self._send(200, {"records": service.baseline_records(m.group(1), q)})
                if path == "/summary":
                    return self._send(200, service.summary())
                return self._send(404, {"error": "not found"})
            except Exception as e:
                log_event(logger, "http_handler_error", logging.ERROR, path=path[:200], error=str(e)[:300])
                return self._send(500, {"error": "internal error"})

        def do_POST(self):  # noqa: N802
            path = urlparse(self.path).path.rstrip("/")
            if self.client_address[0] not in ("127.0.0.1", "::1"):
                return self._send(403, {"error": "forbidden"})
            if path == "/poll":
                threading.Thread(target=service.sweep, daemon=True).start()
                return self._send(202, {"status": "started"})
            if path == "/baselines/check":
                threading.Thread(target=service.check_baselines, kwargs={"force": True}, daemon=True).start()
                return self._send(202, {"status": "started"})
            return self._send(404, {"error": "not found"})

    return Handler


def serve(settings: Settings, run_scheduler: bool = True) -> None:
    service = IngestService(settings)
    server = ThreadingHTTPServer((settings.api_host, settings.api_port), make_handler(service))
    server.daemon_threads = True
    if run_scheduler:
        threading.Thread(target=service.run_scheduler, name="scheduler", daemon=True).start()
    log_event(logger, "api_listening", host=settings.api_host, port=settings.api_port)
    try:
        server.serve_forever(poll_interval=1.0)
    except KeyboardInterrupt:
        pass
    finally:
        service.stop()
        server.server_close()
