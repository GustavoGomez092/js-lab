import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import viteConfig from "../../ui/vite.config";
import electrobunConfig from "../electrobun.config";

// The page a browser-mode tab's `<electrobun-webview>` loads (spec §5.12): a bare `<div id="root"></div>`, no
// stylesheet, so a user only ever sees what their own code renders. It is the single on-disk source for the
// `runner-web` Vite entry and the Electrobun copy rule below -- see apps/ui/vite.config.ts's
// `runnerWebEntryPlugin` for why the entry itself is a virtual id rather than this path directly.
const RUNNER_WEB_PAGE = join(import.meta.dir, "..", "..", "..", "packages", "runner-web", "index.html");

describe("build wiring: packages/runner-web/index.html", () => {
  test("the page exists on disk, is deliberately bare, and is a declared Vite rollup input", () => {
    expect(existsSync(RUNNER_WEB_PAGE)).toBe(true);
    const html = readFileSync(RUNNER_WEB_PAGE, "utf8");
    expect(html).toContain('<div id="root"></div>');
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<script");

    const input = (viteConfig.build?.rollupOptions?.input ?? {}) as Record<string, string>;
    expect(Object.keys(input).sort()).toEqual(["main", "runner-web", "settings"]);
    // Every entry is an absolute path; the runner-web one resolves inside this project's Vite `root` ("src") so
    // Vite's HTML output naming (always relative to `root`) never computes a path containing "..".
    for (const entryPath of Object.values(input)) expect(entryPath.startsWith("/")).toBe(true);
    expect(input["runner-web"]?.endsWith(join("src", "runner-web", "index.html"))).toBe(true);
  });

  test("apps/desktop/electrobun.config.ts copies the built runner-web page to its own views:// root", () => {
    const copy = electrobunConfig.build?.copy ?? {};
    // The copy source is a path the build actually produces: apps/ui/vite.config.ts's `outDir` is
    // "../../desktop/dist/mainview" (relative to apps/ui), i.e. apps/desktop/dist/mainview -- and the
    // "runner-web" rollup input above lands at "runner-web/index.html" under that outDir, so the source here is
    // "dist/mainview/runner-web" relative to apps/desktop, the same base the existing "dist/mainview" rule uses.
    expect(copy["dist/mainview/runner-web"]).toBe("views/runner-web");
    // The pre-existing copy rules stay untouched by this addition.
    expect(copy["dist/mainview"]).toBe("views/mainview");
    expect(copy["dist/runner"]).toBe("runner");
    expect(copy["dist/workers"]).toBe("workers");
    // ElectrobunConfig's `copy` value must be a safe relative path: no absolute paths, no "." / ".." components.
    for (const dest of Object.values(copy)) {
      expect(dest.startsWith("/")).toBe(false);
      expect(dest.split("/")).not.toContain("..");
      expect(dest.split("/")).not.toContain(".");
    }
  });
});
