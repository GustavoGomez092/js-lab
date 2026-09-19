import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_VERSION,
  type ConversationTurn,
  conversationFileContent,
  conversationParser,
  emptyConversation,
  MAX_CONVERSATION_CHARS,
  MAX_CONVERSATION_TURNS,
  parseConversation,
  trimConversation,
} from "../src/conversation";

const turn = (id: string, content: string, overrides: Partial<ConversationTurn> = {}): ConversationTurn => ({
  id,
  role: "user",
  content,
  stopped: false,
  ...overrides,
});

describe("the conversation file (spec §14.3)", () => {
  test("reads a file written by this build, keeping each turn's role, text and interrupted flag", () => {
    const file = {
      version: CONVERSATION_VERSION,
      messages: [turn("a", "why?"), turn("b", "because", { role: "assistant", stopped: true })],
    };
    const { conversation, fileVersion, newerThanBuild } = parseConversation(file);
    expect(fileVersion).toBe(CONVERSATION_VERSION);
    expect(newerThanBuild).toBe(false);
    expect(conversation.messages).toEqual(file.messages);
  });

  test("a file with no version at all is read as version 1 rather than refused", () => {
    const { fileVersion, conversation } = parseConversation({ messages: [turn("a", "hi")] });
    expect(fileVersion).toBe(1);
    expect(conversation.messages).toHaveLength(1);
  });

  /**
   * A newer JSLab's file is READ but flagged, so `ConversationStore` can decline to write it back. Deliberately
   * `CONVERSATION_VERSION + 1` rather than a literal: written as a literal it would silently stop being a
   * *newer* file at the next bump, exactly as the settings suite records happening to its own probe.
   */
  test("a file from a newer JSLab is reported as newer, so it is never written back", () => {
    const { newerThanBuild, fileVersion } = parseConversation({
      version: CONVERSATION_VERSION + 1,
      messages: [turn("a", "hi")],
    });
    expect(newerThanBuild).toBe(true);
    expect(fileVersion).toBe(CONVERSATION_VERSION + 1);
  });

  /**
   * The parser is strict on purpose. `loadJson` treats a throw as corruption, which is what makes it fall back
   * to `conversation.json.bak` and preserve a `.corrupt-<timestamp>.json` copy; a schema that quietly repaired
   * a malformed file instead would make that whole recovery path unreachable.
   */
  test("anything that is not a readable conversation throws, so loadJson can recover from the backup", () => {
    expect(() => conversationParser.parse([1, 2])).toThrow("conversation.json must contain an object");
    expect(() => conversationParser.parse("nope")).toThrow();
    expect(() => conversationParser.parse(null)).toThrow();
    // A turn missing its role is not a turn; the file is corrupt rather than partially usable.
    expect(() => conversationParser.parse({ version: 1, messages: [{ id: "a", content: "x" }] })).toThrow();
    // A role no build ever wrote (the system prompt is built in Main and never persisted).
    expect(() => conversationParser.parse({ version: 1, messages: [{ ...turn("a", "x"), role: "system" }] })).toThrow();
  });

  test("an empty conversation is what a fresh profile starts from", () => {
    expect(emptyConversation()).toEqual({ version: CONVERSATION_VERSION, messages: [] });
  });
});

describe("trimming the conversation before it is written", () => {
  test("a conversation inside both budgets is kept exactly as it is", () => {
    const messages = [turn("a", "one"), turn("b", "two")];
    expect(trimConversation(messages)).toEqual(messages);
  });

  test("the OLDEST turns go first, so the end of the conversation is what survives", () => {
    // Each turn is a tenth of the budget, so eleven of them cannot all fit and the first is the one to go.
    const size = MAX_CONVERSATION_CHARS / 10;
    const messages = Array.from({ length: 11 }, (_, index) => turn(`t${index}`, "x".repeat(size)));
    const kept = trimConversation(messages);
    expect(kept).toHaveLength(10);
    expect(kept[0]?.id).toBe("t1");
    expect(kept.at(-1)?.id).toBe("t10");
  });

  test("more turns than the file may hold are cut to the cap, newest kept", () => {
    const messages = Array.from({ length: MAX_CONVERSATION_TURNS + 5 }, (_, index) => turn(`t${index}`, "x"));
    const kept = trimConversation(messages);
    expect(kept).toHaveLength(MAX_CONVERSATION_TURNS);
    expect(kept[0]?.id).toBe("t5");
  });

  /**
   * The newest turn is kept even when it alone blows the budget. Dropping it would mean a single enormous reply
   * persisted as nothing at all -- the user would come back to a conversation missing the very thing they had
   * just been reading.
   */
  test("a single turn larger than the whole budget is still kept", () => {
    const huge = turn("big", "x".repeat(MAX_CONVERSATION_CHARS * 2));
    expect(trimConversation([turn("old", "gone"), huge])).toEqual([huge]);
  });
});

describe("the bytes written to conversation.json", () => {
  test("stamps this build's version, trims, and ends with a newline", () => {
    const messages = Array.from({ length: MAX_CONVERSATION_TURNS + 1 }, (_, index) => turn(`t${index}`, "x"));
    const text = conversationFileContent(messages);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as { version: number; messages: ConversationTurn[] };
    expect(parsed.version).toBe(CONVERSATION_VERSION);
    expect(parsed.messages).toHaveLength(MAX_CONVERSATION_TURNS);
  });

  test("what it writes always reads back, so a save can never corrupt the next launch", () => {
    const text = conversationFileContent([turn("a", "why?"), turn("b", "because", { role: "assistant" })]);
    expect(parseConversation(JSON.parse(text)).conversation.messages).toHaveLength(2);
  });
});
