import type { BunRunnerProcess, RunnerSpawnConfig } from "./bun-runner-process";

interface Spare {
  key: string;
  promise: Promise<BunRunnerProcess>;
}

const START_ATTEMPTS = 3;

/** Keeps one pre-started runner per tab, keyed by the spawn configuration it was started with. */
export class SparePool {
  readonly #spares = new Map<string, Spare>();
  // Bumped by invalidate()/dispose() so a take() awaiting a since-invalidated/disposed spare can tell (I4).
  readonly #generation = new Map<string, number>();
  #disposed = false;

  constructor(
    private readonly startRunner: (config: RunnerSpawnConfig) => Promise<BunRunnerProcess>,
    private readonly configFor: (tabId: string) => RunnerSpawnConfig,
  ) {}

  prepare(tabId: string): void {
    if (this.#disposed) return;
    const config = this.configFor(tabId);
    const key = String(Bun.hash(JSON.stringify([config.bunPath, config.bootstrapPath, config.cwd, config.env])));
    const existing = this.#spares.get(tabId);
    if (existing?.key === key) return;
    if (existing) this.#discard(existing);
    const promise = this.startRunner(config);
    promise.catch(() => {
      if (this.#spares.get(tabId)?.promise === promise) this.#spares.delete(tabId);
    });
    this.#spares.set(tabId, { key, promise });
  }

  async take(tabId: string): Promise<BunRunnerProcess> {
    let lastError: unknown;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      if (this.#disposed) throw new Error("Spare pool disposed");
      this.prepare(tabId);
      const spare = this.#spares.get(tabId);
      this.#spares.delete(tabId);
      if (!spare) continue;
      const generation = this.#generationFor(tabId);
      try {
        const runner = await spare.promise;
        // dispose()/invalidate(tabId) may have run while we were awaiting start() above; re-preparing (or handing
        // this runner back) would leak it since nothing will ever come looking for it again (I4).
        if (this.#disposed || this.#generationFor(tabId) !== generation) {
          runner.kill();
          throw new Error("Spare pool disposed");
        }
        this.prepare(tabId);
        return runner;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Runtime unavailable");
  }

  invalidate(tabId: string): void {
    this.#generation.set(tabId, this.#generationFor(tabId) + 1);
    const existing = this.#spares.get(tabId);
    if (existing) this.#discard(existing);
    this.#spares.delete(tabId);
  }

  dispose(): void {
    this.#disposed = true;
    for (const tabId of [...this.#spares.keys()]) this.invalidate(tabId);
  }

  #generationFor(tabId: string): number {
    return this.#generation.get(tabId) ?? 0;
  }

  #discard(spare: Spare): void {
    spare.promise.then(
      (runner) => runner.kill(),
      () => {},
    );
  }
}
