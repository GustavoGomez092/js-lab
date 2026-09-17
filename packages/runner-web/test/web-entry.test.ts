import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "..", "src", "web-entry.ts");

/**
 * Main delivers the web runner by handing this bundle's *text* to a page's `executeJavascript`, which evaluates it
 * as a classic script -- not as a module. So the bundle must contain no module syntax at all: a single top-level
 * `import` or `export` is a parse error that kills the whole injection, and the only symptom Main would ever see
 * is a page that never reports `ready`, i.e. a run that hangs until `waitForReady` gives up.
 *
 * Nothing in the build command enforces this any more. The obvious flag (`--format iife`) cannot be used: the
 * bundles are built inside Hutch's Cottontail shell, whose `build` command rejects `--format` outright. The
 * default browser output happens to be self-contained -- so this test pins that property on the emitted bytes,
 * where a future dependency pulling in a stray re-export would show up.
 */
/**
 * Built exactly once for the whole file, and shared. Not just an optimization: only the *first* `Bun.build` in a
 * test process succeeds here. Once this package's own sources have been loaded into the runtime module registry
 * (`bootstrap.test.ts` and friends import them), a later `Bun.build` of the same graph fails to re-read the
 * workspace barrels -- `Unexpected reading file: packages/serializer/src/index.ts`, and a bogus
 * "No matching export ... for import parseStack" on top of it. That is a Bun quirk, not a defect in the bundle, and
 * it bites per build call, so one shared build keeps every assertion below honest.
 */
let built: Promise<{ success: boolean; code: string }> | null = null;
function bundle(): Promise<{ success: boolean; code: string }> {
  built ??= (async () => {
    const result = await Bun.build({ entrypoints: [ENTRY], target: "browser" });
    const output = result.outputs[0];
    return { success: result.success, code: output ? await output.text() : "" };
  })();
  return built;
}

describe("the injectable web bootstrap bundle", () => {
  test("is a classic script: no top-level module syntax, and it parses as one", async () => {
    const { success, code } = await bundle();
    expect(success).toBe(true);
    expect(code).not.toBe("");

    expect(code).not.toMatch(/^\s*(?:import|export)[\s{*]/m);
    expect(code).not.toContain("import.meta");
    // The decisive check: `new Function` compiles its body under classic-script rules, so any module syntax that
    // slipped past the patterns above throws here rather than in a webview nobody is watching.
    expect(() => new Function(code)).not.toThrow();
  });

  /**
   * Task 9b, replacing a text-grep that could not fail. It asserted the bundle *contains* the string
   * `__jslabHostMessage` -- but that string is inside `startRunnerWeb`'s own definition, which the bundle carries
   * whether or not anything calls it. Deleting the `startRunnerWeb()` call from `web-entry.ts` left it green, so it
   * guarded nothing, which matters precisely because this task changes that call site (it now passes a runtime).
   *
   * This runs the emitted bundle instead. `globalThis`/`window`/`self` are shadowed as parameters of a `Function`,
   * so the classic script installs itself onto a fake page rather than this test process's real global (which
   * `bootstrap.test.ts` already owns -- `__jl` is non-configurable and can only be installed once per realm).
   */
  function runBundleAgainstFakePage(code: string, runtime?: string) {
    const sent: unknown[] = [];
    const page = {
      setTimeout,
      clearTimeout,
      // A no-op interval: the heartbeat would otherwise outlive the test.
      setInterval: () => 0,
      clearInterval: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      console: {},
      fetch: () => Promise.reject(new Error("unused")),
      __electrobunSendToHost: (value: unknown) => sent.push(value),
      ...(runtime === undefined ? {} : { __jslabRuntime: runtime }),
    };
    new Function("globalThis", "window", "self", code)(page, page, page);
    return { sent, page };
  }

  test("actually starts the runner: the emitted bundle reports ready to its host", async () => {
    const { code } = await bundle();

    const { sent, page } = runBundleAgainstFakePage(code);

    // The observable contract Main depends on: without this envelope, `waitForReady` can only time out.
    expect(sent[0]).toEqual({ seq: 1, message: { type: "ready" } });
    // And it really bootstrapped this page, rather than merely defining something.
    expect(typeof (page as { __jslabHostMessage?: unknown }).__jslabHostMessage).toBe("function");
  });

  /**
   * Task 9b: the entry must read Main's injected `window.__jslabRuntime` prelude and fail **closed**. A page that
   * was told nothing must behave as `browser` (CORS enforced, nothing routed through Main) rather than quietly
   * getting the privileged proxy.
   */
  test("adopts the runtime Main injected, and falls back to browser when told nothing", async () => {
    const { code } = await bundle();

    // `installFetchProxy` replaces `fetch` only for `browser-node`; for `browser` the page keeps its own.
    const asBrowserNode = runBundleAgainstFakePage(code, "browser-node");
    const asBrowser = runBundleAgainstFakePage(code, "browser");
    const unset = runBundleAgainstFakePage(code);
    const nonsense = runBundleAgainstFakePage(code, "not-a-runtime");

    const proxied = (result: { sent: unknown[] }) => {
      // A proxied page sends the request to the host; an unproxied one never does.
      return result.sent.some((value) => (value as { message?: { type?: string } }).message?.type === "fetchRequest");
    };
    for (const result of [asBrowserNode, asBrowser, unset, nonsense]) {
      void (result.page.fetch as unknown as typeof fetch)("https://example.com/").catch(() => {});
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(proxied(asBrowserNode)).toBe(true);
    expect(proxied(asBrowser)).toBe(false);
    expect(proxied(unset)).toBe(false);
    expect(proxied(nonsense)).toBe(false);
  });
});
