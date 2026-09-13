import { useEffect, useRef } from "react";
import { startThroughputProbe } from "./rpc";

// S7: can main->webview RPC carry batched console-event output (16ms/200-event
// batches for M1's run.events channel) without loss, with low latency, and
// without janking the UI? The meter (latencies/gaps/worstFrameMs) lives in
// rpc.ts (see the comment there on why: rpc.setMessageHandlers doesn't exist
// in Electrobun 2.0.1, so the handlers are static in Electroview.defineRPC's
// `messages` object, which needed the state next to it). This component is
// just the trigger: the two buttons for manual re-runs (brief Step 2), plus
// an automated 200/batch-then-1000/batch sequence gated behind
// JSLAB_SPIKE_S7=1 (ruling R1), run once per mount when `autoRun` is true.
export function ThroughputProbe({ autoRun }: { autoRun: boolean }) {
  const startedRef = useRef(false);

  useEffect(() => {
    if (!autoRun || startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      await startThroughputProbe(200, 10);
      await startThroughputProbe(1000, 10);
    })();
  }, [autoRun]);

  return (
    <section>
      <h2>Throughput probe (S7)</h2>
      <button type="button" onClick={() => void startThroughputProbe(200, 10)}>
        Throughput 200/batch
      </button>
      <button type="button" onClick={() => void startThroughputProbe(1000, 10)}>
        Throughput 1000/batch
      </button>
    </section>
  );
}
