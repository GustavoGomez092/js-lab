import type { E2EUiMethod } from "@jslab/rpc-schema";
import type { ExecuteResult } from "../commands/registry";
import type { EditorHandle, TsDiagnostic } from "../editor/editor-handle";
import type { InstallAction } from "../editor/install-assist";
import type { AppStore } from "../state/store";
import { typeIntoField } from "./fields";
import { keyEventInit } from "./keys";
import type { LayoutMetrics } from "./layout-metrics";
import { snapshotOutput, snapshotState } from "./snapshot";

/** A DOM element's viewport box, in CSS pixels -- which are also Electrobun DIPs (`overlaySync.ts`). */
export interface RectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * M4 diagnostics for the "the Web View paints over the console" user report -- measurement, not a feature.
 *
 * A native `<electrobun-webview>` surface paints above all HTML regardless of `z-index`, so CSS cannot arbitrate
 * it and the console rows it covers are a *paint* defect, not a data defect. The open question these numbers
 * answer is whether the frame JS ships to the native layer is itself wrong: `OverlaySyncController.sync()`
 * (`apps/desktop/.hutch/devkit/api/preload/overlaySync.ts`) measures the `<electrobun-webview>` element's own
 * `getBoundingClientRect()` and sends exactly that as the native frame. If that rect does NOT overlap `.output`,
 * the frame requested is correct and the defect is below the JS boundary (native placement/scale/inset); if it
 * DOES overlap, the defect is in this app's own rect plumbing.
 */
export interface OverlayDiagnostics {
  /** Keyed by role: the docked tile, the native surface element, and the console pane. `null` when absent. */
  rects: Record<string, RectSnapshot | null>;
  /** How many `<electrobun-webview>` elements exist, so a single-tab reading is unambiguous. */
  webviewCount: number;
  /** The window's inner box, so a degenerate rect can be read against the space it had available. */
  viewport: { width: number; height: number };
  /**
   * The re-measure/re-render counters (see `webViewTileCounters`): the tile's own `measures`/`renders`, plus
   * `hosts`/`app` render counts and `appInputs` -- how often each of `App`'s own subscriptions changed identity.
   * Together these say where an idle-window re-render loop starts, not just that one exists.
   */
  counters: {
    measures: number;
    /** How many of those `measures` got past the rect equality guard and actually committed new state. */
    rectCommits: number;
    renders: number;
    hosts: number;
    app: number;
    appInputs: Record<string, number>;
    /** The most recent `runState` transitions as `"<previous>-><next>"`, naming the values a count alone cannot. */
    runStateTrail: string[];
  };
}

export interface E2EAgentDeps {
  store: AppStore;
  /** Runs a command id through the registry. */
  executeCommand(id: string, args?: unknown): ExecuteResult;
  editor(): Pick<EditorHandle, "typeText"> | null;
  /** Where synthetic keys are dispatched; the app passes the focused element. */
  target(): EventTarget;
  /** Monaco action ids from EDITOR_ACTIONS that don't exist in this Monaco build (verification step). */
  missingEditorActions?(): string[];
  editorOptions?(): Record<string, unknown> | null;
  /** Which layout regions are currently mounted, keyed by name (verification step, Task 16). */
  regions?(): Record<string, boolean>;
  /** M4 diagnostics: live geometry of the console/webview surfaces plus the Web View tile's re-measure counters. */
  overlayDiagnostics?(): OverlayDiagnostics;
  /**
   * M5e: real measured geometry of the shell's own regions, with the text each box contained, so an E2E scenario
   * can assert the UI still lays out under a non-English locale. Separate from `overlayDiagnostics`, which answers
   * a native-surface question and is read by the two webview scenarios.
   */
  layoutMetrics?(): LayoutMetrics;
  /** Every command id registered in the UI command registry (Task 22 verification: every menu action is dispatchable). */
  registeredCommands?(): string[];
  /** Monaco's TypeScript markers for the shown tab (Task 21). */
  tsDiagnostics?(): Promise<TsDiagnostic[]>;
  completions?(offset: number): Promise<string[]>;
  /** The editor's install-assist actions for its current markers (Task 23). */
  installActions?(): Promise<InstallAction[]>;
  /** XT-11: the editor's fold and scroll state, so a scenario can check a format left both alone. */
  viewGeometry?(): { scrollTop: number; folding: string } | null;
  /**
   * XT-11: folds every foldable region (Monaco's `editor.foldAll`). A named fold trigger rather than a general
   * "run any Monaco action" hook, which would be an escape hatch around the command registry. It exists because
   * a synthetic keystroke cannot reach Monaco's own keybinding dispatch (see `packages/e2e/src/app.ts`'s `key`).
   */
  foldAll?(): boolean;
}

/** E2E-only command: clicks a temporary link inside the page, as a user clicking a web link would (R-M1-17(e)). */
export const E2E_OPEN_LINK = "e2e.openLink";
export const E2E_COMPLETIONS = "e2e.completions";
export const E2E_INSTALL_ACTIONS = "e2e.installActions";
export const E2E_FOLD_ALL = "e2e.foldAll";

function openLink(args: unknown): { executed: string } {
  const href = (args as { href?: unknown } | undefined)?.href;
  if (typeof href !== "string" || !/^https?:\/\//.test(href)) throw new Error("e2e.openLink needs an http(s) URL");
  const link = document.createElement("a");
  link.href = href;
  link.dataset.e2eLink = "";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
  return { executed: E2E_OPEN_LINK };
}

/**
 * Answers Main's `e2e.request` messages (spec §22.3). Main has already validated params with zod,
 * so the agent only narrows their types. Only installed for JSLAB_E2E=1 launches.
 */
export function createE2EAgent(deps: E2EAgentDeps) {
  return async (method: E2EUiMethod, params: unknown): Promise<unknown> => {
    switch (method) {
      case "type": {
        const { text, replace } = params as { text: string; replace?: boolean };
        if (typeIntoField(deps.target(), text, replace === true)) return { typed: text.length };
        const editor = deps.editor();
        if (!editor) throw new Error("No editor is mounted");
        editor.typeText(text, replace === true);
        return { typed: text.length };
      }
      case "key": {
        const init = keyEventInit((params as { key: string }).key);
        const target = deps.target();
        const notPrevented = target.dispatchEvent(new KeyboardEvent("keydown", init));
        target.dispatchEvent(new KeyboardEvent("keyup", init));
        return { defaultPrevented: !notPrevented };
      }
      case "command": {
        const { id, args } = params as { id: string; args?: unknown };
        if (id === E2E_OPEN_LINK) return openLink(args);
        if (id === E2E_COMPLETIONS) {
          const offset = Number((args as { offset?: unknown } | undefined)?.offset ?? 0);
          return { executed: E2E_COMPLETIONS, completions: (await deps.completions?.(offset)) ?? [] };
        }
        if (id === E2E_INSTALL_ACTIONS)
          return { executed: E2E_INSTALL_ACTIONS, actions: (await deps.installActions?.()) ?? [] };
        if (id === E2E_FOLD_ALL) return { executed: E2E_FOLD_ALL, folded: deps.foldAll?.() ?? false };
        const result = deps.executeCommand(id, args);
        if (result === "unknown") throw new Error(`Unknown command: ${id}`);
        if (result === "disabled") throw new Error(`Command is disabled: ${id}`);
        return { executed: id };
      }
      case "state":
        return {
          ...snapshotState(deps.store.getState()),
          missingEditorActions: deps.missingEditorActions?.() ?? [],
          editorOptions: deps.editorOptions?.() ?? null,
          regions: deps.regions?.() ?? {},
          overlayDiagnostics: deps.overlayDiagnostics?.() ?? null,
          layoutMetrics: deps.layoutMetrics?.() ?? null,
          registeredCommands: deps.registeredCommands?.() ?? [],
          tsDiagnostics: (await deps.tsDiagnostics?.()) ?? [],
          viewGeometry: deps.viewGeometry?.() ?? null,
        };
      case "output":
        return { entries: snapshotOutput(deps.store.getState(), (params as { tabId?: string }).tabId) };
    }
  };
}
