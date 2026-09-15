import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface TsDiagnostic {
  code: number;
  message: string;
  line: number;
}

// ESC-1: this file's source lines are joined with a real newline character built with String.fromCharCode, never a
// typed backslash-n escape.
const NL = String.fromCharCode(10);

const CODE = [
  "console.log(typeof setTimeout);",
  "const platform: string = process.platform;",
  "Bun.version;",
  "document.title;",
  'const wrong: number = "x";',
  "export {};",
].join(NL);

async function seedTabs(userData: string, tabs: { id: string; runtime: string; code: string }[]) {
  await mkdir(join(userData, "buffers"), { recursive: true });
  const session = {
    version: 2,
    tabOrder: tabs.map((tab) => tab.id),
    activeTabId: tabs[0]?.id,
    tabs: Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        { id: tab.id, title: tab.id, titleIsCustom: true, language: "typescript", runtime: tab.runtime },
      ]),
    ),
  };
  await writeFile(join(userData, "session.json"), JSON.stringify(session));
  for (const tab of tabs) await writeFile(join(userData, "buffers", `${tab.id}.ts`), tab.code);
}

const flaggedNames = (diagnostics: TsDiagnostic[]) =>
  ["console", "setTimeout", "process", "Bun", "document"].filter((name) =>
    diagnostics.some((d) => d.message.includes(`'${name}'`)),
  );

const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((name, index) => name === b[index]);

/**
 * Polls until the shown tab's diagnostics are the expected, settled snapshot, not just the first one that includes
 * 2322 (Task 21 fix round 1, I-1): on mount, Monaco can validate against the esnext-only startup defaults before
 * the lazily loaded pack chunks finish, which would also flag names the final, pack-aware validation never flags.
 */
async function diagnosticsFor(tabId: string, expected: string[]): Promise<TsDiagnostic[]> {
  const current = app as LaunchedApp;
  let lastSeen: string[] = [];
  let diagnostics: TsDiagnostic[];
  try {
    diagnostics = await waitFor(
      async () => {
        const ui = (await current.state()).ui;
        const list = (ui.tsDiagnostics ?? []) as TsDiagnostic[];
        lastSeen = flaggedNames(list);
        const ready = ui.activeTabId === tabId && list.some((d) => d.code === 2322) && sameNames(lastSeen, expected);
        return ready ? list : null;
      },
      {
        timeoutMs: 30_000,
        message: `TypeScript diagnostics for ${tabId} never settled on ${JSON.stringify(expected)}`,
      },
    );
  } catch (error) {
    throw new Error(`${(error as Error).message} (last saw ${JSON.stringify(lastSeen)})`);
  }
  // Belt-and-braces: the poll's own condition already checked this, but assert it explicitly too.
  expect(flaggedNames(diagnostics)).toEqual(expected);
  return diagnostics;
}

describe("TypeScript in the editor (spec §6.1, ED-09, ED-14)", () => {
  test("each runtime gets its own libraries: console is never flagged, and Bun, process and document only where they exist", async () => {
    const userData = await createUserData();
    await seedTabs(userData, [
      { id: "bun-tab", runtime: "bun", code: CODE },
      { id: "node-tab", runtime: "browser-node", code: CODE },
      { id: "web-tab", runtime: "browser", code: CODE },
    ]);
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    await diagnosticsFor("bun-tab", ["document"]);
    await app.command("tab.next");
    await diagnosticsFor("node-tab", ["Bun"]);
    await app.command("tab.next");
    await diagnosticsFor("web-tab", ["process", "Bun"]);
  });

  test("autocomplete comes from the TypeScript worker, and Linting off clears diagnostics (ED-08, ED-09)", async () => {
    const userData = await createUserData();
    const code = ["const list = [1, 2];", 'const wrong: number = "x";', "list."].join(NL);
    await seedTabs(userData, [{ id: "bun-tab", runtime: "bun", code }]);
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    const current = app;
    await diagnosticsFor("bun-tab", []);
    const reply = await current.client.call<{ result: { completions: string[] } }>("e2e.command", {
      id: "e2e.completions",
      args: { offset: code.length },
    });
    expect(reply.result.completions).toEqual(expect.arrayContaining(["map", "filter"]));
    await current.key("cmd+,");
    await waitFor(async () => (await current.settingsState())?.ready || null, { timeoutMs: 45_000 });
    await current.settingsCommand("settings.set", { key: "editor.linting", value: false });
    await waitFor(
      async () => (((await current.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[]).length === 0 || null,
      {
        timeoutMs: 30_000,
        message: "diagnostics never cleared after Linting was turned off",
      },
    );
    // M-4(a): a transient revalidation gap can also read as empty. Require the empty reading to hold across several
    // more polls covering at least 1000 ms, using the same Bun.sleep primitive waitFor uses, bounded by a small
    // fixed count rather than an open-ended loop.
    for (let reading = 0; reading < 6; reading++) {
      await Bun.sleep(200);
      const stillClear = ((await current.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[];
      if (stillClear.length > 0) {
        throw new Error(
          `diagnostics came back after Linting was turned off: ${JSON.stringify(stillClear.map((d) => d.code))}`,
        );
      }
    }
  });
});
