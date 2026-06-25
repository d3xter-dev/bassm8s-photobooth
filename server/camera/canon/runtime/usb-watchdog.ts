/// <reference types="bun" />
import { platform } from 'node:process';

const LIBUSB_STALE_RE =
  /libusb:.*get_usbfs_fd|libusb couldn't open USB device|libusb:.*errno=2/i;

const LIBUSB_NOISE_RE = /LIBUSB_ERROR_INTERRUPTED/i;

export type UsbWatchdogOptions = {
  onUsbLost: (reason: string) => void;
  intervalMs?: number;
  vid?: string;
  libusbStaleThreshold?: number;
  libusbStaleWindowMs?: number;
  lsusbAbsentStreak?: number;
};

export function isCanonUsbPresent(vid = process.env.CANON_USB_VID || '04a9'): boolean | null {
  if (platform !== 'linux') {
    return null;
  }
  try {
    const proc = Bun.spawnSync(['lsusb'], { stdout: 'pipe', stderr: 'pipe' });
    if (proc.exitCode !== 0) {
      return false;
    }
    const out = proc.stdout.toString().toLowerCase();
    const needle = vid.toLowerCase().replace(/^0x/, '');
    return out.includes(needle);
  } catch {
    return null;
  }
}

export function startUsbWatchdog(opts: UsbWatchdogOptions): () => void {
  const intervalMs = opts.intervalMs ?? 3000;
  const staleThreshold = opts.libusbStaleThreshold ?? 3;
  const staleWindowMs = opts.libusbStaleWindowMs ?? 20_000;
  const absentStreakMax = opts.lsusbAbsentStreak ?? 10;
  const vid = opts.vid ?? process.env.CANON_USB_VID ?? '04a9';

  let usbWasPresent = false;
  let absentStreak = 0;
  let libusbStaleHits: number[] = [];
  let fatalScheduled = false;

  const scheduleFatal = (reason: string) => {
    if (fatalScheduled) return;
    fatalScheduled = true;
    console.error(`[canon-bridge] USB lost (${reason}) — exiting for supervisor restart`);
    opts.onUsbLost(reason);
  };

  const noteLibusbStderr = (text: string) => {
    if (LIBUSB_NOISE_RE.test(text)) return;
    if (!LIBUSB_STALE_RE.test(text)) return;
    const now = Date.now();
    libusbStaleHits.push(now);
    libusbStaleHits = libusbStaleHits.filter((t) => now - t <= staleWindowMs);
    if (libusbStaleHits.length >= staleThreshold) {
      scheduleFatal('libusb_stale_device_node');
    }
  };

  process.stderr.on('data', (chunk: Buffer | string) => {
    noteLibusbStderr(typeof chunk === 'string' ? chunk : chunk.toString());
  });

  const timer = setInterval(() => {
    const present = isCanonUsbPresent(vid);
    if (present === true) {
      usbWasPresent = true;
      absentStreak = 0;
      return;
    }
    if (present === null || !usbWasPresent) {
      return;
    }
    absentStreak++;
    if (absentStreak >= absentStreakMax) {
      scheduleFatal('lsusb_missing');
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}
