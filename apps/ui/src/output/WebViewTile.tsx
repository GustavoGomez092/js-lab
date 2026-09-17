import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WebviewElement } from "./webview-host";

/**
 * The page every browser-mode tab's `<electrobun-webview>` loads (spec §5.12): a bare, local `views://` page with
 * no external requests -- see `apps/ui/vite.config.ts` and `apps/desktop/electrobun.config.ts` for how
 * `packages/runner-web/index.html` ends up served at this URL.
 */
export const RUNNER_WEB_URL = "views://runner-web/index.html";

/** One tab's live webview element: a real DOM node that also answers the Electrobun webview tag's own API. */
export type TileWebview = HTMLElement & WebviewElement;

type Rect = { top: number; left: number; width: number; height: number };

/**
 * M4 diagnostics only -- not a feature, and nothing in the app reads these but the E2E agent.
 *
 * Counts how often a docked tile re-measures (`measure()` below, every call of which sets React state) and how
 * often it renders, so an E2E scenario can tell a tile that measures once at dock time from one that re-measures
 * continuously while the app sits idle with nothing running. A user report ("not running the web view gets rid of
 * the reload error") pointed at the Web View tile itself as a re-render driver independent of run state; these two
 * numbers, sampled twice across a fixed idle window, are what turns that into a measurement instead of a guess.
 */
const counters = {
  measures: 0,
  /**
   * How many of those `measures` actually committed a new rect to React state.
   *
   * `measures` counts every *attempt*; this counts the ones that got past the equality guard in `measure()` below
   * and called `setRect`. The pair is what makes the guard observable: a trigger that fires while the dock has not
   * actually moved advances `measures` and leaves this flat, which is exactly the "extra triggers must not cause a
   * render storm" property -- and the only part of it a layout-less test DOM can witness, since there every
   * `getBoundingClientRect()` is zeros and so every re-measure after the first is a genuine no-op.
   */
  rectCommits: 0,
  renders: 0,
  hosts: 0,
  app: 0,
  appInputs: {} as Record<string, number>,
  /**
   * M4 round 3: the last few `runState` transitions, as `"<previous>-><next>"` strings.
   *
   * Round 2's sample named `runState` as the sole input driving the shell's churn (+314 over a 3s idle window, every
   * other input +0). But `runState` is a primitive string union, so `Object.is` compares it BY VALUE -- meaning the
   * run state is genuinely oscillating between two different values ~105 times a second, not merely losing object
   * identity. Which two values that is, is what separates a known-and-already-fixed defect from a new one: the
   * `idle`/`settled` pair is the signature of the self-rescheduling-handle dip fixed in `runner-web` (388f865) and
   * `runner-bun` (75f8c84), and seeing a DIFFERENT pair here is what would prove those fixes are not the whole
   * story. A count alone cannot tell those apart, so this records the values themselves.
   *
   * A bounded ring (the most recent `RUN_STATE_TRAIL_MAX`), so it stays useful for an idle window sampled minutes
   * into a session rather than filling up during the run that precedes it, and never grows without limit.
   */
  runStateTrail: [] as string[],
};

/** How many recent `runState` transitions `counters.runStateTrail` keeps. */
const RUN_STATE_TRAIL_MAX = 40;

/**
 * M4 round 2: the same idea, one level up.
 *
 * The first sample (b6673a8) established that a docked tile re-renders ~110 times a second while the app sits idle
 * with nothing running, and that `measures` stays at 0 through it -- so the tile's own `ResizeObserver`/`setRect`
 * path is not the driver and the churn arrives from upstream. An in-process probe then narrowed it further: the
 * ONLY mechanism that reproduces that exact signature (tile renders climb, `measures` flat) is `App` itself
 * re-rendering and passing through `WebViewHosts` with `docked`/`dockNode` unchanged. An overlay-presence flip does
 * not reproduce it, and neither does store churn `App` does not select.
 *
 * What is still unnamed is what re-renders `App` ~110 times a second. `App` re-renders only when one of its own
 * subscriptions yields a new value, so these counters record exactly that: how many times each of `App`,
 * `WebViewHosts` and the tile rendered, and -- decisively -- which of `App`'s inputs actually changed identity on
 * each of its renders. An idle-window sample then reads, for example, "app +330, settings +330", which names the
 * subscription driving the loop instead of leaving it to inference.
 */
export function recordAppRender(current: Record<string, unknown>, previous: Record<string, unknown> | null): void {
  counters.app += 1;
  if (!previous) return;
  for (const key of Object.keys(current)) {
    // `Object.is` is exactly the comparison React/zustand use to decide whether a subscription re-renders, so a key
    // counted here is a key that really did force this render -- not one that merely looks different.
    if (Object.is(current[key], previous[key])) continue;
    counters.appInputs[key] = (counters.appInputs[key] ?? 0) + 1;
    // `runState` is a primitive, so a change counted just above is a change of VALUE, not of object identity --
    // record which values, because the PAIR is what names the defect (see `counters.runStateTrail`).
    if (key === "runState") {
      counters.runStateTrail.push(`${String(previous[key])}->${String(current[key])}`);
      if (counters.runStateTrail.length > RUN_STATE_TRAIL_MAX) counters.runStateTrail.shift();
    }
  }
}

/** Counts one `WebViewHosts` render, so the loop's start can be told from the tile it ends at. */
export function recordHostsRender(): void {
  counters.hosts += 1;
}

/** A snapshot of the diagnostics counters above, for `e2e.state`. */
export const webViewTileCounters = (): {
  measures: number;
  rectCommits: number;
  renders: number;
  hosts: number;
  app: number;
  appInputs: Record<string, number>;
  runStateTrail: string[];
} => ({ ...counters, appInputs: { ...counters.appInputs }, runStateTrail: [...counters.runStateTrail] });

/**
 * The collapsed (not-docked) style, deliberately 1x1 rather than 0x0 -- confirmed necessary by a live run, not a
 * theoretical worry. `apps/desktop/.hutch/devkit/api/preload/overlaySync.ts`'s `OverlaySyncController.sync()`
 * (the thing that tells the native layer this element's box changed) has its own early return: `if
 * (newRect.width === 0 && newRect.height === 0) return;` -- an exact 0x0 box is silently never synced at all. A
 * tile that had a real, non-zero docked rect and then collapses to exactly 0x0 (M4 T9c: an overlay opening, or the
 * pre-existing park-on-hide/park-on-switch path from Task 8/9) never tells the native compositor surface to
 * shrink, so it stays painted at its last docked rect indefinitely -- invisible to this component's own React
 * state and to jsdom (which is why no unit test caught it; see the task report's live-run evidence) but fully
 * visible on screen, including on top of whatever HTML the collapse was supposed to make room for. 1x1 sidesteps
 * the guard (the rect is no longer `=== 0` on both axes) while being visually negligible; `overflow: hidden` and
 * `pointerEvents: none` do the rest of the work zero-size was already relying on.
 */
const COLLAPSED_STYLE = {
  position: "fixed",
  top: 0,
  left: 0,
  width: 1,
  height: 1,
  overflow: "hidden",
  pointerEvents: "none",
} as const;

/**
 * One tab's persistent `<electrobun-webview>` host (Task 8, spec §7.1 / Appendix C; fix round 1 F1/F2).
 *
 * Owned and kept alive by `WebViewHosts` for as long as the tab stays open -- `key={tabId}` there is what gives
 * each tab its own instance and prevents this component from ever remounting on a tab switch.
 *
 * **Fix round 1's revised mechanism.** The first attempt at this fix portaled this component's own element
 * directly into `OutputTiles`'s docking placeholder and re-pointed the portal there and back. That is wrong: the
 * placeholder is a DOM child of `OutputTiles`, which *is* allowed to unmount (hiding Output, switching to a `bun`
 * tab) -- and removing a DOM node removes everything physically nested inside it, portaled content included,
 * regardless of which React fiber "owns" it. A test asserting node identity across that action caught it directly
 * (see the report's red/green evidence).
 *
 * So this component's own element **always** ends up inside `parkingNode` -- `WebViewHosts`'s own permanent,
 * never-unmounting node -- and is **never** re-parented. Instead, when `docked` and `dockNode` are provided (the
 * tab is active, Output is visible, its own Web View toggle is on, and no overlay is occluding it -- see
 * `WebViewHosts.tsx`), a set of triggers -- one measurement whenever docking starts, a `ResizeObserver` on the
 * dock *and each of its ancestors*, a `MutationObserver` for structural DOM changes, window `resize`, and
 * capture-phase `scroll` -- drives
 * this element's own `position: fixed` coordinates to visually track `dockNode`'s box. `dockNode` is read from,
 * never rendered into. When not docked, this element collapses to a 1x1, non-interactive box (`COLLAPSED_STYLE`
 * below -- not literally 0x0; see that constant's own doc comment for why) instead of being removed.
 *
 * **M4 T9c: the portal itself moved up to `WebViewHosts`.** This component used to call `createPortal` on its own
 * returned element; it now just returns that element directly, and `WebViewHosts` wraps the whole list of tiles in
 * ONE `createPortal` call instead of one per tile. Deferred at Task 9 fix round 1 because it was unclear whether
 * DOM order among tiles mattered; it now demonstrably does, since a native webview surface paints above HTML
 * regardless of `z-index` (Task 9a's screenshot), which makes DOM order the only thing left to arbitrate stacking
 * among tiles. A direct probe against React 19.3.0 (recorded in this task's report) found that several *separate*
 * `createPortal` calls into the same container -- "sibling portals" -- do not reorder relative to each other when
 * the source order changes after mount, even with distinct `key`s; a *single* `createPortal` whose children is a
 * keyed array reorders correctly, using React's ordinary reconciliation inside that one portal. That is also what
 * "restores full tile laziness" means in the task brief: DOM order is now a property of the array `WebViewHosts`
 * passes to that one `createPortal` call, not of each tile's own historical mount sequence -- the structural
 * reason the M2 workaround below (mount every web-capable tab's wrapper immediately, in tab order, whether or not
 * it is enabled, purely to pin sibling-portal order at mount time) was ever needed no longer applies. This task
 * deliberately does not go further and make the wrapper itself conditionally-mounted: the M2 test still pins
 * "mounted eagerly, in tab order" as current, asserted behaviour, and turning that into a genuinely separate
 * change is out of this task's own scope (occlusion + the hoist) -- see the task report.
 *
 * **`enabled` (M4 T9 fix round 1, M2/N4).** `WebViewHosts` mounts one of these for every web-capable tab as soon
 * as it exists -- in tab order, from the very first render -- so DOM sibling order among tiles is established
 * once, at ordinary sequential mount time, and never needs to be re-derived later. What stays genuinely lazy is
 * the **expensive** part: the real `<electrobun-webview>` element inside this cheap wrapper div is created only
 * once `enabled` becomes true.
 *
 * **`generation` (M4 Task 9a).** Task 8's invariant was that the element, once created, is never removed while
 * this component stays mounted. That held while the only thing that could create one was the user's own toggle.
 * It cannot hold now that Main drives the webview as a *runtime*: Kill (and a reset that times out) destroy the
 * webview deliberately and immediately ask for a fresh one (`web-adapter.ts`'s `#killWebview`), and a tab whose
 * element was destroyed but never replaced would fail every later run with a timeout. `generation` is that
 * replacement, made explicit: `WebViewHosts` bumps it only when Main has asked for an element the host registry
 * hasn't got, so the element is still never removed by anything the *user* does -- only by the runtime that owns
 * it, which is the one actor entitled to.
 */
export function WebViewTile({
  tabId,
  dockNode,
  docked,
  enabled,
  generation,
  createWebview,
  onElement,
}: {
  tabId: string;
  /** `OutputTiles`'s live docking placeholder to visually track, or `null` when there isn't one right now. */
  dockNode: HTMLElement | null;
  docked: boolean;
  /** Whether the tab's own Web View toggle has ever been switched on, or Main has asked for a webview. */
  enabled: boolean;
  /** Bumped when Main needs a replacement element; each value creates exactly one webview. */
  generation: number;
  /** Builds the element. Must be referentially stable, or every render would replace the webview. */
  createWebview: () => TileWebview;
  /** Reports this tab's live element (or `null` once it goes away). Must be referentially stable. */
  onElement: (tabId: string, element: TileWebview | null) => void;
}) {
  const container = useRef<HTMLDivElement>(null);

  // M4 diagnostics (see `counters` above): an effect with no dependency array runs after every render, so this
  // counts renders without doing side-effect work during the render phase itself.
  useEffect(() => {
    counters.renders += 1;
  });

  // `generation` is deliberately a dependency this effect never reads. It is the *reason* the effect re-runs:
  // Main destroying a tab's webview and asking for another (Kill, a timed-out reset) must tear the old element
  // down and build a new one, and a value the body ignores is exactly how that request is expressed. Removing it
  // would leave a killed tab with no webview for good.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above -- `generation` is the re-run trigger.
  useEffect(() => {
    if (!enabled) return;
    const host = container.current;
    if (!host) return;
    const webview = createWebview();
    host.appendChild(webview);
    onElement(tabId, webview);
    return () => {
      // Runs only when `generation` changes (Main asked for a replacement) or this tile unmounts (the tab closed,
      // or stopped being web-capable). Reporting `null` first is what lets the host registry tell those two apart
      // from its own `webRunner.destroy`, which has already removed the element and forgotten the tab by now.
      onElement(tabId, null);
      webview.remove();
    };
  }, [enabled, generation, tabId, createWebview, onElement]);

  const [rect, setRect] = useState<Rect | null>(null);
  /**
   * The last rect committed to state, for the equality guard in `measure()` below.
   *
   * A ref rather than a read of `rect`: `measure` is called from observer callbacks and event listeners that close
   * over the effect's first run, so comparing against the `rect` state variable there would compare against a
   * stale value and commit a "change" on every single trigger -- the exact render storm the guard exists to
   * prevent. It is written in lockstep with `setRect`, and cleared when the tile undocks.
   */
  const lastRect = useRef<Rect | null>(null);
  useLayoutEffect(() => {
    if (!docked || !dockNode) {
      lastRect.current = null;
      setRect(null);
      return;
    }
    /**
     * Read the dock's live box and commit it -- but only when it actually differs.
     *
     * `setRect` used to be handed a fresh object literal on every call, so React's `Object.is` bailout could never
     * fire and every measurement re-rendered the tile. That was survivable while a `ResizeObserver` on the dock was
     * the only trigger; with the triggers below firing far more often it would not be, and this app has already had
     * one idle re-render defect (~110 renders/second) it does not want back. Comparing the four numbers means a
     * trigger that fires while the dock has not moved costs one `getBoundingClientRect()` and nothing else.
     */
    const measure = () => {
      counters.measures += 1;
      const box = dockNode.getBoundingClientRect();
      const previous = lastRect.current;
      if (
        previous !== null &&
        previous.top === box.top &&
        previous.left === box.left &&
        previous.width === box.width &&
        previous.height === box.height
      ) {
        return;
      }
      const next = { top: box.top, left: box.left, width: box.width, height: box.height };
      lastRect.current = next;
      counters.rectCommits += 1;
      setRect(next);
    };

    /**
     * Coalesces triggers that can fire many times within one frame (a burst of console rows arriving, a scroll)
     * into a single measurement. A `ResizeObserver` deliberately does NOT go through this: the browser already
     * delivers its callback at most once per frame, so deferring it would only add a frame of visible lag to the
     * one trigger that was always correct.
     */
    let frame: ReturnType<typeof requestAnimationFrame> | null = null;
    const scheduleMeasure = () => {
      if (typeof requestAnimationFrame !== "function") {
        measure();
        return;
      }
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        measure();
      });
    };

    measure();

    const dispose: Array<() => void> = [];

    // A `ResizeObserver` fires on size changes only -- never on a move. A dock that is repositioned by something
    // *above* it in the tree (a banner appearing, a pane resizing, the shell relaying out) can therefore keep its
    // own box while its viewport coordinates change, leaving the `position: fixed` tile -- and the native
    // `<electrobun-webview>` surface inside it, which paints above all HTML regardless of `z-index` -- stranded at
    // stale coordinates on top of real content. Observing every ancestor as well as the dock is what turns "the
    // dock resized" into "anything that could reposition the dock resized", without enumerating today's layout.
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measure);
      for (let node: Element | null = dockNode; node !== null; node = node.parentElement) observer.observe(node);
      dispose.push(() => observer.disconnect());
    }

    // The general form of "content changed, so the layout may have moved the dock": any structural DOM change
    // anywhere in the document. Deliberately not a subscription to the output store and deliberately not scoped to
    // today's console/web-view tile pair -- the dock's position can be disturbed by anything that reflows the
    // shell, and a trigger shaped around one known cause would simply be re-reported the next time a different
    // one moved it. `attributes` is excluded on purpose: attribute churn (Monaco's, mostly) is relentless, and a
    // style change that genuinely moves the dock almost always resizes something in the ancestor chain observed
    // above, which the `ResizeObserver` already catches.
    const body = dockNode.ownerDocument?.body ?? null;
    if (typeof MutationObserver !== "undefined" && body !== null) {
      const mutations = new MutationObserver(scheduleMeasure);
      mutations.observe(body, { childList: true, subtree: true });
      dispose.push(() => mutations.disconnect());
    }

    window.addEventListener("resize", measure);
    dispose.push(() => window.removeEventListener("resize", measure));
    // Capture phase, so this sees scrolls of *any* element on the way down -- `scroll` does not bubble from an
    // element, so a bubble-phase listener on `window` would only ever hear the document's own.
    window.addEventListener("scroll", scheduleMeasure, true);
    dispose.push(() => window.removeEventListener("scroll", scheduleMeasure, true));

    return () => {
      if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
      for (const off of dispose) off();
    };
  }, [docked, dockNode]);

  return (
    <div
      className="webview-tile"
      data-testid={`webview-tile-${tabId}`}
      aria-hidden={!docked}
      style={
        docked && rect
          ? { position: "fixed", top: rect.top, left: rect.left, width: rect.width, height: rect.height }
          : COLLAPSED_STYLE
      }
      ref={container}
    />
  );
}
