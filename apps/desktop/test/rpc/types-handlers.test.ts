import { describe, expect, mock, test } from "bun:test";
import { createTypesHandlers } from "../../src/main/rpc/types-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

describe("types handlers (spec §6.2)", () => {
  test("validates package and local type requests and delegates", async () => {
    const types = {
      packages: mock(async (_tabId: string, names: readonly string[]) =>
        names.map((name) => ({
          name,
          files: [],
          dependencies: [],
          typesPackage: null,
          hasTypes: false,
          truncated: false,
        })),
      ),
      local: mock(async () => ({ files: [], packages: [], truncated: false })),
    };
    const handlers = createTypesHandlers({ types, log: () => {} });
    expect(
      (await handlers.requests["types.package"]({ tabId: "t1", packages: ["zod"] })).packages.map((p) => p.name),
    ).toEqual(["zod"]);
    expect(await handlers.requests["types.local"]({ tabId: "t1", specifiers: ["./util"] })).toEqual({
      files: [],
      packages: [],
      truncated: false,
    });
    expect(() => handlers.requests["types.local"]({ tabId: "t1", specifiers: ["/etc/passwd"] })).toThrow(
      InvalidPayloadError,
    );
    expect(types.local).toHaveBeenCalledTimes(1);
  });
});
