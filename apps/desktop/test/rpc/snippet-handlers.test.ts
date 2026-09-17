import { describe, expect, mock, test } from "bun:test";
import { MAX_SNIPPETS_FILE_BYTES, type SnippetsExported, type SnippetsImported } from "@jslab/rpc-schema";
import { SNIPPETS_FORMAT, SNIPPETS_VERSION, type Snippet } from "@jslab/shared";
import { FileTooLargeError } from "../../src/main/files/bounded-read";
import { createSnippetHandlers } from "../../src/main/rpc/snippet-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";
import { strings } from "../../src/main/strings";

const AT = "2026-09-16T10:00:00.000Z";
const record = (overrides: Partial<Snippet> = {}): Snippet => ({
  id: "s1",
  name: "fetchjson",
  description: "Fetch + parse JSON",
  body: "await fetch($0)",
  language: "typescript",
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

/**
 * `createValidators`' `message` wrapper is fire-and-forget: it returns `void`, not the handler's promise, so
 * `await handlers.messages[...](...)` awaits `undefined` and resumes a tick later -- before an `await`ing handler
 * has reached its `send`. Every message test therefore calls the handler and then flushes, the same idiom
 * file-handlers.test.ts uses. Without this, tests asserting "nothing was sent" pass vacuously.
 */
const flush = () => Bun.sleep(5);

function setup(options: { file?: string; chosen?: string[]; savePath?: string | null } = {}) {
  let stored: Snippet[] = [record()];
  const imported: SnippetsImported[] = [];
  const exported: SnippetsExported[] = [];
  const written: { path: string; content: string }[] = [];
  /**
   * The real reader (src/main/files/bounded-read.ts) refuses from the opened handle's `fstat`, before it
   * allocates anything. This fake refuses on the same rule, at whatever cap the handler hands it -- so a handler
   * that widened the cap, or stopped passing one, imports a file the product refuses.
   */
  const readFile = mock(async (path: string, maxBytes: number) => {
    const text = options.file ?? "";
    const size = Buffer.byteLength(text);
    if (size > maxBytes) throw new FileTooLargeError(path, size, maxBytes);
    return text;
  });
  const handlers = createSnippetHandlers({
    snippets: {
      get snippets() {
        return stored;
      },
      save: mock(async (next: Snippet[]) => {
        stored = next;
        return next;
      }),
    },
    openDialog: mock(async () => options.chosen ?? ["/tmp/library.json"]),
    saveDialog: mock(async () => (options.savePath === undefined ? "/tmp/out.json" : options.savePath)),
    readFile,
    writeFile: mock(async (path: string, content: string) => void written.push({ path, content })),
    documentsDir: "/docs",
    send: { imported: (p) => imported.push(p), exported: (p) => exported.push(p) },
    log: () => {},
  });
  return { handlers, imported, exported, written, readFile, current: () => stored };
}

const library = (snippets: Snippet[]) =>
  JSON.stringify({ format: SNIPPETS_FORMAT, version: SNIPPETS_VERSION, snippets });

describe("snippet handlers (spec §13.1, §13.4, §18)", () => {
  test("snippets.list returns the library and snippets.save replaces it", async () => {
    const { handlers, current } = setup();
    expect(handlers.requests["snippets.list"]({})).toEqual({ snippets: [record()] });
    const next = [record({ id: "s2", name: "log", body: "console.log($0)" })];
    expect(await handlers.requests["snippets.save"]({ snippets: next })).toEqual({ ok: true });
    expect(current()).toEqual(next);
  });

  test("snippets.save rejects an invalid payload before the store sees it", () => {
    const { handlers, current } = setup();
    expect(() => handlers.requests["snippets.save"]({ snippets: [record({ name: "has spaces" })] })).toThrow(
      InvalidPayloadError,
    );
    expect(() => handlers.requests["snippets.save"]({ snippets: "everything" })).toThrow(InvalidPayloadError);
    expect(current()).toEqual([record()]);
  });

  test("a failed write is reported as a result, not an exception", async () => {
    const { handlers } = setup();
    const failing = createSnippetHandlers({
      snippets: {
        snippets: [],
        save: mock(async () => {
          throw new Error("EACCES: permission denied");
        }),
      },
      openDialog: async () => [],
      saveDialog: async () => null,
      readFile: async () => "",
      writeFile: async () => {},
      documentsDir: "/docs",
      send: { imported: () => {}, exported: () => {} },
      log: () => {},
    });
    expect(await failing.requests["snippets.save"]({ snippets: [] })).toEqual({
      ok: false,
      error: "EACCES: permission denied",
    });
    expect(handlers.requests["snippets.list"]({})).toBeDefined();
  });

  test("importDialog parses the chosen file and reports it WITHOUT merging or saving", async () => {
    const incoming = [record({ id: "i1", name: "brandnew" })];
    const { handlers, imported, current } = setup({ file: library(incoming) });
    handlers.messages["snippets.importDialog"]({});
    await flush();
    expect(imported).toEqual([{ ok: true, snippets: incoming }]);
    // R-M5b-8: the library is the panel's to change; import only reports.
    expect(current()).toEqual([record()]);
  });

  test("a malformed or hostile file is refused with a reason, and the library is untouched", async () => {
    const hostile = [
      "{ not json",
      JSON.stringify({ format: "vscode-snippets", version: 1, snippets: [] }),
      JSON.stringify({ format: SNIPPETS_FORMAT, version: 99, snippets: [] }),
      library([record({ body: "x".repeat(20_001) })]),
      library([record(), record({ id: "s2" })]),
      JSON.stringify({ format: SNIPPETS_FORMAT, version: 1, snippets: [{ name: "__proto__", body: "x" }] }),
    ];
    for (const file of hostile) {
      const { handlers, imported, current } = setup({ file });
      handlers.messages["snippets.importDialog"]({});
      await flush();
      const [result] = imported;
      expect([file, result?.ok]).toEqual([file, false]);
      if (result && !result.ok) expect(result.detail.length).toBeGreaterThan(0);
      expect(current()).toEqual([record()]);
    }
  });

  test("a cancelled open dialog reports nothing at all", async () => {
    const { handlers, imported } = setup({ chosen: [] });
    handlers.messages["snippets.importDialog"]({});
    await flush();
    expect(imported).toEqual([]);
  });

  test("exportDialog writes the documented format and reports the path", async () => {
    const { handlers, exported, written } = setup();
    handlers.messages["snippets.exportDialog"]({ snippets: [record()] });
    await flush();
    expect(exported).toEqual([{ ok: true, path: "/tmp/out.json" }]);
    expect(JSON.parse(written[0]?.content ?? "null")).toEqual({
      format: SNIPPETS_FORMAT,
      version: SNIPPETS_VERSION,
      snippets: [record()],
    });
  });

  test("a cancelled save dialog reports cancellation rather than a failure", async () => {
    const { handlers, exported, written } = setup({ savePath: null });
    handlers.messages["snippets.exportDialog"]({ snippets: [record()] });
    await flush();
    expect(exported).toEqual([{ cancelled: true }]);
    expect(written).toEqual([]);
  });

  // The four branches the eight cases above leave unexercised. Each is a path an ordinary user reaches (a huge
  // file, an unreadable one, a dialog that errors, a disk that refuses the write), so each gets its own test.

  test("a file too large to be a library is refused, at the documented cap", async () => {
    // Valid JSON, and a valid library, but padded past the cap. R-M5b-S2: the refusal is the *reader's* now, so
    // this asserts the cap the handler hands it as well as the outcome -- widening that cap, or dropping it,
    // imports this file instead of refusing it. That the refusal costs no read is proved against the real reader
    // in test/files/bounded-read.test.ts, which this fake cannot show.
    const padded = `${library([record({ id: "i1", name: "brandnew" })])}${" ".repeat(5 * 1024 * 1024)}`;
    const { handlers, imported, current, readFile } = setup({ file: padded });
    handlers.messages["snippets.importDialog"]({});
    await flush();
    expect(imported).toEqual([{ ok: false, reason: "tooLarge", detail: strings.snippets.tooLarge }]);
    expect(readFile.mock.calls[0]).toEqual(["/tmp/library.json", MAX_SNIPPETS_FILE_BYTES]);
    expect(current()).toEqual([record()]);
  });

  test("a file that cannot be read is reported, not thrown", async () => {
    const imported: SnippetsImported[] = [];
    const handlers = createSnippetHandlers({
      snippets: { snippets: [record()], save: mock(async (next: Snippet[]) => next) },
      openDialog: async () => ["/tmp/library.json"],
      saveDialog: async () => null,
      readFile: async () => {
        throw new Error("EACCES: permission denied");
      },
      writeFile: async () => {},
      documentsDir: "/docs",
      send: { imported: (p) => imported.push(p), exported: () => {} },
      log: () => {},
    });
    handlers.messages["snippets.importDialog"]({});
    await flush();
    expect(imported).toEqual([{ ok: false, reason: "unreadable", detail: "EACCES: permission denied" }]);
  });

  test("an export dialog that fails is reported as an error, and nothing is written", async () => {
    const exported: SnippetsExported[] = [];
    const written: { path: string; content: string }[] = [];
    const handlers = createSnippetHandlers({
      snippets: { snippets: [record()], save: mock(async (next: Snippet[]) => next) },
      openDialog: async () => [],
      saveDialog: async () => {
        throw new Error("osascript exited with 1");
      },
      readFile: async () => "",
      writeFile: async (path: string, content: string) => void written.push({ path, content }),
      documentsDir: "/docs",
      send: { imported: () => {}, exported: (p) => exported.push(p) },
      log: () => {},
    });
    handlers.messages["snippets.exportDialog"]({ snippets: [record()] });
    await flush();
    expect(exported).toEqual([{ ok: false, error: "osascript exited with 1" }]);
    expect(written).toEqual([]);
  });

  test("an export whose write fails is reported as an error rather than a success", async () => {
    const exported: SnippetsExported[] = [];
    const handlers = createSnippetHandlers({
      snippets: { snippets: [record()], save: mock(async (next: Snippet[]) => next) },
      openDialog: async () => [],
      saveDialog: async () => "/tmp/out.json",
      readFile: async () => "",
      writeFile: async () => {
        throw new Error("ENOSPC: no space left on device");
      },
      documentsDir: "/docs",
      send: { imported: () => {}, exported: (p) => exported.push(p) },
      log: () => {},
    });
    handlers.messages["snippets.exportDialog"]({ snippets: [record()] });
    await flush();
    expect(exported).toEqual([{ ok: false, error: "ENOSPC: no space left on device" }]);
  });
});
