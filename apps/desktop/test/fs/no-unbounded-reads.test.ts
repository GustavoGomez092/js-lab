import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
 * To add a read here: use `src/main/fs/bounded-read.ts`. If the read genuinely cannot be bounded, add it below
 * with a reason -- the reason is the point, and "it seemed fine" is not one.
 */

const MAIN_DIR = join(import.meta.dir, "..", "..", "src", "main");

/** None of these can bound a size, and none can obtain O_NONBLOCK, so none can refuse a FIFO. */
const BARE_READ = /readFileSync\(|readFile\(|Bun\.file\(/;

/** Prose mentions these calls legitimately -- bounded-read.ts's own header explains why they are refused. */
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

/**
 * Every read in Main that is allowed to be unbounded, with the count it is pinned at and why it is exempt.
 * Reads of JSLab's own files in its own data dir are the common case: JSLab wrote them, so their size is not
 * third-party controlled.
 */
const ALLOWED: Record<string, { reads: number; why: string }> = {
  "bundling/polyfill-plugin.ts": {
    reads: 1,
    why: "re-reads the importer's own source only to position an error message; best-effort inside try/catch",
  },
  "bundling/resolve-plugin.ts": {
    reads: 1,
    why: "same best-effort importer re-read for error positioning; its package.json read is bounded (F4)",
  },
  "bundling/vendor-cache.ts": {
    reads: 3,
    why: "JSLab's own vendor-chunk cache files, written by JSLab into its own data dir",
  },
  "files/file-service.ts": {
    reads: 1,
    why: "reads via an injected FileSystem seam; paths come from Main's own dialogs and FileService size-checks them. F3 (reading every open tab whole) is tracked separately and is NOT closed by this gate",
  },
  "logging/rotating-log.ts": { reads: 1, why: "JSLab's own rotated log files" },
  "main-services.ts": { reads: 1, why: "JSLab's own shipped web-runner bootstrap asset" },
  "persistence/json-store.ts": { reads: 1, why: "JSLab's own data-dir JSON, written by JSLab" },
  "platform/e2e-dialogs.ts": { reads: 1, why: "JSLAB_E2E=1 only: dialog answers the E2E harness itself writes" },
  "platform/system-fonts.ts": { reads: 1, why: "JSLab's own font cache in its data dir" },
  "rpc/web-node-handlers.ts": {
    reads: 3,
    why: "F1, deliberately out of scope: the browser-node bridge's fs.readFile carries the user's own permissions, and bounding it needs a Main-vs-subprocess blast-radius decision first. One of the three is an interface signature, not a call",
  },
  "runtimes/web-adapter.ts": {
    reads: 1,
    why: "reads bun.lock from JSLab's own packages dir to compute the vendor cache key",
  },
  "services/env-store.ts": { reads: 1, why: "JSLab's own env.json in its data dir" },
  "services/keybindings-store.ts": { reads: 1, why: "JSLab's own keybindings.json in its data dir" },
  "services/npm-service.ts": {
    reads: 2,
    why: "packages/package.json is JSLab's own manifest; the second match is a Bun.file().exists() probe, which never reads. The third-party manifests on this path are bounded (F4)",
  },
  "services/session-store.ts": { reads: 2, why: "JSLab's own tab buffer files in its data dir" },
  "services/settings-store.ts": { reads: 1, why: "JSLab's own settings.json in its data dir" },
};

/**
 * Reads that waive the *byte cap* and nothing else, via `readRegularFileText`.
 *
 * `bundling/css-plugin.ts` used to sit in ALLOWED above with the reason "a cap would break legitimately large
 * stylesheets". That reason was true and incomplete: it justified waiving the size bound, but the call it excused
 * (`Bun.file(path).text()`) also could not refuse a FIFO, and a `.css` resolved out of `node_modules` hung the
 * build forever. Splitting the two exemptions apart is the point -- everything here still goes through the shared
 * reader's `O_NONBLOCK` open and `isFile` check, so only the size is unbounded.
 */
const SIZE_EXEMPT: Record<string, { reads: number; why: string }> = {
  "bundling/css-plugin.ts": {
    reads: 1,
    why: "a .css Bun already resolved for this build: no useful byte cap exists, since a legitimately large stylesheet must still bundle. Only the size bound is waived; a FIFO or directory is still refused",
  },
};

/** The size-waiving reader. Anything calling it must carry a SIZE_EXEMPT reason. */
const UNBOUNDED_SIZE = /readRegularFileText\s*\(/;

function mainSourceFiles(): string[] {
  return readdirSync(MAIN_DIR, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => entry.split("\\").join("/"))
    .sort();
}

/** Matching lines that are not prose, as `line number: text`, so a failure says exactly what to fix. */
function matchingLines(relativePath: string, pattern: RegExp): string[] {
  const source = readFileSync(join(MAIN_DIR, relativePath), "utf8");
  return source
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !COMMENT_LINE.test(line) && pattern.test(line))
    .map(({ line, number }) => `${relativePath}:${number}: ${line.trim()}`);
}

function bareReads(relativePath: string): string[] {
  return matchingLines(relativePath, BARE_READ);
}

describe("no unbounded reads in Main", () => {
  test("the scan actually sees Main's sources", () => {
    // Without this, a broken path or filter would make every assertion below vacuously true.
    const files = mainSourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("fs/bounded-read.ts");
  });

  test("no file outside the allowlist performs a bare readFile / readFileSync / Bun.file read", () => {
    const offenders = mainSourceFiles()
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

  test("no allowlist entry is stale, and every entry carries a reason", () => {
    const files = new Set(mainSourceFiles());
    for (const [file, entry] of Object.entries(ALLOWED)) {
      expect({ file, exists: files.has(file) }).toEqual({ file, exists: true });
      // An exemption with no stated reason is how the next nine get added.
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  test("the shared bounded reader is itself free of bare reads", () => {
    // It names them in its header prose, which is exactly why the scan skips comment lines.
    expect(bareReads("fs/bounded-read.ts")).toEqual([]);
  });

  test("each size-exempt file waives the cap exactly as often as it is pinned, and says why", () => {
    const files = new Set(mainSourceFiles());
    const actual: Record<string, number> = {};
    const pinned: Record<string, number> = {};
    for (const [file, entry] of Object.entries(SIZE_EXEMPT)) {
      expect({ file, exists: files.has(file) }).toEqual({ file, exists: true });
      expect(entry.why.length).toBeGreaterThan(20);
      actual[file] = matchingLines(file, UNBOUNDED_SIZE).length;
      pinned[file] = entry.reads;
    }
    expect(actual).toEqual(pinned);
  });

  test("no file outside SIZE_EXEMPT waives the byte cap", () => {
    const offenders = mainSourceFiles()
      // bounded-read.ts *declares* readRegularFileText; it is the reader, not a caller reaching past it.
      .filter((file) => file !== "fs/bounded-read.ts" && !(file in SIZE_EXEMPT))
      .flatMap((file) => matchingLines(file, UNBOUNDED_SIZE));

    expect(offenders).toEqual([]);
  });
});
