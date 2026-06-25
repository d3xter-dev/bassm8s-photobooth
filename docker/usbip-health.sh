#!/bin/sh
set -eu
timeout -k 1 3 nsenter -t 1 -m -- sh -c "lsusb 2>/dev/null | grep -qi '${CANON_VID:-04a9}'"
