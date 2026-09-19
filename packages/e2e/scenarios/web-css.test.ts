import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

/**
 * WV-03's untested half: a stylesheet imported from the working directory, and a stylesheet the page's own JS
 * builds at run time -- both measured by what they did to the rendered page (spec §5.12).
 *
 * **Why this is not the bundler test again.** `apps/desktop/test/bundling/bundler.test.ts` and `css-plugin.test.ts`
 * already prove that a `.css` import becomes a `<style>`-appending module and that its text survives into the
 * bundle. Neither one renders anything: they assert on bundle *source*. A rule can reach the bundle and still
 * never style the page -- the module could fail to run, the `<style>` could land in a document that is discarded
 * on the run's webview reload, or a `style-src` CSP could drop it. So this scenario asserts the only thing those
 * cannot: `getComputedStyle` in the live page, after the run.
 *
 * **Why the import reaches the working directory at all.** The entry file is written to `<dataDir>/runs/<tabId>/`,
 * not into the WD (`web-adapter.ts`), and `jslabResolve` only intercepts *bare* specifiers -- so `Bun.build` alone
 * resolves `./styles.css` next to the entry and fails. What makes it work is the transform: with a WD set,
 * `createWorkingDirectoryPlugin` (`packages/transform/src/working-directory.ts`) rewrites every relative specifier
 * to an absolute path under the WD *before* bundling, including a bare side-effect `import "./x.css"`. Measured
 * directly against `bundleAppForWeb`: the relative form errors with `Could not resolve: "./styles.css"`, the
 * rewritten absolute form bundles with the rule's text inlined. This scenario therefore also pins that the
 * rewrite still runs for the `browser` runtime, which no other scenario covers.
 *
 * **The non-vacuity guard.** A computed-style assertion is worthless if it would also pass on an unstyled page.
 * So the page measures a second, deliberately unmatched element in the same document and reports it on its own
 * output line: an unstyled `div` computes to `height: 0px`, while the stylesheet's rule sets `57px`. The control
 * line is asserted too, which is what makes the first assertion an assertion -- if CSS never applied, `styled`
 * would read exactly what `bare` reads, and that is the failure this pins.
 */

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

const current = () => app as LaunchedApp;

const consoleText = (entries: { kind: string; text: string }[]) =>
  entries.filter((entry) => entry.kind === "console").map((entry) => entry.text);

/** Waits for a console line starting with `prefix` and returns it (as `web-runtime.test.ts` does). */
async function waitForConsole(target: LaunchedApp, prefix: string, timeoutMs = 90_000) {
  const entries = await target.waitForOutput(
    (all) => consoleText(all).some((text) => text.startsWith(prefix)),
    timeoutMs,
  );
  return consoleText(entries).find((text) => text.startsWith(prefix)) as string;
}

describe("CSS in a browser tab (spec §5.12, WV-03)", () => {
  test("a stylesheet imported from the working directory styles the page, and so does one the page's JS injects", async () => {
    const userData = await createUserData();
    const wd = join(userData, "project");
    await mkdir(wd, { recursive: true });
    // Two properties, both distinctive. `height` carries the non-vacuity argument: an unstyled div has none.
    await writeFile(join(wd, "styles.css"), ".jl-probe { width: 234px; height: 57px; }\n");

    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });

    // The WD is what makes `./styles.css` resolvable at all; set it before the runtime switch, as
    // `web-runtime.test.ts` does.
    await writeFile(join(userData, "e2e-open-dialog.json"), JSON.stringify([wd]));
    await current().command("wd.set");
    await waitFor(async () => activeTab(await current().state()).workingDirectory === wd || null, {
      message: "the working directory was never set",
    });

    await current().command("runtime.browser");
    await waitFor(async () => activeTab(await current().state()).runtime === "browser" || null, {
      message: "the tab never switched to browser",
    });

    const code = [
      'import "./styles.css";',
      'const styled = document.createElement("div");',
      'styled.className = "jl-probe";',
      "document.body.appendChild(styled);",
      // The absence case, measured in the same document: an element the stylesheet does not match.
      'const bare = document.createElement("div");',
      "document.body.appendChild(bare);",
      "const s = getComputedStyle(styled);",
      "const b = getComputedStyle(bare);",
      'console.log("imported:" + s.width + ":" + s.height);',
      'console.log("control:" + b.width + ":" + b.height);',
      // CSS-in-JS: a stylesheet built by the page's own JS at run time, which is the mechanism every
      // CSS-in-JS library ships (styled-components, emotion). It is not a tautology about the browser: a
      // `style-src` CSP on the run's page would drop this `<style>` and leave the rule inert.
      'const sheet = document.createElement("style");',
      'sheet.textContent = ".jl-runtime { width: 321px; height: 29px; }";',
      "document.head.appendChild(sheet);",
      'const runtime = document.createElement("div");',
      'runtime.className = "jl-runtime";',
      "document.body.appendChild(runtime);",
      "const r = getComputedStyle(runtime);",
      'console.log("cssinjs:" + r.width + ":" + r.height);',
    ].join("\n");
    await current().type(code);
    await waitFor(async () => activeTab(await current().state()).code === code || null, {
      message: "the editor never took the typed code",
    });
    await current().command("run.start");

    // The imported stylesheet really applied: both properties resolve to the rule's values in the live page.
    expect(await waitForConsole(current(), "imported:")).toBe("imported:234px:57px");

    // ...and the same page reports an unmatched element as unstyled, so the line above cannot be passing on a
    // page where CSS silently did nothing. An empty block div has no height of its own.
    const control = await waitForConsole(current(), "control:");
    expect(control).toEndWith(":0px");
    expect(control).not.toContain("234px");

    // A run-time-injected stylesheet applies too (CSS-in-JS, and the `<style>` half of the row).
    expect(await waitForConsole(current(), "cssinjs:")).toBe("cssinjs:321px:29px");

    await current().screenshot("web-css");
  }, 240_000);
});
