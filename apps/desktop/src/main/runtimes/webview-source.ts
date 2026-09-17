import type { TabRunContext } from "./adapter";
import { createSequencedWebviewHost, type RawWebview, type WebviewHost, type WebviewSource } from "./web-adapter";

/**
 * The four instructions Main can give one tab's `<electrobun-webview>`, which lives in the UI process. Each one is
 * a `webRunner.*` message on the main window's RPC (`packages/rpc-schema/src/ui-rpc.ts`); this interface exists so
 * the source can be tested without an RPC, and so `index.ts` is the only file that knows how a message is sent.
 */
export interface WebviewBridge {
  /**
   * Make sure this tab has a live webview, creating one if its Web View toggle was never switched on.
   * `generation` is the monotonic-per-tab counter this source mints for the entry it just created (T9e): the UI
   * records it and stamps every `ready`/`exit` it reports for this tab with it, until a later `ensure` replaces it.
   */
  ensure(tabId: string, generation: number): void;
  execute(tabId: string, js: string): void;
  reload(tabId: string): void;
  /** T9e: carries the generation of the entry being torn down, paired with `ensure` above. */
  destroy(tabId: string, generation: number): void;
}

export interface UiWebviewSourceDeps {
  bridge: WebviewBridge;
  /** Reads the bundled runner-web bootstrap (`<Resources>/app/runner/web-bootstrap.js`). Called at most once. */
  readBootstrap(): Promise<string>;
}

/** A `WebviewSource` that also accepts what the UI reports back about each tab's element. */
export interface UiWebviewSource extends WebviewSource {
  /**
   * The tab's page reached `dom-ready`: whatever is waiting to inject script may do so now. `generation` is the
   * one the UI last stamped this tabId's forwarded events with (T9e); an event whose generation doesn't match the
   * tab's current entry is a late report from an entry this source has already replaced, and is ignored.
   */
  ready(tabId: string, generation: number): void;
  /** One page → host envelope, relayed by the UI. Satisfies `WebRunnerMessageSink` (`../rpc/web-runner-handlers.ts`). */
  receive(tabId: string, raw: unknown): void;
  /**
   * The tab's webview died or was torn down by something other than this source's own `destroy`. Same
   * generation-gating as `ready` above, and for the same reason: a crash reported by an entry this source has
   * already replaced must not tear down the replacement (T9e).
   */
  exit(tabId: string, generation: number): void;
  /**
   * The UI that owns every one of these elements has gone away: the watchdog reloaded the view after a post-sleep
   * WKWebView freeze, or the user closed the window and reopened it from the Dock (both in `../index.ts`).
   *
   * Without this, Main's `entries` map outlived the elements it described. The next run's `ensure()` hit a stale
   * entry, returned the old host and so never sent `webRunner.ensure` -- and the `webRunner.reload` that followed
   * reached a UI whose own map was empty, where it is a no-op. No element was ever created, `onLoaded` never
   * fired, and the run failed after 2 s with "never reported ready" on **every** browser tab, self-healing only
   * from the second run once the ready timeout finally dropped the entry.
   *
   * Invalidating from Main rather than relying on the UI to report each teardown is deliberate: on a hard
   * `loadURL` navigation the UI's React cleanup is not guaranteed to run at all, so its `webRunner.exit` cannot be
   * counted on to arrive.
   */
  invalidateAll(): void;
}

interface Entry {
  host: WebviewHost;
  loaded: Set<() => void>;
  messages: Set<(raw: unknown) => void>;
  crashed: Set<() => void>;
  /** T9e: minted when this entry was created (see `ensure` below); gates `ready`/`exit` against a stale generation. */
  generation: number;
}

/**
 * The real `WebviewSource` (spec §5.12) -- the piece that was missing for `createWebAdapter` to be registrable at
 * all. `web-adapter.ts` drives a `RawWebview`, deliberately shaped like Electrobun's own webview tag; here that
 * shape is satisfied by forwarding each call across the RPC to the UI, and by feeding the element's own events
 * back in through `ready`/`receive`/`exit`. Nothing about the bridge discipline (the injected bootstrap, the
 * strictly-consecutive `seq`) is re-implemented: `createSequencedWebviewHost` still owns all of it.
 */
export function createUiWebviewSource(deps: UiWebviewSourceDeps): UiWebviewSource {
  const entries = new Map<string, Entry>();
  /**
   * T9e: the next generation to mint for each tab. Kept apart from `entries` -- which loses the tabId the moment
   * an entry is torn down -- because the counter must keep climbing across a destroy/recreate cycle rather than
   * restart at the same value, or a stale event from the entry just destroyed could pass as current again.
   */
  const nextGeneration = new Map<string, number>();
  /** The bootstrap is identical for every tab and every run, so it is read once and shared. */
  let bootstrap: Promise<string> | null = null;

  /** Drops Main's side of a tab's webview and tells the UI to remove the element. Never reports an exit. */
  function teardown(tabId: string): void {
    const entry = entries.get(tabId);
    if (!entry) return;
    entries.delete(tabId);
    deps.bridge.destroy(tabId, entry.generation);
  }

  function fire(listeners: Set<() => void> | undefined): void {
    for (const listener of [...(listeners ?? [])]) listener();
  }

  return {
    async ensure(tab: TabRunContext): Promise<WebviewHost> {
      const existing = entries.get(tab.tabId);
      if (existing) return existing.host;

      if (!bootstrap) {
        // A failed read is not cached: a later run retries rather than inheriting one bad startup forever.
        bootstrap = deps.readBootstrap();
        bootstrap.catch(() => {
          bootstrap = null;
        });
      }
      const source = await bootstrap;
      // Another `ensure()` for this tab may have finished while this one awaited the bootstrap; one tab owns
      // exactly one webview, so the winner's host is the answer for both.
      const raced = entries.get(tab.tabId);
      if (raced) return raced.host;

      const tabId = tab.tabId;
      // T9e: monotonic per tab, so a destroy/recreate cycle never reuses a value a late event could still carry.
      const generation = (nextGeneration.get(tabId) ?? 0) + 1;
      nextGeneration.set(tabId, generation);
      const loaded = new Set<() => void>();
      const messages = new Set<(raw: unknown) => void>();
      const crashed = new Set<() => void>();
      const raw: RawWebview = {
        executeJavascript: (js) => deps.bridge.execute(tabId, js),
        reload: () => deps.bridge.reload(tabId),
        onLoaded: (listener) => {
          loaded.add(listener);
          return () => loaded.delete(listener);
        },
        onHostMessage: (listener) => {
          messages.add(listener);
          return () => messages.delete(listener);
        },
        onCrashed: (listener) => {
          crashed.add(listener);
          return () => crashed.delete(listener);
        },
        destroy: () => teardown(tabId),
      };
      const entry: Entry = { host: createSequencedWebviewHost(raw, source), loaded, messages, crashed, generation };
      entries.set(tabId, entry);
      // Sent after the entry exists, so a `webRunner.ready` the UI sends straight back finds a host to notify.
      deps.bridge.ensure(tabId, generation);
      return entry.host;
    },

    destroy(tabId: string): void {
      teardown(tabId);
    },

    ready(tabId: string, generation: number): void {
      const entry = entries.get(tabId);
      // T9e: a `ready` for a generation that isn't this tab's current one is a late report from an entry this
      // source has already replaced (destroy() ran, then a new ensure() created the one now in the map) -- the
      // defect this gate exists for. Firing the replacement's `loaded` listeners for someone else's load would be
      // wrong regardless of how harmless a plain reload-ready looks.
      if (!entry || entry.generation !== generation) return;
      fire(entry.loaded);
    },

    receive(tabId: string, raw: unknown): void {
      for (const listener of [...(entries.get(tabId)?.messages ?? [])]) listener(raw);
    },

    invalidateAll(): void {
      // The map is emptied *before* any listener runs: firing `crashed` re-enters this source (a session's own
      // teardown path), and a re-entrant `ensure()` must build a fresh entry rather than find a discarded one.
      const discarded = [...entries.values()];
      entries.clear();
      // No `bridge.destroy`: the UI those commands would be addressed to is the one that just went away, and its
      // replacement has no such element. `nextGeneration` is deliberately kept, so a late event from a discarded
      // entry can never pass as current again -- the same reason `teardown` leaves it alone.
      for (const entry of discarded) fire(entry.crashed);
    },

    exit(tabId: string, generation: number): void {
      const entry = entries.get(tabId);
      // T9e: same generation gate as `ready` -- a crash reported by an entry this source has already replaced
      // must not delete the replacement or fire its `crashed` listeners as a spurious "Web runner exited
      // unexpectedly." on a webview that is alive.
      if (!entry || entry.generation !== generation) return;
      // Dropped before the listeners run: the webview is already gone, so the tab's next run must build a new one
      // rather than keep driving an element that no longer exists.
      entries.delete(tabId);
      fire(entry.crashed);
    },
  };
}
