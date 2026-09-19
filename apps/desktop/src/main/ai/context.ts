import type { AiMessage, AiSendParams } from "@jslab/rpc-schema";

/**
 * The request context (spec §14.2): a bundled system prompt, then the current tab's code capped at 100 KB, then
 * the most recent run's output capped at 20 KB when `ai.includeOutput` is on, then the conversation history
 * trimmed from the OLDEST messages to fit.
 *
 * Every cap here is applied in Main rather than in the renderer, for the same reason the request itself is made
 * in Main: the renderer is where the rule would be duplicated and where it would drift.
 */

/** Spec §14.2: "The current tab's code, up to 100 KB". */
export const AI_CODE_BUDGET_BYTES = 100 * 1024;

/** Spec §14.2: the recent output, "rendered as text and capped at 20 KB". */
export const AI_OUTPUT_BUDGET_BYTES = 20 * 1024;

/**
 * What the conversation history may occupy once the code and output have taken their share.
 *
 * Spec §14.2 says history is trimmed "to fit the model's context budget" without naming a number, and no honest
 * number can be derived here: the budget belongs to whichever model the user selected, which this process does
 * not know and cannot ask about portably. This is therefore a declared default rather than a derivation --
 * chosen so that code + output + history stays well inside the smallest context window any currently shipping
 * instruct model offers, and so that the trim is what drops turns rather than the provider returning a 400.
 */
export const AI_HISTORY_BUDGET_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** The UTF-8 byte length of `text`. */
export function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The longest prefix of `text` that fits in `maxBytes` UTF-8 bytes, never splitting a character.
 *
 * Iterating with `for...of` walks CODE POINTS, so an astral character (an emoji in a comment, a CJK identifier)
 * is kept or dropped whole. Slicing the encoded bytes instead would cut a multi-byte character in half and hand
 * the model a U+FFFD -- and, on a JS string, `slice` on UTF-16 units would do the same to a surrogate pair.
 */
export function truncateHead(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const size = byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += character.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/** As `truncateHead`, but keeping the END of the text -- for output, where the newest lines are the useful ones. */
export function truncateTail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(text) <= maxBytes) return { text, truncated: false };
  const characters = [...text];
  let bytes = 0;
  let start = characters.length;
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index] as string;
    const size = byteLength(character);
    if (bytes + size > maxBytes) break;
    bytes += size;
    start = index;
  }
  return { text: characters.slice(start).join(""), truncated: true };
}

/**
 * The system prompt, bundled with the app (spec §14.2: "a system prompt, bundled with the app (JSLab assistant,
 * with the runtime and language described)").
 *
 * It is built here and never accepted from the renderer, which is why `AI_ROLES` on the wire has no `system`
 * member: a compromised or merely buggy view cannot replace the assistant's instructions.
 */
export function systemPrompt(params: Pick<AiSendParams, "language" | "runtime">): string {
  return [
    "You are the JSLab assistant. JSLab is a JavaScript and TypeScript scratchpad that runs code as it is typed.",
    `The user's current file is ${params.language}, running on the ${params.runtime} runtime.`,
    "Answer about the code you are shown. Prefer short, working examples over prose.",
    "When you give code, put it in a fenced block and mark the fence with the language, because the user can insert a block straight into the editor.",
  ].join("\n");
}

/** How the tab's code is presented: marked with the language, runtime and working-directory name (spec §14.2). */
export function codeBlock(params: AiSendParams): string {
  const code = truncateHead(params.code, AI_CODE_BUDGET_BYTES);
  const where = params.workingDirectoryName ? `, working directory ${params.workingDirectoryName}` : "";
  const note = code.truncated ? ` (truncated to the first ${AI_CODE_BUDGET_BYTES} bytes)` : "";
  return [
    `Current file — ${params.language} on ${params.runtime}${where}${note}:`,
    `\`\`\`${params.language}`,
    code.text,
    "```",
  ].join("\n");
}

/** The most recent run's output, tail-trimmed to the 20 KB budget. */
export function outputBlock(output: string): string {
  const trimmed = truncateTail(output, AI_OUTPUT_BUDGET_BYTES);
  const note = trimmed.truncated ? ` (last ${AI_OUTPUT_BUDGET_BYTES} bytes)` : "";
  return [`Output from the most recent run${note}:`, "```text", trimmed.text, "```"].join("\n");
}

/**
 * Drops whole turns from the FRONT until the rest fits `maxBytes` (spec §14.2: "trimmed from the oldest
 * messages").
 *
 * Whole turns, never partial ones: half a question followed by its full answer reads to the model as though the
 * user asked something they did not. The newest turn is always kept even when it alone exceeds the budget --
 * returning an empty history for a long question would silently discard what the user just asked; the provider's
 * own context error is the honest outcome there, and it is a `contextTooLong` the panel can explain.
 */
export function trimHistory(history: readonly AiMessage[], maxBytes: number): AiMessage[] {
  const kept: AiMessage[] = [];
  let bytes = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index] as AiMessage;
    const size = byteLength(message.content);
    if (kept.length > 0 && bytes + size > maxBytes) break;
    kept.unshift(message);
    bytes += size;
  }
  return kept;
}

/**
 * The full prompt for one request, in the order spec §14.2 lays down: system, then code, then output, then the
 * trimmed history, then what the user just typed.
 *
 * The code and output ride on their own `user` turn ahead of the history rather than being glued onto the user's
 * question, so trimming the history can never take the code with it.
 */
export function buildMessages(params: AiSendParams, options: { includeOutput: boolean }): AiMessage[] {
  const preamble = [codeBlock(params)];
  if (options.includeOutput && params.output && params.output.trim() !== "") {
    preamble.push(outputBlock(params.output));
  }
  return [
    { role: "assistant", content: systemPrompt(params) },
    { role: "user", content: preamble.join("\n\n") },
    ...trimHistory(params.history, AI_HISTORY_BUDGET_BYTES),
    { role: "user", content: params.prompt },
  ];
}
