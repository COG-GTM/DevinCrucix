"""Feed-shape tests against recorded payloads (one fixture per adapter; never assume field names)."""

from __future__ import annotations

import pytest

from crucix_ingest.feeds import (
    MAX_CHILD_SITEMAPS,
    FeedParseError,
    detect_feed_type,
    is_sitemap_index,
    parse_datetime,
    parse_feed,
    parse_sitemap_index,
)

from .conftest import fixture_bytes


def test_rss_wordpress_shape_borderreport():
    items = parse_feed(fixture_bytes("rss_borderreport.xml"), "rss")
    assert len(items) == 3
    first = items[0]
    assert first.url.startswith("https://www.borderreport.com/news/")
    assert first.guid == "https://www.borderreport.com/?p=3078323"
    assert first.title.startswith("From Juárez tunnel to El Paso drains")
    assert first.published_at == "2026-09-05T00:08:42+00:00"
    assert first.language == "en-US"
    assert first.summary and "<" not in first.summary


def test_rss_spanish_content_encoded_zetatijuana():
    items = parse_feed(fixture_bytes("rss_zetatijuana.xml"), "rss")
    assert len(items) == 3
    assert items[0].language == "es"
    assert items[0].title.startswith("FGE llevará el caso Jireh")
    assert items[0].content_html and "<p>" in items[0].content_html  # <content:encoded> retained for feed-only fallback
    assert items[1].published_at == "2026-09-06T00:50:33+00:00"


def test_atom_blogger_shape_borderlandbeat():
    items = parse_feed(fixture_bytes("atom_borderlandbeat.xml"), "atom")
    assert len(items) == 3
    assert all(i.url.startswith("https://www.borderlandbeat.com/2026/") for i in items)
    assert items[0].guid and items[0].guid.startswith("tag:blogger.com,1999:blog-")
    assert items[1].title == "Three Captured after CJNG Car Bomb in Ojocaliente, Zacatecas"
    assert items[1].published_at == "2026-09-04T19:42:37+00:00"
    assert items[0].content_html


def test_news_sitemap_shape_elmanana():
    items = parse_feed(fixture_bytes("news_sitemap_elmanana.xml"), "news_sitemap")
    assert len(items) == 3
    assert items[0].guid == items[0].url
    assert items[0].language == "es"
    assert items[0].published_at == "2026-09-06T14:49:00+00:00"
    assert items[0].summary == ""  # sitemaps carry no description; body must come from the page
    assert items[2].url.startswith("https://elmanana.com.mx/nuevo-laredo/")


def test_wp_api_shape_texastribune():
    items = parse_feed(fixture_bytes("wp_api_texastribune.json"), "wp_api")
    assert len(items) == 2
    assert items[0].url == "https://www.texastribune.org/2026/09/05/texas-maga-inc-10-million-ad-spend-paxton-trump/"
    assert items[0].guid == "https://www.texastribune.org/?p=242116"
    assert items[0].published_at == "2026-09-05T18:47:51+00:00"  # date_gmt, not local ``date``
    assert items[0].content_html and len(items[0].content_html) > 1000
    assert items[1].title.startswith("ICE officer charged in Minnesota shooting")


def test_wp_api_error_payload_is_a_parse_error():
    with pytest.raises(FeedParseError):
        parse_feed(b'{"code":"rest_no_route","message":"No route","data":{"status":404}}', "wp_api")


def test_detect_feed_type_from_body():
    assert detect_feed_type(fixture_bytes("rss_borderreport.xml")) == "rss"
    assert detect_feed_type(fixture_bytes("atom_borderlandbeat.xml")) == "atom"
    assert detect_feed_type(fixture_bytes("news_sitemap_elmanana.xml")) == "news_sitemap"
    assert detect_feed_type(fixture_bytes("wp_api_texastribune.json")) == "wp_api"


def test_malformed_xml_is_a_parse_error():
    with pytest.raises(FeedParseError):
        parse_feed(b"<rss><channel><item><title>x</title>", "rss")


def test_xxe_entities_are_rejected():
    evil = (
        b'<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
        b"<rss><channel><item><title>&x;</title><link>https://a.example/p</link></item></channel></rss>"
    )
    with pytest.raises(FeedParseError):
        parse_feed(evil, "rss")


def test_parse_datetime_normalises_to_utc():
    assert parse_datetime("Sat, 05 Sep 2026 22:18:51 +0000") == "2026-09-05T22:18:51+00:00"
    assert parse_datetime("2026-09-06T08:49:00-06:00") == "2026-09-06T14:49:00+00:00"
    assert parse_datetime("2026-09-05T18:47:51") == "2026-09-05T18:47:51+00:00"
    assert parse_datetime("garbage") is None


SITEMAP_INDEX = b"""<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://www.example.com/sitemap/news-2026-09-04.xml</loc><lastmod>2026-09-04T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>https://www.example.com/sitemap/news-2026-09-06.xml</loc><lastmod>2026-09-06T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>https://cdn.other-host.com/sitemap/news.xml</loc><lastmod>2026-09-07T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>https://www.example.com/sitemap/news-2026-09-05.xml</loc><lastmod>2026-09-05T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>https://www.example.com/sitemap/news-2026-09-03.xml</loc><lastmod>2026-09-03T00:00:00Z</lastmod></sitemap>
  <sitemap><loc>ftp://www.example.com/sitemap/bad.xml</loc></sitemap>
</sitemapindex>"""


def test_sitemap_index_is_detected_and_bounded():
    assert is_sitemap_index(SITEMAP_INDEX)
    assert not is_sitemap_index(fixture_bytes("news_sitemap_elmanana.xml"))
    children = parse_sitemap_index(SITEMAP_INDEX, "https://www.example.com/sitemap/index.xml")
    assert len(children) == MAX_CHILD_SITEMAPS == 3
    assert children == [
        "https://www.example.com/sitemap/news-2026-09-06.xml",
        "https://www.example.com/sitemap/news-2026-09-05.xml",
        "https://www.example.com/sitemap/news-2026-09-04.xml",
    ]
    assert all("other-host" not in c and not c.startswith("ftp:") for c in children)
