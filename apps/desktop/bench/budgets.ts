/**
 * The spec §23 budget table ("Performance budgets (Apple M1, release build)"), as data.
 *
 * Every row of that table appears here exactly once, whether or not this harness can measure it. A row this
 * harness cannot measure honestly carries a `skipReason` saying what it would take -- an unmeasured budget is
 * reported as SKIP, never as a pass, and the reason is recorded here rather than only in a report someone has to
 * go and find.
 *
 * The limits below are the numbers the harness gates on. They are the spec's, and changing one changes what
 * passes: treat this table as the contract, not as tuning knobs.
 */

import type { Threshold } from "./core";

/** Names a driver in `measure.ts`'s `DRIVERS` map. Kept as a string so this table imports no measurement code. */
export type DriverName = "transform" | "spare" | "keystroke" | "browserRerun";

export interface BudgetRow {
  id: string;
  /** §23's "Metric" column. */
  metric: string;
  /** §23's "Budget" column, verbatim. */
  budgetText: string;
  unit: string;
  /** Present for a row this harness measures. */
  driver?: DriverName;
  thresholds?: Threshold[];
  /** What the number does and does not include, when the harness measures only a slice of the budget. */
  scope?: string;
  /** Present for a row this harness does not measure. Mutually exclusive with `driver`. */
  skipReason?: string;
}

export const BUDGETS: readonly BudgetRow[] = [
  {
    id: "cold-start",
    metric: "Cold start to editor interactive",
    budgetText: "<= 1.5 s",
    unit: "ms",
    skipReason:
      "needs the packaged app launched on a real display: the number is the time from process start to Monaco " +
      "accepting input, which only exists once a window and a webview exist. Would need a GUI harness that launches " +
      "the built app with JSLAB_E2E=1 and timestamps the first editor-ready event over the CLI socket (the " +
      "packages/e2e harness already has that channel). Not measurable from a headless process.",
  },
  {
    id: "idle-memory",
    metric: "Idle memory (1 tab, bun runtime, spare warm)",
    budgetText: "<= 300 MB total across processes",
    unit: "MB",
    skipReason:
      "needs the whole packaged app running -- Main, the webview/render process and a warm spare -- and the budget " +
      "is the sum across all of them. A headless process can start a spare but never the webview, which is a large " +
      "and variable share of the total, so any figure produced here would understate it. Would need a GUI harness " +
      "that sums RSS over the app's process tree once idle.",
  },
  {
    id: "keystroke",
    metric: "Keystroke -> first result (50-line TS, no imports, Auto Run delay excluded)",
    budgetText: "p50 <= 120 ms, p95 <= 250 ms",
    unit: "ms",
    driver: "keystroke",
    thresholds: [
      { label: "p50", percentile: 50, limit: 120 },
      { label: "p95", percentile: 95, limit: 250 },
    ],
    scope:
      "Main-side slice only: from RunCoordinator.start() to the first `result` event, through the real transform, " +
      "the real spare pool and a real Bun runner process. Excludes Monaco's own keystroke handling and the output " +
      "panel's paint, which need a window; the true end-to-end figure is therefore HIGHER than this number.",
  },
  {
    id: "transform",
    metric: "Transform 500-line TS file",
    budgetText: "<= 40 ms (warm worker)",
    unit: "ms",
    driver: "transform",
    thresholds: [{ label: "p95", percentile: 95, limit: 40 }],
    scope:
      "The whole budget, measured as the app measures it: a real WorkerTransformHost round trip (postMessage, " +
      "Babel in the worker, reply) after warm-up, so the worker's JIT is warm exactly as it is in a running app.",
  },
  {
    id: "spare",
    metric: "Spare ready after being consumed",
    budgetText: "<= 300 ms",
    unit: "ms",
    driver: "spare",
    thresholds: [{ label: "p95", percentile: 95, limit: 300 }],
    scope:
      "The whole budget: a real SparePool takes its spare, and the replacement's own BunRunnerProcess.start() is " +
      "timed from spawn to the runner's `ready` IPC message.",
  },
  {
    id: "browser-rerun",
    metric: "Browser runtime re-run with a cached React vendor chunk",
    budgetText: "p50 <= 250 ms",
    unit: "ms",
    driver: "browserRerun",
    thresholds: [{ label: "p50", percentile: 50, limit: 250 }],
    scope:
      "Main-side preparation only: transform + bundleAppForWeb + a real VendorCache disk read of the React chunk + " +
      "joinVendorAndApp. Excludes the webview's page load and the module actually evaluating (where React itself " +
      "runs), which need a real webview. The end-to-end figure is therefore substantially HIGHER than this number; " +
      "the app chunk is small by design because jslabResolve stubs each package out to the vendor registry.",
  },
  {
    id: "output-10k",
    metric: "Output: render 10,000 entries",
    budgetText: "UI stays responsive (no frame > 100 ms); virtualized",
    unit: "ms",
    skipReason:
      "not honestly measurable under a DOM shim, and measured to be so rather than assumed. Under happy-dom the " +
      "@tanstack/react-virtual range degenerates: rendering through OutputPanel produced 71 rows for 100 entries " +
      "and 521 rows for 1,000 (a real viewport shows ~40-60 regardless), and 10,000 entries exceed React's " +
      "nested-update limit and throw. Adding clientHeight/getBoundingClientRect/scrollTop shims changed none of " +
      "those numbers. So neither half of this budget can be checked here: frame timing has no meaning without a " +
      "compositor, and the 'virtualized' invariant cannot be read off a virtualizer that is misbehaving because of " +
      "the shim. Needs a GUI harness driving the real webview.",
  },
  {
    id: "typing-5k",
    metric: "Typing latency in a 5,000-line file",
    budgetText: "no frame > 16 ms from JSLab code (Monaco baseline excluded)",
    unit: "ms",
    skipReason:
      "needs Monaco running in a real window, and needs per-frame attribution to separate JSLab's own work from " +
      "Monaco's baseline. Neither a frame nor that attribution exists headlessly. Would need a GUI harness sampling " +
      "frame timings from the webview while typing into a 5,000-line buffer.",
  },
  {
    id: "dmg-size",
    metric: "App download (DMG)",
    budgetText: "<= 80 MB",
    unit: "MB",
    skipReason:
      "needs a release build. No DMG exists in this tree (no artifacts/ or dist/ directory), and building one is " +
      "out of scope for a headless benchmark -- it is also the one budget that needs no timing at all, so it is " +
      "best checked in the release workflow by stat-ing the signed DMG rather than here.",
  },
];
