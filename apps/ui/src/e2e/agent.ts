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

/**
 * EX-35: one tab-audio indicator as it actually exists in the tab bar, read off the rendered element.
 *
 * **Every field here is read from the DOM, never from `store.tabs[].layout.muted` or `runtimes[].audioActive`.**
 * That is the whole point of this reporter, and the same rule `editorOptions` follows by returning what Monaco
 * reports rather than what the settings say (`apps/ui/src/editor/Editor.tsx`). A reporter that echoed the store
 * would stay green no matter what `AudioIndicator` rendered -- including if it rendered nothing at all -- so it
 * could not tell "the control is on screen saying it is muted" from "the store holds `muted: true`". The unit
 * tests already pin the component against props; only the built app can say the attributes reached the screen.
 */
export interface AudioIndicatorReport {
  /**
   * The enclosing tab row's own `.tab-title` text, so a reading names WHICH tab is making noise. Note this is
   * the tab *label* (`tabLabel()`, which may carry a working directory), while the accessible name below is
   * built from the bare title -- they coincide for a tab with no working directory.
   */
  tabTitle: string;
  /** The row's `aria-selected`, read off the row element: whether the noisy tab is the one in front. */
  tabSelected: string | null;
  /** `BUTTON` for a real control; anything else means the "not a div with a click handler" claim regressed. */
  tagName: string;
  /** Raw attributes, uninterpreted: a missing attribute reads `null` rather than a plausible-looking `false`. */
  ariaPressed: string | null;
  ariaLabel: string | null;
  className: string;
  /** The glyph actually rendered (🔊 / 🔇). */
  glyph: string;
  /** Real measured geometry: a control that is present but has collapsed to nothing is not "on screen". */
  width: number;
  height: number;
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
  /** EX-35: the tab bar's audio indicators as rendered, attribute by attribute. See `AudioIndicatorReport`. */
  audioIndicators?(): AudioIndicatorReport[];
}

/** E2E-only command: clicks a temporary link inside the page, as a user clicking a web link would (R-M1-17(e)). */
export const E2E_OPEN_LINK = "e2e.openLink";
/** E2E-only command: activates the first URL rendered in an output row (OU-13), by Cmd-click or by keyboard. */
export const E2E_OPEN_OUTPUT_LINK = "e2e.openOutputLink";
export const E2E_COMPLETIONS = "e2e.completions";
export const E2E_INSTALL_ACTIONS = "e2e.installActions";
export const E2E_FOLD_ALL = "e2e.foldAll";
/** E2E-only command: clicks a tab's own audio indicator, as a user muting a noisy tab would (EX-35). */
export const E2E_TOGGLE_TAB_AUDIO = "e2e.toggleTabAudio";
/** E2E-only command: clicks the About dialog's Open-Source Notices button (ST-13). */
export const E2E_ABOUT_NOTICES = "e2e.aboutNotices";

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
 * OU-13. Activates a URL the running program printed into the output panel.
 *
 * A named trigger rather than a general "click any selector" hook, for the same reason `e2e.foldAll` is named:
 * the agent offers the gestures the product actually supports, not an escape hatch around them. Both gestures
 * are real DOM events on the real rendered control -- `bubbles` because React listens at the tree root -- so the
 * component's own handler is what decides whether anything opens.
 *
 * The keyboard path asserts the control took focus before pressing Enter, which is the accessibility claim
 * itself: a link only a modified click could reach would fail here rather than pass quietly.
 */
function openOutputLink(args: unknown): { executed: string; href: string } {
  const via = (args as { via?: unknown } | undefined)?.via ?? "click";
  const link = document.querySelector<HTMLElement>('[data-testid="output-link"]');
  if (!link) throw new Error("e2e.openOutputLink found no link in the output");
  if (via === "keyboard") {
    link.focus();
    if (document.activeElement !== link) throw new Error("e2e.openOutputLink could not focus the link");
    link.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  } else {
    link.dispatchEvent(new MouseEvent("click", { metaKey: true, bubbles: true, cancelable: true }));
  }
  return { executed: E2E_OPEN_OUTPUT_LINK, href: link.textContent ?? "" };
}

/** The tab bar's audio indicators with the tab row each sits in. One selector, shared by the reporter and trigger. */
function audioIndicatorElements(): { button: HTMLElement; row: Element | null }[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="tab-audio"]')].map((button) => ({
    button,
    row: button.closest('[role="tab"]'),
  }));
}

function rowTitle(row: Element | null): string {
  return (row?.querySelector(".tab-title")?.textContent ?? "").trim();
}

/**
 * EX-35. Reads every tab audio indicator's own rendered attributes. See `AudioIndicatorReport` for why this
 * must never consult the store.
 */
export function reportAudioIndicators(): AudioIndicatorReport[] {
  return audioIndicatorElements().map(({ button, row }) => {
    const { width, height } = button.getBoundingClientRect();
    return {
      tabTitle: rowTitle(row),
      tabSelected: row?.getAttribute("aria-selected") ?? null,
      tagName: button.tagName,
      ariaPressed: button.getAttribute("aria-pressed"),
      ariaLabel: button.getAttribute("aria-label"),
      className: button.className,
      glyph: (button.textContent ?? "").trim(),
      width,
      height,
    };
  });
}

/**
 * EX-35. Clicks one tab's audio indicator, as a user silencing a noisy tab would.
 *
 * A named trigger for the same reason `e2e.openOutputLink` and `e2e.foldAll` are named (see `openOutputLink`
 * above): there is no command id behind this control -- `TabBar` wires it straight to `toggleMuted` -- so the
 * only honest way to exercise it is a real event on the real rendered button.
 *
 * The click deliberately `bubbles`, because the thing most worth proving here is what the component *stops*:
 * the indicator sits inside its tab's own clickable row, and `AudioIndicator`'s `stopPropagation` is all that
 * keeps muting a background tab from also switching to it. A non-bubbling click could not tell the difference.
 * Focus is asserted first, so a control that a mouse alone could reach fails loudly instead of passing quietly.
 */
function toggleTabAudio(args: unknown): { executed: string; tabTitle: string; pressedBefore: string | null } {
  const wanted = (args as { title?: unknown } | undefined)?.title;
  const all = audioIndicatorElements();
  const found = typeof wanted === "string" ? all.filter((entry) => rowTitle(entry.row) === wanted) : all;
  const [target] = found;
  const onScreen = `${all.length} on screen: [${all.map((entry) => rowTitle(entry.row)).join(", ")}]`;
  if (!target) {
    const which = typeof wanted === "string" ? ` for tab "${wanted}"` : "";
    throw new Error(`e2e.toggleTabAudio found no audio indicator${which}; ${onScreen}`);
  }
  if (found.length > 1) throw new Error(`e2e.toggleTabAudio matched ${found.length} indicators; ${onScreen}`);
  target.button.focus();
  if (document.activeElement !== target.button)
    throw new Error("e2e.toggleTabAudio could not focus the indicator: it is not keyboard-reachable");
  const pressedBefore = target.button.getAttribute("aria-pressed");
  target.button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return { executed: E2E_TOGGLE_TAB_AUDIO, tabTitle: rowTitle(target.row), pressedBefore };
}

/**
 * ST-13. Clicks the About dialog's Open-Source Notices button, which -- like the audio indicator -- has no
 * command id behind it: it calls `api.appCommand("openThirdPartyNotices")` directly. Dispatching that action
 * from the harness instead would skip the dialog entirely and prove nothing about the button on screen.
 */
function aboutNotices(): { executed: string; label: string } {
  const button = document.querySelector<HTMLElement>('[data-testid="about-notices"]');
  if (!button) throw new Error("e2e.aboutNotices found no Open-Source Notices button (is the About dialog open?)");
  button.focus();
  if (document.activeElement !== button)
    throw new Error("e2e.aboutNotices could not focus the notices button: it is not keyboard-reachable");
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return { executed: E2E_ABOUT_NOTICES, label: (button.textContent ?? "").trim() };
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
        if (id === E2E_OPEN_OUTPUT_LINK) return openOutputLink(args);
        if (id === E2E_COMPLETIONS) {
          const offset = Number((args as { offset?: unknown } | undefined)?.offset ?? 0);
          return { executed: E2E_COMPLETIONS, completions: (await deps.completions?.(offset)) ?? [] };
        }
        if (id === E2E_INSTALL_ACTIONS)
          return { executed: E2E_INSTALL_ACTIONS, actions: (await deps.installActions?.()) ?? [] };
        if (id === E2E_FOLD_ALL) return { executed: E2E_FOLD_ALL, folded: deps.foldAll?.() ?? false };
        if (id === E2E_TOGGLE_TAB_AUDIO) return toggleTabAudio(args);
        if (id === E2E_ABOUT_NOTICES) return aboutNotices();
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
          audioIndicators: deps.audioIndicators?.() ?? [],
        };
      case "output":
        return { entries: snapshotOutput(deps.store.getState(), (params as { tabId?: string }).tabId) };
    }
  };
}
