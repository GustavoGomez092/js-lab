import type {
  AppAction,
  BootstrapPayload,
  E2EResponse,
  EncodedValue,
  EnvVars,
  FileSaveResult,
  LocalTypesResult,
  NpmListResult,
  NpmSearchResponse,
  PackageTypesResult,
  RunExpandParams,
  RunStartParams,
  SaveResult,
  SettingsUpdateParams,
  TabCloseResult,
  TabCreateParams,
  TabPatch,
  TabWithContent,
  ViewMessages,
} from "@jslab/rpc-schema";
import type { Settings, TabState } from "@jslab/shared";

/**
 * Everything the UI needs from Main. Components depend on this interface only; `rpc.ts` implements it with
 * Electrobun, and tests use `test/fake-api.ts`.
 */
export interface MainApi {
  bootstrap(): Promise<BootstrapPayload>;
  startRun(params: RunStartParams): Promise<{ runId: string }>;
  expand(params: RunExpandParams): Promise<EncodedValue | null>;
  stop(tabId: string): void;
  kill(tabId: string): void;
  wait(tabId: string): void;
  bufferChanged(tabId: string, content: string): void;
  patchTab(tabId: string, patch: TabPatch["patch"]): void;
  heartbeat(): void;
  stateFlushed(): void;

  createTab(params: TabCreateParams): Promise<{ tab: TabState }>;
  closeTab(tabId: string): Promise<TabCloseResult>;
  reopenTab(): Promise<TabWithContent | null>;
  activateTab(tabId: string): void;
  reorderTabs(tabOrder: string[]): void;
  saveViewState(tabId: string, viewState: unknown): void;

  updateSettings(patch: SettingsUpdateParams["patch"]): Promise<Settings>;

  saveFile(tabId: string, content: string): Promise<FileSaveResult>;
  openFileDialog(): void;
  confirmLargeFiles(tokens: string[]): void;
  saveAsDialog(tabId: string, content: string): void;
  confirmSaveAs(token: string, confirmed: boolean): void;
  revealInFinder(tabId: string): void;
  copyPath(tabId: string): void;

  npmList(refreshOutdated: boolean): Promise<NpmListResult>;
  npmSearch(query: string): Promise<NpmSearchResponse>;
  npmInstall(spec: string): void;
  npmRemove(name: string): void;
  npmUpdate(name: string): void;
  npmUpdateAll(): void;

  packageTypes(tabId: string, packages: string[]): Promise<PackageTypesResult[]>;
  localTypes(tabId: string, specifiers: string[]): Promise<LocalTypesResult>;

  getEnv(): Promise<EnvVars>;
  saveEnv(variables: EnvVars): Promise<SaveResult>;

  pickWorkingDirectory(tabId: string): void;
  clearWorkingDirectory(tabId: string): void;

  appCommand(action: AppAction): void;
  e2eRespond(response: E2EResponse): void;
  on<K extends keyof ViewMessages>(name: K, listener: (payload: ViewMessages[K]) => void): () => void;
}
