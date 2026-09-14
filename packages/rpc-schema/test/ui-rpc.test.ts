import { describe, expect, test } from "bun:test";
import {
  bufferChangedSchema,
  e2eResponseSchema,
  runExpandParamsSchema,
  runStartParamsSchema,
  settingsUpdateParamsSchema,
  tabParamsSchema,
  tabPatchSchema,
} from "../src/ui-rpc";

const validStart = {
  tabId: "t1",
  code: "1 + 1",
  language: "typescript" as const,
  logpoints: [2],
  reason: "auto" as const,
};

describe("inbound validators", () => {
  test("accept a valid run.start and strip unknown keys", () => {
    expect(runStartParamsSchema.parse({ ...validStart, extra: true })).toEqual(validStart);
  });

  test("reject bad run.start payloads", () => {
    expect(runStartParamsSchema.safeParse({ ...validStart, tabId: "" }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, language: "python" }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, logpoints: [0] }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, code: "x".repeat(5_000_001) }).success).toBe(false);
  });

  test("tab ids must use the safe id format tabs are created with", () => {
    for (const tabId of [crypto.randomUUID(), "t1", "tab_2-B"]) {
      expect(tabParamsSchema.safeParse({ tabId }).success).toBe(true);
    }
    for (const tabId of ["../..", "..", ".", "a/b", "a\\b", "a b", "t1\u0000", "tab.json", "é", "x".repeat(101)]) {
      expect(tabParamsSchema.safeParse({ tabId }).success).toBe(false);
    }
    expect(runStartParamsSchema.safeParse({ ...validStart, tabId: "../../etc" }).success).toBe(false);
    expect(bufferChangedSchema.safeParse({ tabId: "../t1", content: "" }).success).toBe(false);
  });

  test("run.expand requires a uuid run id and a handle id", () => {
    const runId = crypto.randomUUID();
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId, handleId: "h12" }).success).toBe(true);
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId: "nope", handleId: "h12" }).success).toBe(false);
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId, handleId: "../etc" }).success).toBe(false);
  });

  test("buffer.changed caps content size", () => {
    expect(bufferChangedSchema.safeParse({ tabId: "t1", content: "ok" }).success).toBe(true);
    expect(bufferChangedSchema.safeParse({ tabId: "t1", content: "x".repeat(5_000_001) }).success).toBe(false);
  });

  test("tab.patch accepts partial patches and rejects invalid layouts", () => {
    expect(tabPatchSchema.parse({ tabId: "t1", patch: { title: "x" } })).toEqual({
      tabId: "t1",
      patch: { title: "x" },
    });
    expect(
      tabPatchSchema.safeParse({ tabId: "t1", patch: { layout: { orientation: "diagonal", editorSize: 50 } } }).success,
    ).toBe(false);
  });

  test("e2e.response requires a positive request id and caps error text", () => {
    expect(e2eResponseSchema.safeParse({ reqId: 1, ok: true, result: { any: "thing" } }).success).toBe(true);
    expect(e2eResponseSchema.safeParse({ reqId: 0, ok: true }).success).toBe(false);
    expect(e2eResponseSchema.safeParse({ reqId: 2, ok: false, error: "x".repeat(10_001) }).success).toBe(false);
  });

  test("settings.update accepts scalar patches to known sections only", () => {
    expect(
      settingsUpdateParamsSchema.safeParse({ patch: { editor: { lineWrap: false }, view: { layout: "vertical" } } })
        .success,
    ).toBe(true);
    expect(settingsUpdateParamsSchema.safeParse({ patch: { ai: { provider: "openai" } } }).success).toBe(false);
    expect(settingsUpdateParamsSchema.safeParse({ patch: { editor: { lineWrap: { nested: true } } } }).success).toBe(
      false,
    );
  });
});
