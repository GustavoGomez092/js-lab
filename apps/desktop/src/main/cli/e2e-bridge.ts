import type { E2ERequest, E2EResponse, E2EUiMethod } from "@jslab/rpc-schema";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Correlates Main → UI `e2e.request` messages with the UI's `e2e.response` messages. */
export class E2EBridge {
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();

  constructor(
    private readonly send: (request: E2ERequest) => void,
    private readonly timeoutMs = 15_000,
  ) {}

  request(method: E2EUiMethod, params: unknown): Promise<unknown> {
    const reqId = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(reqId);
        reject(new Error(`UI did not answer ${method} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.#pending.set(reqId, { resolve, reject, timer });
      try {
        this.send({ reqId, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(reqId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  receive(response: E2EResponse): void {
    const pending = this.#pending.get(response.reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(response.reqId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error ?? "The UI reported an error"));
  }

  rejectAll(reason: string): void {
    for (const [reqId, pending] of this.#pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(reqId);
      pending.reject(new Error(reason));
    }
  }
}
