#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * PID-1 wrapper for Docker: EDSDK FFI can block Bun's event loop, so SIGTERM handlers
 * inside the bridge never run. This process only supervises the child and SIGKILLs it on stop.
 */
import { resolve } from 'node:path';

const bridgeScript = resolve(import.meta.dirname, '../canon-bridge.ts');

let child: ReturnType<typeof Bun.spawn> | null = null;
let exiting = false;

async function hardKillChild(signal: string): Promise<void> {
  if (exiting) return;
  exiting = true;
  console.log(`[canon-bridge-supervisor] ${signal} — killing bridge child`);
  const proc = child;
  child = null;
  if (!proc) {
    process.exit(143);
    return;
  }
  try {
    proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    await proc.exited;
  } catch {
    /* ignore */
  }
  process.exit(143);
}

process.on('SIGTERM', () => {
  void hardKillChild('SIGTERM');
});
process.on('SIGINT', () => {
  void hardKillChild('SIGINT');
});

console.log('[canon-bridge-supervisor] starting bridge child (native dev)');

child = Bun.spawn(['bun', bridgeScript], {
  cwd: process.cwd(),
  stdio: ['inherit', 'inherit', 'inherit'],
  env: process.env
});

void (async () => {
  const code = await child!.exited;
  if (!exiting) {
    console.log(`[canon-bridge-supervisor] bridge exited (${code ?? 'unknown'})`);
    process.exit(code === 0 ? 0 : 1);
  }
})();
