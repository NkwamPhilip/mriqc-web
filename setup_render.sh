#!/usr/bin/env bash
# Render build script (Python runtime)
# Builds the React frontend AND installs the Python backend dependencies.
# NOTE: MRIQC cannot run in this environment — it requires a full neuroimaging
#       toolchain (ANTs, FSL, Nipype, ~10 GB). Use the Docker deployment for
#       full MRIQC functionality. This script gives you:
#         ✓  React frontend
#         ✓  DICOM → BIDS conversion  (dcm2bids + dcm2niix)
#         ✗  MRIQC analysis  (not possible without Docker)
set -e

# ── 1. Install Node.js (if not present) and build the React app ───────────────
echo "=== Building React frontend ==="
if ! command -v node &>/dev/null; then
  echo "Node.js not found — installing via nvm..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  source "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
fi
node --version
npm ci
npm run build
echo "React build complete — dist/ has $(find dist -type f | wc -l) files"

# ── 2. Install Python packages ────────────────────────────────────────────────
echo "=== Installing Python packages ==="
pip install --upgrade pip
pip install -r requirements.txt

# ── 3. Download dcm2niix static binary ───────────────────────────────────────
echo "=== Downloading dcm2niix static binary ==="
mkdir -p bin
DCM2NIIX_VER="v1.0.20240202"
DCM2NIIX_URL="https://github.com/rordenlab/dcm2niix/releases/download/${DCM2NIIX_VER}/dcm2niix_lnx.zip"
curl -fsSL "$DCM2NIIX_URL" -o /tmp/dcm2niix.zip
unzip -o /tmp/dcm2niix.zip -d bin/
chmod +x bin/dcm2niix
echo "dcm2niix: $(./bin/dcm2niix --version 2>&1 | head -1)"

echo ""
echo "=== Build complete ==="
echo "  ✓ React frontend built"
echo "  ✓ dcm2bids installed"
echo "  ✓ dcm2niix installed"
echo "  ✗ mriqc NOT available (requires Docker deployment)"
