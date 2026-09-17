import { mock } from "bun:test";
import type {
  AppAction,
  E2EResponse,
  EnvVars,
  FileSaveResult,
  LocalTypesResult,
  NpmListResult,
  NpmSearchResponse,
  PackageTypesResult,
  SaveResult,
  TabCloseResult,
  TabCreateParams,
  TabWithContent,
  ViewMessages,
} from "@jslab/rpc-schema";
import { createTab, defaultSettings } from "@jslab/shared";
import { act } from "@testing-library/react";
import type { MainApi } from "../src/api";

/** A MainApi where every method is a mock; `emit` delivers a Main → UI message inside act(). */
export function createFakeApi() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const api = {
    bootstrap: mock(async () => {
      throw new Error("not used");
    }),
    startRun: mock(async (_params: unknown) => ({ runId: "r1" })),
    expand: mock(async (_params: unknown) => null),
    // The return type is written out so a test can re-implement this as the never-transpiled case (`null`), which
    // an inferred `{ code, source }` would reject.
    transpiled: mock(
      async (_tabId: string, _hideInstrumentation: boolean): Promise<{ code: string; source: string } | null> => ({
        code: "",
        source: "",
      }),
    ),
    stop: mock((_tabId: string) => {}),
    kill: mock((_tabId: string) => {}),
    wait: mock((_tabId: string) => {}),
    bufferChanged: mock((_tabId: string, _content: string) => {}),
    patchTab: mock((_tabId: string, _patch: unknown) => {}),
    heartbeat: mock(() => {}),
    stateFlushed: mock(() => {}),
    createTab: mock(async (params: TabCreateParams) => ({ tab: createTab({ language: params.language }) })),
    closeTab: mock(
      async (_tabId: string): Promise<TabCloseResult> => ({ ok: true, activeTabId: "", replacement: null }),
    ),
    reopenTab: mock(async (): Promise<TabWithContent | null> => null),
    activateTab: mock((_tabId: string) => {}),
    reorderTabs: mock((_order: string[]) => {}),
    saveViewState: mock((_tabId: string, _viewState: unknown) => {}),
    updateSettings: mock(async (_patch: unknown) => defaultSettings()),
    saveFile: mock(async (_tabId: string, _content: string): Promise<FileSaveResult> => ({ needsSaveAs: true })),
    openFileDialog: mock(() => {}),
    confirmLargeFiles: mock((_tokens: string[]) => {}),
    saveAsDialog: mock((_tabId: string, _content: string) => {}),
    confirmSaveAs: mock((_token: string, _confirmed: boolean) => {}),
    revealInFinder: mock((_tabId: string) => {}),
    copyPath: mock((_tabId: string) => {}),
    npmList: mock(
      async (_refreshOutdated: boolean): Promise<NpmListResult> => ({
        installed: [],
        outdatedCheckedAt: null,
        outdatedError: null,
        revision: 0,
      }),
    ),
    npmSearch: mock(async (_query: string): Promise<NpmSearchResponse> => ({ results: [], error: null })),
    npmInstall: mock((_spec: string) => {}),
    npmRemove: mock((_name: string) => {}),
    npmUpdate: mock((_name: string) => {}),
    npmUpdateAll: mock(() => {}),
    packageTypes: mock(async (_tabId: string, _packages: string[]): Promise<PackageTypesResult[]> => []),
    localTypes: mock(
      async (_tabId: string, _specifiers: string[]): Promise<LocalTypesResult> => ({
        files: [],
        packages: [],
        truncated: false,
      }),
    ),
    getEnv: mock(async (): Promise<EnvVars> => ({})),
    saveEnv: mock(async (_variables: EnvVars): Promise<SaveResult> => ({ ok: true })),
    pickWorkingDirectory: mock((_tabId: string) => {}),
    clearWorkingDirectory: mock((_tabId: string) => {}),
    appCommand: mock((_action: AppAction) => {}),
    e2eRespond: mock((_response: E2EResponse) => {}),
    webRunnerReady: mock((_tabId: string, _generation: number) => {}),
    webRunnerExit: mock((_tabId: string, _generation: number) => {}),
    webRunnerMessage: mock((_tabId: string, _raw: unknown) => {}),
    on(name: string, listener: (payload: never) => void) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener as (payload: unknown) => void);
      return () => {
        set.delete(listener as (payload: unknown) => void);
      };
    },
  } satisfies MainApi;
  const emit = <K extends keyof ViewMessages>(name: K, payload: ViewMessages[K]) =>
    act(async () => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
      await Bun.sleep(1);
    });
  return { api, emit };
}
