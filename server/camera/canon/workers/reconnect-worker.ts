import type { EventBus } from '../core/event-bus';

type ReconnectOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
};

export class ReconnectWorker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private attempt = 0;

  constructor(
    private readonly bus: EventBus,
    private readonly tryReconnect: () => Promise<boolean>,
    private readonly opts: ReconnectOptions = {}
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(reason: string): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.schedule(reason, this.opts.initialDelayMs ?? 300);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = false;
    this.attempt = 0;
  }

  private schedule(reason: string, delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      void this.tick(reason);
    }, delayMs);
  }

  private async tick(reason: string): Promise<void> {
    if (!this.running) return;
    this.attempt++;
    try {
      const ok = await this.tryReconnect();
      if (ok) {
        this.stop();
        return;
      }
    } catch (error) {
      this.bus.emit('camera.error', {
        error: `reconnect attempt ${this.attempt} failed: ${error instanceof Error ? error.message : String(error)}`,
        at: Date.now()
      });
    }

    const maxAttempts = this.opts.maxAttempts ?? 0;
    if (maxAttempts > 0 && this.attempt >= maxAttempts) {
      this.bus.emit('camera.error', {
        error: `reconnect stopped after ${this.attempt} attempts (${reason})`,
        at: Date.now()
      });
      this.stop();
      return;
    }

    const base = this.opts.initialDelayMs ?? 300;
    const max = this.opts.maxDelayMs ?? 10_000;
    const jitter = Math.floor(Math.random() * 180);
    const nextDelay = Math.min(max, base * (2 ** Math.min(this.attempt, 8)) + jitter);
    this.schedule(reason, nextDelay);
  }
}

