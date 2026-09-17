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
  // Fix round 1, N1: if this button currently has focus and it does unmount (the audio stopped on its own on an
  // unmuted tab), focus falls back to <body> -- there is no more specific place for it to go once the control
  // that held it is gone, and the tab row itself (TabBar.tsx) isn't a focus stop either. Acceptable: the far
  // more common path out of "muted and active" is the user's own click, which keeps this control (and its
  // focus) mounted, just re-labelled.
  //
  // CodeRabbit finding 7: a **muted** tab keeps its control even once audio goes inactive. `TabBar` passes the
  // runner's `audioActive` as `active`, and the media path in `packages/runner-web/src/handles.ts` *pauses*
  // playback while the tab is muted (`if (audio.muted) this.pause()`), which drops the element out of
  // `AudioController.active`. With the old `!active` test alone, muting a tab could therefore unmount the only
  // control capable of undoing it, stranding the tab muted with no way back. Mute is a persistent, user-set
  // state, so its control stays reachable for as long as it is set.
  if (!active && !muted) return null;
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
      onKeyDown={(event) => {
        // CodeRabbit finding 6: the row underneath activates its tab on Enter/Space too (TabBar.tsx's own
        // `onKeyDown`), so without this a keyboard user unmuting a background tab also switched to it -- the
        // click path was already guarded, the key path was not.
        //
        // Stops propagation ONLY. A native <button> already turns Enter and Space into a click, and that click
        // is what toggles mute via `onClick` above; calling `onToggle()` here as well would flip it twice. There
        // is deliberately no `preventDefault()` either -- that would suppress the very click the browser
        // synthesizes, leaving the control dead for keyboard users.
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      <span aria-hidden="true">{muted ? "🔇" : "🔊"}</span>
    </button>
  );
}
