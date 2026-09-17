import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const UI_PACKAGE_JSON = join(import.meta.dir, "..", "package.json");

describe("the i18next dependency (spec §2 D1, §2 D8, §22.5)", () => {
  test("is declared, pinned exactly, and MIT — never a range", () => {
    const manifest = read(UI_PACKAGE_JSON);
    const dependencies = manifest.dependencies as Record<string, string>;
    const pin = dependencies.i18next;
    expect(pin).toBeDefined();
    // Spec §2 D1: "exact version pins". A range would let a `bun install` months from now
    // ship a different i18next into a signed build than the one this milestone tested.
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("resolves to an MIT package, so the §22.5 license check stays satisfiable", () => {
    const installed = read(join(import.meta.dir, "..", "node_modules", "i18next", "package.json"));
    expect(installed.license).toBe("MIT");
    expect(installed.version).toBe((read(UI_PACKAGE_JSON).dependencies as Record<string, string>).i18next);
    // §22.5 denies GPL anywhere in the dependency tree; i18next declares no runtime dependencies of its own.
    expect(installed.dependencies ?? {}).toEqual({});
  });

  test("actually loads: a truncated install (manifest present, dist/ missing) must fail this gate", async () => {
    // The two tests above only read package.json metadata. An aborted `bun install` can leave a
    // package "present and resolvable" by that measure — package.json intact, version/license
    // correct — while the file its "main"/"module"/"exports" point at (dist/) never landed. A
    // metadata-only check reports healthy in that truncated state too, which defeats the whole
    // point of gating on i18next: the dependency the app actually needs at runtime is missing.
    //
    // A dynamic `import()` is used instead of `require.resolve()` because resolution proves only
    // that a path exists on disk, whereas `import()` must additionally load and evaluate that file
    // and hand back real bindings. Asserting the shape of what comes back (not just that the
    // promise resolved) confirms the module is genuinely usable, not merely present.
    const installed: unknown = await import("i18next");
    const namedExport = (installed as { createInstance?: unknown }).createInstance;
    expect(typeof namedExport).toBe("function");
  });
});
