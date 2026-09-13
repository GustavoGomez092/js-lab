import { useEffect, useState } from "react";
import { probeLib } from "@spike/probe-lib";
import { rpc } from "./rpc";
import { MonacoProbe } from "./MonacoProbe";
import { WebviewProbe } from "./WebviewProbe";
import { ThroughputProbe } from "./ThroughputProbe";

export default function App() {
  const [probes, setProbes] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    rpc.send.viewReport({ section: "S1-view", data: { probeLib: probeLib("view") } });
    void rpc.request.probes({}).then(setProbes);
  }, []);

  useEffect(() => {
    // S6 automated probe (ruling R1), gated behind JSLAB_SPIKE_S6=1 (follow-up
    // controller ruling): trigger the osascript Save dialog once on launch,
    // with no human click, and keep sending RPC messages while it is open, so
    // an external observer can confirm from the committed report that the app
    // stayed responsive rather than blocking on the dialog. Without the env
    // var (normal launches, S7/S8 runs), `probes.s6Enabled` is false and this
    // effect does nothing — no dialog pops up on screen. A separate
    // "Save As..." button below covers the manual pass-criteria checks (choose
    // a path / cancel / a name with quotes) that still need a human click, and
    // is unaffected by this gate.
    if (!probes?.s6Enabled) return;

    const openedAt = Date.now();
    rpc.send.viewReport({ section: "S6-dialog-opened", data: { at: openedAt } });
    rpc.send.saveDialog({ defaultName: "scratch.ts" });

    let seq = 0;
    const heartbeat = setInterval(() => {
      seq += 1;
      rpc.send.viewReport({ section: "S6-heartbeat", data: { seq, at: Date.now() } });
    }, 500);
    const stopHeartbeat = setTimeout(() => clearInterval(heartbeat), 5000);
    return () => {
      clearInterval(heartbeat);
      clearTimeout(stopHeartbeat);
    };
  }, [probes]);

  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      <h1>JSLab spikes</h1>
      <button onClick={() => rpc.send.saveDialog({ defaultName: "scratch.ts" })}>Save As...</button>
      <pre>{JSON.stringify(probes, null, 2)}</pre>
      <MonacoProbe />
      <WebviewProbe />
      <ThroughputProbe autoRun={!!probes?.s7Enabled} />
    </main>
  );
}
