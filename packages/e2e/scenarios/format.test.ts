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
/** XT-11: the editor's fold memento and scroll offset, as `e2e.state` reports them. */
const geometry = async (target: LaunchedApp) =>
  (await target.state()).ui.viewGeometry as { scrollTop: number; folding: string };
/** XT-11: the start line of every region the folding memento reports as actually collapsed. */
const collapsedStarts = (geo: { folding: string }): number[] => {
  const memento = JSON.parse(geo.folding) as {
    collapsedRegions?: { startLineNumber: number; isCollapsed?: boolean }[];
  };
  return (memento.collapsedRegions ?? []).filter((r) => r.isCollapsed).map((r) => r.startLineNumber);
};
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

  test("formatting keeps folds and scroll, not only the cursor (XT-11)", async () => {
    app = await launchApp({ settings: { version: 2, run: { autoRun: false } } });
    // Unformatted on purpose -- the runs of spaces are what the format actually has to rewrite. A foldable block
    // first, then enough top-level lines that collapsing it does NOT make the document fit the viewport: if it
    // did, scrollTop would clamp to 0 and the scroll half of this assertion would be vacuous.
    const block = ["function outer() {", ...Array.from({ length: 20 }, (_, i) => `  const b${i}   =   ${i};`), "}"];
    const tail = Array.from({ length: 300 }, (_, i) => `const v${i}   =   ${i};`);
    // The trailing newline is deliberate: Prettier emits one, and Monaco's folding memento carries the model's
    // line count, so without it the count would shift for a reason that has nothing to do with folds surviving.
    const source = `${[...block, ...tail].join("\n")}\n`;
    await current().type(source);
    await codeIs(source);

    // Monaco computes folding ranges asynchronously, so a single foldAll straight after typing can find nothing to
    // fold -- which is what this scenario measured on its first run (the memento came back with a lineCount and no
    // collapsedRegions). Retry until regions really exist rather than sleeping a guessed interval. This wait IS the
    // "something was actually folded" guard, so no separate assertion restates it.
    const before = await waitFor(
      async () => {
        await current().command("e2e.foldAll");
        const geo = await geometry(current());
        return geo.folding.includes("collapsedRegions") ? geo : null;
      },
      { timeoutMs: 30_000, message: "editor.foldAll never collapsed anything" },
    );
    // Not vacuous: the buffer really is scrolled, so "unchanged" below is a claim about a non-zero offset, not 0 === 0.
    expect(before.scrollTop).toBeGreaterThan(0);

    expect(collapsedStarts(before)).toEqual([1]);

    await current().key("alt+shift+f");
    await waitFor(async () => (activeTab(await current().state()).code === source ? null : true));
    const after = await geometry(current());
    // The row's actual claim: the fold is still collapsed, still anchored where it was, and the scroll offset is
    // untouched. The memento is deliberately NOT compared whole. Its `checksum` hashes the folded text -- which a
    // format exists to rewrite -- and the indent provider recomputes the region's `endLineNumber` from the new
    // body. Measured on the first green run: comparing the whole token failed for exactly the change this
    // assertion has to tolerate (checksum -49469 -> -948125, end line 21 -> 22), while the fold plainly survived.
    expect(collapsedStarts(after)).toEqual([1]);
    expect(after.scrollTop).toBe(before.scrollTop);
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
