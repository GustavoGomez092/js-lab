import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { listVsixThemes, readVsixTheme } from "../../src/main/themes/vsix";

interface Member {
  name: string;
  data: Uint8Array;
  /** Replaces the body bytes while both headers keep describing `data` — used to corrupt a deflate stream. */
  rawBody?: Uint8Array;
}

/**
 * A byte-level zip builder kept deliberately separate from the one in zip.test.ts.
 *
 * The two suites do not share a helper module on purpose: a change made to one builder can then never silently
 * weaken the other suite's assertions. This one stays minimal — every member is deflated and only the body is
 * overridable — because this suite is about manifest handling, not about the reader's own refusals.
 */
function buildZip(members: Member[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = encoder.encode(member.name);
    const body = member.rawBody ?? new Uint8Array(deflateRawSync(member.data));

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

const text = (value: string) => new TextEncoder().encode(value);
const manifest = (contributes: unknown) => text(JSON.stringify({ name: "pack", contributes }));

/** Asserts a refusal and returns its message, so every refusal test pins the exact string it produced. */
function refusalOf(result: { ok: true } | { ok: false; error: string }): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

describe("listVsixThemes", () => {
  test("reads contributes.themes and defaults a missing label and uiTheme", () => {
    const vsix = buildZip([
      {
        name: "extension/package.json",
        data: manifest({
          themes: [
            // uiTheme is deliberately NOT the default here: asserting the default against an entry that declares
            // "vs-dark" would pass just as well if the field were ignored outright.
            { label: "Deep Dark", uiTheme: "vs", path: "./themes/deep.json" },
            { path: "themes/plain.json" },
          ],
        }),
      },
      { name: "extension/themes/deep.json", data: text("{}") },
      { name: "extension/themes/plain.json", data: text("{}") },
    ]);
    const result = listVsixThemes(vsix);
    if (!result.ok) throw new Error(result.error);
    expect(result.themes).toEqual([
      { label: "Deep Dark", uiTheme: "vs", path: "extension/themes/deep.json" },
      { label: "plain", uiTheme: "vs-dark", path: "extension/themes/plain.json" },
    ]);
  });

  test("accepts a declared path that already names the archive entry", () => {
    const vsix = buildZip([
      {
        name: "extension/package.json",
        data: manifest({ themes: [{ label: "Full", path: "extension/themes/full.json" }] }),
      },
      { name: "extension/themes/full.json", data: text("{}") },
    ]);
    const result = listVsixThemes(vsix);
    if (!result.ok) throw new Error(result.error);
    expect(result.themes).toEqual([{ label: "Full", uiTheme: "vs-dark", path: "extension/themes/full.json" }]);
  });

  test("trims whitespace around a declared path, label and uiTheme", () => {
    const vsix = buildZip([
      {
        name: "extension/package.json",
        data: manifest({ themes: [{ label: "  Padded  ", uiTheme: "  vs  ", path: "  ./themes/pad.json  " }] }),
      },
      { name: "extension/themes/pad.json", data: text("{}") },
    ]);
    const result = listVsixThemes(vsix);
    if (!result.ok) throw new Error(result.error);
    expect(result.themes).toEqual([{ label: "Padded", uiTheme: "vs", path: "extension/themes/pad.json" }]);
  });

  test("falls back to the file name when the label or uiTheme is blank, ignoring case in the extension", () => {
    const vsix = buildZip([
      {
        name: "extension/package.json",
        data: manifest({ themes: [{ label: "   ", uiTheme: "   ", path: "./themes/Blank.JSON" }] }),
      },
      { name: "extension/themes/Blank.JSON", data: text("{}") },
    ]);
    const result = listVsixThemes(vsix);
    if (!result.ok) throw new Error(result.error);
    expect(result.themes).toEqual([{ label: "Blank", uiTheme: "vs-dark", path: "extension/themes/Blank.JSON" }]);
  });

  test("skips contributions that are not objects or whose path is not a string", () => {
    const vsix = buildZip([
      {
        name: "extension/package.json",
        data: manifest({
          themes: [null, 42, "themes/str.json", [], { label: "no path" }, { path: 7 }, { path: "./themes/ok.json" }],
        }),
      },
      { name: "extension/themes/ok.json", data: text("{}") },
    ]);
    const result = listVsixThemes(vsix);
    if (!result.ok) throw new Error(result.error);
    expect(result.themes).toEqual([{ label: "ok", uiTheme: "vs-dark", path: "extension/themes/ok.json" }]);
  });

  test("skips a declared theme whose file is absent, and refuses when none are left", () => {
    const present = buildZip([
      {
        name: "extension/package.json",
        data: manifest({ themes: [{ path: "./themes/here.json" }, { path: "./themes/gone.json" }] }),
      },
      { name: "extension/themes/here.json", data: text("{}") },
    ]);
    const result = listVsixThemes(present);
    if (!result.ok) throw new Error(result.error);
    expect(result.themes).toEqual([{ label: "here", uiTheme: "vs-dark", path: "extension/themes/here.json" }]);

    const allMissing = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ path: "./themes/gone.json" }] }) },
    ]);
    expect(refusalOf(listVsixThemes(allMissing))).toBe("That extension doesn't contain any colour themes.");
  });

  test("refuses the whole package when a theme path escapes the extension folder", () => {
    const vsix = buildZip([
      {
        name: "extension/package.json",
        data: manifest({
          // The escaping entry is listed SECOND, behind a perfectly good one, so a reader that merely filtered the
          // bad entry out would still return a usable theme and look like it had worked.
          themes: [
            { label: "Fine", path: "./themes/fine.json" },
            { label: "Evil", path: "../../../../etc/passwd" },
          ],
        }),
      },
      { name: "extension/themes/fine.json", data: text("{}") },
    ]);
    // The exact string matters: "no colour themes" also matches /theme/i, so a loose assertion cannot tell a
    // refusal-to-escape apart from an entry that was quietly skipped.
    expect(refusalOf(listVsixThemes(vsix))).toBe("That extension declares a theme outside the package.");
  });

  test("refuses an absolute or drive-letter theme path", () => {
    const absolute = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ path: "/etc/passwd" }] }) },
    ]);
    expect(refusalOf(listVsixThemes(absolute))).toBe("That extension declares a theme outside the package.");

    const backslash = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ path: ".\\..\\..\\secret.json" }] }) },
    ]);
    expect(refusalOf(listVsixThemes(backslash))).toBe("That extension declares a theme outside the package.");
  });

  test("reports readable errors for a missing manifest, bad JSON and no themes", () => {
    const noManifest = buildZip([{ name: "extension/readme.md", data: text("hi") }]);
    expect(refusalOf(listVsixThemes(noManifest))).toBe("That .vsix doesn't contain an extension manifest.");

    const badJson = buildZip([{ name: "extension/package.json", data: text("{oops") }]);
    expect(refusalOf(listVsixThemes(badJson))).toBe("That extension's manifest isn't valid JSON.");

    const noContributes = buildZip([{ name: "extension/package.json", data: manifest({}) }]);
    expect(refusalOf(listVsixThemes(noContributes))).toBe("That extension doesn't contain any colour themes.");

    const emptyThemes = buildZip([{ name: "extension/package.json", data: manifest({ themes: [] }) }]);
    expect(refusalOf(listVsixThemes(emptyThemes))).toBe("That extension doesn't contain any colour themes.");

    const notAnObject = buildZip([{ name: "extension/package.json", data: text("[1,2]") }]);
    expect(refusalOf(listVsixThemes(notAnObject))).toBe("That extension doesn't contain any colour themes.");

    // `typeof null === "object"`, so a manifest of literal `null` is what catches a record guard that tests the
    // type but forgets the null. Without this the archive would reach `manifest.contributes` and throw.
    const nullManifest = buildZip([{ name: "extension/package.json", data: text("null") }]);
    expect(refusalOf(listVsixThemes(nullManifest))).toBe("That extension doesn't contain any colour themes.");

    const nullContributes = buildZip([{ name: "extension/package.json", data: manifest(null) }]);
    expect(refusalOf(listVsixThemes(nullContributes))).toBe("That extension doesn't contain any colour themes.");
  });

  test("a damaged archive produces a readable error rather than throwing", () => {
    expect(refusalOf(listVsixThemes(text("not a zip")))).toBe("That file isn't a valid .vsix archive.");
  });

  test("a corrupt manifest body is reported as a damaged archive, not as invalid JSON", () => {
    const vsix = buildZip([
      {
        name: "extension/package.json",
        data: manifest({ themes: [{ path: "./themes/d.json" }] }),
        rawBody: text("this is not a deflate stream"),
      },
    ]);
    expect(refusalOf(listVsixThemes(vsix))).toBe("That .vsix archive is damaged.");
  });

  test("an archive refusal never leaks the entry name or a path separator", () => {
    // zip.ts keeps the offending name on ZipError.entryName rather than in the message. This module forwards the
    // message to the UI verbatim, so the property is re-asserted here, at the boundary where a leak would surface.
    const unsafeName = buildZip([{ name: "../../../etc/passwd", data: text("{}") }]);
    const unsafe = refusalOf(listVsixThemes(unsafeName));
    expect(unsafe).toBe("That archive contains an entry with an unsafe path.");
    expect(unsafe.includes("/")).toBe(false);
    expect(unsafe.includes("passwd")).toBe(false);

    const duplicated = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [] }) },
      { name: "extension/package.json", data: manifest({ themes: [] }) },
    ]);
    const duplicate = refusalOf(listVsixThemes(duplicated));
    expect(duplicate).toBe("That archive contains two entries with the same name.");
    expect(duplicate.includes("/")).toBe(false);
  });
});

describe("readVsixTheme", () => {
  test("reads a declared theme file", () => {
    const vsix = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ label: "D", path: "./themes/d.json" }] }) },
      { name: "extension/themes/d.json", data: text('{"name":"D","type":"dark"}') },
    ]);
    const result = readVsixTheme(vsix, "extension/themes/d.json");
    if (!result.ok) throw new Error(result.error);
    expect(result.json).toEqual({ name: "D", type: "dark" });
  });

  test("refuses a path that was never declared by the manifest", () => {
    const vsix = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ label: "D", path: "./themes/d.json" }] }) },
      { name: "extension/themes/d.json", data: text("{}") },
      { name: "extension/secret.json", data: text('{"secret":true}') },
    ]);
    // Present in the archive, absent from the manifest: being readable is not the same as being offered.
    expect(refusalOf(readVsixTheme(vsix, "extension/secret.json"))).toBe(
      "That theme isn't part of the selected extension.",
    );
    expect(refusalOf(readVsixTheme(vsix, "../../../../etc/passwd"))).toBe(
      "That theme isn't part of the selected extension.",
    );
  });

  test("reports a theme file that isn't valid JSON", () => {
    const vsix = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ path: "./themes/d.json" }] }) },
      { name: "extension/themes/d.json", data: text("{not json") },
    ]);
    expect(refusalOf(readVsixTheme(vsix, "extension/themes/d.json"))).toBe("That theme file isn't valid JSON.");
  });

  test("passes the listing's own refusal through unchanged", () => {
    const noManifest = buildZip([{ name: "extension/readme.md", data: text("hi") }]);
    expect(refusalOf(readVsixTheme(noManifest, "extension/themes/d.json"))).toBe(
      "That .vsix doesn't contain an extension manifest.",
    );
  });

  test("a corrupt theme body is reported as a damaged archive, not as invalid JSON", () => {
    const vsix = buildZip([
      { name: "extension/package.json", data: manifest({ themes: [{ path: "./themes/d.json" }] }) },
      {
        name: "extension/themes/d.json",
        data: text("{}"),
        rawBody: text("this is not a deflate stream"),
      },
    ]);
    expect(refusalOf(readVsixTheme(vsix, "extension/themes/d.json"))).toBe("That .vsix archive is damaged.");
  });
});
