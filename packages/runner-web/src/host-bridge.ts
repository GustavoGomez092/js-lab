import type { HostToWeb, HostToWebMessage, WebToHost, WebToHostMessage } from "@jslab/rpc-schema";

/**
 * The two globals the transport touches. The host provides `__electrobunSendToHost` before this bootstrap ever
 * runs; `__jslabHostMessage` is installed here for the host to call through `executeJavascript`. The inbound
 * payload crosses a JSON-only boundary untyped, so it is validated by `isHostToWeb` before use.
 */
export interface HostBridgeGlobal {
  __electrobunSendToHost?: (value: unknown) => void;
  __jslabHostMessage?: (message: unknown) => void;
}

export interface HostBridge {
  /** Wraps `message` with the next outbound sequence number and hands it to the host. */
  send(message: WebToHostMessage): void;
  /**
   * Stops acting on inbound host messages. The `__jslabHostMessage` hook itself stays installed and non-
   * configurable (fix round 2, NEW-1) — it can't be removed — but anything delivered to it after this is a no-op.
   */
  dispose(): void;
}

function isHostToWeb(value: unknown): value is HostToWeb {
  return (
    typeof value === "object" &&
    value !== null &&
    // A cheap shape check only (fix round 2, NEW-1): whether `seq` is actually the next one due is
    // `createHostBridge`'s job below, since only it holds `lastInboundSeq`. `Number.isSafeInteger` (not just
    // `Number.isInteger`, fix round 1's guard) also rules out a value like `Number.MAX_VALUE`, which has no
    // fractional part but isn't exactly comparable once past 2^53 — the successor check below needs exact
    // integer equality, not just "not NaN/Infinity/fractional".
    Number.isSafeInteger((value as { seq?: unknown }).seq) &&
    (value as { seq: number }).seq > 0 &&
    typeof (value as { message?: unknown }).message === "object" &&
    (value as { message?: unknown }).message !== null
  );
}

/**
 * Wires the runner-web ↔ host transport (Task 3; spec's browser/browser-node bridge). Outbound messages go through
 * `window.__electrobunSendToHost`; inbound ones arrive by the host calling the `window.__jslabHostMessage` this
 * installs, through `executeJavascript`. Both directions are JSON values wrapped with a sequence number starting
 * at 1: the host (Task 7's `WebAdapter`) MUST send strictly consecutive integers with no gaps, since the page
 * accepts an inbound message only when its `seq` is exactly one more than the last one it accepted (see
 * `createHostBridge` below) — any other value, however "reasonable" it looks, is dropped.
 */
export function createHostBridge(
  onMessage: (message: HostToWebMessage) => void,
  g: HostBridgeGlobal = globalThis as unknown as HostBridgeGlobal,
): HostBridge {
  let outboundSeq = 0;
  let lastInboundSeq = 0;
  let disposed = false;

  // Fix round 2, NEW-1: `writable: false, configurable: false` — the same hardening round 1 gave `__jl` — so run
  // code can't reassign this to a function of its own and intercept, or itself call, host traffic with a forged
  // `seq`. (It can still *call* the real one with the correct next number to forge a message; that's inherent to
  // a transport the host must be able to reach through `executeJavascript`, and authenticating it is Task 7's
  // decision, not this bridge's — see the plan.)
  Object.defineProperty(g, "__jslabHostMessage", {
    enumerable: false,
    configurable: false,
    writable: false,
    value: (raw: unknown) => {
      if (disposed || !isHostToWeb(raw)) return;
      // Strict successor, not "greater than" (fix round 2, NEW-1): the previous rule tracked only the highest
      // `seq` ever seen, so any accepted value — including one far larger than anything real, like
      // `Number.MAX_SAFE_INTEGER` — could jump `lastInboundSeq` arbitrarily far ahead, after which every
      // legitimately numbered message compares `seq <= lastInboundSeq` and is silently dropped for the rest of
      // the page's life. Requiring the exact next integer means a rejected message — a replay, a duplicate, a
      // reorder, a gap, or an absurd value — can never move the counter, because only a message that is itself
      // accepted increments it.
      if (raw.seq !== lastInboundSeq + 1) return;
      lastInboundSeq = raw.seq;
      onMessage(raw.message);
    },
  });

  return {
    send(message: WebToHostMessage): void {
      outboundSeq += 1;
      const envelope: WebToHost = { seq: outboundSeq, message };
      g.__electrobunSendToHost?.(envelope);
    },
    dispose(): void {
      // The hook itself can no longer be removed (it's non-configurable, like `__jl`); disposing just stops it
      // from acting on anything delivered afterward.
      disposed = true;
    },
  };
}
