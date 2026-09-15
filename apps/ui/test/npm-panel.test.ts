import { describe, expect, mock, test } from "bun:test";
import type { NpmOperation } from "@jslab/rpc-schema";
import {
  createSearchScheduler,
  installTargetFor,
  isHighlighted,
  isMajorUpdate,
  maskCredentials,
  operationStatusMessage,
  shouldSearch,
  visibleInstalled,
} from "../src/npm/npm-panel";
import type { TimerApi } from "../src/state/auto-run";
import { strings } from "../src/strings";

describe("NPM panel logic (spec §11.2)", () => {
  test("Enter installs versioned, git, tarball and path specs, or an exact result name; plain names search", () => {
    const results = [{ name: "zod", version: "4.6.4", description: "", weeklyDownloads: null }];
    expect(installTargetFor("zod@4.6.4", [])).toBe("zod@4.6.4");
    expect(installTargetFor("@scope/name@latest", [])).toBe("@scope/name@latest");
    expect(installTargetFor("git+https://example.test/a.git", [])).toBe("git+https://example.test/a.git");
    expect(installTargetFor("zod", results)).toBe("zod");
    expect(installTargetFor("zo", results)).toBeNull();
    expect(installTargetFor("not a spec", results)).toBeNull();
    expect(["zod", "zod@4", "https://x.test/a.tgz", "z"].map(shouldSearch)).toEqual([true, false, false, false]);
  });

  test("@types rows are hidden unless Show @types is on, and a new row is highlighted for 2 s", () => {
    const installed = [
      { name: "@types/node", version: "22.20.2", latest: null },
      { name: "zod", version: "4.6.4", latest: null },
    ];
    expect(visibleInstalled(installed, false).map((p) => p.name)).toEqual(["zod"]);
    expect(visibleInstalled(installed, true)).toHaveLength(2);
    expect(isHighlighted({ name: "zod", at: 1000 }, "zod", 2999)).toBe(true);
    expect(isHighlighted({ name: "zod", at: 1000 }, "zod", 3001)).toBe(false);
    expect(isHighlighted(null, "zod", 0)).toBe(false);
  });

  test("search runs 300 ms after the last keystroke", () => {
    const pending: (() => void)[] = [];
    const timers: TimerApi = {
      setTimeout: (callback) => pending.push(callback),
      clearTimeout: () => pending.splice(0),
    };
    const search = mock((_query: string) => {});
    const scheduler = createSearchScheduler(search, timers);
    scheduler.input("z");
    scheduler.input("zo");
    scheduler.input("zod");
    for (const callback of pending.splice(0)) callback();
    expect(search.mock.calls).toEqual([["zod"]]);
  });

  // R26-1: a major crossing (leading integer differs, or major 0 with a minor change) needs its own badge.
  test("isMajorUpdate flags a leading-integer or 0.x minor change, and false for unparsable input", () => {
    expect(isMajorUpdate("1.0.0", "2.0.0")).toBe(true);
    expect(isMajorUpdate("0.3.1", "0.4.0")).toBe(true);
    expect(isMajorUpdate("1.0.0", "1.1.0")).toBe(false);
    expect(isMajorUpdate(null, "1.0.0")).toBe(false);
  });

  // R26-6: a finished operation reports a status-bar sentence when the sheet is closed; queued/running are silent.
  test("operationStatusMessage reports success and failure sentences, and null while queued or running", () => {
    const base: NpmOperation = {
      id: "o1",
      kind: "install",
      target: "zod",
      status: "queued",
      error: null,
      notice: null,
    };
    expect(operationStatusMessage(base, "⌘R")).toBeNull();
    expect(operationStatusMessage({ ...base, status: "running" }, "⌘R")).toBeNull();
    expect(operationStatusMessage({ ...base, status: "succeeded" }, "⌘R")).toBe(
      strings.npm.done("install", "zod", "⌘R"),
    );
    expect(operationStatusMessage({ ...base, status: "succeeded" }, null)).toBe(
      strings.npm.done("install", "zod", null),
    );
    const failed: NpmOperation = {
      id: "o2",
      kind: "update",
      target: "zod",
      status: "failed",
      error: { kind: "network", log: "x" },
      notice: null,
    };
    expect(operationStatusMessage(failed, "⌘R")).toBe(
      strings.npm.doneFailed("update", "zod", strings.npm.hints.network),
    );
  });

  // M-6 (parked, closed here); extended in fix round 2 (M-1) for the remaining shapes the review found.
  test("maskCredentials strips URL userinfo and _authToken/_auth/_password values, keeping the host visible", () => {
    const NL = String.fromCharCode(10);
    const text = [
      "https://user:secret@registry.example/",
      "//registry.example/:_authToken=abc123",
      "_auth = abc123",
      "_password=abc123",
    ].join(NL);
    const masked = maskCredentials(text);
    expect(masked.includes("secret")).toBe(false);
    expect(masked.includes("abc123")).toBe(false);
    expect(masked.includes("registry.example")).toBe(true);
    expect(maskCredentials("plain log, no credentials here")).toBe("plain log, no credentials here");

    // Fix round 2 (M-1): case-insensitive keys, the JSON/colon form, a quoted value with a space, a URL whose
    // password contains a quote (redactRegistryUrl can't parse it, so a linear userinfo fallback applies), and
    // an Authorization header.
    expect(maskCredentials("_AUTHTOKEN=abc123").includes("abc123")).toBe(false);
    expect(maskCredentials("//r.example/:_AuthToken=abc123").includes("abc123")).toBe(false);
    expect(maskCredentials('"_authToken": "abc123"').includes("abc123")).toBe(false);
    const quotedSpace = maskCredentials('_authToken="xx abc123"');
    expect(quotedSpace.includes("abc123")).toBe(false);
    expect(quotedSpace.includes("xx abc123")).toBe(false);
    const quotedPassword = maskCredentials('https://user:pa"ss@registry.example/');
    expect(quotedPassword.includes('pa"ss')).toBe(false);
    expect(maskCredentials("Authorization: Bearer abc123").includes("abc123")).toBe(false);
  });

  // Fix round 2 (I-2): the review measured the unbounded URL scheme quantifier at 2.2 s for 64k chars and
  // 9.7 s for 128k (quadratic); a bounded scheme keeps this linear.
  test("credential masking stays fast on long token-like runs", () => {
    const budgetMs = 200;

    const start64 = performance.now();
    maskCredentials("a".repeat(64_000));
    expect(performance.now() - start64).toBeLessThan(budgetMs);

    const start128 = performance.now();
    maskCredentials("a".repeat(128_000));
    expect(performance.now() - start128).toBeLessThan(budgetMs);

    const NL = String.fromCharCode(10);
    const mixedLine = "npm info install ok, resolving dependencies for @scope/pkg version 1.2.3 from registry";
    const mixedLog = new Array(700).fill(mixedLine).join(NL);
    const startMixed = performance.now();
    maskCredentials(mixedLog);
    expect(performance.now() - startMixed).toBeLessThan(budgetMs);
  });
});
