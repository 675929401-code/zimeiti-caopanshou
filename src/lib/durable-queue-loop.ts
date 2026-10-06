export type DurableQueueLoopSnapshot = {
  name: string;
  running: boolean;
  stopping: boolean;
  inFlight: boolean;
  completedTicks: number;
  failedTicks: number;
};

export type DurableQueueLoopOptions = {
  name: string;
  intervalMs: number;
  runOnce: () => Promise<void>;
  onError?: (error: unknown) => void;
};

/**
 * A single-process scheduler. Database claim RPCs remain the cross-process
 * concurrency boundary; this class only prevents overlapping ticks inside one
 * worker process and provides a bounded graceful drain for PM2 shutdown.
 */
export class DurableQueueLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active: Promise<void> | null = null;
  private running = false;
  private stopping = false;
  private completedTicks = 0;
  private failedTicks = 0;

  constructor(private readonly options: DurableQueueLoopOptions) {
    if (!options.name.trim()) throw new Error('QUEUE_LOOP_NAME_REQUIRED');
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 100) {
      throw new Error('QUEUE_LOOP_INTERVAL_INVALID');
    }
  }

  start() {
    if (this.running || this.stopping) return false;
    this.running = true;
    this.schedule(0);
    return true;
  }

  private schedule(delayMs: number) {
    if (!this.running || this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
    this.timer.unref?.();
  }

  private async tick() {
    if (!this.running || this.stopping || this.active) return;
    const run = (async () => {
      try {
        await this.options.runOnce();
        this.completedTicks += 1;
      } catch (error) {
        this.failedTicks += 1;
        this.options.onError?.(error);
      }
    })();
    this.active = run;
    try {
      await run;
    } finally {
      if (this.active === run) this.active = null;
      this.schedule(this.options.intervalMs);
    }
  }

  async stop(drainTimeoutMs = 25_000) {
    this.stopping = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const active = this.active;
    if (!active) return true;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const drained = await Promise.race([
      active.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(100, drainTimeoutMs));
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return drained;
  }

  snapshot(): DurableQueueLoopSnapshot {
    return {
      name: this.options.name,
      running: this.running,
      stopping: this.stopping,
      inFlight: this.active !== null,
      completedTicks: this.completedTicks,
      failedTicks: this.failedTicks,
    };
  }
}
