/**
 * `bun run bench` -- measures JSLab against the spec §23 performance budgets and exits non-zero if a covered
 * budget is exceeded.
 *
 * Run on demand, NOT in CI. Timing on a shared runner is noisy, and a flaky gate is worse than no gate; see the
 * note at the bottom of this file for what gating it later would take.
 *
 * Budgets live in `budgets.ts` (including the reasons some are not measured), scoring in `core.ts`, and the
 * measurement drivers in `measure.ts`. Drivers run strictly one after another: two in flight would measure
 * contention rather than the thing being timed.
 */

import { BUDGETS } from "./budgets";
import { type Check, type CheckResult, evaluate, formatReport, summarize } from "./core";
import { DRIVERS } from "./measure";

function sysctl(key: string): string {
  const result = Bun.spawnSync(["sysctl", "-n", key]);
  return result.success ? result.stdout.toString().trim() : "unknown";
}

function header(): string[] {
  return [
    `machine:  ${sysctl("machdep.cpu.brand_string")} (${sysctl("hw.model")}), ${sysctl("hw.ncpu")} cores`,
    `os:       ${process.platform} ${process.arch}, ${Bun.spawnSync(["uname", "-r"]).stdout.toString().trim()}`,
    `runtime:  bun ${Bun.version}`,
    `build:    development sources (bun run from the repo), NOT a release build`,
    "",
    "CAVEAT: §23's budgets are stated for an Apple M1 running a RELEASE build. Numbers measured on different",
    "silicon or from unbundled sources are not directly comparable -- a faster machine can pass a budget the",
    "target hardware would miss. Re-measure on an M1 against a release build before treating any PASS as final.",
  ];
}

async function main(): Promise<number> {
  const results: CheckResult[] = [];
  for (const row of BUDGETS) {
    if (row.skipReason !== undefined) {
      results.push(
        evaluate({
          kind: "skipped",
          id: row.id,
          metric: row.metric,
          budgetText: row.budgetText,
          reason: row.skipReason,
        }),
      );
      continue;
    }
    const driver = row.driver === undefined ? undefined : DRIVERS[row.driver];
    if (driver === undefined || row.thresholds === undefined) {
      results.push(
        evaluate({
          kind: "skipped",
          id: row.id,
          metric: row.metric,
          budgetText: row.budgetText,
          reason: `no driver is wired up for "${row.driver}"`,
        }),
      );
      continue;
    }
    process.stderr.write(`measuring ${row.id}...\n`);
    const measured = await driver();
    const check: Check =
      "skip" in measured
        ? { kind: "skipped", id: row.id, metric: row.metric, budgetText: row.budgetText, reason: measured.skip }
        : {
            kind: "measured",
            id: row.id,
            metric: row.metric,
            budgetText: row.budgetText,
            unit: row.unit,
            thresholds: row.thresholds,
            samples: measured.samples,
            ...(row.scope === undefined ? {} : { scope: row.scope }),
          };
    results.push(evaluate(check));
  }

  process.stdout.write(`${formatReport(results, header())}\n`);
  return summarize(results).exitCode;
}

process.exit(await main());

/**
 * What gating this in CI would take, if it is ever wanted:
 *
 * 1. A dedicated, consistent machine -- ideally the M1 the budgets name. GitHub's shared macOS runners vary enough
 *    between jobs that a p95 measured on one is not comparable to a p95 measured on the next, so a threshold tight
 *    enough to catch a real regression would also fire on noise.
 * 2. A release build, since §23's numbers describe one. Today this harness runs from sources.
 * 3. Baselines stored per metric, and a comparison against the trend rather than against the absolute limit --
 *    §23 itself asks for "a regression over 20% fails the job", which needs history this harness does not keep.
 * 4. Repeats per metric, with the job failing only when the median of several runs regresses, so one unlucky run
 *    cannot redden the build.
 *
 * Until all four exist, run this on demand: `bun run bench`.
 */
