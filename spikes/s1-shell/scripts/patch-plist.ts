// S5 spike: patch the packaged .app's Info.plist with CFBundleDocumentTypes
// for the JS/TS family of extensions.
//
// Deviations from the task-5 brief, found empirically (see docs/spikes S5):
//
// 1. The brief's skeleton read `process.env.ELECTROBUN_APP_PATH`. The pinned
//    Electrobun 2.0.1 docs (apis/cli/build-configuration.mdx, "Build Hooks")
//    instead document `ELECTROBUN_WRAPPER_BUNDLE_PATH` for the `postWrap`
//    hook. This script reads that variable (falling back to
//    `ELECTROBUN_APP_PATH` in case some other hook uses that name).
//
// 2. `postWrap` alone is NOT early enough on macOS. Empirically, Hutch's
//    macOS release pipeline compresses the fully-assembled .app into a
//    tar.zst update/install payload ("compressing update bundle...") BEFORE
//    `postWrap` fires. `postWrap`'s `ELECTROBUN_WRAPPER_BUNDLE_PATH` points
//    at a small self-extracting installer *stub* (CFBundleIdentifier
//    "extractor") whose own Info.plist has no CFBundleDocumentTypes once
//    extracted, in a postWrap-only build, observed during the S5 spike
//    (see docs/spikes/2026-09-m0-report.md, S5 "Deviations from the brief"
//    item 2, for the raw `plutil -p` output) — patching only that stub's
//    plist leaves the real, installed .app's Info.plist unpatched.
//
//    So this script is also wired to the `postBuild` hook, which fires
//    *before* that compression step. `postBuild` has no documented app-path
//    env var, but empirically the real, not-yet-compressed .app sits at
//    `${ELECTROBUN_BUILD_DIR}/${ELECTROBUN_APP_NAME}-${ELECTROBUN_BUILD_ENV}.app`
//    at that point (the same path `ELECTROBUN_WRAPPER_BUNDLE_PATH` names
//    later, once the compressed payload has replaced it with the installer
//    stub). This script derives that path when no explicit path/env var is
//    given. Patching at `postWrap` too is harmless and kept for belt-and-
//    braces coverage of the stub's own plist.
import { join } from "node:path";

const derivedBuildAppPath =
  process.env.ELECTROBUN_BUILD_DIR && process.env.ELECTROBUN_APP_NAME && process.env.ELECTROBUN_BUILD_ENV
    ? join(
        process.env.ELECTROBUN_BUILD_DIR,
        `${process.env.ELECTROBUN_APP_NAME}-${process.env.ELECTROBUN_BUILD_ENV}.app`
      )
    : undefined;
const appPath =
  process.argv[2] ??
  process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH ??
  process.env.ELECTROBUN_APP_PATH ??
  derivedBuildAppPath;
if (!appPath) {
  throw new Error(
    "usage: bun scripts/patch-plist.ts <path-to-.app> (or set ELECTROBUN_WRAPPER_BUNDLE_PATH)"
  );
}
const plist = join(appPath, "Contents", "Info.plist");
const extensions = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"];
const documentTypes = extensions.map((ext) => ({
  CFBundleTypeName: `${ext.toUpperCase()} source`,
  CFBundleTypeRole: "Editor",
  LSHandlerRank: "Alternate",
  CFBundleTypeExtensions: [ext],
}));
const run = (args: string[]) => {
  const result = Bun.spawnSync(["plutil", ...args], { stderr: "pipe" });
  if (result.exitCode !== 0 && !result.stderr.toString().includes("No value to remove")) {
    throw new Error(result.stderr.toString());
  }
};
run(["-remove", "CFBundleDocumentTypes", plist]);
run(["-insert", "CFBundleDocumentTypes", "-json", JSON.stringify(documentTypes), plist]);
console.log(`patched ${plist}`);
