import { describe, expect, test } from "bun:test";
import { externalLinkFrom, navigationRulesFor } from "../src/main/navigation";

describe("navigation rules (spec §18)", () => {
  test("the UI view may only navigate within views://", () => {
    expect(navigationRulesFor("views://mainview/index.html")).toEqual(["^*", "views://*"]);
  });

  test("the dev server origin is allowed only when it is the loaded URL", () => {
    expect(navigationRulesFor("http://localhost:5173")).toEqual([
      "^*",
      "views://*",
      "http://localhost:5173",
      "http://localhost:5173/*",
    ]);
  });
});

describe("external links", () => {
  const detail = (url: string, allowed: boolean) => JSON.stringify({ url, allowed });

  test("a blocked web or mail link opens in the default browser", () => {
    expect(externalLinkFrom(detail("https://bun.sh/docs", false))).toBe("https://bun.sh/docs");
    expect(externalLinkFrom(detail("http://example.com/", false))).toBe("http://example.com/");
    expect(externalLinkFrom(detail("mailto:someone@example.com", false))).toBe("mailto:someone@example.com");
    expect(externalLinkFrom({ url: "https://bun.sh/", allowed: false })).toBe("https://bun.sh/");
  });

  test("allowed navigations and other schemes are never opened externally", () => {
    expect(externalLinkFrom(detail("views://mainview/index.html", true))).toBeNull();
    expect(externalLinkFrom(detail("https://bun.sh/", true))).toBeNull();
    expect(externalLinkFrom(detail("file:///etc/passwd", false))).toBeNull();
    expect(externalLinkFrom(detail("javascript:alert(1)", false))).toBeNull();
    expect(externalLinkFrom(detail("not a url", false))).toBeNull();
    expect(externalLinkFrom("{broken json")).toBeNull();
    expect(externalLinkFrom(undefined)).toBeNull();
  });
});
