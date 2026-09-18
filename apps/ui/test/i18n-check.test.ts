import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCALES, SOURCE_LOCALE } from "@jslab/shared";
import { type CheckInput, checkLocales, collectUsedKeys, flattenKeys, MIN_KEYS } from "../src/i18n/check";

const UI_ROOT = join(import.meta.dir, "..");
const REPO_ROOT = join(UI_ROOT, "..", "..");
const CLI = join(UI_ROOT, "scripts", "i18n-check.ts");

const en = { menu: { file: "File", quit: "Quit {{app}}" } };
const manifest = ["menu.file", "menu.quit"];
const sources = [{ path: "a.ts", text: `t("menu.file"); t("menu.quit", { app: "JSLab" });` }];
const coverage = { es: 0, ja: 0, pt: 0, zh: 0 };
const empty = { es: {}, ja: {}, pt: {}, zh: {} };

/** A 2-key catalogue that is clean in every other respect, so only the `MIN_KEYS` floor can fail it. */
const small: CheckInput = { locales: { en, ...empty }, sources, manifest, coverage };

/**
 * `MIN_KEYS` is a floor on the real catalogue, so every "this input is healthy" fixture has to clear it --
 * otherwise no test could ever observe `ok === true` and a mutant deleting the floor would survive.
 */
const FILLER = Array.from({ length: MIN_KEYS - manifest.length }, (_, index) => `k${String(index).padStart(5, "0")}`);
const bigEn = {
  filler: Object.fromEntries(FILLER.map((name, index) => [name, `Filler ${index}`])),
  menu: en.menu,
};
const bigManifest = [...FILLER.map((name) => `filler.${name}`), ...manifest];
const bigSources = [{ path: "a.ts", text: FILLER.map((name) => `t("filler.${name}");`).join("\n") }, ...sources];

/** The healthy baseline every failure case below deviates from by exactly one thing. */
function big(over: Partial<CheckInput> = {}): CheckInput {
  return { locales: { en: bigEn, ...empty }, sources: bigSources, manifest: bigManifest, coverage, ...over };
}

describe("flattenKeys", () => {
  test("produces sorted dotted paths and ignores non-string leaves", () => {
    expect(flattenKeys({ b: { y: "1", x: "2" }, a: "3", n: 7 })).toEqual(["a", "b.x", "b.y"]);
  });

  test("keeps i18next plural suffixes as distinct keys", () => {
    expect(flattenKeys({ tabs_one: "a", tabs_other: "b" })).toEqual(["tabs_one", "tabs_other"]);
  });

  test("a locale file that is not an object yields no keys rather than throwing", () => {
    // A corrupt or hand-mangled <lng>.json must fail the check by reporting nothing, not by crashing it.
    for (const value of [null, undefined, "text", 7, true]) {
      expect(flattenKeys(value)).toEqual([]);
    }
  });
});

describe("collectUsedKeys", () => {
  test("finds t() call sites, including multi-line and repeated ones", () => {
    const text = `t("a.b")\nt(\n  "c.d"\n)\nt("a.b")`;
    expect(collectUsedKeys([{ path: "a.ts", text }])).toEqual(["a.b", "c.d"]);
  });

  test("ignores a dynamic key and anything that merely ends in t(", () => {
    // `format(` and `split(` must not be mistaken for the translator, and neither must a member call:
    // `i18next.t(...)` is the raw library, whose keys are checked through the `t()` wrapper instead.
    const text = `t(key); format("x"); split("y"); i18next.t("member"); $t("dollar")`;
    expect(collectUsedKeys([{ path: "a.ts", text }])).toEqual([]);
  });

  test("reads every file it is given and sorts across them", () => {
    // Deliberately out of order on disk: the report is diffed against a committed manifest, so the order
    // has to come from the keys rather than from which file the walker happened to reach first.
    const files = [
      { path: "b.ts", text: `t("b.two")` },
      { path: "a.ts", text: `t("a.one")` },
    ];
    expect(collectUsedKeys(files)).toEqual(["a.one", "b.two"]);
  });
});

describe("checkLocales (spec §17)", () => {
  test("a clean catalogue at full size passes and reports its real total", () => {
    const report = checkLocales(big());
    expect(report.enKeys).toEqual(bigManifest);
    expect(report.enKeys.length).toBe(MIN_KEYS);
    expect(report.unknownKeys).toEqual([]);
    expect(report.unusedKeys).toEqual([]);
    expect(report.manifestDrift).toEqual({ added: [], removed: [] });
    expect(report.ok).toBe(true);
  });

  test("a catalogue below MIN_KEYS can never pass, however clean it otherwise is", () => {
    // The failure this whole check exists to prevent: a path typo loads a near-empty file, every list is
    // empty, and "no errors" reads as success. `small` is clean in every other respect, so this fails on
    // the floor alone.
    const report = checkLocales(small);
    expect(report.manifestDrift).toEqual({ added: [], removed: [] });
    expect(report.unknownKeys).toEqual([]);
    expect(report.unusedKeys).toEqual([]);
    expect(report.ok).toBe(false);
    expect(MIN_KEYS).toBeGreaterThanOrEqual(464);
  });

  test("an empty catalogue fails rather than reading as a clean run", () => {
    const report = checkLocales({ ...small, locales: { en: {}, ...empty }, manifest: [] });
    expect(report.enKeys).toEqual([]);
    expect(report.ok).toBe(false);
  });

  test("a key used in source but absent from en fails, naming it", () => {
    const report = checkLocales(big({ sources: [...bigSources, { path: "b.ts", text: `t("menu.brandNew")` }] }));
    expect(report.unknownKeys).toEqual(["menu.brandNew"]);
    expect(report.ok).toBe(false);
  });

  test("a key in en that no call site uses fails, so deleted controls can't leave copy behind", () => {
    const report = checkLocales(
      big({
        locales: { en: { ...bigEn, menu: { ...en.menu, ghost: "Gone" } }, ...empty },
        manifest: [...bigManifest, "menu.ghost"],
      }),
    );
    expect(report.unusedKeys).toEqual(["menu.ghost"]);
    expect(report.ok).toBe(false);
  });

  test("drift from the committed manifest fails in both directions", () => {
    const report = checkLocales(big({ manifest: [...bigManifest.slice(0, -1), "menu.gone"] }));
    expect(report.manifestDrift).toEqual({ added: ["menu.quit"], removed: ["menu.gone"] });
    expect(report.ok).toBe(false);
  });

  test("a manifest holding the same keys but the wrong number of them fails", () => {
    // Both drift lists are empty here -- only the recorded total disagrees, which is what a duplicated
    // line in keys.json looks like.
    const report = checkLocales(big({ manifest: [...bigManifest, "menu.quit"] }));
    expect(report.manifestDrift).toEqual({ added: [], removed: [] });
    expect(report.enKeys.length).toBe(MIN_KEYS);
    expect(report.ok).toBe(false);
  });

  test("a key missing from the manifest fails even when the totals happen to match", () => {
    // `menu.file` swapped for a second copy of `menu.quit`: the count still agrees, so only `added` bites.
    const report = checkLocales(big({ manifest: [...bigManifest.slice(0, -2), "menu.quit", "menu.quit"] }));
    expect(report.manifestDrift.added).toEqual(["menu.file"]);
    expect(report.manifestDrift.removed).toEqual([]);
    expect(report.ok).toBe(false);
  });

  test("a stale manifest entry fails even when the totals happen to match", () => {
    // Two JSON spellings flatten to one key (`{ a: { b } }` and `{ "a.b": ... }`), which is the one shape
    // that lets `removed` decide on its own: the count agrees, nothing was added, and the floor is cleared.
    const locales = { en: { ...bigEn, "menu.quit": "duplicate spelling" }, ...empty };
    const report = checkLocales(big({ locales, manifest: [...bigManifest, "menu.gone"] }));
    expect(report.enKeys.length).toBe(MIN_KEYS + 1);
    expect(report.manifestDrift.added).toEqual([]);
    expect(report.manifestDrift.removed).toEqual(["menu.gone"]);
    expect(report.unusedKeys).toEqual([]);
    expect(report.ok).toBe(false);
  });

  test("a locale key that is not in en fails; a merely missing one does not", () => {
    const report = checkLocales(
      big({
        locales: { en: bigEn, es: { menu: { file: "Archivo", typo: "x" } }, ja: {}, pt: {}, zh: {} },
        coverage: { ...coverage, es: 1 },
      }),
    );
    const es = report.locales.find((entry) => entry.locale === "es");
    expect(es?.extra).toEqual(["menu.typo"]);
    expect(es?.missing).toContain("menu.quit");
    expect(es?.translated).toBe(1);
    expect(report.ok).toBe(false);
  });

  test("translation coverage may grow but never regress", () => {
    const locales = { en: bigEn, es: { menu: { file: "Archivo" } }, ja: {}, pt: {}, zh: {} };
    // Recorded 1, found 1: a partial translation is fine -- `missing` is reported, not fatal.
    expect(checkLocales(big({ locales, coverage: { ...coverage, es: 1 } })).ok).toBe(true);
    // Recorded 2, found 1: someone deleted a Spanish string. That is a regression, and it fails.
    const dropped = checkLocales(big({ locales, coverage: { ...coverage, es: 2 } }));
    expect(dropped.ok).toBe(false);
    expect(dropped.locales.find((entry) => entry.locale === "es")?.recorded).toBe(2);
  });

  test("a string copied verbatim from English does not count as translated", () => {
    // Otherwise the coverage gate could be satisfied by pasting en.json into ja.json.
    const locales = { en: bigEn, es: { menu: { file: "File" } }, ja: {}, pt: {}, zh: {} };
    const report = checkLocales(big({ locales, coverage: { ...coverage, es: 1 } }));
    expect(report.locales.find((entry) => entry.locale === "es")?.translated).toBe(0);
    expect(report.ok).toBe(false);
  });

  test("reports exactly the shipped locales other than the source one", () => {
    const report = checkLocales(big());
    expect(report.locales.map((entry) => entry.locale)).toEqual(LOCALES.filter((locale) => locale !== SOURCE_LOCALE));
  });

  test("a locale absent from coverage.json is recorded as zero rather than crashing", () => {
    const report = checkLocales(big({ coverage: {} }));
    expect(report.locales.every((entry) => entry.recorded === 0)).toBe(true);
    expect(report.ok).toBe(true);
  });
});

describe("the shipped catalogue (spec §17)", () => {
  const read = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  const enJson = read(join(UI_ROOT, "src", "i18n", "locales", "en.json"));

  test("every key Main asks for exists in en.json, so no window can be titled with a raw key", () => {
    // Main's t() returns the key itself when the catalogue lacks it (apps/desktop/src/main/i18n.ts), and
    // index.ts feeds t("app.settingsWindowTitle") straight into a window title. This is the static half of
    // that risk: a key asked for but never shipped.
    const mainSource = readFileSync(join(REPO_ROOT, "apps", "desktop", "src", "main", "index.ts"), "utf8");
    const used = collectUsedKeys([{ path: "apps/desktop/src/main/index.ts", text: mainSource }]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !flattenKeys(enJson).includes(key))).toEqual([]);
  });

  test("every locale file carries the keys it claims and none en.json lacks", () => {
    for (const locale of LOCALES) {
      const table = read(join(UI_ROOT, "src", "i18n", "locales", `${locale}.json`));
      expect(flattenKeys(table).filter((key) => !flattenKeys(enJson).includes(key))).toEqual([]);
    }
  });
});

describe("the i18n:check CLI", () => {
  test("runs green against the real tree, in bootstrap mode", () => {
    // A subprocess, because the CLI is what CI runs: this proves the script resolves its imports, finds the
    // locale files and the two source trees, and exits 0 -- none of which importing the engine would show.
    const run = Bun.spawnSync([process.execPath, CLI, "--bootstrap"], { cwd: UI_ROOT });
    const stdout = run.stdout.toString();
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    expect(stdout).toContain("i18n: ok");
    expect(stdout).toMatch(/i18n: \d+ keys in en\.json \(bootstrap\)/);
  });
});

describe("the noJsxLiterals lint rule (spec §17)", () => {
  const biome = JSON.parse(readFileSync(join(REPO_ROOT, "biome.json"), "utf8")) as {
    linter: { rules: { style?: Record<string, unknown> } };
    overrides: { includes: string[]; linter: { rules: { style?: Record<string, unknown> } } }[];
  };

  test("is on, at error, for every file the exemptions do not name", () => {
    expect(biome.linter.rules.style?.noJsxLiterals).toBe("error");
  });

  test("exempts test sources, which render fixture text rather than product copy", () => {
    const override = biome.overrides.find((entry) => entry.includes.includes("**/test/**"));
    expect(override?.linter.rules.style?.noJsxLiterals).toBe("off");
    expect(override?.includes).toEqual(["**/test/**", "**/isolated/**"]);
  });

  test("names the pre-existing offenders one file at a time, and every one still exists", () => {
    // A file-by-file list rather than a directory: a NEW component cannot inherit an exemption, and paying
    // the debt down is a visible diff. Phase B (Tasks 8-11) rewrites exactly these files and empties this.
    const override = biome.overrides.find((entry) => entry.includes.includes("apps/ui/src/tabs/TabBar.tsx"));
    expect(override?.linter.rules.style?.noJsxLiterals).toBe("off");
    expect(override?.includes).toEqual([
      "apps/ui/src/env/EnvVarsSheet.tsx",
      "apps/ui/src/npm/NpmSheet.tsx",
      "apps/ui/src/output/EntryRow.tsx",
      "apps/ui/src/output/ValueView.tsx",
      "apps/ui/src/shell/StatusBar.tsx",
      "apps/ui/src/shell/Toolbar.tsx",
      "apps/ui/src/shell/parts.tsx",
      "apps/ui/src/tabs/TabBar.tsx",
    ]);
    for (const path of override?.includes ?? []) {
      expect(readFileSync(join(REPO_ROOT, path), "utf8").length).toBeGreaterThan(0);
    }
  });
});
