import { describe, expect, test } from "bun:test";
import { BUILT_VIEW_URL, DEV_SERVER_URL, resolveMainViewUrl, withLocale } from "../src/main/main-view-url";
import { navigationRulesFor } from "../src/main/navigation";

describe("resolveMainViewUrl (final review M2)", () => {
  test("only an opted-in dev channel uses the dev server, and a probe that never answers falls back in time", async () => {
    const ok = async () => new Response(null);
    const hang = () => new Promise<never>(() => {});
    expect(await resolveMainViewUrl({ channel: "dev", env: {}, probe: ok })).toBe(BUILT_VIEW_URL);
    expect(await resolveMainViewUrl({ channel: "canary", env: { JSLAB_DEV_SERVER: "1" }, probe: ok })).toBe(
      BUILT_VIEW_URL,
    );
    expect(await resolveMainViewUrl({ channel: "dev", env: { JSLAB_DEV_SERVER: "1" }, probe: ok })).toBe(
      DEV_SERVER_URL,
    );
    const started = Date.now();
    expect(
      await resolveMainViewUrl({ channel: "dev", env: { JSLAB_DEV_SERVER: "1" }, probe: hang, timeoutMs: 30 }),
    ).toBe(BUILT_VIEW_URL);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("withLocale (spec §17: the view learns its locale before its first render)", () => {
  test("adds lng to the built view and to the settings page, which has no query of its own", () => {
    expect(withLocale(BUILT_VIEW_URL, "ja")).toBe("views://mainview/index.html?lng=ja");
    expect(withLocale("views://mainview/settings.html", "pt")).toBe("views://mainview/settings.html?lng=pt");
  });

  test("adds lng to the dev server URL, where the path is empty", () => {
    expect(withLocale(DEV_SERVER_URL, "es")).toBe("http://localhost:5173/?lng=es");
    expect(withLocale(`${DEV_SERVER_URL}/settings.html`, "zh")).toBe("http://localhost:5173/settings.html?lng=zh");
  });

  test("replaces an existing lng rather than appending a second one", () => {
    // Guards the relaunch path: a URL is rebuilt per window, and two lng parameters would make
    // URLSearchParams.get return the first -- silently pinning the old locale forever.
    expect(withLocale("views://mainview/index.html?lng=ja", "es")).toBe("views://mainview/index.html?lng=es");
  });

  test("keeps query parameters that are not lng", () => {
    // Only the locale is ours to rewrite; dropping the rest would silently strip anything a caller
    // put on the URL before us.
    expect(withLocale("http://localhost:5173/?debug=1", "ja")).toBe("http://localhost:5173/?debug=1&lng=ja");
    expect(withLocale("views://mainview/index.html?a=1&lng=ja&b=2", "pt")).toBe(
      "views://mainview/index.html?a=1&b=2&lng=pt",
    );
  });

  test("the localized URLs still satisfy the navigation rules (spec §18)", () => {
    // `views://*` and the dev-server `${origin}/*` rule both have to keep matching, or the window
    // blocks its own page load.
    expect(navigationRulesFor(BUILT_VIEW_URL)).toEqual(["^*", "views://*"]);
    expect(navigationRulesFor(DEV_SERVER_URL)).toContain(`${DEV_SERVER_URL}/*`);
    expect(withLocale(BUILT_VIEW_URL, "ja").startsWith("views://")).toBe(true);
    expect(withLocale(DEV_SERVER_URL, "ja").startsWith(`${DEV_SERVER_URL}/`)).toBe(true);
  });
});
