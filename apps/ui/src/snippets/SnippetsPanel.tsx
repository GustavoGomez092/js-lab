import { type ConflictPolicy, isValidSnippetName, type Language, mergeSnippets, type Snippet } from "@jslab/shared";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { copyEntriesToClipboard } from "../output/copy";
import type { Dialogs } from "../shell/dialogs";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { SnippetForm } from "./SnippetForm";
import { filterSnippets } from "./snippet-filter";

/** What the panel needs from the editor and the tab list. Implemented in Task 9 (`createSnippetActions`). */
export interface SnippetActions {
  /** Spec §13.1: insert at the cursor, replacing the selection. */
  insert(snippet: Snippet): void;
  insertInNewTab(snippet: Snippet): Promise<void>;
}

/**
 * Spec §13.1: the preview is syntax-highlighted. Injected (R-M5b-5), because Monaco can't run under happy-dom.
 *
 * SECURITY CONTRACT (finding S1) -- an implementation MUST HTML-escape `code` before returning it. The result is
 * rendered with `dangerouslySetInnerHTML`, and `code` is a snippet body, which may have come from an imported
 * `.jslab-snippets` file, i.e. third-party text. The panel renders in the main window, which holds full RPC, so a
 * colorizer that does not escape its input is script execution with full privileges.
 *
 * The shipped implementation (Task 10) is `monaco.editor.colorize`, whose tokenizer escapes its input before
 * wrapping tokens in spans -- that escaping is the ENTIRE guarantee, and nothing here can enforce it, because
 * `colorize` is an ordinary prop that any caller may replace. `test/snippets-panel.test.tsx` pins both halves the
 * panel itself owns: the no-colorizer fallback renders text, and an escaping colorizer creates no element.
 */
export type SnippetColorize = (code: string, language: Language | null) => Promise<string>;

type SnippetsApi = Pick<
  MainApi,
  "snippetsList" | "snippetsSave" | "snippetsImportDialog" | "snippetsExportDialog" | "on"
>;

interface PanelProps {
  store: AppStore;
  api: SnippetsApi;
  dialogs: Pick<Dialogs, "confirm">;
  actions: SnippetActions;
  colorize?: SnippetColorize;
  clipboard?: Pick<Clipboard, "writeText">;
}

const ROW_HEIGHT = 46;

/**
 * Wraps each matched range in a `<mark>`, so a row says WHY it is in the results. Same shape as the command
 * palette's own `highlight` (`palette/CommandPalette.tsx:22`); worth extracting to a shared helper the next time
 * anyone touches both files.
 */
function highlight(text: string, ranges: [number, number][]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(<mark key={start}>{text.slice(start, end)}</mark>);
    cursor = end;
  }
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

/** Spec §13.1, §7.5: the Snippets side-bar panel. Keeps the `side-bar` class: the shell and its tests key on it. */
export function SnippetsPanel({ store, api, dialogs, actions, colorize, clipboard }: PanelProps) {
  const snippets = useStore(store, (s) => s.snippets);
  const loaded = useStore(store, (s) => s.snippetsLoaded);
  const request = useStore(store, (s) => s.snippetsRequest);

  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ initial: Snippet | null; body: string } | null>(null);
  const [deleted, setDeleted] = useState<Snippet | null>(null);
  const [pendingImport, setPendingImport] = useState<Snippet[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; detail?: string } | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const search = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    api.snippetsList().then(
      (library) => {
        if (mounted.current) store.getState().receiveSnippets(library);
      },
      // `snippetsLoaded` stays false, so the panel says "couldn't read" rather than "no snippets yet" -- an
      // unreadable library and an empty one are not the same claim.
      () => {
        if (mounted.current) setError({ message: strings.snippets.loadFailed });
      },
    );
  }, [api, store]);

  /** Every mutation goes through here: save first, adopt the result only when Main confirms it (pessimistic). */
  const save = useCallback(
    async (next: Snippet[]): Promise<boolean> => {
      setError(null);
      try {
        const result = await api.snippetsSave(next);
        if (!mounted.current) return false;
        if (!result.ok) {
          setError({ message: strings.snippets.saveFailed(result.error) });
          return false;
        }
        store.getState().receiveSnippets(next);
        return true;
      } catch (thrown) {
        if (mounted.current) {
          const reason = thrown instanceof Error ? thrown.message : String(thrown);
          setError({ message: strings.snippets.saveFailed(reason) });
        }
        return false;
      }
    },
    [api, store],
  );

  const applyImport = useCallback(
    async (incoming: Snippet[], policy: ConflictPolicy) => {
      const merged = mergeSnippets(store.getState().snippets, incoming, policy);
      setPendingImport(null);
      if (await save(merged.snippets)) {
        // `deleteMessage` promises the undo lasts "until you make another change". This is that change.
        setDeleted(null);
        setStatus(strings.snippets.imported(merged.added, merged.overwritten, merged.skipped));
      }
    },
    [save, store],
  );

  // Spec §13.1 Options menu: Main answers the dialogs with these two messages (never inline), and the panel owns
  // the merge policy (R-M5b-8).
  useEffect(() => {
    const offImported = api.on("snippets.imported", (result) => {
      if (!result.ok) {
        setError({ message: strings.snippets.importFailed, detail: result.detail });
        return;
      }
      setError(null);
      const names = new Set(store.getState().snippets.map((s) => s.name.toLowerCase()));
      const conflicts = result.snippets.filter((s) => names.has(s.name.toLowerCase())).length;
      if (conflicts === 0) void applyImport(result.snippets, "skip");
      else setPendingImport(result.snippets);
    });
    const offExported = api.on("snippets.exported", (result) => {
      if ("cancelled" in result) setStatus(strings.snippets.exportCancelled);
      else if (result.ok) setStatus(strings.snippets.exportedTo(result.path));
      else setError({ message: strings.snippets.exportFailed(result.error) });
    });
    return () => {
      offImported();
      offExported();
    };
  }, [api, applyImport, store]);

  // Task 9's commands reach the panel through this channel; the nonce is what makes a repeat request land.
  useEffect(() => {
    if (!request) return;
    if (request.kind === "focusSearch") search.current?.focus();
    else setEditing({ initial: null, body: request.body });
    store.getState().clearSnippetsRequest();
  }, [request, store]);

  const ranked = useMemo(() => filterSnippets(snippets, query), [snippets, query]);
  const selected = useMemo(
    () => ranked.find((entry) => entry.snippet.id === selectedId)?.snippet ?? ranked[0]?.snippet ?? null,
    [ranked, selectedId],
  );

  useEffect(() => {
    // Cleared up front, not just on the way out: leaving the previous snippet's HTML up while the new one
    // colorizes would show one snippet's body under another snippet's name.
    setHighlighted(null);
    if (!selected || !colorize) return;
    let live = true;
    colorize(selected.body, selected.language).then(
      (html) => {
        if (live) setHighlighted(html);
      },
      // Deliberately empty. `highlighted` is cleared at the top of this effect, so the <pre> fallback is already
      // showing correct text by the time anything can reject. Measured: a `setHighlighted(null)` here killed no
      // mutant, so it was removed rather than left as an unpinnable line. The handler itself stays, so a rejected
      // colorize is not an unhandled rejection.
      () => {},
    );
    return () => {
      live = false;
    };
  }, [selected, colorize]);

  const virtualizer = useVirtualizer({
    count: ranked.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const remove = async (snippet: Snippet) => {
    // R-M5b-4: §13.1's exact wording, a danger button, and no primary -- so Enter does nothing and Escape cancels.
    const choice = await dialogs.confirm({
      title: strings.snippets.deleteTitle(snippet.name),
      message: strings.snippets.deleteMessage,
      buttons: [
        { id: "cancel", label: strings.snippets.cancel, role: "cancel" },
        { id: "delete", label: strings.snippets.deleteButton, role: "danger" },
      ],
    });
    if (choice !== "delete") return;
    const next = store.getState().snippets.filter((candidate) => candidate.id !== snippet.id);
    if (await save(next)) {
      setStatus(null);
      setDeleted(snippet);
    }
  };

  const undoDelete = async () => {
    // Unreachable at runtime -- the Undo button only exists while `deleted` is set. It is kept because it is what
    // narrows `deleted` to Snippet for the array below: pinned by typecheck, not by any test that could exist.
    if (!deleted) return;
    // Restored with its original id and timestamps: an undo is a restoration, not a new snippet.
    if (await save([...store.getState().snippets, deleted])) setDeleted(null);
  };

  const copy = async (snippet: Snippet) => {
    const result = await copyEntriesToClipboard(snippet.body, clipboard ?? navigator.clipboard);
    if (mounted.current) setStatus(result === "copied" ? strings.snippets.copied : strings.snippets.copyFailed);
  };

  if (editing) {
    return (
      <aside className="side-bar snippets-panel" aria-label={strings.snippets.title}>
        <SnippetForm
          store={store}
          api={api}
          initial={editing.initial}
          body={editing.body}
          onDone={() => setEditing(null)}
        />
      </aside>
    );
  }

  const trimmed = query.trim();
  return (
    <aside className="side-bar snippets-panel" aria-label={strings.snippets.title}>
      <header className="snippets-header">
        <h2>{strings.snippets.title}</h2>
        <button type="button" onClick={() => setEditing({ initial: null, body: "" })}>
          {strings.snippets.newSnippet}
        </button>
        <button type="button" onClick={() => api.snippetsImportDialog()}>
          {strings.snippets.import}
        </button>
        <button type="button" onClick={() => api.snippetsExportDialog(snippets)}>
          {strings.snippets.export}
        </button>
      </header>
      <input
        ref={search}
        type="search"
        className="snippets-search"
        aria-label={strings.snippets.searchLabel}
        placeholder={strings.snippets.searchPlaceholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setSelectedId(null);
        }}
      />
      {pendingImport && (
        <div className="snippets-conflicts">
          {/* No role="group": biome's useSemanticElements wants a <fieldset>, and the <p> below already names what
              the three buttons decide, so the role bought nothing a suppression would have been worth. */}
          <p>
            {strings.snippets.conflicts(
              pendingImport.filter((s) => snippets.some((own) => own.name.toLowerCase() === s.name.toLowerCase()))
                .length,
              pendingImport.length,
            )}
          </p>
          <div className="dialog-actions">
            {(["overwrite", "keepBoth", "skip"] as const).map((policy) => (
              <button key={policy} type="button" onClick={() => void applyImport(pendingImport, policy)}>
                {strings.snippets[policy]}
              </button>
            ))}
          </div>
        </div>
      )}
      <div ref={scroller} className="snippets-scroller">
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          role="listbox"
          aria-label={strings.snippets.list}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const entry = ranked[item.index];
            // `noUncheckedIndexedAccess` types this as possibly undefined; the guard is what typechecks
            // `entry.snippet` below. Also unreachable at runtime, and likewise pinned by typecheck alone.
            if (!entry) return null;
            const { snippet } = entry;
            return (
              <div
                key={snippet.id}
                role="option"
                tabIndex={-1}
                aria-selected={selected?.id === snippet.id}
                className="snippets-row"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
                onClick={() => setSelectedId(snippet.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") actions.insert(snippet);
                }}
              >
                <strong className="snippets-name">{highlight(snippet.name, entry.nameRanges)}</strong>
                <span className="snippets-description">{highlight(snippet.description, entry.descriptionRanges)}</span>
              </div>
            );
          })}
        </div>
        {loaded && snippets.length === 0 && <p className="snippets-empty">{strings.snippets.empty}</p>}
        {loaded && snippets.length > 0 && ranked.length === 0 && (
          // A <div>, not a <p>: a <p> cannot contain a <button>, and real parsers auto-close it (D20).
          <div className="snippets-empty">
            {strings.snippets.noMatches(trimmed)}
            {isValidSnippetName(trimmed) && (
              <button type="button" onClick={() => setEditing({ initial: null, body: "" })}>
                {strings.snippets.createNamed(trimmed)}
              </button>
            )}
          </div>
        )}
      </div>
      {selected && (
        <section className="snippets-detail" aria-label={strings.snippets.preview}>
          {highlighted ? (
            // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by the colorizer -- see SnippetColorize (S1)
            <pre className="snippets-preview" dangerouslySetInnerHTML={{ __html: highlighted }} />
          ) : (
            <pre className="snippets-preview">{selected.body}</pre>
          )}
          <div className="snippets-actions">
            <button type="button" onClick={() => actions.insert(selected)}>
              {strings.snippets.insert}
            </button>
            <button type="button" onClick={() => void actions.insertInNewTab(selected)}>
              {strings.snippets.insertInNewTab}
            </button>
            <button type="button" onClick={() => void copy(selected)}>
              {strings.snippets.copy}
            </button>
            <button type="button" onClick={() => setEditing({ initial: selected, body: selected.body })}>
              {strings.snippets.edit}
            </button>
            <button type="button" className="danger" onClick={() => void remove(selected)}>
              {strings.snippets.delete}
            </button>
          </div>
        </section>
      )}
      {deleted && (
        // A <div>, not a <p>, for the same reason as the no-matches block above (D20).
        <div className="snippets-undo" role="status">
          {strings.snippets.deleted(deleted.name)}
          <button type="button" onClick={() => void undoDelete()}>
            {strings.snippets.undo}
          </button>
        </div>
      )}
      {status && !deleted && (
        <p className="snippets-status" role="status">
          {status}
        </p>
      )}
      {error && (
        <p className="snippets-status" role="alert">
          {error.message}
          {error.detail && <span className="snippets-detail-text">{error.detail}</span>}
        </p>
      )}
    </aside>
  );
}
