import { afterEach, expect, test } from "bun:test";
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
}

// ESC-1: this file's source lines are joined with a real newline character built with String.fromCharCode, never a
// typed backslash-n escape.
const NL = String.fromCharCode(10);

test("working-directory files feed editor types, and a missing package offers Install (ED-13, ED-26)", async () => {
  const userData = await createUserData();
  const wd = join(userData, "api");
  await mkdir(wd, { recursive: true });
  const util = ["export function shout(text: string): string {", "  return text.toUpperCase();", "}", ""].join(NL);
  await writeFile(join(wd, "util.ts"), util);
  const code = [
    'import { shout } from "./util";',
    'import missing from "jslab-not-installed";',
    'const n: number = shout("x");',
    'shout("x").',
  ].join(NL);
  await mkdir(join(userData, "buffers"), { recursive: true });
  await writeFile(join(userData, "buffers", "t1.ts"), code);
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({
      version: 2,
      tabOrder: ["t1"],
      activeTabId: "t1",
      tabs: {
        t1: {
          id: "t1",
          title: "t1",
          titleIsCustom: true,
          language: "typescript",
          runtime: "bun",
          workingDirectory: wd,
        },
      },
    }),
  );
  app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
  const current = app;
  const diagnostics = await waitFor(
    async () => {
      const found = ((await current.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[];
      return found.some((d) => d.code === 2322) ? found : null;
    },
    { timeoutMs: 30_000, message: "the local import never produced typed diagnostics" },
  );
  expect(diagnostics.filter((d) => d.code === 2307).map((d) => d.message)).toEqual([
    expect.stringContaining("'jslab-not-installed'"),
  ]);
  const completions = await current.client.call<{ result: { completions: string[] } }>("e2e.command", {
    id: "e2e.completions",
    args: { offset: code.length },
  });
  expect(completions.result.completions).toContain("toUpperCase");
  const actions = await current.client.call<{ result: { actions: { title: string; spec: string }[] } }>("e2e.command", {
    id: "e2e.installActions",
  });
  expect(actions.result.actions).toEqual([
    { title: "Install package jslab-not-installed", spec: "jslab-not-installed" },
  ]);
});
