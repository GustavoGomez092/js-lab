import type { ReactNode } from "react";
import { strings } from "../strings";

/** The unified macOS toolbar row (hiddenInset title bar). The row drags the window; controls opt out. */
export function Toolbar(props: {
  autoRun: boolean;
  busy: boolean;
  onToggleAutoRun(): void;
  onRun(): void;
  onStop(): void;
  children?: ReactNode;
}) {
  return (
    <header className="toolbar electrobun-webkit-app-region-drag">
      <div className="toolbar-traffic" aria-hidden="true" />
      <div className="toolbar-tabs">{props.children}</div>
      <div className="toolbar-actions electrobun-webkit-app-region-no-drag">
        <button type="button" className="tb-btn" aria-pressed={props.autoRun} onClick={props.onToggleAutoRun}>
          {strings.shell.autoRun} <span className="kbd">{props.autoRun ? strings.shell.on : strings.shell.off}</span>
        </button>
        {props.busy ? (
          <button type="button" className="tb-btn run" onClick={props.onStop}>
            ■ {strings.shell.stop} <span className="kbd">⇧⌘R</span>
          </button>
        ) : (
          <button type="button" className="tb-btn run" onClick={props.onRun}>
            ▶ {strings.shell.run} <span className="kbd">⌘R</span>
          </button>
        )}
      </div>
    </header>
  );
}
