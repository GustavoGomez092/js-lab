import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;
const codeIs = (expected: string) =>
  waitFor(async () => {
    const state = await current().state();
    return activeTab(state).code === expected ? state : null;
  });

describe("formatting", () => {
  test("Format Code applies Prettier settings in one step (ED-22, ED-24, XT-11)", async () => {
    app = await launchApp({
      settings: { version: 2, run: { autoRun: false }, prettier: { semi: false, singleQuote: true } },
    });
    await app.type('const a = "x";;\nconst b   =   2');
    await app.key("alt+shift+f");
    const state = await codeIs("const a = 'x'\nconst b = 2\n");
    expect(state.ui.cursor).not.toBeNull();
  });

  test("format on run formats before a manual run when not typing (ED-23)", async () => {
    app = await launchApp({ settings: { version: 2, run: { autoRun: false, formatOnRun: true } } });
    await app.type("1+1");
    await codeIs("1+1");
    // Semantically required (FA-m10): format-on-run skips formatting within 1 s of the last keystroke
    // (apps/ui/src/format/formatter.ts). Wait well past that window, so a slow machine can't run unformatted code.
    await Bun.sleep(2_000);
    await app.key("cmd+r");
    await codeIs("1 + 1;\n");
    await app.waitForOutput((all) => all.some((e) => e.text === "2"));
  });

  test("format on save writes formatted code (XT-05)", async () => {
    app = await launchApp({ settings: { version: 2, run: { autoRun: false }, editor: { formatOnSave: true } } });
    const work = join(app.userData, "work");
    await mkdir(work, { recursive: true });
    const file = join(work, "fmt.ts");
    await writeFile(file, "");
    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([file]));
    await app.command("file.open");
    await waitFor(async () => activeTab(await current().state()).filePath === file || null);
    await app.type("let x=1");
    await app.command("file.save");
    await waitFor(async () => (await readFile(file, "utf8")) === "let x = 1;\n" || null);
  });

  test("a syntax error leaves the code unchanged and explains why", async () => {
    app = await launchApp({ settings: { version: 2, run: { autoRun: false } } });
    await app.type("const = ;");
    await app.key("alt+shift+f");
    const state = await waitFor(async () => {
      const s = await current().state();
      return String(s.ui.statusMessage ?? "").startsWith("Couldn't format") ? s : null;
    });
    expect(activeTab(state).code).toBe("const = ;");
  });
});
