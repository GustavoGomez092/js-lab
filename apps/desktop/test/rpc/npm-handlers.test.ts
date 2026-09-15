import { describe, expect, mock, test } from "bun:test";
import { createNpmHandlers } from "../../src/main/rpc/npm-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

function setup() {
  const op = { id: "op1", kind: "install", target: "", status: "queued", error: null, notice: null } as const;
  const npm = {
    install: mock((_spec: string) => op),
    remove: mock((_name: string) => op),
    update: mock((_name: string) => op),
    updateAll: mock(() => op),
    list: mock(async (_options: { refreshOutdated: boolean }) => ({
      installed: [],
      outdatedCheckedAt: null,
      outdatedError: null,
      revision: 0,
    })),
    search: mock(async (_query: string) => ({ results: [], error: null })),
  };
  const log = mock((_message: string, _detail?: unknown) => {});
  return { npm, log, handlers: createNpmHandlers({ npm, log }) };
}

describe("npm handlers (spec §11)", () => {
  test("requests validate and delegate", async () => {
    const { handlers, npm } = setup();
    expect(await handlers.requests["npm.list"]({ refreshOutdated: true })).toEqual({
      installed: [],
      outdatedCheckedAt: null,
      outdatedError: null,
      revision: 0,
    });
    expect(npm.list).toHaveBeenCalledWith({ refreshOutdated: true });
    await handlers.requests["npm.search"]({ query: " zod " });
    expect(npm.search).toHaveBeenCalledWith("zod");
    expect(() => handlers.requests["npm.search"]({ query: "" })).toThrow(InvalidPayloadError);
  });

  test("messages validate specs and names, and a flag-like spec never reaches bun", () => {
    const { handlers, npm, log } = setup();
    handlers.messages["npm.install"]({ spec: "zod@4.6.4" });
    handlers.messages["npm.install"]({ spec: "--registry=http://evil" });
    handlers.messages["npm.remove"]({ name: "zod" });
    handlers.messages["npm.update"]({ name: "Zod" });
    handlers.messages["npm.updateAll"]({});
    expect(npm.install.mock.calls).toEqual([["zod@4.6.4"]]);
    expect(npm.remove.mock.calls).toEqual([["zod"]]);
    expect(npm.update).not.toHaveBeenCalled();
    expect(npm.updateAll).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((call) => call[0])).toEqual([
      "Rejected invalid npm.install payload",
      "Rejected invalid npm.update payload",
    ]);
  });
});
