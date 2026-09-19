import type { ConversationTurn } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AiChatMessage, AppStore } from "../state/store";

/**
 * Spec §14.3: "the current conversation is kept in `ai/conversation.json` and restored at launch; New Chat
 * clears it."
 *
 * This deliberately does NOT live in `AiChatPanel`. The panel unmounts whenever the side bar is closed, and
 * closing the side bar mid-reply is a supported thing to do -- the store's own `AiChatState` comment says so,
 * and the chunks keep arriving and keep being applied while the panel is gone. A panel-owned save would
 * therefore miss exactly the replies that finished while the user was not looking at them. Subscribing to the
 * store instead makes persistence independent of what happens to be rendered.
 */

/** The durable half of a turn. `streaming` and `error` are in-flight state; see `shared/src/conversation.ts`. */
export function conversationTurns(messages: readonly AiChatMessage[]): ConversationTurn[] {
  return (
    messages
      // A failed turn is dropped rather than stored, because its error is not stored either: restoring it would
      // put a blank assistant bubble under the user's question with nothing to say why.
      .filter((message) => message.error === null)
      .map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        stopped: message.stopped,
      }))
  );
}

/**
 * Writes the conversation to Main whenever it settles, and returns the unsubscribe.
 *
 * Two rules, both load-bearing:
 * - **Never mid-stream.** `requestId !== null` means chunks are still arriving; saving there would rewrite the
 *   file once per chunk for the whole of a long reply.
 * - **Only on a real change.** The saved transcript is compared with what was last written, so re-renders and
 *   unrelated store updates (a keystroke in the editor, a run finishing) do not schedule writes. The baseline
 *   starts at whatever was restored by `hydrate`, so a conversation JSLab just read is never written straight
 *   back out.
 */
export function persistConversation(store: AppStore, api: Pick<MainApi, "aiSaveConversation">): () => void {
  let last = JSON.stringify(conversationTurns(store.getState().aiChat.messages));
  return store.subscribe((state) => {
    if (state.aiChat.requestId !== null) return;
    const turns = conversationTurns(state.aiChat.messages);
    const serialized = JSON.stringify(turns);
    if (serialized === last) return;
    last = serialized;
    api.aiSaveConversation(turns);
  });
}
