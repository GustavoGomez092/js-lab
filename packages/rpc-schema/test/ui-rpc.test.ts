import { describe, expect, test } from "bun:test";
import {
  appCommandSchema,
  appNoticeSchema,
  bufferChangedSchema,
  e2eResponseSchema,
  fileConfirmLargeSchema,
  fileConfirmSaveAsSchema,
  fileSaveParamsSchema,
  MAX_OPEN_FILE_BYTES,
  MAX_TEXT_CHARS,
  runExpandParamsSchema,
  runStartParamsSchema,
  settingsAppCommandSchema,
  settingsUpdateParamsSchema,
  tabCreateParamsSchema,
  tabParamsSchema,
  tabPatchSchema,
  tabReorderSchema,
  tabViewStateSchema,
} from "../src/ui-rpc";

const validStart = {
  tabId: "t1",
  code: "1 + 1",
  language: "typescript" as const,
  logpoints: [2],
  reason: "auto" as const,
  runtime: "bun" as const,
};

describe("inbound validators", () => {
  test("accept a valid run.start and strip unknown keys", () => {
    expect(runStartParamsSchema.parse({ ...validStart, extra: true })).toEqual(validStart);
  });

  test("reject bad run.start payloads", () => {
    expect(runStartParamsSchema.safeParse({ ...validStart, tabId: "" }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, language: "python" }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, logpoints: [0] }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, code: "x".repeat(MAX_TEXT_CHARS + 1) }).success).toBe(false);
  });

  test("run.start carries the tab's runtime", () => {
    const parsed = runStartParamsSchema.parse({
      tabId: "t1",
      code: "1",
      language: "typescript",
      logpoints: [],
      reason: "manual",
      runtime: "browser",
    });
    expect(parsed.runtime).toBe("browser");
  });

  test("run.start defaults an unknown runtime to bun rather than throwing", () => {
    const parsed = runStartParamsSchema.parse({
      tabId: "t1",
      code: "1",
      language: "typescript",
      logpoints: [],
      reason: "manual",
      runtime: "nope",
    });
    expect(parsed.runtime).toBe("bun");
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
    expect(bufferChangedSchema.safeParse({ tabId: "t1", content: "x".repeat(MAX_TEXT_CHARS + 1) }).success).toBe(false);
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

  test("settings.update accepts at most 64 keys per section (FA-m7)", () => {
    const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`key${i}`, true]));
    expect(settingsUpdateParamsSchema.safeParse({ patch: { editor: keys(64), view: keys(64) } }).success).toBe(true);
    expect(settingsUpdateParamsSchema.safeParse({ patch: { editor: keys(65) } }).success).toBe(false);
  });

  test("workspace payloads: tab.create, widened tab.patch, tab.reorder, size-capped view state and one text cap", () => {
    expect(MAX_TEXT_CHARS).toBeGreaterThan(MAX_OPEN_FILE_BYTES);
    const large = "x".repeat(6 * 1024 * 1024);
    const tooLarge = "x".repeat(MAX_TEXT_CHARS + 1);
    const run = { tabId: "t", language: "javascript", logpoints: [], reason: "manual" };
    expect(tabCreateParamsSchema.safeParse({ content: large }).success).toBe(true);
    expect(tabCreateParamsSchema.safeParse({ content: tooLarge }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...run, code: large }).success).toBe(true);
    expect(runStartParamsSchema.safeParse({ ...run, code: tooLarge }).success).toBe(false);
    expect(bufferChangedSchema.safeParse({ tabId: "t", content: large }).success).toBe(true);
    expect(tabCreateParamsSchema.parse({ language: "tsx", content: "x", extra: 1 })).toEqual({
      language: "tsx",
      content: "x",
    });
    expect(tabCreateParamsSchema.safeParse({ runtime: "deno" }).success).toBe(false);
    expect(
      tabPatchSchema.safeParse({
        tabId: "t",
        patch: { titleIsCustom: true, runtime: "bun", layout: { outputVisible: false } },
      }).success,
    ).toBe(true);
    expect(tabReorderSchema.safeParse({ tabOrder: [] }).success).toBe(false);
    expect(tabViewStateSchema.safeParse({ tabId: "t", viewState: { a: 1 } }).success).toBe(true);
    expect(tabViewStateSchema.safeParse({ tabId: "t", viewState: "x".repeat(200_001) }).success).toBe(false);
  });

  test("app.command accepts only known actions", () => {
    expect(appCommandSchema.safeParse({ action: "copyDebugLog" }).success).toBe(true);
    expect(appCommandSchema.safeParse({ action: "exec" }).success).toBe(false);
  });

  test("the Settings window's app.command accepts only the Settings actions (FA-m11)", () => {
    for (const action of ["resetSettings", "openDataFolder", "restartSafeMode"]) {
      expect(settingsAppCommandSchema.safeParse({ action }).success).toBe(true);
    }
    for (const action of ["closeWindow", "toggleFullScreen", "openSettings", "copyDebugLog", "exec"]) {
      expect(settingsAppCommandSchema.safeParse({ action }).success).toBe(false);
    }
  });

  test("app.notice carries a known notice id and bounded text (FA-I3)", () => {
    expect(appNoticeSchema.safeParse({ id: "unexpectedError", message: "Something went wrong." }).success).toBe(true);
    expect(appNoticeSchema.safeParse({ id: "exec", message: "x" }).success).toBe(false);
    expect(appNoticeSchema.safeParse({ id: "unexpectedError", message: "x".repeat(2001) }).success).toBe(false);
  });

  test("file payloads cap content and token lists", () => {
    expect(fileSaveParamsSchema.safeParse({ tabId: "t", content: "x" }).success).toBe(true);
    expect(fileSaveParamsSchema.safeParse({ tabId: "t", content: "x".repeat(MAX_TEXT_CHARS + 1) }).success).toBe(false);
    expect(fileConfirmLargeSchema.safeParse({ tokens: Array.from({ length: 101 }, () => "t") }).success).toBe(false);
    expect(fileConfirmSaveAsSchema.safeParse({ token: "t", confirmed: "yes" }).success).toBe(false);
  });
});
