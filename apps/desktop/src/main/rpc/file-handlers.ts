import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
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
import { baseName, contentHash, deriveTitle, extensionFor, languageForPath, type TabState } from "@jslab/shared";
import { type FileService, type ReadyFile, TOKEN_TTL_MS } from "../files/file-service";
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

/** js/jsx/ts/tsx/mjs/cjs/mts/cts: the extensions a Save As should re-derive the tab's language from (m-7b).
 * json/txt keep the tab's existing language. */
const SOURCE_EXTENSION = /\.(?:[mc]?[jt]sx?)$/i;

/** The first candidate folder that still exists on disk, or `fallback` (Documents) when none do (m-7c). */
async function firstExistingDir(candidates: (string | null)[], fallback: string): Promise<string> {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Missing or inaccessible: fall through to the next candidate.
    }
  }
  return fallback;
}

/**
 * The comparable spelling of `folder/name`: the folder's real path when it exists, then NFC. Both sides of the
 * default-path check go through it, so /var vs /private/var and NFD vs NFC spellings match (m-3, R-M2-T18-1).
 */
async function canonicalPath(folder: string, name: string): Promise<string> {
  return join(await realpath(folder).catch(() => folder), name).normalize("NFC");
}

/** Open, Save, Save As, reveal and copy path (spec §7.3, §10.2). */
export function createFileHandlers(deps: FileHandlerDeps) {
  const { parse, message } = createValidators(deps.log);
  // Save As confirmation tokens this handler issued, by tab, so an expired token still answers its tab (R-M2-T18-1).
  // An entry outlives its token by one more TTL, so a late answer still gets file.saveFailed; then it is swept, so
  // the map stays bounded (fix round 1, m-4).
  const confirmTabs = new Map<string, { tabId: string; issuedAt: number }>();
  const sweepConfirmTabs = (now: number) => {
    for (const [token, entry] of confirmTabs) {
      if (now - entry.issuedAt > 2 * TOKEN_TTL_MS) confirmTabs.delete(token);
    }
  };

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
    // The tab may have closed while a dialog (or a pending confirmation) was in flight (m-2): never write for a
    // tab that's no longer open.
    if (!deps.session.session.tabs[tabId]) {
      deps.send.saveFailed({ tabId, error: strings.files.tabGone });
      return;
    }
    // Never silently overwrite a path a different tab already has open (m-6).
    const owner = deps.session.findTabByPath(path);
    if (owner && owner.id !== tabId) {
      deps.send.saveFailed({ tabId, error: strings.files.openInAnotherTab(baseName(path)) });
      return;
    }
    try {
      const hash = await deps.files.write(path, content);
      await deps.session.patchTab(tabId, {
        filePath: path,
        lastSavedHash: hash,
        // Only a source extension re-derives the language; json/txt keep the tab's own (m-7b).
        ...(SOURCE_EXTENSION.test(path) ? { language: languageForPath(path) } : {}),
      });
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
        if (!tab) {
          // The tab may have closed between the UI sending this message and Main handling it (m-2).
          deps.send.saveFailed({ tabId, error: strings.files.tabGone });
          return;
        }
        // The file's own name when it has one; otherwise the derived title plus the language extension (m-7a).
        const defaultName = tab.filePath
          ? baseName(tab.filePath)
          : `${safeName(deriveTitle(tab, content)).replace(/\.(?:[mc]?[jt]sx?|json|txt)$/i, "")}.${extensionFor(tab.language)}`;
        const defaultDir = await firstExistingDir(
          [tab.filePath ? dirname(tab.filePath) : null, deps.session.session.lastDirectory],
          deps.documentsDir,
        );
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
        // Both sides are spelled the same way, so an untouched dialog result still counts as the default path.
        const defaultPath = await canonicalPath(defaultDir, defaultName);
        if ((await canonicalPath(dirname(path), basename(path))) === defaultPath) {
          // M0-S6: an untouched dialog can resolve to the default path by itself. Never write without confirmation.
          const token = deps.files.issueSaveAsToken({ tabId, path, content });
          const now = Date.now();
          sweepConfirmTabs(now);
          confirmTabs.set(token, { tabId, issuedAt: now });
          deps.send.saveAsConfirm({ token, tabId, path });
          return;
        }
        await completeSaveAs(tabId, path, content);
      }),
      "file.confirmSaveAs": message(fileConfirmSaveAsSchema, "file.confirmSaveAs", async ({ token, confirmed }) => {
        const pending = deps.files.takeSaveAsToken(token);
        const issuedFor = confirmTabs.get(token);
        confirmTabs.delete(token);
        sweepConfirmTabs(Date.now());
        if (!pending) {
          // Expired (5-minute TTL) or already used: answer the tab's pending Save As so the UI doesn't wait forever.
          // A token this handler never issued, or one swept long after expiry, has no tab to answer.
          if (issuedFor) deps.send.saveFailed({ tabId: issuedFor.tabId, error: strings.files.confirmExpired });
          return;
        }
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
