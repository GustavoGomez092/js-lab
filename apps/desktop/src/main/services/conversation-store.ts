import {
  CONVERSATION_VERSION,
  type ConversationTurn,
  conversationFileContent,
  emptyConversation,
  MAX_CONVERSATION_FILE_BYTES,
  parseConversation,
  trimConversation,
} from "@jslab/shared";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";
import {
  createDebouncedWriter,
  type DebouncedWriter,
  loadJson,
  type PrimaryFile,
  type Recovery,
} from "../persistence/json-store";

export type ConversationWrite = (path: string, data: string, options: AtomicWriteOptions) => Promise<void>;

export interface ConversationStoreOptions {
  write?: ConversationWrite;
  delayMs?: number;
  onWriteError?: (error: unknown) => void;
}

/**
 * `ai/conversation.json` (spec §14.3): the AI chat conversation, restored at launch and cleared by New Chat.
 *
 * Shaped after `SettingsStore` and `SessionStore` rather than after `SnippetStore`: it goes through `loadJson`,
 * so it inherits the whole recovery path those two already have -- the `.bak`, the preserved
 * `.corrupt-<timestamp>.json` copy, and the fall back to an empty conversation only once both files are
 * unreadable. Writes are atomic with a `.bak` and debounced, because the UI saves after every settled turn.
 */
export class ConversationStore {
  #messages: ConversationTurn[];
  readonly #writer: DebouncedWriter;

  private constructor(
    readonly path: string,
    messages: ConversationTurn[],
    /** What `loadJson` had to do to produce the messages above. */
    readonly recovered: Recovery,
    /** FA-m4 parity: what was wrong with the primary file, if anything. */
    readonly primary: PrimaryFile,
    /**
     * The version of a conversation.json written by a NEWER JSLab; while set, the file is never written.
     *
     * Session.json's I4 rule, for the same reason: a downgrade that rewrote this file would silently drop every
     * field a later version added, and the user would come back to a truncated transcript on the next upgrade.
     */
    readonly newerVersion: number | null,
    delayMs: number,
    write: ConversationWrite,
    onWriteError: (error: unknown) => void,
  ) {
    this.#messages = messages;
    this.#writer = createDebouncedWriter(
      (data) => (this.newerVersion === null ? write(this.path, data, { backup: true }) : Promise.resolve()),
      delayMs,
      onWriteError,
    );
  }

  static async open(path: string, options: ConversationStoreOptions = {}): Promise<ConversationStore> {
    // `loadJson` retries the parser on `<path>.bak`, so this records the version of whichever file parsed LAST
    // and therefore of the one whose value is actually returned.
    let fileVersion: number | null = null;
    const parser = {
      parse(input: unknown) {
        const result = parseConversation(input);
        fileVersion = result.fileVersion;
        return result.conversation;
      },
    };
    const { value, recovered, primary } = await loadJson(path, parser, emptyConversation, MAX_CONVERSATION_FILE_BYTES);
    // `fileVersion` is assigned only once `parseConversation` has SUCCEEDED, so it always describes the file
    // whose value is in hand -- the primary, or the `.bak` that stood in for it. When neither parsed it is
    // never assigned at all, and the empty conversation below is correctly read as version-less rather than as
    // a newer build's file. A `recovered !== "defaults"` guard stood here to catch a stale leftover; mutation
    // testing showed it could not fail, because there is no path that produces one, so it is gone.
    const newerVersion = fileVersion !== null && fileVersion > CONVERSATION_VERSION ? fileVersion : null;
    return new ConversationStore(
      path,
      value.messages,
      recovered,
      primary,
      newerVersion,
      options.delayMs ?? 500,
      options.write ?? writeFileAtomic,
      options.onWriteError ?? ((error) => console.error("[jslab] conversation write failed", error)),
    );
  }

  get messages(): readonly ConversationTurn[] {
    return this.#messages;
  }

  /** Replaces the conversation and schedules the write. Trimmed here, so what is held matches what is written. */
  save(messages: readonly ConversationTurn[]): void {
    this.#messages = trimConversation(messages);
    // Serialized when the write STARTS, not per call (FA-m9): a burst of saves writes the newest state once.
    this.#writer.schedule(() => conversationFileContent(this.#messages));
  }

  flush(): Promise<void> {
    return this.#writer.flush();
  }
}
