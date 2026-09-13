import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type TsconfigLike = { compilerOptions?: Record<string, unknown> } & Record<string, unknown>;

/**
 * Hutch 0.24.3 generates the Electrobun devkit's `tsconfig.json` with a legacy `compilerOptions.baseUrl`.
 * TypeScript 7 has removed that option (`TS5102`), so it must be stripped before the devkit tsconfig can be
 * extended. `compilerOptions.paths` (and everything else) is left untouched, and relative `paths` entries
 * resolve against the config file's own directory once `baseUrl` is gone, so this has no resolution effect.
 * Pure and non-mutating: returns a new object, or the same reference when there is nothing to strip.
 */
export function stripBaseUrl(config: TsconfigLike): TsconfigLike {
  if (!config.compilerOptions || !("baseUrl" in config.compilerOptions)) {
    return config;
  }
  const { baseUrl: _baseUrl, ...restCompilerOptions } = config.compilerOptions;
  return { ...config, compilerOptions: restCompilerOptions };
}

if (import.meta.main) {
  const devkitTsconfigPath = join(import.meta.dir, "../.hutch/devkit/tsconfig.json");

  function fail(reason: string): never {
    console.error(`devkit-tsconfig: ${reason}. Run \`hutch electrobun sync\` (Hutch 0.24.3) first.`);
    process.exit(1);
  }

  if (!existsSync(devkitTsconfigPath)) {
    fail(`${devkitTsconfigPath} not found`);
  }

  const raw = readFileSync(devkitTsconfigPath, "utf8");

  let parsed: TsconfigLike;
  try {
    parsed = JSON.parse(raw) as TsconfigLike;
  } catch (error) {
    fail(`could not parse ${devkitTsconfigPath} (${(error as Error).message})`);
  }

  const stripped = stripBaseUrl(parsed);
  if (JSON.stringify(stripped) !== JSON.stringify(parsed)) {
    writeFileSync(devkitTsconfigPath, JSON.stringify(stripped));
  }
}
