#!/bin/sh
# Force-clear a stuck canon-bridge container (D-state bun thread / zombie).
# If this fails, restart Docker Desktop — kernel USB state is wedged.
set -eu

COMPOSE_FILES="-f docker-compose.yml -f docker-compose.mac.yml"
CONTAINER="${CANON_BRIDGE_CONTAINER:-bassm8s-photobooth-canon-bridge-1}"

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "[kill-stuck-bridge] container not found: $CONTAINER"
  exit 0
fi

HOST_PID="$(docker inspect -f '{{.State.Pid}}' "$CONTAINER" 2>/dev/null || echo 0)"
echo "[kill-stuck-bridge] container=$CONTAINER init_pid=$HOST_PID"

if [ "$HOST_PID" != "0" ] && [ -n "$HOST_PID" ]; then
  docker run --rm --privileged --pid host --entrypoint sh bassm8s-photobooth-usbip-attach -c "
    set +e
    echo '[kill-stuck-bridge] killing process tree under pid $HOST_PID'
    pkill -9 -P $HOST_PID 2>/dev/null
    kill -9 -$HOST_PID 2>/dev/null
    kill -9 $HOST_PID 2>/dev/null
    # D-state threads ignore signals; list anything left
    for p in \$(pgrep -P $HOST_PID 2>/dev/null) \$(pgrep -f 'bun.*canon-bridge' 2>/dev/null); do
      [ -n \"\$p\" ] || continue
      stat=\$(awk '/^State:/{print \$2}' /proc/\$p/status 2>/dev/null || echo '?')
      wchan=\$(cat /proc/\$p/wchan 2>/dev/null || echo '')
      echo \"[kill-stuck-bridge] pid \$p state=\$stat wchan=\$wchan\"
    done
  " 2>/dev/null || true
fi

# Remove failed-recreate orphans (e.g. c629451bde81_bassm8s-photobooth-canon-bridge-1)
docker ps -aq --filter 'name=bassm8s-photobooth-canon-bridge' 2>/dev/null | while read -r id; do
  name="$(docker inspect -f '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||')"
  case "$name" in
    "$CONTAINER") continue ;;
    *_bassm8s-photobooth-canon-bridge-1|*_bassm8s-photobooth-canon-bridge-1)
      docker rm -f "$id" 2>/dev/null || true
      ;;
  esac
done

if docker rm -f -t 2 "$CONTAINER" 2>/dev/null; then
  echo "[kill-stuck-bridge] removed $CONTAINER"
  exit 0
fi

echo "[kill-stuck-bridge] docker rm still blocked (D-state USB thread in kernel) — restart Docker Desktop, then run:" >&2
echo "  docker compose $COMPOSE_FILES up -d --build" >&2
exit 1
