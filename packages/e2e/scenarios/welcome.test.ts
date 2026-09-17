import { afterEach, describe, expect, test } from "bun:test";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

type Regions = Record<string, boolean>;
const regions = async (app: LaunchedApp) => (await app.state()).ui.regions as Regions;

/**
 * Replaces the editor's contents and waits until the store has them, so nothing that follows races the edit
 * (the pattern `web-runtime.test.ts` established).
 */
async function typeCode(app: LaunchedApp, code: string) {
  await app.type(code);
  await waitFor(async () => activeTab(await app.state()).code === code || null, {
    message: `the editor never took ${JSON.stringify(code)}`,
  });
  return code;
}

/**
 * Auto Log instruments top-level *expression statements* only (`packages/transform/src/instrument.ts`: the
 * `options.autoLog` pass skips anything that is not an `ExpressionStatement`). A program of declarations alone
 * therefore logs NOTHING, and waiting on "any output at all" after typing one would simply time out. Each program
 * below ends in an expression statement, so the run announces itself with a result row whose text is the value --
 * and because the two values differ, that row also says WHICH of the two programs ran.
 */
const FIRST = "const a = 5\na * 2";
const SECOND = "const a = 6\na * 2";

describe("welcome tab and transpiled output", () => {
  test("a first launch opens one welcome tab, and a relaunch keeps what the user made of it (ST-12)", async () => {
    // The harness suppresses the welcome tab by default (R-M5a-REGRESSION-1) -- it rewrites the first tab every
    // other scenario assumes -- so the scenarios that are *about* it ask for it by name.
    const app = await launchApp({ env: { JSLAB_E2E_WELCOME: "1" } });
    apps.push(app);
    const state = await app.state();
    expect(state.ui.tabOrder).toHaveLength(1);
    const tab = activeTab(state);
    // The markers of the shipped welcome text (`apps/desktop/src/main/welcome.ts`), which an empty scratch tab --
    // what every launch before M5a produced -- has none of.
    expect(tab.language).toBe("tsx");
    expect(tab.code).toContain("Welcome to JSLab");
    expect(tab.code).toContain("//?");
    expect(tab.code).toContain("F9");
    expect(tab.code).toContain("fetch(");
    // Spec §5.14: a newly created tab is never armed for Auto Run. This launch left Auto Run ON (no settings are
    // written), so these two are load-bearing: a welcome tab that armed itself would have run its samples here.
    expect(tab.autoRunArmed).toBe(false);
    expect(tab.runState).toBeNull();

    // What the user makes of the tab is theirs. `mine` is deliberately NOT the welcome text, so a second launch
    // that re-opened the welcome tab over the top of it fails this -- the one thing R-M5a-5 exists to prevent.
    const mine = await typeCode(app, "const mine = 1");
    await app.quit();

    // Opted in again on purpose: the user's work has to survive even on a launch that would happily write the
    // sample, which is the half of R-M5a-5 that a suppressed relaunch could never prove.
    const again = await launchApp({ userData: app.userData, env: { JSLAB_E2E_WELCOME: "1" } });
    apps.push(again);
    const restored = await again.state();
    expect(restored.ui.tabOrder).toHaveLength(1);
    expect(activeTab(restored).code).toBe(mine);
  });

  test("Show Transpiled Output opens the panel, and it admits output that the code has moved on from (EX-37, R-M5a-7)", async () => {
    // Auto Run OFF. R-M5a-7 is about the window between an edit and the next run, so that window must not close
    // itself on a 300 ms timer while the scenario is looking into it.
    const app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    apps.push(app);
    await typeCode(app, FIRST);
    await app.command("run.start");
    await app.waitForOutput((all) => all.some((entry) => entry.kind === "result" && entry.text === "10"));

    // EX-37: the command really puts the panel on screen -- both the state field and the rendered region, so a bug
    // that set one without the other is caught.
    await app.command("view.showTranspiled");
    const opened = await waitFor(
      async () => {
        const state = await app.state();
        return state.ui.sideBarPanel === "transpiled" && (state.ui.regions as Regions).transpiledPanel ? state : null;
      },
      { message: "the transpiled panel never appeared" },
    );
    expect(opened.ui.sideBarPanel).toBe("transpiled");
    // Nothing has been edited since the run, so the panel must not be crying stale. (A weaker check than the two
    // below: an entry still in flight also reads as not-stale. The transition to `true` below is what proves an
    // entry was actually loaded.)
    expect((opened.ui.regions as Regions).transpiledStale).toBe(false);

    // R-M5a-7, half one: the indicator APPEARS once the buffer differs from the source Main transpiled. With no run
    // in between, the only way this can flip is the panel comparing against Main's own `source`.
    await typeCode(app, SECOND);
    await waitFor(async () => (await regions(app)).transpiledStale || null, {
      message: "the transpiled panel never admitted it was showing output for code that had changed",
    });

    // R-M5a-7, half two: it CLEARS on the next run. The "12" proves that run really evaluated SECOND (FIRST logs
    // "10"), so this is the panel refreshing onto the new transform, not the chip flickering off on its own.
    await app.command("run.start");
    await app.waitForOutput((all) => all.some((entry) => entry.kind === "result" && entry.text === "12"));
    await waitFor(async () => (await regions(app)).transpiledStale === false || null, {
      message: "the transpiled panel never refreshed after the next run",
    });

    // ...and it refreshed in place: still the transpiled panel, still on screen.
    const after = await app.state();
    expect([after.ui.sideBarPanel, (after.ui.regions as Regions).transpiledPanel]).toEqual(["transpiled", true]);
  });

  /**
   * R-M5a-REGRESSION-2, in the built app. `files.test.ts` covers TF-21 for an empty tab; this is the case the
   * welcome tab created, where the only tab is untouched but full of sample code. Closing the tab here would leave
   * a first-run user looking at an empty window, so ⌘W has to close the window exactly as it always did.
   */
  test("⌘W on the untouched welcome tab closes the window, not the tab (TF-21)", async () => {
    const app = await launchApp({ env: { JSLAB_E2E_WELCOME: "1" } });
    apps.push(app);
    expect(activeTab(await app.state()).code).toContain("Welcome to JSLab");

    await app.key("cmd+w");
    const closed = await waitFor(
      async () => {
        const raw = await app.client.call<{ ui: unknown; main: { windowOpen: boolean } }>("e2e.state");
        return raw.main.windowOpen === false && raw.ui === null ? raw : null;
      },
      { message: "⌘W never closed the window on the untouched welcome tab" },
    );
    expect(closed.main.windowOpen).toBe(false);

    // The tab is kept, not closed: reopening the window brings the same single welcome tab back.
    await app.reopenWindow();
    const reopened = await app.state();
    expect(reopened.ui.tabOrder).toHaveLength(1);
    expect(activeTab(reopened).code).toContain("Welcome to JSLab");
  });
});
