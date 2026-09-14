/** Spec §11.3: every npm operation gets at most five minutes. */
export const NPM_OPERATION_TIMEOUT_MS = 5 * 60_000;

/** Fix round 1 (I-1): how long a timed-out task's own promise is awaited before the queue moves on regardless. */
export const NPM_OPERATION_KILL_GRACE_MS = 10_000;

export class OperationTimeoutError extends Error {
  /**
   * The timed-out task's own fulfilled value, when it settled within the kill grace (I-1). Wrapped so an actually
   * fulfilled `undefined` is distinguishable from "never settled in time".
   */
  constructor(
    readonly timeoutMs: number,
    readonly settled?: { readonly value: unknown },
  ) {
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

/** A unique marker so the timeout race's rejection can never be confused with a genuine task rejection. */
const TIMEOUT_MARKER = Symbol("jslab-npm-operation-timeout");

/**
 * Serializes npm operations (spec §11.3). A timed-out task's signal is aborted, and its own settlement (bounded by
 * a kill grace) is awaited before the next task starts (fix round 1, I-1) — so a task's late side effects (a file
 * write, another spawn) can never race the next task's.
 */
export class OperationQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(private readonly options: { timeoutMs?: number; graceMs?: number; timers?: QueueTimers } = {}) {}

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
    const taskPromise = task(controller.signal);
    let timedOut = false;
    let handle: unknown;
    const timeout = new Promise<never>((_, reject) => {
      handle = timers.setTimeout(() => {
        timedOut = true;
        reject(TIMEOUT_MARKER);
      }, timeoutMs);
    });
    try {
      return await Promise.race([taskPromise, timeout]);
    } catch (error) {
      if (!timedOut) throw error;
      controller.abort();
      const settled = await this.#awaitSettlement(taskPromise, timers);
      throw new OperationTimeoutError(timeoutMs, settled);
    } finally {
      timers.clearTimeout(handle);
    }
  }

  /** Awaits the aborted task's own promise, bounded by the kill grace, so its side effects finish before we return. */
  async #awaitSettlement<T>(taskPromise: Promise<T>, timers: QueueTimers): Promise<{ readonly value: T } | undefined> {
    const graceMs = this.options.graceMs ?? NPM_OPERATION_KILL_GRACE_MS;
    let handle: unknown;
    const grace = new Promise<undefined>((resolve) => {
      handle = timers.setTimeout(() => resolve(undefined), graceMs);
    });
    try {
      return await Promise.race([
        taskPromise.then(
          (value) => ({ value }) as const,
          () => undefined,
        ),
        grace,
      ]);
    } finally {
      timers.clearTimeout(handle);
    }
  }
}
