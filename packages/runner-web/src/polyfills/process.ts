/**
 * Task 10 (spec §5.13): the `browser-node` `process` polyfill.
 *
 * `env`, `cwd()`, `platform`, `argv` and `versions` all come from a snapshot taken once, outside this module --
 * `apps/desktop/src/main/bundling/polyfill-plugin.ts` computes it in Main (the same process that already builds
 * `runnerEnvironment` for the Bun runtime, spec §5.3), then appends `export default createProcessPolyfill(<that
 * snapshot, as a JSON literal>);` after this file's own text when it serves it as the bundled `process` module.
 * That happens fresh on every bundle build, and the app chunk is rebuilt on every run without exception
 * (`bundler.ts`'s own note on this), so in practice the snapshot really is taken at "page load" even though the
 * append itself runs at bundle time, one step before.
 *
 * This file deliberately has **no default export of its own** and touches no ambient/global state at module top
 * level: `createProcessPolyfill` is a pure function of its `snapshot` argument, so `bun test` can import and call
 * it directly with a fixture snapshot, with nothing to substitute and nothing that throws on load.
 *
 * `nextTick` is the one live (non-snapshotted) behavior: it schedules on the microtask queue, same as Node's own
 * `process.nextTick` ordering relative to Promise callbacks in a browser-hosted event loop (there is no libuv
 * "next tick queue" phase to reproduce here; a microtask is the closest faithful primitive available).
 */

export interface ProcessSnapshot {
  env: Record<string, string>;
  cwd: string;
  platform: string;
  argv: string[];
  versions: Record<string, string>;
}

export interface ProcessPolyfill {
  env: Record<string, string>;
  platform: string;
  argv: string[];
  versions: Record<string, string>;
  version: string;
  cwd(): string;
  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
  readonly browser: true;
}

/**
 * Pure and independently testable: every value the polyfill exposes is derived only from `snapshot`, with no
 * reference to the real `process` global (there may not be one -- this runs inside a browser page).
 */
export function createProcessPolyfill(snapshot: ProcessSnapshot): ProcessPolyfill {
  return {
    // Copied, not aliased: a tab mutating `process.env.X` must never reach back into the snapshot object, and a
    // second `createProcessPolyfill` call (a second run) must never observe an earlier run's mutations.
    env: { ...snapshot.env },
    platform: snapshot.platform,
    argv: [...snapshot.argv],
    versions: { ...snapshot.versions },
    version: `v${snapshot.versions.node ?? "0.0.0"}`,
    cwd(): string {
      return snapshot.cwd;
    },
    nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void {
      queueMicrotask(() => callback(...args));
    },
    // Long-standing browserify/webpack convention (not a real Node property) that a lot of npm code branches on
    // to detect a non-Node environment; cheap to set correctly given this really is a browser-hosted polyfill.
    browser: true,
  };
}
