// A stand-in runner that finishes its run, then exits instead of answering an expand request, like a runner that
// crashed or was killed while an expansion was in flight.
import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);

process.on("disconnect", () => process.exit(0));
process.on("message", (message: MainToRunner) => {
  if (message.type === "run") {
    send({ type: "state", runId: message.runId, state: "evaluating", activeHandles: 0 });
    send({ type: "state", runId: message.runId, state: "idle", activeHandles: 0 });
  }
  if (message.type === "expand") process.exit(0);
});

setInterval(() => send({ type: "heartbeat" }), 50);
send({ type: "ready", bunVersion: Bun.version });
