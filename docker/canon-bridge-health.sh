#!/bin/sh
# Health: Canon lsusb entry + /dev/bus/usb node + bridge HTTP health.
set -eu

VID="${CANON_USB_VID:-04a9}"
line="$(lsusb -d "${VID}:" 2>/dev/null | head -1 || true)"
[ -n "$line" ] || exit 1

bus_dev="$(printf '%s' "$line" | sed -n 's/.*Bus \([0-9][0-9]*\) Device \([0-9][0-9]*\):.*/\1 \2/p')"
set -- $bus_dev
[ -n "${1:-}" ] && [ -n "${2:-}" ] || exit 1
node="/dev/bus/usb/$(printf '%03d' "$1")/$(printf '%03d' "$2")"
[ -e "$node" ] || exit 1

exec bun -e "fetch('http://127.0.0.1:31337/health').then(r=>r.json()).then(j=>process.exit(j.ok?0:1)).catch(()=>process.exit(1))"
