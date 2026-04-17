type CommandTask<T> = () => Promise<T>;

type QueueItem<T> = {
  run: CommandTask<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timeoutMs?: number;
  label?: string;
};

export class CommandQueue {
  private queue: QueueItem<unknown>[] = [];
  private running = false;

  depth(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  async enqueue<T>(task: CommandTask<T>, opts?: { timeoutMs?: number; label?: string }): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: task,
        resolve,
        reject,
        timeoutMs: opts?.timeoutMs,
        label: opts?.label
      });
      this.kick();
    });
  }

  private kick(): void {
    if (this.running) return;
    this.running = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      try {
        const op = item.run();
        const result = item.timeoutMs && item.timeoutMs > 0
          ? await Promise.race([
              op,
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => reject(new Error(`Command timeout (${item.label || 'anonymous'})`)),
                  item.timeoutMs
                );
              })
            ])
          : await op;
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    this.running = false;
  }
}

