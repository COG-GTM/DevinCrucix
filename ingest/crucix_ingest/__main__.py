"""CLI: python -m crucix_ingest <command>."""

from __future__ import annotations

import argparse
import json
import logging
import sys

from .anomaly import detect_news_anomalies, list_anomalies
from .baselines import all_loaders, get_loader, run_due_loaders, run_loader
from .config import load_settings
from .db import Database
from .http_client import build_http_client
from .logging_utils import configure_logging
from .pipeline import Pipeline
from .registry import get_source, list_sources, load_seed, seed_registry, set_enabled, upsert_source
from .service import IngestService, serve


def _print(obj) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False, default=str))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="crucix_ingest", description="CRUCIX border-region ingestion service")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("serve", help="run scheduler + JSON API (default mode)")
    sub.add_parser("api", help="run JSON API only (no scheduler)")
    p = sub.add_parser("poll", help="poll enabled sources once")
    p.add_argument("--source", help="slug of a single source")
    sub.add_parser("sources", help="list source registry")
    sub.add_parser("enable", help="enable a source").add_argument("slug")
    sub.add_parser("disable", help="disable a source").add_argument("slug")
    p = sub.add_parser("baselines", help="run baseline loaders")
    p.add_argument("--dataset", help="run one dataset")
    p.add_argument("--force", action="store_true", help="ignore refresh schedule")
    p.add_argument("--list", action="store_true", help="list registered loaders")
    sub.add_parser("anomalies", help="recompute and print news anomalies")
    p = sub.add_parser("seed", help="seed the source registry from bundled JSON")
    p.add_argument("--refresh", action="store_true", help="also update metadata of existing sources from the seed (poll state is kept)")
    args = parser.parse_args(argv)

    settings = load_settings()
    configure_logging(settings.log_json, logging.INFO)
    settings.ensure_dirs()

    if args.cmd == "serve":
        serve(settings, run_scheduler=True)
        return 0
    if args.cmd == "api":
        serve(settings, run_scheduler=False)
        return 0

    db = Database(settings.db_path)
    seed_registry(db)
    try:
        if args.cmd == "seed":
            if args.refresh:
                for seed_src in load_seed():
                    upsert_source(db, seed_src)
            _print({"sources": len(list_sources(db)), "refreshed": bool(args.refresh)})
        elif args.cmd == "sources":
            _print(list_sources(db))
        elif args.cmd in ("enable", "disable"):
            ok = set_enabled(db, args.slug, args.cmd == "enable")
            _print({"slug": args.slug, "changed": ok})
            return 0 if ok else 1
        elif args.cmd == "poll":
            pipeline = Pipeline(db, settings)
            if args.source:
                src = get_source(db, args.source)
                if not src:
                    print("unknown source", file=sys.stderr)
                    return 1
                _print(pipeline.poll_source(src).to_dict())
            else:
                _print([s.to_dict() for s in pipeline.poll_all()])
                _print({"anomalies": detect_news_anomalies(db, settings)})
        elif args.cmd == "baselines":
            http = build_http_client(settings)
            if args.list:
                _print([{"dataset": ld.dataset, "name": ld.name, "schedule": ld.refresh_schedule, "source": ld.source_url}
                        for ld in all_loaders(db, settings, http)])
            elif args.dataset:
                loader = get_loader(args.dataset, db, settings, http)
                if not loader:
                    print("unknown dataset", file=sys.stderr)
                    return 1
                _print(run_loader(loader).to_dict())
            else:
                _print([r.to_dict() for r in run_due_loaders(db, settings, http, force=args.force)])
        elif args.cmd == "anomalies":
            svc = IngestService(settings, db)
            detect_news_anomalies(svc.db, settings)
            _print(list_anomalies(svc.db, limit=50))
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
