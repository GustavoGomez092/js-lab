// A stand-in runner that answers one run with a single oversized events message (450 events), like an older or
// misbehaving runner that doesn't split its batches. Used to test Main's re-batching (spec §4.2).
import type { MainToRunner, RawRunEvent, RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);

process.on("disconnect", () => process.exit(0));
process.on("message", (message: MainToRunner) => {
  if (message.type !== "run") return;
  const { runId } = message;
  send({ type: "state", runId, state: "evaluating", activeHandles: 0 });
  const events: RawRunEvent[] = Array.from({ length: 450 }, (_, i) => ({
    kind: "stdout",
    text: `${i}\n`,
    seq: i + 1,
    t: Date.now(),
  }));
  send({ type: "events", runId, events });
  send({ type: "state", runId, state: "idle", activeHandles: 0 });
});

setInterval(() => send({ type: "heartbeat" }), 50);
send({ type: "ready", bunVersion: Bun.version });
