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
  // Only this tab keeps a pre-warmed spare (M1 final review, M2-readiness note 2). Null until Main sets it.
  #activeTabId: string | null = null;

  constructor(
    private readonly startRunner: (config: RunnerSpawnConfig) => Promise<BunRunnerProcess>,
    private readonly configFor: (tabId: string) => RunnerSpawnConfig,
  ) {}

  prepare(tabId: string): void {
    if (this.#disposed) return;
    if (!this.#generation.has(tabId)) this.#generation.set(tabId, 0);
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
    // Captured once, for the trailing pre-warm decision below: an invalidate() mid-take (e.g. a runner config
    // change, or the tab closing) must not stop a still-current caller from getting a fresh runner via retry, but
    // must stop the pool from pre-warming a spare that a closed tab will never come back to collect (I4).
    const generationAtEntry = this.#generationFor(tabId);
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      if (this.#disposed) throw new Error("Spare pool disposed");
      this.prepare(tabId);
      const spare = this.#spares.get(tabId);
      this.#spares.delete(tabId);
      if (!spare) continue;
      const generationBeforeAwait = this.#generationFor(tabId);
      try {
        const runner = await spare.promise;
        if (this.#disposed) {
          runner.kill();
          throw new Error("Spare pool disposed");
        }
        if (this.#generationFor(tabId) !== generationBeforeAwait) {
          runner.kill();
          throw new Error(`Runner configuration for tab ${tabId} changed while starting`);
        }
        // Re-warm after a take only for the active tab; a background tab gets a runner when it runs again.
        if (
          this.#generationFor(tabId) === generationAtEntry &&
          (this.#activeTabId === null || this.#activeTabId === tabId)
        ) {
          this.prepare(tabId);
        }
        return runner;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Runtime unavailable");
  }

  /** Keeps a warm spare for the active tab only: other tabs' idle spares are killed, and this tab gets one. */
  setActiveTab(tabId: string): void {
    if (this.#disposed) return;
    this.#activeTabId = tabId;
    for (const [other, spare] of [...this.#spares]) {
      if (other === tabId) continue;
      this.#discard(spare);
      this.#spares.delete(other);
    }
    this.prepare(tabId);
  }

  invalidate(tabId: string): void {
    this.#generation.set(tabId, this.#generationFor(tabId) + 1);
    const existing = this.#spares.get(tabId);
    if (existing) this.#discard(existing);
    this.#spares.delete(tabId);
  }

  /** env.json or package changes recycle every tab's spare; only the active tab is re-warmed (spec §11.3, §12.1). */
  invalidateAll(): void {
    if (this.#disposed) return;
    for (const tabId of new Set([...this.#spares.keys(), ...this.#generation.keys()])) this.invalidate(tabId);
    if (this.#activeTabId !== null) this.prepare(this.#activeTabId);
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
