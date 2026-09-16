import type { EncodedValue, RawRunEvent, RunEvent, RunState } from "@jslab/rpc-schema";
import type { Runtime } from "@jslab/shared";

/**
 * The tab-level context an adapter needs to warm or recycle whatever it keeps per tab (a spare Bun process, a web
 * runner's webview). Kept intentionally thin (spec §5.1): no `BunRunnerProcess`, no OS-process assumption -- Task
 * 7's `WebAdapter` implements the same shape against a webview instead of a spawned process.
 */
export interface TabRunContext {
  tabId: string;
  /** The tab's working directory, or null (spec §5.3). */
  workingDirectory: string | null;
}

/**
 * One transpiled run, ready to execute. `code` is already-transpiled source (the transform's output); an adapter
 * decides how to deliver it to its runtime -- write an entry file for a spawned process, post it into a webview --
 * so no file path lives here. `mapEvent` remaps a runner's raw (generated-position) event back to the user's
 * original source lines; `RunCoordinator` builds it once per run (via `createEventMapper`) since source-map
 * handling is shared across every runtime (Global Constraints: "Main always does the mapping itself", never the
 * runner). `isCancelled` lets an adapter's own async prep work (writing an entry, taking a spare) bail out at the
 * same points `RunCoordinator` used to check before this task -- a superseded or disposed run must not touch the
 * filesystem or a runner on the new run's behalf.
 */
export interface PreparedRun {
  runId: string;
  tabId: string;
  code: string;
  maxEntries: number;
  workingDirectory: string | null;
  mapEvent(event: RawRunEvent): RunEvent;
  isCancelled(): boolean;
  /**
   * Task 15 (spec §5.12, EX-35): the tab's saved mute preference, applied to a fresh web run the moment it starts
   * -- every run gets a new realm (Decision 1, `web-adapter.ts`), so without this a muted tab would come back
   * unmuted the instant Auto Run (or any Run) started a new one. Ignored by `BunAdapter` (Bun has no audio).
   * Optional (default false): every `PreparedRun` built before this task, across every existing test fixture,
   * stays valid unchanged.
   */
  muted?: boolean;
}

/** Where an adapter reports what a run is doing, in `RunCoordinator`'s own generic vocabulary (spec §4.2/§5.1). */
export interface RunEventSink {
  /**
   * A controllable handle now exists for this run. An adapter MUST call this the moment it has one -- before any
   * lock bookkeeping or start message -- not merely once its own `start()` resolves: `RunCoordinator` records the
   * handle here so a `stop()`/`kill()` arriving reentrantly at that pinch point (for example from inside a
   * `runLock.add` callback) still finds a handle to act on and takes the graceful branch (M4 T2 fix 1, review
   * Finding 1). Task 7's `WebAdapter` must follow the same ordering.
   */
  attached(handle: RunHandle): void;
  events(events: RunEvent[]): void;
  state(state: RunState, activeHandles?: number): void;
  /** A liveness signal arrived; `RunCoordinator` owns unresponsive-detection and recovery from it (spec §5.11). */
  heartbeat(): void;
  /**
   * Task 15 (spec §5.12, EX-35): the tab's audio-active state changed -- true while any AudioContext the runner
   * tracks is running or any media element is playing. Optional: only `WebAdapter`'s sessions ever call it (Bun
   * has no audio concept, spec §5.6 vs §5.12), so `BunRunSession` needs no stub implementation.
   */
  audio?(active: boolean): void;
  /**
   * The runtime behind this run's handle is gone for good (its process exited, its webview was torn down, ...),
   * whether or not that was expected. `RunCoordinator` uses this to treat the handle as gone too -- for example, a
   * Kill requested after the runtime already exited on its own must not relabel an already-settled run.
   */
  exited(): void;
}

/**
 * A tab's working directory was deleted (or changed) between `RunCoordinator`'s pre-transform check and the runtime
 * actually starting in it (M-3, fail closed): the run must not execute against, or write relative files into, the
 * wrong folder. Adapter-agnostic (spec's Global Constraints anticipate `browser-node` needing the same fail-closed
 * check) so `RunCoordinator` can catch it generically by class, and any adapter -- not just Bun's -- can throw it.
 */
export class WorkingDirectoryMismatchError extends Error {
  constructor(readonly workingDirectory: string) {
    super(`Runner did not start in working directory: ${workingDirectory}`);
    this.name = "WorkingDirectoryMismatchError";
  }
}

/** spec §5.1, verbatim. */
export interface RuntimeAdapter {
  id: Runtime;
  /** Warms whatever this adapter keeps ready for a tab (a spare Bun process, a web runner). */
  prepare(tab: TabRunContext): Promise<void>;
  /** Starts one run and returns a handle to control it. */
  start(run: PreparedRun, sink: RunEventSink): Promise<RunHandle>;
  /** The tab's env/working directory/settings changed: recycle whatever was warmed for it. */
  invalidate(tab: TabRunContext): void;
  /** The tab closed: release everything kept for it. */
  dispose(tabId: string): Promise<void>;
}

/** spec §5.1, verbatim. */
export interface RunHandle {
  runId: string;
  /** Graceful; escalates to kill after 500 ms (spec §5.1). */
  stop(): Promise<void>;
  /** Immediate. */
  kill(): void;
  expand(handleId: string): Promise<EncodedValue | null>;
  /**
   * Task 15 (spec §5.12, EX-35): sets or clears mute for this run's runtime. Optional: only `WebAdapter`'s
   * `WebRunSession` implements it (Bun has no audio concept), so `RunCoordinator.mute()` calls it with `?.` and a
   * Bun-runtime tab's mute toggle is a harmless no-op at the runtime level -- it still persists in the tab's
   * saved layout either way.
   */
  mute?(muted: boolean): void;
}
