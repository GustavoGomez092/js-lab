import type { MainRequests } from "@jslab/rpc-schema";

/**
 * How much data one request can move, and therefore how long the UI is willing to wait for it.
 *
 * - `buffer`: the request carries or returns tab text. One tab's text is capped at `MAX_TEXT_CHARS` (64 MB), and
 *   `app.bootstrap` is additionally unbounded in tab count. Main may be doing an atomic write, an fsync and a
 *   `.bak` of that much data, possibly on a slow or network volume; the transport of the payload alone is already
 *   the dominant cost, whatever Main does with it afterwards.
 * - `small`: bounded, small payloads -- ids, settings patches, package names.
 */
export type RequestPayloadClass = "buffer" | "small";

/** Electrobun's bound for every `small` request on this window's RPC. */
export const DEFAULT_REQUEST_TIME_MS = 10_000;

/**
 * FB-m11: the bound the Settings window already uses (`settings-rpc.ts`), applied here to every `buffer` request.
 * Ten seconds is not enough for a 64 MB atomic write plus fsync plus `.bak`, nor for reading every open tab back.
 */
export const BUFFER_REQUEST_TIME_MS = 60_000;

/**
 * Exhaustive by type: adding a request to `MainRequests` is a compile error here until it is classified, so a new
 * request that moves buffer-sized data cannot ship on the 10 s default by omission.
 *
 * Omission is exactly what F1 was. `tab.close` and `file.save` were exempted by hand; `app.bootstrap`,
 * `tab.create`, `tab.reopen` and `run.start` carry the same payload class and were missed. On timeout the UI
 * promise rejects and Main is never told, so the work completes anyway -- which is why a missed exemption showed
 * up as "the action failed" on a tab that had in fact been created (Failure B), and as an unopenable app whose
 * only control re-ran the identical failing request (Failure A).
 */
export const REQUEST_PAYLOAD_CLASS: Record<keyof MainRequests, RequestPayloadClass> = {
  // Response carries every open tab's full text: session-store's readBuffers loops the whole tabOrder, and each
  // buffer can be up to MAX_TEXT_CHARS. The largest payload in the protocol, and unbounded in tab count.
  "app.bootstrap": "buffer",
  // `code` is capped at MAX_TEXT_CHARS. Main only starts a run, but the UI still has to ship the whole buffer.
  "run.start": "buffer",
  "run.expand": "small",
  // `content` is capped at MAX_TEXT_CHARS and Main persists it with writeFileAtomic -- the atomic write the
  // original 60 s exemption was written for.
  "tab.create": "buffer",
  // Flushes the tab's buffer writer, renames the buffer file, and may write a replacement tab's buffer.
  "tab.close": "buffer",
  // Reads a closed buffer and atomically writes it back; the reply carries its full text.
  "tab.reopen": "buffer",
  "settings.get": "small",
  "settings.update": "small",
  // `content` is capped at MAX_TEXT_CHARS and Main writes it to the tab's file, with a `.bak`.
  "file.save": "buffer",
  "npm.list": "small",
  "npm.search": "small",
  "types.package": "small",
  "types.local": "small",
  "env.get": "small",
  "env.save": "small",
  // Both `code` and `source` are a tab's text run through Babel, each bounded by MAX_TEXT_CHARS -- so the reply is
  // up to two buffers wide, and the panel asks for it on every run.
  "run.transpiled": "buffer",
  // The whole snippet library, both ways: MAX_SNIPPETS (2000) entries whose bodies alone reach
  // MAX_SNIPPET_BODY_CHARS (20,000) each. That is buffer-class transport however small a typical library is, and
  // `snippets.save` additionally does the atomic write plus `.bak` the 60 s bound was written for (FB-m11).
  // Classified by payload rather than by how long Main is expected to take: a bound that is too short reports a
  // failure for work that in fact completed, which is exactly the F1 failure this table exists to prevent.
  "snippets.list": "buffer",
  "snippets.save": "buffer",
};

export function maxRequestTimeFor(method: keyof MainRequests): number {
  return REQUEST_PAYLOAD_CLASS[method] === "buffer" ? BUFFER_REQUEST_TIME_MS : DEFAULT_REQUEST_TIME_MS;
}

/**
 * The per-request options object Electrobun's request proxy takes as its second argument. Every request in
 * `rpc.ts` goes through this, so the bound is never decided at the call site.
 */
export function requestOptions(method: keyof MainRequests): { maxRequestTime: number } {
  return { maxRequestTime: maxRequestTimeFor(method) };
}
