#!/usr/bin/env bash
# Start the macOS USB/IP server for Canon cameras (Docker Desktop testing).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

CANON_VID="${CANON_VID:-04a9}"
USBIP_PORT="${USBIP_PORT:-3240}"
CONTROL_PORT="${CONTROL_PORT:-3241}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script is for macOS USB/IP testing only." >&2
  echo "On Linux, use docker compose up (direct /dev/bus/usb passthrough)." >&2
  exit 1
fi

user_python_bin() {
  python3 -m site --user-base 2>/dev/null | sed 's|$|/bin|'
}

resolve_pyusbip() {
  if command -v pyusbip >/dev/null 2>&1; then
    command -v pyusbip
    return 0
  fi
  local user_bin
  user_bin="$(user_python_bin)"
  if [ -n "$user_bin" ] && [ -x "${user_bin}/pyusbip" ]; then
    echo "${user_bin}/pyusbip"
    return 0
  fi
  if [ -x "${HOME}/.local/bin/pyusbip" ]; then
    echo "${HOME}/.local/bin/pyusbip"
    return 0
  fi
  return 1
}

ensure_pyusbip() {
  if resolve_pyusbip >/dev/null; then
    return 0
  fi
  echo "Installing pyusbip..."
  if command -v uv >/dev/null 2>&1; then
    uv tool install "git+https://github.com/jenish-rudani/pyusbip"
  elif command -v pip3 >/dev/null 2>&1; then
    pip3 install --user "git+https://github.com/jenish-rudani/pyusbip"
  else
    echo "Install pyusbip manually: https://github.com/jenish-rudani/pyusbip" >&2
    exit 1
  fi
  if ! resolve_pyusbip >/dev/null; then
    echo "pyusbip installed but binary not found." >&2
    echo "Add to PATH: $(user_python_bin)" >&2
    exit 1
  fi
}

list_devices() {
  if curl -sf "http://127.0.0.1:${CONTROL_PORT}/devices" >/tmp/pyusbip-devices.json 2>/dev/null; then
    echo ""
    echo "Exported / visible devices (HTTP :${CONTROL_PORT}/devices):"
    python3 - <<'PY' /tmp/pyusbip-devices.json
import json, sys
data = json.load(open(sys.argv[1]))
devices = data if isinstance(data, list) else data.get("devices", data)
if not devices:
    print("  (none yet — connect the camera and retry)")
for d in devices:
    vid = d.get("vendor_id") or d.get("vid")
    pid = d.get("product_id") or d.get("pid")
    print(f"  bus_id={d.get('bus_id')}  {d.get('manufacturer','')} {d.get('product','')}  ({vid}:{pid})  state={d.get('bind_state','')}")
PY
    echo ""
  fi
}

ensure_pyusbip
PYUSBIP_BIN="$(resolve_pyusbip)"

echo "=== Bassm8s USB/IP host (Canon VID 0x${CANON_VID}) ==="
echo ""
echo "1. Power on the Canon camera and connect USB."
echo "2. Close EOS Utility / any app that holds the camera."
echo "3. Leave this terminal running, then in another:"
echo "     docker compose -f docker-compose.yml -f docker-compose.mac.yml up --build"
echo ""
echo "USB/IP :${USBIP_PORT}  |  control API http://127.0.0.1:${CONTROL_PORT}/devices"
echo "pyusbip: ${PYUSBIP_BIN}"
echo ""

if [ "${1:-}" = "list" ]; then
  list_devices
  exit 0
fi

if ! sudo -n true 2>/dev/null; then
  echo "pyusbip needs sudo to claim USB devices on macOS."
fi

list_devices || true
# sudo resets PATH — use the full binary path (pip installs to ~/Library/Python/X.Y/bin on macOS).
# Bind USB/IP on all interfaces so Docker Desktop VM can reach us via host.docker.internal.
exec sudo "$PYUSBIP_BIN" --host 0.0.0.0 --vid "0x${CANON_VID}"
