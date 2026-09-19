import { describe, expect, test } from "bun:test";
import { AiRequestError } from "../../src/main/ai/provider";
import { MAX_NDJSON_LINE_BYTES, NdjsonDecoder, readNdjsonStream } from "../../src/main/ai/stream";

const encoder = new TextEncoder();

/** A stream that yields exactly the given byte chunks, so a read boundary can be placed anywhere. */
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
}

/** A stream that never produces anything and never closes: the hung-provider case. */
function silentStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start() {} });
}

describe("NdjsonDecoder: a chunk split across a read boundary", () => {
  test("a JSON object split mid-object is reassembled, not parsed as two broken halves", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push(encoder.encode('{"a":'))).toEqual([]);
    expect(decoder.push(encoder.encode("1}\n"))).toEqual(['{"a":1}']);
  });

  test("a multi-byte character split across reads is reassembled rather than becoming U+FFFD", () => {
    const bytes = encoder.encode('{"t":"é"}\n');
    const split = 6; // lands inside the two-byte "é"
    const decoder = new NdjsonDecoder();
    expect(decoder.push(bytes.slice(0, split))).toEqual([]);
    const lines = decoder.push(bytes.slice(split));
    expect(lines).toEqual(['{"t":"é"}']);
    expect(lines[0]).not.toContain("�");
  });

  test("several complete lines in one read all come out, in order, and blanks are dropped", () => {
    const decoder = new NdjsonDecoder();
    expect(decoder.push(encoder.encode("a\n\nb\nc"))).toEqual(["a", "b"]);
    // "c" had no newline, so it is held back until flush -- which is what makes a final unterminated line work.
    expect(decoder.flush()).toEqual(["c"]);
  });

  test("an unterminated line past the cap is refused instead of growing Main's heap forever", () => {
    const decoder = new NdjsonDecoder();
    expect(() => decoder.push(encoder.encode("x".repeat(MAX_NDJSON_LINE_BYTES + 1)))).toThrow(AiRequestError);
  });
});

describe("readNdjsonStream: the four streaming failures (spec §14.3)", () => {
  test("a provider that ends its turn reports completed, with every line delivered in order", async () => {
    const seen: string[] = [];
    const result = await readNdjsonStream({
      body: streamOf(['{"n":1}\n', '{"n":2}\n', '{"done":true}\n', '{"n":"never"}\n']),
      controller: new AbortController(),
      onLine: (line) => {
        seen.push(line);
        return line.includes('"done":true');
      },
    });
    expect(result.completed).toBe(true);
    // Reading stops at the terminator: the line after it is never delivered.
    expect(seen).toEqual(['{"n":1}', '{"n":2}', '{"done":true}']);
  });

  /**
   * The server-death case. A body that simply ran out and a turn the provider finished are the same event to a
   * naive reader, which is exactly how a truncated answer gets shown to the user as though it were whole.
   */
  test("a body that ends without a terminator is NOT reported as completed", async () => {
    const controller = new AbortController();
    const result = await readNdjsonStream({
      body: streamOf(['{"n":1}\n']),
      controller,
      onLine: (line) => line.includes('"done":true'),
    });
    expect(result.completed).toBe(false);
    // And the request is torn down rather than left open after we stopped reading it.
    expect(controller.signal.aborted).toBe(true);
  });

  test("a response that never ends is stopped by the byte cap, and the request is aborted", async () => {
    const controller = new AbortController();
    const chunks = Array.from({ length: 40 }, () => `${"x".repeat(1000)}\n`);
    await expect(
      readNdjsonStream({
        body: streamOf(chunks),
        controller,
        maxBytes: 5_000,
        onLine: () => undefined,
      }),
    ).rejects.toThrow(/exceeded 5000 bytes/);
    expect(controller.signal.aborted).toBe(true);
  });

  test("a provider that stops sending is stopped by the stall timeout, and the request is aborted", async () => {
    const controller = new AbortController();
    await expect(
      readNdjsonStream({
        body: silentStream(),
        controller,
        stallMs: 25,
        onLine: () => undefined,
      }),
    ).rejects.toThrow(/sent nothing for 25ms/);
    expect(controller.signal.aborted).toBe(true);
  });

  test("the byte cap counts the whole response, not one chunk", async () => {
    const controller = new AbortController();
    // Each chunk is well under the cap; only their total exceeds it. A per-chunk check would pass this happily.
    const chunks = Array.from({ length: 10 }, () => `${"y".repeat(100)}\n`);
    await expect(
      readNdjsonStream({ body: streamOf(chunks), controller, maxBytes: 400, onLine: () => undefined }),
    ).rejects.toThrow(AiRequestError);
  });
});
