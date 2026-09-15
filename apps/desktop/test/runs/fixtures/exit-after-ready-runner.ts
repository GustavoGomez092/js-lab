// A stand-in runner that reports ready and then exits on its own shortly afterwards, like a runner that crashed or
// whose user code called process.exit(). Used to check that nothing signals its (possibly reused) pid afterwards.
import type { RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);

send({ type: "ready", bunVersion: Bun.version });
setTimeout(() => process.exit(0), 50);
