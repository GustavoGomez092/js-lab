import { webRunnerMessageParamsSchema, webRunnerTabSchema } from "@jslab/rpc-schema";
import { createValidators, type Log } from "./validate";

/**
 * Main's side of one tab's webview, as the UI reports on it. Implemented by `createUiWebviewSource`
 * (`../runtimes/webview-source.ts`), which turns each call back into the listeners `web-adapter.ts` registered on
 * its `RawWebview`. This file only validates the RPC boundary and dispatches by `tabId`; it never interprets an
 * envelope itself -- `createSequencedWebviewHost` owns the bridge's own shape and sequence checks.
 */
export interface WebRunnerMessageSink {
  /** One page → host envelope for this tab. */
  receive(tabId: string, raw: unknown): void;
  /** This tab's page reached `dom-ready`: it is safe to inject script into it now. */
  ready(tabId: string): void;
  /** This tab's webview is gone for a reason Main didn't ask for (the tab closed, the view died). */
  exit(tabId: string): void;
}

export interface WebRunnerHandlerDeps {
  webviews: WebRunnerMessageSink;
  log: Log;
}

/**
 * The Main-side half of the Web runner's UI-relayed bridge traffic (spec §5.12). The UI-side host module
 * (`apps/ui/src/output/webview-host.ts`) owns each tab's `<electrobun-webview>` and calls these three messages.
 *
 * Fire-and-forget, like every other `messages` entry in this codebase's handler groups: an invalid payload is
 * logged and dropped, never thrown into the RPC layer. The schemas come from `@jslab/rpc-schema` so this boundary
 * keeps the same path-safe `tabId` rule (spec §18) as every other tabId payload, rather than a local approximation.
 */
export function createWebRunnerHandlers(deps: WebRunnerHandlerDeps) {
  const { message } = createValidators(deps.log);
  return {
    requests: {},
    messages: {
      "webRunner.message": message(webRunnerMessageParamsSchema, "webRunner.message", ({ tabId, raw }) => {
        deps.webviews.receive(tabId, raw);
      }),
      "webRunner.ready": message(webRunnerTabSchema, "webRunner.ready", ({ tabId }) => {
        deps.webviews.ready(tabId);
      }),
      "webRunner.exit": message(webRunnerTabSchema, "webRunner.exit", ({ tabId }) => {
        deps.webviews.exit(tabId);
      }),
    },
  };
}
