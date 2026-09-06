"""Border-region geotagging and a bilingual violence-reporting classifier."""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from .config import PACKAGE_DIR

GAZETTEER_PATH = PACKAGE_DIR / "data" / "border_regions.json"


@dataclass(frozen=True)
class Region:
    code: str
    name: str
    type: str          # county | municipality
    country: str       # US | MX
    state: str
    on_border: bool

    def to_dict(self) -> dict:
        return {"code": self.code, "name": self.name, "type": self.type, "country": self.country,
                "state": self.state, "on_border": self.on_border}


def _fold(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", value.lower()).strip()


class Gazetteer:
    def __init__(self, path: Path = GAZETTEER_PATH):
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        self.regions: dict[str, Region] = {}
        patterns: list[tuple[str, str]] = []
        for r in data["regions"]:
            region = Region(code=r["code"], name=r["name"], type=r["type"], country=r["country"], state=r["state"], on_border=bool(r["on_border"]))
            self.regions[region.code] = region
            for alias in r["aliases"]:
                patterns.append((_fold(alias), region.code))
        # longest aliases first so "Nogales, Sonora" wins over "Nogales"
        patterns.sort(key=lambda p: -len(p[0]))
        self._alias_codes: dict[str, str] = {}
        parts: list[str] = []
        for alias, code in patterns:
            if alias in self._alias_codes:
                continue
            self._alias_codes[alias] = code
            parts.append(re.escape(alias).replace(r"\ ", r"\s+").replace(r"\.", r"\.?"))
        self._re = re.compile(r"(?<![\w])(" + "|".join(parts) + r")(?![\w])", re.IGNORECASE)

    def tag(self, *texts: str) -> list[Region]:
        counts: dict[str, int] = {}
        for text in texts:
            if not text:
                continue
            folded = _fold(text)
            for m in self._re.finditer(folded):
                alias = re.sub(r"\s+", " ", m.group(1)).replace(" ,", ",")
                code = self._alias_codes.get(alias) or self._alias_codes.get(alias.replace(".", ""))
                if code is None:
                    # normalise optional dots / whitespace variants back to a known alias
                    for known, kcode in self._alias_codes.items():
                        if known.replace(".", "") == alias.replace(".", ""):
                            code = kcode
                            break
                if code:
                    counts[code] = counts.get(code, 0) + 1
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return [self.regions[c] for c, _ in ordered]

    def get(self, code: str) -> Region | None:
        return self.regions.get(code)

    def all(self) -> Iterable[Region]:
        return self.regions.values()


@lru_cache(maxsize=1)
def default_gazetteer() -> Gazetteer:
    return Gazetteer()


# ---------------------------------------------------------------------------
# Violence classifier (keyword-weighted, EN + ES). Deliberately transparent so
# it is explainable to a government customer; scores are stored with the record.
# ---------------------------------------------------------------------------
_VIOLENCE_TERMS: dict[str, float] = {
    # English
    "homicide": 3, "murder": 3, "murdered": 3, "killed": 2.5, "killing": 2.5, "shooting": 3, "shot dead": 3, "shot and killed": 3,
    "gunfire": 2.5, "gunmen": 3, "gunman": 3, "massacre": 4, "beheaded": 4, "decapitated": 4, "dismembered": 4, "bodies found": 3,
    "body found": 2, "mass grave": 4, "clandestine grave": 4, "kidnapping": 3, "kidnapped": 3, "abducted": 3, "extortion": 2,
    "cartel": 2, "cartel violence": 4, "sicario": 3, "sicarios": 3, "hitmen": 3, "shootout": 3.5, "firefight": 3, "armed attack": 3.5,
    "ambush": 3, "grenade": 3, "explosive": 1, "car bomb": 4, "ied": 2, "narco": 1.5, "drug violence": 3, "femicide": 3,
    "human smuggling": 1.5, "stash house": 1.5, "assassinated": 4, "assassination": 4, "executed": 1.5, "execution-style": 4,
    "torture": 3, "tortured": 3, "disappeared": 2, "disappearances": 2, "violence": 1.5, "violent": 1, "stabbed": 2.5, "stabbing": 2.5,
    "narcobloqueo": 3, "blockade": 1, "burned vehicles": 2, "armed men": 2.5, "gunned down": 3.5,
    # Spanish
    "homicidio": 3, "homicidios": 3, "asesinado": 3, "asesinada": 3, "asesinados": 3, "asesinato": 3, "asesinatos": 3, "ejecutado": 2,
    "ejecutados": 2, "ejecución": 1, "ejecuciones": 2, "balacera": 3.5, "balaceras": 3.5, "tiroteo": 3, "enfrentamiento armado": 3.5,
    "enfrentamiento": 2, "hombres armados": 2.5, "sujetos armados": 2.5, "civiles armados": 2.5,
    "cártel": 2, "narcobloqueos": 3, "secuestro": 3, "secuestrado": 3, "secuestrados": 3, "secuestran": 3,
    "extorsión": 2, "extorsiones": 2, "cobro de piso": 2.5, "fosa clandestina": 4, "fosas clandestinas": 4, "restos humanos": 3,
    "cadáver": 2.5, "cadáveres": 3, "descuartizado": 4, "decapitado": 4, "embolsado": 3.5, "encobijado": 3.5,
    "narcomanta": 3, "narcomantas": 3, "granada": 2.5, "explosivo": 2, "artefacto explosivo": 3, "ataque armado": 3.5,
    "emboscada": 3, "feminicidio": 3, "desaparecido": 2, "desaparecidos": 2, "desaparición": 2, "violencia": 1.5, "levantón": 3,
    "levantados": 3, "acribillado": 3.5, "acribillados": 3.5, "abatido": 2.5, "abatidos": 2.5, "grupo armado": 2.5, "célula criminal": 2,
    "quema de vehículos": 2.5, "vehículos incendiados": 2.5, "bloqueos": 1, "matan": 3, "asesinan": 3, "hallan cuerpo": 3,
    "hallan cuerpos": 3.5, "localizan cuerpo": 3, "sin vida": 2.5, "privado de la vida": 3, "privan de la vida": 3, "lesionado por arma de fuego": 3,
    "herido de bala": 3, "heridos de bala": 3, "disparos": 2.5, "arma de fuego": 2, "armas largas": 2,
}
_NEGATION_CONTEXT = re.compile(r"\b(film|movie|película|novela|serie|series|video game|videojuego|book review|reseña)\b", re.IGNORECASE)


@lru_cache(maxsize=1)
def _violence_regex() -> re.Pattern:
    terms = sorted((_fold(t) for t in _VIOLENCE_TERMS), key=len, reverse=True)
    return re.compile(r"(?<![\w])(" + "|".join(re.escape(t).replace(r"\ ", r"\s+") for t in terms) + r")(?![\w])")


@lru_cache(maxsize=1)
def _folded_terms() -> dict[str, float]:
    return {_fold(k): v for k, v in _VIOLENCE_TERMS.items()}


def violence_score(title: str, text: str | None) -> tuple[float, list[str]]:
    """Return (score, matched_terms). Title matches are weighted 2x. Score is
    normalised per 1,000 words of body text so long features don't dominate."""
    matched: dict[str, int] = {}
    total = 0.0
    folded_title = _fold(title or "")
    folded_text = _fold(text or "")[:60_000]
    rx = _violence_regex()
    weights = _folded_terms()
    for m in rx.finditer(folded_title):
        term = re.sub(r"\s+", " ", m.group(1))
        total += weights.get(term, 1.0) * 2
        matched[term] = matched.get(term, 0) + 1
    body_hits = 0.0
    for m in rx.finditer(folded_text):
        term = re.sub(r"\s+", " ", m.group(1))
        body_hits += weights.get(term, 1.0)
        matched[term] = matched.get(term, 0) + 1
    words = max(len(folded_text.split()), 150)
    total += body_hits * (1000.0 / words) if folded_text else 0.0
    if _NEGATION_CONTEXT.search(folded_title):
        total *= 0.3
    return round(total, 2), sorted(matched, key=lambda t: -matched[t])[:15]


VIOLENCE_THRESHOLD = 6.0


def is_violence_report(score: float) -> bool:
    return score >= VIOLENCE_THRESHOLD
