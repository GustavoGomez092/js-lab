# JSLab M0: Spikes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the eight open technical questions that could change JSLab's design, and record a go or fallback decision for each before M1 starts.

**Architecture:** Every spike lives in `spikes/<name>/` and is throwaway: nothing here is imported by product code. S1 creates one Electrobun shell app. S2–S8 add probes to that same app, so one packaged build answers several questions. Results go into a single report, and the spec is edited where reality differs.

**Tech Stack:** Electrobun 2.0.1 + Hutch, `mainProcess: "bun"`, React + Vite (from Electrobun's `react-tailwind-vite` template), `monaco-editor@0.56.0`.

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md` (§4.6, §5.3, §5.12, §19, §24 M0 row, §25).

## Global Constraints

- Spike code is throwaway. It is committed for reference, but never imported by `apps/` or `packages/`.
- Electrobun is pinned to exactly `2.0.1`. Record the Hutch version and the bundled Bun version that it installs.
- Never modify the real `~/.npmrc`, `~/Library` preferences or other user state. Use temporary directories and env overrides.
- App identifier for spikes: `dev.jslab.spike`.
- Each task ends by appending its section to `docs/spikes/2026-09-m0-report.md` and committing.
- A spike "passes" only on the criteria written in its task. Anything else is recorded as a fail, with the fallback decision.

## Already known (verified 2026-09-12 on Bun 1.3.13, outside Electrobun)

S3 and S8 must re-check these with the Bun that Electrobun bundles, inside the packaged app:

- `bun --no-env-file` prevents `.env` auto-loading.
- `NODE_PATH` and walk-up `node_modules` resolution both work for a spawned child that `await import()`s an entry file.
- A preload `Bun.plugin` `onResolve` hook does **not** intercept bare imports in a dynamically imported module.
- `process.getActiveResourcesInfo()` returns `[]` while a timer is pending, so it can't be used.
- `Bun.spawn({ ipc })` with `process.send`/`process.on("message")` round-trips JSON messages.

## File map

```
spikes/s1-shell/                     Electrobun app from the react-tailwind-vite template
  electrobun.config.ts               mainProcess bun, copy rules for runner + probe files
  hutch.config.ts                    packageManager bun
  package.json                       workspaces: ["packages/*"]
  packages/probe-lib/src/index.ts    workspace package imported by main and view (S1)
  src/bun/index.ts                   main process: probes S1, S3, S6, S7, S8 + RPC
  src/bun/worker.ts                  Bun Worker echo (S1)
  src/bun/save-dialog.ts             osascript save dialog (S6)
  src/shared/rpc.ts                  RPC schema for the spike
  src/mainview/main.tsx, App.tsx     view: Monaco (S2), webview tag (S4), throughput meter (S7)
  runner/child.mjs                   child runner script copied into the bundle (S3, S8)
  runner/fixture-pkg/                package used for NODE_PATH resolution (S3)
  webview-probe/index.html           page loaded in <electrobun-webview> (S4)
  scripts/patch-plist.ts             Info.plist document types patch (S5)
docs/spikes/2026-09-m0-report.md     results
```

---

### Task 1: Report skeleton and S1 shell app

**Files:**
- Create: `docs/spikes/2026-09-m0-report.md`
- Create: `spikes/s1-shell/**` (copied from the template)
- Create: `spikes/s1-shell/packages/probe-lib/package.json`, `spikes/s1-shell/packages/probe-lib/src/index.ts`
- Create: `spikes/s1-shell/src/bun/worker.ts`, `spikes/s1-shell/src/shared/rpc.ts`
- Modify: `spikes/s1-shell/electrobun.config.ts`, `spikes/s1-shell/hutch.config.ts`, `spikes/s1-shell/package.json`, `spikes/s1-shell/src/bun/index.ts`, `spikes/s1-shell/src/mainview/App.tsx`

**Interfaces:**
- Produces: a buildable app at `spikes/s1-shell`, the RPC type `SpikeRPC` in `src/shared/rpc.ts`, and `writeReport(section: string, data: unknown)` in `src/bun/index.ts`, which writes `<userData>/spike-report.json`. Tasks 2–8 extend these.

- [ ] **Step 1: Create the report skeleton**

```markdown
# M0 Spike Report

| Spike | Question | Result | Decision |
|---|---|---|---|
| S1 | Shell, workspace imports, Worker, paths | | |
| S2 | Monaco workers over views:// | | |
| S3 | Bundled Bun child runner | | |
| S4 | Embedded webview dialogs + hidden timers | | |
| S5 | Info.plist document types + signing | | |
| S6 | osascript save dialog | | |
| S7 | RPC throughput | | |
| S8 | Runtime flags + .npmrc isolation | | |

## Environment

- macOS version:
- Electrobun: 2.0.1
- Hutch version:
- Bundled Bun version (from `Bun.version` in main):
```

- [ ] **Step 2: Copy the template at the pinned tag**

```bash
git clone --depth 1 --branch v2.0.1 https://github.com/blackboardsh/electrobun /tmp/electrobun-2.0.1
mkdir -p spikes
cp -R /tmp/electrobun-2.0.1/templates/react-tailwind-vite spikes/s1-shell
```

Expected: `spikes/s1-shell/electrobun.config.ts` exists.

- [ ] **Step 3: Install Hutch and dependencies**

```bash
cd spikes/s1-shell
bunx electrobun@2.0.1 --help
```

Follow the printed bootstrap instructions to get `hutch` on `PATH`, then run:

```bash
hutch --version
hutch install
hutch electrobun sync
```

Expected: a `.hutch/devkit` directory exists. Record the Hutch version in the report's Environment section.

- [ ] **Step 4: Switch to the Bun main process and add copy rules**

Replace `spikes/s1-shell/electrobun.config.ts` with:

```ts
import type { ElectrobunConfig } from "electrobun";

export default {
  app: { name: "JSLab Spike", identifier: "dev.jslab.spike", version: "0.0.1" },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/bun/index.ts" },
    copy: {
      "dist/index.html": "views/mainview/index.html",
      "dist/assets": "views/mainview/assets",
      runner: "runner",
      "webview-probe": "views/webview-probe",
    },
    watchIgnore: ["dist/**"],
    mac: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
```

Replace `spikes/s1-shell/hutch.config.ts` with:

```ts
export default {
  packageManager: "bun",
  scripts: {
    install: ["hutch", "pm", "install"],
    dev: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev",
    build: "hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=canary",
  },
};
```

Add `"workspaces": ["packages/*"]` to `spikes/s1-shell/package.json`.

- [ ] **Step 5: Add the workspace package**

`spikes/s1-shell/packages/probe-lib/package.json`:

```json
{ "name": "@spike/probe-lib", "version": "0.0.0", "type": "module", "exports": { ".": "./src/index.ts" } }
```

`spikes/s1-shell/packages/probe-lib/src/index.ts`:

```ts
export const probeLib = (from: string): string => `probe-lib reached from ${from}`;
```

Add `"@spike/probe-lib": "workspace:*"` to `dependencies` in `spikes/s1-shell/package.json`, then run `hutch install`.

- [ ] **Step 6: Define the spike RPC schema**

`spikes/s1-shell/src/shared/rpc.ts`:

```ts
import type { RPCSchema } from "electrobun/view";

export type SpikeRPC = {
  bun: RPCSchema<{
    requests: {
      probes: { params: {}; response: Record<string, unknown> };
    };
    messages: {
      viewReport: { section: string; data: unknown };
      saveDialog: { defaultName: string };
      startThroughput: { seconds: number; batchSize: number };
    };
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {
      saveDialogResult: { path: string | null; error?: string; ms: number };
      throughputBatch: { sentAt: number; events: { seq: number; text: string }[] };
      throughputDone: { sent: number };
    };
  }>;
};
```

- [ ] **Step 7: Write the main-process probes**

`spikes/s1-shell/src/bun/worker.ts`:

```ts
declare const self: Worker;
self.onmessage = (event: MessageEvent) => {
  self.postMessage({ echo: event.data, bun: Bun.version });
};
```

Replace `spikes/s1-shell/src/bun/index.ts` with:

```ts
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
```

- [ ] **Step 8: Show S1 results in the view**

Replace `spikes/s1-shell/src/mainview/App.tsx` with:

```tsx
import { Electroview } from "electrobun/view";
import { useEffect, useState } from "react";
import { probeLib } from "@spike/probe-lib";
import type { SpikeRPC } from "../shared/rpc";

export const rpc = Electroview.defineRPC<SpikeRPC>({
  maxRequestTime: 10_000,
  handlers: {
    requests: {},
    messages: { saveDialogResult: () => {}, throughputBatch: () => {}, throughputDone: () => {} },
  },
});
new Electroview({ rpc });

export default function App() {
  const [probes, setProbes] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    rpc.send.viewReport({ section: "S1-view", data: { probeLib: probeLib("view") } });
    void rpc.request.probes({}).then(setProbes);
  }, []);
  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      <h1>JSLab spikes</h1>
      <pre>{JSON.stringify(probes, null, 2)}</pre>
    </main>
  );
}
```

- [ ] **Step 9: Run in dev, then as a packaged canary build**

```bash
cd spikes/s1-shell
hutch run dev
```

Expected: a window titled "JSLab Spike" showing the probes JSON. Quit it, then run:

```bash
hutch run build
ls artifacts/
open "$(find build -name '*.app' -maxdepth 3 | head -1)"
```

Quit again, then collect the report:

```bash
cat ~/Library/Application\ Support/dev.jslab.spike/*/spike-report.json
```

**Pass criteria** (all in the packaged build):
- `probeLib` works from both main and view.
- The worker replied.
- `execPath` points inside the `.app` bundle.
- `userData` is under `dev.jslab.spike`.

- [ ] **Step 10: Record and commit**

Add an `## S1` section to the report with the raw JSON, the resolved `runner` copy destination (`ls "<app>/Contents/Resources/app"`), and a decision:
- **go:** use workspace packages directly.
- **fallback:** pre-bundle workspace packages with `bun build` into `dist/` before Hutch runs.

```bash
git add spikes/s1-shell docs/spikes/2026-09-m0-report.md
git commit -m "spike(m0): S1 electrobun shell with bun main process"
```

---

### Task 2: S2 Monaco workers over views://

**Files:**
- Create: `spikes/s1-shell/src/mainview/MonacoProbe.tsx`
- Modify: `spikes/s1-shell/src/mainview/App.tsx`, `spikes/s1-shell/package.json`

**Interfaces:**
- Consumes: `rpc` from `App.tsx` (Task 1).
- Produces: a decision on the Monaco worker loading strategy, used by M1 Task 15.

- [ ] **Step 1: Add Monaco**

```bash
cd spikes/s1-shell && hutch pm add monaco-editor@0.56.0
```

- [ ] **Step 2: Write the probe component**

`spikes/s1-shell/src/mainview/MonacoProbe.tsx`:

```tsx
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/languages/features/typescript/ts.worker?worker";
import { useEffect, useRef } from "react";
import { rpc } from "./App";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    return label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker();
  },
};

export function MonacoProbe() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    monaco.typescript.typescriptDefaults.addExtraLib("declare const fromExtraLib: { hello: string };", "file:///extra.d.ts");
    const model = monaco.editor.createModel(
      'const x: number = "a";\n[1, 2].ma\nfromExtraLib.hello',
      "typescript",
      monaco.Uri.parse("file:///tab/probe.ts"),
    );
    const editor = monaco.editor.create(host.current, { model, theme: "vs-dark", automaticLayout: true });
    const timer = setTimeout(async () => {
      const markers = monaco.editor.getModelMarkers({ resource: model.uri });
      const getWorker = await monaco.typescript.getTypeScriptWorker();
      const client = await getWorker(model.uri);
      const completions = await client.getCompletionsAtPosition(model.uri.toString(), model.getOffsetAt({ lineNumber: 2, column: 10 }));
      rpc.send.viewReport({
        section: "S2",
        data: {
          location: location.href,
          markerMessages: markers.map((m) => m.message),
          completionHasMap: Boolean(completions?.entries.some((e: { name: string }) => e.name === "map")),
        },
      });
    }, 4000);
    return () => {
      clearTimeout(timer);
      editor.dispose();
      model.dispose();
    };
  }, []);
  return <div ref={host} style={{ height: 240, border: "1px solid #444" }} />;
}
```

- [ ] **Step 3: Render it**

In `App.tsx`, import `MonacoProbe` and render `<MonacoProbe />` below the `<pre>`.

- [ ] **Step 4: Verify in the packaged build**

```bash
hutch run build && open "$(find build -name '*.app' -maxdepth 3 | head -1)"
```

Wait 5 s, quit, and read the `S2` line in `spike-report.json`.

**Pass criteria:**
- `location` starts with `views://`.
- `markerMessages` contains `Type 'string' is not assignable to type 'number'.`
- `completionHasMap` is `true`.
- Manual check: typing `[1, 2].` shows a suggestion list; hovering `x` shows `const x: number`.

- [ ] **Step 5: Fallback probe (only if Step 4 fails)**

Change both worker imports to `?worker&inline`, rebuild and repeat Step 4. Record which variant passed.

- [ ] **Step 6: Record and commit**

Add an `## S2` report section with the raw data, the variant that passed, and the worker import lines M1 must use.

```bash
git add spikes/s1-shell docs/spikes/2026-09-m0-report.md
git commit -m "spike(m0): S2 monaco workers in WKWebView"
```

---

### Task 3: S3 bundled Bun child runner

**Files:**
- Create: `spikes/s1-shell/runner/child.mjs`
- Create: `spikes/s1-shell/runner/fixture-pkg/node_modules/fixture/package.json`, `spikes/s1-shell/runner/fixture-pkg/node_modules/fixture/index.js`
- Modify: `spikes/s1-shell/src/bun/index.ts`

**Interfaces:**
- Consumes: `writeReport` (Task 1), the `runner` copy rule (Task 1 Step 4).
- Produces: how M1's `appPaths.runnerBootstrap()` locates copied files, and whether `process.execPath` is a usable runner binary.

- [ ] **Step 1: Write the child script**

`spikes/s1-shell/runner/child.mjs`:

```js
process.send({ type: "ready", bun: Bun.version, execPath: process.execPath });
process.on("message", async (message) => {
  if (message.type !== "run") return;
  const result = { type: "result" };
  try {
    result.fixture = (await import("fixture")).default;
  } catch (error) {
    result.fixtureError = String(error);
  }
  result.tla = await Promise.resolve(42);
  result.dotenv = process.env.SPIKE_DOTENV ?? null;
  result.cwd = process.cwd();
  process.send(result);
});
```

- [ ] **Step 2: Write the fixture package**

`runner/fixture-pkg/node_modules/fixture/package.json`:

```json
{ "name": "fixture", "version": "1.0.0", "type": "module", "main": "index.js" }
```

`runner/fixture-pkg/node_modules/fixture/index.js`:

```js
export default "fixture resolved via NODE_PATH";
```

- [ ] **Step 3: Add the S3 probe to main**

Append to `spikes/s1-shell/src/bun/index.ts`:

```ts
import { existsSync, writeFileSync } from "node:fs";

async function s3Probe(): Promise<unknown> {
  const appDir = join(PATHS.RESOURCES_FOLDER, "app");
  const childPath = join(appDir, "runner", "child.mjs");
  const cwd = join(Utils.paths.userData, "s3-cwd");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".env"), "SPIKE_DOTENV=should-not-load\n");
  const out: Record<string, unknown> = { childPath, childExists: existsSync(childPath) };
  const started = performance.now();
  const messages: unknown[] = [];
  const child = Bun.spawn([process.execPath, "--no-env-file", childPath], {
    cwd,
    env: { ...process.env, NODE_PATH: join(appDir, "runner", "fixture-pkg", "node_modules") },
    stderr: "pipe",
    ipc(message) {
      messages.push(message);
      if ((message as { type: string }).type === "ready") {
        out.readyMs = Math.round(performance.now() - started);
        child.send({ type: "run" });
      }
    },
  });
  await Bun.sleep(3000);
  child.kill("SIGKILL");
  out.exitCode = await child.exited;
  out.messages = messages;
  out.stderr = await new Response(child.stderr).text();
  const codesign = Bun.spawnSync(["codesign", "-dv", process.execPath], { stderr: "pipe" });
  out.execPathCodesign = codesign.stderr.toString();
  return out;
}
writeReport("S3", await s3Probe());
```

- [ ] **Step 4: Verify in the packaged build**

Build, open, wait 5 s, quit, then read the `S3` line.

**Pass criteria:**
- `childExists` is `true`.
- `messages` contains `ready` with `execPath` inside the bundle, and a `result` with `fixture: "fixture resolved via NODE_PATH"`, `tla: 42`, `dotenv: null`.
- `readyMs` is under 300.
- `exitCode` is non-null (the kill worked).

- [ ] **Step 5: Evaluate a separately pinned runner Bun (risk R9)**

1. Download Bun 1.3.13 darwin-aarch64 from `https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-darwin-aarch64.zip`.
2. Unzip it to `spikes/s1-shell/runner/bun-bin/bun`.
3. Add a second spawn in `s3Probe` using `join(appDir, "runner", "bun-bin", "bun")` instead of `process.execPath`.
4. Build with `hutch run build`.

Record whether the copied binary:
- runs, reporting `ready`;
- is signed by Hutch's nested signing (`codesign -dv` output).

- [ ] **Step 6: Record and commit**

Add an `## S3` section with the raw data. Decisions to record:
- **Runner binary:** `process.execPath` or a separately pinned binary.
- **Copied-file path formula:** `join(PATHS.RESOURCES_FOLDER, "app", "runner", …)`, or whatever the data shows.

```bash
git add spikes/s1-shell docs/spikes/2026-09-m0-report.md
git commit -m "spike(m0): S3 bundled bun child runner"
```

---

### Task 4: S4 embedded webview dialogs and hidden timers

**Files:**
- Create: `spikes/s1-shell/webview-probe/index.html`
- Create: `spikes/s1-shell/src/mainview/WebviewProbe.tsx`
- Modify: `spikes/s1-shell/src/mainview/App.tsx`

**Interfaces:**
- Consumes: `rpc` (Task 1).
- Produces: the dialog strategy and hidden-webview strategy for M4.

- [ ] **Step 1: Read the tag docs at the pinned version**

```bash
ls /tmp/electrobun-2.0.1/docs/src/content/docs/electrobun/apis/browser/
```

Open the page for `<electrobun-webview>`. Note in the report:
- the attribute for the URL (expected `src`)
- partition and sandbox attributes
- how the host page talks to the embedded page (host-message API)

If the attribute names differ from the ones below, use the documented names in Steps 2–3.

- [ ] **Step 2: Write the embedded probe page**

`spikes/s1-shell/webview-probe/index.html`:

```html
<!doctype html>
<html>
  <body style="font-family: monospace">
    <button id="dialogs">alert / confirm / prompt</button>
    <pre id="out"></pre>
    <script>
      const out = document.getElementById("out");
      const log = (line) => (out.textContent += line + "\n");
      let intervalTicks = 0;
      let rafTicks = 0;
      setInterval(() => intervalTicks++, 100);
      const raf = () => {
        rafTicks++;
        requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
      window.spikeTicks = () => ({ intervalTicks, rafTicks, at: Date.now() });
      document.getElementById("dialogs").onclick = () => {
        const t0 = performance.now();
        const alertReturn = alert("alert from embedded webview");
        const alertBlockedMs = Math.round(performance.now() - t0);
        const confirmed = confirm("confirm?");
        const prompted = prompt("prompt?", "default");
        log(JSON.stringify({ alertReturn, alertBlockedMs, confirmed, prompted }));
      };
    </script>
  </body>
</html>
```

- [ ] **Step 3: Write the host component**

`spikes/s1-shell/src/mainview/WebviewProbe.tsx`:

```tsx
import { useRef, useState } from "react";
import { rpc } from "./App";

export function WebviewProbe() {
  const ref = useRef<HTMLElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const style = collapsed ? { width: 0, height: 0 } : { width: 480, height: 200 };
  const collapseFor10s = () => {
    setCollapsed(true);
    rpc.send.viewReport({ section: "S4-collapse", data: { startedAt: Date.now() } });
    setTimeout(() => setCollapsed(false), 10_000);
  };
  return (
    <section>
      <button type="button" onClick={collapseFor10s}>Collapse webview for 10s</button>
      {/* @ts-expect-error custom element provided by Electrobun's preload */}
      <electrobun-webview ref={ref} src="views://webview-probe/index.html" style={{ display: "block", ...style }} />
    </section>
  );
}
```

Render `<WebviewProbe />` in `App.tsx`.

- [ ] **Step 4: Manual verification in the packaged build**

1. Click the button in the embedded page. Note whether the three native dialogs appear, whether `alertBlockedMs` is at least the time the alert stayed open, and whether `confirmed`/`prompted` reflect your choices.
2. Open Web Inspector on the embedded page (right-click → Inspect, if enabled) and run `spikeTicks()`. Click "Collapse webview for 10s", wait, then run `spikeTicks()` again.

Record both tick deltas over the 10 s:
- **Expected if not throttled:** about 100 interval ticks and about 600 rAF ticks at 60 Hz.

**Pass criteria:**
- Dialogs block and return real values.
- The interval keeps at least 80% of its ticks while collapsed. rAF pausing is acceptable; record it either way.

- [ ] **Step 5: Record and commit**

Add an `## S4` section. Decisions to record:
- **Dialogs:** native, or the §5.12 async fallback.
- **Hidden webview:** zero-size, or offscreen at 1×1 px if zero-size throttles timers.

```bash
git add spikes/s1-shell docs/spikes/2026-09-m0-report.md
git commit -m "spike(m0): S4 embedded webview dialogs and hidden timers"
```

---

### Task 5: S5 Info.plist document types and signing order

**Files:**
- Create: `spikes/s1-shell/scripts/patch-plist.ts`
- Modify: `spikes/s1-shell/electrobun.config.ts`

**Interfaces:**
- Produces: the hook name and patch script shape for M6 file associations.

- [ ] **Step 1: Find the post-wrap hook name at the pinned version**

```bash
grep -rn -iE "postWrap|postBuild|postPackage|hooks" /tmp/electrobun-2.0.1/docs/src/content/docs/electrobun/apis/build-config.mdx | head -20
```

Record the hook name that runs after the `.app` is assembled and **before** code signing. If no such hook exists, record that and use the hook that runs after signing, then re-sign in Step 4.

- [ ] **Step 2: Write the patch script**

`spikes/s1-shell/scripts/patch-plist.ts`:

```ts
import { join } from "node:path";

const appPath = process.argv[2] ?? process.env.ELECTROBUN_APP_PATH;
if (!appPath) throw new Error("usage: bun scripts/patch-plist.ts <path-to-.app>");
const plist = join(appPath, "Contents", "Info.plist");
const extensions = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"];
const documentTypes = extensions.map((ext) => ({
  CFBundleTypeName: `${ext.toUpperCase()} source`,
  CFBundleTypeRole: "Editor",
  LSHandlerRank: "Alternate",
  CFBundleTypeExtensions: [ext],
}));
const run = (args: string[]) => {
  const result = Bun.spawnSync(["plutil", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0 && !result.stderr.toString().includes("No value to remove")) {
    throw new Error(result.stderr.toString());
  }
};
run(["-remove", "CFBundleDocumentTypes", plist]);
run(["-insert", "CFBundleDocumentTypes", "-json", JSON.stringify(documentTypes), plist]);
console.log(`patched ${plist}`);
```

- [ ] **Step 3: Wire the hook**

Add the hook from Step 1 to `electrobun.config.ts`, pointing at `bun scripts/patch-plist.ts` and using the variable or argument the docs specify for the app path. Rebuild with `hutch run build`.

- [ ] **Step 4: Verify**

```bash
APP="$(find build -name '*.app' -maxdepth 3 | head -1)"
plutil -p "$APP/Contents/Info.plist" | grep -A3 CFBundleDocumentTypes
codesign --verify --deep --strict --verbose=2 "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
```

If the build is not Developer-ID signed (no credentials locally), ad-hoc sign first with `codesign --force --deep -s - "$APP"`, then verify.

Manual check: in Finder, right-click a `.ts` file → Open With. "JSLab Spike" should be listed. Open the file and add a temporary `Electrobun.events.on("open-url", e => writeReport("S5-open-url", e.data))` in main to confirm the path arrives.

**Pass criteria:**
- `CFBundleDocumentTypes` is present.
- `codesign --verify` passes.
- The app appears in Open With.
- `open-url` delivers a `file://` URL.

- [ ] **Step 5: Record and commit**

Add an `## S5` section. Decision: **go** with the hook, or **fallback** (re-sign after patching in CI, or defer file associations past 1.0 per risk R4).

```bash
git add spikes/s1-shell docs/spikes/2026-09-m0-report.md
git commit -m "spike(m0): S5 info.plist document types"
```

---

### Task 6: S6 osascript save dialog

**Files:**
- Create: `spikes/s1-shell/src/bun/save-dialog.ts`
- Create: `spikes/s1-shell/src/bun/save-dialog.test.ts`
- Modify: `spikes/s1-shell/src/bun/index.ts`, `spikes/s1-shell/src/mainview/App.tsx`

**Interfaces:**
- Produces: `saveDialog(options: { defaultName: string; defaultDir?: string }): Promise<string | null>` and `buildSaveScript(...)`. M2 copies these into `apps/desktop/src/main/platform/save-dialog.ts` if the spike passes.

- [ ] **Step 1: Write the failing test for script building**

`spikes/s1-shell/src/bun/save-dialog.test.ts`:

```ts
import { expect, test } from "bun:test";
import { buildSaveScript } from "./save-dialog";

test("escapes quotes and backslashes in names and folders", () => {
  expect(buildSaveScript({ defaultName: 'a "b"\\c.ts', defaultDir: "/tmp/x y" })).toBe(
    'POSIX path of (choose file name with prompt "Save As" default name "a \\"b\\"\\\\c.ts" default location (POSIX file "/tmp/x y"))',
  );
});

test("omits the location when no folder is given", () => {
  expect(buildSaveScript({ defaultName: "x.ts" })).toBe('POSIX path of (choose file name with prompt "Save As" default name "x.ts")');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd spikes/s1-shell && bun test src/bun/save-dialog.test.ts`
Expected: FAIL, `Cannot find module './save-dialog'`.

- [ ] **Step 3: Implement**

`spikes/s1-shell/src/bun/save-dialog.ts`:

```ts
const quote = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

export function buildSaveScript(options: { defaultName: string; defaultDir?: string }): string {
  const location = options.defaultDir ? ` default location (POSIX file ${quote(options.defaultDir)})` : "";
  return `POSIX path of (choose file name with prompt "Save As" default name ${quote(options.defaultName)}${location})`;
}

/** Resolves the chosen path, or null when the user cancels (AppleScript error -128). */
export async function saveDialog(options: { defaultName: string; defaultDir?: string }): Promise<string | null> {
  const proc = Bun.spawn(["osascript", "-e", buildSaveScript(options)], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code === 0) return stdout.trim();
  if (stderr.includes("-128")) return null;
  throw new Error(stderr.trim() || `osascript exited with ${code}`);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `bun test src/bun/save-dialog.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Wire it through the RPC message pattern**

In `src/bun/index.ts`, replace the `saveDialog: () => {}` handler with:

```ts
saveDialog: ({ defaultName }) => {
  const started = performance.now();
  saveDialog({ defaultName, defaultDir: Utils.paths.documents })
    .then((path) => rpc.send.saveDialogResult({ path, ms: Math.round(performance.now() - started) }))
    .catch((error) => rpc.send.saveDialogResult({ path: null, error: String(error), ms: Math.round(performance.now() - started) }));
},
```

Add `import { saveDialog } from "./save-dialog";` at the top. In `App.tsx`:
- add a button that calls `rpc.send.saveDialog({ defaultName: "scratch.ts" })`
- replace the `saveDialogResult` handler with one that sends the payload to `viewReport` under section `"S6"`

- [ ] **Step 6: Manual verification in the packaged build**

Click the button three times:
1. Choose a path.
2. Cancel.
3. Type a name with quotes.

For each, note:
- whether the dialog appears in front of the JSLab window
- whether the JSLab window stays responsive while the dialog is open
- the returned path

**Pass criteria:**
- The chosen path is correct, and cancel gives `null`.
- The dialog is frontmost, or becomes frontmost with one click.
- The UI stays responsive.

- [ ] **Step 7: Record and commit**

Add an `## S6` section. Decision: **go** with osascript, or **fallback** to NSSavePanel via `bun:ffi` in M2.

```bash
git add spikes/s1-shell docs/spikes/2026-09-m0-report.md
git commit -m "spike(m0): S6 osascript save dialog"
```

---

### Task 7: S7 RPC throughput

**Files:**
- Create: `spikes/s1-shell/src/mainview/ThroughputProbe.tsx`
- Modify: `spikes/s1-shell/src/bun/index.ts`, `spikes/s1-shell/src/mainview/App.tsx`

**Interfaces:**
- Produces: validated batching parameters (flush interval and batch size) for M1's `run.events` channel.

- [ ] **Step 1: Main-side sender**

In `src/bun/index.ts`, replace `startThroughput: () => {}` with:

```ts
startThroughput: ({ seconds, batchSize }) => {
  let seq = 0;
  const text = "x".repeat(180);
  const endAt = Date.now() + seconds * 1000;
  const timer = setInterval(() => {
    if (Date.now() >= endAt) {
      clearInterval(timer);
      rpc.send.throughputDone({ sent: seq });
      return;
    }
    const events = Array.from({ length: batchSize }, () => ({ seq: ++seq, text }));
    rpc.send.throughputBatch({ sentAt: Date.now(), events });
  }, 16);
},
```

- [ ] **Step 2: View-side meter**

`spikes/s1-shell/src/mainview/ThroughputProbe.tsx`:

```tsx
import { rpc } from "./App";

const latencies: number[] = [];
let received = 0;
let lastSeq = 0;
let gaps = 0;
let worstFrameMs = 0;
let lastFrame = performance.now();

function frame(now: number) {
  worstFrameMs = Math.max(worstFrameMs, now - lastFrame);
  lastFrame = now;
  requestAnimationFrame(frame);
}

export function attachThroughputHandlers() {
  rpc.setMessageHandlers?.({
    throughputBatch: ({ sentAt, events }: { sentAt: number; events: { seq: number }[] }) => {
      latencies.push(Date.now() - sentAt);
      for (const e of events) {
        if (e.seq !== lastSeq + 1) gaps++;
        lastSeq = e.seq;
      }
      received += events.length;
    },
    throughputDone: ({ sent }: { sent: number }) => {
      const sorted = [...latencies].sort((a, b) => a - b);
      rpc.send.viewReport({
        section: "S7",
        data: { sent, received, gaps, p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)], worstFrameMs: Math.round(worstFrameMs) },
      });
    },
  });
}

export function ThroughputProbe() {
  const start = (batchSize: number) => {
    latencies.length = 0;
    received = 0;
    lastSeq = 0;
    gaps = 0;
    worstFrameMs = 0;
    lastFrame = performance.now();
    requestAnimationFrame(frame);
    rpc.send.startThroughput({ seconds: 10, batchSize });
  };
  return (
    <div>
      <button type="button" onClick={() => start(200)}>Throughput 200/batch</button>
      <button type="button" onClick={() => start(1000)}>Throughput 1000/batch</button>
    </div>
  );
}
```

If `rpc.setMessageHandlers` doesn't exist in 2.0.1, move the two handlers into the `messages` object of `Electroview.defineRPC` in `App.tsx` (import the module-level state from this file). Record which API worked.

- [ ] **Step 3: Measure in the packaged build**

Run 200/batch (about 12.5k events/s) and 1000/batch (about 62k events/s), one after the other.

**Pass criteria for 200/batch:**
- `gaps` is `0` and `received === sent`.
- `p95` is under 50 ms.
- `worstFrameMs` is under 100.

Record the 1000/batch numbers as headroom.

- [ ] **Step 4: Record and commit**

Add an `## S7` section. Decision: keep 16 ms / 200 events, or change it (for example 33 ms / 500).

```bash
git add spikes/s1-shell docs/spikes/2026-09-m0-report.md
git commit -m "spike(m0): S7 rpc throughput"
```

---

### Task 8: S8 runtime flags and .npmrc isolation in the packaged app

**Files:**
- Modify: `spikes/s1-shell/src/bun/index.ts`

**Interfaces:**
- Consumes: `writeReport`, the S3 runner path formula.
- Produces: the exact env/flags for M3's npm service, and confirmation of the S3 flags on the bundled Bun.

- [ ] **Step 1: Add the S8 probe**

Append to `src/bun/index.ts`:

```ts
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

  return {
    bunVersion: Bun.version,
    hasPeek: typeof Bun.peek === "function" && typeof Bun.peek.status === "function",
    emptyProjectRc,
    userconfigOverride,
    projectRegistry,
    installed: await Bun.file(join(project, "package.json")).json(),
  };
}
writeReport("S8", await s8Probe());
```

- [ ] **Step 2: Verify in the packaged build**

Build, open, wait until the `S8` line appears (installs need network), then quit. Interpret:
- `emptyProjectRc.code === 0` means Bun ignores `~/.npmrc` (via `HOME`) by default.
- Otherwise, `userconfigOverride.code === 0` means `NPM_CONFIG_USERCONFIG` isolates it.
- `projectRegistry.code === 0` confirms a project `.npmrc` registry wins.

**Pass criteria:**
- `hasPeek` is `true`.
- At least one isolation strategy succeeds.
- `projectRegistry` succeeds.

- [ ] **Step 3: Record, update the spec and commit**

Add an `## S8` section. Fill in the summary table's Result and Decision cells for all spikes.

Then edit the spec to match reality, in the same commit:
- **§11.3:** the exact isolation env/flags.
- **§5.3:** runner binary choice.
- **§5.12:** dialog and hidden-webview strategy.
- **§4.6:** saveDialog and fileAssociations adapters.
- **§4.2:** batch parameters.
- **§25:** mark retired risks.

```bash
git add spikes/s1-shell docs/spikes/2026-09-m0-report.md docs/superpowers/specs/2026-09-12-jslab-design.md
git commit -m "spike(m0): S8 runtime flags, npmrc isolation, report and spec updates"
```

- [ ] **Step 4: Update M1 plan inputs**

In `docs/superpowers/plans/2026-09-12-jslab-m1-core-scratchpad.md`, update Task 13 (Electrobun project config and app paths), Task 14 (main process bootstrap) and Task 17 (Monaco workers and the Electroview RPC client) wherever a spike result differs from the plan. Commit with `docs(plans): apply M0 spike results to M1`.
