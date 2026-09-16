import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import viteConfig from "../../ui/vite.config";
import electrobunConfig from "../electrobun.config";
import hutchConfig from "../hutch.config";
import { resolveAppPaths } from "../src/main/app-paths";

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

/**
 * M4 Task 9a. The runner-web page is deliberately bare -- no `<script>` at all -- so the bootstrap that turns it
 * into a runner only ever arrives by Main injecting it through `executeJavascript`. Nothing built that injectable
 * form before this task: `hutch.config.ts` bundled the *Bun* runner's bootstrap and the transform worker, and the
 * web one had no build step, no shipped artifact and no path. A `WebviewSource` with no bootstrap to inject is a
 * webview that loads a blank page and never reports `ready`, so this wiring is load-bearing, not packaging polish.
 */
describe("build wiring: the runner-web bootstrap Main injects", () => {
  const WEB_ENTRY = join(import.meta.dir, "..", "..", "..", "packages", "runner-web", "src", "web-entry.ts");

  test("the self-starting page entry exists and actually starts the runner", () => {
    expect(existsSync(WEB_ENTRY)).toBe(true);
    const source = readFileSync(WEB_ENTRY, "utf8");
    expect(source).toContain("startRunnerWeb()");
  });

  test("build:bundles builds that entry to dist/runner as a classic script", () => {
    const bundles = (hutchConfig.scripts as Record<string, string>)["build:bundles"] ?? "";
    expect(bundles).toContain("packages/runner-web/src/web-entry.ts");
    expect(bundles).toContain("dist/runner/web-bootstrap.js");
    // `--target browser` keeps Bun-only globals out of a bundle destined for a WKWebView page.
    expect(bundles).toContain("--target browser");
    // No `--format`: these scripts run inside Hutch's Cottontail shell, whose `build` command rejects the flag
    // ("unsupported cottontail build option" -- it fails the whole build). The default output is already a
    // classic script, which `packages/runner-web/test/web-entry.test.ts` pins directly on the emitted bundle.
    expect(bundles).not.toContain("--format");
    // The existing two bundles stay: the Bun runner's bootstrap and the transform worker.
    expect(bundles).toContain("packages/runner-bun/src/bootstrap.ts");
    expect(bundles).toContain("transform-worker.ts");
  });

  test("electrobun.config.ts already ships whatever lands in dist/runner, so the bundle needs no new copy rule", () => {
    expect(electrobunConfig.build?.copy?.["dist/runner"]).toBe("runner");
  });

  test("app-paths points Main at the shipped bundle, and lets a dev run override it", () => {
    const resources = join("/tmp", "Resources");
    const paths = resolveAppPaths({ resourcesFolder: resources, userData: "/tmp/data", execPath: "/bin/bun", env: {} });
    expect(paths.webRunnerBootstrap).toBe(join(resources, "app", "runner", "web-bootstrap.js"));

    const overridden = resolveAppPaths({
      resourcesFolder: resources,
      userData: "/tmp/data",
      execPath: "/bin/bun",
      env: { JSLAB_WEB_RUNNER_BOOTSTRAP: "/elsewhere/web-bootstrap.js" },
    });
    expect(overridden.webRunnerBootstrap).toBe("/elsewhere/web-bootstrap.js");
  });
});
