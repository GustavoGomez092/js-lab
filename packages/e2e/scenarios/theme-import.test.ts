import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type E2EState, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;

/** `applyThemeImport` builds a successful import's status line as `Imported <name>.` plus any caveats. */
const IMPORTED = "Imported ";

const THEME = JSON.stringify({
  name: "Test Deep",
  type: "dark",
  colors: { "editor.background": "#101014", "editor.foreground": "#D4D4D4", focusBorder: "#7AA2F7" },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#6A9955", fontStyle: "italic" } },
    { scope: ["keyword", "storage"], settings: { foreground: "#C586C0" } },
  ],
});

type Settled = { ok: true; state: E2EState } | { ok: false; reason: string };

/**
 * One poll of an in-flight import: applied, refused, or neither yet.
 *
 * `waitFor` treats a THROWING probe as "not yet", so a fast fail has to travel in the return value. A probe that
 * only watched `themeId` would turn every refusal -- an unreadable file, an oversized one, a name that collides
 * with a built-in -- into the same silent 10 s timeout, which is the one failure mode that says nothing at all.
 */
async function pollImport(themeId: string, seen: string[]): Promise<Settled | null> {
  const state = await current().state();
  const status = state.ui.statusMessage;
  seen.push(`themeId=${state.ui.themeId} status=${status ?? "null"}`);
  if (state.ui.themeId === themeId) return { ok: true, state };
  // A refusal is any status line that is not the success line; Main sends "" for a cancelled dialog, which is
  // deliberately silent and must not be read as an error.
  if (typeof status === "string" && status !== "" && !status.startsWith(IMPORTED)) return { ok: false, reason: status };
  return null;
}

/** Waits for `themeId` to become active, failing fast on a refusal and naming what was actually observed. */
async function expectImported(themeId: string): Promise<E2EState> {
  const seen: string[] = [];
  let settled: Settled;
  try {
    settled = await waitFor(() => pollImport(themeId, seen), { message: `the "${themeId}" theme never became active` });
  } catch (error) {
    throw new Error(`${String(error)}; last observed: ${seen.slice(-3).join(" | ") || "nothing"}`);
  }
  if (!settled.ok) throw new Error(`the import was refused: ${settled.reason}`);
  return settled.state;
}

test("importing a VS Code theme .json applies it, persists it and survives a relaunch (XT-01)", async () => {
  const userData = await createUserData();
  const themeFile = join(userData, "test-deep.json");
  await writeFile(themeFile, THEME);
  app = await launchApp({ userData });

  expect((await current().state()).ui.themeId).toBe("graphite");
  // Native dialogs can't be driven over the socket, so the harness writes the answer and Main consumes it once
  // (`readE2EOpenDialog`); `files.test.ts` is the existing precedent.
  await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([themeFile]));
  await current().command("theme.import");
  await expectImported("test-deep");
  await current().screenshot("theme-imported");

  // Spec §4.5: saved under <appdata>/themes/ as *.jslab-theme.json.
  const saved = join(userData, "themes", "test-deep.jslab-theme.json");
  expect(existsSync(saved)).toBe(true);
  const written = JSON.parse(await readFile(saved, "utf8"));
  expect(written).toMatchObject({ id: "test-deep", name: "Test Deep", type: "dark" });
  // `rgbToHex` uppercases, and every one of the 34 tokens is a full six-digit hex or `ThemeStore` refuses the file.
  expect(written.tokens["bg.canvas"]).toMatch(/^#[0-9A-F]{6}$/);
  expect(JSON.parse(await readFile(join(userData, "settings.json"), "utf8")).appearance.theme).toBe("test-deep");

  // It is a real theme afterwards: still selectable after a relaunch, and the built-ins still work (ST-03).
  const relaunched = await current().relaunch();
  app = relaunched;
  expect((await relaunched.state()).ui.themeId).toBe("test-deep");
  await relaunched.command("theme.select", { themeId: "dracula" });
  await waitFor(async () => ((await relaunched.state()).ui.themeId === "dracula" ? true : null), {
    message: "a built-in theme stopped being selectable once a theme had been imported",
  });
  await relaunched.command("theme.select", { themeId: "test-deep" });
  await waitFor(async () => ((await relaunched.state()).ui.themeId === "test-deep" ? true : null), {
    message: "the imported theme was not selectable after a relaunch",
  });
});

test("importing a .vsix reads contributes.themes out of a real archive (XT-01)", async () => {
  const userData = await createUserData();
  const staging = join(userData, "vsix-src");
  await mkdir(join(staging, "extension", "themes"), { recursive: true });
  await writeFile(
    join(staging, "extension", "package.json"),
    JSON.stringify({
      name: "pack",
      contributes: { themes: [{ label: "Packed", uiTheme: "vs-dark", path: "./themes/packed.json" }] },
    }),
  );
  await writeFile(join(staging, "extension", "themes", "packed.json"), THEME.replace("Test Deep", "Packed"));
  const vsix = join(userData, "pack.vsix");
  // A real zip from the system tool, so the hand-written reader is checked against a genuine producer.
  const zipped = Bun.spawnSync(["zip", "-qr", vsix, "extension"], { cwd: staging });
  expect(zipped.exitCode).toBe(0);

  app = await launchApp({ userData });
  await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([vsix]));
  await current().command("theme.import");
  await expectImported("packed");
  expect(existsSync(join(userData, "themes", "packed.jslab-theme.json"))).toBe(true);
});

test("an invalid theme file reports a readable error and changes nothing (spec §9.3)", async () => {
  const userData = await createUserData();
  const bad = join(userData, "broken.json");
  await writeFile(bad, "{ this is not json");
  app = await launchApp({ userData });
  await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([bad]));
  await current().command("theme.import");
  const seen: string[] = [];
  let state: E2EState;
  try {
    state = await waitFor(
      async () => {
        const next = await current().state();
        seen.push(`themeId=${next.ui.themeId} status=${next.ui.statusMessage ?? "null"}`);
        return next.ui.statusMessage ? next : null;
      },
      { message: "no error was reported for an unparseable theme file" },
    );
  } catch (error) {
    throw new Error(`${String(error)}; last observed: ${seen.slice(-3).join(" | ") || "nothing"}`);
  }
  // Spec §18: the readable line never quotes a path, so the raw cause can't leak one through the status bar.
  expect(String(state.ui.statusMessage)).not.toMatch(/[/\\]/);
  expect(state.ui.themeId).toBe("graphite");
  // `ThemeStore` creates nothing until a successful save, so a refused import must leave no themes folder at all.
  expect(existsSync(join(userData, "themes"))).toBe(false);
});
