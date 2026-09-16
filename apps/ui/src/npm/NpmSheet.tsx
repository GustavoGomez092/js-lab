import type { NpmOpError, NpmOperation, NpmSearchResult } from "@jslab/rpc-schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { writeSetting } from "../commands/settings-writer";
import { copyEntriesToClipboard } from "../output/copy";
import { useSheetFocus } from "../shell/sheet-focus";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import {
  createSearchScheduler,
  HIGHLIGHT_MS,
  installTargetFor,
  isHighlighted,
  isMajorUpdate,
  minutesSince,
  pendingFor,
  pendingInstallFor,
  shouldSearch,
  visibleInstalled,
} from "./npm-panel";

type NpmApi = Pick<
  MainApi,
  "npmList" | "npmSearch" | "npmInstall" | "npmRemove" | "npmUpdate" | "npmUpdateAll" | "updateSettings"
>;

/** Tools → NPM Packages… (spec §11.2), a modal sheet (spec §7.5). */
export function NpmSheet({ store, api }: { store: AppStore; api: NpmApi }) {
  const open = useStore(store, (s) => s.modal?.kind === "npm");
  // R26-2/Task 25 pattern: a fresh session per opening, so a closed sheet's local state (search, results,
  // arrow-key selection, dismissed failure cards) never lingers into the next opening.
  const session = useRef(0);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) session.current += 1;
  wasOpen.current = open;
  if (!open) return null;
  return <NpmPanel key={session.current} store={store} api={api} />;
}

function NpmPanel({ store, api }: { store: AppStore; api: NpmApi }) {
  const npm = useStore(store, (s) => s.npm);
  const allowScripts = useStore(store, (s) => s.settings?.npm.allowInstallScripts ?? false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NpmSearchResult[]>([]);
  const [searchError, setSearchError] = useState<NpmOpError | null>(null);
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [showTypes, setShowTypes] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const search = useRef<HTMLInputElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const queryRef = useRef(query);
  queryRef.current = query;
  // R25 pattern: a synchronous guard, since a second click in the same tick must not fire Allow Scripts and
  // Retry twice (writeSetting is async, like EnvVarsSheet's save()).
  const allowScriptsRetrying = useRef(false);
  // Fix round 2 (M-4): row buttons disable only once Main's queued echo makes the round trip, so a synchronous
  // guard covers the gap: one `kind:target` key per in-flight click, added before the API call and cleared once
  // a matching `npm.op` (queued, running or terminal) arrives.
  const pendingRef = useRef<Set<string>>(new Set());
  // Fix round 2 (M-5): invalidates an in-flight search response that resolves after a newer one, or after the
  // query was cleared by an install.
  const searchSeq = useRef(0);

  const scheduler = useMemo(
    () =>
      createSearchScheduler((text) => {
        searchSeq.current += 1;
        const seq = searchSeq.current;
        void api.npmSearch(text).then((response) => {
          if (searchSeq.current !== seq) return;
          setResults(response.results);
          setSearchError(response.error);
          setSearchedFor(text);
          setActive(null);
        });
      }),
    [api],
  );

  useEffect(() => {
    void api.npmList(true).then((list) => store.getState().receiveNpmList(list));
    search.current?.focus();
    return () => {
      scheduler.cancel();
      // M-4: a closed sheet's pending guard must never leak into the next opening.
      pendingRef.current.clear();
    };
  }, [api, store, scheduler]);

  useEffect(() => {
    if (!npm.lastAdded) return;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), HIGHLIGHT_MS + 50);
    return () => clearTimeout(timer);
  }, [npm.lastAdded]);

  // Fix round 2 (N-1): "Checked N min ago" otherwise keeps its mount-time value for as long as the sheet stays
  // open.
  useEffect(() => {
    if (npm.outdatedCheckedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [npm.outdatedCheckedAt]);

  // Fix round 2 (M-4): a key clears the moment Main's own echo of that kind/target arrives, whatever its status.
  useEffect(() => {
    for (const op of npm.operations) {
      const target = npm.rawTargets[op.id] ?? op.target;
      pendingRef.current.delete(`${op.kind}:${op.kind === "updateAll" ? "" : target}`);
    }
  }, [npm.operations, npm.rawTargets]);

  // R25 pattern: this panel exists only while the sheet is open, so its own mount/unmount is the open/close
  // transition.
  useSheetFocus(true, sheetRef);

  // R25 pattern: document capture-phase Escape, gated on the modal kind, so it works even when focus has left
  // the sheet's inputs. R26-2's own carve-out: when the search field is focused with a non-empty query, this
  // handler steps aside so the field's own onKeyDown can clear the query first instead of closing the sheet.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (store.getState().modal?.kind !== "npm") return;
      if (event.key !== "Escape") return;
      if (document.activeElement === search.current && queryRef.current.trim() !== "") return;
      event.preventDefault();
      store.getState().closeModal();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [store]);

  /** M-4: runs `action` unless `key` is already pending; marks it pending synchronously, before the API call. */
  const guarded = (key: string, action: () => void) => {
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    action();
  };

  const install = (spec: string) => {
    guarded(`install:${spec}`, () => api.npmInstall(spec));
    setQuery("");
    setResults([]);
    setSearchedFor(null);
    setActive(null);
    // M-5: a still-in-flight search for the cleared query must not repopulate the list once it resolves.
    searchSeq.current += 1;
    scheduler.cancel();
  };

  // M-2: the stored target is masked; Retry needs the real spec, kept apart in npm.rawTargets.
  const rawTargetFor = (op: NpmOperation) => npm.rawTargets[op.id] ?? op.target;

  const retry = (op: NpmOperation) => {
    const target = rawTargetFor(op);
    if (op.kind === "install") guarded(`install:${target}`, () => api.npmInstall(target));
    else if (op.kind === "update") guarded(`update:${target}`, () => api.npmUpdate(target));
    else if (op.kind === "remove") guarded(`remove:${target}`, () => api.npmRemove(target));
    else guarded("updateAll:", () => api.npmUpdateAll());
  };

  const allowScriptsAndRetry = async (op: NpmOperation) => {
    if (allowScriptsRetrying.current) return;
    allowScriptsRetrying.current = true;
    try {
      await writeSetting(store, api, "npm.allowInstallScripts", () => true);
      retry(op);
    } finally {
      allowScriptsRetrying.current = false;
    }
  };

  // I-2: the store already masks `error.log` once, on arrival (receiveNpmOperation); never re-mask at render.
  const copyLog = async (log: string) => {
    const result = await copyEntriesToClipboard(log);
    setCopyStatus(result);
  };

  const running = npm.operations.find((op) => op.status === "running");
  const queued = npm.operations.filter((op) => op.status === "queued").length;
  const lastDone = [...npm.operations]
    .reverse()
    .find((op) => (op.status === "failed" || op.status === "succeeded") && !dismissed.has(op.id));
  const currentLogOp = running ?? lastDone;
  const failedOp =
    lastDone && lastDone.status === "failed" && lastDone.error ? { ...lastDone, error: lastDone.error } : null;
  const visible = visibleInstalled(npm.installed, showTypes);
  const outdated = npm.installed.filter((pkg) => pkg.latest !== null);
  const majors = outdated.filter((pkg) => isMajorUpdate(pkg.version, pkg.latest)).length;
  const allTypesHidden = npm.loaded && npm.installed.length > 0 && !showTypes && visible.length === 0;
  // M-4: Update all also disables while an updateAll is already queued or running, not only when nothing's outdated.
  const updateAllPending = npm.operations.some(
    (op) => op.kind === "updateAll" && (op.status === "queued" || op.status === "running"),
  );

  return (
    <div className="dialog-backdrop">
      <div ref={sheetRef} className="sheet npm-sheet" role="dialog" aria-modal="true" aria-label={strings.npm.title}>
        <h2>{strings.npm.title}</h2>
        <input
          ref={search}
          type="search"
          className="npm-search"
          aria-label={strings.npm.searchLabel}
          aria-controls="npm-results"
          aria-activedescendant={active !== null ? `npm-result-${active}` : undefined}
          placeholder={strings.npm.searchPlaceholder}
          value={query}
          onChange={(event) => {
            const value = event.target.value;
            setQuery(value);
            setActive(null);
            if (shouldSearch(value)) {
              scheduler.input(value.trim());
            } else {
              searchSeq.current += 1;
              scheduler.cancel();
              setResults([]);
              setSearchError(null);
              setSearchedFor(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query.trim() !== "") {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
              setResults([]);
              setSearchError(null);
              setSearchedFor(null);
              setActive(null);
              searchSeq.current += 1;
              scheduler.cancel();
              return;
            }
            if (event.key === "ArrowDown" && results.length > 0) {
              event.preventDefault();
              setActive((current) => (current === null ? 0 : Math.min(current + 1, results.length - 1)));
              return;
            }
            if (event.key === "ArrowUp" && results.length > 0) {
              event.preventDefault();
              setActive((current) => (current === null ? results.length - 1 : Math.max(current - 1, 0)));
              return;
            }
            if (event.key !== "Enter") return;
            if (active !== null && results[active]) {
              event.preventDefault();
              install(results[active].name);
              return;
            }
            const target = installTargetFor(query, results);
            if (target) {
              event.preventDefault();
              install(target);
            }
          }}
        />
        {searchError && (
          <p className="sheet-status" role="alert">
            {strings.npm.hints[searchError.kind]}
          </p>
        )}
        {searchedFor === query.trim() && results.length === 0 && !searchError && (
          <p className="sheet-status">{strings.npm.noResults(searchedFor)}</p>
        )}
        {results.length > 0 && (
          <div id="npm-results" role="listbox" className="npm-results">
            {results.map((result, index) => {
              const installedPkg = npm.installed.find((pkg) => pkg.name === result.name);
              // M-6: only a pending *install* of this exact package, matched by name (not the literal spec).
              const pendingInstall = pendingInstallFor(npm.operations, result.name);
              return (
                <div
                  key={result.name}
                  id={`npm-result-${index}`}
                  role="option"
                  tabIndex={-1}
                  aria-selected={active === index}
                  className="npm-result"
                >
                  <div>
                    <strong>{result.name}</strong> <span className="npm-version">{result.version}</span>
                    <p>{result.description}</p>
                    {result.weeklyDownloads !== null && (
                      <span className="npm-downloads">{strings.npm.weekly(result.weeklyDownloads)}</span>
                    )}
                  </div>
                  {pendingInstall ? (
                    <span className="npm-version">{strings.npm.adding}</span>
                  ) : installedPkg ? (
                    <span className="npm-version">{strings.npm.installedVersion(installedPkg.version ?? "?")}</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={strings.npm.add(result.name)}
                      onClick={() => install(result.name)}
                    >
                      {strings.npm.addButton}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className="npm-toolbar">
          <label>
            <input
              type="checkbox"
              checked={allowScripts}
              onChange={(event) => void writeSetting(store, api, "npm.allowInstallScripts", () => event.target.checked)}
            />
            {strings.npm.allowScripts}
          </label>
          <label>
            <input type="checkbox" checked={showTypes} onChange={(event) => setShowTypes(event.target.checked)} />
            {strings.npm.showTypes}
          </label>
          <button
            type="button"
            disabled={outdated.length === 0 || updateAllPending}
            title={strings.npm.updateAllTitle(outdated.length, majors)}
            onClick={() => guarded("updateAll:", () => api.npmUpdateAll())}
          >
            {strings.npm.updateAll}
          </button>
        </div>
        {npm.outdatedCheckedAt !== null && (
          <p className="sheet-help npm-checked">{strings.npm.checkedAgo(minutesSince(npm.outdatedCheckedAt, now))}</p>
        )}
        {npm.outdatedError && (
          <p className="sheet-status" role="alert">
            {strings.npm.outdatedFailed(strings.npm.hints[npm.outdatedError.kind])}
          </p>
        )}
        {running && <p className="sheet-status">{strings.npm.running(running.kind, running.target, queued)}</p>}
        {failedOp && (
          <div className="npm-failure" role="alert">
            <p>
              {strings.npm.failed(failedOp.kind, failedOp.target)} <span>{strings.npm.hints[failedOp.error.kind]}</span>
            </p>
            <details>
              <summary>{strings.npm.log}</summary>
              <pre>{failedOp.error.log}</pre>
            </details>
            <div className="dialog-actions">
              <button type="button" onClick={() => retry(failedOp)}>
                {strings.npm.retry}
              </button>
              {failedOp.error.kind === "scriptBlocked" && (
                <button type="button" onClick={() => void allowScriptsAndRetry(failedOp)}>
                  {strings.npm.allowAndRetry}
                </button>
              )}
              <button type="button" onClick={() => void copyLog(failedOp.error.log)}>
                {strings.npm.copyLog}
              </button>
              {/* N-2: Dismiss is local only (R26-4); it no longer frees the store's log buffer, which age-out
                  already bounds, so a dismissed card's drawer doesn't go empty if it's reopened. */}
              <button type="button" onClick={() => setDismissed((current) => new Set(current).add(failedOp.id))}>
                {strings.npm.dismiss}
              </button>
            </div>
            {copyStatus !== "idle" && (
              <p className="sheet-status" role="status">
                {copyStatus === "copied" ? strings.output.copied : strings.output.copyFailed}
              </p>
            )}
          </div>
        )}
        {lastDone?.status === "succeeded" && lastDone.notice === "scriptBlocked" && (
          <p className="sheet-status">{strings.npm.scriptBlocked}</p>
        )}
        <div className="npm-installed">
          <table aria-busy={Boolean(running)}>
            <thead>
              <tr>
                <th>{strings.npm.name}</th>
                <th>{strings.npm.version}</th>
                <th>{strings.npm.latest}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visible.map((pkg) => {
                const rowPending = pendingFor(npm.operations, pkg.name, pkg.latest !== null);
                return (
                  <tr key={pkg.name} className={isHighlighted(npm.lastAdded, pkg.name, now) ? "npm-new" : undefined}>
                    <td>{pkg.name}</td>
                    <td>{pkg.version ?? "—"}</td>
                    <td>
                      {pkg.latest ?? ""}
                      {pkg.latest && isMajorUpdate(pkg.version, pkg.latest) && (
                        <span className="npm-major" title={strings.npm.majorTitle(pkg.name, pkg.version, pkg.latest)}>
                          {strings.npm.major}
                        </span>
                      )}
                      {rowPending && (
                        <span className="npm-row-status">
                          {strings.npm.rowStatus(rowPending.kind, rowPending.status)}
                        </span>
                      )}
                      {pkg.latest && (
                        <button
                          type="button"
                          aria-label={strings.npm.update(pkg.name)}
                          disabled={Boolean(rowPending)}
                          onClick={() => guarded(`update:${pkg.name}`, () => api.npmUpdate(pkg.name))}
                        >
                          {strings.npm.updateButton}
                        </button>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        aria-label={strings.npm.remove(pkg.name)}
                        disabled={Boolean(rowPending)}
                        onClick={() => guarded(`remove:${pkg.name}`, () => api.npmRemove(pkg.name))}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {npm.loaded && npm.installed.length === 0 && <p className="sheet-status">{strings.npm.none}</p>}
          {allTypesHidden && <p className="sheet-status">{strings.npm.typesHidden(npm.installed.length)}</p>}
        </div>
        <details className="npm-log">
          <summary>{strings.npm.log}</summary>
          <pre>{currentLogOp ? (npm.logs[currentLogOp.id] ?? "") : ""}</pre>
        </details>
      </div>
    </div>
  );
}
