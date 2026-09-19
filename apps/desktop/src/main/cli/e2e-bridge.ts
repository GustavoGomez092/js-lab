import type { E2ERequest, E2EResponse, E2EUiMethod } from "@jslab/rpc-schema";

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Correlates Main → UI `e2e.request` messages with the UI's `e2e.response` messages.
 *
 * Delivery gate: `send` silently drops a message aimed at a webview whose bundle has not executed yet. There is no
 * message hub in the page to queue it (`apps/ui/src/message-hub.ts` only exists once `createRpcApi()` has run), so
 * nothing ever answers and the request burns its entire timeout. That was not a rare race: measured over six cold
 * launches, the FIRST `e2e.state` after a launch failed 6 times out of 6, each at ~15.00 s, because `jslab.sock` is
 * served ~0.3 s in while the view is still loading several MB of bundle. Retrying whole launches could never help --
 * every roll loses.
 *
 * So a request raised while the view is booting now waits for that view to report in (`viewReady()`) rather than
 * being sent into a void. From `app.bootstrap` onwards the page's hub queues and replays anything React has not
 * subscribed to yet, so the send is safe even though `App.tsx` subscribes later still.
 *
 * The gate starts OPEN, so a bridge nobody gates behaves exactly as it did before.
 */
export class E2EBridge {
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  #canDeliver = true;
  #booted: Promise<void> | null = null;
  #openGate: (() => void) | null = null;

  constructor(
    private readonly send: (request: E2ERequest) => void,
    private readonly timeoutMs = 15_000,
  ) {}

  /** This view is (re)loading and cannot receive messages yet: hold sends until `viewReady()`. */
  viewBooting(): void {
    if (!this.#canDeliver) return;
    this.#canDeliver = false;
    this.#booted = new Promise<void>((resolve) => {
      this.#openGate = resolve;
    });
  }

  /** The view's RPC is live (it has made its first request), so its hub holds whatever it cannot yet handle. */
  viewReady(): void {
    if (this.#canDeliver) return;
    this.#canDeliver = true;
    this.#openGate?.();
    this.#openGate = null;
    this.#booted = null;
  }

  request(method: E2EUiMethod, params: unknown): Promise<unknown> {
    const reqId = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(reqId);
        reject(new Error(`UI did not answer ${method} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.#pending.set(reqId, { resolve, reject, timer });
      const dispatch = () => {
        // The timeout above, or `rejectAll`, may have retired this request while the gate was shut. Without this
        // guard a closed window's request would still go out once some later view booted.
        if (!this.#pending.has(reqId)) return;
        try {
          this.send({ reqId, method, params });
        } catch (error) {
          clearTimeout(timer);
          this.#pending.delete(reqId);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      // Synchronous while the gate is open, so a caller can still observe the send in the same tick.
      if (this.#canDeliver) dispatch();
      else void this.#booted?.then(dispatch);
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
