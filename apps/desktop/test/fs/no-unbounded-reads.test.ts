import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The structural half of the bounded-reads fix.
 *
 * A shared helper on its own is just a fourth correct implementation waiting to be bypassed by the fifth feature:
 * the reason the same defect appeared nine times was never that the good reader was hard to write, it was that
 * nothing made reaching past it fail. This gate is that failure. It is modelled on `rpc-timeouts.ts`, where
 * `REQUEST_PAYLOAD_CLASS` is an exhaustive `Record<keyof MainRequests, ...>` so a new request cannot ship
 * unclassified -- except that "a bare read" has no type to be exhaustive over, so the source tree is scanned
 * instead and every permitted read is pinned by count.
 *
 * Pinning the count, rather than merely listing the file, is what makes this catch the realistic regression:
 * adding a tenth unbounded read to a file that already has a legitimate one.
 *
 * Four ways around the first version of this gate were found and are now closed, each of which still executed the
 * read in Main:
 *
 *   1. `import { readFile as slurp }` -- the call site says `slurp(p)` and matches no call pattern. Caught by
 *      matching the *import* instead: the alias is local, but the binding it renames is still spelled `readFile`.
 *      The import check deliberately skips allowlisted files, because such a file legitimately imports the very
 *      reader its pinned count covers -- so the rename is refused *separately, and in every file*. Without that,
 *      the evasion simply moved inside the allowlist: mutant M5 added a renamed read to a file pinned at one read
 *      and the gate stayed green, because `slurp(p)` never moves the count that pins it.
 *   2. `import * as FS` then `FS["readFile"]` -- a computed member access matches nothing either. A namespace
 *      import of `node:fs` hands over every reader at once, so the namespace import is itself the offence.
 *   3. Moving the read into `packages/npm/src`, outside the scan root, while Main still imports it and runs it.
 *      The scan now follows `@jslab/*` specifiers out of Main, transitively, into the packages that really do
 *      execute in Main -- and only those. `packages/e2e` and `packages/test-registry` are dev harnesses that
 *      never run in Main, and sweeping them in would have meant allowlisting reads that are not the hazard.
 *   4. Splitting `Bun.file(p).text()` across three lines, because the patterns were matched per line. Lines are
 *      joined before matching, and the patterns tolerate whitespace between every token.
 *
 * What is deliberately NOT done: lexing TypeScript. An early attempt stripped comments properly and broke on this
 * repo's own regex literals -- a backtick inside `/`/g` in css-plugin.ts flips a naive scanner into string mode and
 * the comment after it survives, inventing a read that is not there. Comment *lines* are skipped instead, exactly
 * as before, which leaves a read hidden in a trailing comment undetected. That is the accepted limit: this gate
 * exists to fail the accidental regression, not to defeat an author who is determined to smuggle one past it.
 *
 * The limits that remain, stated honestly, because a limits list that claims completeness and isn't is worse than
 * a shorter true one:
 *
 *   - A read hidden in a **trailing** comment is not seen (comment *lines* are skipped; see above).
 *   - The scan is textual. A reader reached through a value -- stashed on an object, passed as a parameter,
 *     retrieved via `await import("node:fs")` -- names no binding this can match.
 *   - A **non-`node:` specifier** (`from "fs/promises"`) is invisible here. That is not a hole in practice: biome
 *     rejects it at *error* severity, so it cannot land.
 *   - Only `node:fs` and `node:fs/promises` are matched. A whole-file read reached through some other builtin is
 *     not in scope.
 *
 * To add a read here: use `src/main/fs/bounded-read.ts`. If the read genuinely cannot be bounded, add it below
 * with a reason -- the reason is the point, and "it seemed fine" is not one.
 */

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const MAIN_ROOT = "apps/desktop/src/main";
/** The shared reader itself: it necessarily imports and performs the primitives everything else must not. */
const THE_READER = `${MAIN_ROOT}/fs/bounded-read.ts`;

/**
 * None of these can bound a size, and none can obtain O_NONBLOCK, so none can refuse a FIFO. Whitespace between
 * tokens is tolerated so the call cannot be split across lines to hide from the scan.
 */
const BARE_READ = [/readFileSync\s*\(/, /readFile\s*\(/, /Bun\s*\.\s*file\s*\(/, /createReadStream\s*\(/];

/**
 * An `import ... from` **or `export ... from`** clause naming `node:fs` / `node:fs/promises`, whatever its shape.
 * Group 1 is the keyword, group 2 the clause.
 *
 * The `export` half is not decoration. This used to require the literal `import`, so
 * `export { readFile } from "node:fs/promises"` inside a crawled `@jslab` package was invisible -- the package
 * *is* crawled and the specifier *is* `@jslab`, so this was neither of the two limits the header admits to.
 * Mutant M8 planted exactly that in `packages/npm/src/index.ts` and the gate stayed green.
 */
const FS_IMPORT = /(import|export)\s+([^;]*?)\s+from\s+"node:fs(?:\/promises)?"/;
/** A binding that reads a whole file. An alias renames it locally; the name written here is still the giveaway. */
const READ_BINDING = /\b(?:readFile|readFileSync|createReadStream|readSync)\b/;
/**
 * A clause that takes the module *whole*: `* as fs`, a bare `*` (`export * from`), or a **default** import
 * (`import fs from "node:fs"`). Each hands over every reader at once, reachable by computed access -- and
 * `fs["readFile"]` matches no call pattern.
 *
 * Only `* as` was matched before. `import fs from "node:fs"` reaches every reader identically, and was invisible.
 */
const WHOLE_MODULE_IMPORT = [/\*/, /^\s*[A-Za-z_$][A-Za-z0-9_$]*\s*(?:,|$)/];

/** Whether an import/export clause takes `node:fs` whole rather than naming individual bindings. */
function takesWholeModule(clause: string): boolean {
  return WHOLE_MODULE_IMPORT.some((pattern) => pattern.test(clause));
}
/**
 * A read binding renamed on the way in (`readFile as slurp`).
 *
 * The rename is the whole offence, and it is an offence in an allowlisted file as much as anywhere else. An
 * allowlisted file is pinned by a *count* of bare reads, and that count matches call spellings (`readFile(`), so a
 * plainly-imported reader stays fully covered by the pin -- a second plain `readFile(` moves the count and fails.
 * A renamed one does not: `slurp(p)` matches no call pattern, the count stays pinned, and the import check skips
 * allowlisted files entirely. Mutant M5 put exactly that into `services/settings-store.ts` (pinned at 1) and left
 * the gate at 8 pass / 0 fail.
 */
const ALIASED_READ_BINDING = /\b(?:readFile|readFileSync|createReadStream|readSync)\s+as\s+/;

/** Prose mentions these calls legitimately -- bounded-read.ts's own header explains why they are refused. */
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

/** Workspace specifiers, used to follow Main's imports into the packages that execute inside Main. */
const WORKSPACE_SPECIFIER = /"@jslab\/([a-z0-9-]+)/g;

/**
 * Every read in Main that is allowed to be unbounded, with the count it is pinned at and why it is exempt.
 * Reads of JSLab's own files in its own data dir are the common case: JSLab wrote them, so their size is not
 * third-party controlled.
 */
const ALLOWED: Record<string, { reads: number; why: string }> = {
  [`${MAIN_ROOT}/bundling/vendor-cache.ts`]: {
    reads: 3,
    why: "JSLab's own vendor-chunk cache files, written by JSLab into its own data dir",
  },
  [`${MAIN_ROOT}/files/file-service.ts`]: {
    reads: 1,
    why: "reads via an injected FileSystem seam; paths come from Main's own dialogs and FileService size-checks them. F3 (reading every open tab whole) is tracked separately and is NOT closed by this gate",
  },
  [`${MAIN_ROOT}/logging/rotating-log.ts`]: { reads: 1, why: "JSLab's own rotated log files" },
  [`${MAIN_ROOT}/main-services.ts`]: { reads: 1, why: "JSLab's own shipped web-runner bootstrap asset" },
  [`${MAIN_ROOT}/persistence/json-store.ts`]: { reads: 1, why: "JSLab's own data-dir JSON, written by JSLab" },
  [`${MAIN_ROOT}/platform/e2e-dialogs.ts`]: {
    reads: 1,
    why: "JSLAB_E2E=1 only: dialog answers the E2E harness itself writes",
  },
  [`${MAIN_ROOT}/platform/system-fonts.ts`]: { reads: 1, why: "JSLab's own font cache in its data dir" },
  [`${MAIN_ROOT}/rpc/web-node-handlers.ts`]: {
    reads: 3,
    why: "F1, deliberately out of scope: the browser-node bridge's fs.readFile carries the user's own permissions, and bounding it needs a Main-vs-subprocess blast-radius decision first. One of the three is an interface signature, not a call",
  },
  [`${MAIN_ROOT}/runtimes/web-adapter.ts`]: {
    reads: 1,
    why: "reads bun.lock from JSLab's own packages dir to compute the vendor cache key",
  },
  [`${MAIN_ROOT}/services/env-store.ts`]: { reads: 1, why: "JSLab's own env.json in its data dir" },
  [`${MAIN_ROOT}/services/keybindings-store.ts`]: { reads: 1, why: "JSLab's own keybindings.json in its data dir" },
  [`${MAIN_ROOT}/services/npm-service.ts`]: {
    reads: 2,
    why: "packages/package.json is JSLab's own manifest; the second match is a Bun.file().exists() probe, which never reads. The third-party manifests on this path are bounded (F4)",
  },
  [`${MAIN_ROOT}/services/session-store.ts`]: { reads: 2, why: "JSLab's own tab buffer files in its data dir" },
  [`${MAIN_ROOT}/services/settings-store.ts`]: { reads: 1, why: "JSLab's own settings.json in its data dir" },
  "packages/runner-web/src/node-bridge.ts": {
    reads: 2,
    why: "not filesystem reads at all: this is the browser-side Node bridge, and its `readFile` is an RPC shim forwarding to Main's web-node-handlers (F1). The two matches are an interface signature and that shim's own method definition",
  },
};

/**
 * Reads that waive the *byte cap* and nothing else, via `readRegularFileText`.
 *
 * `bundling/css-plugin.ts` used to sit in ALLOWED above with the reason "a cap would break legitimately large
 * stylesheets". That reason was true and incomplete: it justified waiving the size bound, but the call it excused
 * (`Bun.file(path).text()`) also could not refuse a FIFO, and a `.css` resolved out of `node_modules` hung the
 * build forever. Splitting the two exemptions apart is the point -- everything here still goes through the shared
 * reader's `O_NONBLOCK` open and `isFile` check, so only the size is unbounded.
 *
 * The two bundling plugins joined it for exactly the same reason, one review later: their importer re-reads sat in
 * ALLOWED excused as "best-effort inside try/catch", which is a *recoverability* argument and answers neither
 * hazard. Measured: `readFileSync` on a FIFO blocks, so no try/catch can rescue it, and both hooks were driven with
 * a FIFO importer and had to be killed by a hard alarm.
 *
 * What belongs here is any read with **no meaningful byte cap**, however that is spelled -- not merely a call to
 * one particular reader. `UNBOUNDED_SIZE` below matches both spellings for exactly that reason.
 */
const SIZE_EXEMPT: Record<string, { reads: number; why: string }> = {
  [`${MAIN_ROOT}/bundling/css-plugin.ts`]: {
    reads: 1,
    why: "a .css Bun already resolved for this build: no useful byte cap exists, since a legitimately large stylesheet must still bundle. Only the size bound is waived; a FIFO or directory is still refused",
  },
  [`${MAIN_ROOT}/bundling/polyfill-plugin.ts`]: {
    reads: 1,
    why: "re-reads the importing module's own source only to position an error message. No byte cap is meaningful: Bun has already read and parsed that same file to see the import, so a cap could only refuse a file the build itself accepted. Only the size is waived -- a FIFO importer is refused, and falls through to the unpositioned error",
  },
  [`${MAIN_ROOT}/bundling/resolve-plugin.ts`]: {
    reads: 1,
    why: "the same importer re-read for error positioning, on a resolution miss, where the importer is third-party- or user-controlled. No byte cap is meaningful for the same reason; only the size is waived, and a FIFO importer is refused rather than blocking Main's loop. Its package.json read is separately bounded (F4)",
  },
};

/**
 * The size-waiving reads. Anything matching one must carry a SIZE_EXEMPT reason.
 *
 * The named readers are not the only way to waive a cap, which is why the second pattern exists: passing
 * `Number.POSITIVE_INFINITY` (or `Infinity`) as the `maxBytes` argument of any bounded reader waives it just as
 * completely, while naming none of them. Mutant M7 called `readBoundedText(p, Number.POSITIVE_INFINITY)` from a
 * file with no SIZE_EXEMPT entry at all and the gate stayed at 9 pass / 0 fail -- the ledger was exhaustive over
 * one function name rather than over "reads with no meaningful cap", which is what it claims to record.
 */
const UNBOUNDED_SIZE = [
  /readRegularFileText(?:Sync)?\s*\(/,
  // Both spellings, and they are *not* the same token: `Number.POSITIVE_INFINITY` carries `INFINITY` in caps, so a
  // pattern written as `(?:POSITIVE_)?Infinity` matches only the bare `Infinity` and silently misses the commoner
  // form -- measured, with M7 passing 9/0 against exactly that mistake.
  /readBounded[A-Za-z]*\s*\([^;]*?(?:POSITIVE_INFINITY|Infinity)/,
];

function sourceFilesUnder(root: string): string[] {
  const absolute = join(REPO, root);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true })
    .map((entry) => String(entry).split("\\").join("/"))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => `${root}/${entry}`);
}

/**
 * Main, plus the `src` of every workspace package Main pulls in, transitively. Derived rather than listed, so a
 * package that becomes reachable from Main comes under the gate on its own -- which is evasion 3's exit closed at
 * the root instead of one package at a time.
 */
function scanRoots(): string[] {
  const roots = [MAIN_ROOT];
  const seen = new Set<string>();
  const pending: string[] = [];

  const follow = (root: string) => {
    for (const file of sourceFilesUnder(root)) {
      const text = readFileSync(join(REPO, file), "utf8");
      for (const match of text.matchAll(WORKSPACE_SPECIFIER)) {
        const name = match[1];
        if (name !== undefined) pending.push(name);
      }
    }
  };

  follow(MAIN_ROOT);
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    const root = `packages/${name}/src`;
    if (!existsSync(join(REPO, root))) continue;
    roots.push(root);
    follow(root);
  }
  return roots.sort();
}

function scannedFiles(): string[] {
  return scanRoots()
    .flatMap((root) => sourceFilesUnder(root))
    .sort();
}

/**
 * The file's code lines joined back together, so a call split across lines still matches, plus the mapping back to
 * real line numbers so a failure says exactly what to fix.
 */
function code(relativePath: string): { text: string; lineOf(index: number): number } {
  const lines = readFileSync(join(REPO, relativePath), "utf8").split("\n");
  const kept: string[] = [];
  const starts: Array<{ start: number; line: number }> = [];
  let offset = 0;
  for (const [index, line] of lines.entries()) {
    if (COMMENT_LINE.test(line)) continue;
    starts.push({ start: offset, line: index + 1 });
    kept.push(line);
    offset += line.length + 1;
  }
  return {
    text: kept.join("\n"),
    lineOf(index: number): number {
      let found = starts[0]?.line ?? 0;
      for (const entry of starts) {
        if (entry.start > index) break;
        found = entry.line;
      }
      return found;
    },
  };
}

/** Matches of any pattern, as `path:line: text`. */
function matchesIn(relativePath: string, patterns: RegExp[]): string[] {
  const source = code(relativePath);
  const found: Array<{ line: number; text: string }> = [];
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, "g");
    let match = global.exec(source.text);
    while (match !== null) {
      found.push({ line: source.lineOf(match.index), text: match[0] });
      match = global.exec(source.text);
    }
  }
  return found.sort((a, b) => a.line - b.line).map((hit) => `${relativePath}:${hit.line}: ${hit.text}`);
}

function bareReads(relativePath: string): string[] {
  return matchesIn(relativePath, BARE_READ);
}

/**
 * `node:fs` imports that escape an allowlisted file's pinned read count, and so must be refused in *every* file.
 * A plainly-imported reader is not one of these: its call site is spelled the way `BARE_READ` matches, so the pin
 * already covers it.
 */
function pinEscapingImports(relativePath: string): string[] {
  const source = code(relativePath);
  const global = new RegExp(FS_IMPORT.source, "g");
  const found: string[] = [];
  let match = global.exec(source.text);
  while (match !== null) {
    const clause = match[2] ?? "";
    // A re-export escapes a pinned count for a different reason than a rename does: it hands the reader *out* of
    // this file, so there is no local call site here for any count to pin. Refused wherever it appears.
    const reExportsAReader = match[1] === "export" && READ_BINDING.test(clause);
    if (takesWholeModule(clause) || ALIASED_READ_BINDING.test(clause) || reExportsAReader) {
      found.push(`${relativePath}:${source.lineOf(match.index)}: ${clause.replace(/\s+/g, " ").trim()}`);
    }
    match = global.exec(source.text);
  }
  return found;
}

/** `import`s of `node:fs` that hand the file a whole-file reader, under any alias or via a namespace. */
function fsReadImports(relativePath: string): string[] {
  const source = code(relativePath);
  const global = new RegExp(FS_IMPORT.source, "g");
  const found: string[] = [];
  let match = global.exec(source.text);
  while (match !== null) {
    const clause = match[2] ?? "";
    if (takesWholeModule(clause) || READ_BINDING.test(clause)) {
      found.push(`${relativePath}:${source.lineOf(match.index)}: ${clause.replace(/\s+/g, " ").trim()}`);
    }
    match = global.exec(source.text);
  }
  return found;
}

describe("no unbounded reads in Main", () => {
  test("the scan actually sees Main's sources, and follows Main's imports into packages", () => {
    // Without this, a broken path or filter would make every assertion below vacuously true.
    const roots = scanRoots();
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(THE_READER);
    // Evasion 3 moved a read into packages/npm and it executed in Main regardless, so the crawl must reach it.
    expect(roots).toContain("packages/npm/src");
    expect(roots).toContain("packages/runner-web/src");
    // ...but only where Main really reaches. These are dev harnesses that never run in Main.
    expect(roots).not.toContain("packages/e2e/src");
    expect(roots).not.toContain("packages/test-registry/src");
  });

  test("no file outside the allowlist performs a bare readFile / readFileSync / Bun.file / createReadStream read", () => {
    const offenders = scannedFiles()
      .filter((file) => !(file in ALLOWED))
      .flatMap((file) => bareReads(file));

    expect(offenders).toEqual([]);
  });

  test("each allowlisted file performs exactly the number of bare reads it is pinned at", () => {
    // Catches the realistic regression: a new unbounded read added to a file that already has a permitted one.
    const actual: Record<string, number> = {};
    const pinned: Record<string, number> = {};
    for (const [file, entry] of Object.entries(ALLOWED)) {
      actual[file] = bareReads(file).length;
      pinned[file] = entry.reads;
    }
    expect(actual).toEqual(pinned);
  });

  test("no file outside the allowlist even imports or re-exports a whole-file reader from node:fs", () => {
    // The call site can be renamed (`readFile as slurp`) or computed (`FS["readFile"]`); the import cannot hide
    // which binding it takes. An allowlisted file is exempt *from this test only* -- it legitimately imports the
    // reader its pinned count covers -- and the test below is what stops that exemption from being a hole.
    const offenders = scannedFiles()
      .filter((file) => file !== THE_READER && !(file in ALLOWED))
      .flatMap((file) => fsReadImports(file));

    expect(offenders).toEqual([]);
  });

  test("no file -- allowlisted or not -- renames a read binding or takes node:fs whole", () => {
    // The gate's stated primary purpose is catching "a tenth unbounded read added beside a legitimate one", and
    // that is precisely the case the allowlist exemption above used to miss: a renamed read moves no count, and a
    // whole-module import reaches every reader by computed access. Neither is ever legitimate, in any file, so
    // neither carries an exemption. Mutant M5 is the regression this pins.
    const offenders = scannedFiles().flatMap((file) => pinEscapingImports(file));

    expect(offenders).toEqual([]);
  });

  test("no allowlist entry is stale, and every entry carries a reason", () => {
    const files = new Set(scannedFiles());
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect({ file, exists: files.has(file) }).toEqual({ file, exists: true });
      // An exemption with no stated reason is how the next nine get added.
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  test("the shared bounded reader is itself free of bare reads", () => {
    // It names them in its header prose, which is exactly why the scan skips comment lines.
    expect(bareReads(THE_READER)).toEqual([]);
  });

  test("each size-exempt file waives the cap exactly as often as it is pinned, and says why", () => {
    const files = new Set(scannedFiles());
    const actual: Record<string, number> = {};
    const pinned: Record<string, number> = {};
    for (const [file, entry] of Object.entries(SIZE_EXEMPT)) {
      expect({ file, exists: files.has(file) }).toEqual({ file, exists: true });
      expect(entry.why.length).toBeGreaterThan(20);
      actual[file] = matchesIn(file, UNBOUNDED_SIZE).length;
      pinned[file] = entry.reads;
    }
    expect(actual).toEqual(pinned);
  });

  test("no file outside SIZE_EXEMPT waives the byte cap", () => {
    const offenders = scannedFiles()
      // bounded-read.ts *declares* readRegularFileText; it is the reader, not a caller reaching past it.
      .filter((file) => file !== THE_READER && !(file in SIZE_EXEMPT))
      .flatMap((file) => matchesIn(file, UNBOUNDED_SIZE));

    expect(offenders).toEqual([]);
  });
});
