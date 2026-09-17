import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { visibleEntries } from "../state/output";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { copyAllText, copyEntriesToClipboard } from "./copy";
import { EntryRow } from "./EntryRow";
import { FilterChips } from "./FilterChips";
import { applyFilter, filterCounts } from "./filters";
import { entryIsStale, lastSuccessfulRunLabel } from "./stale";
import { WebDialog } from "./WebDialog";

const COPY_STATUS_DURATION_MS = 2000;

interface OutputPanelProps {
  store: AppStore;
  api: MainApi;
  /** The Run keycap from the effective keybindings, for the empty state (review rec 2). */
  runKeys?: string | null;
  /** R23-1: routed through the npm.install command by the caller, not called on api directly. */
  onInstall?(spec: string): void;
  /**
   * R-WEBVIEW-TAB-1: the Web View's single docking placeholder, for when the Web View tab is selected and this
   * panel is where it currently lives. Absent (the common case) leaves the log list in place. `OutputTiles` owns
   * that node and decides which of its two positions it goes in -- this component only gives it a home, and never
   * builds one of its own, because a second dock node would silently strand the tab's one `<electrobun-webview>`.
   */
  webViewSlot?: ReactNode;
  /** spec §7.1: whether this tab's runtime can host a Web View at all. A `bun` tab gets no Web View control. */
  webviewSupported?: boolean;
}

export function OutputPanel({
  store,
  api,
  runKeys = null,
  onInstall,
  webViewSlot = null,
  webviewSupported = false,
}: OutputPanelProps) {
  const output = useStore(store, (s) => s.output);
  const showUndefined = useStore(store, (s) => s.settings?.run.showUndefined ?? false);
  const highlighting = useStore(store, (s) => s.settings?.output.highlighting ?? true);
  const showLineNumbers = useStore(store, (s) => s.settings?.output.showLineNumbers ?? true);
  const filter = useStore(store, (s) => s.outputFilter);
  const tabId = useStore(store, (s) => s.activeTabId);
  // R24-4: a primitive selector for whether the active tab has a working directory.
  const hasWorkingDirectory = useStore(store, (s) => Boolean(s.tab?.workingDirectory));
  // Derived from the slot itself rather than read from the store a second time: the Web View is showing here
  // exactly when `OutputTiles` handed this panel the dock, so the two can never disagree.
  const showingWebView = webViewSlot !== null;

  const visible = useMemo(() => visibleEntries(output, { showUndefined }), [output, showUndefined]);
  const counts = useMemo(() => filterCounts(visible), [visible]);
  const entries = useMemo(() => applyFilter(visible, filter), [visible, filter]);
  const staleLabel = lastSuccessfulRunLabel(output);

  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  // As built (M1 T17 fix round): Copy All reports "Copied" or "Couldn't copy" for two seconds.
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const copyStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyStatusTimer.current) clearTimeout(copyStatusTimer.current);
    },
    [],
  );
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 30,
    overscan: 20,
  });

  useEffect(() => {
    if (pinnedToBottom.current && entries.length > 0) virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
  }, [entries.length, virtualizer]);

  const expand = (handle: string) =>
    tabId && output.runId ? api.expand({ tabId, runId: output.runId, handleId: handle }) : Promise.resolve(null);

  const copyAll = () => {
    // R-M2-T19A-1: the entries visible under the current filter chip -- the same owner the `output.copyAll`
    // command uses, so the button and the palette can never copy different sets again.
    const text = copyAllText(store.getState());
    void copyEntriesToClipboard(text).then((status) => {
      if (copyStatusTimer.current) clearTimeout(copyStatusTimer.current);
      setCopyStatus(status);
      copyStatusTimer.current = setTimeout(() => setCopyStatus(null), COPY_STATUS_DURATION_MS);
    });
  };

  const logList = (
    <div
      ref={scroller}
      className="output-scroller"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the output list is keyboard-focusable so ⌘K and the palette get output context
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const entry = entries[item.index];
          if (!entry) return null;
          return (
            <div
              key={entry.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              <EntryRow
                entry={entry}
                stale={entryIsStale(output, entry.event)}
                expand={expand}
                showLineNumbers={showLineNumbers}
                onReveal={(line) => store.getState().reveal(line)}
                onHover={(line) => store.getState().setHoveredLine(line)}
                onInstall={onInstall}
                onChangeWorkingDirectory={() => (tabId ? api.pickWorkingDirectory(tabId) : undefined)}
                hasWorkingDirectory={hasWorkingDirectory}
              />
            </div>
          );
        })}
      </div>
      {output.truncated > 0 && <div className="output-truncated">{strings.output.truncated(output.truncated)}</div>}
      {/* T19A-m3, review rec 2: quiet, centered empty states instead of a blank scroller. */}
      {visible.length > 0 && entries.length === 0 && (
        <div className="output-empty" data-testid="output-empty">
          <span>{strings.output.noMatches}</span>
          <button type="button" onClick={() => store.getState().setOutputFilter("all")}>
            {strings.output.showAll}
          </button>
        </div>
      )}
      {visible.length === 0 && output.runId === null && output.truncated === 0 && (
        <div className="output-empty" data-testid="output-empty">
          {strings.output.noOutput(runKeys)}
        </div>
      )}
    </div>
  );

  return (
    <section
      className={`output${highlighting ? "" : " output-plain"}`}
      aria-label={strings.output.region}
      onFocusCapture={() => store.getState().setFocus("output")}
    >
      <header className="output-toolbar">
        <FilterChips
          counts={counts}
          filter={filter}
          onChange={(next) => store.getState().setOutputFilter(next)}
          webView={
            webviewSupported
              ? { selected: showingWebView, onSelect: () => store.getState().setOutputView("webview") }
              : undefined
          }
        />
        {staleLabel && <span className="output-stale-label">{staleLabel}</span>}
        <span className="output-spacer" />
        {copyStatus && (
          <span className="output-copy-status">
            {copyStatus === "copied" ? strings.output.copied : strings.output.copyFailed}
          </span>
        )}
        <button type="button" onClick={copyAll} disabled={entries.length === 0}>
          {strings.output.copyAll}
        </button>
        <button type="button" onClick={() => store.getState().clearOutput()} disabled={visible.length === 0}>
          {strings.output.clear}
        </button>
      </header>
      {/* Deliberately rendered in both views: a web dialog (alert/confirm/prompt) comes from the very runtime the
          Web View is showing, so it must not be hidden by the view that caused it. */}
      <WebDialog
        dialogs={output.dialogs}
        onDismiss={(key) => store.getState().dismissWebDialog(key, tabId ?? undefined)}
      />
      {showingWebView ? webViewSlot : logList}
    </section>
  );
}
