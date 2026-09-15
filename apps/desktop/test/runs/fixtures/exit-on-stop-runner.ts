// A stand-in runner whose user code ends with a clean process.exit(0) while Stop is in progress: it starts a run,
// and exits on "stop" without confirming the stopped state. Main must still report the run as stopped (FA-m3).
import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);

process.on("disconnect", () => process.exit(0));
process.on("message", (message: MainToRunner) => {
  if (message.type === "run") send({ type: "state", runId: message.runId, state: "evaluating", activeHandles: 1 });
  if (message.type === "stop") process.exit(0);
});

setInterval(() => send({ type: "heartbeat" }), 50);
send({ type: "ready", bunVersion: Bun.version });
