import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type E2EState, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

// JSX compiled with the automatic runtime; in a TypeScript tab the same text is a syntax error.
const TSX_CODE = 'const el = <div id="x">hi</div>;\nel.type + "#" + el.props.id + ":" + el.props.children';
// A generic arrow: valid TypeScript but a syntax error in TSX, so its result proves the tab still compiles as TypeScript.
const TS_CODE = "const id = <T>(x: T) => x;\nid(41) + 1";

/**
 * A stand-in `react/jsx-runtime` in this launch's data folder. React isn't bundled (user packages arrive in M3), and a
 * run's entry file lives in `<data>/runs/<tab>/`, so the runner's normal module lookup finds `<data>/node_modules`.
 */
async function writeJsxRuntime(userData: string): Promise<void> {
  const react = join(userData, "node_modules", "react");
  await mkdir(react, { recursive: true });
  await writeFile(
    join(react, "package.json"),
    JSON.stringify({
      name: "react",
      version: "0.0.0-e2e",
      type: "module",
      exports: { "./jsx-runtime": "./jsx-runtime.js" },
    }),
  );
  await writeFile(
    join(react, "jsx-runtime.js"),
    'export const jsx = (type, props) => ({ type, props });\nexport const jsxs = jsx;\nexport const Fragment = Symbol.for("e2e.fragment");\n',
  );
}

const until = (app: LaunchedApp, predicate: (state: E2EState) => boolean, message: string) =>
  waitFor(
    async () => {
      const state = await app.state();
      return predicate(state) ? state : null;
    },
    { timeoutMs: 15_000, message },
  );

const hasResult = (text: string) => (entries: { kind: string; text: string }[]) =>
  entries.some((entry) => entry.kind === "result" && entry.text === text);

describe("per-tab language", () => {
  test("a TSX tab runs JSX while a TypeScript tab stays TypeScript, and both keep their language after relaunch (LB-01)", async () => {
    const userData = await createUserData();
    await writeJsxRuntime(userData);
    const app = await launchApp({ userData, settings: { version: 2, run: { autoRun: false } } });
    apps.push(app);

    const tabA = (await app.state()).ui.activeTabId as string;
    await app.command("language.tsx");
    await until(app, (s) => activeTab(s).language === "tsx", "tab A never switched to TSX");
    await app.type(TSX_CODE);
    await until(app, (s) => activeTab(s).code === TSX_CODE, "tab A's code never landed");
    await app.command("run.start");
    await app.waitForOutput(hasResult("div#x:hi"));

    const tabB = await app.newTab();
    expect(activeTab(await app.state()).language).toBe("typescript");
    await app.type(TS_CODE);
    await until(app, (s) => activeTab(s).code === TS_CODE, "tab B's code never landed");
    await app.command("run.start");
    await app.waitForOutput(hasResult("42"));

    // Both languages are on disk before quitting (no fixed sleep); buffers are flushed by the quit itself.
    await waitFor(
      async () => {
        const session = JSON.parse(await readFile(join(userData, "session.json"), "utf8"));
        return (session.tabs?.[tabA]?.language === "tsx" && session.tabs?.[tabB]?.language === "typescript") || null;
      },
      { timeoutMs: 10_000, message: "the tab languages were never persisted" },
    );
    await app.quit();

    const again = await launchApp({ userData });
    apps.push(again);
    const restored = await again.state();
    expect(restored.ui.tabs.map((tab) => [tab.id, tab.language, tab.code])).toEqual([
      [tabA, "tsx", TSX_CODE],
      [tabB, "typescript", TS_CODE],
    ]);
    expect(restored.ui.activeTabId).toBe(tabB);
    // Each tab still compiles with its own language after the relaunch.
    await again.command("run.start");
    await again.waitForOutput(hasResult("42"));
    await again.command("tab.previous");
    await until(again, (s) => s.ui.activeTabId === tabA, "tab A never became active again");
    await again.command("run.start");
    await again.waitForOutput(hasResult("div#x:hi"));
  });
});
