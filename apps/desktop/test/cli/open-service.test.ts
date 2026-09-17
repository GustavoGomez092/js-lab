import { describe, expect, mock, test } from "bun:test";
import type { FileOpened } from "@jslab/rpc-schema";
import { createTab } from "@jslab/shared";
import { createOpenService, type OpenServiceDeps } from "../../src/main/cli/open-service";

function setup(files: Record<string, string> = {}, open: Record<string, string> = {}) {
  const announced: FileOpened[] = [];
  const presented: { run: boolean }[] = [];
  let next = 0;
  const deps = {
    session: {
      createTab: mock(async (options: Record<string, unknown>) => createTab({ id: `t${++next}`, ...options })),
      // `SessionStore.findTabByPath` returns `TabState | null`, so the miss case is null, not undefined.
      findTabByPath: mock((path: string) => (open[path] ? createTab({ id: open[path], filePath: path }) : null)),
    },
    readFile: mock(async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    }),
    defaults: () => ({ language: "typescript" as const, runtime: "bun" as const }),
    announce: (payload: FileOpened) => announced.push(payload),
    present: (options: { run: boolean }) => presented.push(options),
    log: mock(() => {}),
  } satisfies OpenServiceDeps;
  return { deps, announced, presented, open: createOpenService(deps) };
}

describe("the CLI open service", () => {
  test("opens each file in a tab, with the language from its extension", async () => {
    const { deps, announced, open } = setup({ "/w/a.ts": "const a = 1", "/w/b.jsx": "<b/>" });
    expect(await open({ files: ["/w/a.ts", "/w/b.jsx"] })).toEqual({ tabIds: ["t1", "t2"] });
    expect(deps.session.createTab.mock.calls.map(([options]) => options)).toEqual([
      {
        filePath: "/w/a.ts",
        language: "typescript",
        content: "const a = 1",
        lastSavedHash: expect.any(String),
        workingDirectory: null,
      },
      {
        filePath: "/w/b.jsx",
        language: "jsx",
        content: "<b/>",
        lastSavedHash: expect.any(String),
        workingDirectory: null,
      },
    ]);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.tabs.map((entry) => entry.tab.id)).toEqual(["t1", "t2"]);
    expect(announced[0]).toMatchObject({ focusTabId: null, large: [], errors: [] });
  });

  test("focuses a file that is already open instead of opening it twice (§10.2)", async () => {
    const { deps, announced, open } = setup({ "/w/a.ts": "x" }, { "/w/a.ts": "already" });
    expect(await open({ files: ["/w/a.ts"] })).toEqual({ tabIds: ["already"] });
    expect(deps.session.createTab).not.toHaveBeenCalled();
    expect(announced[0]?.focusTabId).toBe("already");
  });

  test("stdin code becomes one tab, taking the language and runtime from settings unless overridden", async () => {
    const { deps, open } = setup();
    expect(await open({ code: "1 + 1" })).toEqual({ tabIds: ["t1"] });
    expect(deps.session.createTab).toHaveBeenCalledWith({
      language: "typescript",
      runtime: "bun",
      content: "1 + 1",
      workingDirectory: null,
    });
  });

  test("--runtime, --lang, --cwd and --title reach the created tab, for every runtime", async () => {
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      const { deps, open } = setup();
      await open({ code: "1", runtime, lang: "jsx", cwd: "/w/project", title: "scratch" });
      expect(deps.session.createTab).toHaveBeenCalledWith({
        language: "jsx",
        runtime,
        content: "1",
        workingDirectory: "/w/project",
        title: "scratch",
        titleIsCustom: true,
      });
    }
  });

  test("--lang overrides the extension for a file, and --cwd applies to it too", async () => {
    const { deps, open } = setup({ "/w/a.txt": "x" });
    await open({ files: ["/w/a.txt"], lang: "javascript", cwd: "/w/project" });
    expect(deps.session.createTab).toHaveBeenCalledWith({
      filePath: "/w/a.txt",
      language: "javascript",
      content: "x",
      lastSavedHash: expect.any(String),
      workingDirectory: "/w/project",
    });
  });

  test("an unreadable file is reported but never stops the others", async () => {
    const { announced, open } = setup({ "/w/a.ts": "x" });
    expect(await open({ files: ["/w/missing.ts", "/w/a.ts"] })).toEqual({ tabIds: ["t1"] });
    expect(announced[0]?.errors).toEqual(["/w/missing.ts couldn't be read."]);
  });

  test("a request whose every file failed becomes an error reply, not a silent success", async () => {
    const { open } = setup();
    await expect(open({ files: ["/w/missing.ts"] })).rejects.toThrow("/w/missing.ts couldn't be read.");
  });

  test("code runs only when run is passed (§16.3)", async () => {
    const quiet = setup({ "/w/a.ts": "x" });
    await quiet.open({ files: ["/w/a.ts"] });
    expect(quiet.presented).toEqual([{ run: false }]);

    const loud = setup({ "/w/a.ts": "x" });
    await loud.open({ files: ["/w/a.ts"], run: true });
    expect(loud.presented).toEqual([{ run: true }]);
  });
});
