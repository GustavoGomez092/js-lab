import { describe, expect, test } from "bun:test";
import { npmrcWarnings } from "../src/settings/npmrc-lint";

const NL = String.fromCharCode(10);

describe("npmrcWarnings (spec §11.5, R27-3)", () => {
  test("flags a missing '=' and a non-URL registry value, by line number only, never echoing line content", () => {
    const text = [
      "registry=npm.acme.dev",
      "@a:registry=https://x/",
      "//x/:_authToken=npm_FAKE_TEST_TOKEN",
      "# c",
      "broken",
    ].join(NL);
    const warnings = npmrcWarnings(text);
    expect(warnings).toEqual([
      { line: 1, message: "registryNotUrl" },
      { line: 5, message: "missingEquals" },
    ]);
    expect(JSON.stringify(warnings)).not.toContain("npm_FAKE_TEST_TOKEN");
    expect(JSON.stringify(warnings)).not.toContain("npm.acme.dev");
  });
});
