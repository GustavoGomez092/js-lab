import Electrobun, { BrowserView, BrowserWindow, PATHS, Utils } from "electrobun/main";
import { probeLib } from "@spike/probe-lib";
import { mkdirSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
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
    requests: { probes: () => ({ ...s1, s6Enabled: process.env.JSLAB_SPIKE_S6 === "1" }) },
    messages: {
      viewReport: ({ section, data }) => writeReport(section, data),
      saveDialog: ({ defaultName }) => {
        const started = performance.now();
        saveDialog({ defaultName, defaultDir: Utils.paths.documents })
          .then((path) => rpc.send.saveDialogResult({ path, ms: Math.round(performance.now() - started) }))
          .catch((error) => rpc.send.saveDialogResult({ path: null, error: String(error), ms: Math.round(performance.now() - started) }));
      },
      startThroughput: () => {},
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
