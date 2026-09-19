import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

interface Item {
  label?: string;
  submenu?: Item[];
}

const flatten = (items: Item[]): Item[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);

/** Every label in the native application menu, sections and items alike (`mainState().menu`). */
const labels = async (target: LaunchedApp): Promise<string[]> =>
  flatten(((await target.state()).main.menu ?? []) as Item[]).flatMap((item) => (item.label ? [item.label] : []));

/**
 * A menu label carries its shortcut: `buildMenu` renders `${title}    ${formatChord(chord)}`
 * (apps/desktop/src/main/menu.ts). Every assertion about the label *text* has to drop that suffix first, or an
 * anchored pattern quietly stops matching on exactly the items that have a shortcut -- which is most of them.
 */
const titleOf = (label: string): string => label.split(/\s{2,}/)[0] ?? label;
const titles = async (target: LaunchedApp): Promise<string[]> => (await labels(target)).map(titleOf);

/**
 * An untranslated key that reached the UI as text, e.g. `commands.tab.reopenClosed`. Main's `t()` returns the key
 * itself when the catalogue lacks it, so this is what a missing key looks like on screen.
 *
 * Scoped to menu labels on purpose: `settings.build.functionSent.label` is the English string "function.sent",
 * a real label that matches this pattern. It is a Settings *field* label and never appears in the menu, so the
 * pattern is only safe here. Do not lift this assertion over the whole catalogue.
 */
const DOTTED_KEY = /^[a-z]+(\.[a-zA-Z]+)+$/;

describe("UI language (ST-08, spec §17)", () => {
  test("launching with app.uiLanguage set opens the app in that language", async () => {
    // launchApp writes settings.json before the app starts, so this is exactly what a user sees after the
    // restart the setting asks for.
    const app = await launchApp({ settings: { version: 3, app: { uiLanguage: "ja" } } });
    apps.push(app);

    const menu = await titles(app);
    expect(menu).toContain("ファイル");
    expect(menu).toContain("編集");
    expect(menu).toContain("ヘルプ");
    // A key the seed does not translate falls back to readable English rather than showing a dotted key (§17).
    // The pair matters: the fallback proves the catalogue resolves, the sweep proves nothing leaked raw.
    expect(menu).toContain("Reopen Closed Tab");
    expect(menu.filter((title) => DOTTED_KEY.test(title))).toEqual([]);

    // Captures an image; nothing compares it to a baseline and this repository has no baseline image. It is an
    // artifact for the manual pass in docs/qa/m5e-checklist.md, not a layout check.
    await app.screenshot("i18n-ja-menu");
  });

  test("Spanish reaches the Settings window too, which has its own React tree and RPC", async () => {
    const app = await launchApp({ settings: { version: 3, app: { uiLanguage: "es" } } });
    apps.push(app);

    await app.key("cmd+,");
    // A freshly created window loads its bundle first: the same allowance as `reopenWindow` (R-M2-T24-4).
    const state = await waitFor(
      async () => {
        const settings = await app.settingsState();
        return settings?.ready ? settings : null;
      },
      { timeoutMs: 45_000, message: "The Settings window never became ready" },
    );

    expect(state.settings?.app?.uiLanguage).toBe("es");
    expect(await titles(app)).toContain("Archivo");
    await app.client.call("e2e.screenshot", { name: "i18n-es-settings", window: "settings" });
  });

  test("changing the language does not switch the running window, and takes effect after a restart", async () => {
    const userData = await createUserData();
    const app = await launchApp({ userData, settings: { version: 3, app: { uiLanguage: "en" } } });
    apps.push(app);
    expect(await titles(app)).toContain("File");

    await app.key("cmd+,");
    await waitFor(async () => (await app.settingsState())?.ready || null, {
      timeoutMs: 45_000,
      message: "The Settings window never became ready",
    });
    await app.settingsCommand("settings.set", { key: "app.uiLanguage", value: "ja" });

    // Durable evidence the change was accepted, in place of the `languageChanged` notice. That notice is `info`
    // severity, so it removes itself NOTICE_AUTO_DISMISS_MS (8s) after it mounts (apps/ui/src/shell/parts.tsx),
    // while the E2E bridge's first `e2e.state` round trip after a launch can go unanswered until its own 15s
    // timeout (apps/desktop/src/main/cli/e2e-bridge.ts). 15s outlasts 8s, so polling or relaunching cannot make
    // an assertion on it reliable -- help.test.ts already retries five whole launches for the same reason. The
    // notice itself is covered where it is deterministic: apps/desktop/test/startup-notices.test.ts asserts its
    // id and message, packages/rpc-schema asserts its `info` severity, and Q4 checks it by hand.
    await waitFor(
      async () => JSON.parse(await readFile(join(userData, "settings.json"), "utf8")).app?.uiLanguage === "ja" || null,
      { timeoutMs: 10_000, message: "app.uiLanguage was never persisted as ja" },
    );

    // Spec §17: the running window keeps the language its menus were built in.
    const afterChange = await titles(app);
    expect(afterChange).toContain("File");
    expect(afterChange).not.toContain("ファイル");

    // A real restart, not `relaunch()`: that helper launches a second app against the same data folder without
    // quitting the first, which leaves two instances contending for one jslab.sock.
    await app.quit();
    const restarted = await launchApp({ userData });
    apps.push(restarted);
    expect(await titles(restarted)).toContain("ファイル");
  });
});
