import type { ReactNode } from "react";
import { strings } from "../strings";

/**
 * The parts of the row that are controls rather than title bar.
 *
 * `titleBarStyle: "hiddenInset"` means there is no native title bar, so this row *is* it: Electrobun's preload
 * turns a mousedown on an `app-region: drag` element into a window move, and the row opts its controls out with
 * `app-region: no-drag` (styles.css: `.toolbar-actions`, `.toolbar button`, `.toolbar input`,
 * `.toolbar [role="tab"]`, plus `.tab` and the whole `.tab-bar`). Double-click-to-zoom has to honour exactly that
 * same boundary, or double-clicking Run or a tab title would zoom the window.
 *
 * Matched structurally rather than through `getComputedStyle`, for two reasons: WKWebView drops `app-region` from
 * the CSSOM entirely -- which is the reason Electrobun mirrors the property in its preload in the first place --
 * and happy-dom never loads styles.css, so no unit test could observe the computed value either way.
 */
const CONTROL_SELECTOR =
  'button, input, [role="tab"], [role="tablist"], .toolbar-actions, .tab, .tab-bar, .electrobun-webkit-app-region-no-drag';

/** The unified macOS toolbar row (hiddenInset title bar). The row drags the window; controls opt out. */
export function Toolbar(props: {
  autoRun: boolean;
  busy: boolean;
  /** Keycap text from the effective keybindings, or null when the command is unbound (FB-m3). */
  runKeys: string | null;
  stopKeys: string | null;
  onToggleAutoRun(): void;
  onRun(): void;
  onStop(): void;
  /** Standard macOS double-click-on-the-title-bar zoom. Fires only on the row itself, never on a control. */
  onZoom(): void;
  children?: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the row is the title bar, not a control; double-click-to-zoom is a pointer affordance of the OS window frame, and the same action is keyboard-reachable as the `view.zoomWindow` command
    <header
      className="toolbar electrobun-webkit-app-region-drag"
      onDoubleClick={(event) => {
        if ((event.target as Element | null)?.closest?.(CONTROL_SELECTOR)) return;
        props.onZoom();
      }}
    >
      <div className="toolbar-traffic" aria-hidden="true" />
      <div className="toolbar-tabs">{props.children}</div>
      <div className="toolbar-actions electrobun-webkit-app-region-no-drag">
        <button type="button" className="tb-btn" aria-pressed={props.autoRun} onClick={props.onToggleAutoRun}>
          {strings.shell.autoRun} <span className="kbd">{props.autoRun ? strings.shell.on : strings.shell.off}</span>
        </button>
        {props.busy ? (
          <button type="button" className="tb-btn run" onClick={props.onStop}>
            ■ {strings.shell.stop} {props.stopKeys && <span className="kbd">{props.stopKeys}</span>}
          </button>
        ) : (
          <button type="button" className="tb-btn run" onClick={props.onRun}>
            ▶ {strings.shell.run} {props.runKeys && <span className="kbd">{props.runKeys}</span>}
          </button>
        )}
      </div>
    </header>
  );
}
