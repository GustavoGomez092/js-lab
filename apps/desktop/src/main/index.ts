import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { arch, homedir } from "node:os";
import { join } from "node:path";
import type {
  MainMessages,
  MainRequests,
  SettingsViewMessages,
  SettingsWindowMessages,
  SettingsWindowRequests,
  StartupNotice,
  ViewMessages,
} from "@jslab/rpc-schema";
import { DEFAULT_KEYBINDINGS, resolveKeybindings } from "@jslab/shared";
import { listThemes } from "@jslab/themes";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  PATHS,
  type RPCSchema,
  Screen,
  Updater,
  Utils,
} from "electrobun/main";
import { e2eBunCacheDir, resolveAppPaths } from "./app-paths";
import { E2EBridge } from "./cli/e2e-bridge";
import { createSocketMethods } from "./cli/socket-methods";
import { type SocketServer, startSocketServer } from "./cli/socket-server";
import { createErrorPolicy } from "./error-policy";
import { FileService, nodeFileSystem, OPEN_EXTENSIONS } from "./files/file-service";
import { createRedactor } from "./logging/redact";
import { RotatingLog } from "./logging/rotating-log";
import { createMainServices } from "./main-services";
import { resolveMainViewUrl } from "./main-view-url";
import { buildMenu, createMenuController, dispatchMenuAction } from "./menu";
import { externalLinkFrom, navigationRulesFor } from "./navigation";
import { readE2EOpenDialog, readE2ESaveDialog } from "./platform/e2e-dialogs";
import { mergeLoginEnv, readLoginShellEnv } from "./platform/login-shell-env";
import { relaunchApp } from "./platform/relaunch";
import { saveDialog } from "./platform/save-dialog";
import { runSystemProfiler, SystemFontsService } from "./platform/system-fonts";
import { captureWindow, windowNumberOf } from "./platform/window-capture";
import { flushBeforeQuit } from "./quit";
import { type AppHandlerDeps, createAppHandlers, createSettingsAppHandlers } from "./rpc/app-handlers";
import { createEnvHandlers } from "./rpc/env-handlers";
import { createFileHandlers } from "./rpc/file-handlers";
import { createFontHandlers } from "./rpc/font-handlers";
import { createNpmHandlers } from "./rpc/npm-handlers";
import { createNpmrcHandlers } from "./rpc/npmrc-handlers";
import { createE2EResponseHandler, createSettingsHandlers } from "./rpc/settings-handlers";
import { createTypesHandlers } from "./rpc/types-handlers";
import { createWorkingDirectoryHandlers } from "./rpc/wd-handlers";
import { createWebRunnerHandlers } from "./rpc/web-runner-handlers";
import { createWorkspaceHandlers, mergeHandlers } from "./rpc/workspace-handlers";
import { createRpcHandlers } from "./rpc-handlers";
import { KeybindingsStore } from "./services/keybindings-store";
import { isShiftHeld, requestSafeModeOnNextLaunch } from "./services/safe-mode";
import { startupNotices } from "./startup-notices";
import { strings } from "./strings";
import { afterUiFlush, createUiFlushHandlers, createUiFlushWaiter } from "./ui-flush";
import { onReload, shouldReloadView } from "./ui-watchdog";
import { type DisplayInfo, displayForFrame, frameToSave, restoreFrame } from "./windows/frame-restore";
import { createMainWindowController } from "./windows/main-window";

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

type SettingsRPC = {
  bun: RPCSchema<{ requests: SettingsWindowRequests; messages: SettingsWindowMessages }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: SettingsViewMessages }>;
};

const APP_VERSION = "0.0.1";

// Console until start() creates the rotating log, which then replaces both.
let log: (message: string, detail?: unknown) => void = (message, detail) =>
  console.error(`[jslab] ${message}`, detail ?? "");
let logError: (message: string, detail?: unknown) => void = (message, detail) =>
  console.error(`[jslab] ${message}`, detail ?? "");
// Set once the main window and its RPC exist; until then there is nowhere to show a notice.
let showUnexpectedErrorNotice: () => void = () => {};
/**
 * D1: the same late binding, for a notice Main raises from the composition root rather than from an error handler.
 *
 * It must be a `let` assigned later rather than a closure over `rpc`, unlike the run and npm callbacks passed to
 * `createMainServices` below. Those are safe because none of them can run before `rpc` exists; this one can. A
 * settings write is refused inside `createMainServices` itself when the recovery rewrite at open produces an
 * over-cap snapshot, and that happens before `rpc` and `mainWindow` are declared -- so capturing them the way those
 * callbacks do would turn a refused write into a TDZ crash during startup.
 *
 * Dropping a notice raised before the window exists is correct rather than merely tolerable: the condition is
 * permanent, so the next settings change raises it again -- but that is only true because `main-services.ts`
 * latches its once-per-session guard on DELIVERY rather than on the attempt. This sender therefore has to report
 * whether the notice was actually shown. Returning void let an undelivered startup notice spend that guard, after
 * which the user saw no banner at all, ever (D1/D3).
 */
let sendAppNotice: (notice: StartupNotice) => boolean = () => false;

/**
 * Spec §20 (FA-I3, error-policy.ts). A rejection anywhere in `start()` -- a failing store recovery rewrite, for
 * example -- must not crash Main before any window (or dialog) appears, which would look like the app silently
 * "doesn't launch" (I2): until startup finishes, errors fail fast with one dialog and exit code 1. After that, an
 * uncaught error is logged and shown as a notice, and JSLab keeps running.
 */
const errorPolicy = createErrorPolicy({
  log: (message, detail) => logError(message, detail),
  // Utils.showMessageBox (apps/desktop/.hutch/devkit/api/sdks/main/core/Utils.ts:284-306, backed by the native
  // `ffi.request.showMessageBox`) shows a native dialog independent of any BrowserWindow -- exactly what's needed
  // here, since startup can fail before a window exists.
  showFatal: async (message) => {
    await Utils.showMessageBox({ type: "error", title: "JSLab", message: strings.dialogs.startupFailed(message) });
  },
  // Utils.quit() itself falls back to process.exit() when native FFI isn't available (see Utils.ts), and returns
  // false only if a quit is already in flight; process.exit covers that remaining case.
  quit: (code) => {
    if (!Utils.quit(code)) process.exit(code);
  },
  notify: () => showUnexpectedErrorNotice(),
});
process.on("uncaughtException", (error) => errorPolicy.onUncaught("exception", error));
process.on("unhandledRejection", (reason) => errorPolicy.onUncaught("rejection", reason));

async function start(): Promise<void> {
  const paths = resolveAppPaths({
    resourcesFolder: PATHS.RESOURCES_FOLDER,
    userData: Utils.paths.userData,
    execPath: process.execPath,
    env: process.env,
  });

  // Spec §18: env.json values are masked in logs and the debug report once the env store is open.
  let envSecrets: () => readonly string[] = () => [];
  const redact = createRedactor(() => envSecrets());
  const logsDir = join(paths.dataDir, "logs");
  const logger = new RotatingLog({ dir: logsDir, debug: process.env.JSLAB_DEBUG === "1", redact });
  log = (message, detail) => logger.warn(message, detail);
  logError = (message, detail) => logger.error(message, detail);
  const ELECTROBUN_VERSION = "2.0.1";
  // m-4: sw_vers blocks the event loop; only Copy Debug Log needs it, so it's computed on first use and cached
  // rather than on every launch. A plain getter satisfies AppHandlerDeps' `os: { macOS: string; arch: string }`.
  let macOSVersionCache: string | null = null;
  const osInfo = {
    get macOS(): string {
      if (macOSVersionCache === null) {
        macOSVersionCache = Bun.spawnSync(["sw_vers", "-productVersion"]).stdout.toString().trim() || "unknown";
      }
      return macOSVersionCache;
    },
    arch: arch(),
  };

  // A fresh install has no userData directory yet: settings/session recovery tolerates that (it treats a missing
  // primary file as "none", never writing until an update or a real recovery), but SparePool's pre-warmed runner
  // spawns with this as its cwd, and Bun.spawn throws synchronously (ENOENT) for a cwd that doesn't exist yet.
  mkdirSync(paths.dataDir, { recursive: true });
  // FA-I2: the E2E harness reads this to tear down a launch that never became ready, even a Main reparented away from
  // its launcher (the harness checks this PID's command line first). Written before any step that could hang.
  if (process.env.JSLAB_E2E === "1") writeFileSync(join(paths.dataDir, "e2e-main.pid"), String(process.pid));

  // Read the modifier keys as early as possible: the user may release Shift while stores load.
  const shiftHeld = isShiftHeld();
  // Spec §4.6 loginShellEnv: a GUI app lacks the shell PATH. E2E launches skip it, so no scenario runs the user's
  // shell profile.
  const loginEnv = process.env.JSLAB_E2E === "1" ? null : await readLoginShellEnv({ shell: process.env.SHELL, log });
  const baseEnv = mergeLoginEnv(process.env, loginEnv);
  // The composition root builds everything that doesn't need Electrobun (main-services.ts, tested without it).
  // R-M3-T18-FIX-1 M-4: under E2E, npm operations never use the user's Bun cache
  // (JSLAB_E2E_BUN_CACHE_DIR, else <dataDir>/e2e-bun-cache).
  const cacheDir = e2eBunCacheDir(process.env, paths.dataDir);
  const services = await createMainServices({
    paths,
    env: baseEnv,
    shiftHeld,
    log,
    redact,
    // D1: a settings write refused as too large is silent, permanent and repeats forever, so the log line it used
    // to produce was not telling the user anything. `sendAppNotice` is bound once the window exists (see above).
    notify: (notice) => sendAppNotice(notice),
    onEvents: (tabId, runId, events) => rpc.send["run.events"]({ tabId, runId, events }),
    onState: (tabId, runId, state, activeHandles) =>
      rpc.send["run.state"]({ tabId, runId, state, ...(activeHandles === undefined ? {} : { activeHandles }) }),
    onDiagnostics: (tabId, runId, diagnostics) => rpc.send["run.diagnostics"]({ tabId, runId, diagnostics }),
    onAudio: (tabId, active) => rpc.send["run.audio"]({ tabId, active }),
    realHome: homedir(),
    ...(cacheDir ? { bunCacheDirOverride: cacheDir } : {}),
    // M4 §5.12: a browser-mode tab's `<electrobun-webview>` lives in the UI, but the runtime driving it lives
    // here, so every instruction crosses as one of these four messages. `rpc` is declared further down; like the
    // run and npm callbacks above, none of these ever runs before it exists.
    webviewBridge: {
      // T9e: `generation` travels with ensure/destroy so the UI can stamp every `ready`/`exit` it forwards with it.
      ensure: (tabId, generation) => rpc.send["webRunner.ensure"]({ tabId, generation }),
      execute: (tabId, js) => rpc.send["webRunner.execute"]({ tabId, js }),
      reload: (tabId) => rpc.send["webRunner.reload"]({ tabId }),
      destroy: (tabId, generation) => rpc.send["webRunner.destroy"]({ tabId, generation }),
    },
    onNpmOperation: (operation) => rpc.send["npm.op"](operation),
    // R-M3-T18-LOGCAP-1: a pass-through; the log drawer (Task 26) keeps the newest MAX_NPM_LOG_CHARS per operation.
    onNpmLog: (opId, text) => rpc.send["npm.log"]({ opId, text }),
    onNpmChanged: (list) => rpc.send["npm.changed"](list),
  });
  const { settings, session, env, npm, types, runLock, safeMode, transform, spares, coordinator } = services;
  envSecrets = () => env.secrets();
  if (settings.recovered !== "none") log(`settings.json recovered from ${settings.recovered}`);
  if (session.recovered !== "none") log(`session.json recovered from ${session.recovered}`);
  if (settings.newerVersion !== null) {
    log(`settings.json was written by a newer JSLab (version ${settings.newerVersion}); it won't be overwritten`);
  }
  if (session.newerVersion !== null) {
    log(`session.json was written by a newer JSLab (version ${session.newerVersion}); it won't be overwritten`);
  }
  if (session.droppedTabs.length > 0) {
    log(`session.json: skipped ${session.droppedTabs.length} unreadable tab entries`, session.droppedTabs);
  }
  const keybindings = await KeybindingsStore.open(paths.dataDir);
  if (keybindings.invalid) log(strings.log.keybindingsInvalid(keybindings.path));
  if (safeMode.active) logger.info(strings.log.safeMode(String(safeMode.reason)));

  // The UI gets a longer boot grace period for its first heartbeat (cold WKWebView init, bundle load, etc.);
  // only once it has sent one does the shorter steady-state deadline apply (I1).
  let sawFirstHeartbeat = false;
  let bootWindowStartedAt = Date.now();
  let lastUiHeartbeat = Date.now();

  const e2eEnabled = process.env.JSLAB_E2E === "1";

  const systemFonts = new SystemFontsService({
    cacheFile: join(paths.dataDir, "cache", "system-fonts.json"),
    run: () => runSystemProfiler(),
    log,
  });
  // Warm the cache early so the Settings window's font picker has the list (spec §9.4). E2E runs seed the cache.
  if (!e2eEnabled) void systemFonts.list();

  // The bridge sends through `rpc`, which is defined next; send runs only after startup.
  const e2eBridge = new E2EBridge((request) => rpc.send["e2e.request"](request));
  let socketServer: SocketServer | null = null;

  const writeClipboard = (text: string) =>
    e2eEnabled ? writeFileSync(join(paths.dataDir, "e2e-clipboard.txt"), text) : Utils.clipboardWriteText(text);

  // Shared by the main window and the Settings window (whose RPC accepts only its own actions, FA-m11). `mainWindow`
  // and `settingsWindow` are declared later; the handlers read them only when invoked, after startup.
  const appHandlerDeps: AppHandlerDeps = {
    logTail: (lines) => logger.tail(lines),
    settings,
    paths: { dataDir: paths.dataDir, logsDir },
    versions: { app: APP_VERSION, bun: Bun.version, electrobun: ELECTROBUN_VERSION },
    os: osInfo,
    redact,
    log,
    clipboard: writeClipboard,
    openPath: (target) =>
      e2eEnabled ? appendFileSync(join(paths.dataDir, "e2e-opened.txt"), `${target}\n`) : Utils.openPath(target),
    restartInSafeMode: () => {
      logger.info(strings.log.restartRequested);
      requestSafeModeOnNextLaunch(paths.dataDir);
      // m-6: a relaunch that couldn't be spawned is still reported; either way JSLab quits (the user can
      // reopen it themselves, and the flag makes the next launch start in Safe Mode regardless).
      if (!e2eEnabled && !relaunchApp(PATHS.RESOURCES_FOLDER, process.pid)) log(strings.log.relaunchFailed);
      Utils.quit();
    },
    toggleFullScreen: () => {
      const current = mainWindow.window;
      if (current) current.setFullScreen(!current.isFullScreen());
    },
    // M-2 (R-M3-T19-FIX-1): the UI flushes pending edits before the window closes. `uiFlush` is declared below and read
    // only when this runs, after startup.
    // biome-ignore lint/suspicious/noThenProperty: afterUiFlush's deps object is never awaited or returned (R-M3-T19-FIX-1 names it `then`)
    closeWindow: () => void afterUiFlush({ uiFlush, then: () => mainWindow.close() })(),
    openSettings: () => void settingsWindow.open(),
  };
  const appHandlers = createAppHandlers(appHandlerDeps);

  // X1: before the quit flush, the UI flushes its pending view-state saves and buffer edits.
  const uiFlush = createUiFlushWaiter({
    send: () => rpc.send["app.flushState"]({}),
    isOpen: () => mainWindow.isOpen(),
  });
  // M4 §5.12 (Task 9a): the Main-side half of the web runner's UI-relayed bridge. Registered only when a webview
  // source exists, which is whenever a `webviewBridge` was passed above -- i.e. always, in a real app. Without
  // this group the UI's `webRunner.ready` / `.exit` / `.message` reach no handler at all, and a browser tab's run
  // hangs until `waitForReady` gives up rather than failing with anything a user could act on.
  const webRunnerHandlers = services.webviews ? [createWebRunnerHandlers({ webviews: services.webviews, log })] : [];
  const rpc = BrowserView.defineRPC<JSLabRPC>({
    maxRequestTime: 10_000,
    handlers: mergeHandlers(
      createRpcHandlers({
        coordinator,
        settings,
        session,
        safeMode,
        keybindings,
        versions: { app: APP_VERSION, bun: Bun.version },
        log,
        e2e: e2eEnabled,
        onE2EResponse: (response) => e2eBridge.receive(response),
        // The as-built body, unchanged: shouldReloadView (src/main/ui-watchdog.ts) leaves its 30 s boot grace only
        // once sawFirstHeartbeat is true. Dropping that line would reload the view every 30 s (review I1).
        onUiHeartbeat: () => {
          sawFirstHeartbeat = true;
          lastUiHeartbeat = Date.now();
        },
        // The stores report what their own load found, including the corrupt copy saved this launch (FA-m4).
        notices: startupNotices({ settings, session }),
      }),
      createWorkspaceHandlers({ session, coordinator, spares, log }),
      ...webRunnerHandlers,
      createSettingsHandlers({ settings, e2e: e2eEnabled, log }),
      createNpmHandlers({ npm, log }),
      createEnvHandlers({ env, log }),
      createTypesHandlers({ types, log }),
      createWorkingDirectoryHandlers({
        session,
        documentsDir: Utils.paths.documents,
        pickFolder: async ({ startingFolder }) =>
          e2eEnabled
            ? ((await readE2EOpenDialog(paths.dataDir))[0] ?? null)
            : ((
                await Utils.openFileDialog({
                  startingFolder,
                  allowedFileTypes: "*",
                  canChooseFiles: false,
                  canChooseDirectory: true,
                  allowsMultipleSelection: false,
                })
              )[0] ?? null),
        isDirectory: (path) =>
          stat(path).then(
            (info) => info.isDirectory(),
            () => false,
          ),
        spares,
        types,
        send: { changed: (payload) => rpc.send["wd.changed"](payload) },
        log,
      }),
      appHandlers,
      createUiFlushHandlers(uiFlush, log),
      // Task 12/13 (spec §5.12), fix round 1: `browser-node`'s fetch proxy is no longer an RPC handler group here.
      // It used to take a page-supplied `tabId` in a flat payload, authorized by looking the tab's runtime up by
      // that same id -- once registered, a `browser` tab could name a `browser-node` tab's id and get a CORS-free
      // request issued on the user's session. It's now constructed per `WebRunSession`
      // (`runtimes/web-adapter.ts`), which already knows its own tab and runtime from the `WebviewHost` the
      // connection arrived on, never from anything the message claims -- see `rpc/web-fetch-handlers.ts`'s doc
      // comment and `main-services.ts`'s `webAdapterDeps` for the wiring.
      createFileHandlers({
        files: new FileService(nodeFileSystem),
        session,
        documentsDir: Utils.paths.documents,
        openDialog: ({ startingFolder }) =>
          e2eEnabled
            ? readE2EOpenDialog(paths.dataDir)
            : Utils.openFileDialog({
                startingFolder,
                allowedFileTypes: OPEN_EXTENSIONS.join(","),
                canChooseFiles: true,
                canChooseDirectory: false,
                allowsMultipleSelection: true,
              }),
        saveDialog: (options) => (e2eEnabled ? readE2ESaveDialog(paths.dataDir) : saveDialog(options)),
        revealInFinder: (path) =>
          e2eEnabled
            ? appendFileSync(join(paths.dataDir, "e2e-opened.txt"), `${path}\n`)
            : Utils.showItemInFolder(path),
        clipboard: writeClipboard,
        send: {
          opened: (payload) => rpc.send["file.opened"](payload),
          saved: (payload) => rpc.send["file.saved"](payload),
          saveAsConfirm: (payload) => rpc.send["file.saveAsConfirm"](payload),
          saveCancelled: (payload) => rpc.send["file.saveCancelled"](payload),
          saveFailed: (payload) => rpc.send["file.saveFailed"](payload),
        },
        log,
      }),
    ),
  });

  settings.onChange((next) => rpc.send["settings.changed"]({ settings: next }));

  const url = await resolveMainViewUrl({
    channel: await Updater.localInfo.channel(),
    env: process.env,
    probe: (target, signal) => fetch(target, { method: "HEAD", signal }),
  });
  const displays = (): DisplayInfo[] => Screen.getAllDisplays();
  // A blocked web or mail link opens in the default browser; E2E runs record it instead (never the user's browser).
  const openExternal = (link: string) =>
    e2eEnabled ? appendFileSync(join(paths.dataDir, "e2e-external.txt"), `${link}\n`) : Utils.openExternal(link);
  const createWindow = () => {
    // Spec §10.1: back on its display if that display still exists, otherwise centered on the primary display.
    const restored = restoreFrame(session.session.window, displays());
    const created = new BrowserWindow({
      title: "JSLab",
      url,
      frame: restored.frame,
      titleBarStyle: "hiddenInset",
      rpc,
    });
    // Spec §18, as built by the M1 fix wave (navigation.ts): the RPC-bridged view never navigates away from views://
    // (a dropped URL or a clicked link would replace the UI). Applied to every created window, including a Dock reopen.
    created.webview.setNavigationRules(navigationRulesFor(url));
    created.webview.on("will-navigate", (event: unknown) => {
      const link = externalLinkFrom((event as { data?: { detail?: unknown } }).data?.detail);
      if (link) openExternal(link);
    });
    if (restored.fullscreen) created.setFullScreen(true);
    // Full screen keeps the windowed frame; the first toggle with none saved keeps the current one (FA-m6).
    const saveFrame = () =>
      session.setWindow(
        frameToSave({
          fullScreen: created.isFullScreen(),
          frame: created.getFrame(),
          previous: session.session.window,
          displays: displays(),
        }),
      );
    created.on("resize", saveFrame);
    created.on("move", saveFrame);
    // Every new window (a Dock reopen included) is a fresh boot with the watchdog's 30 s grace (R-M2-T18-3).
    ({ sawFirstHeartbeat, bootWindowStartedAt, lastUiHeartbeat } = onReload(Date.now()));
    return created;
  };
  const mainWindow = createMainWindowController({
    create: createWindow,
    onClosed: () => {
      e2eBridge.rejectAll("The JSLab window closed");
      // M4 final review (C): this window's UI owned every `<electrobun-webview>` Main was driving. Reopening from
      // the Dock builds a fresh view with an empty registry, so Main's own entries must go with the old one --
      // otherwise the next run on every browser tab hits a stale entry, skips `webRunner.ensure`, and fails after
      // 2 s with "never reported ready".
      services.webviews?.invalidateAll();
    },
  });
  mainWindow.open();
  Electrobun.events.on("reopen", () => {
    mainWindow.open();
  });
  // Spec §20 (FA-I3): after startup, an unexpected Main error shows a non-blocking notice in the main window.
  showUnexpectedErrorNotice = () => {
    if (mainWindow.isOpen())
      rpc.send["app.notice"]({ id: "unexpectedError", message: strings.notices.unexpectedError });
  };
  // D1: the same channel, for a notice raised by the composition root (a settings write refused as too large).
  // The UI's `addNotice` shows one banner per id, and main-services raises this once per session anyway.
  sendAppNotice = (notice) => {
    // Reporting delivery, not attempting it: main-services spends its one telling only on a notice that landed.
    if (!mainWindow.isOpen()) return false;
    rpc.send["app.notice"](notice);
    return true;
  };

  // `MenuItem` (menu.ts) is the devkit's own `ApplicationMenuItemConfig` shape at its source (final review T14),
  // proved at compile time by `MENU_IS_DEVKIT_CONFIG`, so a built menu is passed straight to
  // `ApplicationMenu.setApplicationMenu` with no adapter.
  const resolvedBindings = resolveKeybindings(DEFAULT_KEYBINDINGS, keybindings.rules);
  const menu = createMenuController({
    build: () =>
      buildMenu({
        settings: settings.current,
        activeTab: session.session.tabs[session.session.activeTabId] ?? null,
        bindings: resolvedBindings,
        themes: listThemes(),
        canReopen: session.session.closedStack.length > 0,
      }),
    apply: (items) => ApplicationMenu.setApplicationMenu(items),
  });
  menu.refresh();
  settings.onChange(() => menu.refresh());
  session.onChange(() => menu.refresh());
  ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
    const action = (event as { data?: { action?: string } }).data?.action;
    dispatchMenuAction(action, {
      isOpen: () => mainWindow.isOpen(),
      open: () => void mainWindow.open(),
      // `settingsWindow` is declared below; this handler only runs after startup.
      openSettings: () => void settingsWindow.open(),
      send: (c) => rpc.send["menu.command"](c),
    });
  });

  // The Settings window (spec §7.5): its own narrower RPC, the same settings/app handlers, and its own E2E bridge.
  // The bridge sends through `settingsRpc`, defined next; send runs only after startup.
  const settingsE2E = new E2EBridge((request) => settingsRpc.send["e2e.request"](request));
  const settingsRpc = BrowserView.defineRPC<SettingsRPC>({
    maxRequestTime: 60_000,
    handlers: mergeHandlers(
      createSettingsHandlers({ settings, e2e: e2eEnabled, log }),
      createFontHandlers({ fonts: systemFonts, log }),
      createNpmrcHandlers({ path: paths.packagesNpmrc, onSaved: () => npm.resetOutdated(), log }),
      createSettingsAppHandlers(appHandlerDeps),
      createE2EResponseHandler(settingsE2E, log),
    ),
  });
  const settingsUrl = url.startsWith("views://") ? "views://mainview/settings.html" : `${url}/settings.html`;
  const settingsWindow = createMainWindowController({
    create: () => {
      // The same display-aware restore as the main window (Task 18, spec §10.1).
      const restored = restoreFrame(
        session.session.settingsWindow ?? { x: 220, y: 140, width: 760, height: 560 },
        displays(),
      );
      const created = new BrowserWindow({
        title: strings.window.settingsTitle,
        url: settingsUrl,
        frame: restored.frame,
        // The nav column has a 40px top pad and is the drag region, which is built for the inset title bar (review M13).
        titleBarStyle: "hiddenInset",
        rpc: settingsRpc,
      });
      // Spec §18 (final review M3): the Settings window is RPC-bridged too, so it gets the same rules as createWindow.
      // navigationRulesFor(url) allows views:// (which serves settings.html) and, in dev, the dev server.
      created.webview.setNavigationRules(navigationRulesFor(url));
      created.webview.on("will-navigate", (event: unknown) => {
        const link = externalLinkFrom((event as { data?: { detail?: unknown } }).data?.detail);
        if (link) openExternal(link);
      });
      const saveFrame = () => {
        const frame = created.getFrame();
        const display = displayForFrame(frame, displays());
        session.setSettingsWindow({ ...frame, ...(display ? { displayId: String(display.id) } : {}) });
      };
      created.on("resize", saveFrame);
      created.on("move", saveFrame);
      return created;
    },
    onClosed: () => settingsE2E.rejectAll("The Settings window closed"),
  });
  settings.onChange((next) => {
    if (settingsWindow.isOpen()) settingsRpc.send["settings.changed"]({ settings: next });
  });

  if (e2eEnabled) {
    socketServer = await startSocketServer({
      path: paths.socketPath,
      log,
      methods: createSocketMethods({
        e2eEnabled,
        bridge: e2eBridge,
        settingsBridge: settingsE2E,
        mainState: () => ({
          safeMode,
          dataDir: paths.dataDir,
          windowOpen: mainWindow.isOpen(),
          pid: process.pid,
          windowFrame: mainWindow.window?.getFrame() ?? null,
          primaryWorkArea: Screen.getPrimaryDisplay().workArea,
          menu: menu.current(),
          settingsWindowOpen: settingsWindow.isOpen(),
        }),
        uiAvailable: (window = "main") => (window === "main" ? mainWindow.isOpen() : settingsWindow.isOpen()),
        reopenWindow: () => void mainWindow.open(),
        screenshot: async (name, window) => {
          await mkdir(paths.screenshotsDir, { recursive: true });
          const out = join(paths.screenshotsDir, `${name}.png`);
          const target = window === "main" ? mainWindow.window : settingsWindow.window;
          const result = await captureWindow(windowNumberOf(target?.ptr ?? null), out, () =>
            Utils.screenCapture.hasAccess(),
          );
          if ("skipped" in result) log(`Screenshot ${name} skipped: ${result.skipped}`);
          return result;
        },
        quit: () => Utils.quit(),
      }),
    });
    logger.info(strings.log.e2eEnabled(socketServer.path));
  }

  // Warm the first runner so the first run is fast (spec §5.3).
  spares.setActiveTab(session.session.activeTabId);

  // WKWebView can freeze after sleep (Electrobun #550): reload the view if UI heartbeats stop (spec §4.6),
  // giving the first heartbeat a longer boot grace period so a slow-but-healthy cold start isn't reloaded
  // forever (I1).
  setInterval(() => {
    const now = Date.now();
    // Final review M11: no reload while the window is closed (the M1 loop kept calling loadURL on a closed window).
    const current = mainWindow.window;
    if (!current) return;
    if (!shouldReloadView({ now, startedAt: bootWindowStartedAt, lastHeartbeat: lastUiHeartbeat, sawFirstHeartbeat })) {
      return;
    }
    log("UI heartbeat missed; reloading the view");
    // A reload is a fresh boot (R-M2-T18-3): the reloaded view gets the 30 s boot grace until its own first
    // heartbeat, instead of the 6 s steady-state deadline left over from the view it replaces.
    ({ sawFirstHeartbeat, bootWindowStartedAt, lastUiHeartbeat } = onReload(now));
    // M4 final review (C): the reloaded view starts with an empty webview registry, so Main's entries for the view
    // being replaced are stale the instant this navigates. Dropping them here is what makes the next run create a
    // new element instead of driving one nobody owns any more. This reload is the likeliest trigger of all: it
    // exists because WKWebView freezes after sleep, i.e. exactly when the user wakes the laptop and hits Run.
    services.webviews?.invalidateAll();
    current.webview.loadURL(url);
  }, 2000);

  let quitting = false;
  Electrobun.events.on("before-quit", (event: { response?: unknown }) => {
    if (quitting) return;
    // before-quit does not await promises: cancel, flush state, then quit for real.
    event.response = { allow: false };
    quitting = true;
    e2eBridge.rejectAll("JSLab is quitting");
    settingsE2E.rejectAll("JSLab is quitting");
    socketServer?.close();
    menu.dispose();
    coordinator.dispose();
    transform.dispose();
    runLock.releaseAll();
    // Final review T14: a hung flush must not keep JSLab from quitting. FA-I1: settings writes are awaited too.
    // A quit started by a startup failure keeps its exit code 1 (FA-I3).
    void flushBeforeQuit(
      // biome-ignore lint/suspicious/noThenProperty: afterUiFlush's deps object is never awaited or returned (R-M3-T19-FIX-1 names it `then`)
      () => afterUiFlush({ uiFlush, then: () => Promise.all([session.flush(), settings.flush()]) })(),
      log,
    ).finally(() => Utils.quit(errorPolicy.exitCode));
  });
}

void start().then(
  () => errorPolicy.markStarted(),
  (error: unknown) => errorPolicy.fail(error),
);
