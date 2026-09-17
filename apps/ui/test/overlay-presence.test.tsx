import { beforeEach, expect, test } from "bun:test";
import { render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { useOverlayPresence } from "../src/shell/overlay-presence";

/**
 * CodeRabbit finding 4 (M4 T9c). `useOverlayPresence` registered the open overlay from a `useEffect`, which React
 * runs **after paint**. A native `<electrobun-webview>` paints above every HTML element regardless of `z-index`
 * (see `overlay-presence.ts`), so `WebViewHosts` collapses every docked tile while an overlay is open -- and if
 * the counter only rises after paint, there is a frame in which the newly mounted overlay is on screen while the
 * native surface is still there to occlude it. That is the same defect family as the 0x0 `OverlaySyncController`
 * guard fixed in Task 9c: the fix is to update the counter *before* paint, with `useLayoutEffect`.
 *
 * How this is observed without a compositor: React runs layout effects bottom-up within one commit, children
 * before parents, and all of them before paint; passive (`useEffect`) effects run later, after paint. So a parent
 * reading the counter from its OWN `useLayoutEffect` sees 1 only if the child registered in a layout effect too.
 * With the `useEffect` version it reads 0 -- which is precisely the frame in which the overlay is occluded.
 */

const COUNTER_KEY = "__jslabOverlayPresence__";

function openCount(): number {
  const g = globalThis as typeof globalThis & { [COUNTER_KEY]?: { openCount: number } };
  return g[COUNTER_KEY]?.openCount ?? 0;
}

/*
 * Reset *before* each test, never after. The counter deliberately lives on `globalThis` (see
 * `overlay-presence.ts`), so it survives between tests -- but testing-library's automatic cleanup unmounts the
 * previous test's tree during ITS OWN `afterEach`, which runs this hook's decrement afterwards. Resetting in an
 * `afterEach` therefore races that cleanup and leaves the counter at -1, which the next test silently absorbs.
 */
beforeEach(() => {
  const g = globalThis as typeof globalThis & { [COUNTER_KEY]?: { openCount: number } };
  if (g[COUNTER_KEY]) g[COUNTER_KEY].openCount = 0;
});

function Overlay() {
  useOverlayPresence(true);
  return null;
}

test("an overlay is registered before paint, not after it (CodeRabbit 4)", () => {
  const seenByParentLayoutEffect: number[] = [];

  function Parent() {
    useLayoutEffect(() => {
      seenByParentLayoutEffect.push(openCount());
    }, []);
    return <Overlay />;
  }

  render(<Parent />);

  // 1, not 0: the overlay counted itself in the same commit that mounted it, so `WebViewHosts` collapses the
  // docked tile in the very frame the overlay first appears.
  expect(seenByParentLayoutEffect).toEqual([1]);
});

test("unmounting the overlay releases the count, so the Web View comes back", () => {
  const { unmount } = render(<Overlay />);
  expect(openCount()).toBe(1);
  unmount();
  expect(openCount()).toBe(0);
});
