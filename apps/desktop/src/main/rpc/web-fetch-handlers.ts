import type { Runtime } from "@jslab/shared";
import type { Redactor } from "../logging/redact";
import { createValidators, type Log, type SafeParser } from "./validate";

/**
 * The Main-side half of `browser-node`'s `fetch` (spec section 5.12).
 *
 * Only `browser-node` is routed through Main. A `browser` tab's `fetch` is the page's own, with CORS enforced --
 * true browser semantics are the point of that runtime -- so nothing in a `browser` page ever sends `webFetch.*`
 * (the refusal lives in `packages/runner-web/src/fetch-proxy.ts`, which installs nothing at all for `browser`).
 *
 * What crosses back is streamed, not buffered: `head` as soon as the reply's status and headers are known, then one
 * `chunk` per read, then `end`. `webFetch.abort` aborts the real request and releases its in-flight entry, so an
 * aborted request costs nothing afterwards -- one leaked handle per abort is the kind of slow leak that only shows
 * up in a long session.
 *
 * Wiring this group into `mergeHandlers` belongs to the UI-side tile task that also relays the page's messages, the
 * same way `web-runner-handlers.ts` validates its end of that relay without owning the wiring. Both method names
 * here are new and unique across the merged groups (`mergeHandlers` throws on a duplicate).
 */

export interface ProxiedRequestPayload {
  url: string;
  method: string;
  headers: [string, string][];
  /** base64, or null when the request has no body. The relay carries JSON only. */
  body: string | null;
}

export interface WebFetchRequestPayload {
  tabId: string;
  id: number;
  request: ProxiedRequestPayload;
}

export interface WebFetchAbortPayload {
  tabId: string;
  id: number;
}

/** The page-bound half of one reply. Every payload names the tab so the UI can relay it to the right webview. */
export interface WebFetchSend {
  head(payload: {
    tabId: string;
    id: number;
    status: number;
    statusText: string;
    headers: [string, string][];
    url: string;
  }): void;
  chunk(payload: { tabId: string; id: number; data: string }): void;
  end(payload: { tabId: string; id: number }): void;
  error(payload: { tabId: string; id: number; message: string }): void;
}

export interface WebFetchHandlerDeps {
  send: WebFetchSend;
  /**
   * The runtime of the tab a request claims to come from (fix round 1, F2). This is an authorization check, not
   * wiring: the page-side refusal lives in the same JS realm as user code, over a transport `host-bridge.ts`
   * documents as forgeable, so `browser` has to be refused at the trust boundary as well. Undefined means Main
   * cannot identify the tab, which is refused exactly like a `browser` tab.
   */
  runtimeOf(tabId: string): Runtime | undefined;
  /** Spec section 18: anything recorded about a request is masked here, before it is written or sent anywhere. */
  redact: Redactor;
  log: Log;
  /** Test seam; production always uses the runtime's own `fetch`. */
  fetch?(url: string, init?: RequestInit): Promise<Response>;
}

function isHeaderList(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"),
    )
  );
}

function isProxiedRequest(value: unknown): value is ProxiedRequestPayload {
  if (typeof value !== "object" || value === null) return false;
  const { url, method, headers, body } = value as Record<string, unknown>;
  if (typeof url !== "string" || url.length === 0) return false;
  if (typeof method !== "string" || method.length === 0) return false;
  // The scheme is deliberately NOT checked here (fix round 1, F1): a payload this well-formed is routable, and a
  // routable request must be answered with an error rather than dropped by `message()` to hang the page forever.
  if (!isHeaderList(headers)) return false;
  return body === null || typeof body === "string";
}

/**
 * Hand-rolled `SafeParser`s, matching `createValidators`' duck-typed contract, for the same reason
 * `web-runner-handlers.ts` hand-rolls its own rather than adding a `@jslab/rpc-schema` zod schema: these payloads
 * are the runner-web fetch proxy's own envelope, not part of the UI's settings/session surface.
 */
const requestSchema: SafeParser<WebFetchRequestPayload> = {
  safeParse(input) {
    if (typeof input !== "object" || input === null) {
      return { success: false, error: { message: "expected an object" } };
    }
    const { tabId, id, request } = input as Record<string, unknown>;
    if (typeof tabId !== "string" || tabId.length === 0) {
      return { success: false, error: { message: "tabId must be a non-empty string" } };
    }
    if (!Number.isSafeInteger(id) || (id as number) < 1) {
      return { success: false, error: { message: "id must be a positive safe integer" } };
    }
    if (!isProxiedRequest(request)) {
      return { success: false, error: { message: "request must be an http(s) request envelope" } };
    }
    return { success: true, data: { tabId, id: id as number, request } };
  },
};

const abortSchema: SafeParser<WebFetchAbortPayload> = {
  safeParse(input) {
    if (typeof input !== "object" || input === null) {
      return { success: false, error: { message: "expected an object" } };
    }
    const { tabId, id } = input as Record<string, unknown>;
    if (typeof tabId !== "string" || tabId.length === 0) {
      return { success: false, error: { message: "tabId must be a non-empty string" } };
    }
    if (!Number.isSafeInteger(id) || (id as number) < 1) {
      return { success: false, error: { message: "id must be a positive safe integer" } };
    }
    return { success: true, data: { tabId, id: id as number } };
  },
};

/** The url's scheme, or null when it does not parse at all. */
function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** One line describing a request, for the log. Passed through `redact` before it reaches the log or the page. */
function summarize(request: ProxiedRequestPayload): string {
  return [`${request.method} ${request.url}`, ...request.headers.map(([name, value]) => `${name}: ${value}`)].join(
    " | ",
  );
}

export function createWebFetchHandlers(deps: WebFetchHandlerDeps) {
  const { message } = createValidators(deps.log);
  const inflight = new Map<string, AbortController>();
  const keyOf = (tabId: string, id: number) => `${tabId}:${id}`;
  const doFetch: NonNullable<WebFetchHandlerDeps["fetch"]> = deps.fetch ?? ((url, init) => fetch(url, init));

  /** Answers a routable request that will not be served, so it surfaces as a failure instead of a hang. */
  function refuse(tabId: string, id: number, reason: string): void {
    const text = deps.redact(reason);
    deps.log("Web fetch refused", text);
    deps.send.error({ tabId, id, message: text });
  }

  async function run({ tabId, id, request }: WebFetchRequestPayload): Promise<void> {
    const key = keyOf(tabId, id);

    // F2: the defining refusal, enforced at the trust boundary rather than only in the page's own realm. Fail
    // closed -- a tab Main cannot identify is refused exactly like a `browser` tab.
    const runtime = deps.runtimeOf(tabId);
    if (runtime !== "browser-node") {
      refuse(
        tabId,
        id,
        `Fetch is only routed through JSLab for the "browser-node" runtime; tab ${tabId} is ${runtime ?? "unknown"}.`,
      );
      return;
    }

    // F1, defence in depth. The page refuses these before sending; if one arrives anyway it is answered, never
    // dropped. A `file:` url stays refused: it would make this bridge an unrestricted file reader for page code,
    // which is a different capability from "fetch without CORS".
    const scheme = schemeOf(request.url);
    if (scheme === null || (scheme !== "http:" && scheme !== "https:")) {
      refuse(tabId, id, `Cannot fetch ${request.url}: only http and https are routed through JSLab.`);
      return;
    }

    // M3: ids are proxy-generated and monotonic, so a repeat means a misbehaving page or relay. Refusing the
    // newcomer keeps the request already in flight abortable, rather than silently orphaning it.
    if (inflight.has(key)) {
      refuse(tabId, id, `Ignored a repeated request id for tab ${tabId}; the request already in flight continues.`);
      return;
    }

    const controller = new AbortController();
    inflight.set(key, controller);
    deps.log("Web fetch request", deps.redact(summarize(request)));
    try {
      const response = await doFetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body === null ? null : Buffer.from(request.body, "base64"),
        signal: controller.signal,
      });
      // An aborted request is already released, and the page is no longer listening: send nothing more.
      if (controller.signal.aborted) return;
      deps.send.head({
        tabId,
        id,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()) as [string, string][],
        url: response.url,
      });
      const body = response.body;
      if (!body) {
        inflight.delete(key);
        deps.send.end({ tabId, id });
        return;
      }
      const reader = body.getReader();
      // One `chunk` per read, as the read resolves: the page's `Response` body has to arrive progressively, so
      // nothing here may accumulate the body and send it in one piece at the end.
      for (;;) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) return;
        if (done) break;
        if (value && value.length > 0) {
          deps.send.chunk({ tabId, id, data: Buffer.from(value).toString("base64") });
        }
      }
      inflight.delete(key);
      deps.send.end({ tabId, id });
    } catch (error) {
      if (controller.signal.aborted) return;
      inflight.delete(key);
      // Masked before it crosses back to the page, not after: the failure text can quote the request (a url with
      // credentials in it, an authorization header) and this is the boundary.
      const text = deps.redact(error instanceof Error ? error.message : String(error));
      deps.log("Web fetch failed", text);
      deps.send.error({ tabId, id, message: text });
    }
  }

  return {
    requests: {},
    messages: {
      "webFetch.request": message(requestSchema, "webFetch.request", run),
      "webFetch.abort": message(abortSchema, "webFetch.abort", ({ tabId, id }) => {
        const key = keyOf(tabId, id);
        const controller = inflight.get(key);
        if (!controller) return;
        // Release first, then cancel: the in-flight entry is gone whatever the abort does to the request in
        // progress, so an aborted request can never leave a handle behind.
        inflight.delete(key);
        controller.abort();
      }),
    },
    /** In-flight requests. A diagnostic seam: an abort that did not release its entry is a leak. */
    pending: (): number => inflight.size,
  };
}
