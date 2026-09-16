import { isAbsolute } from "node:path";
import { tabParamsSchema } from "@jslab/rpc-schema";
import type { TabState } from "@jslab/shared";
import type { SparePool } from "../runs/spare-pool";
import type { SessionStore } from "../services/session-store";
import type { TypesService } from "../services/types-service";
import { createValidators, type Log } from "./validate";

export interface WorkingDirectoryHandlerDeps {
  session: Pick<SessionStore, "session" | "setWorkingDirectory">;
  /** The native folder picker (or the E2E stub); resolves the chosen folder or null. */
  pickFolder(options: { startingFolder: string }): Promise<string | null>;
  isDirectory(path: string): Promise<boolean>;
  documentsDir: string;
  spares: Pick<SparePool, "invalidate" | "setActiveTab">;
  types: Pick<TypesService, "invalidate">;
  send: { changed(payload: { tabId: string; tab: TabState }): void };
  log: Log;
}

/** Actions → Set/Clear Working Directory and the WD chip (spec §12.2). */
export function createWorkingDirectoryHandlers(deps: WorkingDirectoryHandlerDeps) {
  const { message } = createValidators(deps.log);
  // R-M3-T18-FIX-1 M-2: tabs whose folder picker is open. A second wd.pick for one of them opens nothing.
  const picking = new Set<string>();

  const apply = (tabId: string, workingDirectory: string | null) => {
    // M-3: a change that changes nothing does nothing: no commit, no spare restart, no types clear, no wd.changed.
    if ((deps.session.session.tabs[tabId]?.workingDirectory ?? null) === workingDirectory) return;
    const tab = deps.session.setWorkingDirectory(tabId, workingDirectory);
    if (!tab) return;
    deps.spares.invalidate(tabId);
    deps.spares.setActiveTab(deps.session.session.activeTabId);
    deps.types.invalidate();
    deps.send.changed({ tabId, tab });
  };

  return {
    requests: {},
    messages: {
      "wd.pick": message(tabParamsSchema, "wd.pick", async ({ tabId }) => {
        const tab = deps.session.session.tabs[tabId];
        if (!tab || picking.has(tabId)) return;
        picking.add(tabId);
        try {
          const current =
            tab.workingDirectory && (await deps.isDirectory(tab.workingDirectory)) ? tab.workingDirectory : null;
          const picked = await deps.pickFolder({
            startingFolder: current ?? deps.session.session.lastDirectory ?? deps.documentsDir,
          });
          // N-4: only an absolute folder is applied; anything else counts as a cancel.
          if (!picked || !isAbsolute(picked) || !(await deps.isDirectory(picked))) return;
          apply(tabId, picked);
        } finally {
          picking.delete(tabId);
        }
      }),
      "wd.clear": message(tabParamsSchema, "wd.clear", ({ tabId }) => apply(tabId, null)),
    },
  };
}
