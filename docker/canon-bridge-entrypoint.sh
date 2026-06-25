#!/bin/sh
# Supervises the Bun bridge: EDSDK FFI can block the child; on stop we SIGKILL + wait to reap.
set -eu

child=0

shutdown() {
  if [ "$child" -ne 0 ]; then
    kill -KILL "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  exit 143
}

trap shutdown TERM INT

echo "[canon-bridge-supervisor] starting bridge child"
bun server/camera/canon/canon-bridge.ts &
child=$!
wait "$child"
