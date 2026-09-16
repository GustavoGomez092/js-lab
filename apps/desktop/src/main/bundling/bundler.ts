import type { Runtime } from "@jslab/shared";
import { cssInject } from "./css-plugin";
import { nodePolyfills } from "./polyfill-plugin";
import { jslabResolve } from "./resolve-plugin";

export interface BundleOptions {
  /** Absolute path to the per-run entry file (already transpiled -- the bundler resolves and packages it). */
  entry: string;
  runtime: Runtime;
  /** The tab's working directory, or null when none is set (spec §5.3). */
  workingDirectory: string | null;
  /** `apps/desktop/src/main/app-paths.ts:46`'s `packagesNodeModules`. */
  packagesNodeModules: string;
}

/**
 * One bundle failure, presented like a transpile failure (spec §5.11): one error entry with a code frame, feeding
 * the same install-assist path (§11.4) transpile/runtime module-not-found errors already do. `specifier` is a
 * field of its own, not just folded into `message` -- Task 5's brief pins this exactly, since deriving `@a/b` from
 * `@a/b/c` (§11.4) needs the raw specifier text, not a substring match against prose.
 */
export interface BundleError {
  message: string;
  specifier?: string;
  line?: number;
  column?: number;
  codeFrame?: string;
}

/**
 * `imports` is the set of bare (npm-style) specifiers `jslabResolve` actually resolved into this bundle -- Task 6's
 * vendor cache keys its chunk on exactly this set (plus the `bun.lock` hash), so it has to travel with the result
 * rather than be re-derived later.
 */
export type BundleResult = { code: string; map: string; imports: string[] } | { error: BundleError };

interface BunResolveOrBuildMessage {
  name?: string;
  message?: string;
  specifier?: string;
  position?: { line: number; column: number; lineText: string } | null;
}

function buildCodeFrame(lineText: string, column: number): string {
  return `${lineText}\n${" ".repeat(Math.max(column - 1, 0))}^`;
}

/**
 * Bun.build's own resolve failure (a `ResolveMessage`) already carries the specifier and an accurate source
 * position (`position.line`/`position.column`, 0-indexed, plus `position.lineText`) -- there's no need to
 * reconstruct any of that ourselves for an ordinary missing package. Column is normalized to 1-indexed to match
 * `Diagnostic.column` (`packages/transform/src/types.ts`), which the rest of the app's error presentation expects.
 */
function fromBuildFailure(error: unknown): BundleError {
  const errors = (error as { errors?: BunResolveOrBuildMessage[] } | undefined)?.errors;
  const first = errors?.[0];
  if (!first) return { message: error instanceof Error ? error.message : String(error) };
  const position = first.position;
  return {
    message: first.message ?? "Bundle failed",
    ...(first.specifier ? { specifier: first.specifier } : {}),
    ...(position ? { line: position.line, column: position.column + 1 } : {}),
    ...(position?.lineText ? { codeFrame: buildCodeFrame(position.lineText, position.column + 1) } : {}),
  };
}

/**
 * `bundleForWeb` (spec §5.12, §5.11): turns one tab's transpiled entry into a single browser-runnable module.
 * `Bun.build({target:'browser', format:'esm', sourcemap:'external'})`, with the three plugins in the spec's exact
 * order -- `jslabResolve` (npm resolution, WD first), `nodePolyfills` (the §5.13 Node-builtin table/seam), then
 * `cssInject` (stylesheet imports).
 */
export async function bundleForWeb(options: BundleOptions): Promise<BundleResult> {
  const resolvedImports = new Set<string>();
  let capturedError: BundleError | null = null;

  try {
    const result = await Bun.build({
      entrypoints: [options.entry],
      target: "browser",
      format: "esm",
      sourcemap: "external",
      plugins: [
        jslabResolve(
          { workingDirectory: options.workingDirectory, packagesNodeModules: options.packagesNodeModules },
          resolvedImports,
        ),
        nodePolyfills(options.runtime, (error) => {
          capturedError ??= error;
        }),
        cssInject(),
      ],
    });

    const codeOutput = result.outputs.find((output) => output.kind === "entry-point");
    const mapOutput = result.outputs.find((output) => output.kind === "sourcemap");
    return {
      code: codeOutput ? await codeOutput.text() : "",
      map: mapOutput ? await mapOutput.text() : "",
      imports: [...resolvedImports],
    };
  } catch (error) {
    // A plugin (`nodePolyfills`, for a blocked Node builtin) may have already captured a richer error than
    // whatever `Bun.build`'s own thrown `AggregateError` carries here -- that one wins (spec §5.11: one entry).
    return { error: capturedError ?? fromBuildFailure(error) };
  }
}
