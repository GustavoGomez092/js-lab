import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  dockedWebviewRects,
  type RectLike,
  rectsIntersect,
  trackWidgetOcclusion,
} from "../src/editor/widget-occlusion";

/**
 * M4, the user-reported defect: Monaco's hover/IntelliSense popup appearing *underneath* a docked Web View tile.
 *
 * A native `<electrobun-webview>` paints above all HTML regardless of `z-index` (see `overlay-presence.ts`), and
 * Monaco's widgets cannot register with the presence counter the seven shell overlays use -- they are not
 * components we render, and Monaco 0.56 exposes no public widget-visibility event. `widget-occlusion.ts` closes
 * that hole by watching the container Monaco is given as `overflowWidgetsDomNode`.
 *
 * The property these tests exist to pin is not merely "a widget collapses the tile" but the narrower one that keeps
 * the cure from being worse than the disease: presence is registered ONLY while a widget actually overlaps a docked
 * tile. Registering on every hover would blink a running tab's Web View out on nearly every keystroke.
 */

const COUNTER_KEY = "__jslabOverlayPresence__";

function openCount(): number {
  const g = globalThis as typeof globalThis & { [COUNTER_KEY]?: { openCount: number } };
  return g[COUNTER_KEY]?.openCount ?? 0;
}

beforeEach(() => {
  const g = globalThis as typeof globalThis & { [COUNTER_KEY]?: { openCount: number } };
  if (g[COUNTER_KEY]) g[COUNTER_KEY].openCount = 0;
  document.body.innerHTML = "";
});

/** happy-dom lays nothing out -- every `getBoundingClientRect` is 0x0 -- so boxes are assigned explicitly. */
const boxes = new WeakMap<Element, RectLike>();
function setBox(element: Element, box: { top: number; left: number; width: number; height: number }): void {
  boxes.set(element, {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
  });
}
const ZERO: RectLike = { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };

let originalRect: PropertyDescriptor | undefined;
beforeEach(() => {
  originalRect = Object.getOwnPropertyDescriptor(Element.prototype, "getBoundingClientRect");
  Object.defineProperty(Element.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: Element) {
      return boxes.get(this) ?? ZERO;
    },
  });
});
afterEach(() => {
  if (originalRect) Object.defineProperty(Element.prototype, "getBoundingClientRect", originalRect);
});

/** happy-dom delivers MutationObserver records on a microtask; give it a turn to run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const TILE: RectLike = { top: 400, left: 0, right: 800, bottom: 900, width: 800, height: 500 };

function setup() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

describe("rectsIntersect", () => {
  test("overlapping boxes intersect; merely touching edges do not", () => {
    const tile: RectLike = { top: 100, left: 100, right: 200, bottom: 200, width: 100, height: 100 };
    const overlapping: RectLike = { top: 150, left: 150, right: 250, bottom: 250, width: 100, height: 100 };
    const touching: RectLike = { top: 200, left: 100, right: 200, bottom: 300, width: 100, height: 100 };
    const apart: RectLike = { top: 0, left: 0, right: 50, bottom: 50, width: 50, height: 50 };
    expect(rectsIntersect(tile, overlapping)).toBe(true);
    expect(rectsIntersect(tile, touching)).toBe(false);
    expect(rectsIntersect(tile, apart)).toBe(false);
  });
});

describe("dockedWebviewRects", () => {
  test("selects docked tiles only -- a collapsed tile's 1x1 box is not an occluder", () => {
    const docked = document.createElement("div");
    docked.className = "webview-tile";
    docked.setAttribute("aria-hidden", "false");
    setBox(docked, { top: 400, left: 0, width: 800, height: 500 });
    const parked = document.createElement("div");
    parked.className = "webview-tile";
    parked.setAttribute("aria-hidden", "true");
    setBox(parked, { top: 0, left: 0, width: 1, height: 1 });
    document.body.append(docked, parked);

    const rects = dockedWebviewRects();
    expect(rects).toHaveLength(1);
    expect(rects[0]).toMatchObject({ top: 400, height: 500 });
  });
});

describe("trackWidgetOcclusion", () => {
  test("a widget overlapping a docked tile registers presence, and removing it releases", async () => {
    const container = setup();
    const stop = trackWidgetOcclusion({ container, occluders: () => [TILE] });
    try {
      expect(openCount()).toBe(0); // an empty container occludes nothing

      const hover = document.createElement("div");
      setBox(hover, { top: 500, left: 100, width: 300, height: 120 }); // squarely over the tile
      container.appendChild(hover);
      await settle();
      expect(openCount()).toBe(1);

      hover.remove();
      await settle();
      expect(openCount()).toBe(0);
    } finally {
      stop();
    }
  });

  /**
   * The anti-flicker property, and the reason this module measures instead of merely detecting. A hover in the
   * middle of the editor is nowhere near the tile; collapsing for it would blink the Web View on every keystroke.
   */
  test("a widget that does NOT overlap a docked tile registers nothing (no flicker while typing)", async () => {
    const container = setup();
    const stop = trackWidgetOcclusion({ container, occluders: () => [TILE] });
    try {
      const hover = document.createElement("div");
      setBox(hover, { top: 20, left: 100, width: 300, height: 120 }); // up in the editor, clear of the tile
      container.appendChild(hover);
      await settle();
      expect(openCount()).toBe(0);
    } finally {
      stop();
    }
  });

  test("a widget moved onto the tile by a style change alone registers presence", async () => {
    const container = setup();
    const stop = trackWidgetOcclusion({ container, occluders: () => [TILE] });
    try {
      const hover = document.createElement("div");
      setBox(hover, { top: 20, left: 100, width: 300, height: 120 });
      container.appendChild(hover);
      await settle();
      expect(openCount()).toBe(0);

      // Monaco reuses one node and repositions it by rewriting `style` -- no add or remove ever happens.
      setBox(hover, { top: 500, left: 100, width: 300, height: 120 });
      hover.setAttribute("style", "top:500px");
      await settle();
      expect(openCount()).toBe(1);
    } finally {
      stop();
    }
  });

  test("with no docked tile there is no native surface, so nothing is ever registered", async () => {
    const container = setup();
    const stop = trackWidgetOcclusion({ container, occluders: () => [] });
    try {
      const hover = document.createElement("div");
      setBox(hover, { top: 500, left: 100, width: 300, height: 120 });
      container.appendChild(hover);
      await settle();
      expect(openCount()).toBe(0);
    } finally {
      stop();
    }
  });

  test("disposing while a widget is showing releases the presence it held", async () => {
    const container = setup();
    const stop = trackWidgetOcclusion({ container, occluders: () => [TILE] });
    const hover = document.createElement("div");
    setBox(hover, { top: 500, left: 100, width: 300, height: 120 });
    container.appendChild(hover);
    await settle();
    expect(openCount()).toBe(1);

    stop();
    expect(openCount()).toBe(0);

    // ...and the disposer is not a second decrement waiting to happen.
    stop();
    expect(openCount()).toBe(0);
  });

  test("a zero-sized widget box is ignored (Monaco leaves its overflow containers mounted and empty)", async () => {
    const container = setup();
    const stop = trackWidgetOcclusion({ container, occluders: () => [TILE] });
    try {
      const empty = document.createElement("div"); // no box assigned -> 0x0, like an idle overflow container
      container.appendChild(empty);
      await settle();
      expect(openCount()).toBe(0);
    } finally {
      stop();
    }
  });
});
