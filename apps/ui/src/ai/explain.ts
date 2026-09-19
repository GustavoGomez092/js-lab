import { MAX_AI_MESSAGE_CHARS } from "@jslab/rpc-schema";
import { entryToText } from "../output/text";
import type { DisplayEvent } from "../state/output";
import { strings } from "../strings";

/**
 * TL-20 "Explain Result" (spec §14.2): "from an output entry, it opens the panel and sends 'Explain why line
 * <L> produces this result:' with the rendered value, the code, and the surrounding output."
 *
 * Only the first two halves are built here. The code and the surrounding output are NOT assembled again: they
 * already ride every `ai.send` -- the panel attaches the tab's code and the run's rendered output, and Main
 * applies spec §14.2's 100 KB / 20 KB budgets to them. Explain Result is therefore an ordinary prompt with an
 * extraordinary body, which is what keeps one context assembler rather than two that can drift.
 */

/**
 * How much of a rendered value one prompt may carry.
 *
 * This cap is load-bearing, not tidiness. `aiSendParamsSchema.prompt` is capped at `MAX_AI_MESSAGE_CHARS`, and
 * an over-long message is rejected by Main's validator, logged, and DROPPED -- `createValidators`' `message`
 * wrapper is fire-and-forget, so the panel would sit with an empty assistant turn forever and the user would
 * see Explain Result do nothing at all. An output row can hold megabytes (a big typed array, a long string),
 * so the value is cut here, well inside that bound, and the cut is disclosed in the prompt.
 */
export const MAX_EXPLAIN_VALUE_CHARS = 20_000;

/** The source line an entry belongs to, or undefined for the stream rows (stdout/stderr) that have none. */
export function explainLineOf(event: DisplayEvent): number | undefined {
  return event.kind === "result" || event.kind === "console" || event.kind === "error" ? event.line : undefined;
}

/**
 * The prompt for one output row.
 *
 * The value is `entryToText` -- the very text Copy puts on the clipboard, and the rule OU-10 already settled:
 * it renders what the UI HOLDS and never re-fetches, so a truncated string, a lazy handle or a collection page
 * beyond the first is sent as the bytes on screen rather than as a deeper read of a run that may be over. The
 * model is then reasoning about exactly what the user is looking at, and a refusal to send anything at all
 * would make Explain Result unavailable on precisely the large values people most want explained.
 */
export function explainPrompt(event: DisplayEvent): string {
  const line = explainLineOf(event);
  const headline = line === undefined ? strings.ai.explainOutput : strings.ai.explainLine(line);
  const rendered = entryToText(event);
  const value =
    rendered.length > MAX_EXPLAIN_VALUE_CHARS
      ? `${rendered.slice(0, MAX_EXPLAIN_VALUE_CHARS)}\n${strings.ai.explainTruncated}`
      : rendered;
  const prompt = `${headline}\n\n${value}`;
  // Belt and braces against the drop described above: the headline is translated, so its length is not fixed
  // here, and a locale with a very long rendering must still produce a prompt the wire accepts.
  return prompt.length > MAX_AI_MESSAGE_CHARS ? prompt.slice(0, MAX_AI_MESSAGE_CHARS) : prompt;
}
