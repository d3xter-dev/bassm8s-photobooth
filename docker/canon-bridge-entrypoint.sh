#!/bin/sh
# One bridge run per container lifecycle. USB/libusb trouble → exit 1 → Docker restarts clean.
set -eu

CANON_VID="${CANON_USB_VID:-04a9}"
USB_STABLE_POLLS="${CANON_USB_STABLE_POLLS:-3}"
USB_WAIT_MAX_SEC="${CANON_USB_WAIT_MAX_SEC:-180}"
USB_SETTLE_SEC="${CANON_USB_SETTLE_SEC:-3}"
BRIDGE_LOG="${CANON_BRIDGE_LOG:-/tmp/canon-bridge.log}"

child=0
tail_pid=0
shutdown_requested=0
libusb_stale_triggered=0

canon_usb_device_ready() {
  line="$(lsusb -d "${CANON_VID}:" 2>/dev/null | head -1 || true)"
  [ -n "$line" ] || return 1
  bus_dev="$(printf '%s' "$line" | sed -n 's/.*Bus \([0-9][0-9]*\) Device \([0-9][0-9]*\):.*/\1 \2/p')"
  set -- $bus_dev
  [ -n "${1:-}" ] && [ -n "${2:-}" ] || return 1
  node="/dev/bus/usb/$(printf '%03d' "$1")/$(printf '%03d' "$2")"
  [ -e "$node" ]
}

child_stat() {
  [ "$child" -eq 0 ] && return 1
  ps -o stat= -p "$child" 2>/dev/null | tr -d ' ' || true
}

# kill -0 succeeds on zombies; D-state children block wait() forever after SIGKILL.
child_gone() {
  [ "$child" -eq 0 ] && return 0
  kill -0 "$child" 2>/dev/null || return 0
  stat="$(child_stat)"
  [ -z "$stat" ] && return 0
  case "$stat" in *Z*) return 0 ;; esac
  return 1
}

reap_child_if_zombie() {
  [ "$child" -eq 0 ] && return 0
  stat="$(child_stat)"
  case "$stat" in
    *Z*)
      wait "$child" 2>/dev/null || true
      child=0
      ;;
  esac
}

kill_bridge_child() {
  [ "$child" -eq 0 ] && return 0
  kill -KILL "$child" 2>/dev/null || true
  pgid="$(ps -o pgid= -p "$child" 2>/dev/null | tr -d ' ' || true)"
  if [ -n "$pgid" ] && [ "$pgid" != "0" ] && [ "$pgid" != "1" ]; then
    kill -KILL "-$pgid" 2>/dev/null || true
  fi
  reap_child_if_zombie
  child=0
}

stop_tail() {
  [ "$tail_pid" -eq 0 ] && return 0
  kill "$tail_pid" 2>/dev/null || true
  tail_pid=0
}

shutdown() {
  shutdown_requested=1
  kill_bridge_child
  stop_tail
  exit 143
}

trap shutdown TERM INT

interruptible_sleep() {
  secs="${1:-1}"
  end=$(( $(date +%s) + secs ))
  while [ "$(date +%s)" -lt "$end" ]; do
    [ "$shutdown_requested" -ne 0 ] && return 0
    sleep 1
  done
}

wait_for_canon_usb() {
  stable=0
  elapsed=0
  echo "[canon-bridge-supervisor] waiting for Canon USB device node (${CANON_VID})..."
  while [ "$shutdown_requested" -eq 0 ] && [ "$elapsed" -lt "$USB_WAIT_MAX_SEC" ]; do
    if canon_usb_device_ready; then
      stable=$((stable + 1))
      if [ "$stable" -ge "$USB_STABLE_POLLS" ]; then
        echo "[canon-bridge-supervisor] Canon USB device node ready"
        interruptible_sleep "$USB_SETTLE_SEC"
        return 0
      fi
    else
      stable=0
    fi
    interruptible_sleep 2
    elapsed=$((elapsed + 2))
  done
  [ "$shutdown_requested" -ne 0 ] && exit 143
  echo "[canon-bridge-supervisor] Canon USB not ready after ${USB_WAIT_MAX_SEC}s"
  return 1
}

recycle_container() {
  reason="${1:-unknown}"
  echo "[canon-bridge-supervisor] recycling container ($reason)"
  kill_bridge_child
  stop_tail
  exit 1
}

poll_child_exit() {
  exit_code=0
  log_pos=0
  libusb_stale=0

  while ! child_gone; do
    [ "$shutdown_requested" -ne 0 ] && shutdown

    if [ -f "$BRIDGE_LOG" ]; then
      size="$(wc -c < "$BRIDGE_LOG" 2>/dev/null | tr -d ' ' || echo 0)"
      if [ "$size" -gt "$log_pos" ]; then
        new_lines="$(tail -c +$((log_pos + 1)) "$BRIDGE_LOG" 2>/dev/null || true)"
        log_pos="$size"
        if printf '%s' "$new_lines" | grep -qE 'libusb:.*get_usbfs_fd|libusb couldn.t open USB device'; then
          libusb_stale=$((libusb_stale + 1))
          if [ "$libusb_stale" -ge 3 ]; then
            libusb_stale_triggered=1
            recycle_container "libusb_stale_device_node"
          fi
        fi
      fi
    fi

    sleep 1
  done

  reap_child_if_zombie
  stop_tail
}

wait_for_canon_usb || recycle_container "usb_wait_timeout"

echo "[canon-bridge-supervisor] starting bridge"
: > "$BRIDGE_LOG"

tail -n 0 -F "$BRIDGE_LOG" 2>/dev/null | while IFS= read -r line; do
  case "$line" in *LIBUSB_ERROR_INTERRUPTED*) continue ;; esac
  printf '%s\n' "$line"
done &
tail_pid=$!

setsid sh -c 'exec bun server/camera/canon/canon-bridge.ts >>"$0" 2>&1' "$BRIDGE_LOG" &
child=$!

poll_child_exit
[ "$shutdown_requested" -ne 0 ] && exit 143

if [ "$libusb_stale_triggered" -eq 1 ] || [ "${exit_code:-0}" -eq 1 ]; then
  recycle_container "bridge_usb_exit"
fi

recycle_container "bridge_exited_${exit_code:-0}"
