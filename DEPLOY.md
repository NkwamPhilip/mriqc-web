# WebMRIQC — Server Deployment Guide

Deploy the full WebMRIQC stack (React frontend + FastAPI + MRIQC + dcm2bids) as a **single Docker container** on any Linux compute server. Anyone on the network can then open a browser and use the site remotely.

---

## Minimum server requirements

| Resource | Minimum | Recommended |
|---|---|---|
| CPU cores | 8 | 16–32 |
| RAM | 16 GB | 32–64 GB |
| Disk (free) | 20 GB | 60 GB |
| OS | Ubuntu 20.04+ / Debian 11+ | Ubuntu 22.04 LTS |

> MRIQC is memory-hungry. Processing a single T1w subject typically uses 8–16 GB RAM.

---

## Quick start (3 commands)

```bash
# 1. Clone / copy the project onto the server
git clone <your-repo-url> webmriqc && cd webmriqc
# — or — scp -r ./mriqc-web user@server:~/webmriqc && cd ~/webmriqc

# 2. Make the deploy script executable (only needed once)
chmod +x deploy.sh

# 3. Build and start
./deploy.sh
```

The first run downloads the `nipreps/mriqc` base image (~5–6 GB). Subsequent starts are instant.

Once running, open **`http://<server-ip>:8000`** in any browser on the network.

---

## Configuration

Create a `.env` file next to `docker-compose.yml` to override defaults:

```dotenv
# Port the site is reachable on (default 8000)
PORT=8000

# Number of uvicorn worker processes (default 2)
# Only increase if you have ≥64 GB RAM — each worker can run one MRIQC job
WORKERS=2
```

Then redeploy:

```bash
./deploy.sh --restart
```

---

## Managing the service

```bash
./deploy.sh --logs      # tail live logs  (Ctrl-C to stop tailing)
./deploy.sh --restart   # stop, rebuild image, and restart
./deploy.sh --stop      # stop and remove the container

# Or use docker compose directly:
docker compose ps                   # check status
docker compose logs -f webmriqc     # live logs
docker compose down                 # stop
docker compose up -d                # start (without rebuilding)
docker compose up -d --build        # rebuild and start
```

---

## Updating the site (after code changes)

```bash
git pull                 # or copy new files to the server
./deploy.sh --restart    # rebuilds the image and restarts
```

---

## Adding HTTPS (optional but recommended for remote access)

### Option A — Self-signed cert (no domain name needed)

```bash
mkdir -p ssl
openssl req -x509 -nodes -days 3650 -newkey rsa:4096 \
  -keyout ssl/key.pem -out ssl/cert.pem \
  -subj "/CN=webmriqc"
```

Then uncomment the `nginx` service in `docker-compose.yml` and restart:

```bash
./deploy.sh --restart
```

The site will now be at **`https://<server-ip>`**. Browsers will warn about the self-signed cert — click "Advanced → Proceed" to continue.

### Option B — Let's Encrypt (requires a domain name)

Install [Caddy](https://caddyserver.com/) on the host as a reverse proxy — it auto-provisions and renews certs:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/pub/linux/apt/sources.list.d/caddy-stable.list' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# /etc/caddy/Caddyfile:
# yourdomain.com {
#     reverse_proxy localhost:8000
# }
sudo systemctl restart caddy
```

---

## Opening firewall port

If the server has a firewall (UFW or firewalld), open the port you chose:

```bash
# UFW (Ubuntu default)
sudo ufw allow 8000/tcp
sudo ufw reload

# firewalld (CentOS / RHEL / Fedora)
sudo firewall-cmd --permanent --add-port=8000/tcp
sudo firewall-cmd --reload
```

---

## Persistent temp storage

Work directories for DICOM conversion and MRIQC runs are written to `/tmp/webmriqc` on the **host** (mounted into the container). They are cleaned up automatically after each job. If a job crashes you can manually clean up with:

```bash
sudo rm -rf /tmp/webmriqc/*
```

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Site unreachable from other machines | Firewall blocking the port | Open the port (see above) |
| Container exits immediately | Not enough RAM or disk | Check `docker compose logs webmriqc` |
| MRIQC step hangs >30 min | Out of memory | Reduce `WORKERS` to `1`, or add more RAM |
| "mriqc not found" on health check | First-run Docker image pull in progress | Wait 2–3 min and reload |
| Build fails at `npm ci` | Network issue fetching npm packages | Retry; or pre-build on a machine with internet then push the image |

---

## Architecture

```
Browser  ──→  port 8000  ──→  uvicorn (FastAPI)
                                  ├─ GET  /*             → serves React SPA (dist/)
                                  ├─ POST /convert-dicom → runs dcm2bids locally
                                  └─ POST /run-mriqc     → runs mriqc CLI locally
```

Everything runs inside a single Docker container derived from `nipreps/mriqc:24.0.2`, which already includes MRIQC, ANTs, FSL, and Nipype. The `deploy.sh` script layers dcm2niix, dcm2bids, and the FastAPI server on top.
