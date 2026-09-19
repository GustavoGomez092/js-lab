import { describe, expect, mock, test } from "bun:test";
import { MAX_AI_MESSAGE_CHARS } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { explainLineOf, explainPrompt, MAX_EXPLAIN_VALUE_CHARS } from "../src/ai/explain";
import { conversationTurns, persistConversation } from "../src/ai/persist";
import type { DisplayEvent } from "../src/state/output";
import { createAppStore } from "../src/state/store";

const resultRow = (value: unknown, line = 7): DisplayEvent =>
  ({ kind: "result", line, source: "autolog", value, seq: 1, t: 0 }) as unknown as DisplayEvent;

describe("the Explain Result prompt (TL-20, spec §14.2)", () => {
  /**
   * Literal wording, deliberately: written as `strings.ai.explainLine(7)` this would still pass if the
   * catalogue entry were changed to something that is not the sentence the spec names, because the
   * implementation reads that same entry.
   */
  test("names the line and carries the rendered value, as the spec words it", () => {
    const prompt = explainPrompt(resultRow({ t: "string", v: "hello" }));
    expect(prompt).toContain("Explain why line 7 produces this result:");
    expect(prompt).toContain("hello");
  });

  test("a row with no source line of its own asks about the output instead of inventing a line", () => {
    const prompt = explainPrompt({ kind: "stdout", text: "raw output\n", seq: 1, t: 0 } as DisplayEvent);
    expect(prompt).not.toContain("line undefined");
    expect(prompt).toContain("Explain why the code produces this output:");
    expect(prompt).toContain("raw output");
  });

  test("the line is read from the kinds that have one, and only those", () => {
    expect(explainLineOf(resultRow({ t: "number", v: "1" }, 3))).toBe(3);
    expect(explainLineOf({ kind: "stdout", text: "x", seq: 1, t: 0 } as DisplayEvent)).toBeUndefined();
    expect(explainLineOf({ kind: "stderr", text: "x", seq: 1, t: 0 } as DisplayEvent)).toBeUndefined();
  });

  /**
   * The cap is load-bearing rather than cosmetic: `aiSendParamsSchema.prompt` is capped at
   * MAX_AI_MESSAGE_CHARS, and Main's message validator DROPS an over-long payload after logging it -- the
   * panel would sit on an empty assistant turn forever and Explain Result would appear to do nothing.
   */
  test("an enormous value is cut, marked as cut, and still fits what the wire accepts", () => {
    const prompt = explainPrompt(resultRow({ t: "string", v: "x".repeat(MAX_EXPLAIN_VALUE_CHARS * 3) }));
    expect(prompt.length).toBeLessThanOrEqual(MAX_AI_MESSAGE_CHARS);
    expect(prompt.length).toBeLessThan(MAX_EXPLAIN_VALUE_CHARS * 2);
    expect(prompt).toContain("the value was cut to fit this request");
  });

  test("a value that fits is sent whole, with no truncation marker", () => {
    const prompt = explainPrompt(resultRow({ t: "string", v: "short" }));
    expect(prompt).not.toContain("the value was cut to fit this request");
  });
});

function hydrated() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  return store;
}

describe("persisting the conversation (spec §14.3)", () => {
  test("only the durable half of a turn is stored", () => {
    expect(
      conversationTurns([
        { id: "a", role: "user", content: "why?", streaming: false, stopped: false, error: null },
        { id: "b", role: "assistant", content: "cut off", streaming: false, stopped: true, error: null },
      ]),
    ).toEqual([
      { id: "a", role: "user", content: "why?", stopped: false },
      { id: "b", role: "assistant", content: "cut off", stopped: true },
    ]);
  });

  test("a failed turn is dropped, since its error is not stored either", () => {
    const turns = conversationTurns([
      { id: "a", role: "user", content: "why?", streaming: false, stopped: false, error: null },
      {
        id: "b",
        role: "assistant",
        content: "",
        streaming: false,
        stopped: false,
        error: { kind: "network", detail: "x" },
      },
    ]);
    expect(turns.map((item) => item.id)).toEqual(["a"]);
  });

  test("saves once the reply has settled, and sends the whole transcript", () => {
    const store = hydrated();
    const save = mock((_messages: unknown[]) => {});
    const stop = persistConversation(store, { aiSaveConversation: save });

    const requestId = "11111111-1111-4111-8111-111111111111";
    store.getState().aiStartRequest(requestId, "why?");
    store.getState().aiAppendChunk(requestId, "because");
    // Still streaming: nothing may be written yet, or a long reply rewrites the file once per chunk.
    expect(save).toHaveBeenCalledTimes(0);

    store.getState().aiFinishRequest(requestId, false);
    expect(save).toHaveBeenCalledTimes(1);
    // The exact records, not just their text: the ids are derived from the request id, so a turn that lost its
    // identity or its interrupted flag on the way to disk is visible here.
    expect(save.mock.calls[0]?.[0]).toEqual([
      { id: `${requestId}-user`, role: "user", content: "why?", stopped: false },
      { id: requestId, role: "assistant", content: "because", stopped: false },
    ]);
    stop();
  });

  test("New Chat is persisted too, so a cleared conversation does not come back", () => {
    const store = hydrated();
    const save = mock((_messages: unknown[]) => {});
    const stop = persistConversation(store, { aiSaveConversation: save });

    store.getState().aiStartRequest("22222222-2222-4222-8222-222222222222", "why?");
    store.getState().aiFinishRequest("22222222-2222-4222-8222-222222222222", false);
    save.mockClear();

    store.getState().aiNewChat();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual([]);
    stop();
  });

  test("store changes that leave the conversation alone schedule no write at all", () => {
    const store = hydrated();
    const save = mock((_messages: unknown[]) => {});
    const stop = persistConversation(store, { aiSaveConversation: save });

    store.getState().setSideBarPanel("ai");
    store.getState().editCode("const a = 2;");
    store.getState().setHoveredLine(4);
    expect(save).toHaveBeenCalledTimes(0);
    stop();
  });

  test("a conversation restored at launch is not written straight back out", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
      conversation: [{ id: "a", role: "user", content: "from last launch", stopped: false }],
    });
    const save = mock((_messages: unknown[]) => {});
    const stop = persistConversation(store, { aiSaveConversation: save });

    store.getState().setHoveredLine(2);
    expect(save).toHaveBeenCalledTimes(0);
    stop();
  });

  test("unsubscribing really stops the writes", () => {
    const store = hydrated();
    const save = mock((_messages: unknown[]) => {});
    persistConversation(store, { aiSaveConversation: save })();

    store.getState().aiStartRequest("33333333-3333-4333-8333-333333333333", "why?");
    store.getState().aiFinishRequest("33333333-3333-4333-8333-333333333333", false);
    expect(save).toHaveBeenCalledTimes(0);
  });
});

describe("restoring the conversation into the store (spec §14.3)", () => {
  test("a restored turn is settled, keeps its interrupted flag, and offers no stale Retry", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
      conversation: [
        { id: "a", role: "user", content: "why?", stopped: false },
        { id: "b", role: "assistant", content: "half an answer", stopped: true },
      ],
    });
    const chat = store.getState().aiChat;
    expect(chat.messages.map((message) => message.content)).toEqual(["why?", "half an answer"]);
    expect(chat.messages.every((message) => message.streaming === false)).toBe(true);
    expect(chat.messages.every((message) => message.error === null)).toBe(true);
    expect(chat.messages[1]?.stopped).toBe(true);
    // Nothing is in flight after a relaunch, and Retry has no prompt to resend.
    expect(chat.requestId).toBeNull();
    expect(chat.lastPrompt).toBeNull();
  });

  test("a bootstrap with no conversation leaves the empty one in place", () => {
    expect(hydrated().getState().aiChat.messages).toEqual([]);
  });
});
