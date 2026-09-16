// A stand-in runner that starts a run and then goes completely quiet: it reports ready and "evaluating" but never
// sends a single heartbeat. That makes Main's own stamping the only thing that can keep the run from being judged
// unresponsive, which is exactly what the attach-time stamp exists to do.
import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);

process.on("disconnect", () => process.exit(0));
process.on("message", (message: MainToRunner) => {
  if (message.type === "run") send({ type: "state", runId: message.runId, state: "evaluating", activeHandles: 1 });
});

send({ type: "ready", bunVersion: Bun.version });
