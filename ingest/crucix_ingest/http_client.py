"""Polite HTTP client.

- Descriptive, fixed User-Agent (no rotation, no spoofing).
- robots.txt is fetched, cached and enforced for every request.
- Conditional requests (ETag / If-Modified-Since) when validators are known.
- Per-host minimum delay between requests; honours Crawl-delay and Retry-After.
- Hard byte caps on response bodies.
- No proxies, no cookies beyond a per-fetch in-memory jar (needed only for
  anonymous SharePoint share links), no JavaScript execution.
"""

from __future__ import annotations

import http.cookiejar
import logging
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .logging_utils import log_event

if TYPE_CHECKING:
    from .config import Settings

logger = logging.getLogger(__name__)

ALLOWED_SCHEMES = {"http", "https"}
ROBOTS_CACHE_TTL_SECONDS = 6 * 3600
MAX_URL_LENGTH = 2048


class RobotsDisallowedError(Exception):
    pass


class InvalidUrlError(ValueError):
    pass


@dataclass
class FetchResult:
    url: str
    final_url: str
    status: int
    headers: dict[str, str]
    body: bytes
    not_modified: bool = False
    elapsed_ms: int = 0
    error: str | None = None

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    @property
    def etag(self) -> str | None:
        return self.headers.get("etag")

    @property
    def last_modified(self) -> str | None:
        return self.headers.get("last-modified")

    @property
    def content_type(self) -> str:
        return self.headers.get("content-type", "")

    def text(self, fallback_encoding: str = "utf-8") -> str:
        charset = None
        ct = self.content_type
        if "charset=" in ct:
            charset = ct.split("charset=", 1)[1].split(";")[0].strip().strip('"').strip("'")
        for enc in (charset, "utf-8", fallback_encoding, "latin-1"):
            if not enc:
                continue
            try:
                return self.body.decode(enc)
            except (UnicodeDecodeError, LookupError):
                continue
        return self.body.decode("utf-8", errors="replace")


@dataclass
class _RobotsEntry:
    parser: urllib.robotparser.RobotFileParser | None
    fetched_at: float
    status: int
    crawl_delay: float | None = None


@dataclass
class HostState:
    next_allowed_at: float = 0.0
    lock: threading.Lock = field(default_factory=threading.Lock)


def validate_url(url: str) -> urllib.parse.ParseResult:
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise InvalidUrlError("URL missing or too long")
    parsed = urllib.parse.urlparse(url.strip())
    if parsed.scheme not in ALLOWED_SCHEMES or not parsed.netloc:
        raise InvalidUrlError("URL scheme/host not allowed")
    if any(ch in url for ch in ("\n", "\r", " ")):
        raise InvalidUrlError("URL contains illegal characters")
    return parsed


class PoliteHttpClient:
    def __init__(
        self,
        user_agent: str,
        per_host_delay: float = 2.0,
        timeout: float = 20.0,
        max_bytes: int = 10_000_000,
        enforce_robots: bool = True,
        dataset_download_hosts: Iterable[str] | None = None,
    ):
        self.user_agent = user_agent
        self.per_host_delay = per_host_delay
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.enforce_robots = enforce_robots
        self.dataset_download_hosts: frozenset[str] = frozenset(h.lower() for h in dataset_download_hosts or ())
        self._robots: dict[str, _RobotsEntry] = {}
        self._hosts: dict[str, HostState] = {}
        self._lock = threading.Lock()

    # ----- robots -------------------------------------------------------
    def _robots_for(self, parsed: urllib.parse.ParseResult) -> _RobotsEntry:
        origin = f"{parsed.scheme}://{parsed.netloc}"
        now = time.monotonic()
        with self._lock:
            entry = self._robots.get(origin)
            if entry and now - entry.fetched_at < ROBOTS_CACHE_TTL_SECONDS:
                return entry
        robots_url = f"{origin}/robots.txt"
        parser = urllib.robotparser.RobotFileParser()
        parser.set_url(robots_url)
        status = 0
        crawl_delay: float | None = None
        try:
            self._wait_for_host(parsed.netloc)
            req = urllib.request.Request(robots_url, headers={"User-Agent": self.user_agent, "Accept": "text/plain,*/*;q=0.5"})
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310 - scheme validated
                status = resp.status
                body = resp.read(512_000)
            parser.parse(body.decode("utf-8", errors="replace").splitlines())
            try:
                cd = parser.crawl_delay(self.user_agent)
                crawl_delay = float(cd) if cd else None
            except (AttributeError, ValueError):
                crawl_delay = None
        except urllib.error.HTTPError as e:
            status = e.code
            if e.code in (401, 403):
                # Per RFC 9309 a 4xx robots response means unrestricted, but a
                # 401/403 is a clear signal the site does not want automated
                # clients; treat conservatively as fully disallowed.
                parser.disallow_all = True  # type: ignore[attr-defined]
            else:
                parser.allow_all = True  # type: ignore[attr-defined]
        except Exception as e:  # network error: fail closed for one TTL window
            status = -1
            parser.disallow_all = True  # type: ignore[attr-defined]
            log_event(logger, "robots_fetch_failed", logging.WARNING, host=parsed.netloc, error=str(e)[:200])
        entry = _RobotsEntry(parser=parser, fetched_at=time.monotonic(), status=status, crawl_delay=crawl_delay)
        with self._lock:
            self._robots[origin] = entry
        log_event(logger, "robots_loaded", host=parsed.netloc, http_status=status, crawl_delay=crawl_delay)
        return entry

    def is_allowed(self, url: str) -> bool:
        parsed = validate_url(url)
        if not self.enforce_robots:
            return True
        entry = self._robots_for(parsed)
        if entry.parser is None:
            return True
        return entry.parser.can_fetch(self.user_agent, url)

    def _direct_download_ok(self, host: str, dataset_download: bool, url: str) -> bool:
        if not dataset_download:
            return False
        ok = host.lower() in self.dataset_download_hosts
        if ok:
            log_event(
                logger, "dataset_direct_download", host=host, url=url[:300],
                reason="published open-data artifact on allowlisted host; robots.txt not consulted",
            )
        return ok

    def robots_status(self, url: str) -> dict:
        parsed = validate_url(url)
        entry = self._robots_for(parsed)
        return {"host": parsed.netloc, "http_status": entry.status, "crawl_delay": entry.crawl_delay,
                "allowed": entry.parser.can_fetch(self.user_agent, url) if entry.parser else True}

    # ----- rate limiting ------------------------------------------------
    def _host_state(self, host: str) -> HostState:
        with self._lock:
            state = self._hosts.get(host)
            if state is None:
                state = HostState()
                self._hosts[host] = state
            return state

    def _wait_for_host(self, host: str, extra_delay: float | None = None) -> None:
        state = self._host_state(host)
        delay = max(self.per_host_delay, extra_delay or 0.0)
        with state.lock:
            now = time.monotonic()
            if state.next_allowed_at > now:
                time.sleep(min(state.next_allowed_at - now, 60.0))
            state.next_allowed_at = time.monotonic() + delay

    def _backoff_host(self, host: str, seconds: float) -> None:
        state = self._host_state(host)
        with state.lock:
            state.next_allowed_at = max(state.next_allowed_at, time.monotonic() + min(seconds, 3600.0))

    # ----- fetch --------------------------------------------------------
    def fetch(
        self,
        url: str,
        etag: str | None = None,
        last_modified: str | None = None,
        accept: str = "*/*",
        max_bytes: int | None = None,
        allow_cookies: bool = False,
        max_redirects: int = 5,
        dataset_download: bool = False,
    ) -> FetchResult:
        """Fetch ``url`` politely.

        ``dataset_download=True`` marks the request as a retrieval of a published
        open-data artifact that an official agency page links to explicitly
        (e.g. a SESNSP zip hosted on a SharePoint tenant whose blanket
        ``Disallow: /`` targets crawlers, not the agency's own download link).
        Such requests skip the robots.txt check *only* when the host is on the
        operator-configured ``dataset_download_hosts`` allowlist; every use is
        written to the audit log. Redirect hops are held to the same rule.
        """
        parsed = validate_url(url)
        check_robots = self.enforce_robots and not self._direct_download_ok(parsed.netloc, dataset_download, url)
        if check_robots and not self.is_allowed(url):
            raise RobotsDisallowedError(url)
        entry = self._robots_for(parsed) if check_robots else None
        self._wait_for_host(parsed.netloc, entry.crawl_delay if entry else None)

        headers = {
            "User-Agent": self.user_agent,
            "Accept": accept,
            "Accept-Encoding": "identity",
        }
        if etag:
            headers["If-None-Match"] = etag[:512]
        if last_modified:
            headers["If-Modified-Since"] = last_modified[:128]

        handlers: list = [_NoAutoRedirect()]
        if allow_cookies:
            handlers.append(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        opener = urllib.request.build_opener(*handlers)
        cap = max_bytes or self.max_bytes
        start = time.monotonic()
        current = url
        redirects = 0
        body = b""
        while True:
            req = urllib.request.Request(current, headers=headers, method="GET")
            try:
                with opener.open(req, timeout=self.timeout) as resp:
                    status = resp.status
                    hdrs = {k.lower(): v for k, v in resp.headers.items()}
                    body = resp.read(cap + 1)
            except urllib.error.HTTPError as e:
                status = e.code
                hdrs = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
                try:
                    body = e.read(65_536)
                except Exception:
                    body = b""
            except Exception as e:
                elapsed = int((time.monotonic() - start) * 1000)
                log_event(logger, "http_fetch_error", logging.WARNING, url=url[:300], error=str(e)[:200], elapsed_ms=elapsed)
                return FetchResult(url=url, final_url=current, status=0, headers={}, body=b"", elapsed_ms=elapsed, error=str(e)[:200])

            if status in (301, 302, 303, 307, 308) and "location" in hdrs:
                redirects += 1
                if redirects > max_redirects:
                    return FetchResult(url=url, final_url=current, status=status, headers=hdrs, body=b"", error="too many redirects")
                nxt = urllib.parse.urljoin(current, hdrs["location"])
                nparsed = validate_url(nxt)
                if (
                    self.enforce_robots
                    and not self._direct_download_ok(nparsed.netloc, dataset_download, nxt)
                    and not self.is_allowed(nxt)
                ):
                    raise RobotsDisallowedError(nxt)
                if nparsed.netloc != urllib.parse.urlparse(current).netloc:
                    self._wait_for_host(nparsed.netloc)
                current = nxt
                continue
            break

        elapsed = int((time.monotonic() - start) * 1000)
        if status == 429 or status == 503:
            retry_after = hdrs.get("retry-after")
            try:
                self._backoff_host(parsed.netloc, float(retry_after) if retry_after else 300.0)
            except ValueError:
                self._backoff_host(parsed.netloc, 300.0)
        if len(body) > cap:
            body = body[:cap]
            log_event(logger, "http_body_truncated", logging.WARNING, url=url[:300], cap=cap)
        log_event(logger, "http_fetch", url=url[:300], final_url=current[:300], http_status=status, bytes=len(body), elapsed_ms=elapsed)
        return FetchResult(
            url=url, final_url=current, status=status, headers=hdrs, body=body,
            not_modified=(status == 304), elapsed_ms=elapsed,
        )


def build_http_client(settings: Settings) -> PoliteHttpClient:
    return PoliteHttpClient(
        user_agent=settings.user_agent,
        per_host_delay=settings.per_host_delay_seconds,
        timeout=settings.request_timeout_seconds,
        max_bytes=settings.max_feed_bytes,
        dataset_download_hosts=settings.dataset_download_hosts,
    )


class _NoAutoRedirect(urllib.request.HTTPRedirectHandler):
    """Surface redirects to the caller so robots.txt is re-checked per hop."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None
