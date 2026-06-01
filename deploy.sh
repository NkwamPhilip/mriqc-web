#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# WebMRIQC — one-command deployment script
#
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh              # build + start on port 8000
#   PORT=80 ./deploy.sh      # start on port 80
#   ./deploy.sh --restart    # stop, rebuild, and restart
#   ./deploy.sh --stop       # stop and remove the container
#   ./deploy.sh --logs       # tail live logs
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PORT="${PORT:-8000}"
WORKERS="${WORKERS:-2}"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[webmriqc]${NC} $*"; }
success() { echo -e "${GREEN}[webmriqc]${NC} $*"; }
warn()    { echo -e "${YELLOW}[webmriqc]${NC} $*"; }
error()   { echo -e "${RED}[webmriqc]${NC} $*" >&2; }

# ── Handle flags ──────────────────────────────────────────────────────────────
case "${1:-}" in
  --stop)
    info "Stopping WebMRIQC..."
    docker compose down
    success "Stopped."
    exit 0
    ;;
  --logs)
    docker compose logs -f webmriqc
    exit 0
    ;;
  --restart)
    info "Restarting WebMRIQC (rebuilding image)..."
    docker compose down
    ;;
  ""|--start)
    : # fall through to normal startup
    ;;
  *)
    echo "Usage: $0 [--restart | --stop | --logs]"
    exit 1
    ;;
esac

# ── Check Docker is available ─────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  warn "Docker not found. Attempting to install (requires sudo)..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq ca-certificates curl gnupg
    sudo install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
      | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
      | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
    sudo systemctl enable --now docker
    sudo usermod -aG docker "$USER"
    success "Docker installed. You may need to log out and back in for group permissions."
  else
    error "Auto-install only supports apt (Ubuntu/Debian). Please install Docker manually:"
    error "  https://docs.docker.com/engine/install/"
    exit 1
  fi
fi

if ! docker compose version &>/dev/null; then
  error "docker compose (v2) plugin not found. Please install it:"
  error "  https://docs.docker.com/compose/install/"
  exit 1
fi

# ── Create host temp dir ──────────────────────────────────────────────────────
sudo mkdir -p /tmp/webmriqc
sudo chmod 777 /tmp/webmriqc

# ── Build and start ───────────────────────────────────────────────────────────
info "Building image (this downloads ~6 GB on first run — grab a coffee)..."
PORT="$PORT" WORKERS="$WORKERS" docker compose build

info "Starting WebMRIQC (detached)..."
PORT="$PORT" WORKERS="$WORKERS" docker compose up -d

# ── Wait for health ───────────────────────────────────────────────────────────
info "Waiting for the server to become healthy..."
ATTEMPTS=0
MAX_ATTEMPTS=30   # 30 × 10s = 5 min
until docker inspect --format='{{.State.Health.Status}}' webmriqc 2>/dev/null | grep -q "healthy"; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    warn "Health check timed out. The container may still be starting."
    warn "Run  ./deploy.sh --logs  to watch the startup."
    break
  fi
  echo -n "."
  sleep 10
done
echo ""

# ── Print access info ─────────────────────────────────────────────────────────
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_SERVER_IP")

success "═══════════════════════════════════════════════════════"
success "  WebMRIQC is running!"
success ""
success "  Local:    http://localhost:${PORT}"
success "  Network:  http://${LOCAL_IP}:${PORT}"
success ""
success "  Manage:"
success "    Logs:     ./deploy.sh --logs"
success "    Restart:  ./deploy.sh --restart"
success "    Stop:     ./deploy.sh --stop"
success "═══════════════════════════════════════════════════════"
