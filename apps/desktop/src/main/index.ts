import { mkdirSync } from "node:fs";
import type { MainMessages, MainRequests, ViewMessages } from "@jslab/rpc-schema";
import { runnerSettings } from "@jslab/shared";
import Electrobun, {
  ApplicationMenu,
  type ApplicationMenuItemConfig,
  BrowserView,
  BrowserWindow,
  PATHS,
  type RPCSchema,
  Updater,
  Utils,
} from "electrobun/main";
import { resolveAppPaths, runnerEnvironment } from "./app-paths";
import { buildMenu, commandForMenuAction, type MenuItem } from "./menu";
import { externalLinkFrom, navigationRulesFor } from "./navigation";
import { RunLock } from "./persistence/run-lock";
import { createRpcHandlers } from "./rpc-handlers";
import { BunRunnerProcess } from "./runs/bun-runner-process";
import { RunCoordinator } from "./runs/run-coordinator";
import { SparePool } from "./runs/spare-pool";
import { detectSafeMode, isShiftHeld } from "./services/safe-mode";
import { SessionStore } from "./services/session-store";
import { SettingsStore } from "./services/settings-store";
import { CachingTransformHost, WorkerTransformHost } from "./transform/transform-host";
import { shouldReloadView } from "./ui-watchdog";

// `.hutch/devkit`'s `api/sdks/main/proc/native.ts` references the WebWorker global `self` in a carrot/Bunny Ears
// bridge class we never instantiate, but this project's tsconfig has no "dom"/"webworker" lib entry (a Bun main
// process has no DOM). Importing any `electrobun/main` API pulls that vendored file into the type-check program,
// so it fails `tsc` even though the code path is unreachable here. `declare global` merges into the whole
// apps/desktop tsconfig program (every file `tsc -p .` type-checks here), not just this file -- it's safe only
// because apps/ui (Tasks 15-18's React/Monaco code) is a separate tsconfig program with its own "dom" lib, so
// there's no conflicting `self` declaration to clash with. If a future tsconfig ever merges a "dom"/"webworker"
// lib into this same program (e.g. apps/desktop/src ever included from a DOM-lib tsconfig), move this to a
// main-only `.d.ts` (e.g. `src/main/global.d.ts`) instead of leaving it here.
declare global {
  // eslint-disable-next-line no-var
  var self: typeof globalThis;
}

type JSLabRPC = {
  bun: RPCSchema<{ requests: MainRequests; messages: MainMessages }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: ViewMessages }>;
};

const APP_VERSION = "0.0.1";
const DEV_SERVER_URL = "http://localhost:5173";

const log = (message: string, detail?: unknown) => console.error(`[jslab] ${message}`, detail ?? "");

/**
 * A rejection anywhere in `start()` -- a failing store recovery rewrite, for example -- must not crash Main
 * before any window (or dialog) appears, which would look like the app silently "doesn't launch" (I2).
 */
async function fail(error: unknown): Promise<void> {
  log("startup failed", error);
  const message = error instanceof Error ? error.message : String(error);
  try {
    // Utils.showMessageBox (apps/desktop/.hutch/devkit/api/sdks/main/core/Utils.ts:284-306, backed by the
    // native `ffi.request.showMessageBox`) shows a native dialog independent of any BrowserWindow -- exactly
    // what's needed here, since startup can fail before a window exists.
    await Utils.showMessageBox({ type: "error", title: "JSLab", message: `JSLab couldn't start: ${message}` });
  } catch (dialogError) {
    log("startup failure dialog could not be shown", dialogError);
  }
  // Utils.quit() itself falls back to process.exit() when native FFI isn't available (see Utils.ts), and
  // returns false only if a quit is already in flight; process.exit(1) covers that remaining case.
  if (!Utils.quit(1)) process.exit(1);
}

async function start(): Promise<void> {
  const paths = resolveAppPaths({
    resourcesFolder: PATHS.RESOURCES_FOLDER,
    userData: Utils.paths.userData,
    execPath: process.execPath,
    env: process.env,
  });

  // A fresh install has no userData directory yet: settings/session recovery tolerates that (it treats a missing
  // primary file as "none", never writing until an update or a real recovery), but SparePool's pre-warmed runner
  // spawns with this as its cwd, and Bun.spawn throws synchronously (ENOENT) for a cwd that doesn't exist yet.
  mkdirSync(paths.dataDir, { recursive: true });

  // Read the modifier keys as early as possible: the user may release Shift while stores load.
  const shiftHeld = isShiftHeld();
  const runLock = new RunLock(paths.runLock);
  const [settings, session] = await Promise.all([SettingsStore.open(paths.dataDir), SessionStore.open(paths.dataDir)]);
  const safeMode = await detectSafeMode({
    uncleanPreviousExit: runLock.uncleanPreviousExit,
    shiftHeld: () => shiftHeld,
  });
  if (settings.recovered !== "none") log(`settings.json recovered from ${settings.recovered}`);
  if (session.recovered !== "none") log(`session.json recovered from ${session.recovered}`);
  if (safeMode.active) log(`starting in Safe Mode (${safeMode.reason})`);

  // The UI gets a longer boot grace period for its first heartbeat (cold WKWebView init, bundle load, etc.);
  // only once it has sent one does the shorter steady-state deadline apply (I1).
  let sawFirstHeartbeat = false;
  let bootWindowStartedAt = Date.now();
  let lastUiHeartbeat = Date.now();
  const transform = new CachingTransformHost(new WorkerTransformHost(paths.transformWorker));
  const spares = new SparePool(
    (config) => BunRunnerProcess.start(config),
    () => ({
      bunPath: paths.bunBinary,
      bootstrapPath: paths.runnerBootstrap,
      cwd: paths.dataDir,
      env: runnerEnvironment(paths, process.env),
    }),
  );

  const coordinator: RunCoordinator = new RunCoordinator({
    transform: (source, options) => transform.transform(source, options),
    spares,
    runsDir: paths.runsDir,
    settings: () => runnerSettings(settings.current),
    onEvents: (tabId, runId, events) => rpc.send["run.events"]({ tabId, runId, events }),
    onState: (tabId, runId, state, activeHandles) =>
      rpc.send["run.state"]({ tabId, runId, state, ...(activeHandles === undefined ? {} : { activeHandles }) }),
    onDiagnostics: (tabId, runId, diagnostics) => rpc.send["run.diagnostics"]({ tabId, runId, diagnostics }),
    runLock,
  });

  const rpc = BrowserView.defineRPC<JSLabRPC>({
    maxRequestTime: 10_000,
    handlers: createRpcHandlers({
      coordinator,
      settings,
      session,
      safeMode,
      versions: { app: APP_VERSION, bun: Bun.version },
      log,
      onUiHeartbeat: () => {
        sawFirstHeartbeat = true;
        lastUiHeartbeat = Date.now();
      },
    }),
  });

  async function mainViewUrl(): Promise<string> {
    if ((await Updater.localInfo.channel()) === "dev") {
      try {
        await fetch(DEV_SERVER_URL, { method: "HEAD" });
        return DEV_SERVER_URL;
      } catch {
        // No Vite dev server; use the built view.
      }
    }
    return "views://mainview/index.html";
  }

  const url = await mainViewUrl();
  const window = new BrowserWindow({
    title: "JSLab",
    url,
    frame: session.session.window ?? { x: 120, y: 80, width: 1280, height: 820 },
    rpc,
  });

  // Spec §18: the RPC-bridged view never navigates away from views:// (a dropped URL or a clicked link would otherwise
  // replace the UI); blocked web and mail links open in the default browser instead.
  window.webview.setNavigationRules(navigationRulesFor(url));
  window.webview.on("will-navigate", (event: unknown) => {
    const link = externalLinkFrom((event as { data?: { detail?: unknown } }).data?.detail);
    if (link) Utils.openExternal(link);
  });

  const saveFrame = () => session.setWindow(window.getFrame());
  window.on("resize", saveFrame);
  window.on("move", saveFrame);

  // `MenuItem` (Task 13) models the shape ApplicationMenu.setApplicationMenu ends up accepting at runtime
  // (`type: "separator"` is treated identically to "divider", see .hutch/devkit's ApplicationMenu.ts), but its
  // `type` field isn't a discriminated union, so it doesn't structurally satisfy the devkit's real
  // `ApplicationMenuItemConfig` union. Adapt it here rather than reshaping menu.ts's own interface (Task 13's file).
  function toApplicationMenuItems(items: MenuItem[]): ApplicationMenuItemConfig[] {
    return items.map((item): ApplicationMenuItemConfig => {
      if (item.type === "separator") return { type: "divider" };
      const submenu = item.submenu ? toApplicationMenuItems(item.submenu) : undefined;
      if (item.role) {
        return {
          role: item.role,
          ...(item.label !== undefined ? { label: item.label } : {}),
          ...(item.accelerator !== undefined ? { accelerator: item.accelerator } : {}),
          ...(submenu ? { submenu } : {}),
        };
      }
      return {
        label: item.label ?? "",
        ...(item.action !== undefined ? { action: item.action } : {}),
        ...(item.accelerator !== undefined ? { accelerator: item.accelerator } : {}),
        ...(submenu ? { submenu } : {}),
      };
    });
  }

  ApplicationMenu.setApplicationMenu(toApplicationMenuItems(buildMenu()));
  ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
    const action = (event as { data?: { action?: string } }).data?.action;
    const command = action ? commandForMenuAction(action) : null;
    if (command) rpc.send["menu.command"]({ command });
  });

  // Warm the first runner so the first run is fast (spec §5.3).
  spares.prepare(session.session.activeTabId);

  // WKWebView can freeze after sleep (Electrobun #550): reload the view if UI heartbeats stop (spec §4.6),
  // giving the first heartbeat a longer boot grace period so a slow-but-healthy cold start isn't reloaded
  // forever (I1).
  setInterval(() => {
    const now = Date.now();
    if (!shouldReloadView({ now, startedAt: bootWindowStartedAt, lastHeartbeat: lastUiHeartbeat, sawFirstHeartbeat })) {
      return;
    }
    log("UI heartbeat missed; reloading the view");
    // Still waiting on the first heartbeat: start a fresh boot window rather than reloading every tick.
    if (!sawFirstHeartbeat) bootWindowStartedAt = now;
    lastUiHeartbeat = now;
    window.webview.loadURL(url);
  }, 2000);

  let quitting = false;
  Electrobun.events.on("before-quit", (event: { response?: unknown }) => {
    if (quitting) return;
    // before-quit does not await promises: cancel, flush state, then quit for real.
    event.response = { allow: false };
    quitting = true;
    coordinator.dispose();
    transform.dispose();
    runLock.releaseAll();
    void session
      .flush()
      .catch((error) => log("session flush failed at quit", error))
      .finally(() => Utils.quit());
  });
}

void start().catch(fail);
