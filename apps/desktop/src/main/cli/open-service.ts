import type { CliOpenParams, CliOpenResult, FileOpened, TabWithContent } from "@jslab/rpc-schema";
import { contentHash, type Language, languageForPath, type Runtime, type TabState } from "@jslab/shared";
import type { Log } from "../rpc/validate";
import type { SessionStore } from "../services/session-store";

export interface OpenServiceDeps {
  session: Pick<SessionStore, "createTab" | "findTabByPath" | "activateTab" | "patchTab">;
  readBoundedFile(path: string): Promise<string>;
  /** `run.defaultLanguage` / `run.defaultRuntime` at the moment of the call (spec §8, §16.2). */
  defaults(): { language: Language; runtime: Runtime };
  /** The existing `file.opened` push; the UI's `handleOpened` already renders it. */
  announce(payload: FileOpened): void;
  /**
   * The `tab.updated` push, for a tab Main changed on its own. `file.opened` cannot carry it: it announces tabs that
   * were just created, and the UI's `openTab` ignores an id it already holds (store.ts). Same shape and same UI
   * handler (`applyTabUpdate`) as `wd.changed`.
   */
  updated(payload: { tabId: string; tab: TabState }): void;
  /** Focus (or reopen) the window, then run the now-active tab when `--run` was passed. */
  present(options: { run: boolean }): void;
  log: Log;
}

/**
 * `open` (spec §16.3). Every tab comes from `SessionStore.createTab` and every announcement from `file.opened`, so a
 * CLI-opened tab is indistinguishable from one opened through File → Open. A file already open is focused rather than
 * opened twice (§10.2), and a file that can't be read is reported alongside the ones that worked.
 */
export function createOpenService(deps: OpenServiceDeps): (params: CliOpenParams) => Promise<CliOpenResult> {
  return async (params) => {
    const workingDirectory = params.cwd ?? null;
    const titleFields = params.title === undefined ? {} : { title: params.title, titleIsCustom: true };
    const tabIds: string[] = [];
    const tabs: TabWithContent[] = [];
    const errors: string[] = [];
    let focusTabId: string | null = null;

    for (const path of params.files ?? []) {
      const existing = deps.session.findTabByPath(path);
      if (existing) {
        focusTabId = existing.id;
        tabIds.push(existing.id);
        // R-M5c-TITLE-1: `--title` names the tab the user asked for, so an already-open tab takes it too. Returning
        // here without applying it would discard a flag the user typed, with no diagnostic anywhere.
        if (params.title !== undefined) {
          const rename = { title: params.title, titleIsCustom: true } as const;
          await deps.session.patchTab(existing.id, rename);
          // ...and tell the UI, or only Main knows. The tab bar would keep showing the old title, and the UI's own
          // `tab.patch` -- which used to carry title/titleIsCustom on every tracked change -- pushed that stale
          // title straight back over this rename on the next divider drag (M5c F3).
          deps.updated({ tabId: existing.id, tab: { ...existing, ...rename } });
        }
        continue;
      }
      let content: string;
      try {
        content = await deps.readBoundedFile(path);
      } catch (error) {
        deps.log("The jslab CLI couldn't read a file", { path, error: String(error) });
        errors.push(`${path} couldn't be read.`);
        continue;
      }
      const tab = await deps.session.createTab({
        filePath: path,
        language: params.lang ?? languageForPath(path),
        content,
        lastSavedHash: contentHash(content),
        workingDirectory,
        ...(params.runtime === undefined ? {} : { runtime: params.runtime }),
        ...titleFields,
      });
      tabIds.push(tab.id);
      tabs.push({ tab, content });
    }

    if (params.code !== undefined) {
      const defaults = deps.defaults();
      const tab = await deps.session.createTab({
        language: params.lang ?? defaults.language,
        runtime: params.runtime ?? defaults.runtime,
        content: params.code,
        workingDirectory,
        ...titleFields,
      });
      tabIds.push(tab.id);
      tabs.push({ tab, content: params.code });
    }

    // Nothing opened and something was asked for: that is a failed request, and `handleLine` turns this throw into
    // the spec's `{ id, ok: false, error }` reply rather than a success with an empty list.
    if (tabIds.length === 0) throw new Error(errors.join(" · ") || "Nothing to open");

    // Main's `activeTabId` only ever moves inside `createTab` (session-store.ts:213), so a request that opened no new
    // tab would leave the previously-active tab active -- and `--run` runs the ACTIVE tab. With the window closed,
    // `file.opened` is skipped (index.ts:574), so the UI's `handleOpened` -- the only code that honours `focusTabId`
    // (file-flows.ts:143) -- never runs to correct it, and `jslab --run already-open.ts` would execute whatever tab
    // happened to be active. Activating here mirrors `handleOpened`'s own precedence (`focusTabId` wins over the last
    // created tab), so Main and the UI agree whether the window was open or closed.
    if (focusTabId !== null) deps.session.activateTab(focusTabId);

    deps.announce({ tabs, focusTabId, large: [], errors });
    deps.present({ run: params.run === true });
    return { tabIds };
  };
}
