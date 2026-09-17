import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import { isSafeEntryName, openZip, ZIP_LIMITS, ZipError } from "../../src/main/themes/zip";

interface Member {
  name: string;
  data: Uint8Array;
  store?: boolean;
  declaredSize?: number;
  /**
   * Writes this compression method into both headers without changing how the body is encoded. Declaring the method
   * here keeps the unsupported-method test free of byte arithmetic: an offset computed from a name length silently
   * patches a different field the moment a fixture name changes length.
   */
  method?: number;
  /** Replaces the body bytes while both headers keep describing `data` — used to corrupt a deflate stream. */
  rawBody?: Uint8Array;
  /** An extra field on the central-directory record, as real archives routinely carry. */
  extra?: Uint8Array;
  /** A comment on the central-directory record. */
  comment?: Uint8Array;
  /** An extra field on the local header, which sits between the name and the body. */
  localExtra?: Uint8Array;
  /** Overstates the compressed size in both headers, so the body appears to run past the end of the file. */
  declaredCompressedSize?: number;
  /** Writes a wrong signature on the central-directory record, leaving every other field valid. */
  badSignature?: boolean;
  /** Overstates the central record's comment length, so the walk is told to jump past the end of the file. */
  declaredCommentLength?: number;
}

/** Builds a minimal but real zip: local headers, then a central directory, then an EOCD. */
function buildZip(members: Member[], entryCountOverride?: number): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = encoder.encode(member.name);
    const body = member.rawBody ?? (member.store ? member.data : new Uint8Array(deflateRawSync(member.data)));
    const method = member.method ?? (member.store ? 0 : 8);
    const declaredSize = member.declaredSize ?? member.data.length;
    const extra = member.extra ?? new Uint8Array(0);
    const comment = member.comment ?? new Uint8Array(0);
    const localExtra = member.localExtra ?? new Uint8Array(0);
    const compressedSize = member.declaredCompressedSize ?? body.length;

    const local = new DataView(new ArrayBuffer(30 + name.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(8, method, true);
    local.setUint32(18, compressedSize, true);
    local.setUint32(22, declaredSize, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, localExtra.length, true);
    const localBytes = new Uint8Array(30 + name.length + localExtra.length + body.length);
    localBytes.set(new Uint8Array(local.buffer), 0);
    localBytes.set(name, 30);
    localBytes.set(localExtra, 30 + name.length);
    localBytes.set(body, 30 + name.length + localExtra.length);
    locals.push(localBytes);

    const central = new DataView(new ArrayBuffer(46 + name.length));
    central.setUint32(0, member.badSignature ? 0x02014b51 : 0x02014b50, true);
    central.setUint16(10, method, true);
    central.setUint32(20, compressedSize, true);
    central.setUint32(24, declaredSize, true);
    central.setUint16(28, name.length, true);
    central.setUint16(30, extra.length, true);
    central.setUint16(32, member.declaredCommentLength ?? comment.length, true);
    central.setUint32(42, offset, true);
    const centralBytes = new Uint8Array(46 + name.length + extra.length + comment.length);
    centralBytes.set(new Uint8Array(central.buffer), 0);
    centralBytes.set(name, 46);
    centralBytes.set(extra, 46 + name.length);
    centralBytes.set(comment, 46 + name.length + extra.length);
    centrals.push(centralBytes);
    offset += localBytes.length;
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entryCountOverride ?? members.length, true);
  eocd.setUint16(10, entryCountOverride ?? members.length, true);
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

/**
 * Rewrites the EOCD's central-directory offset. Safe where a central-directory patch is not: the EOCD is a
 * fixed 22 bytes and `buildZip` never writes a comment, so it is always exactly the final 22 bytes.
 */
function patchEocdOffset(zip: Uint8Array, value: number): void {
  new DataView(zip.buffer, zip.byteOffset, zip.byteLength).setUint32(zip.length - 22 + 16, value, true);
}

const text = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

describe("isSafeEntryName", () => {
  test("accepts ordinary archive paths", () => {
    for (const name of ["extension/package.json", "extension/themes/dark.json", "a", "a/b/c.json"]) {
      expect(`${name}:${isSafeEntryName(name)}`).toBe(`${name}:true`);
    }
  });

  test("rejects every traversal and absolute form", () => {
    for (const name of [
      "",
      "../evil.json",
      "extension/../../evil.json",
      "extension/./dark.json",
      "/etc/passwd",
      "//server/share/x",
      "C:/Windows/system32",
      "c:\\Windows\\system32",
      "extension\\themes\\dark.json",
      "extension/themes/\u0000dark.json",
      "extension/themes/\u0001dark.json",
      "..",
      `${"a".repeat(600)}.json`,
    ]) {
      expect(`${JSON.stringify(name)}:${isSafeEntryName(name)}`).toBe(`${JSON.stringify(name)}:false`);
    }
  });

  test("the 512 limit counts UTF-8 bytes, not UTF-16 code units", () => {
    // 200 three-byte characters is 600 bytes but only 200 code units: a code-unit comparison would wave it through.
    expect(isSafeEntryName("\u306e".repeat(200))).toBe(false);
    expect(isSafeEntryName("\u306e".repeat(100))).toBe(true);
    // The exact boundary, in ASCII where one character is one byte.
    expect(isSafeEntryName("a".repeat(512))).toBe(true);
    expect(isSafeEntryName("a".repeat(513))).toBe(false);
  });
});

describe("ZIP_LIMITS", () => {
  test("pins the shipped bounds, which are the security contract", () => {
    expect(ZIP_LIMITS).toEqual({
      maxEntries: 2000,
      maxEntryBytes: 2 * 1024 * 1024,
      maxTotalBytes: 16 * 1024 * 1024,
      maxRatio: 200,
    });
  });
});

describe("openZip", () => {
  test("reads stored and deflated members", () => {
    const zip = openZip(
      buildZip([
        { name: "extension/package.json", data: text('{"name":"x"}') },
        { name: "extension/themes/dark.json", data: text('{"name":"Dark"}'), store: true },
      ]),
    );
    expect(zip.names()).toEqual(["extension/package.json", "extension/themes/dark.json"]);
    expect(zip.has("extension/package.json")).toBe(true);
    expect(zip.has("nope")).toBe(false);
    expect(decode(zip.read("extension/themes/dark.json"))).toBe('{"name":"Dark"}');
    expect(decode(zip.read("extension/package.json"))).toBe('{"name":"x"}');
  });

  test("reads an archive handed in as a view into a larger buffer", () => {
    // Task 8 may pass a subarray; a DataView built without `byteOffset` would read the padding instead.
    const zip = buildZip([{ name: "extension/a.json", data: text('{"ok":true}') }]);
    const padded = new Uint8Array(zip.length + 11);
    padded.set(zip, 7);
    const view = padded.subarray(7, 7 + zip.length);
    expect(view.byteOffset).toBe(7);
    expect(decode(openZip(view).read("extension/a.json"))).toBe('{"ok":true}');
  });

  test("decodes a non-ASCII entry name and still finds its body", () => {
    // The local header's name length is in bytes; using the JS string length would misplace the data start.
    const name = "extension/th\u00e8mes/d\u00fcnkel.json";
    const zip = openZip(buildZip([{ name, data: text('{"n":1}') }]));
    expect(zip.names()).toEqual([name]);
    expect(decode(zip.read(name))).toBe('{"n":1}');
  });

  // The headline test: a malicious entry path must be refused, and must never become readable.
  test("refuses an archive containing a zip-slip entry", () => {
    const evil = buildZip([
      { name: "extension/package.json", data: text("{}") },
      { name: "../../../../etc/jslab-pwned.json", data: text("owned") },
    ]);
    expect(() => openZip(evil)).toThrow(ZipError);
    try {
      openZip(evil);
    } catch (error) {
      expect((error as Error).message).toContain("unsafe path");
    }
  });

  test("refuses absolute and backslash entry names too", () => {
    expect(() => openZip(buildZip([{ name: "/etc/passwd", data: text("x") }]))).toThrow(ZipError);
    expect(() => openZip(buildZip([{ name: "extension\\themes\\a.json", data: text("x") }]))).toThrow(ZipError);
  });

  test("refuses an unsafe DIRECTORY record, which carries no data and so is never read", () => {
    // A directory record ends in "/" and holds nothing, which is exactly why it is tempting to skip. Skipping its
    // name means an archive containing `../../../etc/` is accepted in full.
    const evil = buildZip([
      { name: "extension/package.json", data: text("{}") },
      { name: "../../../etc/", data: new Uint8Array(0), store: true },
    ]);
    expect(() => openZip(evil)).toThrow(ZipError);
    try {
      openZip(evil);
    } catch (error) {
      expect((error as Error).message).toContain("unsafe path");
    }
  });

  test("still accepts an ordinary directory record, and keeps it out of the entry list", () => {
    const zip = openZip(
      buildZip([
        { name: "extension/", data: new Uint8Array(0), store: true },
        { name: "extension/themes/", data: new Uint8Array(0), store: true },
        { name: "extension/package.json", data: text("{}") },
      ]),
    );
    expect(zip.names()).toEqual(["extension/package.json"]);
    expect(zip.has("extension/")).toBe(false);
  });

  test("refuses two entries sharing a name rather than picking one", () => {
    // Readers disagree about which record wins, so a duplicate can show one file to JSLab and another to a scanner.
    const ambiguous = buildZip([
      { name: "extension/package.json", data: text('{"real":true}') },
      { name: "extension/package.json", data: text('{"evil":true}') },
    ]);
    expect(() => openZip(ambiguous)).toThrow(ZipError);
  });

  test("caps the entry count", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      name: `extension/${index}.json`,
      data: text("{}"),
    }));
    expect(() =>
      openZip(buildZip(many), { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 4096, maxRatio: 200 }),
    ).toThrow(/too many entries/);
  });

  test("refuses a zip64 entry count before walking anything", () => {
    // A zip64 archive parks 0xFFFF in the 16-bit count; it trips the cap rather than being silently truncated.
    expect(() => openZip(buildZip([{ name: "extension/a.json", data: text("{}") }], 0xffff))).toThrow(
      /too many entries/,
    );
  });

  test("refuses a central directory that stops short of its declared count", () => {
    // The EOCD claims twelve records; only one is present, so the walk lands on the EOCD signature.
    expect(() => openZip(buildZip([{ name: "extension/a.json", data: text("{}") }], 12))).toThrow(ZipError);
  });

  test("refuses a central-directory offset that points past the end", () => {
    const zip = buildZip([{ name: "extension/a.json", data: text("{}") }], 0);
    patchEocdOffset(zip, zip.length);
    // With a count of zero the walk never runs, so only the offset check itself can refuse this.
    expect(() => openZip(zip)).toThrow(ZipError);
  });

  test("caps a single entry's declared size before inflating", () => {
    const big = buildZip([{ name: "extension/big.json", data: text("x".repeat(4096)) }]);
    expect(() => openZip(big, { maxEntries: 10, maxEntryBytes: 128, maxTotalBytes: 65536, maxRatio: 200 })).toThrow(
      /too large/,
    );
  });

  test("caps the total uncompressed size across entries", () => {
    const parts = Array.from({ length: 5 }, (_, index) => ({
      name: `extension/${index}.json`,
      data: text("y".repeat(300)),
    }));
    expect(() =>
      openZip(buildZip(parts), { maxEntries: 50, maxEntryBytes: 4096, maxTotalBytes: 1000, maxRatio: 500 }),
    ).toThrow(/too large/);
  });

  test("the per-entry and whole-archive size refusals are distinguishable", () => {
    // Both match /too large/, so without this the two messages could be swapped and every other test would pass.
    const oneBig = buildZip([{ name: "extension/big.json", data: text("x".repeat(4096)) }]);
    const manySmall = buildZip(
      Array.from({ length: 5 }, (_, index) => ({ name: `extension/${index}.json`, data: text("y".repeat(300)) })),
    );
    const perEntry = { maxEntries: 50, maxEntryBytes: 128, maxTotalBytes: 65536, maxRatio: 500 };
    const whole = { maxEntries: 50, maxEntryBytes: 4096, maxTotalBytes: 1000, maxRatio: 500 };
    expect(() => openZip(oneBig, perEntry)).toThrow("An entry in that archive is too large.");
    expect(() => openZip(manySmall, whole)).toThrow("That archive is too large to read.");
  });

  test("refuses a zip bomb by compression ratio", () => {
    const bomb = buildZip([{ name: "extension/bomb.json", data: text("\u0000".repeat(200_000)) }]);
    expect(() =>
      openZip(bomb, {
        maxEntries: 10,
        maxEntryBytes: 1024 * 1024,
        maxTotalBytes: 8 * 1024 * 1024,
        maxRatio: 50,
      }),
    ).toThrow(/compression ratio/);
  });

  test("refuses a member whose real inflated size disagrees with its header", () => {
    const lying = buildZip([{ name: "extension/a.json", data: text("hello world"), declaredSize: 4 }]);
    const zip = openZip(lying);
    expect(() => zip.read("extension/a.json")).toThrow(/didn't match/);
  });

  test("refuses junk and a truncated archive", () => {
    expect(() => openZip(text("not a zip at all"))).toThrow(ZipError);
    expect(() => openZip(new Uint8Array(0))).toThrow(ZipError);
    const good = buildZip([{ name: "extension/a.json", data: text("{}") }]);
    expect(() => openZip(good.slice(0, good.length - 10))).toThrow(ZipError);
  });

  test("refuses an unsupported compression method by name, without attempting it", () => {
    // Method 9 is deflate64. Declared through the builder, so no assertion here depends on a byte offset.
    const unsupported = buildZip([{ name: "extension/a.json", data: text("{}"), method: 9 }]);
    expect(() => openZip(unsupported)).toThrow(/unsupported compression method/);
    // A supported method in the same shape still opens, so the test above is about the method and nothing else.
    expect(openZip(buildZip([{ name: "extension/a.json", data: text("{}"), method: 8 }])).names()).toEqual([
      "extension/a.json",
    ]);
  });

  test("bounds the end-of-directory scan to the 65,535 bytes a comment may occupy", () => {
    const good = buildZip([{ name: "extension/a.json", data: text("{}") }]);
    const nearby = new Uint8Array(good.length + 100);
    nearby.set(good, 0);
    expect(openZip(nearby).names()).toEqual(["extension/a.json"]);

    const faraway = new Uint8Array(good.length + 70_000);
    faraway.set(good, 0);
    // Scanning the whole buffer would find it; a bounded scan refuses rather than walking an arbitrary file.
    expect(() => openZip(faraway)).toThrow(ZipError);
  });

  test("turns a corrupt deflate stream into a ZipError rather than a raw zlib error", () => {
    const corrupt = buildZip([
      { name: "extension/a.json", data: text('{"hello":"world"}'), rawBody: text("not a deflate stream") },
    ]);
    expect(() => openZip(corrupt).read("extension/a.json")).toThrow(ZipError);
  });

  test("returns stored bytes as a copy, not a window onto the archive", () => {
    const zip = openZip(buildZip([{ name: "extension/a.json", data: text("{}"), store: true }]));
    const first = zip.read("extension/a.json");
    first[0] = 0x21;
    expect(decode(zip.read("extension/a.json"))).toBe("{}");
  });

  test("walks past central-directory extra fields and comments", () => {
    // Real archives carry extra fields (timestamps, zip64). Mis-advancing past them desyncs the whole walk.
    const zip = openZip(
      buildZip([
        { name: "extension/a.json", data: text('{"a":1}'), extra: text("EXTRA-FIELD"), comment: text("hello") },
        { name: "extension/b.json", data: text('{"b":2}'), extra: text("XX") },
      ]),
    );
    expect(zip.names()).toEqual(["extension/a.json", "extension/b.json"]);
    expect(decode(zip.read("extension/b.json"))).toBe('{"b":2}');
  });

  test("locates the body after a local header's own extra field", () => {
    const zip = openZip(
      buildZip([{ name: "extension/a.json", data: text('{"deep":true}'), localExtra: text("PAD!") }]),
    );
    expect(decode(zip.read("extension/a.json"))).toBe('{"deep":true}');
  });

  test("refuses a header claiming zero compressed bytes for a non-empty entry", () => {
    // Storing 100 bytes in 0 is impossible, so the ratio is infinite and the entry is refused unread.
    const impossible = buildZip([
      { name: "extension/a.json", data: text("x".repeat(100)), rawBody: new Uint8Array(0) },
    ]);
    expect(() => openZip(impossible)).toThrow(/compression ratio/);
    // A genuinely empty stored entry is 0 of 0, which must still open.
    const empty = openZip(buildZip([{ name: "extension/empty.json", data: new Uint8Array(0), store: true }]));
    expect(empty.names()).toEqual(["extension/empty.json"]);
    expect(empty.read("extension/empty.json").length).toBe(0);
  });

  test("bounds inflation while it runs, not after it has already allocated", () => {
    // The header understates the size, so nothing refuses this entry up front. maxOutputLength has to stop the
    // inflate itself: without it the 3 MiB would be allocated in full and only then fail the size comparison.
    const understated = buildZip([
      { name: "extension/a.json", data: text(" ".repeat(3 * 1024 * 1024)), declaredSize: 100 },
    ]);
    expect(() => openZip(understated).read("extension/a.json")).toThrow("That .vsix archive is damaged.");
  });

  test("refuses a body that would run past the end of the file", () => {
    // The header claims far more compressed bytes than the file holds. The message matters: without the bounds
    // check the subarray is silently clamped and the read falls through to the size comparison instead, which
    // also throws — so asserting only "it throws" would not notice the check disappearing.
    const overstated = buildZip([
      { name: "extension/a.json", data: text("{}"), store: true, declaredCompressedSize: 10_000 },
    ]);
    expect(() => openZip(overstated).read("extension/a.json")).toThrow("That .vsix archive is damaged.");
  });

  test("refuses a record whose declared comment runs past the end of the file", () => {
    // The walk is told to jump 10,000 bytes past the end. It must refuse as a ZipError: reading the signature at
    // an out-of-bounds offset would raise a RangeError instead, which is not this module's contract.
    const runaway = buildZip([
      { name: "extension/a.json", data: text("{}"), declaredCommentLength: 10_000 },
      { name: "extension/b.json", data: text("{}") },
    ]);
    expect(() => openZip(runaway)).toThrow(ZipError);
  });

  test("refuses a central-directory record whose signature is wrong", () => {
    // A second record follows with room to spare, so the length check cannot refuse it: only the signature can.
    const forged = buildZip([
      { name: "extension/a.json", data: text('{"a":1}') },
      { name: "extension/b.json", data: text('{"b":2}'), badSignature: true },
    ]);
    expect(() => openZip(forged)).toThrow("That .vsix archive is damaged.");
  });

  test("reading an entry that doesn't exist throws rather than returning empty bytes", () => {
    const zip = openZip(buildZip([{ name: "extension/a.json", data: text("{}") }]));
    expect(() => zip.read("extension/missing.json")).toThrow(ZipError);
  });

  test("no refusal message ever quotes the attacker-controlled entry name", () => {
    // Task 6's withArchive hands a ZipError's message straight to the user, so a message carrying an entry name
    // would put archive-controlled text on screen and break the no-path property Tasks 8 and 13 assert.
    const refusals: (() => unknown)[] = [
      () => openZip(buildZip([{ name: "../../../../etc/jslab-pwned.json", data: text("x") }])),
      () => openZip(buildZip([{ name: "../../../etc/", data: new Uint8Array(0), store: true }])),
      () => openZip(buildZip([{ name: "/etc/passwd", data: text("x") }])),
      () => openZip(buildZip([{ name: "extension\\themes\\a.json", data: text("x") }])),
      () =>
        openZip(
          buildZip([
            { name: "extension/a.json", data: text("1") },
            { name: "extension/a.json", data: text("2") },
          ]),
        ),
      () => openZip(buildZip([{ name: "extension/a.json", data: text("{}"), method: 9 }])),
      () =>
        openZip(buildZip([{ name: "extension/big.json", data: text("x".repeat(4096)) }]), {
          maxEntries: 10,
          maxEntryBytes: 128,
          maxTotalBytes: 65536,
          maxRatio: 200,
        }),
      () =>
        openZip(buildZip([{ name: "extension/bomb.json", data: text("\u0000".repeat(200_000)) }]), {
          maxEntries: 10,
          maxEntryBytes: 1024 * 1024,
          maxTotalBytes: 8 * 1024 * 1024,
          maxRatio: 50,
        }),
      () => openZip(buildZip([{ name: "extension/a.json", data: text("{}") }])).read("../../secret.json"),
      () =>
        openZip(buildZip([{ name: "extension/a.json", data: text("hello"), declaredSize: 4 }])).read(
          "extension/a.json",
        ),
    ];
    expect(refusals.length).toBe(10);
    for (const [index, refusal] of refusals.entries()) {
      let caught: unknown;
      try {
        refusal();
      } catch (error) {
        caught = error;
      }
      expect(`${index}:${caught instanceof ZipError}`).toBe(`${index}:true`);
      const message = (caught as Error).message;
      expect(`${index}:${/[/\\]/.test(message)}`).toBe(`${index}:false`);
      expect(`${index}:${message.includes("etc")}`).toBe(`${index}:false`);
    }
  });

  test("keeps the entry name on the error for logging, where the message cannot carry it", () => {
    // Main logs the detail and shows the message (the pattern main/strings.ts already uses for file errors).
    try {
      openZip(buildZip([{ name: "../../../../etc/jslab-pwned.json", data: text("x") }]));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ZipError);
      expect((error as ZipError).entryName).toBe("../../../../etc/jslab-pwned.json");
      expect((error as ZipError).name).toBe("ZipError");
    }
  });
});
