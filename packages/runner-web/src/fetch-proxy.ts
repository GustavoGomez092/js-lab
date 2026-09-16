/**
 * The page-side half of `browser-node`'s `fetch` (spec section 5.12).
 *
 * The refusal this module is built around: in the **`browser`** runtime `fetch` is the page's own `fetch`, with CORS
 * enforced -- true browser semantics are the entire point of that runtime, so a cross-origin request a real page
 * would fail must fail here in exactly the same way. `installFetchProxy` therefore does nothing at all for
 * `browser`: it does not wrap the global, and it does not even subscribe to the host transport (proved by the first
 * test in `test/fetch-proxy.test.ts`).
 *
 * In **`browser-node`** the request is routed through Main instead, which is what makes it Node-like (no CORS).
 * `Response` semantics are preserved across that hop: status, statusText, headers, `ok`, and a body that is
 * enqueued chunk by chunk as Main streams it back, never buffered and handed over at the end. An `AbortController`
 * in the page reaches Main as an explicit `abort`, and the pending entry is released on every terminal outcome
 * (end, error or abort) so neither side accumulates a handle per cancelled request.
 *
 * The transport is an interface rather than the host bridge itself: the page's only channel to Main is the
 * `<electrobun-webview>` relay, and wiring this to it is the UI-side tile's job (the same way
 * `apps/desktop/src/main/rpc/web-runner-handlers.ts` validates the Main end of that relay without owning the
 * wiring). Everything below is therefore drivable, and tested, against a fake transport.
 */

/** The two web runtimes. Declared locally rather than imported: runner-web does not depend on `@jslab/shared`. */
export type WebRuntime = "browser" | "browser-node";

/** One page->host request. `body` is base64 because the relay carries JSON only. */
export interface ProxiedRequest {
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
}

/** What Main streams back for one request id. */
export type FetchHostEvent =
  | { type: "head"; id: number; status: number; statusText: string; headers: [string, string][]; url: string }
  | { type: "chunk"; id: number; data: string }
  | { type: "end"; id: number }
  | { type: "error"; id: number; message: string };

export interface FetchTransport {
  /** Hands one request to the host. */
  request(id: number, request: ProxiedRequest): void;
  /** Tells the host to cancel an in-flight request; the host releases its own handle for it. */
  abort(id: number): void;
  /** Subscribes to the host's streamed replies. Returns an unsubscribe function. */
  onEvent(listener: (event: FetchHostEvent) => void): () => void;
}

/** The one global this module touches: a real page, or a fake built for tests. */
export interface FetchProxyGlobal {
  fetch?: (input: unknown, init?: RequestInit) => Promise<Response>;
}

export interface FetchProxyOptions {
  runtime: WebRuntime;
  transport: FetchTransport;
  global?: FetchProxyGlobal;
}

/** Statuses whose `Response` must have a null body; constructing one with a stream throws. */
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The error `fetch` rejects with when its signal aborts (a `DOMException` named "AbortError", as on the platform). */
function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function signalOf(input: unknown, init?: RequestInit): AbortSignal | null {
  if (init?.signal) return init.signal;
  if (typeof Request === "function" && input instanceof Request) return input.signal;
  return null;
}

/** The only schemes Main routes. Everything else is either served by the page itself or refused outright. */
const PROXIED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Served by the page's own `fetch`, never proxied (fix round 1, Q1): neither needs a network or a host, and a
 * `data:` payload is already in the page's memory, so routing them through Main would leave `browser-node` less
 * capable than both runtimes it sits between while withholding nothing.
 */
const NATIVE_SCHEMES = new Set(["data:", "blob:"]);

/**
 * The scheme of what `fetch` was called with, or null when there isn't one that can be determined here.
 *
 * Deliberately a bare `URL` parse rather than `new Request(...)`: constructing a `Request` for a `file:` or `data:`
 * url makes the runtime touch the resource itself, so the scheme has to be decided *before* any normalization or
 * body access happens.
 */
function schemeOf(raw: string): string | null {
  try {
    return new URL(raw).protocol;
  } catch {
    return null;
  }
}

/**
 * Normalizes whatever `fetch` was called with into the JSON-safe shape the relay carries. A real `Request` does the
 * normalizing (absolute url, upper-cased method, lower-cased header names, the `content-type` a `FormData` or
 * `URLSearchParams` body implies), so the host receives the same request the page would have made itself.
 */
async function toProxiedRequest(input: unknown, init?: RequestInit): Promise<ProxiedRequest> {
  // Branched rather than passing a union: `Request`'s constructor is declared as separate overloads for a
  // url and for another `Request`, and a union argument matches neither.
  const request =
    typeof Request === "function" && input instanceof Request
      ? new Request(input, init)
      : new Request(String(input), init);
  const body = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
  return {
    url: request.url,
    method: request.method,
    headers: Array.from(request.headers.entries()) as [string, string][],
    body: body ? encodeBase64(body) : null,
  };
}

/** One request in flight: the promise waiting for its head, and the stream its chunks are enqueued into. */
interface PendingFetch {
  resolve(response: Response): void;
  reject(error: Error): void;
  settled: boolean;
  stream: ReadableStreamDefaultController<Uint8Array> | null;
  release(): void;
}

/**
 * Installs `browser-node`'s proxied `fetch`, or leaves a `browser` page's own `fetch` completely alone. Returns
 * whether it installed anything.
 *
 * Install this **before** `installHandleTracking` (`handles.ts`): that wrapper captures whichever `fetch` the
 * global has at the time, and it is what keeps a run "active" while a request is outstanding and releases the
 * handle when the promise settles -- including the rejection an abort produces here.
 */
export function installFetchProxy(options: FetchProxyOptions): boolean {
  if (options.runtime === "browser") return false;

  const g = options.global ?? (globalThis as unknown as FetchProxyGlobal);
  const { transport } = options;
  // Captured before the global is replaced: `data:`/`blob:` are handed straight back to it.
  const native = g.fetch;
  const nativeFetch = (input: unknown, init?: RequestInit): Promise<Response> =>
    native
      ? native.call(g, input, init)
      : Promise.reject(new TypeError("This page has no fetch of its own to serve a data: or blob: URL with."));
  const pending = new Map<number, PendingFetch>();
  let nextId = 1;

  const finish = (id: number): PendingFetch | undefined => {
    const entry = pending.get(id);
    if (entry) {
      pending.delete(id);
      entry.release();
    }
    return entry;
  };

  transport.onEvent((event) => {
    const entry = pending.get(event.id);
    if (!entry) return;
    switch (event.type) {
      case "head": {
        if (entry.settled) return;
        entry.settled = true;
        if (event.status < 200 || event.status > 599) {
          finish(event.id);
          entry.reject(new TypeError(`The host replied with an unusable status (${event.status}).`));
          return;
        }
        const body = NULL_BODY_STATUS.has(event.status)
          ? null
          : new ReadableStream<Uint8Array>({
              start(controller) {
                entry.stream = controller;
              },
              // The page dropped the body: stop the host-side request rather than draining it into nothing. A
              // body cancelled after the request already finished has nothing left to stop, so it puts no
              // avoidable traffic on the relay (fix round 1, nit).
              cancel() {
                if (!pending.has(event.id)) return;
                transport.abort(event.id);
                finish(event.id);
              },
            });
        const response = new Response(body, {
          status: event.status,
          statusText: event.statusText,
          headers: event.headers,
        });
        // `Response`'s constructor cannot set `url`; a real `fetch` result carries the final url, so preserve it.
        Object.defineProperty(response, "url", { value: event.url, configurable: true });
        if (body === null) finish(event.id);
        entry.resolve(response);
        return;
      }
      case "chunk":
        entry.stream?.enqueue(decodeBase64(event.data));
        return;
      case "end":
        finish(event.id);
        entry.stream?.close();
        return;
      case "error": {
        finish(event.id);
        // A failed request is a network error: `fetch` rejects with a TypeError, and a failure that arrives
        // mid-body errors the stream the caller is already reading.
        const error = new TypeError(event.message);
        if (entry.settled) entry.stream?.error(error);
        else entry.reject(error);
        return;
      }
    }
  });

  g.fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const signal = signalOf(input, init);
    if (signal?.aborted) throw abortError();

    // Fix round 1, F1. The scheme is settled here, before anything is sent, because this is the only layer that
    // can *guarantee* a failure: a payload Main cannot route leaves Main nothing to reply to, and the request
    // would simply never settle. The runner page is served from `views://runner-web/index.html`, so an ordinary
    // `fetch("/api/data")` resolves to `views://runner-web/api/data` and lands here -- it must fail loudly rather
    // than hang. A url with no determinable scheme (a relative one with no base to resolve against) is refused the
    // same way, for the same reason.
    const raw = typeof Request === "function" && input instanceof Request ? input.url : String(input);
    const scheme = schemeOf(raw);
    if (scheme !== null && NATIVE_SCHEMES.has(scheme)) return nativeFetch(input, init);
    if (scheme === null || !PROXIED_SCHEMES.has(scheme)) {
      throw new TypeError(
        `Cannot fetch ${raw}: the "browser-node" runtime routes http and https through JSLab and serves data and blob URLs in the page; no other scheme is supported.`,
      );
    }

    const request = await toProxiedRequest(input, init);
    if (signal?.aborted) throw abortError();

    const id = nextId;
    nextId += 1;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => {
        // Cancel the Main-side request first: the page is done with it either way, and a request Main is still
        // running is exactly the leak this is here to prevent.
        transport.abort(id);
        const entry = finish(id);
        if (!entry) return;
        const error = abortError();
        if (entry.settled) entry.stream?.error(error);
        else entry.reject(error);
      };
      pending.set(id, {
        resolve,
        reject,
        settled: false,
        stream: null,
        release: () => signal?.removeEventListener("abort", onAbort),
      });
      signal?.addEventListener("abort", onAbort);
      transport.request(id, request);
    });
  };

  return true;
}
