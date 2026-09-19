import { describe, expect, test } from "bun:test";
import type { AiSendParams } from "@jslab/rpc-schema";
import {
  AI_CODE_BUDGET_BYTES,
  AI_HISTORY_BUDGET_BYTES,
  AI_OUTPUT_BUDGET_BYTES,
  buildMessages,
  byteLength,
  systemPrompt,
  trimHistory,
  truncateHead,
  truncateTail,
} from "../../src/main/ai/context";

const request = (overrides: Partial<AiSendParams> = {}): AiSendParams => ({
  requestId: crypto.randomUUID(),
  tabId: "t1",
  prompt: "why is this undefined?",
  code: "const a = 1;",
  language: "typescript",
  runtime: "bun",
  history: [],
  ...overrides,
});

describe("AI request context (spec §14.2)", () => {
  test("the budgets are the numbers the spec names", () => {
    expect(AI_CODE_BUDGET_BYTES).toBe(100 * 1024);
    expect(AI_OUTPUT_BUDGET_BYTES).toBe(20 * 1024);
  });

  test("the system prompt names the runtime and the language, so the model is not guessing", () => {
    const prompt = systemPrompt({ language: "tsx", runtime: "browser" });
    expect(prompt).toContain("tsx");
    expect(prompt).toContain("browser");
    expect(prompt).toContain("JSLab");
  });

  /**
   * The cap is in BYTES but the text is UTF-16, so the two disagree for every non-ASCII character. Cutting at a
   * byte offset would split a multi-byte character and hand the model a U+FFFD; cutting at a UTF-16 offset would
   * split a surrogate pair and do the same to an emoji.
   */
  test("truncation never splits a character, and respects the byte budget", () => {
    // "é" is 2 UTF-8 bytes: a 5-byte budget fits two of them and must refuse the third rather than half of it.
    const accented = truncateHead("ééé", 5);
    expect(accented.text).toBe("éé");
    expect(accented.truncated).toBe(true);
    expect(byteLength(accented.text)).toBeLessThanOrEqual(5);

    // An emoji is 4 UTF-8 bytes AND a surrogate pair in UTF-16, so it catches both mistakes at once.
    const emoji = truncateHead("🔑🔑", 7);
    expect(emoji.text).toBe("🔑");
    expect(emoji.text).not.toContain("�");
    expect([...emoji.text]).toHaveLength(1);

    expect(truncateHead("abc", 100)).toEqual({ text: "abc", truncated: false });
  });

  test("output keeps its TAIL, because the newest lines are what a question is about", () => {
    const tail = truncateTail("abcdef", 3);
    expect(tail.text).toBe("def");
    expect(tail.truncated).toBe(true);
    // The head-trimming twin on the same input, so a copy-paste that used the wrong one is visible here.
    expect(truncateHead("abcdef", 3).text).toBe("abc");
    expect(truncateTail("🔑🔑", 7).text).toBe("🔑");
  });

  test("the code block carries the language, runtime and working-directory name", () => {
    const [, context] = buildMessages(request({ workingDirectoryName: "scratch", code: "const x = 2;" }), {
      includeOutput: false,
    });
    expect(context?.content).toContain("const x = 2;");
    expect(context?.content).toContain("typescript");
    expect(context?.content).toContain("bun");
    expect(context?.content).toContain("scratch");
  });

  test("code past 100 KB is truncated and says so, rather than being sent whole", () => {
    const huge = "x".repeat(AI_CODE_BUDGET_BYTES + 5_000);
    const [, context] = buildMessages(request({ code: huge }), { includeOutput: false });
    expect(byteLength(context?.content ?? "")).toBeLessThan(AI_CODE_BUDGET_BYTES + 2_000);
    expect(context?.content).toContain("truncated");
    // The point of the cap: what reaches the model is strictly less than what the user had open.
    expect(context?.content).not.toContain(huge);
  });

  test("output is included only when the toggle is on (`ai.includeOutput`, spec §8)", () => {
    const withOutput = buildMessages(request({ output: "TypeError: nope" }), { includeOutput: true });
    expect(withOutput.some((message) => message.content.includes("TypeError: nope"))).toBe(true);

    const without = buildMessages(request({ output: "TypeError: nope" }), { includeOutput: false });
    expect(without.some((message) => message.content.includes("TypeError: nope"))).toBe(false);
  });

  test("history is trimmed from the OLDEST turn, and the newest is never dropped", () => {
    const history = [
      { role: "user" as const, content: "oldest" },
      { role: "assistant" as const, content: "middle" },
      { role: "user" as const, content: "newest" },
    ];
    // A budget that fits only the last two turns.
    const trimmed = trimHistory(history, "middle".length + "newest".length);
    expect(trimmed.map((message) => message.content)).toEqual(["middle", "newest"]);

    // A single turn larger than the whole budget is still kept: returning nothing would silently discard what
    // the user just asked, and the provider's own context error is the honest outcome.
    const huge = [{ role: "user" as const, content: "x".repeat(AI_HISTORY_BUDGET_BYTES * 2) }];
    expect(trimHistory(huge, AI_HISTORY_BUDGET_BYTES)).toHaveLength(1);
  });

  test("the prompt is assembled in the spec's order, with the user's question last", () => {
    const messages = buildMessages(request({ prompt: "explain", history: [{ role: "user", content: "earlier" }] }), {
      includeOutput: false,
    });
    expect(messages).toHaveLength(4);
    expect(messages[0]?.content).toContain("JSLab assistant");
    expect(messages[1]?.content).toContain("const a = 1;");
    expect(messages[2]?.content).toBe("earlier");
    expect(messages[3]?.content).toBe("explain");
    expect(messages[3]?.role).toBe("user");
  });

  /**
   * The code rides on its own turn ahead of the history specifically so that trimming the history can never take
   * the code with it. A long conversation must still see the file it is about.
   */
  test("a history long enough to be trimmed still leaves the code in place", () => {
    const history = Array.from({ length: 50 }, () => ({
      role: "user" as const,
      content: "y".repeat(AI_HISTORY_BUDGET_BYTES / 10),
    }));
    const messages = buildMessages(request({ code: "const marker = 7;", history }), { includeOutput: false });
    expect(messages.length).toBeLessThan(history.length + 3);
    expect(messages[1]?.content).toContain("const marker = 7;");
  });
});
