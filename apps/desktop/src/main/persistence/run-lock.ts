import { existsSync, rmSync, writeFileSync } from "node:fs";

/**
 * `run.lock` exists while any run is evaluating. If it still exists at startup, the previous
 * session hung or crashed mid-run and JSLab starts in Safe Mode (spec §5.14).
 */
export class RunLock {
  readonly #active = new Set<string>();
  readonly uncleanPreviousExit: boolean;

  constructor(private readonly path: string) {
    this.uncleanPreviousExit = existsSync(path);
    rmSync(path, { force: true });
  }

  add(runId: string): void {
    this.#active.add(runId);
    if (this.#active.size === 1) writeFileSync(this.path, String(process.pid));
  }

  remove(runId: string): void {
    if (!this.#active.delete(runId)) return;
    if (this.#active.size === 0) rmSync(this.path, { force: true });
  }

  releaseAll(): void {
    this.#active.clear();
    rmSync(this.path, { force: true });
  }
}
