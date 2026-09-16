// A stand-in runner whose user code called process.exit but never lets the process exit (a caught exit followed by
// code that keeps the runner alive). Main must end it after the exit grace period and report the requested code.
import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);

process.on("message", (message: MainToRunner) => {
  if (message.type !== "run") return;
  send({ type: "state", runId: message.runId, state: "evaluating", activeHandles: 0 });
  send({ type: "exitRequested", runId: message.runId, code: 0 });
  send({
    type: "events",
    runId: message.runId,
    events: [{ kind: "stdout", text: "ignored after exit", seq: 1, t: Date.now() }],
  });
});
send({ type: "ready", bunVersion: Bun.version });
setInterval(() => send({ type: "heartbeat" }), 50);
