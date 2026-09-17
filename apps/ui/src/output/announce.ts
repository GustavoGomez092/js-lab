import type { RunState } from "@jslab/rpc-schema";
import { strings } from "../strings";

/**
 * The run states that mean the run is over, so its outcome can be announced once and is final.
 *
 * `idle` is in here because it is the NORMAL completion, not an "unknown" placeholder: a run that ends without the
 * user asking it to stop reports `idle` (`apps/desktop/src/main/runtimes/bun-adapter.ts`'s
 * `#reportTerminal(this.#stopRequested ? "stopped" : "idle", 0)`, and the web runner's
 * `tracker.count > 0 ? "settled" : "idle"` in `packages/runner-web/src/bootstrap.ts`). `stopped` means the user
 * pressed Stop, `killed` that it was killed, `failed` that it crashed. Anything else -- `transpiling`,
 * `evaluating`, `settled`, `stopping`, `unresponsive` -- is still in flight; those are exactly the members of
 * `BUSY_STATES` in `shell/labels.ts`, and this set is its complement.
 *
 * This is why the announcement does NOT reuse `runStateLabel`: that function returns `""` for `idle`, so reusing it
 * would say nothing at all for the most common way a run ends.
 */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(["idle", "stopped", "killed", "failed"]);

export function isTerminalRunState(state: RunState | null): boolean {
  return state !== null && TERMINAL_RUN_STATES.has(state);
}

/** What the output panel's live region currently says, and which run it says it about. */
export interface AnnouncerState {
  /** The run `text` describes. A different run blanks the region before it speaks again. */
  runId: string | null;
  text: string;
}

export const EMPTY_ANNOUNCEMENT: AnnouncerState = { runId: null, text: "" };

export interface AnnouncerInput {
  runId: string | null;
  runState: RunState | null;
  /** Entries the panel would show under the All chip -- `filterCounts(visible).all`. */
  entries: number;
  /** `filterCounts(visible).errors`: console.error/assert, stderr and thrown errors. */
  errors: number;
}

/**
 * Folds the run's progress into the one sentence the live region should be holding.
 *
 * Three rules, each answering a measured hazard rather than a preference:
 *
 * 1. **A new run blanks the region.** Clearing is a removal, and `aria-live="polite"` does not announce removals
 *    (the default `aria-relevant` is `"additions text"`), so the blank itself is silent. It exists so that two
 *    consecutive runs with an identical summary are each announced: without it the second run would write the same
 *    string the region already held, the DOM would not change, and a screen reader would stay silent. Under Auto
 *    Run, where the same code runs again and again, that is the common case, not the rare one.
 * 2. **A non-terminal state keeps whatever is already there rather than blanking it.** A run's handle count can
 *    genuinely cross zero more than once, so `settled` and `idle` can alternate (see `HandleTracker.batch`'s doc
 *    comment in `packages/runner-web/src/handles.ts`, which measured 120 state messages a second from a 60 fps rAF
 *    loop before it was fixed). Blanking on every non-terminal state would turn each of those flips back into a
 *    fresh announcement; holding the text means the region only changes when the outcome actually changes.
 * 3. **An unchanged sentence returns the previous object.** Identity is the dedupe: the component writes
 *    `state.text` straight into the DOM, so an unchanged string is an unchanged DOM node and therefore silence.
 *
 * Idempotent by construction -- `f(f(s, i), i) === f(s, i)` -- because the component applies it during render, and
 * React is free to render twice with the same inputs.
 */
export function nextAnnouncement(previous: AnnouncerState, input: AnnouncerInput): AnnouncerState {
  const base = input.runId === previous.runId ? previous : { runId: input.runId, text: "" };
  if (!isTerminalRunState(input.runState)) return base;
  const text = strings.output.announce.runFinished(input.entries, input.errors);
  return text === base.text ? base : { runId: base.runId, text };
}
