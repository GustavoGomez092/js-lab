import { BrowserView, BrowserWindow, PATHS, Utils } from "electrobun/main";
import { probeLib } from "@spike/probe-lib";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { SpikeRPC } from "../shared/rpc";

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

const rpc = BrowserView.defineRPC<SpikeRPC>({
  maxRequestTime: 10_000,
  handlers: {
    requests: { probes: () => s1 },
    messages: {
      viewReport: ({ section, data }) => writeReport(section, data),
      saveDialog: () => {},
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
