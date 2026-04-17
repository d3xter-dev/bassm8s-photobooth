import type { EventBus } from '../core/event-bus';
import type { BridgeMetrics } from '../core/metrics';
import type { EdsdkSession } from '../esdk/session';

export class LiveViewWorker {
  private pullTimer: ReturnType<typeof setInterval> | null = null;
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pulling = false;
  private pendingFrame: Buffer | null = null;

  private readonly pullMs = Math.max(1, Number(process.env.CANON_EVF_PULL_MS || 5));
  private readonly targetFps = Math.max(1, Number(process.env.CANON_LIVEVIEW_FPS || 24));
  private readonly publishMs = Math.max(1, Math.floor(1000 / this.targetFps));

  constructor(
    private readonly session: EdsdkSession,
    private readonly bus: EventBus,
    private readonly metrics: BridgeMetrics
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.pendingFrame = null;

    this.pullTimer = setInterval(() => {
      if (!this.running || this.pulling) return;
      this.pulling = true;
      const t0 = performance.now();
      try {
        const result = this.session.downloadLiveViewFrame();
        if (result.fatal) {
          this.bus.emit('camera.disconnected', { reason: result.fatal, at: Date.now() });
          this.stop('fatal');
          return;
        }
        if (!result.frame) return;
        if (this.pendingFrame) this.metrics.recordDroppedFrame();
        this.pendingFrame = result.frame;
      } finally {
        this.metrics.recordFrameLoop(performance.now() - t0);
        this.pulling = false;
      }
    }, this.pullMs);

    this.publishTimer = setInterval(() => {
      if (!this.running || !this.pendingFrame) return;
      const jpeg = this.pendingFrame;
      this.pendingFrame = null;
      this.bus.emit('liveview.frame', { jpeg, at: Date.now() });
    }, this.publishMs);
  }

  stop(reason: string): void {
    if (this.pullTimer) {
      clearInterval(this.pullTimer);
      this.pullTimer = null;
    }
    if (this.publishTimer) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
    this.pendingFrame = null;
    const wasRunning = this.running;
    this.running = false;
    if (wasRunning) {
      this.bus.emit('liveview.stopped', { at: Date.now(), reason });
    }
  }
}

