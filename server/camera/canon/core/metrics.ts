type RunningStat = {
  count: number;
  sum: number;
  max: number;
  values: number[];
};

function createStat(): RunningStat {
  return { count: 0, sum: 0, max: 0, values: [] };
}

function pushStat(stat: RunningStat, value: number): void {
  stat.count += 1;
  stat.sum += value;
  stat.max = Math.max(stat.max, value);
  stat.values.push(value);
  if (stat.values.length > 512) stat.values.shift();
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx] ?? 0;
}

export class BridgeMetrics {
  private frameStat = createStat();
  private pumpStat = createStat();
  private frameCounter = 0;
  private fpsWindowStart = Date.now();
  private droppedFrames = 0;

  recordFrameLoop(ms: number): void {
    pushStat(this.frameStat, ms);
    this.frameCounter++;
  }

  recordPumpBlock(ms: number): void {
    pushStat(this.pumpStat, ms);
  }

  recordDroppedFrame(): void {
    this.droppedFrames++;
  }

  snapshot() {
    const now = Date.now();
    const seconds = Math.max(0.001, (now - this.fpsWindowStart) / 1000);
    const fps = this.frameCounter / seconds;
    if (now - this.fpsWindowStart > 1000) {
      this.fpsWindowStart = now;
      this.frameCounter = 0;
    }
    return {
      frameAvgMs: this.frameStat.count ? this.frameStat.sum / this.frameStat.count : 0,
      frameP95Ms: percentile(this.frameStat.values, 0.95),
      frameMaxMs: this.frameStat.max,
      framesPerSecond: fps,
      droppedFrames: this.droppedFrames,
      pumpBlockMaxMs: this.pumpStat.max
    };
  }
}

