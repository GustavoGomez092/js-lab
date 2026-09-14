import type { StartupNotice } from "@jslab/rpc-schema";
import { strings } from "../strings";

export function UnresponsiveDialog(props: { onKill(): void; onWait(): void }) {
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

/** Startup notices from Main (spec §20): recovered files, newer files, skipped tabs. Each can be dismissed. */
export function StartupNotices(props: { notices: readonly StartupNotice[]; onDismiss(id: StartupNotice["id"]): void }) {
  if (props.notices.length === 0) return null;
  return (
    <div className="notices" data-testid="startup-notices">
      {props.notices.map((notice) => (
        <output key={notice.id} className="banner banner-warning">
          {notice.message}
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
