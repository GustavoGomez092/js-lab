import type { Socket } from "bun";

interface Reply {
  id: string | null;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface Pending {
  resolve(reply: Reply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class JSLabError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

/** NDJSON client for `jslab.sock` (spec §16.3). */
export class JSLabClient {
  #nextId = 1;
  #buffered = "";
  #closed = false;
  readonly #pending = new Map<string, Pending>();

  private constructor(private readonly socket: Socket<undefined>) {}

  static async connect(path: string): Promise<JSLabClient> {
    let client: JSLabClient | null = null;
    const decoder = new TextDecoder();
    const socket = await Bun.connect<undefined>({
      unix: path,
      socket: {
        data(_socket, data) {
          if (client) client.#receive(decoder.decode(data, { stream: true }));
        },
        close() {
          if (client) client.#failAll(new Error("The JSLab socket closed"));
        },
        error(_socket, error) {
          if (client) client.#failAll(error);
        },
      },
    });
    client = new JSLabClient(socket);
    return client;
  }

  call<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new JSLabError(method, "client is closed"));
    const id = String(this.#nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new JSLabError(method, `no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, {
        timer,
        reject,
        resolve: (reply) =>
          reply.ok ? resolve(reply as unknown as T) : reject(new JSLabError(method, reply.error ?? "failed")),
      });
      this.socket.write(`${JSON.stringify({ v: 1, id, method, params })}\n`);
    });
  }

  close(): void {
    this.#closed = true;
    this.#failAll(new Error("The client was closed"));
    this.socket.end();
  }

  #receive(chunk: string): void {
    this.#buffered += chunk;
    const lines = this.#buffered.split("\n");
    this.#buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const reply = JSON.parse(line) as Reply;
      if (reply.id === null) continue;
      const pending = this.#pending.get(reply.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(reply.id);
      pending.resolve(reply);
    }
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      pending.reject(error);
    }
  }
}
