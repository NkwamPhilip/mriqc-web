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

# Copy the combined FastAPI server
COPY server.py .

# Copy the compiled React frontend
COPY --from=frontend /app/dist ./dist

# ── Runtime ───────────────────────────────────────────────────────────────────
EXPOSE 8000

# Increase uvicorn timeout for long MRIQC jobs (up to 2 h)
CMD ["uvicorn", "server:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--timeout-keep-alive", "7200", \
     "--workers", "2"]
