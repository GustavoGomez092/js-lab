import type { RunState } from "@jslab/rpc-schema";
import { LANGUAGES, type Language } from "@jslab/shared";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { AppStore } from "../state/store";
import { BUSY_STATES, LANGUAGE_LABELS, runStateLabel } from "./labels";

export function ActivityBar(props: { runState: RunState | null; onRun(): void; onStop(): void }) {
  const busy = props.runState !== null && BUSY_STATES.has(props.runState);
  return (
    <nav className="activity-bar" aria-label="Actions">
      <button type="button" title="Run (⌘R)" aria-label="Run" onClick={props.onRun}>
        ▶
      </button>
      <button type="button" title="Stop (⇧⌘R)" aria-label="Stop" onClick={props.onStop} disabled={!busy}>
        ■
      </button>
      {busy && <output className="activity-spinner" aria-label="Running" />}
    </nav>
  );
}

export function StatusBar({ store }: { store: AppStore }) {
  const tab = useStore(store, (s) => s.tab);
  // Primitive selectors only: `s.output` is a new object on every `run.events` batch (~60/s), and returning it
  // from a selector would re-render StatusBar that often. Selecting the two fields it actually renders keeps
  // re-renders limited to when one of them actually changes value.
  const runState = useStore(store, (s) => s.output.runState);
  const activeHandles = useStore(store, (s) => s.output.activeHandles);
  const safeMode = useStore(store, (s) => s.safeMode.active);
  const autoRunArmed = useStore(store, (s) => s.autoRunArmed);
  if (!tab) return null;
  const label = runStateLabel({ state: runState, activeHandles, autoRunArmed, safeMode });
  return (
    <footer className="status-bar">
      <span className="status-item">Bun</span>
      <label className="status-item">
        <span className="visually-hidden">Language</span>
        <select value={tab.language} onChange={(event) => store.getState().setLanguage(event.target.value as Language)}>
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {LANGUAGE_LABELS[language]}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="status-item" onClick={() => store.getState().toggleOrientation()}>
        {tab.layout.orientation === "horizontal" ? "Side by side" : "Stacked"}
      </button>
      <span className="status-item status-run" data-testid="run-status">
        {label}
      </span>
    </footer>
  );
}

export function SplitPane(props: {
  orientation: "horizontal" | "vertical";
  size: number;
  onResize(size: number): void;
  first: ReactNode;
  second: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const horizontal = props.orientation === "horizontal";
  // Tracks the currently-attached drag listeners so an unmount mid-drag (before the user releases the pointer)
  // can remove them too -- `up()` alone only runs on pointerup, which never fires if the component unmounts first.
  const activeDrag = useRef<{ move: (e: PointerEvent) => void; up: () => void } | null>(null);

  useEffect(() => {
    return () => {
      if (activeDrag.current) {
        window.removeEventListener("pointermove", activeDrag.current.move);
        window.removeEventListener("pointerup", activeDrag.current.up);
        activeDrag.current = null;
      }
    };
  }, []);

  const startDrag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (e: PointerEvent) => {
      const ratio = horizontal ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
      props.onResize(Math.round(ratio * 100));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      activeDrag.current = null;
    };
    activeDrag.current = { move, up };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={container} className={`split split-${props.orientation}`}>
      <div className="split-pane" style={{ flexBasis: `${props.size}%` }}>
        {props.first}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter needs role=separator; <hr> cannot be dragged */}
      <div
        className="split-divider"
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuenow={props.size}
        aria-valuemin={10}
        aria-valuemax={90}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          const step = { ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2 }[event.key] ?? 0;
          if (step !== 0) props.onResize(props.size + step);
        }}
      />
      <div className="split-pane split-pane-rest">{props.second}</div>
    </div>
  );
}

export function UnresponsiveDialog(props: { onKill(): void; onWait(): void }) {
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="unresponsive-title">
        <h2 id="unresponsive-title">This tab isn't responding</h2>
        <p>Your code has been busy for a few seconds without responding. You can kill it, or keep waiting.</p>
        <div className="dialog-actions">
          <button type="button" onClick={props.onWait}>
            Wait
          </button>
          <button type="button" className="danger" onClick={props.onKill}>
            Kill
          </button>
        </div>
      </div>
    </div>
  );
}

const SAFE_MODE_MESSAGES = {
  crashLoop: "JSLab didn't shut down cleanly while running code. Auto Run is paused for this session.",
  shift: "Safe Mode: Shift was held at launch. Auto Run is paused for this session.",
} as const;

export function SafeModeBanner({ reason }: { reason: "crashLoop" | "shift" | null }) {
  if (!reason) return null;
  return (
    <output className="banner banner-warning" data-testid="safe-mode-banner">
      {SAFE_MODE_MESSAGES[reason]}
    </output>
  );
}
