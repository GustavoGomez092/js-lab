import { describe, expect, mock, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import type { ThemeDefinition } from "@jslab/themes";
import { createThemeHandlers, MAX_IMPORT_BYTES, type ThemeHandlerDeps } from "../../src/main/rpc/theme-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";
import { strings } from "../../src/main/strings";
import { ZIP_LIMITS } from "../../src/main/themes/zip";

const encode = (value: string) => new TextEncoder().encode(value);

const themeFile = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name: "Deep Dark", type: "dark", colors: { "editor.background": "#101010" }, ...extra });

/**
 * A byte-level zip builder, deliberately local rather than shared with `test/themes/`: a change made to one
 * builder must never be able to silently weaken another suite's assertions.
 */
function buildZip(members: { name: string; data: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = encoder.encode(member.name);
    const body = new Uint8Array(deflateRawSync(member.data));
    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, 8, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, member.data.length, true);
    local.setUint16(26, name.length, true);
    const localBytes = new Uint8Array(30 + name.length + body.length);
    localBytes.set(new Uint8Array(local.buffer), 0);
    localBytes.set(name, 30);
    localBytes.set(body, 30 + name.length);
    locals.push(localBytes);

    const central = new DataView(new ArrayBuffer(46 + name.length));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(10, 8, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, member.data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    const centralBytes = new Uint8Array(46 + name.length);
    centralBytes.set(new Uint8Array(central.buffer), 0);
    centralBytes.set(name, 46);
    centrals.push(centralBytes);
    offset += localBytes.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, members.length, true);
  eocd.setUint16(10, members.length, true);
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const vsix = (themes: unknown, files: Record<string, string> = {}) =>
  buildZip([
    { name: "extension/package.json", data: encode(JSON.stringify({ name: "pack", contributes: { themes } })) },
    ...Object.entries(files).map(([name, body]) => ({ name, data: encode(body) })),
  ]);

function setup(overrides: Partial<ThemeHandlerDeps> = {}) {
  const saved: ThemeDefinition[] = [];
  const changed: ThemeDefinition[][] = [];
  const logs: { message: string; detail: unknown }[] = [];
  const deps: ThemeHandlerDeps = {
    store: {
      get themes() {
        return saved;
      },
      save: mock(async (theme: ThemeDefinition) => {
        saved.push(theme);
      }),
    },
    openDialog: mock(async () => ["/Users/me/theme.json"]),
    fileSize: mock(async () => null),
    readFileBytes: mock(async () => encode(themeFile())),
    onChanged: mock((all: readonly ThemeDefinition[]) => {
      changed.push([...all]);
    }),
    log: mock((message: string, detail?: unknown) => {
      logs.push({ message, detail });
    }),
    ...overrides,
  };
  return { deps, saved, changed, logs, handlers: createThemeHandlers(deps) };
}

/** Asserts a refusal and hands back its message, so every refusal test pins the exact string it produced. */
function refusalOf(result: { ok: true } | { ok: false; error: string }): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

describe("theme.import", () => {
  test("the import bound IS the zip reader's own total, so the two can never disagree", () => {
    // The ledger's inconsistent-bounds ruling. Every other test here spells the bound as this symbol and would
    // follow it anywhere it moved, so the value itself is pinned once, here: restating it as the plan's 64 MiB
    // would accept archives `openZip` then certainly refuses.
    expect(MAX_IMPORT_BYTES).toBe(ZIP_LIMITS.maxTotalBytes);
    expect(MAX_IMPORT_BYTES).toBe(16 * 1024 * 1024);
  });

  test("a file of exactly the bound is imported; one byte past it is refused", async () => {
    const exact = setup({ fileSize: mock(async () => MAX_IMPORT_BYTES) });
    expect((await exact.handlers.requests["theme.import"]({})).ok).toBe(true);
    const over = setup({ fileSize: mock(async () => MAX_IMPORT_BYTES + 1) });
    expect(refusalOf(await over.handlers.requests["theme.import"]({}))).toBe(strings.themes.tooLarge);
  });

  test("converts and saves a .json theme, then reports it", async () => {
    const { handlers, saved, changed } = setup();
    const result = await handlers.requests["theme.import"]({});
    expect(result).toEqual({ ok: true, theme: { id: "deep-dark", name: "Deep Dark", type: "dark" }, notes: [] });
    expect(saved.map((theme) => theme.id)).toEqual(["deep-dark"]);
    // The registry is told the whole set, after the save, so the menu and both windows see the new theme.
    expect(changed).toEqual([[saved[0] as ThemeDefinition]]);
  });

  test("a file with no name of its own is named after the file it came from", async () => {
    const { handlers, saved } = setup({
      openDialog: mock(async () => ["/Users/me/Themes/Midnight Owl.json"]),
      readFileBytes: mock(async () => encode(JSON.stringify({ type: "dark", colors: {} }))),
    });
    await handlers.requests["theme.import"]({});
    expect(saved.map((theme) => theme.name)).toEqual(["Midnight Owl"]);
  });

  test("a cancelled dialog is not an error, saves nothing and tells nobody", async () => {
    const { handlers, saved, changed } = setup({ openDialog: mock(async () => []) });
    expect(await handlers.requests["theme.import"]({})).toEqual({ ok: false, error: "" });
    expect([saved, changed]).toEqual([[], []]);
  });

  test("an unreadable file reports a readable line and keeps the raw cause in the log (spec §9.3, §18)", async () => {
    const { handlers, logs, saved } = setup({
      readFileBytes: mock(async () => {
        throw new Error("EACCES: /Users/me/private/theme.json");
      }),
    });
    const error = refusalOf(await handlers.requests["theme.import"]({}));
    expect(error).toBe(strings.themes.unreadable);
    // The user-facing line never carries a path; the path is exactly what the log is for.
    expect(error).not.toMatch(/[/\\]/);
    expect(logs[0]?.message).toBe(strings.log.themeUnreadable);
    expect(String(logs[0]?.detail)).toContain("/Users/me/private/theme.json");
    expect(saved).toEqual([]);
  });

  test("a file that isn't JSON, and JSON that isn't a theme, are refused differently", async () => {
    const notJson = setup({ readFileBytes: mock(async () => encode("{not json")) });
    expect(refusalOf(await notJson.handlers.requests["theme.import"]({}))).toBe(strings.themes.notJson);

    const notATheme = setup({ readFileBytes: mock(async () => encode("[1, 2, 3]")) });
    const error = refusalOf(await notATheme.handlers.requests["theme.import"]({}));
    // The converter's own refusal, not the parser's: these must not collapse into one message.
    expect(error).not.toBe(strings.themes.notJson);
    expect(error.length).toBeGreaterThan(0);
    expect(notATheme.saved).toEqual([]);
  });

  test("a failing save is never relabelled as invalid JSON", async () => {
    const { handlers } = setup({
      store: {
        themes: [],
        save: mock(async () => {
          throw new Error("EROFS: read-only file system");
        }),
      },
    });
    // The file parsed perfectly well; reporting "isn't a valid VS Code theme" would send the user hunting for a
    // syntax error that does not exist.
    expect(handlers.requests["theme.import"]({})).rejects.toThrow("EROFS");
  });

  test("an oversized file is refused BEFORE it is read into memory (R-M5d-B3)", async () => {
    const readFileBytes = mock(async () => encode(themeFile()));
    const { handlers, saved } = setup({
      fileSize: mock(async () => MAX_IMPORT_BYTES + 1),
      readFileBytes,
    });
    expect(refusalOf(await handlers.requests["theme.import"]({}))).toBe(strings.themes.tooLarge);
    // The whole point of the stat: the bound is applied to the allocation it guards, not after it.
    expect(readFileBytes).not.toHaveBeenCalled();
    expect(saved).toEqual([]);
  });

  test("a file that grows past the bound after the stat is still refused", async () => {
    const { handlers } = setup({
      // Size unknown up front, so only the post-read check can catch it -- which is why it is still there.
      fileSize: mock(async () => null),
      readFileBytes: mock(async () => new Uint8Array(MAX_IMPORT_BYTES + 1)),
    });
    expect(refusalOf(await handlers.requests["theme.import"]({}))).toBe(strings.themes.tooLarge);
  });

  test("a theme whose name slugs onto a built-in is refused instead of silently disappearing", async () => {
    const { handlers, saved, changed } = setup({
      readFileBytes: mock(async () => encode(JSON.stringify({ name: "Graphite", type: "dark", colors: {} }))),
    });
    expect(refusalOf(await handlers.requests["theme.import"]({}))).toBe(strings.themes.builtinName);
    // Task 4 finding 1: the old behaviour wrote the file and reported success, then `listThemes` hid it forever.
    expect([saved, changed]).toEqual([[], []]);
  });

  test("notes report what the conversion could not carry across, and stay silent when nothing was lost", async () => {
    const lost = setup({
      readFileBytes: mock(async () =>
        encode(
          themeFile({
            semanticTokenColors: { variable: "#ABCDEF" },
            tokenColors: [{ scope: "comment", settings: { foreground: "#111111" } }],
          }),
        ),
      ),
    });
    const result = await lost.handlers.requests["theme.import"]({});
    expect(result.ok && "notes" in result ? result.notes : null).toEqual([
      strings.themes.lowContrastSyntax,
      strings.themes.semanticDropped,
    ]);

    // A theme that loses nothing says nothing: the notes must be driven by the file, not attached to every import.
    const kept = setup({
      readFileBytes: mock(async () =>
        encode(themeFile({ tokenColors: [{ scope: "comment", settings: { foreground: "#EEEEEE" } }] })),
      ),
    });
    const clean = await kept.handlers.requests["theme.import"]({});
    expect(clean.ok && "notes" in clean ? clean.notes : null).toEqual([]);
  });
});

describe("theme.import of a .vsix", () => {
  const oneTheme = () =>
    vsix([{ label: "Deep Dark", path: "./themes/deep.json" }], { "extension/themes/deep.json": themeFile() });
  const twoThemes = () =>
    vsix(
      [
        { label: "Deep Dark", path: "./themes/deep.json" },
        { label: "Pale Light", path: "./themes/pale.json" },
      ],
      {
        "extension/themes/deep.json": themeFile(),
        // Deliberately nameless: the only thing that can name this theme is the label its manifest declared, so
        // the assertions below actually exercise that label rather than the theme file's own `name`.
        "extension/themes/pale.json": JSON.stringify({ type: "light", colors: {} }),
      },
    );

  const vsixDeps = (bytes: Uint8Array, overrides: Partial<ThemeHandlerDeps> = {}) =>
    setup({
      openDialog: mock(async () => ["/Users/me/pack.vsix"]),
      readFileBytes: mock(async () => bytes),
      ...overrides,
    });

  test("the .vsix extension is recognised whatever its case", async () => {
    const { handlers, saved } = vsixDeps(oneTheme(), { openDialog: mock(async () => ["/Users/me/Pack.VSIX"]) });
    // Without the case fold these bytes are handed to JSON.parse instead, and a zip archive is not JSON.
    expect((await handlers.requests["theme.import"]({})).ok).toBe(true);
    expect(saved).toHaveLength(1);
  });

  test("a .vsix declaring one theme imports it directly, under the label the manifest gave it", async () => {
    const { handlers, saved } = vsixDeps(oneTheme());
    const result = await handlers.requests["theme.import"]({});
    expect(result).toEqual({ ok: true, theme: { id: "deep-dark", name: "Deep Dark", type: "dark" }, notes: [] });
    expect(saved).toHaveLength(1);
  });

  test("a .vsix declaring several offers a choice and imports the one that is picked", async () => {
    const { handlers, saved } = vsixDeps(twoThemes());
    const offered = await handlers.requests["theme.import"]({});
    expect(offered.ok && "choices" in offered ? offered.choices : null).toEqual([
      { label: "Deep Dark", path: "extension/themes/deep.json" },
      { label: "Pale Light", path: "extension/themes/pale.json" },
    ]);
    // Nothing is imported until the user chooses.
    expect(saved).toEqual([]);
    if (!offered.ok || !("token" in offered)) throw new Error("expected a choice");

    const picked = await handlers.requests["theme.importPick"]({
      token: offered.token,
      path: "extension/themes/pale.json",
    });
    expect(picked).toEqual({ ok: true, theme: { id: "pale-light", name: "Pale Light", type: "light" }, notes: [] });
    expect(saved.map((theme) => theme.id)).toEqual(["pale-light"]);
  });

  test("a successful pick consumes the token, but a refused one leaves the archive pickable", async () => {
    const { handlers } = vsixDeps(twoThemes());
    const offered = await handlers.requests["theme.import"]({});
    if (!offered.ok || !("token" in offered)) throw new Error("expected a choice");

    // An entry the manifest never declared is refused without consuming the archive...
    const undeclared = await handlers.requests["theme.importPick"]({
      token: offered.token,
      path: "extension/themes/nope.json",
    });
    expect(undeclared.ok).toBe(false);
    // ...so the user can still pick a real one instead of having to reopen the file dialog.
    const second = await handlers.requests["theme.importPick"]({
      token: offered.token,
      path: "extension/themes/deep.json",
    });
    expect(second.ok).toBe(true);
    // The successful pick did consume it.
    const third = await handlers.requests["theme.importPick"]({
      token: offered.token,
      path: "extension/themes/pale.json",
    });
    expect(refusalOf(third)).toBe(strings.themes.pickExpired);
  });

  test("a refusal from the conversion itself also leaves the archive pickable", async () => {
    const pack = vsix(
      [
        { label: "Graphite", path: "./themes/graphite.json" },
        { label: "Deep Dark", path: "./themes/deep.json" },
      ],
      {
        "extension/themes/graphite.json": JSON.stringify({ name: "Graphite", type: "dark", colors: {} }),
        "extension/themes/deep.json": themeFile(),
      },
    );
    const { handlers, saved } = vsixDeps(pack);
    const offered = await handlers.requests["theme.import"]({});
    if (!offered.ok || !("token" in offered)) throw new Error("expected a choice");

    // This refusal comes out of `commit`, past the archive read. The undeclared-entry test above returns earlier
    // than that, so this is the only case that reaches -- and therefore pins -- the `if (result.ok)` on the delete.
    const refused = await handlers.requests["theme.importPick"]({
      token: offered.token,
      path: "extension/themes/graphite.json",
    });
    expect(refusalOf(refused)).toBe(strings.themes.builtinName);

    const second = await handlers.requests["theme.importPick"]({
      token: offered.token,
      path: "extension/themes/deep.json",
    });
    expect(second.ok).toBe(true);
    expect(saved.map((theme) => theme.id)).toEqual(["deep-dark"]);
  });

  test("a damaged .vsix is refused without ever quoting an entry name or a path separator", async () => {
    // The invariant `zip.ts` holds and `vsix.ts` forwards: the offending name travels on `ZipError.entryName`,
    // for the log, and never in the message. Asserted here because this is where a leak would reach a user.
    const damaged = vsixDeps(encode("PK not really an archive"));
    expect(refusalOf(await damaged.handlers.requests["theme.import"]({}))).not.toMatch(/[/\\]/);

    const unsafe = vsixDeps(buildZip([{ name: "extension/../../../etc/passwd", data: encode("{}") }]));
    const error = refusalOf(await unsafe.handlers.requests["theme.import"]({}));
    expect(error).not.toMatch(/[/\\]/);
    expect(error).not.toContain("passwd");

    const noThemes = vsixDeps(vsix([]));
    expect(refusalOf(await noThemes.handlers.requests["theme.import"]({}))).not.toMatch(/[/\\]/);
  });

  test("theme.importPick refuses an unknown token and rejects a malformed payload", async () => {
    const { handlers } = setup();
    const unknown = await handlers.requests["theme.importPick"]({
      token: crypto.randomUUID(),
      path: "extension/a.json",
    });
    expect(refusalOf(unknown)).toBe(strings.themes.pickExpired);

    // Spec §18: the payload is validated before anything looks at it.
    expect(handlers.requests["theme.importPick"]({ token: "not-a-uuid", path: "x" })).rejects.toThrow(
      InvalidPayloadError,
    );
    expect(handlers.requests["theme.importPick"]({ token: crypto.randomUUID(), path: 42 })).rejects.toThrow(
      InvalidPayloadError,
    );
    // `emptyParamsSchema` is `z.object({})`, which strips unknown keys rather than refusing them -- the same
    // contract every other no-parameter request in this app has. What it does refuse is a payload that is not an
    // object at all, which is the part worth pinning here.
    expect(handlers.requests["theme.import"]("nope")).rejects.toThrow(InvalidPayloadError);
  });
});
