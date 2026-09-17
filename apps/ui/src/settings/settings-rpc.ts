import type {
  E2EResponse,
  SaveResult,
  SettingsAppAction,
  SettingsUpdateParams,
  SettingsViewMessages,
  SettingsWindowMessages,
  SettingsWindowRequests,
} from "@jslab/rpc-schema";
import type { KeybindingRule, Settings } from "@jslab/shared";
import { Electroview, type RPCSchema } from "electrobun/view";
import { createMessageHub } from "../message-hub";

type SettingsRPC = {
  bun: RPCSchema<{ requests: SettingsWindowRequests; messages: SettingsWindowMessages }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: SettingsViewMessages }>;
};

export interface SettingsApi {
  get(): Promise<{ settings: Settings; e2e: boolean }>;
  update(patch: SettingsUpdateParams["patch"]): Promise<Settings>;
  listFonts(): Promise<SettingsWindowRequests["fonts.list"]["response"]>;
  getNpmrc(): Promise<string>;
  saveNpmrc(content: string): Promise<SaveResult>;
  resetNpmrc(): Promise<string>;
  /** Every command in the shared catalogue, annotated with what the running main window registered (spec §6.5). */
  commandCatalog(): Promise<SettingsWindowRequests["commands.catalog"]["response"]>;
  getKeybindings(): Promise<SettingsWindowRequests["keybindings.get"]["response"]>;
  saveKeybindings(rules: KeybindingRule[]): Promise<SaveResult>;
  appCommand(action: SettingsAppAction): void;
  e2eRespond(response: E2EResponse): void;
  on<K extends keyof SettingsViewMessages>(name: K, listener: (payload: SettingsViewMessages[K]) => void): () => void;
}

export function createSettingsApi(): SettingsApi {
  // Messages that arrive before SettingsApp subscribes are queued, not dropped (R-M2-T24-4).
  const hub = createMessageHub<SettingsViewMessages>();
  const rpc = Electroview.defineRPC<SettingsRPC>({
    maxRequestTime: 60_000,
    handlers: {
      requests: {},
      messages: {
        "settings.changed": hub.dispatch("settings.changed"),
        "e2e.request": hub.dispatch("e2e.request"),
        // Finding K1: a keybindings.json write reaches the Keybindings pane without a relaunch, whoever made it.
        "keybindings.changed": hub.dispatch("keybindings.changed"),
      },
    },
  });
  new Electroview({ rpc });
  return {
    get: () => rpc.request["settings.get"]({}),
    update: (patch) => rpc.request["settings.update"]({ patch }),
    listFonts: () => rpc.request["fonts.list"]({}),
    getNpmrc: () => rpc.request["npmrc.get"]({}).then((reply) => reply.content),
    saveNpmrc: (content) => rpc.request["npmrc.save"]({ content }),
    resetNpmrc: () => rpc.request["npmrc.reset"]({}).then((reply) => reply.content),
    commandCatalog: () => rpc.request["commands.catalog"]({}),
    getKeybindings: () => rpc.request["keybindings.get"]({}),
    saveKeybindings: (rules) => rpc.request["keybindings.save"]({ rules }),
    appCommand: (action) => rpc.send["app.command"]({ action }),
    e2eRespond: (response) => rpc.send["e2e.response"](response),
    on: (name, listener) => hub.on(name, listener),
  };
}
