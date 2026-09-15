import { strings } from "../strings";

const ICONS = {
  run: "M8 5l11 7-11 7z",
  stop: "M7 7h10v10H7z",
  snippets: "M4 6h16M4 12h10M4 18h13",
  npm: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  ai: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  settings:
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
} as const;

function Icon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

export function ActivityBar(props: {
  busy: boolean;
  sideBarOpen: boolean;
  panel: "snippets" | "ai";
  canOpenSettings: boolean;
  /** Keycap text from the effective keybindings, or null when the command is unbound (FB-m3). */
  runKeys: string | null;
  stopKeys: string | null;
  settingsKeys: string | null;
  onRun(): void;
  onStop(): void;
  onPanel(panel: "snippets" | "ai"): void;
  onSettings(): void;
}) {
  const open = (panel: "snippets" | "ai") => props.sideBarOpen && props.panel === panel;
  return (
    <nav className="activity-bar" aria-label={strings.shell.activity}>
      {props.busy ? (
        <button
          type="button"
          title={strings.shell.withKeys(strings.shell.stop, props.stopKeys)}
          aria-label={strings.shell.stop}
          onClick={props.onStop}
        >
          <Icon path={ICONS.stop} />
        </button>
      ) : (
        <button
          type="button"
          title={strings.shell.withKeys(strings.shell.run, props.runKeys)}
          aria-label={strings.shell.run}
          onClick={props.onRun}
        >
          <Icon path={ICONS.run} />
        </button>
      )}
      {props.busy && <output className="activity-spinner" aria-label={strings.shell.running} />}
      <button
        type="button"
        title={strings.shell.snippets}
        aria-label={strings.shell.snippets}
        aria-pressed={open("snippets")}
        onClick={() => props.onPanel("snippets")}
      >
        <Icon path={ICONS.snippets} />
      </button>
      <button type="button" title={strings.shell.laterMilestone} aria-label={strings.shell.npm} disabled>
        <Icon path={ICONS.npm} />
      </button>
      <button
        type="button"
        title={strings.shell.aiChat}
        aria-label={strings.shell.aiChat}
        aria-pressed={open("ai")}
        onClick={() => props.onPanel("ai")}
      >
        <Icon path={ICONS.ai} />
      </button>
      <div className="activity-spacer" />
      <button
        type="button"
        title={
          props.canOpenSettings
            ? strings.shell.withKeys(strings.shell.settings, props.settingsKeys)
            : strings.shell.laterMilestone
        }
        aria-label={strings.shell.settings}
        disabled={!props.canOpenSettings}
        onClick={props.onSettings}
      >
        <Icon path={ICONS.settings} />
      </button>
    </nav>
  );
}
