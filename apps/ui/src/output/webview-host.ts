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
  // M4 T9c (the `ready-NO-HOST` initial load): a tab's tile creates its `<electrobun-webview>` -- and that element
  // starts loading `views://` -- the moment the element is created (`WebViewHosts.tsx`'s `makeWebview`), whether
  // that happens because the *user* merely opened the Web View pane or because *Main* actually asked for one. Only
  // the second case has anyone listening: `wanted` tracks every tabId Main has EVER shown interest in (asked for
  // via `webRunner.ensure`, or `webRunner.reload` -- see below), so the tile-creation-time `dom-ready` for a tab
  // nobody asked about is never even forwarded, rather than reaching Main's own `webviews.ready()` and finding no
  // host entry there (harmless, but a wasted round trip -- see the task report for why the load itself still
  // happens: eliminating that too would need the element's own first navigation deferred past creation, which
  // touches real native-webview load semantics this task chose not to take on). Once a tabId is in `wanted` it
  // stays there for the session: a tab Main has ever run code in will be asked for again on every later run too.
  const wanted = new Set<string>();

  function attach(tabId: string, element: WebviewElement): () => void {
    // `dom-ready` fires on the element's first load *and* after every reload -- which is precisely the contract
    // `RawWebview.onLoaded` documents on Main's side, and the point Electrobun guarantees its own
    // `__electrobunSendToHost` hook is already installed, so the injected bootstrap can always reach the host.
    const onDomReady = () => {
      if (wanted.has(tabId)) api.webRunnerReady(tabId);
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
    api.on("webRunner.ensure", ({ tabId }) => {
      // Marks `tabId` wanted regardless of whether it already has an element: a tab whose Web View pane the user
      // opened before ever running anything already has one (registered, `wanted` still false) by the time Main's
      // *own* first `ensure()` for that tab arrives here -- this is the only place that later run's interest is
      // ever recorded, so it must not be gated behind `entries.has(tabId)` the way the `needsElement` signal below is.
      wanted.add(tabId);
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
      // Marked wanted here too, not only in `webRunner.ensure` above: normally `ensure` arrives first and this is
      // redundant, but nothing guarantees that ordering from this module's own point of view, and a reload this
      // registry didn't yet know was wanted must still unsuppress the `dom-ready` it is about to be satisfied by
      // (see the comment below).
      wanted.add(tabId);
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
      // fires for a destroy the host itself asked for.
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
      api.webRunnerExit(tabId);
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
