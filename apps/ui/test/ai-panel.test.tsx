import { describe, expect, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { AiChatPanel } from "../src/ai/AiChatPanel";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";
import { createFakeApi } from "./fake-api";

/** What the panel's two editor actions were asked to do, reset by each `setup`. */
const inserted: string[] = [];
const replaced: string[] = [];

function setup(options: { provider?: string; code?: string } = {}) {
  inserted.length = 0;
  replaced.length = 0;
  const store = createAppStore();
  store.getState().hydrate({
    settings: mergeSettings(defaultSettings(), {
      ai: { provider: options.provider ?? "ollama" },
      view: { sideBar: true },
    } as never),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: options.code ?? "const a = 1;" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const { api, emit } = createFakeApi();
  const actions = {
    insertAtCursor: (code: string) => {
      inserted.push(code);
    },
    replaceEditor: (code: string) => {
      replaced.push(code);
    },
  };
  render(<AiChatPanel store={store} api={api} actions={actions} />);
  return { store, api, emit };
}

/** Sends a prompt and returns the requestId Main was given, so a reply can be streamed back for it. */
function send(api: ReturnType<typeof createFakeApi>["api"], text: string): string {
  const box = screen.getByLabelText(strings.ai.inputLabel);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
  const call = api.aiSend.mock.calls.at(-1)?.[0] as { requestId: string } | undefined;
  return call?.requestId ?? "";
}

describe("the AI Chat panel (spec §14.1)", () => {
  test("with no provider configured it shows the Choose a provider card, which opens Settings", () => {
    const { api } = setup({ provider: "none" });
    expect(screen.queryByLabelText(strings.ai.inputLabel)).toBeNull();
    fireEvent.click(screen.getByText(strings.ai.chooseProvider));
    expect(api.appCommand).toHaveBeenCalledWith("openSettings");
  });

  test("the header shows the provider and opens Settings when clicked", () => {
    const { api } = setup();
    const header = screen.getByText(strings.ai.providerOnly("ollama"));
    fireEvent.click(header);
    expect(api.appCommand).toHaveBeenCalledWith("openSettings");
  });

  test("Enter sends the prompt with the tab's code; Shift+Enter does not send", () => {
    const { api } = setup({ code: "const marker = 42;" });
    const box = screen.getByLabelText(strings.ai.inputLabel);

    fireEvent.change(box, { target: { value: "still typing" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(api.aiSend).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    expect(api.aiSend).toHaveBeenCalledTimes(1);
    const sent = api.aiSend.mock.calls[0]?.[0] as { prompt: string; code: string; tabId: string };
    expect(sent.prompt).toBe("still typing");
    expect(sent.code).toBe("const marker = 42;");
    expect(sent.tabId).toBe("t1");
  });

  test("streamed chunks are appended to the assistant turn, in order", async () => {
    const { api, emit } = setup();
    const requestId = send(api, "hello?");
    await emit("ai.chunk", { requestId, text: "Hel" });
    await emit("ai.chunk", { requestId, text: "lo there" });

    expect(screen.getByLabelText(strings.ai.assistant).textContent).toContain("Hello there");
  });

  /**
   * The stale-reply guard, against the case that actually happens: a straggling chunk for a PREVIOUS request
   * whose turn is still on screen (the user pressed Stop, then a chunk already in flight arrived).
   *
   * Deliberately not a freshly minted id. Mutation testing killed that version of this test: a random id matches
   * no message, so the per-message `id ===` check alone discards it and the store's stale-request guard could be
   * deleted with every assertion still green. Only a chunk for a turn that EXISTS distinguishes the two.
   */
  test("a late chunk for a finished request does not extend that reply", async () => {
    const { api, emit, store } = setup();
    const first = send(api, "first");
    await emit("ai.chunk", { requestId: first, text: "answer one" });
    await emit("ai.done", { requestId: first, stopped: true });

    // A second request is now the one in flight, while the first turn is still rendered above it.
    const second = send(api, "second");
    expect(second).not.toBe(first);
    await emit("ai.chunk", { requestId: first, text: " LATE" });

    expect(store.getState().aiChat.messages.find((message) => message.id === first)?.content).toBe("answer one");
    expect(screen.getByLabelText(strings.ai.conversation).textContent).not.toContain("LATE");
  });

  test("Stop appears only while streaming and aborts the request that is in flight", async () => {
    const { api, emit } = setup();
    expect(screen.queryByText(strings.ai.stop)).toBeNull();

    const requestId = send(api, "long answer please");
    expect(screen.getByText(strings.ai.stop)).toBeTruthy();

    fireEvent.click(screen.getByText(strings.ai.stop));
    expect(api.aiStop).toHaveBeenCalledWith(requestId);

    await emit("ai.done", { requestId, stopped: true });
    expect(screen.queryByText(strings.ai.stop)).toBeNull();
    expect(screen.getByText(strings.ai.stopped)).toBeTruthy();
  });

  test("an error is shown inline with a Retry that resends the same prompt", async () => {
    const { api, emit } = setup();
    const requestId = send(api, "explain this");
    await emit("ai.error", { requestId, kind: "rateLimit", detail: "slow down" });

    expect(screen.getByText(strings.ai.errors.rateLimit)).toBeTruthy();
    expect(screen.getByText("slow down")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByText(strings.ai.retry));
    });
    expect(api.aiSend).toHaveBeenCalledTimes(2);
    const resent = api.aiSend.mock.calls[1]?.[0] as { prompt: string };
    expect(resent.prompt).toBe("explain this");
  });

  test("a finished code block offers Insert at Cursor and Replace Editor with its exact text", async () => {
    const { api, emit } = setup();
    const requestId = send(api, "give me code");
    await emit("ai.chunk", { requestId, text: "Try:\n```ts\nconst answer = 42;\n```\n" });

    fireEvent.click(screen.getByText(strings.ai.insertAtCursor));
    expect(inserted).toEqual(["const answer = 42;"]);

    fireEvent.click(screen.getByText(strings.ai.replaceEditor));
    expect(replaced.at(-1)).toBe("const answer = 42;");
  });

  /** While a fence is still open the code is half-written; acting on it would insert half a statement. */
  test("an unfinished code block offers no actions until its fence closes", async () => {
    const { api, emit } = setup();
    const requestId = send(api, "give me code");
    await emit("ai.chunk", { requestId, text: "```ts\nconst partial = (" });
    expect(screen.queryByText(strings.ai.insertAtCursor)).toBeNull();

    await emit("ai.chunk", { requestId, text: "1);\n```\n" });
    expect(screen.getByText(strings.ai.insertAtCursor)).toBeTruthy();
  });

  test("New Chat clears the conversation", async () => {
    const { api, emit, store } = setup();
    const requestId = send(api, "first question");
    await emit("ai.done", { requestId, stopped: false });
    expect(store.getState().aiChat.messages).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByText(strings.ai.newChat));
    });
    expect(store.getState().aiChat.messages).toEqual([]);
    expect(screen.getByText(strings.ai.empty)).toBeTruthy();
  });

  test("the conversation so far is sent as history, without the new prompt", async () => {
    const { api, emit } = setup();
    const first = send(api, "first");
    await emit("ai.chunk", { requestId: first, text: "answer one" });
    await emit("ai.done", { requestId: first, stopped: false });

    send(api, "second");
    const sent = api.aiSend.mock.calls[1]?.[0] as { history: { role: string; content: string }[]; prompt: string };
    expect(sent.history.map((message) => message.content)).toEqual(["first", "answer one"]);
    expect(sent.prompt).toBe("second");
  });
});
