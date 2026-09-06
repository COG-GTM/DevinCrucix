"""End-to-end polling against a loopback origin: health semantics, dedup, paywall policy, content policy, NLP order."""

from __future__ import annotations

import gzip
from pathlib import Path

from crucix_ingest.pipeline import Pipeline
from crucix_ingest.registry import get_source, upsert_source

from .conftest import LocalServer, article_html, fixture_text, make_source

RSS_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title><link>{base}</link>
{items}
</channel></rss>"""


def rss(server: LocalServer, items: list[dict]) -> str:
    rendered = []
    for it in items:
        rendered.append(
            '<item><title>{title}</title><link>{link}</link><guid isPermaLink="false">{guid}</guid>'
            "<pubDate>{pub}</pubDate><description>{desc}</description>{content}</item>".format(
                title=it["title"],
                link=it["link"],
                guid=it.get("guid", it["link"]),
                pub=it.get("pub", "Sat, 05 Sep 2026 12:00:00 +0000"),
                desc=it.get("desc", "summary text"),
                content=f"<content:encoded><![CDATA[{it['content']}]]></content:encoded>" if it.get("content") else "",
            )
        )
    return RSS_TEMPLATE.format(base=server.base, items="\n".join(rendered))


LONG_BODY = [
    "Laredo police said a shooting near the international bridge left two people dead on Friday night.",
    "Investigators recovered several shell casings and are reviewing surveillance footage from nearby businesses.",
    "The gunfire erupted shortly after 10 p.m. as families were leaving a nearby festival, witnesses told reporters.",
    "Officials in Nuevo Laredo confirmed that Mexican authorities are cooperating in the homicide investigation.",
    "No arrests have been announced. Anyone with information is asked to contact the department.",
] * 3


def register(db, server: LocalServer, **overrides) -> dict:
    src = upsert_source(db, make_source(server, **overrides))
    return get_source(db, src["slug"])


def test_poll_ok_stores_text_snapshot_regions_and_violence(db, settings, server):
    page = server.add("/news/shooting", article_html("Two dead in Laredo shooting near bridge", LONG_BODY))
    server.add(
        "/feed",
        rss(server, [{"title": "Two dead in Laredo shooting near bridge", "link": page, "guid": "p1"}]),
        content_type="application/rss+xml",
    )
    src = register(db, server)
    pipe = Pipeline(db, settings)
    summary = pipe.poll_source(src)
    assert summary.status == "ok" and summary.items_total == 1 and summary.items_new == 1

    art = db.query_one("SELECT * FROM articles WHERE id = ?", (summary.new_article_ids[0],))
    assert art["fetch_status"] == "fetched" and art["paywalled"] == 0
    assert art["text"] and "shell casings" in art["text"]
    assert art["extraction_method"] in ("trafilatura", "news-please")
    snap = Path(settings.snapshot_dir) / art["raw_html_path"]
    assert snap.exists() and b"<article>" in gzip.open(snap).read()
    assert art["text_language"] == "en" and art["translation_text"] is None
    regions = {r["region_code"] for r in db.query("SELECT region_code FROM article_regions WHERE article_id = ?", (art["id"],))}
    assert "48479" in regions and "28027" in regions  # Webb County TX, Nuevo Laredo (INEGI)
    assert art["is_violence"] == 1 and art["violence_score"] > 0
    assert "shooting" in art["violence_terms_json"]

    src_row = get_source(db, "testoutlet")
    assert src_row["last_status"] == "ok" and src_row["last_error"] is None and src_row["items_seen_total"] == 1


def test_empty_poll_is_distinct_from_ok_and_not_modified_reuses_validators(db, settings, server):
    calls = {"n": 0}

    def route(handler):
        calls["n"] += 1
        if handler.headers.get("If-None-Match") == '"e1"':
            return 304, {}, b""
        return 200, {"Content-Type": "application/rss+xml", "ETag": '"e1"'}, rss(server, []).encode()

    server.routes["/feed"] = route
    src = register(db, server)
    pipe = Pipeline(db, settings)
    first = pipe.poll_source(src)
    assert first.status == "empty" and first.items_total == 0
    row = get_source(db, "testoutlet")
    assert row["last_status"] == "empty" and row["etag"] == '"e1"' and row["last_success_at"]
    second = pipe.poll_source(row)
    assert second.status == "not_modified" and second.http_status == 304
    assert get_source(db, "testoutlet")["etag"] == '"e1"'


def test_error_then_recovery_clears_stale_error(db, settings, server):
    server.add("/feed", "boom", status=500)
    src = register(db, server)
    pipe = Pipeline(db, settings)
    assert pipe.poll_source(src).status == "error"
    row = get_source(db, "testoutlet")
    assert row["last_status"] == "error" and row["consecutive_errors"] == 1 and "HTTP 500" in row["last_error"]

    server.add("/feed", rss(server, []), content_type="application/rss+xml")
    assert pipe.poll_source(row).status == "empty"
    row = get_source(db, "testoutlet")
    assert row["last_status"] == "empty" and row["last_error"] is None and row["consecutive_errors"] == 0


def test_publisher_403_is_blocked_and_robots_disallow_is_robots_blocked(db, settings, server):
    server.add("/feed", "no", status=403)
    src = register(db, server)
    pipe = Pipeline(db, settings)
    s = pipe.poll_source(src)
    assert s.status == "blocked" and "not retried with altered identity" in (s.error or "")
    assert len(server.hits("/feed")) == 1

    server.robots = "User-agent: *\nDisallow: /feed\n"
    other = register(db, server, slug="other", feed_path="/feed")
    s2 = Pipeline(db, settings).poll_source(other)
    assert s2.status == "robots_blocked"
    assert len(server.hits("/feed")) == 1  # not requested again


def test_dedup_by_guid_canonical_url_and_content_hash(db, settings, server):
    page = server.add("/story", article_html("Border patrol reports record seizure at Pharr bridge", LONG_BODY))
    server.add(
        "/feed",
        rss(
            server,
            [
                {"title": "Border patrol reports record seizure at Pharr bridge", "link": page, "guid": "g1"},
                {
                    "title": "Border patrol reports record seizure at Pharr bridge",
                    "link": page + "?utm_source=rss&amp;utm_medium=feed#top",
                    "guid": "g2",
                },
            ],
        ),
        content_type="application/rss+xml",
    )
    src = register(db, server)
    pipe = Pipeline(db, settings)
    s = pipe.poll_source(src)
    assert s.items_total == 2 and s.items_new == 1
    assert db.query_one("SELECT COUNT(*) AS n FROM article_aliases")["n"] >= 3  # url + both guids preserved as aliases

    # second poll, same guid -> nothing new
    assert pipe.poll_source(get_source(db, "testoutlet")).items_new == 0

    # syndicated copy on another outlet with a different URL but identical body -> content-hash dedup
    copy = server.add("/wire/copy", article_html("Record seizure reported at Pharr bridge (wire)", LONG_BODY))
    server.add(
        "/feed2",
        rss(server, [{"title": "Record seizure reported at Pharr bridge (wire)", "link": copy, "guid": "w1"}]),
        content_type="application/rss+xml",
    )
    other = register(db, server, slug="wireoutlet", feed_path="/feed2")
    s3 = pipe.poll_source(other)
    assert s3.items_total == 1 and s3.items_new == 0
    assert db.query_one("SELECT COUNT(*) AS n FROM articles")["n"] == 1


def test_paywalled_article_keeps_feed_metadata_only(db, settings, server):
    jsonld = '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":false}</script>'
    page = server.add("/premium", article_html("Premium story about Eagle Pass", LONG_BODY, extra_head=jsonld))
    server.add(
        "/feed",
        rss(server, [{"title": "Premium story about Eagle Pass", "link": page, "guid": "pw1", "desc": "Feed summary here"}]),
        content_type="application/rss+xml",
    )
    src = register(db, server)
    s = Pipeline(db, settings).poll_source(src)
    art = db.query_one("SELECT * FROM articles WHERE id = ?", (s.new_article_ids[0],))
    assert art["paywalled"] == 1 and art["fetch_status"] == "paywalled"
    assert art["text"] is None and art["raw_html_path"] is None and art["raw_html_sha256"] is None
    assert art["title"] == "Premium story about Eagle Pass" and art["summary"] == "Feed summary here" and art["published_at"]
    assert not any(Path(settings.snapshot_dir).rglob("*.html.gz"))


def test_http_401_and_402_are_treated_as_paywall_not_bypassed(db, settings, server):
    p1 = server.add("/locked1", "login", status=401)
    p2 = server.add("/locked2", "pay", status=402)
    server.add(
        "/feed",
        rss(server, [{"title": "Locked one", "link": p1, "guid": "l1"}, {"title": "Locked two", "link": p2, "guid": "l2"}]),
        content_type="application/rss+xml",
    )
    s = Pipeline(db, settings).poll_source(register(db, server))
    rows = db.query("SELECT paywalled, fetch_status, text FROM articles WHERE id IN (?, ?)", tuple(s.new_article_ids))
    assert all(r["paywalled"] == 1 and r["fetch_status"] == "paywalled" and r["text"] is None for r in rows)
    assert len(server.hits("/locked1")) == 1 and len(server.hits("/locked2")) == 1


def test_metadata_only_policy_never_requests_article_pages(db, settings, server):
    page = server.add("/story", article_html("Valley story", LONG_BODY))
    body = "<p>" + " ".join(LONG_BODY) + "</p>"
    server.add(
        "/feed", rss(server, [{"title": "Valley story", "link": page, "guid": "m1", "content": body}]), content_type="application/rss+xml"
    )
    src = register(db, server, content_policy="metadata_only")
    s = Pipeline(db, settings).poll_source(src)
    assert s.status == "ok" and s.items_new == 1
    art = db.query_one("SELECT * FROM articles WHERE id = ?", (s.new_article_ids[0],))
    assert art["fetch_status"] == "metadata_only" and art["text"] is None and art["raw_html_path"] is None
    assert art["title"] == "Valley story" and art["url"] == page and art["summary"] == "summary text"
    assert server.hits("/story") == []


def test_article_robots_disallow_keeps_feed_fields_without_page(db, settings, server):
    server.robots = "User-agent: *\nDisallow: /articles/\n"
    page = server.add("/articles/x", article_html("Hidden", LONG_BODY))
    server.add("/feed", rss(server, [{"title": "Hidden article title", "link": page, "guid": "r1"}]), content_type="application/rss+xml")
    s = Pipeline(db, settings).poll_source(register(db, server))
    art = db.query_one("SELECT fetch_status, text FROM articles WHERE id = ?", (s.new_article_ids[0],))
    assert art["fetch_status"] == "robots_disallowed" and art["text"] is None
    assert server.hits("/articles/x") == []


SPANISH_BODY = [
    "Autoridades de Tijuana confirmaron que dos hombres fueron ejecutados la madrugada del sábado en la colonia Libertad.",
    "Los cuerpos presentaban impactos de arma de fuego; peritos de la Fiscalía General del Estado acudieron al lugar.",
    "Vecinos reportaron una balacera cerca de la garita de San Ysidro poco antes de la medianoche.",
    "La FGE de Baja California indicó que el ataque estaría relacionado con disputas entre grupos criminales.",
] * 3


def test_spanish_source_keeps_original_text_as_record_and_tags_mexico_regions(db, settings, server):
    page = server.add("/nota", article_html("Ejecutan a dos hombres en Tijuana tras balacera", SPANISH_BODY, lang="es"))
    server.add(
        "/feed",
        rss(server, [{"title": "Ejecutan a dos hombres en Tijuana tras balacera", "link": page, "guid": "es1"}]),
        content_type="application/rss+xml",
    )
    src = register(
        db,
        server,
        slug="zetatest",
        language="es",
        country_of_publication="MX",
        region_tag="mx-bc-border",
        reliability="independent-media",
        source_type="investigative-weekly",
        phase=2,
    )
    s = Pipeline(db, settings).poll_source(src)
    art = db.query_one("SELECT * FROM articles WHERE id = ?", (s.new_article_ids[0],))
    assert art["language"] == "es" and art["country_of_publication"] == "MX" and art["reliability"] == "independent-media"
    assert art["text_language"] == "es" and "Fiscalía" in art["text"]  # original Spanish is the record
    assert art["translation_text"] is None and art["translation_is_machine"] == 1  # provider "none": derived field stays empty
    regions = {r["region_code"] for r in db.query("SELECT region_code FROM article_regions WHERE article_id = ?", (art["id"],))}
    assert "02004" in regions  # Tijuana (INEGI)
    assert art["is_violence"] == 1 and "balacera" in art["violence_terms_json"]


def test_wp_api_source_uses_api_body_and_skips_page_fetch(db, settings, server):
    server.add("/wp-json/wp/v2/posts", fixture_text("wp_api_texastribune.json"), content_type="application/json")
    src = register(db, server, slug="tt", feed_path="/wp-json/wp/v2/posts", feed_type="wp_api")
    s = Pipeline(db, settings).poll_source(src)
    assert s.status == "ok" and s.items_new == 2
    rows = db.query("SELECT extraction_method, fetch_status, text FROM articles")
    assert all(r["extraction_method"] == "wp_api" and r["fetch_status"] == "fetched" and r["text"] for r in rows)
    assert [r for r in server.requests if r[1] != "/robots.txt" and not r[1].startswith("/wp-json")] == []


def test_sitemap_index_expands_newest_same_host_children(db, settings, server):
    child_ok = server.add("/sitemap/news-2026-09-06.xml", fixture_text("news_sitemap_elmanana.xml"), content_type="application/xml")
    index = f"""<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap><loc>{child_ok}</loc><lastmod>2026-09-06T00:00:00Z</lastmod></sitemap>
      <sitemap><loc>https://cdn.elsewhere.example/news.xml</loc><lastmod>2026-09-07T00:00:00Z</lastmod></sitemap>
    </sitemapindex>"""
    server.add("/sitemap/index.xml", index, content_type="application/xml")
    settings.fetch_article_pages = False
    src = register(db, server, slug="idx", feed_path="/sitemap/index.xml", feed_type="news_sitemap")
    s = Pipeline(db, settings).poll_source(src)
    assert s.status == "ok" and s.items_total == 3 and s.items_new == 3
    assert len(server.hits("/sitemap/news-2026-09-06.xml")) == 1


def test_poll_all_survives_a_crashing_source(db, settings, server):
    server.add("/feed", rss(server, []), content_type="application/rss+xml")
    register(db, server, slug="good")
    register(db, server, slug="bad", feed_path="/missing")
    summaries = {s.slug: s for s in Pipeline(db, settings).poll_all()}
    assert summaries["good"].status == "empty"
    assert summaries["bad"].status == "error" and summaries["bad"].http_status == 404
