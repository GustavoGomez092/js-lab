import { describe, expect, test } from "bun:test";
import { defaultSettings, SETTINGS_SECTIONS } from "@jslab/shared";
import { coerceFieldValue, type FieldDef, fieldsFor, SETTINGS_FIELDS, SETTINGS_TABS } from "../src/settings/fields";
import { strings } from "../src/strings";

describe("settings fields", () => {
  test("every in-scope §8 key has exactly one field with a label and help text", () => {
    const settings = defaultSettings() as unknown as Record<string, Record<string, unknown>>;
    const expected = SETTINGS_SECTIONS.flatMap((section) =>
      Object.keys(settings[section] ?? {}).map((key) => `${section}.${key}`),
    ).sort();
    expect(SETTINGS_FIELDS.map((field): string => field.key).sort()).toEqual(expected);
    for (const field of SETTINGS_FIELDS) {
      expect(strings.settings.fields[field.key]?.label.length).toBeGreaterThan(0);
      expect(strings.settings.fields[field.key]?.help.length).toBeGreaterThan(0);
      expect(SETTINGS_TABS.map((tab) => tab.id)).toContain(field.tab);
    }
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      "general",
      "editor",
      "formatting",
      "appearance",
      // Spec §8: "General · Editor · Formatting · Appearance · Keybindings · AI · NPM · Build · Advanced".
      "keybindings",
      "npm",
      "build",
      "advanced",
    ]);
    expect(SETTINGS_FIELDS.find((field) => field.key === "app.uiLanguage")?.restart).toBe(true);
  });

  test("the Default Runtime help text doesn't claim browser runtimes are unavailable or that new tabs use Bun (M4 T9 fix round 1, I1)", () => {
    // AVAILABLE_RUNTIMES holds all three since M4 Task 9, so the old copy's first clause ("Browser runtimes
    // arrive in a later version") is false. Its second ("until then new tabs use Bun") is the wrong thing to say
    // either way: DEFAULT_RUNTIME is a setting the user controls, not a limitation -- M4 Task 9a points it back
    // at "bun" only until browser runs finish, and the help text must not re-acquire either claim.
    // Pinned exactly, plus a defensive check that neither false claim can silently creep back in another form.
    const help = strings.settings.fields["run.defaultRuntime"]?.help ?? "";
    expect(help).toBe("Runtime for new tabs.");
    expect(help).not.toContain("later version");
    expect(help).not.toContain("use Bun");
  });

  test("values are coerced to the key's type and range; invalid input is rejected", () => {
    const field = (key: string) =>
      SETTINGS_FIELDS.find((candidate) => candidate.key === key) as (typeof SETTINGS_FIELDS)[number];
    expect(coerceFieldValue(field("editor.hoverDelayMs"), "5000")).toBe(2000);
    expect(coerceFieldValue(field("editor.hoverDelayMs"), "12.6")).toBe(100);
    expect(coerceFieldValue(field("editor.hoverDelayMs"), "abc")).toBeNull();
    expect(coerceFieldValue(field("appearance.uiScale"), "1.234")).toBe(1.23);
    expect(coerceFieldValue(field("prettier.trailingComma"), "es5")).toBe("es5");
    expect(coerceFieldValue(field("prettier.trailingComma"), "some")).toBeNull();
    expect(coerceFieldValue(field("editor.lineWrap"), false)).toBe(false);
    expect(coerceFieldValue(field("appearance.font"), "  ")).toBeNull();
  });

  test("fields filter by tab, or search across tabs by label, help and key", () => {
    expect(fieldsFor("formatting", "")).toHaveLength(11);
    expect(fieldsFor(null, "print width").map((field) => field.key)).toEqual(["prettier.printWidth"]);
    expect(fieldsFor(null, "hoverDelayMs").map((field) => field.key)).toEqual(["editor.hoverDelayMs"]);
    expect(fieldsFor(null, "ligature").map((field) => field.key)).toEqual(["appearance.fontLigatures"]);
  });

  test("the NPM and Build tabs list their §8 fields in spec order", () => {
    expect(fieldsFor("npm", "").map((field) => field.key)).toEqual(["npm.allowInstallScripts", "npm.autoInstallTypes"]);
    expect(fieldsFor("build", "").map((field) => field.key)).toEqual([
      "build.decorators",
      "build.pipelineOperator",
      "build.doExpressions",
      "build.throwExpressions",
      "build.functionSent",
      "build.regexpModifiers",
      "build.optionalChainingAssign",
    ]);
    const decorators = SETTINGS_FIELDS.find((field) => field.key === "build.decorators") as FieldDef;
    expect(coerceFieldValue(decorators, "legacy")).toBe("legacy");
    expect(coerceFieldValue(decorators, "stage-1")).toBeNull();
  });
});
