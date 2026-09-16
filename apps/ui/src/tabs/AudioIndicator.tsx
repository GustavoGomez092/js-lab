import { strings } from "../strings";

/**
 * The per-tab speaker icon (Task 15, spec §5.12, parity EX-35): shown only while the tab's runner reports audio
 * activity (an AudioContext running, or a media element playing), so a tab making noise is identifiable at a
 * glance -- and stoppable without stopping the whole run -- even when it isn't the active tab. A real `<button>`,
 * not a `<div>` with a click handler, so it's keyboard-reachable and activatable by construction; the visible
 * focus ring comes from the app-wide `:focus-visible` rule (apps/ui/src/styles.css), not anything drawn here.
 * `aria-pressed` and `aria-label` both carry the *current* muted state -- a screen reader announces which one is
 * true, not just that a toggle exists (an earlier M4 task shipped a control whose state never reached the DOM;
 * this one is read straight off real ARIA attributes, not a React prop, in its own tests).
 */
export function AudioIndicator({
  active,
  muted,
  title,
  onToggle,
}: {
  /** Whether the tab's runner currently reports audio activity. Nothing is rendered while false. */
  active: boolean;
  muted: boolean;
  /** The tab's title, folded into the accessible name so it's clear *which* tab this is (spec's own motivation:
   * with several tabs open, nothing else says which one is making noise). */
  title: string;
  onToggle(): void;
}) {
  if (!active) return null;
  return (
    <button
      type="button"
      className={`tab-audio${muted ? " muted" : ""}`}
      aria-pressed={muted}
      aria-label={muted ? strings.tabs.audio.unmute(title) : strings.tabs.audio.mute(title)}
      onClick={(event) => {
        // The indicator lives inside the tab's own clickable row (TabBar.tsx): without this, toggling mute would
        // also activate the tab underneath it.
        event.stopPropagation();
        onToggle();
      }}
    >
      <span aria-hidden="true">{muted ? "🔇" : "🔊"}</span>
    </button>
  );
}
