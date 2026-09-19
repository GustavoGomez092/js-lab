import { describe, expect, test } from "bun:test";
import { BUDGETS } from "../../bench/budgets";
import { type Check, evaluate, formatReport, percentile, summarize } from "../../bench/core";

/**
 * Tests for the benchmark harness itself -- never for timing values, which would be flaky by construction.
 * What is pinned here is the scoring: that percentiles are computed correctly, that a measurement over its budget
 * FAILS and exits non-zero, and that a budget nobody measured is reported as skipped rather than as a pass.
 */

const measured = (samples: number[], limit: number, p = 95): Check => ({
  kind: "measured",
  id: "example",
  metric: "Example metric",
  budgetText: `<= ${limit} ms`,
  unit: "ms",
  thresholds: [{ label: `p${p}`, percentile: p, limit }],
  samples,
});

describe("percentile", () => {
  test("uses nearest rank, so every reported value is one that was actually observed", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(samples, 50)).toBe(5);
    expect(percentile(samples, 95)).toBe(10);
    expect(percentile(samples, 100)).toBe(10);
    // Never interpolates: 9.5 is not a sample, so p95 of these ten is the 10th, not a midpoint.
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95)).toBe(100);
  });

  test("sorts its input rather than trusting the caller's order", () => {
    expect(percentile([10, 1, 5, 3, 2], 50)).toBe(3);
    expect(percentile([100, 1], 50)).toBe(1);
  });

  test("handles a single sample and the 0th percentile without running off either end", () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([5, 9], 0)).toBe(5);
  });

  test("refuses an empty set rather than inventing a number", () => {
    expect(() => percentile([], 50)).toThrow();
  });
});

describe("evaluate", () => {
  test("passes a measurement inside its budget", () => {
    const result = evaluate(measured([10, 11, 12], 40));
    expect(result.status).toBe("pass");
    expect(result.thresholds[0]?.ok).toBe(true);
    expect(result.sampleCount).toBe(3);
  });

  test("FAILS a measurement over its budget", () => {
    const result = evaluate(measured([10, 11, 500], 40));
    expect(result.status).toBe("fail");
    expect(result.thresholds[0]?.measured).toBe(500);
    expect(result.thresholds[0]?.ok).toBe(false);
  });

  test("a value exactly on the limit passes; one just over it fails", () => {
    expect(evaluate(measured([40], 40)).status).toBe("pass");
    expect(evaluate(measured([40.1], 40)).status).toBe("fail");
  });

  test("fails when ANY threshold of a multi-threshold budget is exceeded", () => {
    const check: Check = {
      kind: "measured",
      id: "keystroke",
      metric: "Keystroke",
      budgetText: "p50 <= 120 ms, p95 <= 250 ms",
      unit: "ms",
      thresholds: [
        { label: "p50", percentile: 50, limit: 120 },
        { label: "p95", percentile: 95, limit: 250 },
      ],
      // p50 is comfortably inside 120; the tail blows p95.
      samples: [10, 20, 30, 40, 9000],
    };
    const result = evaluate(check);
    expect(result.status).toBe("fail");
    expect(result.thresholds[0]?.ok).toBe(true);
    expect(result.thresholds[1]?.ok).toBe(false);
  });

  test("a skipped budget is reported as skip, never as a pass, and keeps its reason", () => {
    const result = evaluate({
      kind: "skipped",
      id: "cold-start",
      metric: "Cold start",
      budgetText: "<= 1.5 s",
      reason: "needs a GUI harness",
    });
    expect(result.status).toBe("skip");
    expect(result.status).not.toBe("pass");
    expect(result.reason).toBe("needs a GUI harness");
    expect(result.thresholds).toEqual([]);
  });

  test("a driver that produced no samples is skipped, not silently passed", () => {
    const result = evaluate(measured([], 40));
    expect(result.status).toBe("skip");
    expect(result.reason).toContain("no samples");
  });
});

describe("summarize", () => {
  test("exits non-zero when a covered budget failed", () => {
    const results = [evaluate(measured([10], 40)), evaluate(measured([500], 40))];
    const summary = summarize(results);
    expect(summary.failed).toBe(1);
    expect(summary.passed).toBe(1);
    expect(summary.exitCode).toBe(1);
  });

  test("exits zero when everything covered passed, even with budgets skipped", () => {
    const results = [
      evaluate(measured([10], 40)),
      evaluate({ kind: "skipped", id: "dmg", metric: "DMG", budgetText: "<= 80 MB", reason: "needs a release build" }),
    ];
    const summary = summarize(results);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.exitCode).toBe(0);
  });
});

describe("the report", () => {
  test("marks skipped budgets as SKIP and prints why, so a gap is visible rather than absent", () => {
    const report = formatReport(
      [
        evaluate({
          kind: "skipped",
          id: "dmg",
          metric: "App download (DMG)",
          budgetText: "<= 80 MB",
          reason: "needs a release build",
        }),
      ],
      ["machine: test"],
    );
    expect(report).toContain("[SKIP] App download (DMG)");
    expect(report).toContain("needs a release build");
    expect(report).not.toContain("[PASS]");
  });

  test("prints the measured value, the limit and OVER for a failing budget", () => {
    const report = formatReport([evaluate(measured([500], 40))], []);
    expect(report).toContain("[FAIL]");
    expect(report).toContain("limit 40ms");
    expect(report).toContain("OVER");
  });
});

describe("the budget table", () => {
  test("covers every row of spec §23 exactly once, each either measured or skipped with a reason", () => {
    expect(BUDGETS).toHaveLength(9);
    expect(new Set(BUDGETS.map((row) => row.id)).size).toBe(9);
    for (const row of BUDGETS) {
      const isMeasured = row.driver !== undefined;
      // Exactly one of the two: a row is either wired to a driver with thresholds, or skipped with a reason.
      expect(isMeasured).toBe(row.skipReason === undefined);
      if (isMeasured) expect(row.thresholds?.length ?? 0).toBeGreaterThan(0);
      else expect((row.skipReason ?? "").length).toBeGreaterThan(20);
    }
  });
});
