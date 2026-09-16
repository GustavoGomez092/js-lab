import type { StartupNotice } from "@jslab/rpc-schema";
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

/** A button a notice offers next to its message, such as Copy Debug Log (spec §20, R-M2-FINAL-5). */
export interface NoticeAction {
  label: string;
  run(): void;
}

/** Notices from Main (spec §20): recovered files, newer files, skipped tabs, unexpected errors. Each can be dismissed. */
export function StartupNotices(props: {
  notices: readonly StartupNotice[];
  onDismiss(id: StartupNotice["id"]): void;
  /** Optional per-notice actions, by notice id. */
  actions?: Partial<Record<StartupNotice["id"], NoticeAction>>;
}) {
  if (props.notices.length === 0) return null;
  return (
    <div className="notices" data-testid="startup-notices">
      {props.notices.map((notice) => (
        <output key={notice.id} className="banner banner-warning">
          {notice.message}
          {props.actions?.[notice.id] && (
            <button type="button" className="banner-action" onClick={() => props.actions?.[notice.id]?.run()}>
              {props.actions[notice.id]?.label}
            </button>
          )}
          <button
            type="button"
            className="banner-dismiss"
            aria-label={strings.shell.dismiss(notice.message)}
            onClick={() => props.onDismiss(notice.id)}
          >
            ×
          </button>
        </output>
      ))}
    </div>
  );
}
