import type { MainRequests } from "@jslab/rpc-schema";

/**
 * What makes one request slow, and therefore how long the UI is willing to wait for it.
 *
 * - `buffer`: the request carries or returns tab text. One tab's text is capped at `MAX_TEXT_CHARS` (64 MB), and
 *   `app.bootstrap` is additionally unbounded in tab count. Main may be doing an atomic write, an fsync and a
 *   `.bak` of that much data, possibly on a slow or network volume; the transport of the payload alone is already
 *   the dominant cost, whatever Main does with it afterwards.
 * - `small`: bounded, small payloads -- ids, settings patches, package names.
 * - `interactive`: the payload is small, but Main cannot reply until a *person* has finished with a native modal
 *   dialog. What has to be outlasted is the user, not the bytes.
 *
 * `interactive` is a third class rather than a reuse of `buffer` (R-DIALOG-TIMEOUT-1). The 60 s bound would in
 * fact be an improvement on 10 s, but `buffer` is a claim about size -- every comment in the table below justifies
 * it with `MAX_TEXT_CHARS` -- and a dialog request moves nothing. Folding the two together would put two unrelated
 * hazards on one axis, so the next reader could no longer tell a wide payload from a patient user, and 60 s would
 * silently become the ceiling on how long someone may browse for a file.
 */
export type RequestPayloadClass = "buffer" | "small" | "interactive";

/** Electrobun's bound for every `small` request on this window's RPC. */
export const DEFAULT_REQUEST_TIME_MS = 10_000;

/**
 * FB-m11: the bound the Settings window already uses (`settings-rpc.ts`), applied here to every `buffer` request.
 * Ten seconds is not enough for a 64 MB atomic write plus fsync plus `.bak`, nor for reading every open tab back.
 */
export const BUFFER_REQUEST_TIME_MS = 60_000;

/**
 * R-DIALOG-TIMEOUT-1: the bound for a request that blocks on a human rather than on I/O.
 *
 * `theme.import` sends no params and returns a colour map, but Main does not answer it until the user has found
 * and chosen a `.vsix` or `.json` in a native file dialog -- scrolling through folders, changing their mind, or
 * leaving to download the theme first. Ten seconds is an ordinary amount of time to spend on that. Ten minutes is
 * picked to be far longer than any plausible browse rather than to be tight, because being *early* is the whole
 * failure: on timeout the UI promise rejects and Main is never told, so Main imports the theme the user picked
 * while the UI reports that the import failed.
 *
 * Finite rather than Electrobun's `Infinity` (`.hutch/devkit/api/shared/rpc.ts` accepts it and then starts no
 * timer at all): a bound that never fires can never leak a pending request, but it can also never release one,
 * and ten minutes already outlasts by a wide margin the only thing this bound exists to survive.
 */
export const INTERACTIVE_REQUEST_TIME_MS = 600_000;

/**
 * The bound each class gets.
 *
 * Exhaustive by type for the same reason `REQUEST_PAYLOAD_CLASS` is: adding a class to `RequestPayloadClass` is a
 * compile error here until it has been given a bound. `maxRequestTimeFor` used to read
 * `=== "buffer" ? BUFFER : DEFAULT`, which would have handed a brand-new class the 10 s default without a word --
 * the same shape of omission as F1, one level up from it.
 */
export const REQUEST_CLASS_TIME_MS: Record<RequestPayloadClass, number> = {
  buffer: BUFFER_REQUEST_TIME_MS,
  small: DEFAULT_REQUEST_TIME_MS,
  interactive: INTERACTIVE_REQUEST_TIME_MS,
};

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
  // Small both ways as a payload: no params at all, and the reply is one converted theme (a colour map) or a
  // `.vsix` chooser list -- never tab text. What bounds it is the person. Main serves it by opening a native file
  // dialog (`createThemeHandlers`'s `openDialog`, main/index.ts) and cannot reply until the user has chosen or
  // cancelled, so at the 10 s default M5d shipped, anyone who browsed for longer than that was told the import
  // failed for a theme Main went on to import anyway -- F1's failure mode exactly, on the duration axis instead
  // of the size one (R-DIALOG-TIMEOUT-1).
  "theme.import": "interactive",
  // NOT interactive: by the time this is sent the file has already been chosen. It is the second half of a
  // multi-theme `.vsix` import and takes `{ token, path }` naming an entry in an archive Main already holds --
  // no dialog opens, and nobody is waited on, so the small-payload default is the right bound.
  "theme.importPick": "small",
};

export function maxRequestTimeFor(method: keyof MainRequests): number {
  return REQUEST_CLASS_TIME_MS[REQUEST_PAYLOAD_CLASS[method]];
}

/**
 * The per-request options object Electrobun's request proxy takes as its second argument. Every request in
 * `rpc.ts` goes through this, so the bound is never decided at the call site.
 */
export function requestOptions(method: keyof MainRequests): { maxRequestTime: number } {
  return { maxRequestTime: maxRequestTimeFor(method) };
}
