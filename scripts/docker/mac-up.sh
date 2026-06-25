#!/bin/sh
# macOS stack startup — stop/kill wedged canon-bridge before compose tries to recreate it.
set -eu

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.mac.yml"

echo "[docker:mac] stopping photobooth (if running)..."
$COMPOSE stop -t 5 photobooth 2>/dev/null || true

echo "[docker:mac] stopping canon-bridge (if running)..."
if ! $COMPOSE stop -t 5 canon-bridge 2>/dev/null; then
  echo "[docker:mac] canon-bridge stop timed out — running kill-stuck-bridge"
  ./scripts/docker/kill-stuck-bridge.sh || true
fi

# Failed --force-recreate leaves orphan containers like c629451bde81_bassm8s-photobooth-canon-bridge-1
echo "[docker:mac] removing orphan canon-bridge containers..."
docker ps -aq --filter 'name=bassm8s-photobooth-canon-bridge' 2>/dev/null | while read -r id; do
  name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')"
  case "$name" in
    bassm8s-photobooth-canon-bridge-1) continue ;;
    *_bassm8s-photobooth-canon-bridge-1)
      docker rm -f "$id" 2>/dev/null || true
      ;;
  esac
done

if docker inspect bassm8s-photobooth-canon-bridge-1 >/dev/null 2>&1; then
  if ! docker rm -f -t 3 bassm8s-photobooth-canon-bridge-1 2>/dev/null; then
    echo "[docker:mac] canon-bridge still wedged (D-state USB thread)." >&2
    echo "[docker:mac] Restart Docker Desktop, then run: bun run docker:mac" >&2
    exit 1
  fi
fi

exec $COMPOSE up -d --build "$@"
