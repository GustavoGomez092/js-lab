import { describe, expect, test } from "bun:test";
import { recordAppRender, recordHostsRender, webViewTileCounters } from "../src/output/WebViewTile";

/**
 * M4 diagnostics (`WebViewTile.tsx`'s `counters`): the idle-window re-render instrumentation.
 *
 * The live app re-renders the docked Web View tile ~110 times a second while nothing is running, with `measures`
 * (the tile's own `setRect` path) flat at 0 throughout. An in-process probe showed the only mechanism reproducing
 * that signature is `App` re-rendering, so what these counters have to answer is WHICH of `App`'s subscriptions
 * changes identity that often. That makes `recordAppRender`'s per-key accounting the load-bearing part, and this is
 * where its semantics are pinned.
 *
 * Every assertion is a DELTA against a snapshot taken first: the counters are module-global (one shared object for
 * the whole window, and for every test file sharing a `bun test` process), so absolute values are not this test's
 * to predict.
 */
describe("render counters", () => {
  test("the first render is counted but attributes no input change", () => {
    const before = webViewTileCounters();
    recordAppRender({ settings: {}, notices: [] }, null);
    const after = webViewTileCounters();
    expect(after.app - before.app).toBe(1);
    expect(after.appInputs.settings ?? 0).toBe(before.appInputs.settings ?? 0);
  });

  test("only the inputs that actually changed identity are attributed", () => {
    const settings = { a: 1 };
    const notices: unknown[] = [];
    const before = webViewTileCounters();
    // `notices` keeps its identity; `settings` is replaced by a different object.
    recordAppRender({ settings: { a: 1 }, notices }, { settings, notices });
    const after = webViewTileCounters();
    expect(after.appInputs.settings ?? 0).toBe((before.appInputs.settings ?? 0) + 1);
    expect(after.appInputs.notices ?? 0).toBe(before.appInputs.notices ?? 0);
  });

  /**
   * The distinction the whole measurement rests on: a *fresh object with equal contents* is what a selector
   * returning a new literal every call produces, and it is exactly what re-renders a React subscriber. Counting it
   * as a change (rather than comparing by value) is what makes an "app +330 / settings +330" reading meaningful.
   */
  test("an equal-but-fresh object counts as a change, a reused reference does not", () => {
    const same = { x: 1 };
    const before = webViewTileCounters();
    recordAppRender({ k: same }, { k: same });
    const mid = webViewTileCounters();
    expect(mid.appInputs.k ?? 0).toBe(before.appInputs.k ?? 0);
    recordAppRender({ k: { x: 1 } }, { k: { x: 1 } });
    const after = webViewTileCounters();
    expect(after.appInputs.k ?? 0).toBe((before.appInputs.k ?? 0) + 1);
  });

  test("primitives compare by value, so an unchanged primitive is not attributed", () => {
    const before = webViewTileCounters();
    recordAppRender({ tabId: "t1", runState: null }, { tabId: "t1", runState: null });
    const after = webViewTileCounters();
    expect(after.appInputs.tabId ?? 0).toBe(before.appInputs.tabId ?? 0);
    expect(after.appInputs.runState ?? 0).toBe(before.appInputs.runState ?? 0);
  });

  test("hosts renders are counted separately from app renders", () => {
    const before = webViewTileCounters();
    recordHostsRender();
    recordHostsRender();
    const after = webViewTileCounters();
    expect(after.hosts - before.hosts).toBe(2);
    expect(after.app - before.app).toBe(0);
  });

  test("the snapshot is a copy, so a reader cannot mutate the live counters", () => {
    const snapshot = webViewTileCounters();
    snapshot.app = 999_999;
    snapshot.appInputs.settings = 999_999;
    const fresh = webViewTileCounters();
    expect(fresh.app).not.toBe(999_999);
    expect(fresh.appInputs.settings ?? 0).not.toBe(999_999);
  });
});
