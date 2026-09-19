import { type AiErrorKind, MAX_AI_OUTPUT_CHARS } from "@jslab/rpc-schema";
import { AI_PROVIDER_NONE, LANGUAGES, type Language } from "@jslab/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { copyEntriesToClipboard } from "../output/copy";
import { entryToText } from "../output/text";
import { visibleEntries } from "../state/output";
import type { AiChatMessage, AppStore } from "../state/store";
import { strings } from "../strings";
import { type MarkdownBlock, parseMarkdown } from "./markdown";

/**
 * Spec §14.1: the AI Chat side panel.
 *
 * Everything that talks to a provider lives in Main (spec §14.3). This component sends `ai.send`, listens for
 * `ai.chunk` / `ai.done` / `ai.error`, and renders what arrives -- it holds no key, no base URL credential and no
 * HTTP client, which is the whole point of the message protocol it uses.
 */

/** Spec §14.1: what a code block's "Insert at Cursor" and "Replace Editor" buttons do. Supplied by App.tsx. */
export interface AiCodeActions {
  insertAtCursor(code: string): void;
  replaceEditor(code: string): void;
}

/**
 * Spec §14.1: code blocks are syntax-highlighted. Injected, exactly as `SnippetColorize` is and for the same two
 * reasons -- Monaco cannot run under happy-dom, and the security contract has to be stated where it is used.
 *
 * SECURITY CONTRACT: an implementation MUST HTML-escape `code` before returning it. The result is rendered with
 * `dangerouslySetInnerHTML`, and here `code` is text written by a REMOTE MODEL, which is a stronger reason than
 * the snippets panel has. The shipped implementation is `monaco.editor.colorize`, whose tokenizer escapes its
 * input; nothing here can enforce that, because `colorize` is an ordinary prop.
 */
export type AiColorize = (code: string, language: Language | null) => Promise<string>;

type AiApi = Pick<MainApi, "aiSend" | "aiStop" | "appCommand" | "on">;

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

/**
 * A fence's language tag, when it is one JSLab can actually colorize.
 *
 * A model writes whatever it likes after the fence -- `python`, `bash`, `json`, `sh`, or nothing -- while the
 * colorizer is Monaco's, registered for JSLab's own four languages. Anything else resolves to `null`, which the
 * colorizer treats as plain text, so an unrecognised tag renders as unhighlighted code rather than as an error
 * or as code highlighted under the wrong grammar.
 */
function toLanguage(fence: string | null): Language | null {
  if (fence === null) return null;
  const lowered = fence.toLowerCase();
  return (LANGUAGES as readonly string[]).includes(lowered) ? (lowered as Language) : null;
}

const ERROR_HEADLINES: Record<AiErrorKind, string> = {
  auth: strings.ai.errors.auth,
  rateLimit: strings.ai.errors.rateLimit,
  network: strings.ai.errors.network,
  contextTooLong: strings.ai.errors.contextTooLong,
  modelNotFound: strings.ai.errors.modelNotFound,
  http: strings.ai.errors.http,
  stalled: strings.ai.errors.stalled,
  tooLarge: strings.ai.errors.tooLarge,
  notConfigured: strings.ai.errors.notConfigured,
  unknown: strings.ai.errors.unknown,
};

/** One fenced block, with the three actions spec §14.1 requires. */
function CodeBlock({
  block,
  actions,
  colorize,
  clipboard,
  onStatus,
}: {
  block: Extract<MarkdownBlock, { kind: "code" }>;
  actions: AiCodeActions;
  colorize?: AiColorize;
  clipboard?: Pick<Clipboard, "writeText">;
  onStatus(message: string): void;
}) {
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    // Cleared up front, so a previous block's HTML is never shown under this block's text while it colorizes.
    setHighlighted(null);
    if (!colorize) return;
    let live = true;
    colorize(block.code, toLanguage(block.language)).then(
      (html) => {
        if (live) setHighlighted(html);
      },
      () => {
        // The <pre> fallback below is already showing the correct text, so a rejected colorize needs no state
        // change -- only a handler, so it is not an unhandled rejection.
      },
    );
    return () => {
      live = false;
    };
  }, [block.code, block.language, colorize]);

  const copy = async () => {
    const result = await copyEntriesToClipboard(block.code, clipboard ?? navigator.clipboard);
    onStatus(result === "copied" ? strings.ai.copied : strings.ai.copyFailed);
  };

  return (
    <div className="ai-code">
      {highlighted ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by the colorizer -- see AiColorize
        <pre className="ai-code-body" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <pre className="ai-code-body">{block.code}</pre>
      )}
      {/* Hidden while the fence is still open: acting on half-written code inserts half a function. */}
      {!block.open && (
        <div className="ai-code-actions">
          <button type="button" onClick={() => void copy()}>
            {strings.ai.copy}
          </button>
          <button type="button" onClick={() => actions.insertAtCursor(block.code)}>
            {strings.ai.insertAtCursor}
          </button>
          <button type="button" onClick={() => actions.replaceEditor(block.code)}>
            {strings.ai.replaceEditor}
          </button>
        </div>
      )}
    </div>
  );
}

function Spans({ block }: { block: Extract<MarkdownBlock, { kind: "paragraph" | "heading" | "listItem" }> }) {
  return (
    <>
      {block.spans.map((span, index) => {
        // The index is a legitimate key here: spans are positional and are re-derived from the text on every
        // render, so there is no identity to preserve across reorderings -- there are no reorderings.
        const key = `${span.kind}-${index}`;
        if (span.kind === "code") return <code key={key}>{span.text}</code>;
        if (span.kind === "strong") return <strong key={key}>{span.text}</strong>;
        if (span.kind === "em") return <em key={key}>{span.text}</em>;
        return <span key={key}>{span.text}</span>;
      })}
    </>
  );
}

function MessageBody({
  content,
  actions,
  colorize,
  clipboard,
  onStatus,
}: {
  content: string;
  actions: AiCodeActions;
  colorize?: AiColorize;
  clipboard?: Pick<Clipboard, "writeText">;
  onStatus(message: string): void;
}) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${block.kind}-${index}`;
        if (block.kind === "code") {
          return (
            <CodeBlock
              key={key}
              block={block}
              actions={actions}
              {...(colorize ? { colorize } : {})}
              {...(clipboard ? { clipboard } : {})}
              onStatus={onStatus}
            />
          );
        }
        if (block.kind === "heading") {
          // One element for every level: an assistant's `###` should not become an `<h1>` inside a side panel.
          return (
            <p key={key} className={`ai-heading ai-heading-${block.level}`}>
              <strong>
                <Spans block={block} />
              </strong>
            </p>
          );
        }
        if (block.kind === "listItem") {
          return (
            <p key={key} className="ai-list-item">
              <Spans block={block} />
            </p>
          );
        }
        return (
          <p key={key}>
            <Spans block={block} />
          </p>
        );
      })}
    </>
  );
}

function Turn({
  message,
  actions,
  colorize,
  clipboard,
  onStatus,
  onRetry,
}: {
  message: AiChatMessage;
  actions: AiCodeActions;
  colorize?: AiColorize;
  clipboard?: Pick<Clipboard, "writeText">;
  onStatus(message: string): void;
  onRetry(): void;
}) {
  const who = message.role === "user" ? strings.ai.you : strings.ai.assistant;
  return (
    <article className={`ai-turn ai-turn-${message.role}`} aria-label={who}>
      <h3 className="ai-turn-who">{who}</h3>
      {message.role === "user" ? (
        // A user turn is the user's own text, shown as typed. It is deliberately NOT parsed as Markdown: the
        // user did not ask for their question to be reformatted, and a stray backtick should stay a backtick.
        <p className="ai-turn-text">{message.content}</p>
      ) : (
        <MessageBody
          content={message.content}
          actions={actions}
          {...(colorize ? { colorize } : {})}
          {...(clipboard ? { clipboard } : {})}
          onStatus={onStatus}
        />
      )}
      {message.streaming && message.content === "" && <p className="ai-thinking">{strings.ai.thinking}</p>}
      {message.stopped && <p className="ai-stopped">{strings.ai.stopped}</p>}
      {message.error && (
        <div className="ai-error" role="alert">
          <p>{ERROR_HEADLINES[message.error.kind]}</p>
          {message.error.detail !== "" && <p className="ai-error-detail">{message.error.detail}</p>}
          <button type="button" onClick={onRetry}>
            {strings.ai.retry}
          </button>
        </div>
      )}
    </article>
  );
}

export function AiChatPanel({
  store,
  api,
  actions,
  colorize,
  clipboard,
}: {
  store: AppStore;
  api: AiApi;
  actions: AiCodeActions;
  colorize?: AiColorize;
  clipboard?: Pick<Clipboard, "writeText">;
}) {
  const chat = useStore(store, (s) => s.aiChat);
  const settings = useStore(store, (s) => s.settings);
  const explainRequest = useStore(store, (s) => s.aiExplainRequest);
  const streaming = chat.requestId !== null;
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const scroller = useRef<HTMLElement>(null);

  // Spec §14.3: the reply arrives as messages, so the panel subscribes rather than awaiting anything. The store
  // applies them, which is what lets the side bar be closed and reopened mid-reply without losing chunks.
  useEffect(() => {
    const offChunk = api.on("ai.chunk", ({ requestId, text }) => {
      store.getState().aiAppendChunk(requestId, text);
    });
    const offDone = api.on("ai.done", ({ requestId, stopped }) => {
      store.getState().aiFinishRequest(requestId, stopped);
    });
    const offError = api.on("ai.error", ({ requestId, kind, detail }) => {
      store.getState().aiFailRequest(requestId, { kind, detail });
    });
    return () => {
      offChunk();
      offDone();
      offError();
    };
  }, [api, store]);

  useEffect(() => {
    const node = scroller.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, []);

  const send = useCallback(
    (prompt: string) => {
      const text = prompt.trim();
      if (text === "") return;
      const state = store.getState();
      const tabId = state.activeTabId;
      const tab = state.tab;
      if (!tabId || !tab) return;

      // Built BEFORE the turn is recorded, or the prompt would appear in its own history.
      const history = state.aiChat.messages
        .filter((message) => message.error === null && message.content !== "")
        .map((message) => ({ role: message.role, content: message.content }));

      const includeOutput = state.settings?.ai.includeOutput ?? true;
      // The tail, because the newest output is what a question is usually about. Main applies spec §14.2's real
      // 20 KB budget; this only keeps a huge run from crossing the wire to be thrown away.
      const output = includeOutput
        ? visibleEntries(state.output, { showUndefined: state.settings?.run.showUndefined ?? false })
            .map((entry) => entryToText(entry.event))
            .join("\n")
            .slice(-MAX_AI_OUTPUT_CHARS)
        : "";

      const requestId = crypto.randomUUID();
      api.aiSend({
        requestId,
        tabId,
        prompt: text,
        code: state.code,
        language: tab.language,
        runtime: tab.runtime,
        ...(tab.workingDirectory ? { workingDirectoryName: baseName(tab.workingDirectory) } : {}),
        ...(output === "" ? {} : { output }),
        history,
      });
      state.aiStartRequest(requestId, text);
      setDraft("");
      setStatus(null);
    },
    [api, store],
  );

  // TL-20 (spec §14.2): a prompt queued by an output row's Explain Result. Held in the store rather than passed
  // in, because the click that produces it is usually what opens this panel -- see `AiExplainRequest`. Declared
  // after `send` deliberately: it calls it, and a `const` is not initialized until its declaration is reached.
  //
  // `streaming` is in the guard, not just the body: a request that arrives mid-reply is LEFT queued rather than
  // dropped or sent alongside, and this effect runs again the moment the reply settles. Sending it immediately
  // would overwrite `aiChat.requestId`, orphaning the reply already on screen so its remaining chunks were
  // dropped by the store's own correlation guard.
  useEffect(() => {
    if (!explainRequest || streaming) return;
    store.getState().clearAiExplainRequest();
    send(explainRequest.prompt);
  }, [explainRequest, streaming, send, store]);

  const provider = settings?.ai.provider ?? AI_PROVIDER_NONE;

  if (provider === AI_PROVIDER_NONE) {
    // Spec §14.1: "No provider configured: the panel shows a card with 'Choose a provider', which opens
    // Settings → AI."
    return (
      <aside className="side-bar ai-panel" aria-label={strings.ai.title}>
        <h2>{strings.ai.title}</h2>
        <div className="ai-choose-provider">
          <p>{strings.ai.chooseProviderHelp}</p>
          <button type="button" onClick={() => api.appCommand("openSettings")}>
            {strings.ai.chooseProvider}
          </button>
        </div>
      </aside>
    );
  }

  const model = (settings?.ai as Record<string, unknown> | undefined)?.[`model.${provider}`];
  const modelLabel = typeof model === "string" && model.trim() !== "" ? model.trim() : "";

  return (
    <aside className="side-bar ai-panel" aria-label={strings.ai.title}>
      <header className="ai-header">
        <h2>{strings.ai.title}</h2>
        {/* Spec §14.1: "provider and model display (clicking it opens Settings → AI)". */}
        <button type="button" className="ai-provider" onClick={() => api.appCommand("openSettings")}>
          {modelLabel === "" ? strings.ai.providerOnly(provider) : strings.ai.providerModel(provider, modelLabel)}
        </button>
        <button type="button" onClick={() => store.getState().aiNewChat()}>
          {strings.ai.newChat}
        </button>
      </header>

      {/* A <section>, not a <div>: an aria-label is only honoured on an element whose role supports naming, and
          a bare div has none. As a named region this is also reachable by landmark navigation. */}
      <section ref={scroller} className="ai-messages" aria-label={strings.ai.conversation}>
        {chat.messages.length === 0 && <p className="ai-empty">{strings.ai.empty}</p>}
        {chat.messages.map((message) => (
          <Turn
            key={message.id}
            message={message}
            actions={actions}
            {...(colorize ? { colorize } : {})}
            {...(clipboard ? { clipboard } : {})}
            onStatus={setStatus}
            onRetry={() => {
              if (chat.lastPrompt) send(chat.lastPrompt);
            }}
          />
        ))}
      </section>

      {status && (
        <p className="ai-status" role="status">
          {status}
        </p>
      )}

      <div className="ai-input">
        <textarea
          aria-label={strings.ai.inputLabel}
          placeholder={strings.ai.placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Spec §14.1: "Enter sends and Shift+Enter adds a newline." The other modifiers are left alone so a
            // composing IME (which fires Enter to accept a candidate) is not treated as a send.
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (!streaming) send(draft);
          }}
        />
        {/* Spec §14.1: "A Stop button appears while streaming." */}
        {streaming ? (
          <button
            type="button"
            className="ai-stop"
            onClick={() => {
              const requestId = store.getState().aiChat.requestId;
              if (requestId) api.aiStop(requestId);
            }}
          >
            {strings.ai.stop}
          </button>
        ) : (
          <button type="button" onClick={() => send(draft)} disabled={draft.trim() === ""}>
            {strings.ai.send}
          </button>
        )}
      </div>
    </aside>
  );
}
