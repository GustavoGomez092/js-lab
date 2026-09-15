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

async function diagnosticsFor(tabId: string): Promise<TsDiagnostic[]> {
  const current = app as LaunchedApp;
  return waitFor(
    async () => {
      const ui = (await current.state()).ui;
      const diagnostics = (ui.tsDiagnostics ?? []) as TsDiagnostic[];
      return ui.activeTabId === tabId && diagnostics.some((d) => d.code === 2322) ? diagnostics : null;
    },
    { timeoutMs: 30_000, message: `TypeScript diagnostics never arrived for ${tabId}` },
  );
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
    expect(flaggedNames(await diagnosticsFor("bun-tab"))).toEqual(["document"]);
    await app.command("tab.next");
    expect(flaggedNames(await diagnosticsFor("node-tab"))).toEqual(["Bun"]);
    await app.command("tab.next");
    expect(flaggedNames(await diagnosticsFor("web-tab"))).toEqual(["process", "Bun"]);
  });

  test("autocomplete comes from the TypeScript worker, and Linting off clears diagnostics (ED-08, ED-09)", async () => {
    const userData = await createUserData();
    const code = ["const list = [1, 2];", 'const wrong: number = "x";', "list."].join(NL);
    await seedTabs(userData, [{ id: "bun-tab", runtime: "bun", code }]);
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    const current = app;
    await diagnosticsFor("bun-tab");
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
        message: "diagnostics stayed after Linting was turned off",
      },
    );
  });
});
