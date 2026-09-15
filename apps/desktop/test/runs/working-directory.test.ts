import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunState } from "@jslab/rpc-schema";
import { transform } from "@jslab/transform";
import { resolveAppPaths } from "../../src/main/app-paths";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { RunCoordinator } from "../../src/main/runs/run-coordinator";
import { createRunnerConfig } from "../../src/main/runs/runner-config";
import { SparePool } from "../../src/main/runs/spare-pool";

const NL = String.fromCharCode(10);
const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);
let dir = "";
let coordinator: RunCoordinator | null = null;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-wd-run-")));
});
afterEach(async () => {
  coordinator?.dispose();
  coordinator = null;
  await rm(dir, { recursive: true, force: true });
});

function setup(workingDirectory: string) {
  const paths = resolveAppPaths({
    resourcesFolder: "/R",
    userData: join(dir, "data"),
    execPath: process.execPath,
    env: {},
  });
  const events: RunEvent[] = [];
  const states: { runId: string; state: RunState }[] = [];
  // The latest spare start, so a test can wait for a pre-warmed runner instead of sleeping.
  let lastStart: Promise<unknown> = Promise.resolve();
  const spares = new SparePool(
    (config) => {
      const started = BunRunnerProcess.start(config);
      lastStart = started;
      return started;
    },
    createRunnerConfig({
      paths: { ...paths, runnerBootstrap: BOOTSTRAP },
      baseEnv: () => ({ PATH: process.env.PATH }),
      envVars: () => ({}),
      workingDirectory: () => workingDirectory,
    }),
  );
  coordinator = new RunCoordinator({
    transform: async (source, options) => transform(source, options),
    spares,
    runsDir: paths.runsDir,
    settings: () => ({
      autoLog: true,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      maxEntries: 1000,
      unresponsiveTimeoutMs: 5000,
    }),
    onEvents: (_tabId, _runId, batch) => events.push(...batch),
    onState: (_tabId, runId, state) => states.push({ runId, state }),
    onDiagnostics: () => {},
    runLock: { add: () => {}, remove: () => {} },
  });
  const waitFor = async (runId: string, wanted: RunState[], timeoutMs = 10_000) => {
    const started = Date.now();
    while (!states.some((s) => s.runId === runId && wanted.includes(s.state))) {
      if (Date.now() - started > timeoutMs)
        throw new Error(`run never reached ${wanted.join("/")}: ${JSON.stringify(states)}`);
      await Bun.sleep(20);
    }
  };
  const consoleText = () =>
    events.flatMap((event) =>
      event.kind === "console" ? event.args.map((arg) => String((arg as { v?: unknown }).v)) : [],
    );
  return { spares, spareStarted: () => lastStart, events, states, waitFor, consoleText, current: coordinator };
}

describe("working directory runs (spec §5.3, §12.2)", () => {
  test("relative imports, __dirname, __filename, import.meta.dir and relative fs paths use the WD", async () => {
    const wd = join(dir, "api");
    await Bun.write(join(wd, "util.ts"), ["export const greet = (name: string): string => `hi ${name}`;", ""].join(NL));
    await Bun.write(join(wd, "data.txt"), "from wd");
    const { waitFor, consoleText, current } = setup(wd);
    const { runId } = current.start({
      tabId: "t1",
      code: [
        'import { readFileSync } from "node:fs";',
        'import { greet } from "./util";',
        "console.log(JSON.stringify({",
        '  greet: greet("wd"), same: __dirname === process.cwd(), file: __filename,',
        '  data: readFileSync("./data.txt", "utf8"), metaDir: import.meta.dir,',
        "}));",
      ].join(NL),
      language: "typescript",
      logpoints: [],
      workingDirectory: wd,
      scriptName: "scratch.ts",
    });
    await waitFor(runId, ["idle", "settled", "failed"]);
    expect(JSON.parse(consoleText()[0] ?? "{}")).toEqual({
      greet: "hi wd",
      same: true,
      file: join(wd, "scratch.ts"),
      data: "from wd",
      metaDir: wd,
    });
  }, 20000);

  test("a file created in the WD after the spare started imports (R-M1-17(d), bundled Bun)", async () => {
    const wd = join(dir, "late");
    await Bun.write(join(wd, ".keep"), "");
    const { spares, spareStarted, waitFor, consoleText, current } = setup(wd);
    spares.setActiveTab("t1");
    await spareStarted();
    await writeFile(join(wd, "late.ts"), `export const late = "created after the spare";${NL}`);
    const { runId } = current.start({
      tabId: "t1",
      code: `import { late } from "./late";${NL}console.log(late);`,
      language: "typescript",
      logpoints: [],
      workingDirectory: wd,
      scriptName: "scratch.ts",
    });
    await waitFor(runId, ["idle", "settled", "failed"]);
    expect(consoleText()).toEqual(["created after the spare"]);
  }, 20000);

  test("a missing working directory fails the run with WorkingDirectoryError and starts nothing", async () => {
    const missing = join(dir, "gone");
    const { events, waitFor, current } = setup(missing);
    const { runId } = current.start({
      tabId: "t1",
      code: "1",
      language: "typescript",
      logpoints: [],
      workingDirectory: missing,
      scriptName: "x.ts",
    });
    await waitFor(runId, ["failed"]);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "error",
        phase: "runner",
        name: "WorkingDirectoryError",
        message: `Working directory not found: ${missing}`,
      }),
    ]);
  }, 20000);
});
