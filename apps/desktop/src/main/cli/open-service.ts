import type { CliOpenParams, CliOpenResult, FileOpened, TabWithContent } from "@jslab/rpc-schema";
import { contentHash, type Language, languageForPath, type Runtime } from "@jslab/shared";
import type { Log } from "../rpc/validate";
import type { SessionStore } from "../services/session-store";

export interface OpenServiceDeps {
  session: Pick<SessionStore, "createTab" | "findTabByPath">;
  readFile(path: string): Promise<string>;
  /** `run.defaultLanguage` / `run.defaultRuntime` at the moment of the call (spec §8, §16.2). */
  defaults(): { language: Language; runtime: Runtime };
  /** The existing `file.opened` push; the UI's `handleOpened` already renders it. */
  announce(payload: FileOpened): void;
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
        continue;
      }
      let content: string;
      try {
        content = await deps.readFile(path);
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

    deps.announce({ tabs, focusTabId, large: [], errors });
    deps.present({ run: params.run === true });
    return { tabIds };
  };
}
