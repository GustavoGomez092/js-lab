import { dirname, join } from "node:path";
import {
  emptyParamsSchema,
  type FileOpened,
  type FileSaveResult,
  fileConfirmLargeSchema,
  fileConfirmSaveAsSchema,
  fileSaveParamsSchema,
  type TabWithContent,
  tabParamsSchema,
} from "@jslab/rpc-schema";
import { contentHash, deriveTitle, extensionFor, languageForPath, type TabState } from "@jslab/shared";
import type { FileService, ReadyFile } from "../files/file-service";
import type { SessionStore } from "../services/session-store";
import { strings } from "../strings";
import { createValidators, type Log } from "./validate";

export interface FileHandlerDeps {
  files: Pick<FileService, "prepareOpen" | "confirmLarge" | "write" | "issueSaveAsToken" | "takeSaveAsToken">;
  session: Pick<SessionStore, "session" | "createTab" | "patchTab" | "findTabByPath" | "setLastDirectory">;
  openDialog(options: { startingFolder: string }): Promise<string[]>;
  saveDialog(options: { defaultName: string; defaultDir: string }): Promise<string | null>;
  documentsDir: string;
  revealInFinder(path: string): void;
  clipboard(text: string): void;
  send: {
    opened(payload: FileOpened): void;
    saved(payload: { tabId: string; tab: TabState }): void;
    saveAsConfirm(payload: { token: string; tabId: string; path: string }): void;
    saveCancelled(payload: { tabId: string }): void;
    saveFailed(payload: { tabId: string; error: string }): void;
  };
  log: Log;
}

/** Characters macOS file names can't contain (`:`) or that would create folders (`/`), plus `\` for safety. */
const safeName = (name: string) =>
  name
    .replace(/[/:\\]/g, "-")
    .replace(/…$/, "")
    .trim() || "Untitled";

/** Open, Save, Save As, reveal and copy path (spec §7.3, §10.2). */
export function createFileHandlers(deps: FileHandlerDeps) {
  const { parse, message } = createValidators(deps.log);

  const openReady = async (ready: ReadyFile[], extra: Pick<FileOpened, "large" | "errors">) => {
    const tabs: TabWithContent[] = [];
    let focusTabId: string | null = null;
    for (const { path, content } of ready) {
      const existing = deps.session.findTabByPath(path);
      if (existing) {
        focusTabId = existing.id;
        continue;
      }
      const tab = await deps.session.createTab({
        filePath: path,
        language: languageForPath(path),
        lastSavedHash: contentHash(content),
        content,
      });
      tabs.push({ tab, content });
    }
    const first = ready[0] ?? extra.large[0];
    if (first) deps.session.setLastDirectory(dirname(first.path));
    deps.send.opened({ tabs, focusTabId, ...extra });
  };

  const completeSaveAs = async (tabId: string, path: string, content: string) => {
    try {
      const hash = await deps.files.write(path, content);
      await deps.session.patchTab(tabId, { filePath: path, lastSavedHash: hash });
      deps.session.setLastDirectory(dirname(path));
      const tab = deps.session.session.tabs[tabId];
      if (tab) deps.send.saved({ tabId, tab });
    } catch (error) {
      deps.send.saveFailed({ tabId, error: error instanceof Error ? error.message : String(error) });
    }
  };

  return {
    requests: {
      "file.save": (input: unknown): Promise<FileSaveResult> => {
        const { tabId, content } = parse(fileSaveParamsSchema, "file.save", input);
        return (async (): Promise<FileSaveResult> => {
          const tab = deps.session.session.tabs[tabId];
          if (!tab) return { ok: false, error: strings.files.tabGone };
          if (!tab.filePath) return { needsSaveAs: true };
          try {
            const hash = await deps.files.write(tab.filePath, content);
            await deps.session.patchTab(tabId, { lastSavedHash: hash });
            return { ok: true, tab: deps.session.session.tabs[tabId] ?? tab };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        })();
      },
    },
    messages: {
      "file.openDialog": message(emptyParamsSchema, "file.openDialog", async () => {
        const startingFolder = deps.session.session.lastDirectory ?? deps.documentsDir;
        const paths = await deps.openDialog({ startingFolder });
        if (paths.length === 0) return;
        const { ready, large, errors } = await deps.files.prepareOpen(paths);
        await openReady(ready, { large, errors });
      }),
      "file.confirmLarge": message(fileConfirmLargeSchema, "file.confirmLarge", async ({ tokens }) => {
        const { ready, errors } = await deps.files.confirmLarge(tokens);
        await openReady(ready, { large: [], errors });
      }),
      "file.saveAsDialog": message(fileSaveParamsSchema, "file.saveAsDialog", async ({ tabId, content }) => {
        const tab = deps.session.session.tabs[tabId];
        if (!tab) return;
        const defaultName = `${safeName(deriveTitle(tab, content)).replace(/\.(?:[mc]?[jt]sx?|json|txt)$/i, "")}.${extensionFor(tab.language)}`;
        const defaultDir = tab.filePath
          ? dirname(tab.filePath)
          : (deps.session.session.lastDirectory ?? deps.documentsDir);
        let path: string | null;
        try {
          path = await deps.saveDialog({ defaultName, defaultDir });
        } catch (error) {
          deps.send.saveFailed({ tabId, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        if (path === null) {
          deps.send.saveCancelled({ tabId });
          return;
        }
        if (path === join(defaultDir, defaultName)) {
          // M0-S6: an untouched dialog can resolve to the default path by itself. Never write without confirmation.
          const token = deps.files.issueSaveAsToken({ tabId, path, content });
          deps.send.saveAsConfirm({ token, tabId, path });
          return;
        }
        await completeSaveAs(tabId, path, content);
      }),
      "file.confirmSaveAs": message(fileConfirmSaveAsSchema, "file.confirmSaveAs", async ({ token, confirmed }) => {
        const pending = deps.files.takeSaveAsToken(token);
        if (!pending) return;
        if (!confirmed) {
          deps.send.saveCancelled({ tabId: pending.tabId });
          return;
        }
        await completeSaveAs(pending.tabId, pending.path, pending.content);
      }),
      "tab.revealInFinder": message(tabParamsSchema, "tab.revealInFinder", ({ tabId }) => {
        const path = deps.session.session.tabs[tabId]?.filePath;
        if (path) deps.revealInFinder(path);
      }),
      "tab.copyPath": message(tabParamsSchema, "tab.copyPath", ({ tabId }) => {
        const path = deps.session.session.tabs[tabId]?.filePath;
        if (path) deps.clipboard(path);
      }),
    },
  };
}
