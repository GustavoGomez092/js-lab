import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, REPO_ROOT, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

const CLI = join(REPO_ROOT, "apps/desktop/dist/bin/jslab");

/**
 * `run.autoRun` defaults to **true** (`packages/shared/src/settings.ts`), which would run every tab the CLI opens the
 * moment its code lands. Spec §16.3's rule is that code runs only when `--run` is passed, so a scenario that left
 * autoRun on would see output for a tab opened without `--run` and report a broken `--run` gate that is in fact fine.
 * Every launch here pins it off, the same way `working-directory.test.ts` does, so `--run` is the only thing that runs.
 */
const NO_AUTORUN = { version: 3, run: { autoRun: false } };

const scratchDir = (prefix: string) => mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), prefix));

/** Runs the compiled binary against one launch's own socket. It never launches the user's installed JSLab. */
async function jslab(app: LaunchedApp, args: string[], stdin?: string) {
  if (!existsSync(CLI)) throw new Error(`No jslab binary at ${CLI}. Build it first: bun run build:cli`);
  const proc = Bun.spawn([CLI, ...args], {
    env: {
      ...process.env,
      JSLAB_SOCKET: join(app.userData, "jslab.sock"),
      JSLAB_CLI_NO_LAUNCH: "1",
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("the jslab CLI (XT-03)", () => {
  test("opens a file in a new tab, with the language from its extension", async () => {
    const app = await launchApp({ settings: NO_AUTORUN });
    apps.push(app);
    const dir = await scratchDir("jslab-cli-");
    const file = join(dir, "hello.tsx");
    await writeFile(file, "const greeting: string = 'hi'\n");

    const before = (await app.state()).ui.tabOrder;
    const result = await jslab(app, [file]);
    expect(result.code).toBe(0);
    // The reply's tab ids are the CLI's only stdout, so an empty line here means `open` answered without opening.
    expect(result.stdout.trim()).not.toBe("");

    const state = await waitFor(async () => {
      const next = await app.state();
      return next.ui.tabOrder.length > before.length ? next : null;
    });
    const tab = activeTab(state);
    expect(tab.filePath).toBe(file);
    expect(tab.language).toBe("tsx");
    expect(tab.code).toBe("const greeting: string = 'hi'\n");
  });

  test("reads stdin, and runs only when --run is passed (§16.3)", async () => {
    const app = await launchApp({ settings: NO_AUTORUN });
    apps.push(app);

    await jslab(app, ["-"], "console.log('quiet')\n");
    await waitFor(async () => (activeTab(await app.state()).code.includes("quiet") ? true : null));
    // The code lands in the tab the instant it opens, so checking output straight away proves nothing: a run that
    // *was* wrongly started has not emitted anything yet either. `runState` is the durable signal — it starts null
    // and `applyRunState` only ever moves it to a non-null state, never back — so a run triggered at any point
    // leaves a permanent mark. This window is far longer than the dispatch → "transpiling" round trip.
    await Bun.sleep(2000);
    const quiet = activeTab(await app.state());
    expect(quiet.runState).toBe(null);
    expect(await app.output()).toEqual([]);

    await jslab(app, ["--run", "-"], "console.log('loud')\n");
    await app.waitForOutput((entries) => entries.some((entry) => entry.text === "loud"));
  });

  test("--runtime selects any of the three runtimes, and --cwd and --title reach the tab", async () => {
    const app = await launchApp({ settings: NO_AUTORUN });
    apps.push(app);
    const dir = await scratchDir("jslab-cwd-");
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      const result = await jslab(
        app,
        ["--runtime", runtime, "--cwd", dir, "--title", `cli-${runtime}`, "-"],
        "1 + 1\n",
      );
      expect(result.code).toBe(0);
      const tab = await waitFor(async () => {
        const candidate = activeTab(await app.state());
        return candidate.title === `cli-${runtime}` ? candidate : null;
      });
      expect(tab.runtime).toBe(runtime);
      expect(tab.workingDirectory).toBe(dir);
    }
  });

  test("a second jslab for an already-open file focuses that tab instead of opening another", async () => {
    const app = await launchApp({ settings: NO_AUTORUN });
    apps.push(app);
    const dir = await scratchDir("jslab-dup-");
    const file = join(dir, "once.ts");
    await writeFile(file, "1\n");
    await jslab(app, [file]);
    const opened = await waitFor(async () => {
      const state = await app.state();
      return state.ui.tabs.some((tab) => tab.filePath === file) ? state : null;
    });
    await jslab(app, [file]);
    // A second tab, if one were opened, would be in the snapshot well within this window.
    await Bun.sleep(500);
    const after = await app.state();
    expect(after.ui.tabOrder.length).toBe(opened.ui.tabOrder.length);
    expect(after.ui.tabs.filter((tab) => tab.filePath === file).length).toBe(1);
  });

  test("a bad request is one clear error and a non-zero exit, never a partial open", async () => {
    const app = await launchApp({ settings: NO_AUTORUN });
    apps.push(app);
    const before = (await app.state()).ui.tabOrder.length;
    const missing = await jslab(app, [join(app.userData, "nope.ts")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("couldn't be read");
    expect((await app.state()).ui.tabOrder.length).toBe(before);

    const bogus = await jslab(app, ["--runtime", "deno", "-"], "1\n");
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("--runtime takes bun, browser or browser-node");
    expect((await app.state()).ui.tabOrder.length).toBe(before);
  });

  test("Help → Install jslab Command links the binary and the menu item flips to Uninstall (§16.1)", async () => {
    const app = await launchApp({ settings: NO_AUTORUN });
    apps.push(app);
    // Under JSLAB_E2E the install's "home" is this launch's data folder (index.ts:253), so nothing touches the real
    // ~/.local/bin. This scenario must never assert against a path outside `app.userData`.
    const link = join(app.userData, ".local", "bin", "jslab");
    const labels = async () => JSON.stringify((await app.state()).main.menu ?? []);

    expect(await labels()).toContain("Install jslab Command");
    await app.command("help.installCli");
    await waitFor(() => (existsSync(link) ? true : null));
    await waitFor(async () => ((await labels()).includes("Uninstall jslab Command") ? true : null));

    await app.command("help.uninstallCli");
    await waitFor(() => (existsSync(link) ? null : true));
    await waitFor(async () => ((await labels()).includes("Install jslab Command") ? true : null));
  });
});
