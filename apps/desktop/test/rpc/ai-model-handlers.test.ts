import { describe, expect, test } from "bun:test";
import type { AiModelList } from "@jslab/rpc-schema";
import { createAiModelHandlers } from "../../src/main/rpc/ai-model-handlers";

/**
 * `ai.models.list` (TL-23). The service's own behaviour -- coalescing, caching, backoff -- is pinned in
 * `test/ai/model-list.test.ts`; what these prove is that the request reaches it with the payload intact, and
 * that an invalid payload never reaches it at all.
 */
describe("ai.models.list (TL-23)", () => {
  test("delegates to the service, carrying the provider and the Refresh flag through", async () => {
    const seen: { provider: string; refresh: boolean }[] = [];
    const handlers = createAiModelHandlers({
      models: {
        list: async (provider, refresh) => {
          seen.push({ provider, refresh });
          return { models: ["llama3.2:3b"], error: null, detail: "" };
        },
      },
      log: () => {},
    });

    expect(await handlers.requests["ai.models.list"]({ provider: "ollama", refresh: true })).toEqual({
      models: ["llama3.2:3b"],
      error: null,
      detail: "",
    });
    // The Refresh flag is the whole point of the control: a handler that dropped it would still look healthy.
    expect(seen).toEqual([{ provider: "ollama", refresh: true }]);
  });

  test("a failure the service reports as data is passed through, not turned into a rejection", async () => {
    const failure: AiModelList = { models: null, error: "network", detail: "connect ECONNREFUSED" };
    const handlers = createAiModelHandlers({ models: { list: async () => failure }, log: () => {} });

    expect(await handlers.requests["ai.models.list"]({ provider: "ollama", refresh: false })).toEqual(failure);
  });

  test("an invalid payload is refused before the service is reached (spec §18)", () => {
    const logged: string[] = [];
    let reached = false;
    const handlers = createAiModelHandlers({
      models: {
        list: async () => {
          reached = true;
          return { models: null, error: null, detail: "" };
        },
      },
      log: (message) => logged.push(message),
    });

    // `refresh` missing entirely: the shape the schema exists to catch.
    expect(() => handlers.requests["ai.models.list"]({ provider: "ollama" })).toThrow(
      "Invalid payload for ai.models.list",
    );
    expect(reached).toBe(false);
    expect(logged).toContain("Rejected invalid ai.models.list payload");
  });
});
