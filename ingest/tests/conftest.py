"""Shared fixtures: a loopback HTTP server that serves recorded payloads, a temp database, quiet settings.

Nothing in the test-suite touches the public internet; every "remote" is this local server so robots.txt,
conditional GET, redirects, 401/403 handling and paywall behaviour are exercised deterministically.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from crucix_ingest.config import DEFAULT_USER_AGENT, Settings
from crucix_ingest.db import Database
from crucix_ingest.http_client import PoliteHttpClient

FIXTURES = Path(__file__).parent / "fixtures"


def fixture_bytes(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def fixture_text(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


Response = tuple[int, dict[str, str], bytes]
Route = Response | Callable[[BaseHTTPRequestHandler], Response]


class LocalServer:
    """Tiny programmable origin. ``routes[path] = (status, headers, body)`` or a callable(handler)."""

    def __init__(self) -> None:
        self.routes: dict[str, Route] = {}
        self.requests: list[tuple[str, str, dict[str, str]]] = []
        self.robots: str | int = "User-agent: *\nAllow: /\n"  # str body, or int status (e.g. 403, 500)
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                server.requests.append(("GET", self.path, {k.lower(): v for k, v in self.headers.items()}))
                if self.path == "/robots.txt":
                    if isinstance(server.robots, int):
                        self.send_response(server.robots)
                        self.end_headers()
                        return
                    body = server.robots.encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                route = server.routes.get(self.path)
                if route is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                status, headers, body = route(self) if callable(route) else route
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._httpd.daemon_threads = True
        self.port = self._httpd.server_address[1]
        self.host = f"127.0.0.1:{self.port}"
        self.base = f"http://{self.host}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def url(self, path: str) -> str:
        return self.base + path

    def add(self, path: str, body: bytes | str, status: int = 200, content_type: str = "text/html; charset=utf-8", **headers: str) -> str:
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.routes[path] = (status, {"Content-Type": content_type, **headers}, data)
        return self.url(path)

    def hits(self, path: str) -> list[tuple[str, str, dict[str, str]]]:
        return [r for r in self.requests if r[1] == path]

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


@pytest.fixture
def server() -> Any:
    s = LocalServer()
    yield s
    s.close()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    s = Settings(
        db_path=tmp_path / "ingest.sqlite3",
        snapshot_dir=tmp_path / "snapshots",
        per_host_delay_seconds=0.0,
        request_timeout_seconds=5.0,
        ner_enabled=False,
        translation_provider="none",
        fetch_article_pages=True,
        dataset_download_hosts=(),
        log_json=False,
    )
    s.ensure_dirs()
    return s


@pytest.fixture
def db(settings: Settings) -> Database:
    return Database(settings.db_path)


@pytest.fixture
def client() -> PoliteHttpClient:
    return PoliteHttpClient(DEFAULT_USER_AGENT, per_host_delay=0.0, timeout=5.0)


def make_source(server: LocalServer, slug: str = "testoutlet", feed_path: str = "/feed", **overrides: Any) -> dict[str, Any]:
    src = {
        "slug": slug,
        "outlet_name": f"Outlet {slug}",
        "feed_url": server.url(feed_path),
        "feed_type": "rss",
        "language": "en",
        "country_of_publication": "US",
        "region_tag": "us-tx-border",
        "reliability": "established-media",
        "source_type": "newspaper",
        "discovery_date": "2026-09-01",
        "discovery_method": "test fixture",
        "terms_url": "",
        "notes": "",
        "phase": 1,
        "enabled": 1,
        "content_policy": "full",
    }
    src.update(overrides)
    return src


def article_html(title: str, paragraphs: list[str], lang: str = "en", extra_head: str = "", canonical: str | None = None) -> str:
    body = "".join(f"<p>{p}</p>" for p in paragraphs)
    can = f'<link rel="canonical" href="{canonical}">' if canonical else ""
    return (
        f'<!DOCTYPE html><html lang="{lang}"><head><meta charset="utf-8"><title>{title}</title>{can}{extra_head}</head>'
        f'<body><header><nav><a href="/">Home</a></nav></header><main><article><h1>{title}</h1>{body}</article></main>'
        f"<footer><p>Copyright</p></footer></body></html>"
    )
