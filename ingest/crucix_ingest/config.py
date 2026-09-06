"""Runtime configuration, loaded from environment variables (never hardcoded secrets)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parent
INGEST_DIR = PACKAGE_DIR.parent
REPO_ROOT = INGEST_DIR.parent

DEFAULT_USER_AGENT = (
    "CrucixBorderWatch/1.0 (+https://crucix.fly.dev/crawler; "
    "border-region OSINT research crawler; contact: ops@crucix.fly.dev)"
)


def _env_int(name: str, default: int, lo: int = 0, hi: int = 10_000_000) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return min(max(value, lo), hi)


def _env_float(name: str, default: float, lo: float = 0.0, hi: float = 1e9) -> float:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return min(max(value, lo), hi)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_str(name: str, default: str, max_len: int = 1024) -> str:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip()[:max_len]


_HOST_RE = re.compile(r"^[a-z0-9.-]{1,253}$")


def _env_hosts(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.environ.get(name)
    if raw is None:
        return default
    hosts = [h.strip().lower() for h in raw.split(",")]
    return tuple(h for h in hosts if h and _HOST_RE.match(h))


# Hosts that serve published open-data artifacts linked from an official agency
# page but whose platform-level robots.txt is a blanket ``Disallow: /`` aimed at
# crawlers (SESNSP distributes its monthly zip via a SharePoint tenant). Only
# baseline loaders may fetch from these hosts with ``dataset_download=True``;
# each such fetch is audit-logged. Set INGEST_DATASET_DOWNLOAD_HOSTS="" to
# disable and let those loaders report ``robots_blocked`` instead.
DEFAULT_DATASET_DOWNLOAD_HOSTS: tuple[str, ...] = ("sspcgob-my.sharepoint.com",)


@dataclass
class Settings:
    db_path: Path = field(
        default_factory=lambda: Path(
            _env_str("INGEST_DB_PATH", str(REPO_ROOT / "runs" / "ingest" / "crucix_ingest.sqlite3"))
        )
    )
    snapshot_dir: Path = field(
        default_factory=lambda: Path(
            _env_str("INGEST_SNAPSHOT_DIR", str(REPO_ROOT / "runs" / "ingest" / "snapshots"))
        )
    )
    user_agent: str = field(default_factory=lambda: _env_str("INGEST_USER_AGENT", DEFAULT_USER_AGENT, 512))
    dataset_download_hosts: tuple[str, ...] = field(
        default_factory=lambda: _env_hosts("INGEST_DATASET_DOWNLOAD_HOSTS", DEFAULT_DATASET_DOWNLOAD_HOSTS)
    )
    # Feed polling
    poll_interval_minutes: int = field(default_factory=lambda: _env_int("INGEST_POLL_INTERVAL_MINUTES", 15, 1, 1440))
    per_host_delay_seconds: float = field(
        default_factory=lambda: _env_float("INGEST_PER_HOST_DELAY_SECONDS", 2.0, 0.0, 600.0)
    )
    request_timeout_seconds: float = field(
        default_factory=lambda: _env_float("INGEST_REQUEST_TIMEOUT_SECONDS", 20.0, 1.0, 300.0)
    )
    max_items_per_poll: int = field(default_factory=lambda: _env_int("INGEST_MAX_ITEMS_PER_POLL", 40, 1, 500))
    max_article_bytes: int = field(default_factory=lambda: _env_int("INGEST_MAX_ARTICLE_BYTES", 3_000_000, 10_000))
    max_feed_bytes: int = field(default_factory=lambda: _env_int("INGEST_MAX_FEED_BYTES", 10_000_000, 10_000))
    fetch_article_pages: bool = field(default_factory=lambda: _env_bool("INGEST_FETCH_ARTICLE_PAGES", True))
    # HTTP API
    api_host: str = field(default_factory=lambda: _env_str("INGEST_API_HOST", "127.0.0.1", 255))
    api_port: int = field(default_factory=lambda: _env_int("INGEST_API_PORT", 3118, 1, 65535))
    # NLP
    ner_model: str = field(default_factory=lambda: _env_str("INGEST_NER_MODEL", "xx_ent_wiki_sm", 128))
    ner_enabled: bool = field(default_factory=lambda: _env_bool("INGEST_NER_ENABLED", True))
    # none | libretranslate | openai | argos
    translation_provider: str = field(default_factory=lambda: _env_str("INGEST_TRANSLATION_PROVIDER", "none", 32))
    libretranslate_url: str = field(default_factory=lambda: _env_str("INGEST_LIBRETRANSLATE_URL", "", 512))
    libretranslate_api_key: str = field(default_factory=lambda: _env_str("INGEST_LIBRETRANSLATE_API_KEY", "", 256))
    translation_api_base: str = field(
        default_factory=lambda: _env_str("INGEST_TRANSLATION_API_BASE", "https://api.openai.com/v1", 512)
    )
    translation_api_key: str = field(
        default_factory=lambda: _env_str("INGEST_TRANSLATION_API_KEY", "", 512) or _env_str("LLM_API_KEY", "", 512)
    )
    translation_model: str = field(
        default_factory=lambda: _env_str("INGEST_TRANSLATION_MODEL", "", 128) or _env_str("LLM_MODEL", "gpt-4o-mini", 128)
    )
    translation_max_chars: int = field(default_factory=lambda: _env_int("INGEST_TRANSLATION_MAX_CHARS", 6000, 200, 100_000))
    # Anomaly detection
    anomaly_baseline_weeks: int = field(default_factory=lambda: _env_int("INGEST_ANOMALY_BASELINE_WEEKS", 8, 2, 104))
    anomaly_z_threshold: float = field(default_factory=lambda: _env_float("INGEST_ANOMALY_Z_THRESHOLD", 2.5, 0.5, 20.0))
    anomaly_min_count: int = field(default_factory=lambda: _env_int("INGEST_ANOMALY_MIN_COUNT", 3, 1, 1000))
    # Baselines
    acled_snapshot_path: str = field(default_factory=lambda: _env_str("INGEST_ACLED_SNAPSHOT_PATH", "", 1024))
    # Optional operator-downloaded CBP CSV (used when cbp.gov blocks automated clients from this network).
    cbp_local_path: str = field(default_factory=lambda: _env_str("INGEST_CBP_LOCAL_PATH", "", 1024))
    baseline_check_interval_minutes: int = field(
        default_factory=lambda: _env_int("INGEST_BASELINE_CHECK_INTERVAL_MINUTES", 360, 5, 10080)
    )
    log_json: bool = field(default_factory=lambda: _env_bool("INGEST_LOG_JSON", True))

    def ensure_dirs(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.snapshot_dir.mkdir(parents=True, exist_ok=True)


def load_settings() -> Settings:
    return Settings()
