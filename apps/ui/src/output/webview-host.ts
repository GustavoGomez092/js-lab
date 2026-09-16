import type { MainApi } from "../api";

/**
 * The part of one `<electrobun-webview>` element this module actually drives, named exactly as Electrobun's own
 * tag names it (`apps/desktop/.hutch/devkit/api/browser/webviewtag.ts`). Declaring the contract rather than
 * importing `WebviewTagElement` keeps this module testable in a plain DOM: the custom element is registered by
 * Electrobun's preload *inside* a real webview, so it does not exist in a test environment at all.
 */
export interface WebviewElement {
  executeJavascript(js: string): void;
  reload(): void;
  /** `HTMLElement.remove()`: takes the element out of the document for good. */
  remove(): void;
  on(event: string, listener: (event: CustomEvent) => void): void;
  off(event: string, listener: (event: CustomEvent) => void): void;
}

export interface WebviewHostRegistry {
  /** `WebViewTile` calls this the moment it has created that tab's element. */
  register(tabId: string, element: WebviewElement): void;
  /**
   * The tab's element is going away for a reason Main didn't ask for -- the tab closed, or its runtime changed to
   * `bun` and the tile unmounted. Reported to Main as `webRunner.exit`, which is exactly what `WebviewHost.onExit`
   * means on the other side. Main's own `webRunner.destroy` deliberately does NOT go through here.
   */
  unregister(tabId: string): void;
  /**
   * Main asked for a webview on a tab that hasn't got one. `WebViewHosts` listens and makes the tile create it,
   * which is what lets a run work on a `browser` tab whose Web View toggle was never switched on (Task 9's lazy
   * creation), and what gives Kill its fresh element after `webRunner.destroy`.
   */
  onNeedsElement(listener: (tabId: string) => void): () => void;
  dispose(): void;
}

interface Entry {
  element: WebviewElement;
  detach(): void;
}

/**
 * The UI-side half of the Main ⇄ UI web-runner bridge (spec §5.12).
 *
 * Main owns the *runtime* (`WebAdapter`, `apps/desktop/src/main/runtimes/web-adapter.ts`) but the webview element
 * lives here, so every instruction crosses the RPC as a `webRunner.*` message. This module is the single owner of
 * that correspondence: which tab currently has an element, what to do with an instruction for a tab that hasn't
 * got one, and which of the element's events Main needs to hear about.
 */
export function createWebviewHostRegistry(api: MainApi): WebviewHostRegistry {
  const entries = new Map<string, Entry>();
  const needsElement = new Set<(tabId: string) => void>();
  // M4 T9c (the `ready-NO-HOST` initial load) / T9e (the generation each tabId is currently on): a tab's tile
  // creates its `<electrobun-webview>` -- and that element starts loading `views://` -- the moment the element is
  // created (`WebViewHosts.tsx`'s `makeWebview`), whether that happens because the *user* merely opened the Web
  // View pane or because *Main* actually asked for one. Only the second case has anyone listening: `generations`
  // tracks, for every tabId Main has EVER shown interest in (asked for via `webRunner.ensure`, or reaffirmed via
  // `webRunner.reload` -- see below), the generation number Main minted for the entry it currently means by that
  // tabId (`apps/desktop/src/main/runtimes/webview-source.ts`). A tabId absent from this map has never been asked
  // for, so the tile-creation-time `dom-ready` for it is never even forwarded, rather than reaching Main's own
  // `webviews.ready()` and finding no host entry there (harmless, but a wasted round trip -- see the task report
  // for why the load itself still happens: eliminating that too would need the element's own first navigation
  // deferred past creation, which touches real native-webview load semantics this task chose not to take on).
  // Once a tabId is in `generations` it stays there for the session, its value only ever moving forward: a tab
  // Main has ever run code in will be asked for again on every later run too, and every `webRunner.ready` /
  // `.exit` this registry forwards for it is stamped with the generation on file at the moment it fires -- which
  // is what lets Main tell a late report from a destroyed-and-replaced entry from one about its current entry.
  const generations = new Map<string, number>();

  function attach(tabId: string, element: WebviewElement): () => void {
    // `dom-ready` fires on the element's first load *and* after every reload -- which is precisely the contract
    // `RawWebview.onLoaded` documents on Main's side, and the point Electrobun guarantees its own
    // `__electrobunSendToHost` hook is already installed, so the injected bootstrap can always reach the host.
    const onDomReady = () => {
      const generation = generations.get(tabId);
      if (generation !== undefined) api.webRunnerReady(tabId, generation);
    };
    const onHostMessage = (event: CustomEvent) => api.webRunnerMessage(tabId, (event as { detail?: unknown }).detail);
    element.on("dom-ready", onDomReady);
    element.on("host-message", onHostMessage);
    return () => {
      element.off("dom-ready", onDomReady);
      element.off("host-message", onHostMessage);
    };
  }

  function forget(tabId: string): Entry | undefined {
    const entry = entries.get(tabId);
    if (entry) {
      entry.detach();
      entries.delete(tabId);
    }
    return entry;
  }

  const unsubscribes = [
    api.on("webRunner.ensure", ({ tabId, generation }) => {
      // Records `tabId`'s generation regardless of whether it already has an element: a tab whose Web View pane
      // the user opened before ever running anything already has one (registered, no generation on file yet) by
      // the time Main's *own* first `ensure()` for that tab arrives here -- this is the only place that later
      // run's interest is ever recorded, so it must not be gated behind `entries.has(tabId)` the way the
      // `needsElement` signal below is. Always the newest value Main has minted: every `webRunner.ensure` names a
      // brand-new entry (`webview-source.ts`'s `ensure()` only calls it once per tab per entry), never a repeat.
      generations.set(tabId, generation);
      if (entries.has(tabId)) return;
      for (const listener of [...needsElement]) listener(tabId);
    }),
    api.on("webRunner.execute", ({ tabId, js }) => {
      // Dropped, never queued, when the tab has no element. `execute` only ever follows a `ready` Main itself
      // observed, so arriving here without one means the webview has since gone -- and replaying the script into
      // whatever element appears next would run it in a realm it was never compiled for. Main learns the webview
      // is gone from `webRunner.exit`, and its own `waitForReady` bound covers the rest.
      entries.get(tabId)?.element.executeJavascript(js);
    }),
    api.on("webRunner.reload", ({ tabId }) => {
      // T9e: unlike `webRunner.ensure` above, this never names a new generation -- reload replays the same entry's
      // page, it never replaces the entry -- so there is nothing to record here. Main only ever sends this after
      // the `ensure()` for the same entry has already resolved (its own `bridge.ensure` call is what lets that
      // promise resolve at all), and messages on one RPC channel are delivered in the order they were sent, so
      // `generations` already holds this tab's current value by the time this handler runs.
      const entry = entries.get(tabId);
      // No element yet: Main sends this the instant `ensure()` resolves, while the UI is still creating the
      // element (a React state change, then an effect), so it routinely arrives first. Reloading later would load
      // the page twice -- and the second load would wipe the bootstrap injected after the first `dom-ready`,
      // leaving the run with no `ready` of its own and nothing to do but time out. A new element's own first load
      // already is the fresh realm this was asking for, so it satisfies the request.
      if (entry) entry.element.reload();
    }),
    api.on("webRunner.destroy", ({ tabId }) => {
      // Main's own teardown: no `webRunner.exit` follows, matching `WebviewHost.onExit`'s contract that it never
      // fires for a destroy the host itself asked for. The command's own `generation` (paired with `.ensure`
      // above, T9e) needs no check here: Main only ever sends this after removing the entry from its own map, so
      // a `webRunner.ensure` for whatever replaces it is never sent ahead of this -- there is no newer element
      // for this to mistakenly tear down.
      forget(tabId)?.element.remove();
    }),
  ];

  return {
    register(tabId, element) {
      forget(tabId)?.element.remove();
      entries.set(tabId, { element, detach: attach(tabId, element) });
    },
    unregister(tabId) {
      if (!entries.has(tabId)) return;
      forget(tabId);
      // T9e: stamped with the generation on file for this tab, same as a `dom-ready`-driven `ready`. No generation
      // on file means Main never asked for this tab at all (its Web View pane was opened by hand, nothing ever
      // ran) -- there is no entry on Main's side to report to, so this is dropped locally rather than sent as an
      // event `webRunnerTabSchema` would reject anyway (`generation` is required).
      const generation = generations.get(tabId);
      if (generation !== undefined) api.webRunnerExit(tabId, generation);
    },
    onNeedsElement(listener) {
      needsElement.add(listener);
      return () => needsElement.delete(listener);
    },
    dispose() {
      for (const unsubscribe of unsubscribes) unsubscribe();
      for (const tabId of [...entries.keys()]) forget(tabId);
      needsElement.clear();
    },
  };
}
