FROM python:3.11-slim

WORKDIR /app/ingest

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY crucix_ingest ./crucix_ingest

RUN pip install --no-cache-dir . \
 && python -m spacy download xx_ent_wiki_sm

# Runtime data (SQLite DB + raw HTML snapshots) lives under /app/runs/ingest, shared with the Node service.
ENV INGEST_API_HOST=0.0.0.0 \
    INGEST_API_PORT=3118 \
    INGEST_DB_PATH=/app/runs/ingest/crucix_ingest.sqlite3 \
    INGEST_SNAPSHOT_DIR=/app/runs/ingest/snapshots

EXPOSE 3118

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3118/health || exit 1

CMD ["python", "-m", "crucix_ingest", "serve"]
