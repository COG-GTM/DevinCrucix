"""Language detection, multilingual NER (on original-language text) and machine translation.

Translation is strictly a derived field: the original text is the source of record and
NER never runs on the translation.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .config import Settings
from .logging_utils import log_event

logger = logging.getLogger(__name__)

MAX_NER_CHARS = 20_000
MAX_ENTITIES = 80

_EN_STOP = {"the", "and", "of", "to", "in", "that", "for", "with", "was", "were", "said", "on", "at", "by", "from", "is", "are"}
_ES_STOP = {"el", "la", "los", "las", "de", "del", "que", "en", "y", "por", "con", "para", "una", "un", "se", "su", "fue", "como"}
_WORD_RE = re.compile(r"[a-záéíóúñü]+", re.IGNORECASE)

LABEL_MAP = {"PER": "PERSON", "PERSON": "PERSON", "LOC": "LOCATION", "GPE": "LOCATION", "ORG": "ORGANIZATION", "MISC": "MISC",
             "FAC": "LOCATION", "NORP": "GROUP", "EVENT": "EVENT"}


def detect_language(text: str, default: str = "en") -> str:
    """Cheap stopword-ratio detector for en/es (the only languages in the registry)."""
    if not text:
        return default
    words = _WORD_RE.findall(text[:5000].lower())
    if len(words) < 20:
        return default
    en = sum(1 for w in words if w in _EN_STOP)
    es = sum(1 for w in words if w in _ES_STOP)
    if en == es:
        return default
    return "en" if en > es else "es"


@dataclass
class Entity:
    text: str
    label: str
    count: int = 1

    def to_dict(self) -> dict:
        return {"text": self.text, "label": self.label, "count": self.count}


class NerEngine:
    """spaCy multilingual NER with a conservative regex fallback if the model is missing."""

    def __init__(self, model_name: str = "xx_ent_wiki_sm", enabled: bool = True):
        self.model_name = model_name
        self.enabled = enabled
        self._nlp: Any = None
        self._loaded = False
        self._lock = threading.Lock()
        self.backend = "disabled" if not enabled else "unloaded"

    def _load(self) -> None:
        with self._lock:
            if self._loaded:
                return
            self._loaded = True
            if not self.enabled:
                return
            try:
                import spacy  # type: ignore

                self._nlp = spacy.load(self.model_name, disable=["parser", "lemmatizer", "tagger"])
                self._nlp.max_length = MAX_NER_CHARS + 1000
                self.backend = f"spacy:{self.model_name}"
            except Exception as e:  # model not installed
                self._nlp = None
                self.backend = "regex-fallback"
                log_event(logger, "ner_model_unavailable", logging.WARNING, model=self.model_name, error=str(e)[:200])

    def extract(self, text: str, language: str) -> list[Entity]:
        if not self.enabled or not text:
            return []
        self._load()
        text = text[:MAX_NER_CHARS]
        counts: dict[tuple[str, str], int] = {}
        if self._nlp is not None:
            doc = self._nlp(text)
            for ent in doc.ents:
                label = LABEL_MAP.get(ent.label_, ent.label_)
                name = re.sub(r"\s+", " ", ent.text).strip(" \"'“”‘’.,;:()[]")
                if len(name) < 2 or len(name) > 120 or name.isdigit():
                    continue
                counts[(name, label)] = counts.get((name, label), 0) + 1
        else:
            for name in _fallback_capitalized_spans(text, language):
                counts[(name, "UNKNOWN")] = counts.get((name, "UNKNOWN"), 0) + 1
        ents = [Entity(text=k[0], label=k[1], count=v) for k, v in counts.items()]
        ents.sort(key=lambda e: (-e.count, e.text))
        return ents[:MAX_ENTITIES]


_CAP_SPAN_RE = re.compile(r"\b(?:[A-ZÁÉÍÓÚÑ][\wáéíóúñü'’-]+)(?:\s+(?:de|del|la|las|los|of|the|y|and|el)\s+)?(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñü'’-]+){0,3}")
_SENTENCE_START_STOP = {"The", "A", "An", "In", "On", "At", "El", "La", "Los", "Las", "Un", "Una", "En", "De", "Por", "This", "That", "It", "He", "She", "They", "We"}


def _fallback_capitalized_spans(text: str, language: str) -> list[str]:
    out: list[str] = []
    for m in _CAP_SPAN_RE.finditer(text):
        span = m.group(0).strip()
        first = span.split()[0]
        if first in _SENTENCE_START_STOP and len(span.split()) == 1:
            continue
        if len(span) < 3:
            continue
        out.append(span)
    return out


@dataclass
class Translation:
    text: str
    engine: str
    model: str
    translated_at: str
    is_machine_translation: bool = True


class Translator:
    """Pluggable machine-translation providers. ``none`` records that translation is pending."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.provider = settings.translation_provider.lower()
        if self.provider not in {"none", "libretranslate", "openai", "argos"}:
            log_event(logger, "translation_provider_unknown", logging.WARNING, provider=self.provider)
            self.provider = "none"
        self._argos = None

    @property
    def enabled(self) -> bool:
        if self.provider == "libretranslate":
            return bool(self.settings.libretranslate_url)
        if self.provider == "openai":
            return bool(self.settings.translation_api_key)
        return self.provider == "argos"

    def translate(self, text: str, source_lang: str, target_lang: str = "en") -> Translation | None:
        if not text or source_lang == target_lang or not self.enabled:
            return None
        text = text[: self.settings.translation_max_chars]
        try:
            if self.provider == "libretranslate":
                return self._libretranslate(text, source_lang, target_lang)
            if self.provider == "openai":
                return self._openai(text, source_lang, target_lang)
            if self.provider == "argos":
                return self._argos_translate(text, source_lang, target_lang)
        except Exception as e:
            log_event(logger, "translation_failed", logging.WARNING, provider=self.provider, error=str(e)[:200])
        return None

    def _post_json(self, url: str, payload: dict, headers: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": "application/json", **headers})
        with urllib.request.urlopen(req, timeout=self.settings.request_timeout_seconds * 3) as resp:  # noqa: S310
            return json.loads(resp.read(5_000_000).decode("utf-8"))

    def _libretranslate(self, text: str, source_lang: str, target_lang: str) -> Translation | None:
        url = self.settings.libretranslate_url.rstrip("/") + "/translate"
        payload = {"q": text, "source": source_lang, "target": target_lang, "format": "text"}
        if self.settings.libretranslate_api_key:
            payload["api_key"] = self.settings.libretranslate_api_key
        data = self._post_json(url, payload, {})
        translated = data.get("translatedText")
        if not translated:
            return None
        return Translation(text=str(translated), engine="libretranslate", model="libretranslate",
                           translated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))

    def _openai(self, text: str, source_lang: str, target_lang: str) -> Translation | None:
        url = self.settings.translation_api_base.rstrip("/") + "/chat/completions"
        payload = {
            "model": self.settings.translation_model,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": (
                    f"You are a professional news translator. Translate the user's text from {source_lang} to {target_lang}. "
                    "Preserve names, places and figures exactly. Output only the translation.")},
                {"role": "user", "content": text},
            ],
        }
        data = self._post_json(url, payload, {"Authorization": f"Bearer {self.settings.translation_api_key}"})
        choices = data.get("choices") or []
        if not choices:
            return None
        content = (choices[0].get("message") or {}).get("content")
        if not content:
            return None
        return Translation(text=str(content).strip(), engine="openai-compatible", model=self.settings.translation_model,
                           translated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))

    def _argos_translate(self, text: str, source_lang: str, target_lang: str) -> Translation | None:
        import argostranslate.translate  # type: ignore

        translated = argostranslate.translate.translate(text, source_lang, target_lang)
        if not translated:
            return None
        return Translation(text=translated, engine="argos-translate", model=f"{source_lang}-{target_lang}",
                           translated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
