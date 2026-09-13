/**
 * Webview navigation policy (spec §18): the UI view never navigates away from `views://`, and links to the web open
 * in the default browser instead.
 *
 * Electrobun 2.0.1 evaluates navigation rules natively (`BrowserView.setNavigationRules(rules: string[])`,
 * `.hutch/devkit/api/sdks/main/core/BrowserView.ts`): `*` is a wildcard, a `^` prefix blocks, and the last matching
 * rule wins. Each navigation emits `will-navigate` with the detail `{"url": …, "allowed": …}`.
 */

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Block everything, then allow `views://` and, in development, the dev server that serves the view. */
export function navigationRulesFor(loadedUrl: string): string[] {
  const rules = ["^*", "views://*"];
  if (!loadedUrl.startsWith("views://")) {
    const origin = loadedUrl.replace(/\/+$/, "");
    rules.push(origin, `${origin}/*`);
  }
  return rules;
}

/** The URL to open in the default browser for a blocked navigation, or null when it shouldn't be opened. */
export function externalLinkFrom(detail: unknown): string | null {
  let data = detail;
  if (typeof detail === "string") {
    try {
      data = JSON.parse(detail);
    } catch {
      return null;
    }
  }
  if (typeof data !== "object" || data === null) return null;
  const { url, allowed } = data as { url?: unknown; allowed?: unknown };
  if (allowed !== false || typeof url !== "string") return null;
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}
