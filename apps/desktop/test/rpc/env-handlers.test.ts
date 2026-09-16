import { describe, expect, mock, test } from "bun:test";
import { createEnvHandlers } from "../../src/main/rpc/env-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

// R-M3-T18-ESC-1: the newline is built, never typed as an escape.
const NL = String.fromCharCode(10);

describe("env handlers (spec §12.1)", () => {
  test("env.get returns the variables and env.save saves valid ones", async () => {
    let variables: Record<string, string> = { A: "1" };
    const env = {
      get variables() {
        return variables;
      },
      save: mock(async (next: Record<string, string>) => {
        variables = next;
        return next;
      }),
    };
    const handlers = createEnvHandlers({ env, log: () => {} });
    expect(handlers.requests["env.get"]({})).toEqual({ variables: { A: "1" } });
    expect(await handlers.requests["env.save"]({ variables: { TOKEN: "s3cr3t" } })).toEqual({ ok: true });
    expect(variables).toEqual({ TOKEN: "s3cr3t" });
  });

  test("invalid keys are rejected before the store, a failed write is reported, and values never reach the log", async () => {
    const logged: string[] = [];
    const env = {
      variables: {},
      save: mock(async () => {
        throw new Error("EACCES: permission denied");
      }),
    };
    const handlers = createEnvHandlers({
      env,
      log: (message, detail) => void logged.push(`${message} ${String(detail)}`),
    });
    expect(() => handlers.requests["env.save"]({ variables: { "1BAD": "hunter2-secret" } })).toThrow(
      InvalidPayloadError,
    );
    expect(env.save).not.toHaveBeenCalled();
    expect(await handlers.requests["env.save"]({ variables: { A: "hunter2-secret" } })).toEqual({
      ok: false,
      error: "EACCES: permission denied",
    });
    expect(logged.join(NL)).not.toContain("hunter2-secret");
  });
});
