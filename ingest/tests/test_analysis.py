"""Geography, violence scoring, paywall detection, dedup keys, language detection, NER on original text."""

from __future__ import annotations

import json

import pytest

from crucix_ingest import geo
from crucix_ingest.dedup import candidate_keys, canonicalize_url, content_key, guid_key, title_date_key, url_key
from crucix_ingest.extract import detect_paywall, extract_article, extract_from_html_fragment
from crucix_ingest.geo import (
    STRONG_TERM_WEIGHT,
    VIOLENCE_THRESHOLD,
    Gazetteer,
    default_gazetteer,
    is_violence_report,
    violence_score,
)
from crucix_ingest.nlp import NerEngine, Translator, detect_language

from .conftest import article_html

# --------------------------------------------------------------------------- gazetteer


def test_gazetteer_loads_us_counties_and_mexican_municipalities():
    gaz = default_gazetteer()
    regions = list(gaz.all())
    types = {r.type for r in regions}
    assert {"county", "municipality"} <= types
    assert {r.country for r in regions} == {"US", "MX"}
    codes = [r.code for r in regions]
    assert len(codes) == len(set(codes))
    assert all(len(r.code) == 5 for r in regions if r.type in ("county", "municipality"))


@pytest.mark.parametrize(
    "text,expected",
    [
        ("Two men were shot in Laredo, Texas on Friday", "48479"),
        ("Autoridades de Nuevo Laredo confirmaron el hallazgo", "28027"),
        ("Ciudad Juárez registra otra jornada violenta", "08037"),
        ("Ciudad Juarez registra otra jornada violenta", "08037"),  # accent-insensitive
        ("CIUDAD JUÁREZ: balacera en la zona centro", "08037"),  # case-insensitive
        ("Calexico port of entry reopens", "06025"),
        ("Violence in El Centro, California prompts curfew", "06025"),
        ("Eagle Pass migrants gather at Shelby Park", "48323"),
        ("Tijuana police recovered bodies near Otay", "02004"),
    ],
)
def test_gazetteer_matches_english_and_spanish_aliases(text, expected):
    codes = [r.code for r in default_gazetteer().tag(text)]
    assert expected in codes


def test_imperial_county_bare_el_centro_is_not_matched():
    # 'el centro' is the Spanish phrase for 'downtown'; only the qualified aliases may match Imperial County.
    codes = [r.code for r in default_gazetteer().tag("Balacera en el centro de Tijuana deja tres muertos")]
    assert "06025" not in codes and "02004" in codes
    assert "06025" not in [r.code for r in default_gazetteer().tag("Shooting at the El Centro mall in Houston")]


def test_gazetteer_orders_by_mention_count():
    regions = default_gazetteer().tag("Laredo", "Laredo and Nuevo Laredo. Laredo police said Nuevo Laredo officials helped. Laredo.")
    assert [r.code for r in regions][:2] == ["48479", "28027"]


def test_gazetteer_rejects_unknown_path(tmp_path):
    bad = tmp_path / "regions.json"
    bad.write_text(
        json.dumps(
            {
                "regions": [
                    {
                        "code": "99999",
                        "type": "county",
                        "name": "X",
                        "country": "US",
                        "state": "TX",
                        "on_border": True,
                        "aliases": ["Xville"],
                    }
                ]
            }
        )
    )
    gaz = Gazetteer(bad)
    assert [r.code for r in gaz.tag("Xville rally")] == ["99999"]


# --------------------------------------------------------------------------- violence classifier


def test_violence_terms_carry_required_weights():
    weights = geo._VIOLENCE_TERMS
    for term, w in {
        "explosive": 1,
        "executed": 1.5,
        "ejecutado": 2,
        "ejecutados": 2,
        "ejecución": 1,
        "ejecuciones": 2,
        "bloqueos": 1,
    }.items():
        assert weights[term] == w, term
    assert weights["massacre"] == 4 and weights["shooting"] == 3


def test_violence_score_is_explainable_and_accent_insensitive():
    score, terms = violence_score("Ejecutan a dos hombres", "Hallan los cuerpos tras una balacera; la Fiscalía investiga la ejecución.")
    assert score > 0 and terms
    assert "balacera" in terms and any(t.startswith("ejecuci") for t in terms)
    score2, terms2 = violence_score("EJECUTAN A DOS HOMBRES", "Hallan los cuerpos tras una BALACERA; la Fiscalia investiga la ejecucion.")
    assert terms2 and "balacera" in terms2  # folded matching
    assert is_violence_report(score, terms)


def test_violence_threshold_requires_corroboration():
    assert not is_violence_report(VIOLENCE_THRESHOLD - 0.1, ["shooting", "gunfire"])
    assert is_violence_report(VIOLENCE_THRESHOLD, ["shooting", "gunfire"])  # two distinct terms
    assert is_violence_report(VIOLENCE_THRESHOLD, ["massacre"])  # one strong term
    assert geo._VIOLENCE_TERMS["explosive"] < STRONG_TERM_WEIGHT
    assert not is_violence_report(VIOLENCE_THRESHOLD, ["explosive"])  # single weak/ambiguous term
    assert is_violence_report(VIOLENCE_THRESHOLD)  # legacy score-only path


def test_violence_score_dampens_entertainment_context():
    s_news, _ = violence_score("Gunmen kill four in Reynosa shooting", "Police said the gunmen fled after the shooting.")
    s_film, _ = violence_score("New film about gunmen and a shooting premieres", "The movie follows gunmen after a shooting.")
    assert s_news > s_film


def test_violence_score_dampens_wildlife_context():
    body = (
        "La propuesta permitiría disparos contra los animales; se han hallado cadáveres de ganado en los ranchos. "
        + "La especie fue reintroducida en la Sierra Madre y su población sigue siendo pequeña. " * 40
    )
    s_wolf, terms = violence_score("Por qué Trump quiere permitir disparos contra el lobo mexicano", body)
    s_news, _ = violence_score("Reportan disparos y cadáveres en Nuevo Laredo", body)
    assert "disparos" in terms and "cadaveres" in terms
    assert s_wolf < s_news
    assert not is_violence_report(s_wolf, terms)


def test_non_violent_border_story_scores_low():
    score, terms = violence_score("Bridge wait times improve at Pharr", "CBP said the new lanes cut commercial wait times by 20 minutes.")
    assert score == 0 and terms == []
    assert not is_violence_report(score, terms)


# --------------------------------------------------------------------------- paywall + extraction


def test_paywall_detection_signals():
    assert detect_paywall("<html></html>", "x" * 2000, http_status=402) == ["http_402"]
    j = '<script type="application/ld+json">{"@type":"NewsArticle","isAccessibleForFree":"False"}</script>'
    assert "jsonld:isAccessibleForFree=false" in detect_paywall(f"<html><head>{j}</head><body></body></html>", "x" * 2000)
    assert detect_paywall(article_html("t", ["free content"] * 40), "free content " * 200) == []
    short = "<html><body><p>Subscribe to continue reading this article.</p></body></html>"
    assert any(s.startswith("text:") for s in detect_paywall(short, "Subscribe to continue reading this article."))


def test_extract_article_reports_canonical_language_and_method():
    html = article_html(
        "Headline",
        [f"Body sentence number {i} is fairly long to satisfy extractors of article text." for i in range(20)],
        lang="es",
        canonical="https://example.com/canonical-story",
    )
    res = extract_article(html, "https://example.com/story?utm=1")
    assert res.text and "Body sentence" in res.text
    assert res.method in ("trafilatura", "news-please")
    assert res.canonical_url == "https://example.com/canonical-story"
    assert res.language == "es" and not res.paywalled


def test_extract_from_html_fragment_strips_markup():
    text = extract_from_html_fragment("<p>Hello <b>world</b>.</p><p>Second &amp; third.</p><script>alert(1)</script>")
    assert text and "Hello" in text and "world" in text and "Second & third." in text and "alert" not in text
    assert extract_from_html_fragment("") is None


# --------------------------------------------------------------------------- dedup keys


def test_canonicalize_url_strips_tracking_and_fragments():
    a = canonicalize_url("HTTPS://www.Example.com/news/story/?utm_source=x&utm_medium=y&fbclid=1#comments")
    b = canonicalize_url("https://www.example.com/news/story")
    assert a == b
    assert canonicalize_url("https://example.com/a?id=5&utm_campaign=z") == "https://example.com/a?id=5"
    assert canonicalize_url("https://amp.example.com/a/amp/") == canonicalize_url("https://example.com/a")


def test_dedup_keys_are_stable_and_distinct():
    assert url_key("https://example.com/a?utm_source=1") == url_key("https://example.com/a")
    assert guid_key("s", "https://example.com/a") == url_key("https://example.com/a")
    assert guid_key("s", "123") != guid_key("t", "123") and guid_key("s", "  ") is None
    assert title_date_key("Short", "2026-09-01") is None
    assert title_date_key("A sufficiently long headline", "2026-09-01T10:00:00+00:00") == title_date_key(
        "a sufficiently LONG headline!", "2026-09-01"
    )
    keys = candidate_keys("s", "https://example.com/a", "g1", "A sufficiently long headline", "2026-09-01")
    assert len(keys) == 3 and keys[0].startswith("url:") and keys[1].startswith("guid:") and keys[2].startswith("td:")


def test_content_key_ignores_headline_line_and_short_text():
    body = "\n".join([f"Sentence about the border corridor incident number {i}." for i in range(12)])
    assert content_key("Headline A\n" + body, "Headline A") == content_key("Headline B\n" + body, "Headline B")
    assert content_key("Headline A\n" + body, "Other") != content_key("Headline B\n" + body, "Other")
    assert content_key("too short") is None


# --------------------------------------------------------------------------- language / NER / translation


def test_language_detection_en_es():
    assert (
        detect_language(
            "The border patrol said the men were arrested near the river on Friday and that the truck was "
            "seized by the agents at the checkpoint in the morning."
        )
        == "en"
    )
    assert (
        detect_language(
            "La policía dijo que los hombres fueron detenidos cerca del río el viernes y que la camioneta "
            "fue asegurada por los agentes en el punto de revisión durante la mañana."
        )
        == "es"
    )
    assert detect_language("Short text.", default="es") == "es"  # too few words: default
    assert detect_language("", default="es") == "es"


def test_ner_disabled_returns_nothing_and_reports_backend():
    eng = NerEngine(enabled=False)
    assert eng.extract("Joe Biden visited El Paso.", "en") == [] and eng.backend == "disabled"


def test_ner_runs_on_original_spanish_text():
    eng = NerEngine(model_name="xx_ent_wiki_sm", enabled=True)
    ents = eng.extract("La Fiscalía General del Estado de Tamaulipas confirmó que Nuevo Laredo registró otra balacera.", "es")
    names = {e.text for e in ents}
    assert ents and any("Nuevo Laredo" in n or "Tamaulipas" in n for n in names)
    assert eng.backend in ("spacy:xx_ent_wiki_sm", "regex-fallback")
    assert all(e.to_dict()["count"] >= 1 for e in ents)


def test_translator_none_provider_is_disabled(settings):
    tr = Translator(settings)
    assert tr.provider == "none" and not tr.enabled
    assert tr.translate("Hola mundo, esto es una prueba.", "es", "en") is None
