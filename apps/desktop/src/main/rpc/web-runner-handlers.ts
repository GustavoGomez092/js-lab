import { createValidators, type Log, type SafeParser } from "./validate";

/**
 * Where a relayed page->host message for one tab's webview ends up. A future `WebviewSource` implementation (Task
 * 8, once a real `<electrobun-webview>` DOM node exists to correlate against) satisfies this by routing `raw` into
 * that tab's `RawWebview.onHostMessage` listeners (`../runtimes/web-adapter.ts`) -- this file only validates the
 * RPC boundary and dispatches by `tabId`; it never interprets `raw` itself (the bridge's own strict-successor `seq`
 * check on `HostToWeb`, not relevant here, and `WebToHost`'s own shape check happen inside `createSequencedWebviewHost`).
 */
export interface WebRunnerMessageSink {
  receive(tabId: string, raw: unknown): void;
}

export interface WebRunnerHandlerDeps {
  webviews: WebRunnerMessageSink;
  log: Log;
}

interface WebRunnerMessagePayload {
  tabId: string;
  raw: unknown;
}

/**
 * A hand-rolled `SafeParser` (matching `createValidators`' duck-typed contract) rather than a new `@jslab/rpc-schema`
 * zod schema: `raw`'s shape is the page's own `WebToHost` envelope, already validated by the runner-web bridge
 * on its own side (`host-bridge.ts`'s `isHostToWeb`-equivalent for the reverse direction); this handler only needs
 * to confirm the RPC payload itself is well-formed enough to route (spec's RPC discipline: every new UI-reachable
 * entry point goes through `createValidators`), not re-implement the bridge's own message-shape validation.
 */
const webRunnerMessageSchema: SafeParser<WebRunnerMessagePayload> = {
  safeParse(input) {
    if (typeof input !== "object" || input === null) {
      return { success: false, error: { message: "expected an object" } };
    }
    const { tabId, raw } = input as { tabId?: unknown; raw?: unknown };
    if (typeof tabId !== "string" || tabId.length === 0) {
      return { success: false, error: { message: "tabId must be a non-empty string" } };
    }
    if (typeof raw !== "object" || raw === null) {
      return { success: false, error: { message: "raw must be an object" } };
    }
    return { success: true, data: { tabId, raw } };
  },
};

/**
 * The Main-side half of the Web runner's UI-relayed bridge traffic (spec §5.12): the thin UI-side host module a
 * future task builds (Task 8's `WebViewTile.tsx` is the eventual owner) listens for its `<electrobun-webview>`'s
 * `host-message` event and calls this method to hand the raw envelope to Main. Fire-and-forget, like every other
 * `messages` entry in this codebase's RPC handler groups (`workspace-handlers.ts`, `wd-handlers.ts`): an invalid
 * payload is logged and dropped, never thrown into the RPC layer.
 */
export function createWebRunnerHandlers(deps: WebRunnerHandlerDeps) {
  const { message } = createValidators(deps.log);
  return {
    requests: {},
    messages: {
      "webRunner.message": message(webRunnerMessageSchema, "webRunner.message", ({ tabId, raw }) => {
        deps.webviews.receive(tabId, raw);
      }),
    },
  };
}
