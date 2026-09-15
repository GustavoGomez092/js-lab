import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { activeTab, isAlive, type LaunchedApp, launchApp, waitFor } from "../src";

// Loop protection off, so `while (true) {}` really hangs (M1 QA Q11/Q12).
const NO_LOOP_GUARD = { version: 1, run: { loopProtection: false } };

let apps: LaunchedApp[] = [];
async function launch(...args: Parameters<typeof launchApp>) {
  const app = await launchApp(...args);
  apps.push(app);
  return app;
}
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

describe("M1 core", () => {
  test("typing shows results next to their lines (EX-01, OU-08)", async () => {
    const app = await launch();
    expect(activeTab(await app.state()).runState).toBeNull();
    await app.type("1 + 1");
    const entries = await app.waitForOutput((all) => all.some((e) => e.kind === "result" && e.text === "2"));
    expect(entries).toContainEqual({ kind: "result", line: 1, text: "2" });
    const shot = await app.screenshot("core-typing-result");
    if (shot) expect(existsSync(shot) && statSync(shot).size > 0).toBe(true);
  });

  test("console output and runtime errors carry their source lines (OU-01, OU-14)", async () => {
    const app = await launch();
    await app.type('console.log("hi")\nJSON.parse("{")');
    const entries = await app.waitForOutput((all) => all.some((e) => e.kind === "error"));
    expect(entries).toContainEqual({ kind: "console", level: "log", line: 1, text: "hi" });
    const error = entries.find((e) => e.kind === "error");
    expect(error?.line).toBe(2);
    expect(error?.text).toContain("SyntaxError");
  });

  test("Stop ends async work with no output afterwards, and Kill recovers a hung run and its children (EX-03, EX-04, EX-05)", async () => {
    const app = await launch({ settings: NO_LOOP_GUARD });
    // Final review I1: the interval is created after an await, so Stop arrives before any handle is tracked.
    await app.type("await Bun.sleep(400)\nsetInterval(() => console.log(Date.now()), 50)");
    await app.waitForRunState(["evaluating"]);
    await app.command("run.stop");
    expect(await app.waitForRunState(["stopped"])).toBe("stopped");
    const afterStop = activeTab(await app.state()).entryCount;
    // The resumed code would log from about 400 ms after the run started, every 50 ms, so this window is what the
    // negative check is about. FA-m10 sentinel: a status bar toggle is answered by Main on the same channel as run
    // events, so once it has applied, every event Main sent during the window has reached the UI too.
    await Bun.sleep(1000);
    await app.command("view.toggleStatusBar");
    await waitFor(async () => ((await app.state()).ui.regions as Record<string, boolean>).statusBar === false || null, {
      message: "the status bar sentinel never applied",
    });
    expect(activeTab(await app.state()).entryCount).toBe(afterStop);

    // Final review I3: a child process spawned by user code dies with its runner.
    await app.type(
      'import { spawn } from "node:child_process"\nconst child = spawn("sleep", ["30"])\nconsole.log("child", child.pid)\nsetTimeout(() => { while (true) {} }, 300)',
    );
    const spawned = await app.waitForOutput((all) => all.some((e) => e.text.startsWith("child ")));
    const childPid = Number(spawned.find((e) => e.text.startsWith("child "))?.text.split(" ")[1]);
    expect(Number.isInteger(childPid) && isAlive(childPid)).toBe(true);
    await app.waitForRunState(["unresponsive"], 20_000);
    await app.command("run.kill");
    expect(await app.waitForRunState(["killed"])).toBe("killed");
    await waitFor(() => !isAlive(childPid) || null, { timeoutMs: 5_000, message: `child ${childPid} survived Kill` });
    await app.type("40 + 2");
    await app.waitForOutput((all) => all.some((e) => e.text === "42"));
  });

  test("a large synchronous burst stays bounded and the app keeps answering (final review I2, spec §4.2, §5.9, §5.10)", async () => {
    const app = await launch({ settings: NO_LOOP_GUARD });
    await app.type(
      'const row = "x".repeat(10_000)\nconsole.log(Array.from({ length: 1000 }, () => row))\nfor (let i = 0; i < 20000; i++) console.log(i)',
    );
    const done = await waitFor(
      async () => {
        const tab = activeTab(await app.state());
        return tab.runState === "idle" && tab.truncated > 0 ? tab : null;
      },
      { timeoutMs: 60_000, message: "the burst never finished with a truncation notice" },
    );
    expect(done.entryCount).toBe(10_000);
    // The 10 MB array is over the per-event cap, so it arrives as a handle with a short preview.
    const [first] = await app.output();
    expect(first?.text.length ?? 0).toBeLessThan(256 * 1024);
    const started = Date.now();
    await app.state();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("a forced quit during a hang relaunches in Safe Mode without auto-running (EX-36, XT-09)", async () => {
    const first = await launch({ settings: NO_LOOP_GUARD });
    await first.type("while (true) {}");
    await first.waitForRunState(["evaluating", "unresponsive"]);
    await first.forceKill();
    expect(existsSync(`${first.userData}/run.lock`)).toBe(true);

    const second = await launch({ userData: first.userData });
    const state = await second.state();
    expect(state.ui.safeMode).toEqual({ active: true, reason: "crashLoop" });
    await second.type("1 + 1");
    // FA-m10: wait until the edit has armed auto-run (which Safe Mode must then refuse), then for the auto-run delay
    // from settings plus a margin; never less than the 1.5 s this check used before.
    const armed = await waitFor(async () => {
      const tab = activeTab(await second.state());
      return tab.code === "1 + 1" && tab.autoRunArmed ? await second.state() : null;
    });
    await Bun.sleep(Math.max(1_500, Number(armed.ui.settings?.run?.autoRunDelayMs ?? 300) + 1_200));
    expect((await second.output()).some((e) => e.kind === "result")).toBe(false);
    await second.command("run.start");
    await second.waitForOutput((all) => all.some((e) => e.kind === "result" && e.text === "2"));
  });

  test("a clean quit through the socket releases run.lock and flushes the session (M1 QA Q14, R-M1-9)", async () => {
    const app = await launch({ settings: NO_LOOP_GUARD });
    await app.type("while (true) {}");
    await app.waitForRunState(["evaluating", "unresponsive"]);
    expect(existsSync(`${app.userData}/run.lock`)).toBe(true);
    await app.quit();
    expect(existsSync(`${app.userData}/run.lock`)).toBe(false);
    expect(existsSync(`${app.userData}/session.json`)).toBe(true);
  });
});
