import { useEffect, useState } from "react";
import { probeLib } from "@spike/probe-lib";
import { rpc } from "./rpc";

export default function App() {
  const [probes, setProbes] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    rpc.send.viewReport({ section: "S1-view", data: { probeLib: probeLib("view") } });
    void rpc.request.probes({}).then(setProbes);
  }, []);
  return (
    <main style={{ fontFamily: "monospace", padding: 16 }}>
      <h1>JSLab spikes</h1>
      <pre>{JSON.stringify(probes, null, 2)}</pre>
    </main>
  );
}
