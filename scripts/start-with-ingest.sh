#!/bin/sh
# Container entrypoint: run the Border Watch ingestion service (Python, loopback only) beside the
# Node dashboard. The dashboard is PID 1's foreground child; if the ingest service dies the
# dashboard keeps serving and the Border Ingest panel reports OFFLINE.
set -eu

PY="${INGEST_PYTHON:-/opt/ingest-venv/bin/python}"
if [ -x "$PY" ]; then
  mkdir -p "$(dirname "${INGEST_DB_PATH:-/app/runs/ingest/crucix_ingest.sqlite3}")"
  (cd /app/ingest && exec "$PY" -m crucix_ingest serve) &
else
  echo "[start] ingest python not found at $PY; dashboard only" >&2
fi

exec node server.mjs
