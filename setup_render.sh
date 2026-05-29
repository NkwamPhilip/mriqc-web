#!/usr/bin/env bash
# Render build script — installs dependencies for the Python backend
# No Docker, no apt-get needed: dcm2niix ships as a static Linux binary.
set -e

echo "=== Installing Python packages ==="
pip install --upgrade pip
pip install -r requirements.txt

echo "=== Downloading dcm2niix static binary ==="
mkdir -p bin
DCM2NIIX_VER="v1.0.20240202"
DCM2NIIX_URL="https://github.com/rordenlab/dcm2niix/releases/download/${DCM2NIIX_VER}/dcm2niix_lnx.zip"
curl -fsSL "$DCM2NIIX_URL" -o /tmp/dcm2niix.zip
unzip -o /tmp/dcm2niix.zip -d bin/
chmod +x bin/dcm2niix
echo "dcm2niix version: $(./bin/dcm2niix --version 2>&1 | head -1)"

echo "=== Build complete ==="
