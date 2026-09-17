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
  INTERACTIVE_REQUEST_TIME_MS,
  maxRequestTimeFor,
  REQUEST_CLASS_TIME_MS,
  REQUEST_PAYLOAD_CLASS,
  type RequestPayloadClass,
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

/**
 * R-DIALOG-TIMEOUT-1. The requests Main cannot answer until a *person* has finished with a native modal dialog.
 *
 * Named rather than derived, because what makes a request interactive lives in Main's handler -- `theme.import` is
 * served by `createThemeHandlers`'s `openDialog` (apps/desktop/src/main/index.ts) -- and this package cannot import
 * apps/desktop to ask. So the pin below is on the CONSEQUENCE, not the cause: whatever the class ends up being
 * called and whatever number it carries, a request that waits on a human has to outlast a human.
 */
const HUMAN_INPUT_REQUESTS = ["theme.import"] as const satisfies readonly (keyof MainRequests)[];

/**
 * The near-miss: looks like part of a file import, opens nothing. `theme.importPick` is the second half of a
 * multi-theme `.vsix` import and takes `{ token, path }` for an archive entry Main already holds, so the file is
 * chosen before it is ever sent. It must NOT be swept into the interactive class along with its sibling.
 */
const NO_HUMAN_INPUT_REQUESTS = ["theme.importPick"] as const satisfies readonly (keyof MainRequests)[];

describe("per-request RPC timeouts (F1)", () => {
  test("every request Main serves is classified, and only those", () => {
    expect(Object.keys(REQUEST_PAYLOAD_CLASS).sort()).toEqual([...MAIN_REQUEST_NAMES].sort());
  });

  test("every request is bounded by the class it was given, and every class has its own bound", () => {
    // Spelled out per class, not re-derived from `REQUEST_CLASS_TIME_MS`, so a bound that moved has to be moved
    // here too rather than the table silently agreeing with itself.
    expect(REQUEST_CLASS_TIME_MS).toEqual({
      buffer: BUFFER_REQUEST_TIME_MS,
      small: DEFAULT_REQUEST_TIME_MS,
      interactive: INTERACTIVE_REQUEST_TIME_MS,
    });
    for (const name of MAIN_REQUEST_NAMES) {
      expect(maxRequestTimeFor(name)).toBe(REQUEST_CLASS_TIME_MS[REQUEST_PAYLOAD_CLASS[name]]);
    }
    // Each class is a real widening of the one before it; two classes sharing a number would make one of them
    // decorative and let a request be "reclassified" with no effect on what the UI actually waits.
    expect(BUFFER_REQUEST_TIME_MS).toBeGreaterThan(DEFAULT_REQUEST_TIME_MS);
    expect(INTERACTIVE_REQUEST_TIME_MS).toBeGreaterThan(BUFFER_REQUEST_TIME_MS);
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

/**
 * R-DIALOG-TIMEOUT-1. F1 was a request bounded as though it were small when its PAYLOAD was large. `theme.import`
 * was the same bug on the other axis: its payload really is small, so it was classified `small` and inherited the
 * 10 s default, but Main answers it only once the user has picked a file in a native dialog. Ten seconds is an
 * ordinary amount of time to spend finding a `.vsix`, and on timeout the UI promise rejects while Main -- never
 * told -- imports the theme anyway, so the user is told the import failed and then sees it succeed.
 *
 * These assert a floor in human terms rather than the constant's value: restating `INTERACTIVE_REQUEST_TIME_MS`
 * would pass just as happily if the class were deleted and 10 s came back.
 */
describe("requests that block on a human (R-DIALOG-TIMEOUT-1)", () => {
  /** Longer than anyone plausibly spends browsing for a file -- and far above both other classes' bounds. */
  const PLAUSIBLE_BROWSE_MS = 5 * 60_000;

  test("a request that waits on a file dialog outlasts a person browsing for a file", () => {
    for (const name of HUMAN_INPUT_REQUESTS) {
      // Fails at `small` (10 s), which is the bug, and fails at `buffer` (60 s) too: a minute is not a generous
      // amount of time to locate a theme file, and `buffer` would be claiming this request moves 64 MB besides.
      expect(maxRequestTimeFor(name)).toBeGreaterThanOrEqual(PLAUSIBLE_BROWSE_MS);
      expect(maxRequestTimeFor(name)).toBeGreaterThan(DEFAULT_REQUEST_TIME_MS);
    }
    expect(PLAUSIBLE_BROWSE_MS).toBeGreaterThan(BUFFER_REQUEST_TIME_MS);
  });

  test("a request whose file is already chosen keeps the small-payload default", () => {
    for (const name of NO_HUMAN_INPUT_REQUESTS) {
      expect(REQUEST_PAYLOAD_CLASS[name]).toBe("small");
      expect(maxRequestTimeFor(name)).toBe(DEFAULT_REQUEST_TIME_MS);
    }
    // The two halves of one `.vsix` import are deliberately bounded differently: the half with the dialog waits.
    expect(maxRequestTimeFor("theme.import")).toBeGreaterThan(maxRequestTimeFor("theme.importPick"));
  });

  test("no request is left interactive-classified without being declared one here", () => {
    const interactive = MAIN_REQUEST_NAMES.filter((name) => REQUEST_PAYLOAD_CLASS[name] === "interactive");
    expect(interactive.sort()).toEqual([...HUMAN_INPUT_REQUESTS].sort());
  });

  /**
   * Constraint 1: both tables stay exhaustive BY TYPE, so neither a new request nor a new class can ship
   * unclassified. These are compile-time assertions -- `tsc --noEmit -p .` covers `test/` (apps/ui/tsconfig.json
   * includes it), and a `@ts-expect-error` that stops being an error fails the typecheck just as loudly as one
   * that starts being one, so this cannot rot in either direction.
   */
  test("the classification tables are exhaustive by type", () => {
    const withoutARequest: Omit<typeof REQUEST_PAYLOAD_CLASS, "theme.import"> = REQUEST_PAYLOAD_CLASS;
    // @ts-expect-error - a table missing one request must not satisfy the exhaustive Record. That omission is F1.
    const missingRequest: Record<keyof MainRequests, RequestPayloadClass> = withoutARequest;

    // @ts-expect-error - a payload class with no bound of its own must not compile; it would inherit 10 s in silence.
    const missingClass: Record<RequestPayloadClass, number> = {
      buffer: BUFFER_REQUEST_TIME_MS,
      small: DEFAULT_REQUEST_TIME_MS,
    };

    // The runtime halves, so the type-level pins above are not the only thing standing here.
    expect(missingRequest["run.start"]).toBe("buffer");
    expect(missingClass.small).toBe(DEFAULT_REQUEST_TIME_MS);
    expect(Object.keys(REQUEST_CLASS_TIME_MS).sort()).toEqual(["buffer", "interactive", "small"]);
  });
});
