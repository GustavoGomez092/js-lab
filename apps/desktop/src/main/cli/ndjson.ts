import { MAX_CLI_LINE_CHARS } from "@jslab/rpc-schema";
import { z } from "zod";

/** macOS `sun_path` holds 104 bytes including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;

export const socketRequestSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(100),
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
});

export type SocketResponse =
  | ({ id: string | null; ok: true } & Record<string, unknown>)
  | { id: string | null; ok: false; error: string };

export type SocketMethod = (params: unknown) => Promise<Record<string, unknown>>;

export class LineBuffer {
  #pending = "";

  // The bound is `@jslab/rpc-schema`'s, not a second copy of it: `cliOpenParamsSchema` bounds `code` against the
  // same exported pair, so a request the schema accepts is always one this buffer can receive.
  constructor(private readonly maxLineChars = MAX_CLI_LINE_CHARS) {}

  push(chunk: string): string[] {
    this.#pending += chunk;
    const lines = this.#pending.split("\n");
    this.#pending = lines.pop() ?? "";
    if (this.#pending.length > this.maxLineChars) {
      this.#pending = "";
      throw new Error("Request line too long");
    }
    return lines.filter((line) => line.trim().length > 0);
  }
}

export function encodeLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function assertSocketPath(path: string): void {
  const bytes = Buffer.byteLength(path);
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Socket path is ${bytes} bytes; macOS allows at most ${MAX_SOCKET_PATH_BYTES}: ${path}`);
  }
}

/** Parses one request line and runs its method. Never throws: every failure becomes an error reply. */
export async function handleLine(line: string, methods: Record<string, SocketMethod>): Promise<SocketResponse> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { id: null, ok: false, error: "Invalid JSON" };
  }
  const parsed = socketRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const candidate = (raw as { id?: unknown } | null)?.id;
    return { id: typeof candidate === "string" ? candidate : null, ok: false, error: "Invalid request" };
  }
  const { id, method, params } = parsed.data;
  const handler = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (!handler) return { id, ok: false, error: `Unknown method: ${method}` };
  try {
    const result = await handler(params);
    // id and ok are written last so a result can never spoof them.
    return { ...result, id, ok: true };
  } catch (error) {
    return { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
