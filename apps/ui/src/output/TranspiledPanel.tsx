import { useEffect, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";

/**
 * Show Transpiled Output (spec §7.4): "a read-only side tab with the latest Babel output for the current tab. It
 * updates on each run, and a toggle hides the instrumentation calls." The side bar is this app's side-panel
 * region (R-M5a-6), so it lives there rather than inventing a second one.
 *
 * Refresh trigger: the active tab's `runId`. A new run means a new transform in Main, and `run.transpiled` reads
 * whatever that run produced -- so re-requesting on `runId` is exactly "updates on each run", with no polling.
 *
 * Between runs the output on screen can be for code the user has already changed, and in Safe Mode nothing is
 * armed for Auto Run, so that window is unbounded. R-M5a-7: say so, by comparing the buffer against the `source`
 * Main reports it transpiled. Deriving that source in the UI -- from the last payload sent to `run.start` -- would
 * be wrong exactly when it matters: a run that fails to transpile leaves Main serving the PREVIOUS successful
 * output, so the UI would call it fresh while showing older code.
 */
export function TranspiledPanel({ store, api }: { store: AppStore; api: Pick<MainApi, "transpiled"> }) {
  const tabId = useStore(store, (s) => s.activeTabId);
  const runId = useStore(store, (s) => s.output.runId);
  const code = useStore(store, (s) => s.code);
  const [hideInstrumentation, setHideInstrumentation] = useState(false);
  const [entry, setEntry] = useState<{ tabId: string; code: string; source: string } | null>(null);
  const [failed, setFailed] = useState(false);

  // `runId` is deliberately a dependency this effect never reads. It is the *reason* the effect re-runs: a new run
  // means a new transform in Main, and re-requesting on it is exactly "updates on each run" (spec §7.4). Removing
  // it would freeze the panel on the first run's output for the life of the tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above -- `runId` is the re-request trigger.
  useEffect(() => {
    if (!tabId) {
      setEntry(null);
      return;
    }
    let current = true;
    setFailed(false);
    api.transpiled(tabId, hideInstrumentation).then(
      (result) => {
        if (current) setEntry(result && { tabId, ...result });
      },
      () => {
        if (current) {
          setEntry(null);
          setFailed(true);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [api, tabId, runId, hideInstrumentation]);

  // A tab switch re-runs the effect but does not clear `entry`: React keeps the previous state until the new
  // request lands, so for one round trip the state still holds the *previous* tab's output. Rendering it would
  // attribute tab A's code to tab B, and because `stale` compares the entry's `source` against the active tab's
  // buffer it would also flash "Stale" at a tab that is not stale. Stamping each response with the tab it was
  // requested for, and showing it only while that still matches, makes the panel say "not run yet" for that
  // window instead -- which is the truth about tab B until its own output arrives.
  const shown = entry !== null && entry.tabId === tabId ? entry : null;
  const stale = shown !== null && shown.source !== code;

  return (
    <section className="side-bar transpiled-panel" aria-label={strings.transpiled.title}>
      <header className="transpiled-header">
        <h2>{strings.transpiled.title}</h2>
        {stale && <span className="transpiled-stale-label">{strings.transpiled.stale}</span>}
        <label className="transpiled-toggle">
          <input
            type="checkbox"
            checked={hideInstrumentation}
            onChange={(event) => setHideInstrumentation(event.target.checked)}
          />
          {strings.transpiled.hideInstrumentation}
        </label>
      </header>
      {shown === null ? (
        <p className="transpiled-empty">{failed ? strings.transpiled.failed : strings.transpiled.empty}</p>
      ) : (
        // Read-only by construction: a <pre>, never an editor (spec §7.4).
        <pre className="transpiled-code">{shown.code}</pre>
      )}
    </section>
  );
}
