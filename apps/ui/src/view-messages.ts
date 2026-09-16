import type { ViewMessages } from "@jslab/rpc-schema";
import { createMessageHub } from "./message-hub";

export const VIEW_MESSAGES = [
  "run.events",
  "run.state",
  "run.diagnostics",
  "menu.command",
  "e2e.request",
  "settings.changed",
  "file.opened",
  "file.saved",
  "file.saveAsConfirm",
  "file.saveCancelled",
  "file.saveFailed",
  "app.notice",
  "npm.op",
  "npm.log",
  "npm.changed",
  "wd.changed",
  "app.flushState",
  "webRunner.ensure",
  "webRunner.execute",
  "webRunner.reload",
  "webRunner.destroy",
] as const satisfies readonly (keyof ViewMessages)[];

// Type-level exhaustiveness check: a ViewMessages key missing from VIEW_MESSAGES fails typecheck here (m-5).
type MissingViewMessages = Exclude<keyof ViewMessages, (typeof VIEW_MESSAGES)[number]>;
const _allViewMessagesListed: [MissingViewMessages] extends [never] ? true : false = true;

export interface ViewMessageRouter {
  /** Transport handlers for every main-window message, keyed by message name. */
  handlers: Record<(typeof VIEW_MESSAGES)[number], (payload: unknown) => void>;
  on<K extends keyof ViewMessages>(name: K, listener: (payload: ViewMessages[K]) => void): () => void;
}

/**
 * Main-window messages go through the same hub as the Settings window (T24-hub-main): `main.tsx` renders after
 * `bootstrap()` and App subscribes in effects after the first paint, so a `menu.command`, `settings.changed`,
 * `file.opened` or `app.notice` sent in that window is queued and delivered once instead of dropped.
 */
export function createViewMessageRouter(): ViewMessageRouter {
  const hub = createMessageHub<ViewMessages>();
  return {
    handlers: Object.fromEntries(
      VIEW_MESSAGES.map((name) => [name, hub.dispatch(name)]),
    ) as ViewMessageRouter["handlers"],
    on: (name, listener) => hub.on(name, listener),
  };
}
