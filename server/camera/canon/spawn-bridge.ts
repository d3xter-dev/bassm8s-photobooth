import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RELATIVE_BRIDGE = join('server', 'camera', 'canon', 'canon-bridge.ts');

/**
 * Nitro bundles server code under `.nuxt/dev/` (or `.output/`).
 * Prefer `process.cwd()`, then walk up from this module until `server/camera/canon/canon-bridge.ts` exists.
 */
function resolveCanonBridgeScriptPath(): string {
  if (process.env.CANON_BRIDGE_SCRIPT_PATH) {
    return process.env.CANON_BRIDGE_SCRIPT_PATH;
  }
  const fromCwd = join(process.cwd(), RELATIVE_BRIDGE);
  if (existsSync(fromCwd)) {
    return fromCwd;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 16; i++) {
    const candidate = join(dir, RELATIVE_BRIDGE);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return fromCwd;
}

export function getCanonBridgeScriptPath(): string {
  return resolveCanonBridgeScriptPath();
}

export function spawnCanonBridge(port: number, bunBin = process.env.BUN_BIN || 'bun'): ChildProcess {
  const script = getCanonBridgeScriptPath();
  return spawn(bunBin, [script], {
    env: { ...process.env, CANON_BRIDGE_PORT: String(port) },
    stdio: 'inherit',
    detached: false
  });
}

/** True if the bridge HTTP server is already up (e.g. previous dev session or manual bridge process). */
export async function isCanonBridgeReachable(baseUrl: string, timeoutMs = 2500): Promise<boolean> {
  const health = new URL('/health', baseUrl).toString();
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const r = await fetch(health, { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch {
    return false;
  }
}

export async function waitForBridgeHealth(baseUrl: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const health = new URL('/health', baseUrl).toString();
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 2000);
      const r = await fetch(health, { signal: ac.signal });
      clearTimeout(t);
      if (r.ok) return;
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw lastErr ?? new Error('Canon bridge health check timed out');
}

