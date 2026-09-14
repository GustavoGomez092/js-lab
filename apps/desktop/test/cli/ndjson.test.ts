import { describe, expect, test } from "bun:test";
import { assertSocketPath, handleLine, LineBuffer, MAX_SOCKET_PATH_BYTES } from "../../src/main/cli/ndjson";

describe("LineBuffer", () => {
  test("splits complete lines, keeps partial lines and skips blank lines", () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"a":1}\n\n{"b"')).toEqual(['{"a":1}']);
    expect(buffer.push(":2}\n")).toEqual(['{"b":2}']);
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
