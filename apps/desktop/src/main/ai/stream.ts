import { AiRequestError } from "./provider";

/**
 * Reading a streaming HTTP response safely.
 *
 * This is the file where the four hard cases of spec §14.3's streaming live, and each is a real failure mode
 * rather than a hypothetical:
 *
 *  1. A CHUNK SPLIT ACROSS A READ BOUNDARY. `POST /api/chat` returns newline-delimited JSON, and a TCP read ends
 *     wherever the network decided -- routinely mid-object, and (because the text is UTF-8) sometimes mid-CHARACTER.
 *     `NdjsonDecoder` holds a carry and uses a streaming `TextDecoder`, so a multi-byte character split across two
 *     reads is reassembled rather than turned into U+FFFD. Parsing eagerly instead is the classic bug here: it
 *     shows up only under load, as sporadic "Unexpected end of JSON input".
 *  2. THE SERVER DYING MID-STREAM. The reader rejects (or simply ends without a terminating object). A stream that
 *     ends early is NOT a completed turn, so `readNdjsonStream` reports it rather than resolving quietly -- the
 *     caller decides, and `ollama.ts` turns it into a `network` error with whatever the connection said.
 *  3. A STREAM THAT NEVER TERMINATES. Two independent bounds, because they fail differently: `stallMs` bounds the
 *     time since the last BYTE (a hung model, a half-open socket -- nothing arrives, forever), and `maxBytes`
 *     bounds the total (a model looping produces bytes steadily and would sail past any stall timeout). Either
 *     one aborts the request rather than merely stopping reading.
 *  4. STOP. The caller's `AbortSignal` is passed to `fetch`, so aborting tears down the HTTP request itself
 *     instead of abandoning a stream that goes on being produced and billed. That is why every bound here aborts
 *     the controller rather than just breaking out of the loop: this is the same discipline
 *     `platform/subprocess-output.ts` records for child processes -- ceasing to read bounds nothing, only ending
 *     the producer does.
 */

/**
 * The most a single NDJSON line may be before it is refused.
 *
 * A line is one JSON object holding one fragment of the reply, which is normally a few hundred bytes. The bound
 * exists because the carry buffer grows until a newline arrives: a provider (or a proxy) that never sends one
 * would otherwise grow Main's heap without limit, and no total cap alone would stop it, since the total cap is
 * only checked between reads.
 */
export const MAX_NDJSON_LINE_BYTES = 1024 * 1024;

/** The default total-response bound. Generous for prose; far below anything that threatens Main. */
export const MAX_AI_STREAM_BYTES = 8 * 1024 * 1024;

/** How long the stream may produce nothing at all before it is treated as hung. */
export const AI_STREAM_STALL_MS = 120_000;

/**
 * Splits a byte stream into complete lines, holding the incomplete tail.
 *
 * `TextDecoder` is used in streaming mode (`{ stream: true }`), which is the half that makes a split multi-byte
 * character survive; the carry string is the half that makes a split JSON object survive.
 */
export class NdjsonDecoder {
  #carry = "";
  #decoder = new TextDecoder("utf-8");

  /** The complete lines in `bytes`, with any partial trailing line held back for the next push. */
  push(bytes: Uint8Array): string[] {
    const text = this.#decoder.decode(bytes, { stream: true });
    return this.#take(text);
  }

  /** Any final line that arrived without a trailing newline. Called once, when the body ends. */
  flush(): string[] {
    const text = this.#decoder.decode();
    const lines = this.#take(text);
    const rest = this.#carry.trim();
    this.#carry = "";
    return rest === "" ? lines : [...lines, rest];
  }

  #take(text: string): string[] {
    this.#carry += text;
    const lines: string[] = [];
    let newline = this.#carry.indexOf("\n");
    while (newline >= 0) {
      const line = this.#carry.slice(0, newline).trim();
      this.#carry = this.#carry.slice(newline + 1);
      if (line !== "") lines.push(line);
      newline = this.#carry.indexOf("\n");
    }
    // Checked AFTER consuming every complete line, so the bound applies to one unterminated line and not to a
    // legitimately fast burst of many small ones.
    if (this.#carry.length > MAX_NDJSON_LINE_BYTES) {
      throw new AiRequestError("tooLarge", `A single response line exceeded ${MAX_NDJSON_LINE_BYTES} bytes`);
    }
    return lines;
  }
}

export interface NdjsonStreamOptions {
  body: ReadableStream<Uint8Array>;
  /** Aborted by this function when a bound is hit, so the HTTP request really ends (see case 3 above). */
  controller: AbortController;
  /**
   * Called for each complete line, in arrival order. Returning `true` ends the stream normally.
   *
   * `boolean | undefined` rather than `boolean | void`: a `void` member of a union claims the value is
   * unusable, while this one is read (`=== true`), so the two disagree about the only thing that matters here.
   */
  onLine(line: string): boolean | undefined;
  maxBytes?: number;
  stallMs?: number;
}

/**
 * Reads `body` to completion, or until `onLine` says the turn is over, or until a bound is hit.
 *
 * Resolves `{ completed: true }` only when `onLine` reported the provider's own end-of-turn. A body that simply
 * ran out resolves `{ completed: false }`, which the caller treats as case 2 -- the distinction is the whole
 * point, because "the socket closed" and "the model finished" are the same event to a naive reader.
 */
export async function readNdjsonStream(options: NdjsonStreamOptions): Promise<{ completed: boolean; bytes: number }> {
  const maxBytes = options.maxBytes ?? MAX_AI_STREAM_BYTES;
  const stallMs = options.stallMs ?? AI_STREAM_STALL_MS;
  const reader = options.body.getReader();
  const decoder = new NdjsonDecoder();
  let bytes = 0;
  let completed = false;

  try {
    while (!completed) {
      let stallTimer: ReturnType<typeof setTimeout> | undefined;
      // The race is what makes a hung stream finite. The timer aborts the controller, which rejects the pending
      // read -- so the loop cannot simply resume, and the request is genuinely torn down.
      const stalled = new Promise<"stalled">((resolve) => {
        stallTimer = setTimeout(() => {
          options.controller.abort();
          resolve("stalled");
        }, stallMs);
      });
      // Derived from the reader rather than named: Main's tsconfig has no DOM lib, so the global
      // `ReadableStreamReadResult` does not exist here even though the stream type itself does.
      let result: Awaited<ReturnType<typeof reader.read>> | "stalled";
      try {
        result = await Promise.race([reader.read(), stalled]);
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
      }
      if (result === "stalled") {
        throw new AiRequestError("stalled", `The provider sent nothing for ${stallMs}ms`);
      }
      if (result.done) break;
      const chunk = result.value;
      if (!chunk) continue;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        options.controller.abort();
        throw new AiRequestError("tooLarge", `The response exceeded ${maxBytes} bytes without ending`);
      }
      for (const line of decoder.push(chunk)) {
        if (options.onLine(line) === true) {
          completed = true;
          break;
        }
      }
    }
    if (!completed) {
      for (const line of decoder.flush()) {
        if (options.onLine(line) === true) {
          completed = true;
          break;
        }
      }
    }
  } finally {
    // Releasing the lock lets the body be cancelled by the abort above; without it a torn-down request can leave
    // the stream locked and un-collectable.
    try {
      reader.releaseLock();
    } catch {
      // Already released, or the stream errored -- either way there is nothing left to release.
    }
    // Stop is not the only way out: a bound above ends the request too, and an unaborted controller would leave
    // the socket open after we have stopped reading it.
    if (!completed) options.controller.abort();
  }
  return { completed, bytes };
}
