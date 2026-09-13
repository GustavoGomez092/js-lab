import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the CSP restricts base URIs and form submissions", () => {
  const html = readFileSync(join(import.meta.dir, "../src/index.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
  const directives = csp.split(";").map((directive) => directive.trim());
  expect(directives).toContain("default-src 'self' views:");
  expect(directives).toContain("base-uri 'self'");
  expect(directives).toContain("form-action 'none'");
});
