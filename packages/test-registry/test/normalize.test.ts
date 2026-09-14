import { describe, expect, test } from "bun:test";
import { normalizeOutput } from "../src/normalize";

describe("normalizeOutput", () => {
  test("replaces temp paths, the registry, durations, revisions and ANSI escapes", () => {
    const raw =
      "[1mbun add v1.4.0 (34cbb9a40)[0m\ninstalled fixture-outdated@1.0.0 from http://127.0.0.1:50123/\n1 package installed [412.00ms]\nin /var/folders/xy/T/jslab-capture-1/project";
    expect(
      normalizeOutput(raw, [
        ["/var/folders/xy/T/jslab-capture-1", "<TMP>"],
        ["http://127.0.0.1:50123/", "<REGISTRY>/"],
      ]),
    ).toBe(
      "bun add v1.4.0 (<rev>)\ninstalled fixture-outdated@1.0.0 from <REGISTRY>/\n1 package installed [<ms>]\nin <TMP>/project",
    );
  });
});
