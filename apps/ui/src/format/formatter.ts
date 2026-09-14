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

/** A lazily started Prettier worker. A worker error fails pending requests and the next call starts a new worker. */
export function createWorkerFormatter(createWorker: () => WorkerLike): Formatter {
  let worker: WorkerLike | null = null;
  let nextId = 1;
  const pending = new Map<number, (outcome: FormatOutcome) => void>();

  const failAll = (error: string) => {
    for (const [id, resolve] of pending) {
      pending.delete(id);
      resolve({ ok: false, error });
    }
  };

  const ensure = (): WorkerLike => {
    if (worker) return worker;
    const created = createWorker();
    created.onmessage = (event) => {
      const { id, ...outcome } = event.data as { id: number } & FormatOutcome;
      const resolve = pending.get(id);
      pending.delete(id);
      resolve?.(outcome as FormatOutcome);
    };
    created.onerror = (event) => {
      created.terminate();
      if (worker === created) worker = null;
      failAll(event.message || "The formatter stopped unexpectedly");
    };
    worker = created;
    return created;
  };

  return {
    format(code, options, cursorOffset) {
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        ensure().postMessage({ id, code, options, cursorOffset });
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      failAll("The formatter was disposed");
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
