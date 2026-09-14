import type { SettingsUpdateParams } from "@jslab/rpc-schema";
import {
  type CommandId,
  isRuntimeAvailable,
  type Language,
  type Runtime,
  readSetting,
  type SettingKey,
  settingPatch,
} from "@jslab/shared";
import type { MainApi } from "../api";
import type { EditorHandle } from "../editor/editor-handle";
import { copyEntriesToClipboard } from "../output/copy";
import { entryToText } from "../output/text";
import { visibleEntries } from "../state/output";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import type { TabActions } from "../tabs/tab-actions";
import type { CommandSpec } from "./registry";

export interface AppCommandDeps {
  store: AppStore;
  api: MainApi;
  tabs: TabActions;
  run(reason: "manual"): void;
  editor(): EditorHandle | null;
}

const RUNTIME_COMMANDS: [CommandId, Runtime][] = [
  ["runtime.bun", "bun"],
  ["runtime.browserNode", "browser-node"],
  ["runtime.browser", "browser"],
];

const LANGUAGE_COMMANDS: [CommandId, Language][] = [
  ["language.typescript", "typescript"],
  ["language.javascript", "javascript"],
  ["language.tsx", "tsx"],
  ["language.jsx", "jsx"],
];

export function createAppCommands(deps: AppCommandDeps): CommandSpec[] {
  const s = () => deps.store.getState();
  const withActiveTab = (action: (tabId: string) => void) => () => {
    const id = s().activeTabId;
    if (id) action(id);
  };

  const toggleSetting = (id: CommandId, key: SettingKey, description?: () => string | null): CommandSpec => ({
    id,
    run: async () => {
      const current = s().settings;
      if (!current) return;
      const patch = settingPatch(key, !readSetting(current, key)) as SettingsUpdateParams["patch"];
      s().updateSettings(await deps.api.updateSettings(patch));
    },
    ...(description ? { description } : {}),
  });

  return [
    { id: "run.start", run: () => deps.run("manual") },
    { id: "run.stop", run: withActiveTab((id) => deps.api.stop(id)) },
    { id: "run.kill", run: withActiveTab((id) => deps.api.kill(id)) },
    toggleSetting("run.toggleAutoRun", "run.autoRun", () => strings.commands.onOff(Boolean(s().settings?.run.autoRun))),
    toggleSetting("run.toggleAutoLog", "run.autoLog", () => strings.commands.onOff(Boolean(s().settings?.run.autoLog))),
    toggleSetting("run.toggleLoopProtection", "run.loopProtection", () =>
      strings.commands.loopLimit(s().settings?.run.loopProtectionMaxIterations ?? 2000),
    ),

    { id: "output.clear", run: () => s().clearOutput() },
    {
      id: "output.copyAll",
      run: async () => {
        const state = s();
        const text = visibleEntries(state.output, { showUndefined: state.settings?.run.showUndefined ?? false })
          .map((entry) => entryToText(entry.event))
          .join("\n");
        // As built (M1 T17 fix round): a denied or failed clipboard write reports a status, never an unhandled rejection.
        if ((await copyEntriesToClipboard(text)) === "failed") s().setStatusMessage(strings.commands.copyFailed);
      },
    },
    {
      id: "editor.clear",
      run: () => {
        const editor = deps.editor();
        if (editor) editor.replaceAll("");
        else s().editCode("");
      },
    },

    { id: "tab.new", run: () => deps.tabs.newTab() },
    { id: "tab.close", run: async () => void (await deps.tabs.close()) },
    { id: "tab.closeOthers", isEnabled: () => s().tabOrder.length > 1, run: () => deps.tabs.closeOthers() },
    {
      id: "tab.closeToRight",
      isEnabled: () => {
        const { tabOrder, activeTabId } = s();
        return activeTabId !== null && tabOrder.indexOf(activeTabId) < tabOrder.length - 1;
      },
      run: () => deps.tabs.closeToRight(),
    },
    { id: "tab.reopenClosed", isEnabled: () => s().closedCount > 0, run: () => deps.tabs.reopen() },
    { id: "tab.next", run: () => deps.tabs.next() },
    { id: "tab.previous", run: () => deps.tabs.previous() },
    ...Array.from(
      { length: 9 },
      (_, index): CommandSpec => ({
        id: `tab.goto${index + 1}` as CommandId,
        run: () => deps.tabs.goto(index + 1),
      }),
    ),
    { id: "tab.rename", run: withActiveTab((tabId) => s().openModal({ kind: "rename", tabId })) },
    {
      id: "tab.revealInFinder",
      isEnabled: () => Boolean(s().tab?.filePath),
      run: withActiveTab((id) => deps.api.revealInFinder(id)),
    },
    {
      id: "tab.copyPath",
      isEnabled: () => Boolean(s().tab?.filePath),
      run: withActiveTab((id) => deps.api.copyPath(id)),
    },

    ...RUNTIME_COMMANDS.map(
      ([id, runtime]): CommandSpec => ({
        id,
        isEnabled: () => isRuntimeAvailable(runtime),
        run: () => s().setRuntime(runtime),
        description: () => (s().tab?.runtime === runtime ? strings.commands.current : null),
      }),
    ),
    ...LANGUAGE_COMMANDS.map(
      ([id, language]): CommandSpec => ({
        id,
        run: () => s().setLanguage(language),
        description: () => (s().tab?.language === language ? strings.commands.current : null),
      }),
    ),

    { id: "help.copyDebugLog", run: () => deps.api.appCommand("copyDebugLog") },
    { id: "help.openLogsFolder", run: () => deps.api.appCommand("openLogsFolder") },
    { id: "help.restartSafeMode", run: () => deps.api.appCommand("restartSafeMode") },
    { id: "app.openDataFolder", run: () => deps.api.appCommand("openDataFolder") },
    { id: "view.toggleFullScreen", run: () => deps.api.appCommand("toggleFullScreen") },
  ];
}
