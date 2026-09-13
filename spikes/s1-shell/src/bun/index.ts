import Electrobun, { BrowserView, BrowserWindow, PATHS, Utils } from "electrobun/main";
import { probeLib } from "@spike/probe-lib";
import { mkdirSync, appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SpikeRPC } from "../shared/rpc";
import { saveDialog } from "./save-dialog";

const reportPath = join(Utils.paths.userData, "spike-report.json");
mkdirSync(Utils.paths.userData, { recursive: true });

export function writeReport(section: string, data: unknown): void {
  appendFileSync(reportPath, `${JSON.stringify({ section, at: new Date().toISOString(), data })}\n`);
  console.log(`[spike] ${section}`, JSON.stringify(data));
}

async function workerProbe(): Promise<unknown> {
  try {
    const worker = new Worker(new URL("./worker.ts", import.meta.url).href);
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("worker timeout")), 3000);
      worker.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data);
      };
      worker.postMessage("ping");
    });
    worker.terminate();
    return { ok: true, reply };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

const s1 = {
  bunVersion: Bun.version,
  execPath: process.execPath,
  resourcesFolder: PATHS.RESOURCES_FOLDER,
  viewsFolder: PATHS.VIEWS_FOLDER,
  userData: Utils.paths.userData,
  probeLib: probeLib("main"),
  worker: await workerProbe(),
};
writeReport("S1", s1);

// S5 spike probe: confirm file-association opens are delivered through the
// `open-url` event as a file:// URL. Kept committed (not a temporary edit)
// per the task-5 brief's instruction to reuse writeReport for the probe.
Electrobun.events.on("open-url", (event) => {
  writeReport("S5-open-url", event.data);
});

const rpc = BrowserView.defineRPC<SpikeRPC>({
  maxRequestTime: 10_000,
  handlers: {
    // s6Enabled is not part of the S1 probe data itself (s1 is written verbatim
    // to writeReport("S1", s1) above); it gates the S6 automated probe (see
    // App.tsx) behind JSLAB_SPIKE_S6=1 so S7/S8 runs and normal launches don't
    // pop a Save dialog on screen.
    requests: {
      probes: () => ({
        ...s1,
        s6Enabled: process.env.JSLAB_SPIKE_S6 === "1",
        // S7 automated sequence (ruling R1), relayed to the view the same way
        // s6Enabled is: read here in main, opt-in only, no dialogs involved.
        s7Enabled: process.env.JSLAB_SPIKE_S7 === "1",
      }),
    },
    messages: {
      viewReport: ({ section, data }) => writeReport(section, data),
      saveDialog: ({ defaultName }) => {
        const started = performance.now();
        saveDialog({ defaultName, defaultDir: Utils.paths.documents })
          .then((path) => rpc.send.saveDialogResult({ path, ms: Math.round(performance.now() - started) }))
          .catch((error) => rpc.send.saveDialogResult({ path: null, error: String(error), ms: Math.round(performance.now() - started) }));
      },
      // S7 brief Step 1 sender, verbatim except `batchSize` is threaded through
      // to `throughputDone` (Deviation, see shared/rpc.ts comment) so each
      // completion line self-identifies its run.
      startThroughput: ({ seconds, batchSize }) => {
        let seq = 0;
        const text = "x".repeat(180);
        const endAt = Date.now() + seconds * 1000;
        const timer = setInterval(() => {
          if (Date.now() >= endAt) {
            clearInterval(timer);
            rpc.send.throughputDone({ sent: seq, batchSize });
            return;
          }
          const events = Array.from({ length: batchSize }, () => ({ seq: ++seq, text }));
          rpc.send.throughputBatch({ sentAt: Date.now(), events });
        }, 16);
      },
    },
  },
});

export const mainWindow = new BrowserWindow({
  title: "JSLab Spike",
  url: "views://mainview/index.html",
  frame: { width: 1200, height: 800, x: 120, y: 120 },
  rpc,
});
export { rpc };

async function s3Probe(): Promise<unknown> {
  const appDir = join(PATHS.RESOURCES_FOLDER, "app");
  const childPath = join(appDir, "runner", "child.mjs");
  const cwd = join(Utils.paths.userData, "s3-cwd");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".env"), "SPIKE_DOTENV=should-not-load\n");
  const out: Record<string, unknown> = { childPath, childExists: existsSync(childPath) };

  const runBinary = async (bin: string, serialization?: "json") => {
    const result: Record<string, unknown> = { bin, serialization: serialization ?? "advanced" };
    const started = performance.now();
    const messages: unknown[] = [];
    const child = Bun.spawn([bin, "--no-env-file", childPath], {
      cwd,
      env: { ...process.env, NODE_PATH: join(appDir, "runner", "fixture-pkg", "node_modules") },
      stderr: "pipe",
      ipc(message) {
        messages.push(message);
        if ((message as { type: string }).type === "ready") {
          result.readyMs = Math.round(performance.now() - started);
          child.send({ type: "run" });
        }
      },
      ...(serialization ? { serialization } : {}),
    });
    await Bun.sleep(3000);
    child.kill("SIGKILL");
    result.exitCode = await child.exited;
    result.messages = messages;
    result.stderr = await new Response(child.stderr).text();
    const codesign = Bun.spawnSync(["codesign", "-dv", bin], { stderr: "pipe" });
    result.codesign = codesign.stderr.toString();
    return result;
  };

  const pinnedBunPath = join(appDir, "runner", "bun-bin", "bun");
  const pinnedBunExists = existsSync(pinnedBunPath);
  out.pinnedBunPath = pinnedBunPath;
  out.pinnedBunExists = pinnedBunExists;

  const [execPathRun, pinnedBunRun, pinnedBunJsonRun] = await Promise.all([
    runBinary(process.execPath),
    pinnedBunExists ? runBinary(pinnedBunPath) : Promise.resolve(null),
    // Cross-version IPC follow-up: does explicit JSON serialization avoid the
    // "advanced" (V8 structured-clone) serializer's cross-version incompatibility?
    pinnedBunExists ? runBinary(pinnedBunPath, "json") : Promise.resolve(null),
  ]);
  out.execPathRun = execPathRun;
  out.pinnedBunRun = pinnedBunRun;
  out.pinnedBunJsonRun = pinnedBunJsonRun;
  return out;
}
writeReport("S3", await s3Probe());

async function run(cmd: string[], cwd: string, env: Record<string, string | undefined>) {
  const proc = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) };
}

async function s8Probe(): Promise<unknown> {
  const root = join(Utils.paths.userData, "s8");
  const fakeHome = join(root, "home");
  const project = join(root, "packages");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(fakeHome, ".npmrc"), "registry=http://127.0.0.1:9/\n");
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "s8", private: true, dependencies: {} }));
  const baseEnv = { PATH: process.env.PATH, HOME: fakeHome, TMPDIR: process.env.TMPDIR };

  writeFileSync(join(project, ".npmrc"), "");
  const emptyProjectRc = await run([process.execPath, "add", "--exact", "is-number@7.0.0"], project, baseEnv);

  const userconfigOverride = await run([process.execPath, "add", "--exact", "is-odd@3.0.1"], project, {
    ...baseEnv,
    NPM_CONFIG_USERCONFIG: join(project, ".npmrc"),
  });

  writeFileSync(join(project, ".npmrc"), "registry=https://registry.npmjs.org/\n");
  const projectRegistry = await run([process.execPath, "add", "--exact", "is-even@1.0.0"], project, baseEnv);

  // Beyond the brief (see the report's S8 deviations): a discriminating in-app test of the HOME override.
  // The project .npmrc is emptied (no registry line), and the fake user-home .npmrc holds only a dead
  // *scoped* registry, so the scoped install below can fail only if Bun reads $HOME/.npmrc.
  // (i) HOME = fake user home holding that .npmrc -> expected to fail (proves ~/.npmrc is read).
  // (ii) HOME = empty app-owned npm-home, plus an explicit BUN_INSTALL_CACHE_DIR -> expected exit 0.
  const scopedSpec = "@isaacs/string-locale-compare@1.1.0";
  const userRc = "@isaacs:registry=http://127.0.0.1:9/\n";
  writeFileSync(join(project, ".npmrc"), "");
  writeFileSync(join(fakeHome, ".npmrc"), userRc);
  const isolationSetup = {
    projectNpmrc: await Bun.file(join(project, ".npmrc")).text(),
    fakeUserHomeNpmrc: await Bun.file(join(fakeHome, ".npmrc")).text(),
    spec: scopedSpec,
  };
  const scopedWithUserHome = await run([process.execPath, "add", "--exact", scopedSpec], project, baseEnv);

  const isolatedHome = join(root, "npm-home");
  const cacheDir = join(root, "bun-cache");
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  const scopedWithIsolatedHome = await run([process.execPath, "add", "--exact", scopedSpec], project, {
    ...baseEnv,
    HOME: isolatedHome,
    BUN_INSTALL_CACHE_DIR: cacheDir,
  });

  return {
    bunVersion: Bun.version,
    hasPeek: typeof Bun.peek === "function" && typeof Bun.peek.status === "function",
    emptyProjectRc,
    userconfigOverride,
    projectRegistry,
    isolationSetup,
    scopedWithUserHome,
    scopedWithIsolatedHome: {
      ...scopedWithIsolatedHome,
      isolatedHomeEntries: readdirSync(isolatedHome),
      cacheHasPackage: existsSync(join(cacheDir, "@isaacs")),
    },
    installed: await Bun.file(join(project, "package.json")).json(),
  };
}
writeReport("S8", await s8Probe());
