export function briefCameraConnectError(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'unable to connect, retrying...';
  }
  const msg = err.message.toLowerCase();
  const code = String((err as NodeJS.ErrnoException).code || '').toLowerCase();
  if (msg.includes('no canon camera detected')) {
    return 'camera not detected, retrying...';
  }
  if (
    code === 'econnrefused' ||
    code === 'connectionrefused' ||
    msg.includes('unable to connect') ||
    msg.includes('connection refused')
  ) {
    return 'bridge unavailable, retrying...';
  }
  if (msg.includes('health check timed out') || msg.includes('bridge')) {
    return 'bridge starting, retrying...';
  }
  return 'unable to connect, retrying...';
}
