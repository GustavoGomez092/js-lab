import { describe, expect, test } from "bun:test";
import { MAX_CLI_CODE_CHARS, MAX_CLI_LINE_CHARS } from "@jslab/rpc-schema";
import { assertSocketPath, handleLine, LineBuffer, MAX_SOCKET_PATH_BYTES } from "../../src/main/cli/ndjson";

describe("LineBuffer", () => {
  test("splits complete lines, keeps partial lines and skips blank lines", () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"a":1}\n\n{"b"')).toEqual(['{"a":1}']);
    expect(buffer.push(":2}\n")).toEqual(['{"b":2}']);
  });

  test("caps a line at the SHARED MAX_CLI_LINE_CHARS, so the validator and the transport cannot drift", () => {
    // The default is `@jslab/rpc-schema`'s constant, not a second literal that happens to agree today. Pinning the
    // exact boundary here is what makes a change to either side fail rather than silently make `code` unsendable.
    expect(() => new LineBuffer().push("x".repeat(MAX_CLI_LINE_CHARS + 1))).toThrow("Request line too long");
    expect(new LineBuffer().push(`${"x".repeat(MAX_CLI_LINE_CHARS - 1)}\n`)).toHaveLength(1);
    // The reason the code bound is lower: escaping and the `{"v":1,"id":…,"method":…}` envelope both add to the line.
    expect(MAX_CLI_CODE_CHARS).toBeLessThan(MAX_CLI_LINE_CHARS);
  });

  test("a whole oversized line arriving in ONE chunk is capped too, not just the pending remainder", () => {
    // The cap used to be checked only on what was left PENDING after popping completed lines, so a complete line
    // that arrived inside a single chunk passed straight through and a request could exceed it by up to one chunk.
    // `client.ts`'s own guard covers a `jslab` build; nothing else writing to the socket was bounded by this.
    expect(() => new LineBuffer().push(`${"x".repeat(MAX_CLI_LINE_CHARS + 1)}\n`)).toThrow("Request line too long");
    // The boundary itself still gets through, so the cap did not move.
    expect(new LineBuffer().push(`${"x".repeat(MAX_CLI_LINE_CHARS)}\n`)).toHaveLength(1);
  });
});

describe("assertSocketPath", () => {
  test("rejects paths longer than the macOS sun_path limit", () => {
    expect(() => assertSocketPath(`/${"a".repeat(MAX_SOCKET_PATH_BYTES - 1)}`)).not.toThrow();
    expect(() => assertSocketPath(`/${"a".repeat(MAX_SOCKET_PATH_BYTES)}`)).toThrow(/at most 103/);
  });
});

describe("handleLine", () => {
  test("dispatches valid requests and reports every failure as a reply", async () => {
    const methods = {
      "echo.ok": async (params: unknown) => ({ echoed: params, id: "spoofed", ok: false }),
      "echo.fail": async () => {
        throw new Error("boom");
      },
    };
    expect(await handleLine('{"v":1,"id":"1","method":"echo.ok","params":{"x":1}}', methods)).toEqual({
      echoed: { x: 1 },
      id: "1",
      ok: true,
    });
    expect(await handleLine('{"v":1,"id":"2","method":"echo.fail"}', methods)).toEqual({
      id: "2",
      ok: false,
      error: "boom",
    });
    expect(await handleLine('{"v":1,"id":"3","method":"nope"}', methods)).toEqual({
      id: "3",
      ok: false,
      error: "Unknown method: nope",
    });
    expect(await handleLine('{"v":2,"id":"4","method":"echo.ok"}', methods)).toEqual({
      id: "4",
      ok: false,
      error: "Invalid request",
    });
    expect(await handleLine("{not json", methods)).toEqual({ id: null, ok: false, error: "Invalid JSON" });
    expect(await handleLine('{"v":1,"id":"5","method":"toString"}', methods)).toMatchObject({ ok: false });
  });
});
