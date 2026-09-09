"""Polite-crawler contract: fixed UA, robots.txt fail-closed, conditional GET, redirect policy, narrow dataset exception."""

from __future__ import annotations

import gzip
import logging
import time

import pytest

from crucix_ingest.config import DEFAULT_USER_AGENT
from crucix_ingest.http_client import InvalidUrlError, PoliteHttpClient, RobotsDisallowedError, validate_url


def test_descriptive_user_agent_is_sent_and_never_rotated(server, client):
    server.add("/a", "<html>a</html>")
    for _ in range(3):
        assert client.fetch(server.url("/a")).ok
    uas = {h["user-agent"] for _, path, h in server.requests if path == "/a"}
    assert uas == {DEFAULT_USER_AGENT}
    assert "CrucixBorderWatch/1.0" in DEFAULT_USER_AGENT and "contact:" in DEFAULT_USER_AGENT


def test_robots_txt_is_consulted_once_and_disallow_is_honoured(server, client):
    server.robots = "User-agent: *\nDisallow: /private/\nAllow: /\n"
    server.add("/public", "ok")
    server.add("/private/x", "secret")
    assert client.fetch(server.url("/public")).ok
    with pytest.raises(RobotsDisallowedError):
        client.fetch(server.url("/private/x"))
    assert server.hits("/private/x") == []  # never requested
    assert len(server.hits("/robots.txt")) == 1  # cached per host


def test_robots_disallow_for_our_specific_agent(server, client):
    server.robots = "User-agent: CrucixBorderWatch\nDisallow: /\n\nUser-agent: *\nAllow: /\n"
    server.add("/x", "x")
    with pytest.raises(RobotsDisallowedError):
        client.fetch(server.url("/x"))
    assert server.hits("/x") == []


@pytest.mark.parametrize("status", [401, 403])
def test_robots_forbidden_fails_closed(server, client, status):
    server.robots = status
    server.add("/x", "x")
    with pytest.raises(RobotsDisallowedError):
        client.fetch(server.url("/x"))
    assert server.hits("/x") == []


def test_robots_server_error_fails_closed(server, client):
    server.robots = 503
    server.add("/x", "x")
    with pytest.raises(RobotsDisallowedError):
        client.fetch(server.url("/x"))


def test_robots_404_means_allow_all(server, client):
    server.robots = 404
    server.add("/x", "x")
    assert client.fetch(server.url("/x")).ok


def test_robots_crawl_delay_is_surfaced(server, client):
    server.robots = "User-agent: *\nCrawl-delay: 7\n"
    status = client.robots_status(server.url("/x"))
    assert status["crawl_delay"] == 7.0 and status["allowed"] is True and status["http_status"] == 200


def test_conditional_get_sends_validators_and_reports_not_modified(server, client):
    def route(handler):
        if handler.headers.get("If-None-Match") == '"v1"':
            return 304, {}, b""
        return 200, {"ETag": '"v1"', "Last-Modified": "Sat, 05 Sep 2026 22:18:53 GMT", "Content-Type": "application/rss+xml"}, b"<rss/>"

    server.routes["/feed"] = route
    first = client.fetch(server.url("/feed"))
    assert first.ok and first.etag == '"v1"' and first.last_modified
    second = client.fetch(server.url("/feed"), etag=first.etag, last_modified=first.last_modified)
    assert second.status == 304 and second.not_modified
    hdrs = server.hits("/feed")[1][2]
    assert hdrs["if-none-match"] == '"v1"'
    assert hdrs["if-modified-since"] == "Sat, 05 Sep 2026 22:18:53 GMT"


def test_gzip_responses_are_accepted_and_inflated_with_a_cap(server, client):
    payload = b"<rss>" + b"x" * 5000 + b"</rss>"
    server.add("/feed.gz", gzip.compress(payload), content_type="application/rss+xml", **{"Content-Encoding": "gzip"})
    server.robots = "User-agent: *\nAllow: /\n"
    res = client.fetch(server.url("/feed.gz"))
    assert res.ok and res.body == payload and "content-encoding" not in res.headers
    assert "gzip" in server.hits("/feed.gz")[0][2]["accept-encoding"]
    assert "gzip" in server.hits("/robots.txt")[0][2]["accept-encoding"]
    capped = client.fetch(server.url("/feed.gz"), max_bytes=100)
    assert len(capped.body) == 100  # inflated output is bounded, not just the wire bytes


def test_publisher_block_is_reported_not_evaded(server, client):
    server.add("/wall", "denied", status=403)
    res = client.fetch(server.url("/wall"))
    assert res.status == 403 and not res.ok
    assert len(server.hits("/wall")) == 1  # no retry with a different identity


@pytest.mark.parametrize("status", [429, 503])
def test_rate_limit_and_overload_back_off_the_host(server, client, status):
    server.add("/busy", "later", status=status, **{"Retry-After": "120"})
    res = client.fetch(server.url("/busy"))
    assert res.status == status and not res.ok
    remaining = client._host_state(server.host).next_allowed_at - time.monotonic()
    assert 100 < remaining <= 120  # honours Retry-After; the next poll cycle retries, not this one
    assert len(server.hits("/busy")) == 1


def test_redirect_target_is_robots_checked(server, client):
    server.robots = "User-agent: *\nDisallow: /hidden/\n"
    server.routes["/jump"] = (302, {"Location": server.url("/hidden/page")}, b"")
    server.add("/hidden/page", "should not be read")
    with pytest.raises(RobotsDisallowedError):
        client.fetch(server.url("/jump"))
    assert server.hits("/hidden/page") == []


def test_redirect_is_followed_and_final_url_recorded(server, client):
    server.routes["/old"] = (301, {"Location": server.url("/new")}, b"")
    server.add("/new", "fresh")
    res = client.fetch(server.url("/old"))
    assert res.ok and res.final_url == server.url("/new") and res.body == b"fresh"


def test_max_bytes_is_enforced(server, client):
    server.add("/big", "x" * 10_000)
    res = client.fetch(server.url("/big"), max_bytes=1000)
    assert res.ok and len(res.body) == 1000


def test_dataset_download_exception_requires_allowlisted_host(server, client, caplog):
    """SharePoint-style blanket Disallow: only an explicitly configured official host may be downloaded from,
    and the exception is audit-logged. Everything else still fails closed."""
    server.robots = "User-agent: *\nDisallow: /\n"
    server.add("/data.zip", b"PK\x03\x04", content_type="application/zip")
    with pytest.raises(RobotsDisallowedError):
        client.fetch(server.url("/data.zip"), dataset_download=True)
    assert server.hits("/data.zip") == []

    allowed = PoliteHttpClient(DEFAULT_USER_AGENT, per_host_delay=0.0, timeout=5.0, dataset_download_hosts=(server.host,))
    with caplog.at_level(logging.INFO, logger="crucix_ingest.http_client"):
        res = allowed.fetch(server.url("/data.zip"), dataset_download=True)
    assert res.ok and res.body.startswith(b"PK")
    assert any("dataset_direct_download" in r.getMessage() for r in caplog.records)
    with pytest.raises(RobotsDisallowedError):  # ordinary (non-dataset) fetches on the same host still obey robots
        allowed.fetch(server.url("/data.zip"))


@pytest.mark.parametrize("bad", ["ftp://example.com/x", "javascript:alert(1)", "http://", "https://example.com/" + "a" * 3000, ""])
def test_invalid_urls_are_rejected(bad):
    with pytest.raises(InvalidUrlError):
        validate_url(bad)


def test_validate_url_accepts_http_and_https():
    assert validate_url("https://www.example.com/feed/").netloc == "www.example.com"
