#!/bin/sh
# Attach a USB/IP-exported Canon camera into the Docker Desktop Linux VM.
# Runs inside a privileged container with --pid=host (see docker-compose.mac.yml).
set -eu

USBIP_HOST="${USBIP_HOST:-host.docker.internal}"
CANON_VID="${CANON_VID:-04a9}"
BUS_ID="${USBIP_BUS_ID:-}"
NSENTER_TIMEOUT_SEC="${NSENTER_TIMEOUT_SEC:-45}"

shutdown_requested=0

shutdown() {
  shutdown_requested=1
  exit 143
}

trap shutdown TERM INT

interruptible_sleep() {
  secs="${1:-1}"
  end=$(( $(date +%s) + secs ))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ "$shutdown_requested" -ne 0 ] && exit 143
    sleep 1
  done
}

nsenter_usbip() {
  [ "$shutdown_requested" -ne 0 ] && exit 143
  timeout -k 2 "$NSENTER_TIMEOUT_SEC" nsenter -t 1 -m -- usbip "$@"
}

nsenter_sh() {
  [ "$shutdown_requested" -ne 0 ] && exit 143
  timeout -k 2 "$NSENTER_TIMEOUT_SEC" nsenter -t 1 -m -- sh -c "$1"
}

canon_visible_in_vm() {
  nsenter_sh "lsusb 2>/dev/null | grep -qi '${CANON_VID}'"
}

refresh_export_list() {
  nsenter_usbip list -r "$USBIP_HOST" >/tmp/usbip-list.txt 2>/dev/null || return 1
  grep -q "Exportable USB devices" /tmp/usbip-list.txt
}

wait_for_server() {
  echo "[usbip-attach] Waiting for USB/IP server at ${USBIP_HOST}..."
  i=0
  while [ "$i" -lt 120 ]; do
    [ "$shutdown_requested" -ne 0 ] && exit 143
    if refresh_export_list; then
      echo "[usbip-attach] USB/IP server is reachable."
      return 0
    fi
    i=$((i + 1))
    interruptible_sleep 2
  done
  echo "[usbip-attach] Timed out waiting for USB/IP server." >&2
  echo "[usbip-attach] On macOS, run: ./scripts/usbip/start-host.sh" >&2
  return 1
}

resolve_bus_id() {
  if [ -n "$BUS_ID" ]; then
    echo "$BUS_ID"
    return 0
  fi

  refresh_export_list || true
  found="$(grep -Ei "\\(${CANON_VID}:" /tmp/usbip-list.txt | head -1 | sed -E 's/^[[:space:]]+([0-9]+-[0-9]+):.*/\1/' || true)"
  if [ -z "$found" ]; then
    found="$(grep -Ei "canon" /tmp/usbip-list.txt | head -1 | sed -E 's/^[[:space:]]+([0-9]+-[0-9]+):.*/\1/' || true)"
  fi
  if [ -z "$found" ]; then
    return 1
  fi
  echo "$found"
}

detach_stale_imports() {
  nsenter_sh "usbip port 2>/dev/null" >/tmp/usbip-port.txt 2>/dev/null || return 0
  grep -E '^Port [0-9]+' /tmp/usbip-port.txt 2>/dev/null | while read -r _ port _; do
    [ "$shutdown_requested" -ne 0 ] && exit 143
    port="${port#Port }"
    port="${port%%:*}"
    echo "[usbip-attach] Detaching stale USB/IP port ${port}..."
    nsenter_usbip detach -p "$port" 2>/dev/null || true
  done
}

attach_once() {
  bus_id="$1"
  echo "[usbip-attach] Attaching bus id ${bus_id} from ${USBIP_HOST}..."
  detach_stale_imports
  if nsenter_usbip attach -r "$USBIP_HOST" -d "$bus_id" 2>/tmp/usbip-attach.err; then
    echo "[usbip-attach] usbip attach succeeded for ${bus_id}."
    return 0
  fi
  if grep -qi "already" /tmp/usbip-attach.err 2>/dev/null; then
    echo "[usbip-attach] Device ${bus_id} already attached."
    return 0
  fi
  cat /tmp/usbip-attach.err >&2 2>/dev/null || true
  return 1
}

wait_for_canon_in_vm() {
  i=0
  while [ "$i" -lt 20 ]; do
    [ "$shutdown_requested" -ne 0 ] && exit 143
    if canon_visible_in_vm; then
      echo "[usbip-attach] Canon camera visible in Docker VM:"
      nsenter_sh "lsusb | grep -i '${CANON_VID}' || lsusb" || true
      return 0
    fi
    i=$((i + 1))
    interruptible_sleep 1
  done
  return 1
}

attach_canon_loop() {
  while [ "$shutdown_requested" -eq 0 ]; do
    if canon_visible_in_vm; then
      interruptible_sleep 2
      continue
    fi

    echo "[usbip-attach] Canon not visible in VM — detaching stale imports and re-attaching..."
    detach_stale_imports
    wait_for_server || {
      interruptible_sleep 5
      continue
    }

    bus_id="$(resolve_bus_id || true)"
    if [ -z "$bus_id" ]; then
      echo "[usbip-attach] No Canon on pyusbip export list (host :3241/devices may still show it before export)." >&2
      cat /tmp/usbip-list.txt >&2 2>/dev/null || true
      interruptible_sleep 5
      continue
    fi

    if attach_once "$bus_id" && wait_for_canon_in_vm; then
      echo "[usbip-attach] Ready — EDSDK in photobooth can use /dev/bus/usb."
      while [ "$shutdown_requested" -eq 0 ] && canon_visible_in_vm; do
        interruptible_sleep 2
      done
      echo "[usbip-attach] Canon disappeared from VM — will re-attach."
      detach_stale_imports
    else
      echo "[usbip-attach] Attach failed for bus ${bus_id}; retrying in 5s..." >&2
      interruptible_sleep 5
    fi
  done
}

attach_canon_loop
