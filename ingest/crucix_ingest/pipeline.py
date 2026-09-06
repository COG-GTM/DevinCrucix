"""Feed poller + article pipeline (fetch -> extract -> dedup -> NLP -> geo -> store)."""

from __future__ import annotations

import gzip
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Settings
from .db import Database, utcnow
from .dedup import candidate_keys, canonicalize_url, content_key, sha256_hex
from .extract import extract_article, extract_from_html_fragment
from .feeds import FeedItem, FeedParseError, detect_feed_type, is_sitemap_index, parse_feed, parse_sitemap_index
from .geo import default_gazetteer, is_violence_report, violence_score
from .http_client import InvalidUrlError, PoliteHttpClient, RobotsDisallowedError, build_http_client
from .logging_utils import log_event
from .nlp import NerEngine, Translator, detect_language
from .registry import list_sources, record_poll

logger = logging.getLogger(__name__)

FEED_ACCEPT = "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.5"
HTML_ACCEPT = "text/html, application/xhtml+xml;q=0.9, */*;q=0.5"
_SAFE_SLUG = re.compile(r"[^a-z0-9-]")


@dataclass
class PollSummary:
    slug: str
    status: str
    http_status: int | None = None
    items_total: int = 0
    items_new: int = 0
    error: str | None = None
    new_article_ids: list[int] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "slug": self.slug,
            "status": self.status,
            "http_status": self.http_status,
            "items_total": self.items_total,
            "items_new": self.items_new,
            "error": self.error,
        }


class Pipeline:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        http: PoliteHttpClient | None = None,
        ner: NerEngine | None = None,
        translator: Translator | None = None,
    ):
        self.db = db
        self.settings = settings
        self.http = http or build_http_client(settings)
        self.ner = ner or NerEngine(settings.ner_model, enabled=settings.ner_enabled)
        self.translator = translator or Translator(settings)
        self.gazetteer = default_gazetteer()
        settings.ensure_dirs()

    # ------------------------------------------------------------------ polling
    def poll_all(self) -> list[PollSummary]:
        summaries = []
        for src in list_sources(self.db, enabled_only=True):
            try:
                summaries.append(self.poll_source(src))
            except Exception as e:  # never let one outlet break the sweep
                log_event(logger, "poll_source_crashed", logging.ERROR, slug=src["slug"], error=str(e)[:300])
                summaries.append(PollSummary(slug=src["slug"], status="error", error="internal error"))
        return summaries

    def poll_source(self, src: dict[str, Any]) -> PollSummary:
        started = utcnow()
        slug = src["slug"]
        summary = PollSummary(slug=slug, status="error")
        try:
            result = self.http.fetch(
                src["feed_url"],
                etag=src.get("etag"),
                last_modified=src.get("last_modified"),
                accept=FEED_ACCEPT,
                max_bytes=self.settings.max_feed_bytes,
            )
        except RobotsDisallowedError:
            robots = self.http.robots_status(src["feed_url"])
            reason = (
                f"robots.txt request returned HTTP {robots['http_status']}; treated as disallow"
                if robots["http_status"] in (401, 403, -1)
                else "robots.txt disallows feed URL"
            )
            summary.status, summary.error = "robots_blocked", reason
            self._finish(src, started, summary, None, None)
            return summary
        except InvalidUrlError as e:
            summary.status, summary.error = "error", f"invalid feed url: {e}"
            self._finish(src, started, summary, None, None)
            return summary

        summary.http_status = result.status
        if result.not_modified:
            summary.status = "not_modified"
            self._finish(src, started, summary, result.etag, result.last_modified)
            return summary
        if result.error or not result.ok:
            summary.status = "blocked" if result.status in (401, 403) else "error"
            summary.error = result.error or (
                f"HTTP {result.status}: publisher refused the crawler; not retried with altered identity"
                if summary.status == "blocked"
                else f"HTTP {result.status}"
            )
            self._finish(src, started, summary, None, None)
            return summary

        feed_type = src["feed_type"]
        if feed_type == "unresolved":
            summary.status, summary.error = "disabled", "feed not resolved"
            self._finish(src, started, summary, None, None)
            return summary
        try:
            if feed_type == "news_sitemap" and is_sitemap_index(result.body):
                items = self._poll_sitemap_index(src, result.body, result.final_url or src["feed_url"])
            else:
                items = parse_feed(result.body, feed_type)
        except FeedParseError as e:
            detected = detect_feed_type(result.body, result.content_type)
            if detected != feed_type:
                try:
                    items = parse_feed(result.body, detected)
                    log_event(logger, "feed_type_mismatch", logging.WARNING, slug=slug, registered=feed_type, detected=detected)
                except FeedParseError as e2:
                    summary.status, summary.error = "error", f"feed parse failed: {str(e2)[:200]}"
                    self._finish(src, started, summary, None, None)
                    return summary
            else:
                summary.status, summary.error = "error", f"feed parse failed: {str(e)[:200]}"
                self._finish(src, started, summary, None, None)
                return summary

        summary.items_total = len(items)
        new_ids: list[int] = []
        for item in items[: self.settings.max_items_per_poll]:
            try:
                article_id = self.process_item(src, item)
            except Exception as e:
                log_event(logger, "item_processing_failed", logging.ERROR, slug=slug, url=item.url[:300], error=str(e)[:300])
                continue
            if article_id is not None:
                new_ids.append(article_id)
        summary.items_new = len(new_ids)
        summary.new_article_ids = new_ids
        summary.status = "ok" if items else "empty"
        self._finish(src, started, summary, result.etag, result.last_modified)
        return summary

    def _poll_sitemap_index(self, src: dict[str, Any], body: bytes, index_url: str) -> list[FeedItem]:
        """Expand a ``<sitemapindex>`` by fetching its newest child sitemaps (same host, robots-checked)."""
        items: list[FeedItem] = []
        for child_url in parse_sitemap_index(body, index_url):
            try:
                res = self.http.fetch(child_url, accept=FEED_ACCEPT, max_bytes=self.settings.max_feed_bytes)
            except (RobotsDisallowedError, InvalidUrlError) as e:
                log_event(logger, "sitemap_child_skipped", logging.WARNING, slug=src["slug"], url=child_url[:300], reason=type(e).__name__)
                continue
            if not res.ok or res.error:
                log_event(
                    logger,
                    "sitemap_child_failed",
                    logging.WARNING,
                    slug=src["slug"],
                    url=child_url[:300],
                    http_status=res.status,
                    error=(res.error or "")[:200],
                )
                continue
            try:
                items.extend(parse_feed(res.body, "news_sitemap"))
            except FeedParseError as e:
                log_event(logger, "sitemap_child_parse_failed", logging.WARNING, slug=src["slug"], url=child_url[:300], error=str(e)[:200])
        return items

    def _finish(self, src: dict[str, Any], started: str, summary: PollSummary, etag: str | None, last_modified: str | None) -> None:
        record_poll(
            self.db,
            int(src["id"]),
            started_at=started,
            status=summary.status,
            http_status=summary.http_status,
            items_total=summary.items_total,
            items_new=summary.items_new,
            error=summary.error,
            etag=etag,
            last_modified=last_modified,
        )
        log_event(logger, "poll_finished", **summary.to_dict())

    # ------------------------------------------------------------------ items
    def _existing_article_id(self, keys: list[str]) -> int | None:
        placeholders = ",".join("?" for _ in keys)
        row = self.db.query_one(
            f"SELECT id FROM articles WHERE dedup_key IN ({placeholders}) "  # noqa: S608 - placeholders only
            f"UNION SELECT article_id FROM article_aliases WHERE alias_key IN ({placeholders}) LIMIT 1",
            keys + keys,
        )
        return int(row["id"]) if row else None

    def process_item(self, src: dict[str, Any], item: FeedItem) -> int | None:
        """Returns the new article id, or None if the item was a duplicate / rejected."""
        try:
            canonical = canonicalize_url(item.url)
        except ValueError:
            return None
        if not canonical.startswith(("http://", "https://")):
            return None
        keys = candidate_keys(src["slug"], item.url, item.guid, item.title, item.published_at)
        existing = self._existing_article_id(keys)
        if existing is not None:
            self._add_aliases(existing, keys)
            return None

        record: dict[str, Any] = {
            "source_id": int(src["id"]),
            "dedup_key": keys[0],
            "guid": (item.guid or "")[:1024] or None,
            "url": item.url[:2048],
            "canonical_url": canonical[:2048],
            "title": item.title[:512],
            "summary": item.summary[:4000],
            "published_at": item.published_at,
            "discovered_at": utcnow(),
            "fetched_at": None,
            "language": src["language"],
            "country_of_publication": src["country_of_publication"],
            "reliability": src["reliability"],
            "source_type": src["source_type"],
            "region_tag": src["region_tag"],
            "paywalled": 0,
            "fetch_status": "not_fetched",
            "fetch_error": None,
            "extraction_method": "none",
            "raw_html_path": None,
            "raw_html_sha256": None,
            "text": None,
            "text_hash": None,
            "text_language": None,
            "translation": None,
            "entities": [],
            "ner_model": None,
            "regions": [],
            "violence_score": 0.0,
            "is_violence": 0,
        }

        # 1. Content: API-provided full text (Texas Tribune) or fetched article page.
        #    metadata_only sources (publisher terms forbid crawling) keep feed fields only.
        if src["content_policy"] == "metadata_only":
            record["fetch_status"] = "metadata_only"
        elif item.content_html and src["feed_type"] == "wp_api":
            text = extract_from_html_fragment(item.content_html)
            if text:
                record.update(text=text, extraction_method="wp_api", fetch_status="fetched", fetched_at=utcnow())
                self._store_snapshot(record, src["slug"], item.content_html.encode("utf-8"), canonical)
        elif self.settings.fetch_article_pages:
            self._fetch_and_extract(src, item, record, canonical)
        else:
            record["fetch_status"] = "skipped"

        # Feed-only fallback for text when the page yielded nothing but the feed carried a body.
        if (
            record["text"] is None
            and not record["paywalled"]
            and item.content_html
            and record["fetch_status"] not in ("robots_disallowed", "metadata_only")
        ):
            text = extract_from_html_fragment(item.content_html)
            if text and len(text) > 200:
                record.update(text=text, extraction_method="feed-only")

        # 2. Dedup on content hash across sources (wire copy, syndication).
        if record["text"]:
            ck = content_key(record["text"], record["title"])
            if ck:
                dup = self._existing_article_id([ck])
                if dup is not None:
                    self._add_aliases(dup, keys)
                    return None
                keys.append(ck)
            record["text_hash"] = sha256_hex(record["text"])

        # 3. NLP on original-language text only.
        analysis_text = record["text"] or record["summary"] or ""
        detected = detect_language(analysis_text, default=src["language"]) if analysis_text else src["language"]
        record["text_language"] = detected
        if self.settings.ner_enabled and (analysis_text or record["title"]):
            ents = self.ner.extract(f"{record['title']}\n\n{analysis_text}", detected)
            record["entities"] = [e.to_dict() for e in ents]
            record["ner_model"] = self.ner.backend
        if detected != "en" and record["text"]:
            tr = self.translator.translate(record["text"], detected, "en")
            if tr:
                record["translation"] = tr

        # 4. Geo + violence classification.
        regions = self.gazetteer.tag(record["title"], analysis_text)
        record["regions"] = regions
        score, terms = violence_score(record["title"], analysis_text)
        record["violence_score"] = score
        record["violence_terms"] = terms
        record["is_violence"] = 1 if is_violence_report(score, terms) else 0

        article_id = self._insert(record, keys)
        log_event(
            logger,
            "article_stored",
            slug=src["slug"],
            article_id=article_id,
            url=canonical[:300],
            fetch_status=record["fetch_status"],
            paywalled=bool(record["paywalled"]),
            extraction=record["extraction_method"],
            language=detected,
            regions=[r.code for r in regions],
            violence_score=score,
        )
        return article_id

    def _fetch_and_extract(self, src: dict[str, Any], item: FeedItem, record: dict[str, Any], canonical: str) -> None:
        try:
            page = self.http.fetch(item.url, accept=HTML_ACCEPT, max_bytes=self.settings.max_article_bytes)
        except RobotsDisallowedError:
            record["fetch_status"] = "robots_disallowed"
            return
        except InvalidUrlError:
            record["fetch_status"], record["fetch_error"] = "fetch_error", "invalid url"
            return
        record["fetched_at"] = utcnow()
        if page.error or page.status == 0:
            record["fetch_status"], record["fetch_error"] = "fetch_error", (page.error or "network error")[:300]
            return
        if page.status in (401, 402):
            self._mark_paywalled(record, [f"http_{page.status}"])
            return
        if not page.ok:
            record["fetch_status"], record["fetch_error"] = "fetch_error", f"HTTP {page.status}"
            return
        if "html" not in page.content_type and "xml" not in page.content_type and page.content_type:
            record["fetch_status"], record["fetch_error"] = "fetch_error", f"unsupported content-type {page.content_type[:60]}"
            return
        html = page.text()
        extraction = extract_article(html, page.final_url, http_status=page.status)
        if extraction.paywalled:
            self._mark_paywalled(record, extraction.paywall_signals)
            return
        # Only now (not paywalled) do we persist the raw HTML snapshot.
        self._store_snapshot(record, src["slug"], page.body, canonical)
        if extraction.canonical_url:
            try:
                record["canonical_url"] = canonicalize_url(extraction.canonical_url)[:2048]
            except ValueError:
                pass
        if extraction.text:
            record.update(text=extraction.text, extraction_method=extraction.method, fetch_status="fetched")
            if extraction.language and len(extraction.language) == 2:
                record["text_language"] = extraction.language.lower()
        else:
            record.update(fetch_status="fetched", extraction_method="none", fetch_error="no article body extracted")

    def _mark_paywalled(self, record: dict[str, Any], signals: list[str]) -> None:
        # Policy: headline, feed summary, URL and timestamps only. No HTML, no text.
        record.update(
            paywalled=1,
            fetch_status="paywalled",
            text=None,
            raw_html_path=None,
            raw_html_sha256=None,
            extraction_method="none",
            fetch_error=";".join(signals)[:300],
        )

    def _store_snapshot(self, record: dict[str, Any], slug: str, body: bytes, canonical: str) -> None:
        digest = sha256_hex(body)
        safe_slug = _SAFE_SLUG.sub("", slug.lower())[:64] or "src"
        day = utcnow()[:10]
        directory = Path(self.settings.snapshot_dir) / safe_slug / day
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{digest[:32]}.html.gz"
        if not path.exists():
            with gzip.open(path, "wb") as fh:
                fh.write(body)
        record["raw_html_path"] = str(path.relative_to(self.settings.snapshot_dir))
        record["raw_html_sha256"] = digest

    def _add_aliases(self, article_id: int, keys: list[str]) -> None:
        with self.db.transaction() as cur:
            for k in keys:
                cur.execute("INSERT OR IGNORE INTO article_aliases (alias_key, article_id) VALUES (?, ?)", (k, article_id))

    def _insert(self, r: dict[str, Any], keys: list[str]) -> int:
        now = utcnow()
        tr = r.get("translation")
        with self.db.transaction() as cur:
            cur.execute(
                """INSERT INTO articles (
                     source_id, dedup_key, guid, url, canonical_url, title, summary, published_at, discovered_at, fetched_at,
                     language, country_of_publication, reliability, source_type, region_tag, paywalled, fetch_status, fetch_error,
                     extraction_method, raw_html_path, raw_html_sha256, text, text_hash, text_language,
                     translation_text, translation_engine, translation_model, translation_is_machine, translated_at,
                     entities_json, entity_source_language, ner_model, border_regions_json, violence_score, violence_terms_json,
                     is_violence, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    r["source_id"],
                    r["dedup_key"],
                    r["guid"],
                    r["url"],
                    r["canonical_url"],
                    r["title"],
                    r["summary"],
                    r["published_at"],
                    r["discovered_at"],
                    r["fetched_at"],
                    r["language"],
                    r["country_of_publication"],
                    r["reliability"],
                    r["source_type"],
                    r["region_tag"],
                    r["paywalled"],
                    r["fetch_status"],
                    r["fetch_error"],
                    r["extraction_method"],
                    r["raw_html_path"],
                    r["raw_html_sha256"],
                    r["text"],
                    r["text_hash"],
                    r["text_language"],
                    tr.text if tr else None,
                    tr.engine if tr else None,
                    tr.model if tr else None,
                    1,
                    tr.translated_at if tr else None,
                    json.dumps(r["entities"], ensure_ascii=False),
                    r["text_language"] if r["entities"] else None,
                    r["ner_model"],
                    json.dumps([reg.to_dict() for reg in r["regions"]], ensure_ascii=False),
                    r["violence_score"],
                    json.dumps(r["violence_terms"], ensure_ascii=False),
                    r["is_violence"],
                    now,
                    now,
                ),
            )
            article_id = int(cur.lastrowid or 0)
            for k in keys[1:]:
                cur.execute("INSERT OR IGNORE INTO article_aliases (alias_key, article_id) VALUES (?, ?)", (k, article_id))
            for reg in r["regions"]:
                cur.execute(
                    "INSERT OR IGNORE INTO article_regions (article_id, region_code, region_type, region_name, country) VALUES (?,?,?,?,?)",
                    (article_id, reg.code, reg.type, reg.name, reg.country),
                )
        return article_id
