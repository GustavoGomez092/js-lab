import type { StartupNotice } from "@jslab/rpc-schema";

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
  manual: "Safe Mode: restarted from Help → Restart in Safe Mode. Auto Run is paused for this session.",
  shift: "Safe Mode: Shift was held at launch. Auto Run is paused for this session.",
} as const;

export function SafeModeBanner({ reason }: { reason: "crashLoop" | "manual" | "shift" | null }) {
  if (!reason) return null;
  return (
    <output className="banner banner-warning" data-testid="safe-mode-banner">
      {SAFE_MODE_MESSAGES[reason]}
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
            aria-label={`Dismiss: ${notice.message}`}
            onClick={() => props.onDismiss(notice.id)}
          >
            ×
          </button>
        </output>
      ))}
    </div>
  );
}
