// A stand-in runner that confirms Stop but keeps streaming events afterwards, like a runner whose user code
// resumed after Stop. Main must not forward those events.
import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);
let seq = 0;

process.on("disconnect", () => process.exit(0));
process.on("message", (message: MainToRunner) => {
  if (message.type === "run") {
    const { runId } = message;
    send({ type: "state", runId, state: "evaluating", activeHandles: 1 });
    setInterval(
      () => send({ type: "events", runId, events: [{ kind: "stdout", text: "tick\n", seq: ++seq, t: Date.now() }] }),
      20,
    );
    process.on("message", (next: MainToRunner) => {
      if (next.type === "stop") send({ type: "state", runId, state: "stopped", activeHandles: 0 });
    });
  }
});

setInterval(() => send({ type: "heartbeat" }), 50);
send({ type: "ready", bunVersion: Bun.version });
