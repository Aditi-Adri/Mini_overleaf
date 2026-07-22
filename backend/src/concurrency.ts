/**
 * Per-key mutex: serializes async work sharing the same key (e.g. a session's
 * workspace dir), so two overlapping requests can never run tectonic
 * concurrently against the same files. Map entries are intentionally never
 * evicted — session/key cardinality is small (one per browser) for phase 1.
 */
export class KeyedMutex {
  private locks = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(key, previous.then(() => current));

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Caps how many callers can be inside the critical section at once, queueing the rest FIFO. */
export class Semaphore {
  private available: number;
  private queue: Array<() => void> = [];

  constructor(concurrency: number) {
    this.available = concurrency;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available <= 0) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.available--;
    }
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.available++;
    }
  }
}
