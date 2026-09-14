import type { TimerApi } from "../state/auto-run";
import { strings } from "../strings";
import type { FormatOutcome } from "./format-core";
import type { PrettierFormatOptions } from "./prettier-options";

export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface Formatter {
  format(code: string, options: PrettierFormatOptions, cursorOffset: number): Promise<FormatOutcome>;
  dispose(): void;
}

const MB = 1024 * 1024;

/** How long one format request may take: 10 s, plus 5 s per MB of code, at most 60 s (T21-m1-timeout). */
export function formatTimeoutMs(codeLength: number): number {
  return Math.min(60_000, 10_000 + Math.round((codeLength / MB) * 5_000));
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * A lazily started Prettier worker. A worker error fails pending requests and the next call starts a new worker. A
 * request that outlives its timeout fails, and the worker is terminated with every other pending request, so a hung
 * worker never blocks later runs or saves (T21-m1-timeout).
 */
export function createWorkerFormatter(
  createWorker: () => WorkerLike,
  options: { timers?: TimerApi; timeoutMs?(codeLength: number): number } = {},
): Formatter {
  const timers = options.timers ?? defaultTimers;
  const timeoutFor = options.timeoutMs ?? formatTimeoutMs;
  let worker: WorkerLike | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (outcome: FormatOutcome) => void; timer: unknown }>();

  const settle = (id: number, outcome: FormatOutcome) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    timers.clearTimeout(entry.timer);
    entry.resolve(outcome);
  };

  const failAll = (error: string) => {
    for (const id of [...pending.keys()]) settle(id, { ok: false, error });
  };

  const stop = (target: WorkerLike) => {
    target.terminate();
    if (worker === target) worker = null;
  };

  const ensure = (): WorkerLike => {
    if (worker) return worker;
    const created = createWorker();
    created.onmessage = (event) => {
      const { id, ...outcome } = event.data as { id: number } & FormatOutcome;
      settle(id, outcome as FormatOutcome);
    };
    created.onerror = (event) => {
      stop(created);
      failAll(event.message || strings.format.crashed);
    };
    worker = created;
    return created;
  };

  return {
    format(code, formatOptions, cursorOffset) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = timers.setTimeout(() => {
          const current = worker;
          settle(id, { ok: false, error: strings.format.timedOut });
          if (current) stop(current);
          failAll(strings.format.restarted);
        }, timeoutFor(code.length));
        pending.set(id, { resolve, timer });
        try {
          ensure().postMessage({ id, code, options: formatOptions, cursorOffset });
        } catch (error) {
          // Fix round 1 (m-1): a worker that fails to start (a synchronous throw, e.g. from `new Worker(...)`)
          // must resolve this request instead of leaving it (and every later one) hanging forever.
          settle(id, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
    dispose() {
      if (worker) stop(worker);
      failAll(strings.format.disposed);
    },
  };
}

export function shouldFormatBeforeRun(input: {
  formatOnRun: boolean;
  editorFocused: boolean;
  lastTypedAt: number;
  now: number;
}): boolean {
  if (!input.formatOnRun) return false;
  // Don't move the cursor under someone who is still typing (spec §6.4).
  return !(input.editorFocused && input.now - input.lastTypedAt < 1000);
}
