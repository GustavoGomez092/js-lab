import type { MainMessages, MainRequests, ViewMessages } from "@jslab/rpc-schema";
import { Electroview, type RPCSchema } from "electrobun/view";
import type { MainApi } from "./api";

type JSLabRPC = {
  bun: RPCSchema<{ requests: MainRequests; messages: MainMessages }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: ViewMessages }>;
};

type AnyListener = (payload: never) => void;

/** Electrobun-backed implementation of MainApi. The only UI module that imports Electrobun. */
export function createRpcApi(): MainApi {
  const listeners = new Map<keyof ViewMessages, Set<AnyListener>>();
  const dispatch =
    <K extends keyof ViewMessages>(name: K) =>
    (payload: ViewMessages[K]) => {
      for (const listener of listeners.get(name) ?? []) (listener as (p: ViewMessages[K]) => void)(payload);
    };

  const rpc = Electroview.defineRPC<JSLabRPC>({
    maxRequestTime: 10_000,
    handlers: {
      requests: {},
      messages: {
        "run.events": dispatch("run.events"),
        "run.state": dispatch("run.state"),
        "run.diagnostics": dispatch("run.diagnostics"),
        "menu.command": dispatch("menu.command"),
        "e2e.request": dispatch("e2e.request"),
      },
    },
  });
  new Electroview({ rpc });

  return {
    bootstrap: () => rpc.request["app.bootstrap"]({}),
    startRun: (params) => rpc.request["run.start"](params),
    expand: (params) => rpc.request["run.expand"](params),
    stop: (tabId) => rpc.send["run.stop"]({ tabId }),
    kill: (tabId) => rpc.send["run.kill"]({ tabId }),
    wait: (tabId) => rpc.send["run.wait"]({ tabId }),
    bufferChanged: (tabId, content) => rpc.send["buffer.changed"]({ tabId, content }),
    patchTab: (tabId, patch) => rpc.send["tab.patch"]({ tabId, patch }),
    heartbeat: () => rpc.send["ui.heartbeat"]({}),
    e2eRespond: (response) => rpc.send["e2e.response"](response),
    on(name, listener) {
      const set = listeners.get(name) ?? new Set<AnyListener>();
      listeners.set(name, set);
      set.add(listener as AnyListener);
      return () => {
        set.delete(listener as AnyListener);
      };
    },
  };
}
