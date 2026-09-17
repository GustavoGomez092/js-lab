import { describe, expect, test } from "bun:test";
import {
  emptyParamsSchema,
  MAIN_REQUEST_NAMES,
  MAIN_REQUEST_PARAMS_SCHEMAS,
  MAX_TEXT_CHARS,
  type MainRequests,
} from "@jslab/rpc-schema";
import {
  BUFFER_REQUEST_TIME_MS,
  DEFAULT_REQUEST_TIME_MS,
  maxRequestTimeFor,
  REQUEST_PAYLOAD_CLASS,
} from "../src/rpc-timeouts";

/**
 * F1. `rpc.ts` exempted `tab.close` and `file.save` from the 10 s default by hand and missed every other request
 * carrying the same `MAX_TEXT_CHARS` payload class. On timeout the UI promise rejects with "RPC request timed
 * out." and Main is never told, so the work finishes anyway: `app.bootstrap` left the app unopenable behind a
 * Try Again button that re-ran the identical request, and `tab.create` reported failure for a tab that had
 * actually been written to session.json.
 *
 * A test naming only the three known misses would not catch the fourth, so the invariant is structural instead:
 * every request is classified (exhaustively, by type), and the classification is cross-checked against what the
 * schema actually accepts.
 */

/** Large enough that only a `MAX_TEXT_CHARS`-capped field accepts it -- every other string cap here is ≤ 200 kB. */
const BIG = "x".repeat(1_000_000);

/**
 * A payload carrying a 1 MB string in a declared field, or `none` for a request that has no such field. A `none`
 * claim is machine-checked below wherever the schema is `emptyParamsSchema`, so it cannot be used to hide a
 * request that does take params.
 */
type Probe = { kind: "none"; why: string } | { kind: "big"; params: unknown };

const BIG_PAYLOAD_PROBE: Record<keyof MainRequests, Probe> = {
  "app.bootstrap": { kind: "none", why: "no params; its 64 MB payload is in the response" },
  "run.start": {
    kind: "big",
    params: { tabId: "t1", code: BIG, language: "typescript", logpoints: [], reason: "manual", runtime: "bun" },
  },
  "run.expand": { kind: "big", params: { tabId: BIG, runId: crypto.randomUUID(), handleId: "h1" } },
  "tab.create": { kind: "big", params: { content: BIG } },
  "tab.close": { kind: "big", params: { tabId: BIG } },
  "tab.reopen": { kind: "none", why: "no params; the reopened buffer's text is in the response" },
  "settings.get": { kind: "none", why: "no params" },
  "settings.update": { kind: "big", params: { patch: { editor: { fontFamily: BIG } } } },
  "file.save": { kind: "big", params: { tabId: "t1", content: BIG } },
  // Has params, but no string field: the big value here is stripped by zod, which is what the "retained" check
  // below distinguishes from a request that genuinely carries text.
  "npm.list": { kind: "big", params: { refreshOutdated: true, query: BIG } },
  "npm.search": { kind: "big", params: { query: BIG } },
  "types.package": { kind: "big", params: { tabId: "t1", packages: [BIG] } },
  "types.local": { kind: "big", params: { tabId: "t1", specifiers: [`./${BIG}`] } },
  "env.get": { kind: "none", why: "no params" },
  "env.save": { kind: "big", params: { variables: { KEY: BIG } } },
  // Params are a tab id and a flag; the MAX_TEXT_CHARS-class payload is `code` and `source` in the RESPONSE, which
  // no params probe can reveal -- the named list in the last test is what covers it.
  "run.transpiled": { kind: "big", params: { tabId: BIG, hideInstrumentation: false } },
  "snippets.list": { kind: "none", why: "no params; the whole library is in the response" },
  // Accepted but not retained at this size: snippetSchema caps a body at MAX_SNIPPET_BODY_CHARS (20 kB), so a 1 MB
  // body is rejected outright. The library is still buffer-class in aggregate -- MAX_SNIPPETS (2000) entries -- which
  // is a total no per-field probe can express, so this one is classified by the named list below too.
  "snippets.save": { kind: "big", params: { snippets: [{ id: "s1", name: "s", description: "", body: BIG }] } },
  "theme.import": { kind: "none", why: "no params; Main opens its own dialog and the UI never names a path" },
  // Rejected at this size rather than stripped: `path` is an archive entry name capped at 512 chars, so a 1 MB
  // probe cannot parse -- which is the point, this request carries no MAX_TEXT_CHARS-class field.
  "theme.importPick": { kind: "big", params: { token: crypto.randomUUID(), path: BIG } },
};

/** The requests that move `MAX_TEXT_CHARS`-class data, in either direction. */
const BUFFER_REQUESTS = MAIN_REQUEST_NAMES.filter((name) => REQUEST_PAYLOAD_CLASS[name] === "buffer");

describe("per-request RPC timeouts (F1)", () => {
  test("every request Main serves is classified, and only those", () => {
    expect(Object.keys(REQUEST_PAYLOAD_CLASS).sort()).toEqual([...MAIN_REQUEST_NAMES].sort());
  });

  test("a buffer-class request gets the long bound and a small one the default", () => {
    for (const name of MAIN_REQUEST_NAMES) {
      const expected = REQUEST_PAYLOAD_CLASS[name] === "buffer" ? BUFFER_REQUEST_TIME_MS : DEFAULT_REQUEST_TIME_MS;
      expect(maxRequestTimeFor(name)).toBe(expected);
    }
    expect(BUFFER_REQUEST_TIME_MS).toBeGreaterThan(DEFAULT_REQUEST_TIME_MS);
  });

  /**
   * The structural half: derived from the schema, not from a list. Any request whose params admit a 1 MB string
   * admits a 64 MB one (they are all capped at MAX_TEXT_CHARS or at something ≤ 200 kB), so it must get the long
   * bound. A newly added request of that kind fails here without anyone remembering to update this file.
   */
  test("a request whose params accept a MAX_TEXT_CHARS-class payload gets the long bound", () => {
    const accepted: string[] = [];
    for (const name of MAIN_REQUEST_NAMES) {
      const probe = BIG_PAYLOAD_PROBE[name];
      if (probe.kind === "none") {
        // "No params" is only a valid claim when the schema really takes none.
        expect(MAIN_REQUEST_PARAMS_SCHEMAS[name]).toBe(emptyParamsSchema);
        continue;
      }
      const parsed = MAIN_REQUEST_PARAMS_SCHEMAS[name].safeParse(probe.params);
      // Accepted *and retained*. Zod strips unknown keys, so a schema with no text field of its own would
      // otherwise look like it had accepted a 1 MB string that it in fact threw away -- `npm.list` does exactly
      // that. What matters is whether the request can actually carry the payload, not whether it parses.
      if (!parsed.success || !JSON.stringify(parsed.data).includes(BIG)) continue;
      accepted.push(name);
      expect(REQUEST_PAYLOAD_CLASS[name]).toBe("buffer");
      expect(maxRequestTimeFor(name)).toBe(BUFFER_REQUEST_TIME_MS);
    }
    // The cap really is the 64 MB one, and the probe really did discriminate.
    expect(MAX_TEXT_CHARS).toBeGreaterThan(BIG.length);
    expect(accepted.sort()).toEqual(["file.save", "run.start", "tab.create"]);
  });

  /**
   * The response-side carriers, which no params schema can reveal. They are named here, and the completeness test
   * above is what stops a new one from being silently left out of the classification altogether.
   */
  test("the requests that read or write whole buffers all get the long bound", () => {
    expect(BUFFER_REQUESTS.sort()).toEqual([
      "app.bootstrap",
      "file.save",
      "run.start",
      // Response-side: `code` and `source` are each a tab's text run through Babel, so up to two buffers wide.
      "run.transpiled",
      // Response- and request-side: the whole snippet library, up to MAX_SNIPPETS entries of MAX_SNIPPET_BODY_CHARS
      // each, and `snippets.save` additionally does the atomic write plus `.bak` the long bound was written for.
      "snippets.list",
      "snippets.save",
      "tab.close",
      "tab.create",
      "tab.reopen",
    ]);
    for (const name of BUFFER_REQUESTS) expect(maxRequestTimeFor(name)).toBe(BUFFER_REQUEST_TIME_MS);
  });
});
