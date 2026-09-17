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
 * Seven ways around the first version of this gate were found and are now closed, each of which still executed the
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
 *   5. `import { readRegularFileText as slurp }` -- evasion 1 again, one ledger over, against the project's *own*
 *      unbounded reader rather than `node:fs`. The call site says `slurp(p)`, which matches no call pattern, and
 *      the waiver disappears from SIZE_EXEMPT entirely. Caught by `RENAMED_UNBOUNDED_READER`, in every file.
 *   6. Hand-rolling the read from `openSync`/`fstatSync`/`readSync` inside an ALLOWLISTED file. `readSync` was in
 *      the import check but in no call-level list, and the import check skips allowlisted files, so nothing looked
 *      at it and no count moved. Caught by `FD_PRIMITIVE`, which only `THE_READER` may name -- for the SYNCHRONOUS
 *      shape only. The async twin is not closed, and is admitted in the limits below rather than implied away.
 *   7. Recording a genuine `readRegularFileText(p)` as a NOT_A_READ_CAP entry -- a ledger whose whole claim is
 *      "no file is read here". The waiver test skipped those files wholesale while the pin only checked a total,
 *      so the real read was excused by a ledger that cannot describe one. `UNBOUNDED_READER_CALL` is now split out
 *      and applies to those files too; only `CAP_WAIVER_TOKEN` is theirs to classify.
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
 *   - A cap waived as a plain number (`readBoundedText(p, Number.MAX_SAFE_INTEGER)`) is invisible to any textual
 *     pattern, so this file cannot be the thing that closes it. It is closed in `bounded-read.ts` instead, which
 *     refuses a finite `maxBytes` over `MAX_MEANINGFUL_CAP_BYTES`. That is the one limit here that is answered
 *     elsewhere rather than admitted, and the ledger below is complete only because it is.
 *   - The **asynchronous** hand-roll -- `open()` from `node:fs/promises` plus `handle.read()`, which is what
 *     `bounded-read.ts` itself does minus `O_NONBLOCK` -- is NOT matched, in any file. `FD_PRIMITIVE` covers the
 *     synchronous shape only. Closing it textually was tried and rejected: `open(` appears legitimately twelve
 *     times in the scanned tree (a dialog's `open()`, a window's `open()`, four stores' `static async open(`, and
 *     `persistence/atomic-write.ts` opening a file in order to WRITE it), so a call-level matcher would need about
 *     ten ledger entries for things that are not reads -- the exact conflation SIZE_EXEMPT and NOT_A_READ_CAP
 *     exist to undo. An import-level matcher is no better: it would record atomic-write's write-open as a read,
 *     and `fsReadImports` skips allowlisted files, so it would not close the hole in the very files evasion 6 was
 *     about. The hazard differs too: an async `handle.read()` on a FIFO occupies a libuv threadpool slot rather
 *     than blocking the JS thread, so it degrades Main rather than stopping it.
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
 * The **synchronous** fd primitives a whole-file read is hand-rolled from.
 *
 * These are not unbounded reads in themselves -- `bounded-read.ts` is built out of exactly this
 * `openSync`/`fstatSync`/`readSync` shape -- which is precisely why no other file may name them: `openSync(path)`
 * without `O_NONBLOCK` blocks on a FIFO exactly as `readFileSync` does, and a hand-rolled read loop bounds nothing
 * unless its author remembered to bound it.
 *
 * `readSync` sat in `READ_BINDING` (the import check) but in `BARE_READ` not at all, and `fsReadImports` skips
 * allowlisted files -- so this shape was invisible in exactly the files most likely to reach for it. Measured as a
 * matched pair, identical code: in `services/npm-service.ts` (ALLOWED, pinned at 1) the gate stayed green, while in
 * `services/keybindings-store.ts` (not allowlisted) it failed. Since the offence is the hand-rolling and not the
 * count, this carries no allowlist exemption at all.
 *
 * SYNCHRONOUS ONLY, and the name of the test below says so. The async twin -- `open()` from `node:fs/promises`
 * plus `handle.read()` -- evades this and every other check in this file, in every file. That is stated in the
 * header's limits, with the reasons a textual matcher for it was rejected and the way its hazard differs. Naming
 * this constant or its test as though it covered both would be this branch's own thesis broken in its own test
 * suite: a stated reason has to answer its hazard, and one that overclaims answers nothing.
 */
const FD_PRIMITIVE = [/openSync\s*\(/, /readSync\s*\(/];

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

/**
 * One of the project's OWN unbounded readers, reached under another name.
 *
 * `UNBOUNDED_READER_CALL` matches `readRegularFileText(` as a *call*, so renaming the binding hides the waiver
 * completely: `import { readRegularFileText as slurp }` leaves no `(` after the name, and `FS_IMPORT` /
 * `ALIASED_READ_BINDING` police only `node:fs`. That is evasion 1 -- the `readFile as slurp` rename the header
 * describes at length -- reappearing one ledger over, against JSLab's own reader; `cb9bf84` closed it for
 * `node:fs` only.
 *
 * It is not a contrived spelling either. `runs/runner-config.ts` already writes
 * `const readTextSync = readBoundedTextSyncOrNull`, so re-binding a reader to a local name is an established idiom
 * in this tree, which is why the local-`const` form is refused alongside the import rename. Neither spelling is ever
 * legitimate -- the waiver has to stay legible to SIZE_EXEMPT, and a renamed one is not -- so both are refused in
 * every file, allowlisted or not.
 *
 * What is matched is those TWO spellings, not renaming in general. A reader passed as a parameter, stashed on an
 * object or returned from a factory still names no binding this can see; that is the value-mediated limit the
 * header admits, and this comment does not pretend otherwise.
 */
const RENAMED_UNBOUNDED_READER = [
  /readRegularFileText(?:Sync)?\s+as\s+/,
  /=\s*readRegularFileText(?:Sync)?\s*[;,)\]}]/,
];

/** Prose mentions these calls legitimately -- bounded-read.ts's own header explains why they are refused. */
const COMMENT_LINE = /^\s*(\*|\/\/|\/\*)/;

/** Workspace specifiers, used to follow Main's imports into the packages that execute inside Main. */
const WORKSPACE_SPECIFIER = /"@jslab\/([a-z0-9-]+)/g;

/**
 * Every read in Main that is allowed to be unbounded, with the count it is pinned at and why it is exempt.
 *
 * What is NOT a reason, although it reads like one and stood here over eleven entries: **"JSLab's own file in its
 * own data dir"**. That answers the *size* hazard and nothing else, while every read it excused was equally unable
 * to refuse a non-regular file. All of those paths are user-writable, so having written a file is no guarantee it
 * is still a regular file when it is next read -- and a FIFO at settings.json, session.json, env.json,
 * keybindings.json, the font cache, a vendor chunk, main.log, bun.lock or packages/package.json blocks Main exactly
 * as the bundling plugins' importer re-reads did. It was measured there, twice, and the same measurement was
 * repeated here for settings.json and the log tail: a blocking `read(2)` never returns, so no `try`/`catch` around
 * it can rescue the process, and only a hard SIGKILL on the pid reclaimed the runner.
 *
 * Those reads now go through the shared reader, which is why they are absent below. The ones whose content has no
 * meaningful byte cap moved to SIZE_EXEMPT, where the waiver is recorded as being about size and nothing else; the
 * ones whose own schema or policy bounds them (settings.json, env.json, keybindings.json, the font cache,
 * packages/package.json) carry a real cap and need no entry in either ledger.
 *
 * So a reason here must answer BOTH hazards -- an unbounded allocation, and blocking forever on a non-regular file
 * -- or state plainly which of the two it waives and why that is acceptable at this call site.
 */
const ALLOWED: Record<string, { reads: number; why: string }> = {
  [`${MAIN_ROOT}/files/file-service.ts`]: {
    reads: 1,
    why: "reads via an injected FileSystem seam; paths come from Main's own dialogs and FileService size-checks them. F3 (reading every open tab whole) is tracked separately and is NOT closed by this gate",
  },
  [`${MAIN_ROOT}/platform/e2e-dialogs.ts`]: {
    reads: 1,
    why: "JSLAB_E2E=1 only: dialog answers the E2E harness itself writes. This reason is about REACHABILITY, not about the file being JSLab's -- the read is genuinely unbounded and would block on a FIFO like any other, but the path only exists under the harness's own run, and the harness is not a user who can be attacked through it",
  },
  [`${MAIN_ROOT}/rpc/web-node-handlers.ts`]: {
    reads: 3,
    why: "F1, deliberately out of scope: the browser-node bridge's fs.readFile carries the user's own permissions, and bounding it needs a Main-vs-subprocess blast-radius decision first. One of the three is an interface signature, not a call",
  },
  [`${MAIN_ROOT}/services/npm-service.ts`]: {
    reads: 1,
    why: "the one remaining match is a Bun.file().exists() probe, which stats and never reads a byte. The manifest read that used to sit beside it is now bounded at MAX_PACKAGE_JSON_BYTES, like the third-party manifests on this same path (F4)",
  },
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
 * one particular reader. `UNBOUNDED_SIZE` below matches every spelling for exactly that reason.
 *
 * The data-dir stores joined them a review later still, when "JSLab's own file in its own data dir" turned out to
 * be the same mistake wearing a more plausible hat: it answers size, the call it excused answered neither hazard,
 * and the paths are all user-writable. Those that genuinely cannot name a cap are below; those whose own schema
 * bounds them took a real cap instead and appear in neither ledger.
 */
const SIZE_EXEMPT: Record<string, { reads: number; why: string }> = {
  [`${MAIN_ROOT}/bundling/css-plugin.ts`]: {
    reads: 1,
    why: "a .css Bun already resolved for this build: no useful byte cap exists, since a legitimately large stylesheet must still bundle. Only the size bound is waived; a FIFO or directory is still refused",
  },
  [`${MAIN_ROOT}/bundling/vendor-cache.ts`]: {
    reads: 3,
    why: "the two chunk files and index.json. A vendor chunk is a whole bundled dependency graph, and the cache's bound is the 200 MB directory total that eviction enforces rather than a per-entry one, so there is no per-file cap to apply; index.json's size tracks the entry count for the same reason. Only the size is waived: a FIFO under the cache dir is refused, and #doGet's existing catch treats that as a miss, repairing the index and removing the pair",
  },
  [`${MAIN_ROOT}/logging/rotating-log.ts`]: {
    reads: 1,
    why: "the log tail. The earlier reason given here -- 'maxBytes is a caller option, so there is no constant to cap at' -- is withdrawn: `this.options.maxBytes ?? 5 MB` is in scope in the same class, so a cap was always available and that was the weakest reason in this ledger. What is actually waived, stated plainly: the live file legitimately outgrows maxBytes exactly when rotation is FAILING, which is when its contents matter most, so capping there would discard the tail in the one case it is needed. The cost is bounded and named rather than hand-waved -- at most maxFiles (default 5) files allocated whole, synchronously, on Main's loop, when a Debug Report is generated. Bounding it honestly means reading backwards for the last `count` lines, which is a real change and is deliberately not made here. What the waiver buys is the reachable hazard: tail() is synchronous and existsSync is true for a FIFO, so a FIFO at main.log blocked the Debug Report until a hard alarm killed the process. A refused file is now skipped, so the older rotated files behind it are still read",
  },
  [`${MAIN_ROOT}/main-services.ts`]: {
    reads: 1,
    why: "the shipped web-runner bootstrap, whose size is whatever the build produced, so no cap applies. An app bundle is user-writable and JSLAB_WEB_RUNNER_BOOTSTRAP can repoint it anyway. Only the size is waived -- a FIFO there is refused instead of hanging the first browser-mode run forever",
  },
  [`${MAIN_ROOT}/bundling/polyfill-plugin.ts`]: {
    reads: 1,
    why: "re-reads the importing module's own source only to position an error message. No byte cap is meaningful: Bun has already read and parsed that same file to see the import, so a cap could only refuse a file the build itself accepted. Only the size is waived -- a FIFO importer is refused, and falls through to the unpositioned error",
  },
  [`${MAIN_ROOT}/bundling/resolve-plugin.ts`]: {
    reads: 1,
    why: "the same importer re-read for error positioning, on a resolution miss, where the importer is third-party- or user-controlled. No byte cap is meaningful for the same reason; only the size is waived, and a FIFO importer is refused rather than blocking Main's loop. Its package.json read is separately bounded (F4)",
  },
  [`${MAIN_ROOT}/runtimes/web-adapter.ts`]: {
    reads: 1,
    why: "bun.lock, read to compute the vendor cache key. A lockfile grows with the dependency graph, so a cap would disable the cache for exactly the projects it helps most. Only the size is waived; the packages dir is user-writable, so a FIFO there is refused and vendorKeyFor's own catch turns that into 'no vendor cache for this run'",
  },
  [`${MAIN_ROOT}/services/session-store.ts`]: {
    reads: 3,
    why: "the tab buffer, the closed-tab buffer, and session.json's own load. A buffer holds whatever the user typed or opened into that tab, and session.json grows with the tab count, so any cap would eventually discard the user's own work. The third match is a Number.POSITIVE_INFINITY handed to loadJson rather than a reader name, which is why UNBOUNDED_SIZE matches the token and not just a call. Only the size is waived: a FIFO at a buffer path is refused and latches the tab unreadable so setBuffer cannot overwrite it, and a FIFO at session.json recovers to defaults and is then renamed over. F3 (reading every open tab whole) is tracked separately and is NOT closed here",
  },
};

/**
 * A call to one of the project's OWN unbounded readers.
 *
 * This half is kept separate because it is never excusable by a NOT_A_READ_CAP entry: such an entry claims "no file
 * is read here", and calling `readRegularFileText` *is* reading a file. Folding the two halves together is what let
 * a genuine `readRegularFileText(p)` be laundered through a NOT_A_READ_CAP entry with `uses: 1` -- the hole
 * SIZE_EXEMPT exists to close, reopened one ledger over.
 */
const UNBOUNDED_READER_CALL = [/readRegularFileText(?:Sync)?\s*\(/];

/**
 * Every OTHER way to waive a cap, reduced to the token that must appear in one.
 *
 * This began anchored to `readBounded...(`, because mutant M7 waived a cap by passing
 * `Number.POSITIVE_INFINITY` to a bounded reader from a file carrying no SIZE_EXEMPT entry, and the gate stayed
 * at 9 pass / 0 fail. That anchoring was still too narrow in the same way, one level up: a cap can be waived
 * through a *wrapper* that names no reader at all. `services/session-store.ts` hands
 * `Number.POSITIVE_INFINITY` to `loadJson`, and `loadJson` is the thing that reads -- a call the anchored
 * pattern matched not at all, so the largest waiver in the tree would have gone unrecorded.
 *
 * Matching the bare token catches that, at the cost of also matching uses that have nothing to do with reading a
 * file. Those are classified in NOT_A_READ_CAP below rather than quietly filtered out. A narrower "token as a
 * call argument" pattern was tried first and is not viable: session-store's own waiver spans five lines with
 * nested parens (`join(...)`, `() => ...`) between the opening call and the token, so every such pattern misses
 * the real waiver while still matching an object property that merely holds the constant.
 *
 * Both spellings are listed because they are not the same token -- `Number.POSITIVE_INFINITY` carries `INFINITY`
 * in caps, so a pattern written as `(?:POSITIVE_)?Infinity` matches only the bare form and silently misses the
 * commoner one. That is not hypothetical, and it is not only a regex trap: the check that this token appeared
 * nowhere else was first run as a case-sensitive grep for `Infinity`, which cannot see `POSITIVE_INFINITY`. It
 * reported a clean tree while four uses sat in packages/serializer, and the claim "measured, zero occurrences"
 * was written on the strength of it. The gate caught what the measurement missed, which is the whole point of
 * pinning this in a test rather than trusting a one-off grep.
 *
 * These two are the ONLY spellings of "no cap" that can still reach a read, and that is enforced outside this
 * file: `bounded-read.ts` refuses any finite `maxBytes` over `MAX_MEANINGFUL_CAP_BYTES`, so a waiver spelled as a
 * large literal cannot land at all. Without that refusal this list could never have been complete, because no
 * textual pattern can recognise an arbitrary large number as "not really a cap".
 */
const CAP_WAIVER_TOKEN = [/POSITIVE_INFINITY|Infinity/];

/**
 * The size-waiving reads. Anything matching one must carry a SIZE_EXEMPT reason.
 */
const UNBOUNDED_SIZE = [...UNBOUNDED_READER_CALL, ...CAP_WAIVER_TOKEN];

/**
 * Occurrences of the waiver token that are NOT a file read's byte cap, pinned by count with a reason.
 *
 * `CAP_WAIVER_TOKEN` matches a bare token, so it necessarily also matches uses that have nothing to do with reading
 * a file. Those are classified here rather than dropped silently, and the count is pinned exactly as ALLOWED pins a
 * read count -- so a NEW occurrence in one of these files, which could perfectly well be a real read waiver, fails
 * the gate instead of hiding behind the ones already here.
 *
 * An entry here excuses the TOKEN and nothing else. It used to excuse the whole file, which made it a strictly
 * better hiding place than SIZE_EXEMPT: a real `readRegularFileText(p)` added to a file listed here, with `uses: 1`
 * and a plausible reason, left the gate at 10 pass / 0 fail, because the waiver test skipped the file entirely and
 * the pin only compared a total. A call to an unbounded reader is a file being read, which is the one thing an
 * entry here asserts is not happening, so `UNBOUNDED_READER_CALL` is checked in these files like any other.
 */
const NOT_A_READ_CAP: Record<string, { uses: number; why: string }> = {
  "packages/serializer/src/encode.ts": {
    uses: 4,
    why: "maxEncodedBytes is the encoder's own OUTPUT budget -- how many bytes a value may serialize to before it is truncated -- and POSITIVE_INFINITY is its 'no budget' sentinel. The four uses are that default, a counter's initial value, a comparison against the sentinel, and a reset. No file is read here, so there is no read cap to waive",
  },
};

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
      // A NOT_A_READ_CAP file is excused the TOKEN only -- its count is pinned by the test below -- and is held to
      // the reader call like every other file. Excusing it whole is what let a real read hide in that ledger.
      .flatMap((file) => matchesIn(file, file in NOT_A_READ_CAP ? UNBOUNDED_READER_CALL : UNBOUNDED_SIZE));

    expect(offenders).toEqual([]);
  });

  test("every non-read use of the waiver token is still pinned by count and carries a reason", () => {
    // Without this pin, "that file's POSITIVE_INFINITY is not a cap" would exempt the whole file forever --
    // including a genuine read waiver added to it later, which is precisely the shape of hole SIZE_EXEMPT exists
    // to close. Pinning the count means a fifth occurrence has to be classified before it can land.
    const files = new Set(scannedFiles());
    const actual: Record<string, number> = {};
    const pinned: Record<string, number> = {};
    for (const [file, entry] of Object.entries(NOT_A_READ_CAP)) {
      expect({ file, exists: files.has(file) }).toEqual({ file, exists: true });
      expect(entry.why.length).toBeGreaterThan(20);
      // The token only: a reader call in one of these files is an offence, not a classifiable use, and the test
      // above refuses it there. Counting it here would let the pin absorb it.
      actual[file] = matchesIn(file, CAP_WAIVER_TOKEN).length;
      pinned[file] = entry.uses;
    }
    expect(actual).toEqual(pinned);
  });

  test("no file reaches one of the project's own unbounded readers under another name", () => {
    // Evasion 1 (`readFile as slurp`) reappearing against JSLab's own reader: the waiver is matched as a CALL, so
    // an alias leaves nothing to match and the read vanishes from SIZE_EXEMPT altogether. Proven twice, with an
    // aliased import and with the local-const rename `runner-config.ts` already uses: both left the gate fully
    // green. Renaming these is never legitimate, so -- like the node:fs rename -- this carries no exemption.
    //
    // Deliberately no "N pass / N fail" figures in this comment: bun echoes the source around a failing assertion,
    // so a probe script that scrapes totals out of the run reads them back out of THIS prose instead. That is not
    // hypothetical -- it happened while proving this very test, and reported a caught evasion as an uncaught one.
    const offenders = scannedFiles().flatMap((file) => matchesIn(file, RENAMED_UNBOUNDED_READER));

    expect(offenders).toEqual([]);
  });

  test("no file but the shared reader hand-rolls a whole-file read out of the SYNCHRONOUS fd primitives", () => {
    // bounded-read.ts is written in exactly this openSync/fstatSync/readSync shape, which is what makes the shape
    // the likeliest to be copied by someone doing the right thing badly -- and copying it is how an allowlisted
    // file reads a whole file without moving the count that pins it.
    //
    // The name says SYNCHRONOUS because that is all this enforces. `open()` from node:fs/promises plus
    // `handle.read()` passes this test, and every other test here, in every file. The header's limits say so and
    // why. An earlier name -- "out of fd primitives" -- claimed the pair; that overclaim is the defect this
    // rename fixes, because a gate whose own names overstate their coverage teaches exactly the habit it exists
    // to punish.
    const offenders = scannedFiles()
      .filter((file) => file !== THE_READER)
      .flatMap((file) => matchesIn(file, FD_PRIMITIVE));

    expect(offenders).toEqual([]);
  });
});
