# ── Stage 1: build the React frontend ─────────────────────────────────────────
FROM node:20-slim AS frontend
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build          # outputs to /app/dist

# ── Stage 2: production image ─────────────────────────────────────────────────
# nipreps/mriqc already ships mriqc + ANTs + all neuroimaging dependencies.
# We layer dcm2bids, dcm2niix, and FastAPI on top.
FROM nipreps/mriqc:24.0.2

USER root

# ── System tools ──────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        dcm2niix \
        zip \
        curl \
    && rm -rf /var/lib/apt/lists/*

# ── Python packages ───────────────────────────────────────────────────────────
RUN pip install --no-cache-dir \
        fastapi \
        "uvicorn[standard]" \
        python-multipart \
        dcm2bids

# ── App code ──────────────────────────────────────────────────────────────────
WORKDIR /webmriqc

# Combined FastAPI server
COPY server.py .

# Compiled React frontend from stage 1
COPY --from=frontend /app/dist ./dist

# ── Runtime ───────────────────────────────────────────────────────────────────
EXPOSE 8000

# WORKERS env var lets docker-compose (or -e flag) tune concurrency.
# Default: 2 — one worker can run a long MRIQC job while the second handles
# new uploads. Raise only if your server has ≥64 GB RAM per extra worker.
ENV WORKERS=2

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD curl -f http://localhost:8000/health || exit 1

ENTRYPOINT [] 
CMD ["sh", "-c", \
     "uvicorn server:app \
      --host 0.0.0.0 \
      --port 8000 \
      --timeout-keep-alive 7200 \
      --workers ${WORKERS}"]
