import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_LOCALE } from "@jslab/shared";

test("the CSP restricts base URIs and form submissions", () => {
  const html = readFileSync(join(import.meta.dir, "../src/index.html"), "utf8");
  const csp = /http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)?.[1] ?? "";
  const directives = csp.split(";").map((directive) => directive.trim());
  expect(directives).toContain("default-src 'self' views:");
  expect(directives).toContain("base-uri 'self'");
  expect(directives).toContain("form-action 'none'");
  // The Settings window is RPC-bridged too, so its page carries the identical policy (review m-1).
  const settingsHtml = readFileSync(join(import.meta.dir, "../src/settings.html"), "utf8");
  const contentOf = (text: string) => /content="(default-src[^"]*)"/.exec(text)?.[1];
  expect(contentOf(html)).toBe(csp);
  expect(contentOf(settingsHtml)).toBe(csp);
});

test("both pages declare the source locale statically (spec §17)", () => {
  // The static attribute has to track SOURCE_LOCALE rather than a hand-written "en": it is what a screen reader
  // sees before any script runs, and what remains if an entry point's applyDocumentLocale() call is ever lost.
  //
  // Deliberately NOT a claim that the per-locale override happens -- that is asserted against a real document in
  // i18n-document-lang.test.ts. The <title> elements stay literal: `JSLab` is the product name, and the Settings
  // window's title is replaced at runtime by BrowserWindow's own `title` option, routed through the catalogue in
  // Task 5.
  for (const file of ["../src/index.html", "../src/settings.html"]) {
    const markup = readFileSync(join(import.meta.dir, file), "utf8");
    expect(markup).toContain(`<html lang="${SOURCE_LOCALE}">`);
  }
});
