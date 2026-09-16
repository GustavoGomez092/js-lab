import type { TabRunContext } from "./adapter";
import { createSequencedWebviewHost, type RawWebview, type WebviewHost, type WebviewSource } from "./web-adapter";

/**
 * The four instructions Main can give one tab's `<electrobun-webview>`, which lives in the UI process. Each one is
 * a `webRunner.*` message on the main window's RPC (`packages/rpc-schema/src/ui-rpc.ts`); this interface exists so
 * the source can be tested without an RPC, and so `index.ts` is the only file that knows how a message is sent.
 */
export interface WebviewBridge {
  /** Make sure this tab has a live webview, creating one if its Web View toggle was never switched on. */
  ensure(tabId: string): void;
  execute(tabId: string, js: string): void;
  reload(tabId: string): void;
  destroy(tabId: string): void;
}

export interface UiWebviewSourceDeps {
  bridge: WebviewBridge;
  /** Reads the bundled runner-web bootstrap (`<Resources>/app/runner/web-bootstrap.js`). Called at most once. */
  readBootstrap(): Promise<string>;
}

/** A `WebviewSource` that also accepts what the UI reports back about each tab's element. */
export interface UiWebviewSource extends WebviewSource {
  /** The tab's page reached `dom-ready`: whatever is waiting to inject script may do so now. */
  ready(tabId: string): void;
  /** One page → host envelope, relayed by the UI. Satisfies `WebRunnerMessageSink` (`../rpc/web-runner-handlers.ts`). */
  receive(tabId: string, raw: unknown): void;
  /** The tab's webview died or was torn down by something other than this source's own `destroy`. */
  exit(tabId: string): void;
}

interface Entry {
  host: WebviewHost;
  loaded: Set<() => void>;
  messages: Set<(raw: unknown) => void>;
  crashed: Set<() => void>;
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
  /** The bootstrap is identical for every tab and every run, so it is read once and shared. */
  let bootstrap: Promise<string> | null = null;

  /** Drops Main's side of a tab's webview and tells the UI to remove the element. Never reports an exit. */
  function teardown(tabId: string): void {
    if (!entries.delete(tabId)) return;
    deps.bridge.destroy(tabId);
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
      const entry: Entry = { host: createSequencedWebviewHost(raw, source), loaded, messages, crashed };
      entries.set(tabId, entry);
      // Sent after the entry exists, so a `webRunner.ready` the UI sends straight back finds a host to notify.
      deps.bridge.ensure(tabId);
      return entry.host;
    },

    destroy(tabId: string): void {
      teardown(tabId);
    },

    ready(tabId: string): void {
      fire(entries.get(tabId)?.loaded);
    },

    receive(tabId: string, raw: unknown): void {
      for (const listener of [...(entries.get(tabId)?.messages ?? [])]) listener(raw);
    },

    exit(tabId: string): void {
      const entry = entries.get(tabId);
      if (!entry) return;
      // Dropped before the listeners run: the webview is already gone, so the tab's next run must build a new one
      // rather than keep driving an element that no longer exists.
      entries.delete(tabId);
      fire(entry.crashed);
    },
  };
}
