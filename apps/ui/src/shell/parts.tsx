import { type NoticeSeverity, noticeSeverity, type StartupNotice } from "@jslab/rpc-schema";
import { useEffect, useMemo, useRef } from "react";
import { strings } from "../strings";
import { useOverlayPresence } from "./overlay-presence";

export function UnresponsiveDialog(props: { onKill(): void; onWait(): void }) {
  // M4 T9c: `App.tsx` only renders this component at all while `runState === "unresponsive"`, so its whole mount
  // lifetime IS the open window -- see `overlay-presence.ts`.
  useOverlayPresence(true);
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="unresponsive-title">
        <h2 id="unresponsive-title">{strings.shell.unresponsive.title}</h2>
        <p>{strings.shell.unresponsive.body}</p>
        <div className="dialog-actions">
          <button type="button" onClick={props.onWait}>
            {strings.shell.unresponsive.wait}
          </button>
          <button type="button" className="danger" onClick={props.onKill}>
            {strings.shell.unresponsive.kill}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SafeModeBanner({ reason }: { reason: "crashLoop" | "manual" | "shift" | null }) {
  if (!reason) return null;
  return (
    <output className="banner banner-warning" data-testid="safe-mode-banner">
      {strings.shell.safeModeBanner[reason]}
    </output>
  );
}

/**
 * B1: the active tab is showing a placeholder, not its file. Rendered for as long as that is true, unlike the
 * dismissible startup notice, so the user can always tell this editor is not their code.
 */
export function UnreadableBufferBanner() {
  return (
    <output className="banner banner-warning" data-testid="unreadable-buffer-banner">
      {strings.shell.unreadableBuffer}
    </output>
  );
}

/** A button a notice offers next to its message, such as Copy Debug Log (spec §20, R-M2-FINAL-5). */
export interface NoticeAction {
  label: string;
  run(): void;
}

/** How long an `info` notice stays before dismissing itself. Warnings and errors never do — WCAG 2.2.3. */
export const NOTICE_AUTO_DISMISS_MS = 8000;

/** More than this many notices stacked at once earns a single control to clear the lot. */
const DISMISS_ALL_THRESHOLD = 2;

/**
 * Severity has to be more than colour, for anyone who cannot distinguish the colours. These are decorative
 * (`aria-hidden`), so the `<output>` still announces the message and not a glyph name.
 */
const SEVERITY_ICON: Record<NoticeSeverity, string> = {
  info: "ℹ",
  warning: "⚠",
  error: "⊗",
};

/** Notices from Main (spec §20): recovered files, newer files, skipped tabs, unexpected errors. Each can be dismissed. */
export function StartupNotices(props: {
  notices: readonly StartupNotice[];
  onDismiss(id: StartupNotice["id"]): void;
  /** Optional per-notice actions, by notice id. */
  actions?: Partial<Record<StartupNotice["id"], NoticeAction>>;
  /** Overridable so a test can pin the timing; production uses NOTICE_AUTO_DISMISS_MS. */
  autoDismissMs?: number;
}) {
  const { notices, onDismiss } = props;
  const autoDismissMs = props.autoDismissMs ?? NOTICE_AUTO_DISMISS_MS;

  // Held in a ref so a fresh `onDismiss` identity on re-render does not restart every pending timer.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  // `info` ONLY. A warning or an error must never reach this list: §7's hard constraint, and WCAG 2.2.3 —
  // the user decides when news of a failure goes away, not a timer.
  const autoDismissIds = useMemo(
    () => notices.filter((notice) => noticeSeverity(notice) === "info").map((notice) => notice.id),
    [notices],
  );

  useEffect(() => {
    if (autoDismissIds.length === 0) return;
    const timers = autoDismissIds.map((id) => setTimeout(() => dismissRef.current(id), autoDismissMs));
    // Without this, a timer outlives the tree and dismisses a notice that is already gone.
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [autoDismissIds, autoDismissMs]);

  if (notices.length === 0) return null;
  return (
    <div className="notices" data-testid="startup-notices">
      {notices.map((notice) => {
        const severity = noticeSeverity(notice);
        const action = props.actions?.[notice.id];
        return (
          <output key={notice.id} className={`banner banner-${severity}`} data-severity={severity}>
            <span className="banner-icon" aria-hidden="true">
              {SEVERITY_ICON[severity]}
            </span>
            {notice.message}
            {action && (
              <button type="button" className="banner-action" onClick={() => action.run()}>
                {action.label}
              </button>
            )}
            <button
              type="button"
              className="banner-dismiss"
              aria-label={strings.shell.dismiss(notice.message)}
              onClick={() => onDismiss(notice.id)}
            >
              ×
            </button>
          </output>
        );
      })}
      {notices.length > DISMISS_ALL_THRESHOLD && (
        <button
          type="button"
          className="notices-dismiss-all"
          onClick={() => {
            for (const notice of notices) onDismiss(notice.id);
          }}
        >
          {strings.notices.dismissAll}
        </button>
      )}
    </div>
  );
}
