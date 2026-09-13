import type { BunRunnerProcess, RunnerSpawnConfig } from "./bun-runner-process";

interface Spare {
  key: string;
  promise: Promise<BunRunnerProcess>;
}

const START_ATTEMPTS = 3;

/** Keeps one pre-started runner per tab, keyed by the spawn configuration it was started with. */
export class SparePool {
  readonly #spares = new Map<string, Spare>();

  constructor(
    private readonly startRunner: (config: RunnerSpawnConfig) => Promise<BunRunnerProcess>,
    private readonly configFor: (tabId: string) => RunnerSpawnConfig,
  ) {}

  prepare(tabId: string): void {
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
      this.prepare(tabId);
      const spare = this.#spares.get(tabId);
      this.#spares.delete(tabId);
      if (!spare) continue;
      try {
        const runner = await spare.promise;
        this.prepare(tabId);
        return runner;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Runtime unavailable");
  }

  invalidate(tabId: string): void {
    const existing = this.#spares.get(tabId);
    if (existing) this.#discard(existing);
    this.#spares.delete(tabId);
  }

  dispose(): void {
    for (const tabId of [...this.#spares.keys()]) this.invalidate(tabId);
  }

  #discard(spare: Spare): void {
    spare.promise.then(
      (runner) => runner.kill(),
      () => {},
    );
  }
}
