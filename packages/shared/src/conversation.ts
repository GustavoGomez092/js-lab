import { z } from "zod";

/**
 * `ai/conversation.json` (spec §14.3: "the current conversation is kept in `ai/conversation.json` and restored at
 * launch; New Chat clears it").
 *
 * The file format lives here, beside `session.ts` and `snippets.ts`, because Main owns the file and the UI owns
 * the conversation: both ends validate against this one schema rather than each trusting the other's shape.
 *
 * What is NOT persisted is as deliberate as what is. A turn's `streaming` flag and its `error` are in-flight
 * state: a stream cannot survive a relaunch, and a Retry button for a request whose provider call is long gone
 * would resend a prompt the user has not asked for again. Both are reconstructed as "settled, no error" on load,
 * so a restored conversation is exactly a transcript. `stopped` IS persisted -- it is a property of the reply
 * that was produced, not of the request that produced it, and a reply the user interrupted must not come back
 * looking complete.
 */

/** Spec §14.3: the current file version. Bumping it means adding a CONVERSATION_MIGRATIONS entry. */
export const CONVERSATION_VERSION = 1;

export const CONVERSATION_ROLES = ["user", "assistant"] as const;
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

/** Most turns the file may hold. Matches `MAX_AI_HISTORY_MESSAGES`, the most one request may carry. */
export const MAX_CONVERSATION_TURNS = 200;
/** One turn's text. Matches `MAX_AI_MESSAGE_CHARS`, so a turn that crossed the wire can always be written back. */
export const MAX_CONVERSATION_TURN_CHARS = 100_000;
/**
 * The whole transcript's text budget, trimmed oldest-first by `trimConversation`.
 *
 * Without it the turn caps alone would admit a 20 MB file (200 × 100 000), which Main would then read at every
 * launch before the first paint. Trimming on WRITE is what keeps the read cap below comfortably reachable,
 * rather than leaving a file JSLab can produce but then refuses to load -- which `loadJson` would report as
 * corruption and silently replace with an empty conversation.
 */
export const MAX_CONVERSATION_CHARS = 1_000_000;
/** The read cap for `loadJson`. Far above what `trimConversation` can produce, so a JSLab-written file always loads. */
export const MAX_CONVERSATION_FILE_BYTES = 8 * 1024 * 1024;

export const conversationTurnSchema = z.object({
  /** React's key for the turn. Opaque, like a snippet id: a hand-edited file must not be refused over it. */
  id: z.string().min(1).max(100),
  role: z.enum(CONVERSATION_ROLES),
  content: z.string().max(MAX_CONVERSATION_TURN_CHARS),
  stopped: z.boolean(),
});
export type ConversationTurn = z.infer<typeof conversationTurnSchema>;

export const conversationSchema = z.object({
  version: z.number().int().min(1),
  messages: z.array(conversationTurnSchema).max(MAX_CONVERSATION_TURNS),
});
export type Conversation = z.infer<typeof conversationSchema>;

export const emptyConversation = (): Conversation => ({ version: CONVERSATION_VERSION, messages: [] });

type RawConversation = Record<string, unknown>;

function isObject(value: unknown): value is RawConversation {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `CONVERSATION_MIGRATIONS[n]` upgrades a version-n file to version n + 1. Unknown keys always pass through.
 *
 * Empty at version 1, and that is not an oversight: there is no earlier version to come from. The loop below is
 * what makes the table load-bearing from the next bump on -- `parseConversation` THROWS on a version with no
 * migration, `loadJson` treats a throw as corruption, and corruption is replaced with defaults. So bumping
 * CONVERSATION_VERSION without adding the matching entry here would silently discard the user's conversation,
 * exactly as it would have discarded every setting in `SETTINGS_MIGRATIONS` (see its `3` entry).
 */
export const CONVERSATION_MIGRATIONS: Record<number, (raw: RawConversation) => RawConversation> = {};

export interface ConversationParseResult {
  conversation: Conversation;
  /** The version stored in the file; a file without one is version 1. */
  fileVersion: number;
  /** True when a newer JSLab wrote the file. Callers must never write it back (session.ts's I4 rule). */
  newerThanBuild: boolean;
}

export function parseConversation(input: unknown): ConversationParseResult {
  if (!isObject(input)) throw new Error("conversation.json must contain an object");
  const stored = input.version;
  const fileVersion = typeof stored === "number" && Number.isInteger(stored) && stored >= 1 ? stored : 1;
  // The version is written back before the schema sees it, so a file that never had one (or carries something
  // that is not a version) is read as the version 1 it is treated as above, rather than refused for a field the
  // parser has already decided the value of. The schema itself stays strict -- no `.catch()` default, which
  // would make every other malformed version silently acceptable too.
  let raw: RawConversation = { ...input, version: fileVersion };
  for (let version = fileVersion; version < CONVERSATION_VERSION; version++) {
    const migrate = CONVERSATION_MIGRATIONS[version];
    if (!migrate) throw new Error(`No conversation migration from version ${version}`);
    raw = migrate(raw);
  }
  return {
    conversation: conversationSchema.parse(raw),
    fileVersion,
    newerThanBuild: fileVersion > CONVERSATION_VERSION,
  };
}

/**
 * Parser for `loadJson`: throws on anything it cannot read, so recovery falls back to `conversation.json.bak`
 * and then to an empty conversation.
 *
 * Deliberately strict rather than `.catch()`-defaulted. A schema that quietly repaired a malformed file would
 * make corruption unobservable, and `loadJson`'s whole recovery path -- the `.bak`, the preserved
 * `.corrupt-<timestamp>.json` copy -- would never run.
 */
export const conversationParser = {
  parse(input: unknown): Conversation {
    return parseConversation(input).conversation;
  },
};

/**
 * The turns that fit the budgets, trimmed from the OLDEST first and always by whole turns.
 *
 * Whole turns for the same reason `trimHistory` uses them (spec §14.2): half a question followed by its full
 * answer reads as though the user asked something they did not. The NEWEST turn is always kept even when it
 * alone exceeds the char budget -- a single enormous reply must still be the thing that survives, and the turn
 * cap above is what bounds the file in that case.
 */
export function trimConversation(messages: readonly ConversationTurn[]): ConversationTurn[] {
  const kept: ConversationTurn[] = [];
  let chars = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turn = messages[index] as ConversationTurn;
    if (kept.length >= MAX_CONVERSATION_TURNS) break;
    if (kept.length > 0 && chars + turn.content.length > MAX_CONVERSATION_CHARS) break;
    kept.unshift(turn);
    chars += turn.content.length;
  }
  return kept;
}

/** The exact bytes written to `ai/conversation.json`, so the writer and its tests cannot disagree. */
export function conversationFileContent(messages: readonly ConversationTurn[]): string {
  const file: Conversation = { version: CONVERSATION_VERSION, messages: trimConversation(messages) };
  return `${JSON.stringify(file, null, 2)}\n`;
}
