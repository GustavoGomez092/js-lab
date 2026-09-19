/**
 * Scoring for the spec §23 performance harness: percentiles, pass/fail/skip, and the printed report.
 *
 * Deliberately pure -- no timing, no I/O, no imports from the app. Everything here is unit-tested in
 * `apps/desktop/test/bench/core.test.ts`; the drivers that actually take measurements live in `measure.ts`, and the
 * budget table (including the reasons budgets are skipped) in `budgets.ts`.
 */

/** One threshold a metric is held to. A budget written "p50 <= 120 ms, p95 <= 250 ms" contributes two of these. */
export interface Threshold {
  /** "p50", "p95", or "max" -- the statistic taken over the samples. */
  label: string;
  /** The percentile this statistic reads, 0-100. */
  percentile: number;
  /** The spec's limit for that statistic, in the check's unit. */
  limit: number;
}

export interface MeasuredCheck {
  kind: "measured";
  id: string;
  /** The §23 table's metric text. */
  metric: string;
  /** The §23 table's budget text, verbatim, so the report can be compared to the spec by eye. */
  budgetText: string;
  unit: string;
  thresholds: Threshold[];
  samples: number[];
  /**
   * What this measurement does and does not include. Present whenever the harness measures a *slice* of the
   * budget rather than the whole thing -- a passing slice must never be read as a passing budget.
   */
  scope?: string;
}

export interface SkippedCheck {
  kind: "skipped";
  id: string;
  metric: string;
  budgetText: string;
  /** Why no number is reported. Printed in the report so the gap is visible, not silently absent. */
  reason: string;
}

export type Check = MeasuredCheck | SkippedCheck;

export interface ThresholdResult {
  label: string;
  limit: number;
  measured: number;
  ok: boolean;
}

export interface CheckResult {
  id: string;
  metric: string;
  budgetText: string;
  /** "skip" is its own status: a budget nobody measured is never reported as passing. */
  status: "pass" | "fail" | "skip";
  unit: string;
  thresholds: ThresholdResult[];
  sampleCount: number;
  scope?: string;
  reason?: string;
}

/**
 * Nearest-rank percentile: the smallest sample at or above the given rank, with the input sorted ascending first.
 *
 * Nearest-rank rather than an interpolating definition so every reported number is a sample that was actually
 * observed -- an interpolated p95 is a value the machine never produced, which is a poor thing to hold a budget to.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) throw new Error("percentile() needs at least one sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const clamped = Math.min(100, Math.max(0, p));
  const rank = Math.ceil((clamped / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

/** Scores one check. A measured check fails if *any* of its thresholds is exceeded. */
export function evaluate(check: Check): CheckResult {
  if (check.kind === "skipped") {
    return {
      id: check.id,
      metric: check.metric,
      budgetText: check.budgetText,
      status: "skip",
      unit: "",
      thresholds: [],
      sampleCount: 0,
      reason: check.reason,
    };
  }
  if (check.samples.length === 0) {
    return {
      id: check.id,
      metric: check.metric,
      budgetText: check.budgetText,
      status: "skip",
      unit: check.unit,
      thresholds: [],
      sampleCount: 0,
      reason: "the driver produced no samples",
    };
  }
  const thresholds = check.thresholds.map((threshold) => {
    const measured = percentile(check.samples, threshold.percentile);
    return { label: threshold.label, limit: threshold.limit, measured, ok: measured <= threshold.limit };
  });
  return {
    id: check.id,
    metric: check.metric,
    budgetText: check.budgetText,
    status: thresholds.every((t) => t.ok) ? "pass" : "fail",
    unit: check.unit,
    thresholds,
    sampleCount: check.samples.length,
    ...(check.scope === undefined ? {} : { scope: check.scope }),
  };
}

export interface Summary {
  passed: number;
  failed: number;
  skipped: number;
  /** Non-zero exactly when a *covered* budget was exceeded. A skipped budget never fails the run. */
  exitCode: number;
}

export function summarize(results: readonly CheckResult[]): Summary {
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  return { passed, failed, skipped, exitCode: failed > 0 ? 1 : 0 };
}

const STATUS_LABEL: Record<CheckResult["status"], string> = { pass: "PASS", fail: "FAIL", skip: "SKIP" };

function round(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/** The human-readable report. `header` lines describe the machine the numbers came from (see `main.ts`). */
export function formatReport(results: readonly CheckResult[], header: readonly string[]): string {
  const out: string[] = [];
  out.push("JSLab performance budgets (spec §23)");
  out.push("");
  for (const line of header) out.push(`  ${line}`);
  out.push("");
  for (const result of results) {
    out.push(`[${STATUS_LABEL[result.status]}] ${result.metric}`);
    out.push(`        budget: ${result.budgetText}`);
    if (result.status === "skip") {
      out.push(`        not measured: ${result.reason ?? "no reason recorded"}`);
    } else {
      const measured = result.thresholds
        .map(
          (t) =>
            `${t.label} ${round(t.measured)}${result.unit} (limit ${t.limit}${result.unit}) ${t.ok ? "ok" : "OVER"}`,
        )
        .join(", ");
      out.push(`        measured: ${measured}  [n=${result.sampleCount}]`);
    }
    if (result.scope) out.push(`        scope: ${result.scope}`);
    out.push("");
  }
  const summary = summarize(results);
  out.push(`${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} not measured.`);
  return out.join("\n");
}
