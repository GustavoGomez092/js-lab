/** Spec §11.3: every npm operation gets at most five minutes. */
export const NPM_OPERATION_TIMEOUT_MS = 5 * 60_000;

export class OperationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`npm operation timed out after ${timeoutMs} ms`);
  }
}

export interface QueueTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: QueueTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Serializes npm operations (spec §11.3). A timed-out task's signal is aborted, so its process can be killed. */
export class OperationQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(private readonly options: { timeoutMs?: number; timers?: QueueTimers } = {}) {}

  get pending(): number {
    return this.#pending;
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#pending++;
    const result = this.#tail.then(() => this.#runOne(task));
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result.finally(() => {
      this.#pending--;
    });
  }

  async #runOne<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timers = this.options.timers ?? defaultTimers;
    const timeoutMs = this.options.timeoutMs ?? NPM_OPERATION_TIMEOUT_MS;
    const controller = new AbortController();
    let handle: unknown;
    const timeout = new Promise<never>((_, reject) => {
      handle = timers.setTimeout(() => {
        controller.abort();
        reject(new OperationTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([task(controller.signal), timeout]);
    } finally {
      timers.clearTimeout(handle);
    }
  }
}
