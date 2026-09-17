import { type FileOpened, MAX_OPEN_FILE_BYTES } from "@jslab/rpc-schema";
import { baseName, deriveTitle, isDirty, languageForPath, type TabState } from "@jslab/shared";
import type { MainApi } from "../api";
import type { Dialogs } from "../shell/dialogs";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import type { TabActions } from "../tabs/tab-actions";

export const LARGE_BYTES = 5 * 1024 * 1024;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FileFlows {
  open(): void;
  save(tabId?: string): Promise<boolean>;
  saveAs(tabId?: string): Promise<boolean>;
  beforeClose(tabId: string): Promise<boolean>;
  handleOpened(payload: FileOpened): Promise<void>;
  handleSaved(payload: { tabId: string; tab: TabState }): void;
  handleSaveCancelled(payload: { tabId: string }): void;
  handleSaveFailed(payload: { tabId: string; error: string }): void;
  handleSaveAsConfirm(payload: { token: string; tabId: string; path: string }): Promise<void>;
  dropFiles(files: File[], folderNames: ReadonlySet<string>): Promise<void>;
  confirmLargePaste(bytes: number): Promise<boolean>;
}

/** Open, Save, Save As, close prompts and dropped files (spec §7.3, §10.2). Main owns the file system. */
export function createFileFlows(deps: {
  store: AppStore;
  api: MainApi;
  tabs: TabActions;
  dialogs: Dialogs;
  beforeSave?(tabId: string): Promise<void>;
}): FileFlows {
  const { store, api, tabs, dialogs } = deps;
  const s = () => store.getState();
  // One pending Save As per tab. Main answers every file.saveAsDialog with file.saved, file.saveCancelled or
  // file.saveFailed (including "That tab is no longer open." for a tab closed mid-dialog), which settles it.
  const waiters = new Map<string, (saved: boolean) => void>();
  const cancelButton = { id: "cancel", label: strings.files.cancel, role: "cancel" as const };

  const finishSave = (tabId: string, saved: boolean) => {
    const done = waiters.get(tabId);
    waiters.delete(tabId);
    done?.(saved);
  };

  const formatForSave = async (tabId: string) => {
    if (s().settings?.editor.formatOnSave && deps.beforeSave) await deps.beforeSave(tabId);
  };

  /**
   * B1: refuse every write path for a tab whose contents Main couldn't read.
   *
   * `state.buffers[tabId]` is a placeholder `""` for these, not the file's text. Saving it replaced the user's
   * real source file with nothing -- and `FileService.write` keeps no `.bak`, so there was nothing to recover.
   * Main refuses these independently; this stops the UI from ever asking, and gives the user a reason instead of
   * a silent no-op.
   */
  const refuseUnreadable = (tabId: string): boolean => {
    if (!s().unreadableBuffers.includes(tabId)) return false;
    s().setStatusMessage(strings.files.unreadableBuffer);
    return true;
  };

  const saveAs = (tabId = s().activeTabId ?? undefined): Promise<boolean> => {
    if (!tabId || !s().tabs[tabId]) return Promise.resolve(false);
    if (refuseUnreadable(tabId)) return Promise.resolve(false);
    finishSave(tabId, false);
    return formatForSave(tabId).then(
      () =>
        new Promise<boolean>((resolve) => {
          // Fix round 1 (I-3): formatForSave is always async (even with Format on Save off), so there is a
          // gap between the leading finishSave above and this waiters.set. A second saveAs (or a save whose
          // result is needsSaveAs) for the same tab can register its own waiter during that gap; settle it
          // before this call claims the slot, so it never hangs forever.
          finishSave(tabId, false);
          waiters.set(tabId, resolve);
          api.saveAsDialog(tabId, s().buffers[tabId] ?? "");
        }),
    );
  };

  const save = async (tabId = s().activeTabId ?? undefined): Promise<boolean> => {
    if (!tabId || !s().tabs[tabId]) return false;
    // Before formatForSave: formatting a placeholder is pointless, and the save is refused either way.
    if (refuseUnreadable(tabId)) return false;
    await formatForSave(tabId);
    const result = await api.saveFile(tabId, s().buffers[tabId] ?? "");
    if ("needsSaveAs" in result) {
      finishSave(tabId, false);
      return new Promise<boolean>((resolve) => {
        waiters.set(tabId, resolve);
        api.saveAsDialog(tabId, s().buffers[tabId] ?? "");
      });
    }
    if (!result.ok) {
      s().setStatusMessage(strings.files.saveFailed(result.error));
      return false;
    }
    s().applyTabUpdate(result.tab);
    s().setStatusMessage(strings.files.saved(baseName(result.tab.filePath ?? "")));
    return true;
  };

  const readAsText = async (file: File): Promise<string | null> => {
    const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    if (head.includes(0)) return null;
    return file.text();
  };

  return {
    open: () => api.openFileDialog(),
    save,
    saveAs,

    async beforeClose(tabId) {
      const state = s();
      const tab = state.tabs[tabId];
      if (!tab) return true;
      const code = state.buffers[tabId] ?? "";
      const title = deriveTitle(tab, code);
      // TF-21: ⌘W on the only, untouched, fileless tab closes the window and keeps the tab. "Untouched" means empty
      // OR still holding exactly the first-run welcome sample (R-M5a-REGRESSION-2) -- before that sample existed the
      // two were the same thing, and testing emptiness alone leaves a first-run user staring at an empty window.
      if (state.tabOrder.length === 1 && !tab.filePath && (code === "" || tab.pristine)) {
        api.appCommand("closeWindow");
        return false;
      }
      // B1: a placeholder is not an unsaved change. `isDirty` compares `""` against the real file's
      // `lastSavedHash` and says "modified", which raised a "Save changes?" prompt whose PRIMARY button wrote
      // that `""` over the file. Closing such a tab loses nothing, because nothing was ever read.
      if (!state.unreadableBuffers.includes(tabId) && isDirty(tab, code)) {
        const choice = await dialogs.confirm({
          title: strings.files.saveChanges(title),
          message: strings.files.saveChangesDetail,
          buttons: [
            { id: "discard", label: strings.files.dontSave },
            cancelButton,
            { id: "save", label: strings.files.save, role: "primary" },
          ],
        });
        if (choice === "save") return save(tabId);
        return choice === "discard";
      }
      if (state.settings?.tabs.confirmClose) {
        const choice = await dialogs.confirm({
          title: strings.files.closeTitle(title),
          message: strings.files.closeDetail,
          buttons: [cancelButton, { id: "close", label: strings.files.close, role: "primary" }],
        });
        return choice === "close";
      }
      return true;
    },

    async handleOpened(payload) {
      for (const { tab, content } of payload.tabs) s().openTab(tab, content, true);
      // Main activated the created tabs already; tell it which one the UI shows (harmless when they match).
      if (payload.tabs.length > 0) api.activateTab(payload.tabs[payload.tabs.length - 1]?.tab.id ?? "");
      if (payload.focusTabId) tabs.activate(payload.focusTabId);
      if (payload.errors.length > 0) s().setStatusMessage(payload.errors.join(" · "));
      for (const file of payload.large) {
        const choice = await dialogs.confirm({
          title: strings.files.largeTitle,
          message: strings.files.large(baseName(file.path), formatSize(file.size)),
          buttons: [cancelButton, { id: "open", label: strings.files.open, role: "primary" }],
        });
        if (choice === "open") api.confirmLargeFiles([file.token]);
      }
    },

    handleSaved({ tabId, tab }) {
      s().applyTabUpdate(tab);
      s().setStatusMessage(strings.files.saved(baseName(tab.filePath ?? "")));
      finishSave(tabId, true);
    },

    handleSaveCancelled({ tabId }) {
      finishSave(tabId, false);
    },

    handleSaveFailed({ tabId, error }) {
      s().setStatusMessage(strings.files.saveFailed(error));
      finishSave(tabId, false);
    },

    async handleSaveAsConfirm({ token, path }) {
      const choice = await dialogs.confirm({
        title: strings.files.locationTitle,
        message: strings.files.location(path),
        buttons: [cancelButton, { id: "save", label: strings.files.save, role: "primary" }],
      });
      api.confirmSaveAs(token, choice === "save");
    },

    async dropFiles(files, folderNames) {
      const notices: string[] = [];
      for (const file of files) {
        if (folderNames.has(file.name)) continue;
        if (file.size > MAX_OPEN_FILE_BYTES) {
          notices.push(strings.files.tooLarge(file.name));
          continue;
        }
        if (file.size > LARGE_BYTES) {
          const choice = await dialogs.confirm({
            title: strings.files.largeTitle,
            message: strings.files.large(file.name, formatSize(file.size)),
            buttons: [cancelButton, { id: "open", label: strings.files.open, role: "primary" }],
          });
          if (choice !== "open") continue;
        }
        const content = await readAsText(file);
        if (content === null) {
          notices.push(strings.files.notText(file.name));
          continue;
        }
        await tabs.newTab({ title: file.name, titleIsCustom: true, language: languageForPath(file.name), content });
      }
      if (folderNames.size > 0) notices.push(strings.files.folderDrop);
      if (notices.length > 0) s().setStatusMessage(notices.join(" · "));
    },

    async confirmLargePaste(bytes) {
      const choice = await dialogs.confirm({
        title: strings.files.pasteTitle,
        message: strings.files.paste(formatSize(bytes)),
        buttons: [cancelButton, { id: "paste", label: strings.files.pasteButton, role: "primary" }],
      });
      return choice === "paste";
    },
  };
}
