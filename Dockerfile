FROM node:22-bookworm-slim

WORKDIR /app

# Python runtime for the Border Watch ingestion service (ingest/crucix_ingest).
# It runs beside the Node dashboard in this container and is only reachable on loopback.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv wget \
 && rm -rf /var/lib/apt/lists/*

COPY ingest/pyproject.toml /app/ingest/pyproject.toml
COPY ingest/crucix_ingest /app/ingest/crucix_ingest
RUN python3 -m venv /opt/ingest-venv \
 && /opt/ingest-venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/ingest-venv/bin/pip install --no-cache-dir /app/ingest \
 && /opt/ingest-venv/bin/python -m spacy download xx_ent_wiki_sm

# Copy package files first for better layer caching
COPY package*.json ./
RUN npm install --production

# Copy source
COPY . .

ENV INGEST_API_HOST=127.0.0.1 \
    INGEST_API_PORT=3118 \
    INGEST_API_URL=http://127.0.0.1:3118 \
    INGEST_DB_PATH=/app/runs/ingest/crucix_ingest.sqlite3 \
    INGEST_SNAPSHOT_DIR=/app/runs/ingest/snapshots

# Default port (override with -e PORT=xxxx)
EXPOSE 3117

# Health check
HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:3117/api/health || exit 1

CMD ["sh", "scripts/start-with-ingest.sh"]
