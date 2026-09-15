import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../../src/main/app-paths";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { createRunnerConfig } from "../../src/main/runs/runner-config";

const LF = String.fromCharCode(10);
const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);
let dir = "";
let runner: BunRunnerProcess | null = null;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-runner-env-")));
});
afterEach(async () => {
  runner?.kill();
  runner = null;
  await rm(dir, { recursive: true, force: true });
});

async function writeModule(folder: string, from: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: folder.split("/").pop(), main: "index.js" }));
  await writeFile(join(folder, "index.js"), `module.exports = { from: ${JSON.stringify(from)} };${LF}`);
}

test("a real runner sees login < env.json < .env < JSLAB=1 and resolves the WD's node_modules before app packages (spec §5.3)", async () => {
  const paths = resolveAppPaths({
    resourcesFolder: "/R",
    userData: join(dir, "data"),
    execPath: process.execPath,
    env: {},
  });
  const wd = join(dir, "wd");
  await writeModule(join(wd, "node_modules", "dep"), "wd");
  await writeModule(join(paths.packagesNodeModules, "dep"), "packages");
  await writeModule(join(paths.packagesNodeModules, "only-packages"), "packages");
  await writeFile(join(wd, ".env"), `SHARED=dotenv${LF}ONLY_DOTENV=yes${LF}`);
  const out = join(dir, "out.json");
  const configFor = createRunnerConfig({
    paths: { ...paths, runnerBootstrap: BOOTSTRAP },
    baseEnv: () => ({ PATH: process.env.PATH, SHARED: "login", OUT_FILE: out }),
    envVars: () => ({ SHARED: "env.json", ONLY_ENV: "yes" }),
    workingDirectory: () => wd,
  });
  runner = await BunRunnerProcess.start(configFor("t1"));
  const entry = join(dir, "data", "runs", "t1", "entry-env.mjs");
  await mkdir(join(dir, "data", "runs", "t1"), { recursive: true });
  await writeFile(
    entry,
    [
      'import { writeFileSync } from "node:fs";',
      'const dep = await import("dep");',
      'const only = await import("only-packages");',
      "writeFileSync(process.env.OUT_FILE, JSON.stringify({",
      "  shared: process.env.SHARED, onlyEnv: process.env.ONLY_ENV, onlyDotenv: process.env.ONLY_DOTENV,",
      "  jslab: process.env.JSLAB, cwd: process.cwd(), dep: dep.default.from, only: only.default.from,",
      "}));",
      "",
    ].join(LF),
  );
  const current = runner;
  const settled = new Promise<void>((resolve) =>
    current.onMessage((message) => {
      if (message.type === "state" && (message.state === "idle" || message.state === "settled")) resolve();
    }),
  );
  current.send({ type: "run", runId: "run-env", entry, settings: { maxEntries: 100 } });
  await settled;
  expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
    shared: "dotenv",
    onlyEnv: "yes",
    onlyDotenv: "yes",
    jslab: "1",
    cwd: wd,
    dep: "wd",
    only: "packages",
  });
}, 20000);
