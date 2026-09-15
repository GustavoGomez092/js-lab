import { type TransformOptions, type TransformResult, transform } from "@jslab/transform";

export interface TransformHost {
  transform(source: string, options: TransformOptions): Promise<TransformResult>;
  dispose(): void;
}

type WorkerReply = { id: number; result: TransformResult } | { id: number; error: string };

/** Runs Babel off the main thread (spec §4.1). Recreates the worker if it crashes. */
export class WorkerTransformHost implements TransformHost {
  #worker: Worker | undefined;
  #nextId = 1;
  #disposed = false;
  readonly #pending = new Map<number, { resolve(result: TransformResult): void; reject(error: Error): void }>();

  constructor(private readonly workerUrl: string = new URL("./transform-worker.ts", import.meta.url).href) {}

  transform(source: string, options: TransformOptions): Promise<TransformResult> {
    if (this.#disposed) {
      return Promise.reject(new Error("Transform host disposed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ensureWorker().postMessage({ id, source, options });
    });
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = undefined;
    }
    this.#rejectAll(new Error("Transform host disposed"));
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    this.#worker = this.#spawn();
    return this.#worker;
  }

  #spawn(): Worker {
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if ("error" in event.data) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.result);
    };
    // Late events from a worker that was already replaced must not reject the newer worker's pending requests.
    worker.onerror = (event) => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      this.#rejectAll(new Error(`Transform worker crashed: ${event.message}`));
    };
    worker.addEventListener("close", () => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      this.#rejectAll(new Error("Transform worker exited"));
    });
    return worker;
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/** Same interface without a worker; used where Workers are unavailable (see M0-S1). */
export class InProcessTransformHost implements TransformHost {
  async transform(source: string, options: TransformOptions): Promise<TransformResult> {
    return transform(source, options);
  }

  dispose(): void {}
}

/** LRU cache in front of another host (spec §5.4: 50 entries). */
export class CachingTransformHost implements TransformHost {
  readonly #cache = new Map<string, Promise<TransformResult>>();

  constructor(
    private readonly inner: TransformHost,
    private readonly maxEntries = 50,
  ) {}

  transform(source: string, options: TransformOptions): Promise<TransformResult> {
    const key = String(Bun.hash(JSON.stringify([source, options])));
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    const result = this.inner.transform(source, options);
    result.catch(() => {
      if (this.#cache.get(key) === result) this.#cache.delete(key);
    });
    this.#cache.set(key, result);
    if (this.#cache.size > this.maxEntries) this.#cache.delete(this.#cache.keys().next().value as string);
    return result;
  }

  dispose(): void {
    this.#cache.clear();
    this.inner.dispose();
  }
}
