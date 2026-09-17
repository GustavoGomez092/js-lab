// A stand-in runner that answers an expand request by reporting the offset it was actually asked for (OU-02), so
// `RunCoordinator.expand`'s own forwarding hop can be pinned without building a collection large enough to page.
import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);

process.on("disconnect", () => process.exit(0));
process.on("message", (message: MainToRunner) => {
  if (message.type === "run") {
    send({ type: "state", runId: message.runId, state: "evaluating", activeHandles: 0 });
    send({ type: "state", runId: message.runId, state: "idle", activeHandles: 0 });
  }
  if (message.type === "expand") {
    // `-1` for an absent offset, so "no offset arrived" and "offset 0 arrived" stay distinguishable: a hop that
    // drops the field and one that forwards a genuine 0 would otherwise look identical.
    send({ type: "expanded", reqId: message.reqId, value: { t: "number", v: String(message.offset ?? -1) } });
  }
});

setInterval(() => send({ type: "heartbeat" }), 50);
send({ type: "ready", bunVersion: Bun.version });
