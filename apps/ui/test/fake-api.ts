import { mock } from "bun:test";
import type { AppAction, E2EResponse, TabCloseResult, TabCreateParams, ViewMessages } from "@jslab/rpc-schema";
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
    stop: mock((_tabId: string) => {}),
    kill: mock((_tabId: string) => {}),
    wait: mock((_tabId: string) => {}),
    bufferChanged: mock((_tabId: string, _content: string) => {}),
    patchTab: mock((_tabId: string, _patch: unknown) => {}),
    heartbeat: mock(() => {}),
    createTab: mock(async (params: TabCreateParams) => ({ tab: createTab({ language: params.language }) })),
    closeTab: mock(
      async (_tabId: string): Promise<TabCloseResult> => ({ ok: true, activeTabId: "", replacement: null }),
    ),
    reopenTab: mock(async (): Promise<{ tab: ReturnType<typeof createTab>; content: string } | null> => null),
    activateTab: mock((_tabId: string) => {}),
    reorderTabs: mock((_order: string[]) => {}),
    saveViewState: mock((_tabId: string, _viewState: unknown) => {}),
    updateSettings: mock(async (_patch: unknown) => defaultSettings()),
    saveFile: mock(async (_tabId: string, _content: string) => ({ needsSaveAs: true }) as const),
    openFileDialog: mock(() => {}),
    confirmLargeFiles: mock((_tokens: string[]) => {}),
    saveAsDialog: mock((_tabId: string, _content: string) => {}),
    confirmSaveAs: mock((_token: string, _confirmed: boolean) => {}),
    revealInFinder: mock((_tabId: string) => {}),
    copyPath: mock((_tabId: string) => {}),
    appCommand: mock((_action: AppAction) => {}),
    e2eRespond: mock((_response: E2EResponse) => {}),
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
