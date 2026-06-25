#!/bin/sh
# PID-1 wrapper: attach loop can block in nsenter/usbip — kill child on stop, never wait forever.
set -eu

child=0
shutdown_requested=0
NSENTER_TIMEOUT_SEC="${NSENTER_TIMEOUT_SEC:-45}"

kill_child() {
  [ "$child" -eq 0 ] && return 0
  kill -KILL "$child" 2>/dev/null || true
  child=0
}

# nsenter children run in the Docker VM PID namespace (pid: host) and survive container stop.
cleanup_vm_usbip() {
  echo "[usbip-supervisor] detaching USB/IP imports in Docker VM..."
  timeout 8 nsenter -t 1 -m -- sh -c '
    usbip port 2>/dev/null | while read -r _ port _; do
      case "$port" in Port*)
        p="${port#Port }"
        p="${p%%:*}"
        usbip detach -p "$p" 2>/dev/null || true
      ;; esac
    done
    pkill -9 usbip 2>/dev/null || true
    pkill -9 -f "nsenter -t 1" 2>/dev/null || true
  ' 2>/dev/null || true
}

shutdown() {
  shutdown_requested=1
  kill_child
  cleanup_vm_usbip
  exit 143
}

trap shutdown TERM INT

while [ "$shutdown_requested" -eq 0 ]; do
  echo "[usbip-supervisor] starting attach loop"
  /attach.sh &
  child=$!
  while kill -0 "$child" 2>/dev/null; do
    [ "$shutdown_requested" -ne 0 ] && shutdown
    sleep 1
  done
  wait "$child" 2>/dev/null || true
  child=0
  [ "$shutdown_requested" -ne 0 ] && exit 143
  echo "[usbip-supervisor] attach loop exited — restart in 3s"
  sleep 3
done
