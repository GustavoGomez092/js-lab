import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * ST-13, end to end: JSLab's own About dialog, in a built app.
 *
 * The M6 work is pinned at three wiring points by unit tests -- the menu swap (`apps/desktop/test/menu.test.ts`),
 * the dialog's own rendering (`apps/ui/test/about-dialog.test.tsx`) and the action's routing through `openPath`
 * rather than `openExternal` (`apps/desktop/test/rpc/app-handlers.test.ts`) -- but nothing had ever observed the
 * three halves joined up: that `help.about` really puts a dialog on screen, that it names the versions the
 * running build actually has, and that the notices button opens a file that is genuinely in the bundle.
 *
 * Versions are not asserted as literals. They are cross-checked against the debug report (`help.copyDebugLog`),
 * which reaches Main's `versions` by a different route (`debug-report.ts` vs. the bootstrap payload the store
 * hydrates from), so a dialog showing a placeholder, a stale constant or the wrong field cannot satisfy both.
 */

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface Box {
  width: number;
  height: number;
  text: string;
}

const boxes = async (target: LaunchedApp) =>
  ((await target.state()).ui.layoutMetrics as { boxes: Record<string, Box | null> }).boxes;

/** Opens About and waits until the dialog is really on screen (a measured box, not just a store flag). */
async function openAbout(target: LaunchedApp): Promise<Box> {
  // A missing `help.about` makes this reject outright ("Unknown command"), which is the fail-fast path here:
  // the catalogue entry is the first thing this scenario covers, so it must not present as a silent timeout.
  await target.command("help.about");
  return waitFor(
    async () => {
      const dialog = (await boxes(target)).aboutDialog;
      return dialog && dialog.width > 0 && dialog.height > 0 ? dialog : null;
    },
    { timeoutMs: 15_000, message: "the About dialog never appeared on screen" },
  );
}

describe("About (ST-13)", () => {
  test("Help → About puts a dialog on screen naming this build's real versions and licence", async () => {
    app = await launchApp();
    const dialog = await openAbout(app);

    // The licence and copyright, read off the rendered dialog.
    expect(dialog.text).toContain("About JSLab");
    expect(dialog.text).toContain("MIT License");
    expect(dialog.text).toContain("Copyright (c) 2026 JSLab contributors");

    // What the running build says its versions are, by an independent route.
    await app.command("help.copyDebugLog");
    const clip = join(app.userData, "e2e-clipboard.txt");
    const report = JSON.parse(
      await waitFor(() => (existsSync(clip) ? readFileSync(clip, "utf8") : null), {
        message: "the debug report was never written",
      }),
    ) as { version: string; bunVersion: string; electrobunVersion: string };

    const facts = (await boxes(app)).aboutFacts;
    expect(facts, "the About dialog's version list must be on screen").not.toBeNull();
    // Each version matched in full, including its label, so a dialog wired to the wrong field cannot pass.
    expect(facts?.text).toContain(`Version ${report.version}`);
    expect(facts?.text).toContain(`Bun ${report.bunVersion}`);
    expect(facts?.text).toContain(`Electrobun ${report.electrobunVersion}`);
    // The failure mode `about-dialog.test.tsx` guards against in unit form, checked against a real build too.
    expect(facts?.text).not.toContain("undefined");
    await app.screenshot("about-dialog");

    // Escape dismisses it, and the dialog leaves the screen -- not merely the store.
    await app.key("escape");
    await waitFor(async () => ((await boxes(app as LaunchedApp)).aboutDialog === null ? true : null), {
      timeoutMs: 10_000,
      message: "the About dialog never left the screen after Escape",
    });
    expect((await app.state()).ui.modal).toBeNull();
  });

  test("Open-Source Notices opens the bundled THIRD-PARTY-NOTICES.md as a path, and that file is really there", async () => {
    app = await launchApp();
    await openAbout(app);

    const opened = join(app.userData, "e2e-opened.txt");
    const external = join(app.userData, "e2e-external.txt");
    expect(existsSync(opened), "nothing must have been opened before the button is clicked").toBe(false);

    // Clicks the real button in the real dialog (see `e2e.aboutNotices`), not the action behind it.
    await app.command("e2e.aboutNotices");

    // Races the exact regression `app-handlers.test.ts` guards in unit form: a path handed to `openExternal`
    // would be treated as a URL. Without this race that bug would present as an opaque 15-second timeout.
    const landed = await waitFor(
      () => {
        if (existsSync(external)) return { wrong: readFileSync(external, "utf8").trim() };
        return existsSync(opened) ? { path: readFileSync(opened, "utf8").trim() } : null;
      },
      { timeoutMs: 15_000, message: "the notices file was never opened" },
    );
    if ("wrong" in landed)
      throw new Error(`the notices path was opened as an external link, never as a path: ${landed.wrong}`);

    // An absolute path, inside THIS app bundle, that actually exists: the `hutch.config.ts` staging step and the
    // `electrobun.config.ts` copy are what put it there, so a build that stopped shipping it fails here.
    expect(landed.path.endsWith("THIRD-PARTY-NOTICES.md")).toBe(true);
    expect(landed.path.startsWith(app.appPath)).toBe(true);
    expect(existsSync(landed.path), `the bundle has no notices file at ${landed.path}`).toBe(true);
    expect(readFileSync(landed.path, "utf8").length).toBeGreaterThan(0);
    // Exactly one thing was opened, and nothing was opened as a link.
    expect(readFileSync(opened, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(external)).toBe(false);
  });
});
