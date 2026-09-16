import type { Redactor } from "../logging/redact";
import type { Log } from "./validate";

/**
 * The Main-side half of `browser-node`'s `fetch` (spec section 5.12).
 *
 * Only `browser-node` is routed through Main. A `browser` tab's `fetch` is the page's own, with CORS enforced --
 * true browser semantics are the point of that runtime -- so nothing in a `browser` page ever gets a working proxy
 * (the refusal lives in `packages/runner-web/src/fetch-proxy.ts`, which installs nothing at all for `browser`).
 *
 * **Fix round 1 (security).** This used to be a `mergeHandlers`-registered RPC group taking a page-supplied `tabId`
 * in a flat `{tabId, id, request}` payload, authorized by looking the tab's runtime up by that same id. Once
 * registered, that was exploitable: a plain `browser` tab could name a `browser-node` tab's id and get a CORS-free
 * request issued on the user's session, the exact capability this milestone's defining refusal exists to deny (the
 * reply goes back to the impersonated tab, so it is not exfiltration, but the request itself still happens).
 *
 * The fix removes `tabId` from this module entirely. A `WebFetchRunner` is now created **per `WebRunSession`**
 * (`../runtimes/web-adapter.ts`), which already knows which tab it belongs to and which runtime is driving it --
 * from the `WebviewHost` the connection arrived on, never from anything the message itself claims. `WebRunSession`
 * checks `this.deps.runtime === "browser-node"` before ever constructing or calling into a runner, so a `browser`
 * tab's `fetchRequest` is refused before this file sees it at all -- there is no `tabId` parameter left here for a
 * page to spoof, because identity is now structural (which session's `#onMessage` ran), not data.
 */

export interface ProxiedRequestPayload {
  url: string;
  method: string;
  headers: [string, string][];
  /** base64, or null when the request has no body. The bridge carries JSON only. */
  body: string | null;
}

/** The page-bound half of one reply, scoped to whichever tab constructed this runner -- no `tabId` field needed. */
export interface WebFetchSend {
  head(payload: { id: number; status: number; statusText: string; headers: [string, string][]; url: string }): void;
  chunk(payload: { id: number; data: string }): void;
  end(payload: { id: number }): void;
  error(payload: { id: number; message: string }): void;
}

export interface WebFetchRunnerDeps {
  send: WebFetchSend;
  /** Spec section 18: anything recorded about a request is masked here, before it is written or sent anywhere. */
  redact: Redactor;
  log: Log;
  /** Test seam; production always uses the runtime's own `fetch`. */
  fetch?(url: string, init?: RequestInit): Promise<Response>;
}

export interface WebFetchRunner {
  request(id: number, request: ProxiedRequestPayload): void;
  abort(id: number): void;
  /** In-flight requests. A diagnostic seam: an abort (or a session retiring) that didn't release its entry is a leak. */
  pending(): number;
  /** Aborts everything still in flight -- called when the owning session retires, so a run that ends mid-request
   *  never leaves Main still talking to a server on the user's behalf for a page nothing is listening to anymore. */
  abortAll(): void;
}

function isHeaderList(value: unknown): value is [string, string][] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"),
    )
  );
}

/** Defence in depth against a malformed or forged `fetchRequest` envelope -- the page's contribution, even though
 *  it is now correctly tab-scoped, is still untrusted content (`host-bridge.ts` documents the channel as forgeable
 *  by the page it belongs to). Not a security boundary by itself, just a refusal instead of a crash or a hang. */
function isProxiedRequest(value: unknown): value is ProxiedRequestPayload {
  if (typeof value !== "object" || value === null) return false;
  const { url, method, headers, body } = value as Record<string, unknown>;
  if (typeof url !== "string" || url.length === 0) return false;
  if (typeof method !== "string" || method.length === 0) return false;
  if (!isHeaderList(headers)) return false;
  return body === null || typeof body === "string";
}

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

/** Builds one tab's `browser-node` fetch runner. Construct one per `WebRunSession`, only once its `deps.runtime`
 *  is already known to be `"browser-node"` -- this module trusts the caller for that; it does no authorization of
 *  its own, because it no longer has an identity to check one against. */
export function createWebFetchRunner(deps: WebFetchRunnerDeps): WebFetchRunner {
  const inflight = new Map<number, AbortController>();
  const doFetch: NonNullable<WebFetchRunnerDeps["fetch"]> = deps.fetch ?? ((url, init) => fetch(url, init));

  /** Answers a routable request that will not be served, so it surfaces as a failure instead of a hang. */
  function refuse(id: number, reason: string): void {
    const text = deps.redact(reason);
    deps.log("Web fetch refused", text);
    deps.send.error({ id, message: text });
  }

  async function run(id: number, requestPayload: ProxiedRequestPayload): Promise<void> {
    if (!isProxiedRequest(requestPayload)) {
      refuse(id, "Malformed fetch request envelope.");
      return;
    }
    const request = requestPayload;

    // Defence in depth. The page refuses these before sending; if one arrives anyway it is answered, never
    // dropped. A `file:` url stays refused: it would make this bridge an unrestricted file reader for page code,
    // which is a different capability from "fetch without CORS".
    const scheme = schemeOf(request.url);
    if (scheme === null || (scheme !== "http:" && scheme !== "https:")) {
      refuse(id, `Cannot fetch ${request.url}: only http and https are routed through JSLab.`);
      return;
    }

    // ids are proxy-generated and monotonic, so a repeat means a misbehaving page or relay. Refusing the
    // newcomer keeps the request already in flight abortable, rather than silently orphaning it.
    if (inflight.has(id)) {
      refuse(id, `Ignored a repeated request id; the request already in flight continues.`);
      return;
    }

    const controller = new AbortController();
    inflight.set(id, controller);
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
        id,
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()) as [string, string][],
        url: response.url,
      });
      const body = response.body;
      if (!body) {
        inflight.delete(id);
        deps.send.end({ id });
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
          deps.send.chunk({ id, data: Buffer.from(value).toString("base64") });
        }
      }
      inflight.delete(id);
      deps.send.end({ id });
    } catch (error) {
      if (controller.signal.aborted) return;
      inflight.delete(id);
      // Masked before it crosses back to the page, not after: the failure text can quote the request (a url with
      // credentials in it, an authorization header) and this is the boundary.
      const text = deps.redact(error instanceof Error ? error.message : String(error));
      deps.log("Web fetch failed", text);
      deps.send.error({ id, message: text });
    }
  }

  return {
    request(id, request) {
      void run(id, request);
    },
    abort(id) {
      const controller = inflight.get(id);
      if (!controller) return;
      // Release first, then cancel: the in-flight entry is gone whatever the abort does to the request in
      // progress, so an aborted request can never leave a handle behind.
      inflight.delete(id);
      controller.abort();
    },
    pending: () => inflight.size,
    abortAll() {
      const controllers = [...inflight.values()];
      inflight.clear();
      for (const controller of controllers) controller.abort();
    },
  };
}
