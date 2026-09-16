import { startRunnerWeb } from "./bootstrap";

/**
 * The injected form of the web runner (spec §5.12).
 *
 * `bootstrap.ts` exports `startRunnerWeb` but deliberately never calls it, so tests can drive it against an
 * injected fake global. Production needs the opposite: one self-starting script with no imports and no exports,
 * because Main delivers it by handing a *string* to the page's `executeJavascript`, which evaluates it as a
 * classic script -- an ES module's `import`/`export` syntax is a parse error there. This file is that entry, and
 * `apps/desktop/hutch.config.ts` bundles it (`--target browser`, and deliberately no `--format`: Hutch's
 * Cottontail shell rejects that flag, and the default browser output is already self-contained -- see
 * `web-entry.test.ts`, which pins that) to `dist/runner/web-bootstrap.js`, which `electrobun.config.ts`'s
 * existing `dist/runner` → `runner` rule ships into the app.
 *
 * The page it lands in is bare (`packages/runner-web/index.html`: a single empty `<div id="root">`), so this is
 * the only script that ever runs there besides the user's own bundled code.
 */
/**
 * Which web runtime this page is (Task 9b). Main injects `window.__jslabRuntime` immediately before this bundle, in
 * the same `executeJavascript` call (`runtimePrelude`, `apps/desktop/src/main/runtimes/web-adapter.ts`) -- the only
 * channel available, since one bootstrap bundle serves every tab and `installFetchProxy` has to run synchronously
 * inside `startRunnerWeb`, before `installHandleTracking` wraps `fetch`.
 *
 * Fail-closed: anything other than the exact string `"browser-node"` is treated as `"browser"`, the CORS-enforced
 * runtime that routes nothing through Main. A missing or unrecognised prelude therefore costs a `browser-node` tab
 * its proxy (a visible, ordinary CORS failure) rather than handing a plain `browser` tab a CORS-free fetch.
 */
const declared = (globalThis as { __jslabRuntime?: unknown }).__jslabRuntime;
startRunnerWeb({ runtime: declared === "browser-node" ? "browser-node" : "browser" });
