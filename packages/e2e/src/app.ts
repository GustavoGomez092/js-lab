import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JSLabClient } from "./client";
import { activeTab, type E2EState, newActiveTabId, type OutputEntry } from "./helpers";
import { isAlive, processCommand, processTree } from "./process";
import { waitFor } from "./wait";

/**
 * Launches a built JSLab with JSLAB_E2E=1 and a private data folder, then drives it over jslab.sock.
 * Knobs: JSLAB_E2E_APP, JSLAB_E2E_TMPDIR, JSLAB_E2E_KEEP=1, JSLAB_E2E_SKIP_SCREENSHOTS=1 (see the M2 plan, Task 2).
 */
export type Channel = "dev" | "canary";

export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export interface LaunchOptions {
  channel?: Channel;
  /** Reuse an existing data folder (for relaunch scenarios). */
  userData?: string;
  /** Written to settings.json before launch. */
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  readyTimeoutMs?: number;
}

export interface LaunchedApp {
  client: JSLabClient;
  userData: string;
  appPath: string;
  state(): Promise<E2EState>;
  output(): Promise<OutputEntry[]>;
  type(text: string, replace?: boolean): Promise<void>;
  key(spec: string): Promise<void>;
  command(id: string, args?: unknown): Promise<void>;
  /** Runs `tab.new` and resolves with the new tab's id once it is the active tab. */
  newTab(timeoutMs?: number): Promise<string>;
  screenshot(name: string): Promise<string | null>;
  waitForRunState(states: string[], timeoutMs?: number): Promise<string>;
  waitForOutput(predicate: (entries: OutputEntry[]) => boolean, timeoutMs?: number): Promise<OutputEntry[]>;
  /** Tracked PIDs that are still alive: the spawned launcher, its descendants and the verified Main PID. */
  pids(): number[];
  alive(): boolean;
  waitForExit(timeoutMs?: number): Promise<void>;
  quit(): Promise<void>;
  forceKill(): Promise<void>;
  relaunch(options?: Omit<LaunchOptions, "userData">): Promise<LaunchedApp>;
  /** Reopens a closed main window (a Dock click) and waits until its UI is ready again. */
  reopenWindow(): Promise<void>;
  dispose(): Promise<void>;
}

export function findAppBundle(
  channel: Channel,
  env: Record<string, string | undefined> = process.env,
  repoRoot = REPO_ROOT,
): string {
  if (env.JSLAB_E2E_APP) return env.JSLAB_E2E_APP;
  const buildDir = join(repoRoot, "apps/desktop/build", `${channel}-macos-arm64`);
  const apps = existsSync(buildDir) ? readdirSync(buildDir).filter((name) => name.endsWith(".app")) : [];
  const [only] = apps;
  if (apps.length !== 1 || !only) {
    const script = channel === "dev" ? "build:dev" : "build";
    throw new Error(
      `Expected one .app in ${buildDir}, found ${apps.length}. Build it first: cd apps/desktop && hutch run ${script}`,
    );
  }
  return join(buildDir, only);
}

export function launcherPath(appPath: string): string {
  const launcher = join(appPath, "Contents", "MacOS", "launcher");
  if (!existsSync(launcher)) throw new Error(`No launcher at ${launcher}`);
  return launcher;
}

export function createUserData(): Promise<string> {
  return mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), "jl-"));
}

export async function launchApp(options: LaunchOptions = {}): Promise<LaunchedApp> {
  const appPath = findAppBundle(options.channel ?? "dev");
  const userData = options.userData ?? (await createUserData());
  if (options.settings) await writeFile(join(userData, "settings.json"), JSON.stringify(options.settings));
  const socketPath = join(userData, "jslab.sock");
  if (Buffer.byteLength(socketPath) > 103)
    throw new Error(`Socket path too long; set a shorter JSLAB_E2E_TMPDIR: ${socketPath}`);

  const proc = Bun.spawn([launcherPath(appPath)], {
    // R-M1-14: the launched app must not inherit a cwd on an external volume (this worktree may be on one), or Bun
    // blocks at startup on a hidden removable-volume consent prompt. The data folder is on internal disk.
    cwd: userData,
    env: {
      ...process.env,
      ...options.env,
      JSLAB_E2E: "1",
      JSLAB_USER_DATA: userData,
      ELECTROBUN_INSTALLER_UI_AUTOCLOSE: "1",
    },
    stdout: Bun.file(join(userData, "app.log")),
    stderr: Bun.file(join(userData, "app.err.log")),
  });

  // Only this launch's processes are ever tracked or signalled (R-M1-8). Descendants are collected on every
  // check while their parents are alive, so a launcher that exits early has already recorded its children.
  const tracked = new Set<number>([proc.pid]);
  const track = () => {
    for (const pid of [...tracked])
      if (isAlive(pid)) for (const descendant of processTree(pid)) tracked.add(descendant);
  };
  const livePids = () => {
    track();
    return [...tracked].filter(isAlive);
  };

  const readyTimeoutMs = options.readyTimeoutMs ?? 45_000;
  const client = await waitFor(
    async () => {
      track();
      return existsSync(socketPath) ? await JSLabClient.connect(socketPath) : null;
    },
    { timeoutMs: readyTimeoutMs, message: `jslab.sock did not appear in ${userData}` },
  );

  const app: LaunchedApp = {
    client,
    userData,
    appPath,
    state: () => client.call<E2EState>("e2e.state"),
    output: async () => (await client.call<{ result: { entries: OutputEntry[] } }>("e2e.output")).result.entries,
    type: async (text, replace = true) => {
      await client.call("e2e.type", { text, replace });
    },
    key: async (spec) => {
      await client.call("e2e.key", { key: spec });
    },
    command: async (id, args) => {
      await client.call("e2e.command", args === undefined ? { id } : { id, args });
    },
    newTab: async (timeoutMs = 15_000) => {
      const before = (await app.state()).ui.tabOrder;
      await app.command("tab.new");
      return waitFor(async () => newActiveTabId(before, await app.state()), {
        timeoutMs,
        message: "tab.new never produced a new active tab",
      });
    },
    screenshot: async (name) => {
      if (process.env.JSLAB_E2E_SKIP_SCREENSHOTS === "1") return null;
      const reply = await client.call<{ path?: string; skipped?: string }>("e2e.screenshot", { name });
      if (reply.skipped) {
        console.warn(`[e2e] screenshot ${name} skipped: ${reply.skipped}`);
        return null;
      }
      return reply.path ?? null;
    },
    waitForRunState: (states, timeoutMs = 15_000) =>
      waitFor(
        async () => {
          const runState = activeTab(await app.state()).runState;
          return runState !== null && states.includes(runState) ? runState : null;
        },
        { timeoutMs, message: `Run state never became ${states.join(" or ")}` },
      ),
    waitForOutput: (predicate, timeoutMs = 15_000) =>
      waitFor(
        async () => {
          const entries = await app.output();
          return predicate(entries) ? entries : null;
        },
        { timeoutMs, message: "Expected output never appeared" },
      ),
    pids: () => livePids(),
    alive: () => livePids().length > 0,
    waitForExit: async (timeoutMs = 20_000) => {
      await waitFor(() => livePids().length === 0, { timeoutMs, message: "JSLab processes did not exit" });
    },
    quit: async () => {
      await client.call("e2e.quit").catch(() => {});
      client.close();
      await app.waitForExit(20_000).catch(async () => app.forceKill());
    },
    forceKill: async () => {
      client.close();
      // Deepest descendants first; each PID is one this launch spawned or the verified Main PID.
      for (const pid of livePids().reverse()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      await waitFor(() => livePids().length === 0, { timeoutMs: 10_000, message: "JSLab processes survived SIGKILL" });
    },
    relaunch: (next = {}) => launchApp({ ...next, channel: options.channel, userData }),
    reopenWindow: async () => {
      await client.call("e2e.reopen");
      await waitFor(async () => (await client.call<{ ui: { ready: boolean } | null }>("e2e.state")).ui?.ready || null, {
        timeoutMs: readyTimeoutMs,
        message: "The reopened window never became ready",
      });
    },
    dispose: async () => {
      if (app.alive()) await app.quit();
      if (process.env.JSLAB_E2E_KEEP !== "1") await rm(userData, { recursive: true, force: true });
    },
  };

  const ready = await waitFor(
    async () => {
      const state = await app.state();
      return state.ui.ready ? state : null;
    },
    { timeoutMs: readyTimeoutMs, message: "The JSLab UI never became ready" },
  );
  // Main reports its own PID. Track it only when that PID's command line is inside this app bundle, which guards
  // against a stale or reused PID. This checks one PID; it never searches processes by path.
  const mainPid = ready.main.pid;
  if (typeof mainPid === "number" && processCommand(mainPid).startsWith(appPath)) tracked.add(mainPid);
  track();
  return app;
}
