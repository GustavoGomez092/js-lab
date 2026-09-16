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
  /** Uninstalls the inbound hook. No more host messages are delivered after this. */
  dispose(): void;
}

function isHostToWeb(value: unknown): value is HostToWeb {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { seq?: unknown }).seq === "number" &&
    typeof (value as { message?: unknown }).message === "object" &&
    (value as { message?: unknown }).message !== null
  );
}

/**
 * Wires the runner-web ↔ host transport (Task 3; spec's browser/browser-node bridge). Outbound messages go through
 * `window.__electrobunSendToHost`; inbound ones arrive by the host calling the `window.__jslabHostMessage` this
 * installs, through `executeJavascript`. Both directions are JSON values wrapped with a monotonic `seq`: since
 * `executeJavascript` calls have no delivery guarantee of their own, a message whose `seq` doesn't strictly
 * increase (a stale replay, a duplicate, or one delivered out of order) is dropped rather than acted on twice.
 */
export function createHostBridge(
  onMessage: (message: HostToWebMessage) => void,
  g: HostBridgeGlobal = globalThis as unknown as HostBridgeGlobal,
): HostBridge {
  let outboundSeq = 0;
  let lastInboundSeq = 0;

  g.__jslabHostMessage = (raw: unknown) => {
    if (!isHostToWeb(raw)) return;
    if (raw.seq <= lastInboundSeq) return;
    lastInboundSeq = raw.seq;
    onMessage(raw.message);
  };

  return {
    send(message: WebToHostMessage): void {
      outboundSeq += 1;
      const envelope: WebToHost = { seq: outboundSeq, message };
      g.__electrobunSendToHost?.(envelope);
    },
    dispose(): void {
      g.__jslabHostMessage = undefined;
    },
  };
}
