"""JSON API contract, security headers, input bounding, loopback-only mutations, and scheduler resilience."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from crucix_ingest.baselines import base as baselines_base
from crucix_ingest.baselines.base import LoadResult
from crucix_ingest.registry import upsert_source
from crucix_ingest.service import BASELINE_ANOMALY_SERIES, IngestService, make_handler

from .conftest import article_html, make_source

RSS = """<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Gunmen kill four in Laredo shooting</title><link>{base}/a1</link><guid>g1</guid>
<description>Police said gunmen opened fire; four killed.</description><pubDate>Sun, 06 Sep 2026 10:00:00 GMT</pubDate></item>
<item><title>Bridge wait times improve at Pharr</title><link>{base}/a2</link><guid>g2</guid>
<description>New lanes.</description><pubDate>Sun, 06 Sep 2026 09:00:00 GMT</pubDate></item>
</channel></rss>"""


@pytest.fixture
def service(settings, server):
    svc = IngestService(settings)
    for src in svc.sources():  # seed registry points at live outlets: never poll them in tests
        svc.db.execute("UPDATE sources SET enabled = 0 WHERE id = ?", (src["id"],))
    server.add("/feed", RSS.format(base=server.base).encode(), content_type="application/rss+xml")
    server.add(
        "/a1",
        article_html(
            "Gunmen kill four in Laredo shooting",
            [f"Police in Laredo, Texas said gunmen opened fire and four people were killed, paragraph {i}." for i in range(12)],
        ).encode(),
    )
    server.add(
        "/a2",
        article_html(
            "Bridge wait times improve at Pharr",
            [f"CBP said new commercial lanes at the Pharr bridge cut wait times, paragraph {i}." for i in range(12)],
        ).encode(),
    )
    upsert_source(svc.db, make_source(server))
    yield svc
    svc.stop()
    svc.db.close()


@pytest.fixture
def api(service):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
    httpd.daemon_threads = True
    t = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    t.start()
    base = f"http://127.0.0.1:{httpd.server_address[1]}"

    def call(path: str, method: str = "GET"):
        req = urllib.request.Request(base + path, method=method, data=b"" if method == "POST" else None)
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, dict(resp.headers), json.loads(resp.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), json.loads(e.read() or b"null")

    yield call
    httpd.shutdown()
    httpd.server_close()


SECURITY_HEADERS = {
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
    "Cache-Control": "no-store",
}


def test_health_is_200_even_when_a_source_is_degraded(service, api, server):
    server.add("/feed", b"denied", status=403)
    service.sweep()
    status, headers, body = api("/health")
    assert status == 200 and body["status"] == "ok"
    assert body["sources_degraded"] == ["testoutlet"]
    assert body["user_agent"].startswith("CrucixBorderWatch/1.0")
    assert body["poll_interval_minutes"] == service.settings.poll_interval_minutes
    assert body["ner_backend"] == "disabled" and body["translation_provider"] == "none"
    assert {d["dataset"] for d in body["baselines"]} == {ds for ds, _ in BASELINE_ANOMALY_SERIES} | {
        "acled_snapshot",
        "insight_crime",
        "justice_in_mexico_ocvm",
    }
    assert body["last_sweep"]["new_articles"] == 0 and "sources" not in body["last_sweep"]
    for k, v in SECURITY_HEADERS.items():
        assert headers[k] == v, k
    assert headers["Content-Type"].startswith("application/json")
    assert "Server" not in headers or "Python" not in headers["Server"]


def test_sweep_then_articles_anomalies_summary_shapes(service, api, server):
    result = service.sweep()
    assert result["status"] == "ok" and result["new_articles"] == 2 and result["sources"][0]["status"] == "ok"
    assert service.last_sweep is result

    status, _, body = api("/articles?limit=10")
    assert status == 200 and len(body["articles"]) == 2
    art = next(a for a in body["articles"] if "Gunmen" in a["title"])
    assert art["is_violence"] == 1 and art["violence_terms_json"] and isinstance(art["violence_terms_json"], list)
    assert isinstance(art["border_regions_json"], list) and art["border_regions_json"][0]["code"] == "48479"
    assert isinstance(art["entities_json"], list)
    assert "text" not in art and "raw_html" not in art  # list view is metadata-only

    status, _, body = api("/articles?violence=1")
    assert [a["title"] for a in body["articles"]] == ["Gunmen kill four in Laredo shooting"]
    status, _, body = api("/articles?region=48479&language=en&source=testoutlet&since=2026-09-01")
    assert len(body["articles"]) >= 1
    status, _, body = api("/articles?region=%3Cscript%3E&language=english&limit=abc")
    assert status == 200 and len(body["articles"]) == 2  # invalid filters ignored, not echoed

    status, _, detail = api(f"/articles/{art['id']}")
    assert status == 200 and detail["text"] and "gunmen opened fire" in detail["text"]
    assert detail["fetch_status"] == "fetched" and detail["paywalled"] == 0
    assert detail["translation_text"] is None and detail["translation_is_machine"] == 1
    assert api("/articles/999999")[0] == 404 and api("/articles/abc")[0] == 404

    status, _, body = api("/sources")
    src = next(s for s in body["sources"] if s["slug"] == "testoutlet")
    assert src["last_status"] == "ok" and src["items_seen_total"] == 2 and src["last_error"] is None

    status, _, body = api("/anomalies?limit=5&since=2026-09-01")
    assert status == 200 and body["anomalies"] == []  # two stories are below min_count

    status, _, body = api("/summary")
    assert status == 200 and body["articles_24h"] == 2 and body["violence_24h"] == 1
    assert body["health"]["status"] == "ok" and isinstance(body["by_language"], list)
    assert body["top_regions_7d"][0]["region_code"] == "48479"
    assert len(body["recent_articles"]) == 2

    status, _, body = api("/baselines")
    assert status == 200 and len(body["datasets"]) == 6
    ds = body["datasets"][0]
    assert {"dataset", "name", "refresh_schedule", "last_status", "record_count", "version", "source_url"} <= set(ds)
    status, _, body = api("/baselines/cbp_encounters/records?series=encounters&limit=5")
    assert status == 200 and body["records"] == []
    assert api("/baselines/DROP%20TABLE/records")[0] == 404
    assert api("/nope")[0] == 404 and api("/")[0] == 404


def test_post_mutations_are_loopback_only_and_async(service, api, monkeypatch):
    monkeypatch.setattr(service, "sweep", lambda: {"status": "ok"})
    monkeypatch.setattr(service, "check_baselines", lambda force=False: [])
    assert api("/poll", "POST")[0] == 202
    assert api("/baselines/check", "POST")[0] == 202
    assert api("/nope", "POST")[0] == 404
    handler = make_handler(service)
    sent: list = []

    class Fake(handler):  # a non-loopback peer must get 403
        def __init__(self):
            self.client_address = ("203.0.113.9", 1234)
            self.path = "/poll"

        def _send(self, status, payload):
            sent.append((status, payload))

    Fake().do_POST()
    assert sent == [(403, {"error": "forbidden"})]


def test_sweep_is_serialized_and_errors_are_generic(service, server, monkeypatch):
    assert service._lock.acquire(blocking=False)
    try:
        assert service.sweep() == {"status": "busy"}
    finally:
        service._lock.release()
    server.add("/feed", b"<rss><channel><item><title>x</title><link>not a url</link></item></channel></rss>")
    res = service.sweep()
    assert res["status"] == "ok"
    assert res["sources"][0]["status"] in ("empty", "ok", "error")
    if res["sources"][0]["status"] == "error":
        assert "Traceback" not in (res["sources"][0]["error"] or "")


def test_check_baselines_runs_due_loaders_and_recomputes_anomalies(service, monkeypatch):
    calls: list[str] = []

    class Stub(baselines_base.BaselineLoader):
        dataset = "cbp_encounters"
        name = "stub"
        refresh_schedule = "monthly"

        def load(self):
            calls.append("load")
            return LoadResult(self.dataset, "updated", records=0, version="v1")

    monkeypatch.setattr(baselines_base, "_LOADERS", {"cbp_encounters": Stub})
    monkeypatch.setattr(baselines_base, "_import_builtin_loaders", lambda: None)
    scanned: list[tuple[str, str]] = []
    monkeypatch.setattr("crucix_ingest.service.detect_baseline_anomalies", lambda db, s, ds, se: scanned.append((ds, se)) or [])
    out = service.check_baselines()
    assert [r["status"] for r in out] == ["updated"] and calls == ["load"]
    assert scanned == [("cbp_encounters", "encounters")]  # only the updated dataset is rescanned
    assert service.last_baseline_check
    assert service.check_baselines() == [] and calls == ["load"]  # not due again
    scanned.clear()
    service.check_baselines(force=True)
    assert calls == ["load", "load"] and scanned == BASELINE_ANOMALY_SERIES  # force rescans every configured series
    row = service.db.query_one("SELECT last_status, version FROM baseline_datasets WHERE dataset='cbp_encounters'")
    assert row["last_status"] == "updated" and row["version"] == "v1"


def test_scheduler_survives_exceptions_and_stops(service, monkeypatch):
    calls = {"sweep": 0, "baselines": 0}

    def boom_sweep():
        calls["sweep"] += 1
        raise RuntimeError("feed exploded")

    def baselines(force=False):
        calls["baselines"] += 1
        if calls["baselines"] >= 1:
            service.stop()
        return []

    monkeypatch.setattr(service, "sweep", boom_sweep)
    monkeypatch.setattr(service, "check_baselines", baselines)
    t = threading.Thread(target=service.run_scheduler, daemon=True)
    t.start()
    t.join(timeout=10)
    assert not t.is_alive()
    assert calls["sweep"] == 1 and calls["baselines"] == 1  # a crashing sweep did not prevent the baseline check
