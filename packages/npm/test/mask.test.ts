import { describe, expect, test } from "bun:test";
import { maskCredentials } from "../src/mask";

const NL = String.fromCharCode(10);

describe("maskCredentials (R-M3-T26-FIX-3: one masker shared by Main and the UI)", () => {
  // Moved from apps/ui/test/npm-panel.test.ts (M-6, extended in fix round 2 for M-1).
  test("maskCredentials strips URL userinfo and _authToken/_auth/_password values, keeping the host visible", () => {
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
    // an Authorization header. Fix round 3: an Authorization value must now be token-like (8+ characters), so
    // the header fixture uses an 8-character token.
    expect(maskCredentials("_AUTHTOKEN=abc123").includes("abc123")).toBe(false);
    expect(maskCredentials("//r.example/:_AuthToken=abc123").includes("abc123")).toBe(false);
    expect(maskCredentials('"_authToken": "abc123"').includes("abc123")).toBe(false);
    const quotedSpace = maskCredentials('_authToken="xx abc123"');
    expect(quotedSpace.includes("abc123")).toBe(false);
    expect(quotedSpace.includes("xx abc123")).toBe(false);
    const quotedPassword = maskCredentials('https://user:pa"ss@registry.example/');
    expect(quotedPassword.includes('pa"ss')).toBe(false);
    expect(maskCredentials("Authorization: Bearer abc12345").includes("abc12345")).toBe(false);
  });

  // Moved from apps/ui/test/npm-panel.test.ts (fix round 2, I-2): the review measured the unbounded URL scheme
  // quantifier at 2.2 s for 64k chars and 9.7 s for 128k (quadratic); every pattern must stay linear.
  test("credential masking stays fast on long token-like runs", () => {
    const budgetMs = 200;
    const shapes: [string, (size: number) => string][] = [
      ["letter run", (size) => "a".repeat(size)],
      ["scheme-like repeats", (size) => "a://".repeat(size / 4)],
      ["31 letters and a colon-slash", (size) => `${"a".repeat(31)}:/`.repeat(Math.floor(size / 33))],
      ["a scheme then a long userinfo with no @", (size) => `${"a".repeat(31)}://${"x".repeat(size)}`],
      ["double slash then a letter run", (size) => `//${"a".repeat(size)}`],
      ["an unclosed quoted value", (size) => `_auth="${"x".repeat(size)}`],
      ["key and spaces", (size) => `_auth=${" ".repeat(size)}`],
      ["authorization and spaces", (size) => `authorization: bearer${" ".repeat(size)}`],
      ["repeated authorization headers", (size) => "authorization: bearer ".repeat(Math.floor(size / 22))],
    ];
    for (const size of [64_000, 128_000]) {
      for (const [name, build] of shapes) {
        const input = build(size);
        const start = performance.now();
        maskCredentials(input);
        const elapsed = performance.now() - start;
        if (elapsed >= budgetMs) throw new Error(`${name} at ${size} took ${elapsed.toFixed(1)} ms`);
        expect(elapsed).toBeLessThan(budgetMs);
      }
    }

    const mixedLine = "npm info install ok, resolving dependencies for @scope/pkg version 1.2.3 from registry";
    const mixedLog = new Array(700).fill(mixedLine).join(NL);
    const startMixed = performance.now();
    maskCredentials(mixedLog);
    expect(performance.now() - startMixed).toBeLessThan(budgetMs);
  });

  // Fix round 3 (N-c, Nm-2): a key inside a longer identifier, prose after "authorization:", and a scoped path
  // after a double slash are not credentials; masking must also be a fixed point for every shape it touches.
  test("masking has no false positives and is idempotent", () => {
    const unchanged = [
      "my_auth: enabled",
      "no_auth = required",
      "authorization: basic setup",
      "See authorization: basic setup in docs",
      "node_modules//@types",
      "node_modules//@types/node",
      "https://registry.example//@scope/pkg",
      "//TODO@me fix",
      "_authentication=true",
      "_authorization=enabled",
      "the authorization: step failed",
      "oauth_password_reset=1",
      "email me at foo@bar.com",
      "// comment @decorator",
      "file:///Users/x/@scope/pkg",
      "https://registry.npmjs.org/@types%2fnode",
      "GET https://registry.example/zod 200",
    ];
    for (const text of unchanged) {
      expect(maskCredentials(text)).toBe(text);
    }

    const masked: [string, string[]][] = [
      ["https://user:secret@registry.example/", ["secret", "user:"]],
      ["//registry.example/:_authToken=abc123", ["abc123"]],
      ["//r/:_authToken=abc123", ["abc123"]],
      ["_auth = abc123", ["abc123"]],
      ["_password=abc123", ["abc123"]],
      ["_AUTHTOKEN=abc123", ["abc123"]],
      ["//r.example/:_AuthToken=abc123", ["abc123"]],
      ['"_authToken": "abc123"', ["abc123"]],
      ["'_authToken': 'abc123'", ["abc123"]],
      ['_authToken="xx abc123"', ["abc123", "xx"]],
      ["_password: 'abc 123'", ["abc 123", "abc"]],
      ['https://user:pa"ss@registry.example/', ['pa"ss', "user:"]],
      ["https://user:pa'ss@registry.example/", ["pa'ss", "user:"]],
      ["Authorization: Bearer abc12345", ["abc12345"]],
      ["authorization: basic abc12345", ["abc12345"]],
      ["AUTHORIZATION:Bearer abc12345", ["abc12345"]],
      ["Proxy-Authorization: Basic abc12345", ["abc12345"]],
      [`Authorization: Bearer${NL}abc12345`, ["abc12345"]],
      [`_authToken=${NL}abc123`, ["abc123"]],
      ['{"registry":"https://user:secret@r.example/","//r/:_authToken":"abc123"}', ["secret", "abc123"]],
      ["git+https://ghp_FAKE12345@github.com/o/r.git", ["ghp_FAKE12345"]],
      ["GET https://user:secret@registry.example/zod - ConnectionRefused", ["secret"]],
    ];
    for (const [text, secrets] of masked) {
      const once = maskCredentials(text);
      for (const secret of secrets) {
        if (once.includes(secret)) throw new Error(`${JSON.stringify(text)} kept ${JSON.stringify(secret)}: ${once}`);
        expect(once.includes(secret)).toBe(false);
      }
      expect(maskCredentials(once)).toBe(once);
    }
    for (const text of unchanged) {
      expect(maskCredentials(maskCredentials(text))).toBe(maskCredentials(text));
    }
    // The host stays readable after the userinfo is gone.
    expect(maskCredentials('https://user:pa"ss@registry.example/').includes("registry.example")).toBe(true);
    expect(maskCredentials("GET https://user:secret@registry.example/zod - ConnectionRefused")).toBe(
      "GET https://registry.example/zod - ConnectionRefused",
    );
  });
});
