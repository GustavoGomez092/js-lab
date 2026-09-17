import { describe, expect, test } from "bun:test";
import type { RunState } from "@jslab/rpc-schema";
import {
  type AnnouncerState,
  EMPTY_ANNOUNCEMENT,
  isTerminalRunState,
  nextAnnouncement,
  TERMINAL_RUN_STATES,
} from "../src/output/announce";
import { BUSY_STATES } from "../src/shell/labels";
import { strings } from "../src/strings";

const ALL_STATES: RunState[] = [
  "transpiling",
  "evaluating",
  "settled",
  "idle",
  "unresponsive",
  "stopping",
  "stopped",
  "killed",
  "failed",
];

const running = (runId: string | null, runState: RunState | null, entries = 0, errors = 0) => ({
  runId,
  runState,
  entries,
  errors,
});

describe("run announcement", () => {
  /**
   * The load-bearing fact, and the one most likely to be "tidied" into wrongness later: `idle` is a NORMAL
   * completion, not an absence of information. A run the user did not stop ends in `idle`, so dropping it from this
   * set would silence the single most common outcome while every test about errors still passed.
   */
  test("terminal states are exactly the complement of BUSY_STATES, and idle is one of them", () => {
    const terminal = ALL_STATES.filter((state) => isTerminalRunState(state));
    const busy = ALL_STATES.filter((state) => BUSY_STATES.has(state));
    expect(terminal).toEqual(["idle", "stopped", "killed", "failed"]);
    expect(busy).toEqual(["transpiling", "evaluating", "settled", "unresponsive", "stopping"]);
    // Complement, asserted rather than assumed: every state is in exactly one of the two.
    expect([...terminal, ...busy].sort()).toEqual([...ALL_STATES].sort());
    expect([...TERMINAL_RUN_STATES].sort()).toEqual([...terminal].sort());
  });

  test("no run at all says nothing", () => {
    expect(isTerminalRunState(null)).toBe(false);
    expect(nextAnnouncement(EMPTY_ANNOUNCEMENT, running(null, null))).toEqual(EMPTY_ANNOUNCEMENT);
  });

  test("a run in flight stays silent, and only a terminal state produces the summary", () => {
    let state: AnnouncerState = EMPTY_ANNOUNCEMENT;
    for (const inFlight of ["transpiling", "evaluating", "settled", "stopping", "unresponsive"] as RunState[]) {
      state = nextAnnouncement(state, running("r1", inFlight, 3, 1));
      expect(state.text).toBe("");
    }
    state = nextAnnouncement(state, running("r1", "idle", 3, 1));
    expect(state.text).toBe(strings.output.announce.runFinished(3, 1));
    expect(state.text).toBe("Run finished. Entries: 3. Errors: 1.");
  });

  /**
   * Rule 2. A run's handle count can cross zero more than once, so `settled` and `idle` alternate -- the flapping
   * `handles.ts` measured at 120 state messages a second. Blanking on a non-terminal state would make every one of
   * those flips a fresh announcement.
   */
  test("flapping back to a busy state keeps the sentence rather than blanking it, and re-settling is silent", () => {
    const settled = nextAnnouncement(EMPTY_ANNOUNCEMENT, running("r1", "idle", 2, 0));
    expect(settled.text).toBe(strings.output.announce.runFinished(2, 0));

    const flapped = nextAnnouncement(settled, running("r1", "settled", 2, 0));
    expect(flapped.text).toBe(settled.text);
    // Identity, not just equality: an unchanged object is an unchanged DOM node, which is what silence is made of.
    expect(nextAnnouncement(flapped, running("r1", "idle", 2, 0))).toBe(flapped);
  });

  /**
   * Rule 1, and the reason it exists: under Auto Run the same code runs again and again, so consecutive runs very
   * often produce an identical sentence. Without the blank, the second run would write the string the region
   * already held, the DOM would not change, and a screen reader would say nothing.
   */
  test("a new run blanks the region first, so an identical summary is announced again", () => {
    const first = nextAnnouncement(EMPTY_ANNOUNCEMENT, running("r1", "idle", 3, 1));
    expect(first.text).toBe(strings.output.announce.runFinished(3, 1));

    const restarted = nextAnnouncement(first, running("r2", "transpiling", 3, 1));
    expect([restarted.runId, restarted.text]).toEqual(["r2", ""]);

    const second = nextAnnouncement(restarted, running("r2", "idle", 3, 1));
    expect(second.text).toBe(first.text);
    // The region genuinely changed ("" -> sentence) even though the sentence is the same as last run's.
    expect(second).not.toBe(restarted);
  });

  test("a changed outcome within the same run updates the sentence", () => {
    const first = nextAnnouncement(EMPTY_ANNOUNCEMENT, running("r1", "idle", 1, 0));
    const later = nextAnnouncement(first, running("r1", "idle", 4, 2));
    expect(later.text).toBe(strings.output.announce.runFinished(4, 2));
    expect(later.text).not.toBe(first.text);
  });

  /** The component folds this during render, and React may render twice with identical inputs. */
  test("is idempotent: applying the same input twice changes nothing the second time", () => {
    for (const state of ALL_STATES) {
      for (const previous of [EMPTY_ANNOUNCEMENT, { runId: "r1", text: "stale" }]) {
        const input = running("r1", state, 2, 1);
        const once = nextAnnouncement(previous, input);
        expect(nextAnnouncement(once, input)).toBe(once);
      }
    }
  });
});
