import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * The `browser` and `browser-node` runtimes, driven end to end against a dev build (spec §5.12, §5.13).
 *
 * Every scenario here turns Auto Run off and runs explicitly: a web run reloads the tab's webview and bundles the
 * tab's code with `Bun.build` before anything evaluates, so an Auto Run firing on each keystroke would overlap runs
 * and make the output non-deterministic.
 */

let app: LaunchedApp | null = null;
const servers: { stop(): void }[] = [];

afterEach(async () => {
  await app?.dispose();
  app = null;
  for (const server of servers.splice(0)) server.stop();
});

const current = () => app as LaunchedApp;

/** Replaces the editor's contents and waits until the store has them, so `run.start` never races the edit. */
async function typeCode(target: LaunchedApp, lines: string[]) {
  const code = lines.join("\n");
  await target.type(code);
  await waitFor(async () => activeTab(await target.state()).code === code || null, {
    message: "the editor never took the typed code",
  });
  return code;
}

/** Switches the active tab's runtime and waits until the tab reports it (spec §5.2). */
async function useRuntime(target: LaunchedApp, command: string, runtime: string) {
  await target.command(command);
  await waitFor(async () => activeTab(await target.state()).runtime === runtime || null, {
    message: `the tab never switched to ${runtime}`,
  });
}

const consoleText = (entries: { kind: string; text: string }[]) =>
  entries.filter((entry) => entry.kind === "console").map((entry) => entry.text);

/** Waits for a console line starting with `prefix` and returns it. */
async function waitForConsole(target: LaunchedApp, prefix: string, timeoutMs = 90_000) {
  const entries = await target.waitForOutput(
    (all) => consoleText(all).some((text) => text.startsWith(prefix)),
    timeoutMs,
  );
  return consoleText(entries).find((text) => text.startsWith(prefix)) as string;
}

describe("browser runtimes (spec §5.12, §5.13)", () => {
  test("a browser tab runs in its webview: it writes the DOM, queries it back, and logs an element (WV-02, WV-03)", async () => {
    app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    await useRuntime(current(), "runtime.browser", "browser");
    await typeCode(current(), [
      'document.title = "jslab-web";',
      'const el = document.createElement("div");',
      'el.id = "probe";',
      'el.setAttribute("data-kind", "encoded");',
      'el.textContent = "hi";',
      "document.body.appendChild(el);",
      'console.log("dom:" + document.title + ":" + document.querySelectorAll("#probe").length + ":" + el.outerHTML);',
      // The encoded-element entry itself (spec §5.9): asserted below as its own output entry.
      "console.log(el);",
      "1 + 1;",
    ]);
    await current().command("run.start");

    const line = await waitForConsole(current(), "dom:");
    // The page really has a document: the title took, the node is findable through a selector, and its own
    // serialization comes back with the attributes that were set on it.
    expect(line).toBe('dom:jslab-web:1:<div id="probe" data-kind="encoded">hi</div>');

    // A run that reaches its last expression also reports a result, so this proves the whole run completed rather
    // than stalling after the first console write (the Task 9b failure mode).
    const entries = await current().waitForOutput(
      (all) => all.some((entry) => entry.kind === "result" && entry.text === "2"),
      60_000,
    );
    // Two console writes reached the output: the string line above, and the element itself.
    expect(consoleText(entries)).toHaveLength(2);
    // `idle`, not "idle or settled". This code creates no timer, frame, socket, request, AudioContext or media
    // element, so the only correct terminal state is `idle` with zero handles -- and accepting `settled` here was
    // what let a browser run that finished holding a phantom handle pass the suite (the status bar reads a
    // `settled` run as "Running: N active handles", since `settled` is in `BUSY_STATES`).
    await current().waitForRunState(["idle"], 30_000);
    expect(activeTab(await current().state()).activeHandles).toBe(0);
    await current().screenshot("web-runtime-browser");
  });

  test("a browser-node tab resolves the bridged Node modules and refuses fs.readFileSync in the spec's words (§5.13)", async () => {
    const userData = await createUserData();
    const wd = join(userData, "project");
    await mkdir(wd, { recursive: true });
    await writeFile(join(wd, "notes.txt"), "from-the-working-directory\n");
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });

    await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([wd]));
    await current().command("wd.set");
    await waitFor(async () => activeTab(await current().state()).workingDirectory === wd || null, {
      message: "the working directory was never set",
    });
    await useRuntime(current(), "runtime.browserNode", "browser-node");

    await typeCode(current(), [
      'import { readFile } from "fs/promises";',
      'import { readFileSync } from "fs";',
      'import { exec } from "child_process";',
      // Importing the bridged modules resolves to the real Node table, not to an empty stub.
      'console.log("imports:" + typeof readFile + "," + typeof readFileSync + "," + typeof exec);',
      "try {",
      '  readFileSync("notes.txt", "utf8");',
      '  console.log("sync:no-refusal");',
      "} catch (error) {",
      '  console.log("sync:" + error.name + ": " + error.message);',
      "}",
    ]);
    await current().command("run.start");

    expect(await waitForConsole(current(), "imports:")).toBe("imports:function,function,function");
    // The spec's refusal, quoted in full: it names the method, names the async alternative, and points at Bun.
    // This path needs no bridge at all -- the generated module throws locally.
    expect(await waitForConsole(current(), "sync:")).toBe(
      'sync:JSLabUnsupportedError: fs.readFileSync isn\'t available in "Browser & Node APIs". ' +
        "Use fs/promises or switch this tab to the Bun runtime.",
    );
  });

  /**
   * This scenario found a real defect, and it is the reason `host-bridge.ts` gained its five `node*` cases.
   *
   * Before that fix, no bridged Node call ever completed: Main really received the call and really ran it (its own
   * log said so), but the page's inbound validator did not recognise `nodeResult`/`nodeError`/`nodeStdout`/
   * `nodeStderr`/`nodeExit`, so every reply was discarded -- and because a rejected message must not advance the
   * sequence counter, the promise never settled and the connection was left wedged. `fetch` was unaffected only
   * because its four variants were already listed. Both calls below now answer in well under a second.
   */
  test("a browser-node tab reads a file in its working directory with fs/promises and runs a command (§5.13)", async () => {
    const userData = await createUserData();
    const wd = join(userData, "project");
    await mkdir(wd, { recursive: true });
    await writeFile(join(wd, "notes.txt"), "from-the-working-directory\n");
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });

    await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([wd]));
    await current().command("wd.set");
    await waitFor(async () => activeTab(await current().state()).workingDirectory === wd || null, {
      message: "the working directory was never set",
    });
    await useRuntime(current(), "runtime.browserNode", "browser-node");

    await typeCode(current(), [
      'import { readFile } from "fs/promises";',
      'import { exec } from "child_process";',
      // A relative path resolves against the tab's working directory, exactly as it does under Bun.
      'const text = await readFile("notes.txt", "utf8");',
      'console.log("read:" + text.trim());',
      'exec("echo bridged", (error, stdout) => console.log("exec:" + String(stdout).trim()));',
    ]);
    await current().command("run.start");

    expect(await waitForConsole(current(), "read:")).toBe("read:from-the-working-directory");
    // The async bridge carries a real child process's stdout back into the page.
    expect(await waitForConsole(current(), "exec:")).toBe("exec:bridged");
  });

  test("browser-node fetch reaches a loopback server that the same code in a browser tab cannot (§5.12)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("pong") });
    servers.push({ stop: () => void server.stop(true) });
    app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });

    const code = [
      `const url = "http://127.0.0.1:${server.port}/ping";`,
      "try {",
      "  const response = await fetch(url);",
      '  console.log("fetched:" + (await response.text()));',
      "} catch (error) {",
      '  console.log("blocked:" + error.name);',
      "}",
    ];

    // `browser-node` routes fetch through Main, so there is no origin to enforce and the body comes back.
    await useRuntime(current(), "runtime.browserNode", "browser-node");
    await typeCode(current(), code);
    await current().command("run.start");
    expect(await waitForConsole(current(), "fetched:")).toBe("fetched:pong");

    // The same tab, the same code, switched to `browser`: the page's own fetch is used, and a cross-origin request
    // without CORS headers is refused -- which is the entire point of that runtime.
    await current().command("output.clear");
    await useRuntime(current(), "runtime.browser", "browser");
    await current().command("run.start");
    const blocked = await waitForConsole(current(), "blocked:");
    expect(blocked).toStartWith("blocked:");
    expect(consoleText(await current().output())).not.toContain("fetched:pong");
  });

  test("Stop cancels a requestAnimationFrame loop, and Kill lets the tab run again on a fresh webview (§5.8)", async () => {
    app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    await useRuntime(current(), "runtime.browser", "browser");
    await typeCode(current(), [
      "let frames = 0;",
      "function tick() {",
      "  frames += 1;",
      '  if (frames % 20 === 0) console.log("frames:" + frames);',
      "  requestAnimationFrame(tick);",
      "}",
      "requestAnimationFrame(tick);",
    ]);
    await current().command("run.start");

    // A live rAF loop keeps the run active and registers a handle (spec §5.6).
    await waitForConsole(current(), "frames:");
    const running = await waitFor(
      async () => {
        const tab = activeTab(await current().state());
        return tab.activeHandles > 0 ? tab : null;
      },
      { timeoutMs: 30_000, message: "the rAF loop never registered a handle" },
    );
    expect(running.activeHandles).toBeGreaterThan(0);

    await current().command("run.stop");
    await current().waitForRunState(["stopped", "killed"], 30_000);
    // Stop actually cancelled the loop: the output stops growing rather than merely being marked stopped.
    const settled = (await current().output()).length;
    await Bun.sleep(1500);
    expect((await current().output()).length).toBe(settled);

    // Kill destroys the webview; the next run has to bring a new one up before it can produce anything at all.
    // Clear first: without it the wait below would match the stopped run's leftover lines and return before this
    // run had even attached a handle -- and a Kill that arrives then is a no-op, leaving the run mid-flight.
    await current().command("output.clear");
    await current().command("run.start");
    await waitForConsole(current(), "frames:");
    await waitFor(async () => (activeTab(await current().state()).activeHandles > 0 ? true : null), {
      timeoutMs: 30_000,
      message: "the restarted rAF loop never registered a handle",
    });
    await current().command("run.kill");
    await current().waitForRunState(["killed", "stopped"], 30_000);

    await current().command("output.clear");
    await typeCode(current(), ['console.log("after-kill:" + typeof document.body);']);
    await current().command("run.start");
    expect(await waitForConsole(current(), "after-kill:")).toBe("after-kill:object");
  });

  /**
   * The coverage gap this suite shipped with (user report, M4): a `browser` tab running trivial TypeScript -- no
   * async, no timer, no frame, no socket, no request, no audio -- left the status bar reading
   * "Running: 1 active handle" indefinitely.
   *
   * Nothing here asserted that case. The `browser` scenario above accepted `["idle", "settled"]` -- *either* -- and
   * the rAF scenario below only ever asserts `activeHandles > 0`, which is the opposite direction. So a run that
   * finished holding a phantom handle satisfied every assertion in the file, even though `settled` is in
   * `apps/ui/src/shell/labels.ts`'s `BUSY_STATES` and therefore presents to the user as a run that never stopped.
   *
   * This pins the only correct outcome for code that allocates nothing: `idle`, with zero handles.
   */
  test("a trivial TypeScript browser run finishes idle holding no handles (user report)", async () => {
    app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    await useRuntime(current(), "runtime.browser", "browser");
    await current().command("language.typescript");
    await typeCode(current(), ['const test: string = "test";', 'console.log("trivial:" + test);']);
    await current().command("run.start");

    // Proves the run really evaluated, so the state assertions below are about a completed run rather than one
    // that never started.
    expect(await waitForConsole(current(), "trivial:")).toBe("trivial:test");

    await current().waitForRunState(["idle"], 30_000);
    expect(activeTab(await current().state()).activeHandles).toBe(0);
  });
});
