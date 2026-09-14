import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyNpmFailure,
  detectNotice,
  MAX_NPM_LOG_CHARS,
  parseInstalled,
  parseOutdated,
  parseSearchResponse,
} from "../src/output";

interface CommandFixture {
  exitCode: number;
  stdout: string;
  stderr: string;
}
const fixture = (name: string): CommandFixture =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "bun-output", `${name}.json`), "utf8"));

describe("bun output parsing (captured from the bundled Bun, Task 9)", () => {
  test("parses the captured bun outdated table", () => {
    const outdated = fixture("outdated");
    expect(parseOutdated(`${outdated.stdout}\n${outdated.stderr}`)).toContainEqual({
      name: "fixture-outdated",
      current: "1.0.0",
      update: "1.0.0",
      latest: "1.1.0",
    });
  });

  test("parses box and ASCII tables, drops dependency-kind suffixes and ignores everything else", () => {
    const box = [
      "bun outdated v1.4.0 (<rev>)",
      "┌──────────────┬─────────┬────────┬────────┐",
      "│ Package      │ Current │ Update │ Latest │",
      "├──────────────┼─────────┼────────┼────────┤",
      "│ zod (dev)    │ 4.0.0   │ 4.0.0  │ 4.6.4  │",
      "│ @a/b         │ 1.0.0   │ 1.2.0  │ 2.0.0  │",
      "└──────────────┴─────────┴────────┴────────┘",
    ].join("\n");
    expect(parseOutdated(box)).toEqual([
      { name: "zod", current: "4.0.0", update: "4.0.0", latest: "4.6.4" },
      { name: "@a/b", current: "1.0.0", update: "1.2.0", latest: "2.0.0" },
    ]);
    expect(parseOutdated("| Package | Current | Update | Latest |\n|---|---|---|---|\n| x | 1 | 1 | 2 |")).toEqual([
      { name: "x", current: "1", update: "1", latest: "2" },
    ]);
    expect(parseOutdated("bun outdated v1.4.0\n")).toEqual([]);
  });

  test("reads installed packages from bun add output", () => {
    expect(parseInstalled(fixture("add-ok").stdout)).toEqual([{ name: "fixture-outdated", version: "1.0.0" }]);
    expect(parseInstalled("installed @a/b@2.0.0 with binaries:\ninstalled x@1.0.0-beta.1\n")).toEqual([
      { name: "@a/b", version: "2.0.0" },
      { name: "x", version: "1.0.0-beta.1" },
    ]);
  });

  test("classifies the captured network failure and keeps the raw log", () => {
    const network = fixture("add-network");
    const error = classifyNpmFailure(network);
    expect(error?.kind).toBe("network");
    expect(error?.log).toContain(network.stderr.trim().split("\n").at(-1) ?? "");
  });

  test("classifies the captured not-found and no-matching-version failures", () => {
    expect(classifyNpmFailure(fixture("add-not-found"))?.kind).toBe("notFound");
    expect(classifyNpmFailure(fixture("add-no-matching-version"))?.kind).toBe("noMatchingVersion");
  });

  test("classifies peer, native build, disk, timeout and unknown failures; success is not a failure", () => {
    const fail = (stderr: string, extra: { timedOut?: boolean } = {}) =>
      classifyNpmFailure({ exitCode: 1, stdout: "", stderr, ...extra })?.kind;
    expect(fail("error: incorrect peer dependency react@17")).toBe("peerConflict");
    expect(fail("gyp ERR! build error")).toBe("nativeBuild");
    expect(fail("error: ENOSPC: no space left on device")).toBe("disk");
    expect(fail("", { timedOut: true })).toBe("timeout");
    expect(fail("something odd")).toBe("unknown");
    expect(classifyNpmFailure({ exitCode: 0, stdout: "installed x@1.0.0", stderr: "" })).toBeNull();
    const long = classifyNpmFailure({ exitCode: 1, stdout: "a".repeat(MAX_NPM_LOG_CHARS), stderr: "tail" });
    expect(long?.log.length).toBe(MAX_NPM_LOG_CHARS);
    expect(long?.log.endsWith("tail")).toBe(true);
  });

  test("a blocked postinstall on a successful install is a notice", () => {
    expect(detectNotice(fixture("add-script-blocked"))).toBe("scriptBlocked");
    expect(detectNotice(fixture("add-ok"))).toBeNull();
  });

  test("parses registry search responses and tolerates missing fields", () => {
    expect(
      parseSearchResponse({
        objects: [
          {
            package: { name: "zod", version: "4.6.4", description: "TypeScript-first schema validation" },
            downloads: { weekly: 1234 },
          },
          { package: { name: "x", version: "1.0.0" } },
          { package: { version: "no name" } },
        ],
      }),
    ).toEqual([
      { name: "zod", version: "4.6.4", description: "TypeScript-first schema validation", weeklyDownloads: 1234 },
      { name: "x", version: "1.0.0", description: "", weeklyDownloads: null },
    ]);
    expect(parseSearchResponse("nope")).toEqual([]);
  });
});
