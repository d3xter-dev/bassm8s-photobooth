# macOS Docker + Canon USB (USB/IP)

Docker Desktop on macOS cannot pass USB devices directly. This project uses [USB/IP](https://docs.docker.com/desktop/features/usbip/) with [pyusbip](https://github.com/jenish-rudani/pyusbip) on the host.

**Linux production** uses `docker compose up` only (no USB/IP).

## Prerequisites

- Docker Desktop for Mac
- Canon camera on USB
- Python 3 + `pip3` or `uv` (for pyusbip)
- `server/vendor/esdk/linux/ARM64/libEDSDK.so` on the host (mounted into the container)

## Steps

### Terminal 1 — USB/IP server on macOS

```bash
bun run usbip:host
# or: ./scripts/usbip/start-host.sh
```

Enter your password when prompted (`sudo` is required for libusb on macOS).

With the camera connected you should see it at `http://127.0.0.1:3241/devices`.

### Terminal 2 — Docker stack

```bash
bun run docker:mac
# or: docker compose -f docker-compose.yml -f docker-compose.mac.yml up --build
```

The `usbip-attach` sidecar connects the camera into the Docker Desktop VM. `photobooth` starts after the sidecar is healthy.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `No Canon camera detected` in photobooth but `/devices` shows camera | `/devices` is the **Mac host**; EDSDK needs USB/IP import into the VM. Wait for `usbip-attach` log: `Canon camera visible in Docker VM`, then restart photobooth. |
| `Timed out waiting for USB/IP server` | Start `./scripts/usbip/start-host.sh` first |
| `No Canon device in export list` | Replug camera; close EOS Utility; check `curl http://127.0.0.1:3241/devices` |
| Wrong device attached | Set `USBIP_BUS_ID=1-5` under `usbip-attach.environment` in `docker-compose.mac.yml` |
| `Missing libEDSDK.so` | Add Linux ARM64 EDSDK under `server/vendor/esdk/linux/ARM64/` |
| Attach works but capture crashes / Bun segfault | USB/IP + Linux EDSDK + Bun FFI is unstable. `canon-bridge` runs in its own container and auto-restarts. For reliable macOS dev, run `bun run canon-bridge` on the host and set `NUXT_CAMERA_CANON_BRIDGE_URL=http://host.docker.internal:31337`. |

## How it works

```
Canon USB ──► pyusbip (Mac :3240)     ← http://127.0.0.1:3241/devices (host only)
                    │ USB/IP IMPORT
                    ▼
         Docker Desktop Linux VM       ← `lsusb` must show 04a9:xxxx here
                    │ /dev/bus/usb
                    ▼
              photobooth (EDSDK)
```

**Important:** `/devices` on the Mac means pyusbip can see the camera on the host. EDSDK only works after `usbip-attach` successfully imports it into the Docker VM. Check sidecar logs for `Canon camera visible in Docker VM`.
