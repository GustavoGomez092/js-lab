import type {
  BootstrapPayload,
  E2EResponse,
  EncodedValue,
  RunExpandParams,
  RunStartParams,
  TabPatch,
  ViewMessages,
} from "@jslab/rpc-schema";

/**
 * Everything the UI needs from Main. Components depend on this interface only; `rpc.ts` implements it
 * with Electrobun, and tests pass a fake.
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
  on<K extends keyof ViewMessages>(name: K, listener: (payload: ViewMessages[K]) => void): () => void;
  e2eRespond?(response: E2EResponse): void;
}
