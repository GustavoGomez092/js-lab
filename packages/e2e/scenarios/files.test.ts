import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type E2EState, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;

async function fixture(name: string, content: string): Promise<string> {
  const work = join(current().userData, "work");
  await mkdir(work, { recursive: true });
  const path = join(work, name);
  await writeFile(path, content);
  return path;
}

async function openViaDialog(paths: string[]) {
  await writeFile(join(current().userData, "e2e-open-dialog.json"), JSON.stringify(paths));
  await current().command("file.open");
}

const until = (predicate: (state: E2EState) => boolean, timeoutMs = 15_000) =>
  waitFor(
    async () => {
      const state = await current().state();
      return predicate(state) ? state : null;
    },
    { timeoutMs },
  );

describe("files", () => {
  test("Open, edit and Save round-trip; opening an open file focuses it (TF-10)", async () => {
    app = await launchApp();
    const file = await fixture("hello.ts", "export const x = 1\n");
    await openViaDialog([file]);
    const opened = activeTab(await until((s) => activeTab(s).filePath === file));
    expect([opened.title, opened.language, opened.dirty, opened.code]).toEqual([
      "hello.ts",
      "typescript",
      false,
      "export const x = 1\n",
    ]);
    await app.type("export const x = 2\n");
    await until((s) => activeTab(s).dirty);
    await app.command("file.save");
    await until((s) => !activeTab(s).dirty);
    expect(await readFile(file, "utf8")).toBe("export const x = 2\n");
    await app.newTab();
    expect((await app.state()).ui.tabOrder).toHaveLength(3);
    await openViaDialog([file]);
    await until((s) => activeTab(s).filePath === file && s.ui.tabOrder.length === 3);
  });

  test("Save As confirms a result equal to the default path, and saves a chosen path directly (TF-10, M0-S6)", async () => {
    app = await launchApp();
    const seed = await fixture("seed.ts", "");
    await openViaDialog([seed]);
    await until((s) => activeTab(s).filePath === seed);
    const work = join(app.userData, "work");

    await app.newTab();
    await app.type("1 + 1");
    const defaultPath = join(work, "1 + 1.ts");
    await writeFile(join(app.userData, "e2e-save-dialog.json"), JSON.stringify({ path: defaultPath }));
    await app.command("file.saveAs");
    await until((s) => s.ui.modal === "confirm");
    expect(existsSync(defaultPath)).toBe(false);
    await app.screenshot("save-as-confirm");
    await app.key("enter");
    await until((s) => activeTab(s).filePath === defaultPath);
    expect(await readFile(defaultPath, "utf8")).toBe("1 + 1");

    await app.newTab();
    await app.type("2 + 2");
    const picked = join(work, "picked.ts");
    await writeFile(join(app.userData, "e2e-save-dialog.json"), JSON.stringify({ path: picked }));
    await app.command("file.saveAs");
    const saved = await until((s) => activeTab(s).filePath === picked);
    expect(saved.ui.modal).toBeNull();
  });

  test("closing a modified file asks to save, and ⌘D discards (TF-09)", async () => {
    app = await launchApp();
    const file = await fixture("keep.ts", "original\n");
    await openViaDialog([file]);
    await until((s) => activeTab(s).filePath === file);
    await app.type("changed\n");
    await until((s) => activeTab(s).dirty);
    await app.command("tab.close");
    await until((s) => s.ui.modal === "confirm");
    await app.key("cmd+d");
    await until((s) => s.ui.tabOrder.length === 1 && s.ui.modal === null);
    expect(await readFile(file, "utf8")).toBe("original\n");
  });

  test("Confirm Close asks before closing any tab (TF-08)", async () => {
    app = await launchApp({ settings: { version: 2, tabs: { confirmClose: true } } });
    await app.newTab();
    await app.type("x");
    await app.command("tab.close");
    await until((s) => s.ui.modal === "confirm");
    await app.key("escape");
    const state = await until((s) => s.ui.modal === null);
    expect(state.ui.tabOrder).toHaveLength(2);
  });

  test("⌘W on the only empty tab closes the window, and reopening restores the workspace (TF-21)", async () => {
    app = await launchApp();
    await app.key("cmd+w");
    await waitFor(async () => {
      const raw = await current().client.call<{ ui: unknown; main: { windowOpen: boolean } }>("e2e.state");
      return raw.main.windowOpen === false && raw.ui === null ? raw : null;
    });
    await app.reopenWindow();
    expect((await app.state()).ui.tabOrder).toHaveLength(1);
  });

  test("a window saved on a display that no longer exists opens on the primary display (spec §10.1, TF-14)", async () => {
    const userData = await createUserData();
    await writeFile(
      join(userData, "session.json"),
      JSON.stringify({
        version: 1,
        window: { x: -40000, y: -40000, width: 900, height: 600, displayId: "999999", fullscreen: false },
      }),
    );
    app = await launchApp({ userData });
    const { main } = await app.state();
    const frame = main.windowFrame as { x: number; y: number; width: number; height: number };
    const area = main.primaryWorkArea as { x: number; y: number; width: number; height: number };
    expect(frame.x).toBeGreaterThanOrEqual(area.x);
    expect(frame.y).toBeGreaterThanOrEqual(area.y);
    expect(frame.x + frame.width).toBeLessThanOrEqual(area.x + area.width);
    expect(frame.y + frame.height).toBeLessThanOrEqual(area.y + area.height);
  });

  test("files over 5 MB open only after confirmation, and edits to them still persist (TF-12)", async () => {
    app = await launchApp();
    const size = 6 * 1024 * 1024;
    const big = await fixture("big.js", "x".repeat(size));
    await openViaDialog([big]);
    await until((s) => s.ui.modal === "confirm");
    await app.key("enter");
    const opened = activeTab(await until((s) => activeTab(s).filePath === big, 30_000));
    expect(opened.code.length).toBe(size);
    // Edits must reach Main (buffer.changed is capped at MAX_TEXT_CHARS, above any file that opens) and the disk.
    const edit = "// edited\n";
    await app.type(edit, false);
    const buffer = join(app.userData, "buffers", `${opened.id}.js`);
    await waitFor(
      async () => {
        if (!existsSync(buffer)) return null;
        const text = await readFile(buffer, "utf8");
        return text.length === size + edit.length && text.includes("// edited") ? true : null;
      },
      { timeoutMs: 30_000, message: "The edited large buffer was never persisted" },
    );
    expect(activeTab(await app.state()).dirty).toBe(true);
  });

  test("a web link clicked in the page opens outside JSLab and the view stays on views:// (spec §18, R-M1-17(e))", async () => {
    app = await launchApp();
    const href = "https://example.com/jslab-e2e-link";
    await app.command("e2e.openLink", { href });
    const recorded = join(app.userData, "e2e-external.txt");
    await waitFor(async () => (existsSync(recorded) && (await readFile(recorded, "utf8")).includes(href)) || null, {
      timeoutMs: 15_000,
      message: "The blocked link never reached openExternal",
    });
    expect((await app.state()).ui.ready).toBe(true);
    await app.type("1 + 1");
    await app.waitForOutput((all) => all.some((e) => e.kind === "result" && e.text === "2"));
  });
});
