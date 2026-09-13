import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { visibleEntries } from "../state/output";
import type { AppStore } from "../state/store";
import { EntryRow } from "./EntryRow";
import { entryToText } from "./text";

interface OutputPanelProps {
  store: AppStore;
  api: MainApi;
}

export function OutputPanel({ store, api }: OutputPanelProps) {
  const output = useStore(store, (s) => s.output);
  const showUndefined = useStore(store, (s) => s.settings?.run.showUndefined ?? false);
  const tabId = useStore(store, (s) => s.tab?.id ?? null);
  const entries = visibleEntries(output, { showUndefined });

  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 24,
    overscan: 20,
  });

  useEffect(() => {
    if (pinnedToBottom.current && entries.length > 0) virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
  }, [entries.length, virtualizer]);

  const expand = (handle: string) =>
    tabId && output.runId ? api.expand({ tabId, runId: output.runId, handleId: handle }) : Promise.resolve(null);

  const copyAll = () => navigator.clipboard.writeText(entries.map((entry) => entryToText(entry.event)).join("\n"));

  return (
    <section className="output" aria-label="Output">
      <header className="output-toolbar">
        <span className="output-title">Console</span>
        <button type="button" onClick={copyAll} disabled={entries.length === 0}>
          Copy All
        </button>
        <button type="button" onClick={() => store.getState().clearOutput()} disabled={entries.length === 0}>
          Clear
        </button>
      </header>
      <div
        ref={scroller}
        className="output-scroller"
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
                  stale={output.stale}
                  expand={expand}
                  onReveal={(line) => store.getState().reveal(line)}
                  onHover={(line) => store.getState().setHoveredLine(line)}
                />
              </div>
            );
          })}
        </div>
        {output.truncated > 0 && (
          <div className="output-truncated">
            Output truncated: {output.truncated} more entries were dropped. Raise the limit in Settings → Advanced.
          </div>
        )}
      </div>
    </section>
  );
}
