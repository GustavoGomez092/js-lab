// TF-20 (spec §4.6): declare the JS/TS family as document types in the packaged app's Info.plist, so macOS
// offers JSLab for them in Finder's "Open With", on a double-click and on a drag to the Dock.
//
// Wired to BOTH the `postBuild` and `postWrap` hooks in electrobun.config.ts. Three facts, all established
// empirically by the M0-S5 spike (docs/spikes/2026-09-m0-report.md) rather than read off the documentation:
//
//  1. `postWrap` is NOT early enough on macOS, despite its docs saying "before final packaging/signing".
//     Hutch's macOS pipeline compresses the fully-assembled .app into a tar.zst install/update payload BEFORE
//     `postWrap` fires, then assembles a small self-extracting installer *stub* at the same path and points
//     `ELECTROBUN_WRAPPER_BUNDLE_PATH` at that stub. Patching only the stub leaves the real app — the one
//     macOS actually registers — with no document types at all, which the spike confirmed by extracting the
//     stub's embedded payload and finding zero `CFBundleDocumentTypes` entries.
//  2. `postBuild` fires before that compression, when the real .app is still on disk. It has no documented
//     app-path variable, but the bundle sits at
//     `${ELECTROBUN_BUILD_DIR}/${ELECTROBUN_APP_NAME}-${ELECTROBUN_BUILD_ENV}.app`, which this script derives
//     when no explicit path is given. This hook is the one that makes file association work.
//  3. `postWrap` is kept anyway: patching the stub's own plist is free and harmless, and may matter to other
//     tooling that inspects the installer.
//
// `LSHandlerRank: "Alternate"` on every entry is ruling R7 and is not optional: JSLab must never outrank the
// user's own editor as the default handler for a .js or .ts file. Electrobun 2.0.1's native
// `app.fileAssociations` config field would be less code, but it exposes no rank control, which is why this
// script ships instead — see the note in electrobun.config.ts.
import { join } from "node:path";

/** Spec §4.6: the four RunJS associates, plus the four module/CommonJS variants JSLab adds. */
export const ASSOCIATED_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"] as const;

export interface DocumentType {
  CFBundleTypeName: string;
  CFBundleTypeRole: "Editor";
  LSHandlerRank: "Alternate";
  CFBundleTypeExtensions: string[];
}

/** One entry per extension. Exported so the shape is unit-testable without running a build. */
export function documentTypesFor(extensions: readonly string[]): DocumentType[] {
  return extensions.map((ext) => ({
    CFBundleTypeName: `${ext.toUpperCase()} source`,
    CFBundleTypeRole: "Editor",
    LSHandlerRank: "Alternate",
    CFBundleTypeExtensions: [ext],
  }));
}

/**
 * The .app to patch. An explicit argument wins, then the `postWrap` variable, then the `postBuild`-derived
 * path. Returns null when nothing names a bundle, so the caller can fail loudly rather than patch a guess.
 */
export function resolveAppPath(env: Record<string, string | undefined>, argument?: string): string | null {
  if (argument) return argument;
  if (env.ELECTROBUN_WRAPPER_BUNDLE_PATH) return env.ELECTROBUN_WRAPPER_BUNDLE_PATH;
  if (env.ELECTROBUN_APP_PATH) return env.ELECTROBUN_APP_PATH;
  const { ELECTROBUN_BUILD_DIR: dir, ELECTROBUN_APP_NAME: name, ELECTROBUN_BUILD_ENV: buildEnv } = env;
  if (dir && name && buildEnv) return join(dir, `${name}-${buildEnv}.app`);
  return null;
}

if (import.meta.main) {
  const appPath = resolveAppPath(process.env, process.argv[2]);
  if (!appPath) {
    throw new Error(
      "patch-plist: no app bundle to patch. Pass one (`bun scripts/patch-plist.ts <path-to-.app>`) or set " +
        "ELECTROBUN_WRAPPER_BUNDLE_PATH, or ELECTROBUN_BUILD_DIR + ELECTROBUN_APP_NAME + ELECTROBUN_BUILD_ENV.",
    );
  }
  const plist = join(appPath, "Contents", "Info.plist");

  // `-remove` then `-insert` rather than a bare insert, so re-running the hook (a rebuild, or the second of
  // the two wired hooks) replaces the entries instead of appending a duplicate set. A first run has nothing
  // to remove, and plutil says so on stderr rather than failing; that one message is the only tolerated one.
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["plutil", ...args], { stderr: "pipe" });
    const stderr = result.stderr.toString();
    if (result.exitCode !== 0 && !stderr.includes("No value to remove")) {
      throw new Error(`patch-plist: plutil ${args[0]} failed for ${plist}: ${stderr.trim()}`);
    }
  };
  run(["-remove", "CFBundleDocumentTypes", plist]);
  run(["-insert", "CFBundleDocumentTypes", "-json", JSON.stringify(documentTypesFor(ASSOCIATED_EXTENSIONS)), plist]);
  console.log(`patch-plist: declared ${ASSOCIATED_EXTENSIONS.length} document types in ${plist}`);
}
