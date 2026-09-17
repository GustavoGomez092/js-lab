import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;

/** One rule as it is written to keybindings.json; `-command` marks a removal. */
interface Rule {
  key: string;
  command: string;
  when?: string;
}

/** The Keybindings pane's slice of the Settings window's E2E snapshot (`SettingsApp`). */
interface Pane {
  rowCount: number;
  query: string;
  status: string | null;
  capturing: string | null;
}

type PaneSettled = { ok: true; pane: Pane } | { ok: false; reason: string };

function paneOf(state: Record<string, unknown> | null): Pane | null {
  const keybindings = state?.keybindings;
  return keybindings ? (keybindings as Pane) : null;
}

/**
 * Opens Settings → Keybindings and waits for the table.
 *
 * The pane reports a load or file failure through `status` rather than by staying empty, and `waitFor` counts a
 * throwing probe as "not yet" -- so the failure is raced in the RETURN value. Watching `rowCount` alone would spend
 * the whole timeout and then blame the table for a failure that the pane had already named.
 */
async function openKeybindings(): Promise<Pane> {
  await current().key("cmd+,");
  await waitFor(async () => ((await current().settingsState())?.ready ? true : null), {
    // A freshly created window loads its bundle first: the same allowance `settings-window.test.ts` uses.
    timeoutMs: 45_000,
    message: "the Settings window never became ready",
  });
  await current().settingsCommand("settings.tab", { tab: "keybindings" });
  const seen: string[] = [];
  let settled: PaneSettled;
  try {
    settled = await waitFor<PaneSettled>(
      async () => {
        const pane = paneOf(await current().settingsState());
        seen.push(pane ? `rowCount=${pane.rowCount} status=${pane.status ?? "null"}` : "pane not mounted");
        if (!pane) return null;
        if (pane.status !== null) return { ok: false, reason: pane.status };
        return pane.rowCount > 0 ? { ok: true, pane } : null;
      },
      { message: "the keybindings table never rendered" },
    );
  } catch (error) {
    throw new Error(`${String(error)}; last observed: ${seen.slice(-3).join(" | ") || "nothing"}`);
  }
  if (!settled.ok) throw new Error(`the keybindings pane reported: ${settled.reason}`);
  return settled.pane;
}

/** Waits until keybindings.json satisfies `predicate`, and names what the file actually held if it never does. */
async function waitForRules(predicate: (rules: Rule[]) => boolean, message: string): Promise<Rule[]> {
  const path = join(current().userData, "keybindings.json");
  const seen: string[] = [];
  try {
    return await waitFor(
      async () => {
        // Before the first save the file may not exist; the read throws and counts as "not yet".
        const rules = JSON.parse(await readFile(path, "utf8")) as Rule[];
        seen.push(JSON.stringify(rules));
        return Array.isArray(rules) && predicate(rules) ? rules : null;
      },
      { message },
    );
  } catch (error) {
    throw new Error(`${String(error)}; last keybindings.json: ${seen.at(-1) ?? "unreadable"}`);
  }
}

test("the Keybindings tab lists the catalogue, and a rebind applies live before a reset restores it (XT-02, ST-01)", async () => {
  app = await launchApp();
  const table = await openKeybindings();
  // The table is the whole command catalogue rather than a curated subset (R-M5D-REGISTRY-1), so commands added by
  // other milestones appear here automatically. A floor, not an exact count: pinning the number would make this
  // scenario fail on work it does not cover.
  expect(table.rowCount).toBeGreaterThanOrEqual(100);

  await current().type("1 + 1");
  await current().waitForOutput((entries) => entries.length === 1);

  // Rebind Clear Output from ⌘K to ⇧⌘K through the capture editor, which applies the same rules a keystroke would.
  await current().settingsCommand("keybindings.capture", { command: "output.clear", key: "cmd+shift+k" });
  // R-M5d-ALIAS-1: a plain user rule does not delete a default, so capture retires the old chord with a
  // `-output.clear` removal written BEFORE the new rule -- `resolveKeybindings` applies overrides in file order,
  // and a removal placed after would delete the binding itself. One rebind therefore writes TWO entries.
  const bound = await waitForRules(
    (rules) => rules.some((rule) => rule.key === "cmd+shift+k" && rule.command === "output.clear"),
    "keybindings.json never recorded the new chord",
  );
  expect(bound).toEqual([
    { key: "cmd+k", command: "-output.clear" },
    { key: "cmd+shift+k", command: "output.clear" },
  ]);

  // The highest-value assertion here: `apps/desktop/src/main/index.ts` has no unit test, so only a real run proves
  // that `keybindings.onChange` reaches the MAIN window (`rpc.send["keybindings.changed"]`) and that the new chord
  // fires there with no relaunch (Finding K1).
  await current().key("cmd+shift+k");
  await waitFor(async () => (activeTab(await current().state()).entryCount === 0 ? true : null), {
    message: "the newly bound chord did not take effect without a relaunch",
  });

  // Reset All puts the defaults back, in the file and in the running app.
  await current().type("2 + 2");
  await current().waitForOutput((entries) => entries.length === 1);
  await current().settingsCommand("keybindings.resetAll");
  await waitForRules((rules) => rules.length === 0, "Reset All never cleared keybindings.json");
  await current().key("cmd+k");
  await waitFor(async () => (activeTab(await current().state()).entryCount === 0 ? true : null), {
    message: "the default chord did not come back after a reset",
  });
});

test("a per-row reset restores just that command's default (spec §6.5)", async () => {
  app = await launchApp();
  await openKeybindings();
  // Neither chord is in the shipped keymap, so this rebinds without also exercising a conflict.
  await current().settingsCommand("keybindings.capture", { command: "run.start", key: "cmd+ctrl+r" });
  // Sequenced deliberately. The pane builds each new rule set from React state that is only refreshed once the
  // previous save has resolved, so two captures fired inside one save round trip make the second compute from a
  // stale set and overwrite the first. A person cannot click that fast; a scenario can, and driving it that way
  // would be measuring the harness rather than the feature.
  await waitForRules(
    (rules) => rules.some((rule) => rule.key === "cmd+ctrl+r" && rule.command === "run.start"),
    "the run.start rebind never landed",
  );
  await current().settingsCommand("keybindings.capture", { command: "output.clear", key: "cmd+shift+k" });
  // Two rebinds, each writing a removal plus a binding: FOUR rules, not two.
  await waitForRules((rules) => rules.length === 4, "both rebinds never landed");
  await current().settingsCommand("keybindings.resetRow", { command: "run.start" });
  const remaining = await waitForRules((rules) => rules.length === 2, "the per-row reset never landed");
  // Only run.start's pair is gone -- the removal and the binding both address it -- and output.clear keeps both.
  expect(remaining).toEqual([
    { key: "cmd+k", command: "-output.clear" },
    { key: "cmd+shift+k", command: "output.clear" },
  ]);
});
