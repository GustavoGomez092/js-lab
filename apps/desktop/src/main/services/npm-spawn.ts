import { lastLineBreakEnd, MAX_NPM_LOG_CHARS, maskCredentials } from "@jslab/npm";

export interface NpmSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface NpmSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  onOutput(text: string): void;
}

/** Runs one npm operation step: argv excludes the Bun binary. */
export type NpmSpawn = (argv: readonly string[], options: NpmSpawnOptions) => Promise<NpmSpawnResult>;

const MAX_CAPTURED_CHARS = 256 * 1024;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

/**
 * Caps `text` to the last `MAX_CAPTURED_CHARS` characters. Fix round 1 (M-6): a slice can start mid-surrogate-pair;
 * drop a leading lone low surrogate rather than keep a broken character.
 */
function trimCapture(text: string): string {
  if (text.length <= MAX_CAPTURED_CHARS) return text;
  const sliced = text.slice(-MAX_CAPTURED_CHARS);
  const first = sliced.charCodeAt(0);
  return first >= LOW_SURROGATE_START && first <= LOW_SURROGATE_END ? sliced.slice(1) : sliced;
}

export interface LineMasker {
  /** Buffers decoded text; emits every complete line (through the last `\n` or `\r`), masked. */
  push(text: string): void;
  /** Flushes the unterminated remainder, masked. */
  end(): void;
  /** Everything emitted so far (masked), capped to the last 256 KB. */
  readonly text: string;
}

/**
 * R-M3-T26-FIX-3: one stream's line buffer. A pipe read can end anywhere (inside a credential), and stdout and
 * stderr interleave, so only complete lines of a single stream are masked and emitted; the remainder waits for the
 * rest of its line. A remainder past MAX_NPM_LOG_CHARS with no line break is masked whole and emitted (accepted: a
 * credential is split only by a single line longer than 64,000 characters, and the UI drawer keeps only the newest
 * 64,000 characters anyway).
 */
export function createLineMasker(onOutput: (text: string) => void): LineMasker {
  let pending = "";
  let captured = "";
  const emit = (raw: string) => {
    const masked = maskCredentials(raw);
    if (!masked) return;
    onOutput(masked);
    captured = trimCapture(captured + masked);
  };
  return {
    push(text) {
      if (!text) return;
      // `pending` never holds a line break, so only the new text needs scanning (linear over many small reads).
      const breakEnd = lastLineBreakEnd(text);
      if (breakEnd === -1) {
        pending += text;
      } else {
        emit(pending + text.slice(0, breakEnd));
        pending = text.slice(breakEnd);
      }
      if (pending.length > MAX_NPM_LOG_CHARS) {
        emit(pending);
        pending = "";
      }
    },
    end() {
      if (!pending) return;
      emit(pending);
      pending = "";
    },
    get text() {
      return captured;
    },
  };
}

/**
 * Spawns the bundled Bun (spec §11.3) as its own process group, so an abort (the queue's 5-minute timeout) also stops
 * install scripts. R-M3-T26-FIX-3: each stream is decoded and line-buffered on its own; onOutput receives only
 * masked complete lines (plus each stream's masked remainder at its end), and the returned text is that same masked
 * output, keeping the last 256 KB of each stream, so `classifyNpmFailure`'s `NpmOpError.log` leaves Main masked.
 */
export function createBunSpawn(bunPath: string): NpmSpawn {
  return async (argv, options) => {
    const proc = Bun.spawn([bunPath, ...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const onAbort = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const lines = createLineMasker((text) => options.onOutput(text));
      for await (const chunk of stream) {
        lines.push(decoder.decode(chunk, { stream: true }));
      }
      // Fix round 1 (M-6): flush a trailing partial multi-byte sequence the loop's streaming decode held back.
      lines.push(decoder.decode());
      lines.end();
      return lines.text;
    };
    try {
      const [stdout, stderr, exitCode] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
      return { exitCode, stdout, stderr };
    } finally {
      options.signal.removeEventListener("abort", onAbort);
    }
  };
}
