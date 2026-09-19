import {
  type CommandCatalogEntry,
  commandsPublishedSchema,
  emptyParamsSchema,
  keybindingsSaveParamsSchema,
  type SaveResult,
} from "@jslab/rpc-schema";
import { COMMANDS, commandTitleKey, DEFAULT_KEYBINDINGS, type KeybindingRule } from "@jslab/shared";
import type { Translate } from "../i18n";
import type { KeybindingsStore } from "../services/keybindings-store";
import { strings } from "../strings";
import { createValidators, type Log } from "./validate";

export interface KeybindingHandlerDeps {
  store: Pick<KeybindingsStore, "path" | "rules" | "save" | "invalid">;
  /** Ids the running main window has registered, published by App.tsx. Empty when no main window is open. */
  registeredCommands(): readonly string[];
  /** Spec §17: command titles live in the catalogue, so the row text is resolved here rather than shipped. */
  t: Translate;
  log: Log;
}

/** Settings → Keybindings (spec §6.5), served to the Settings window. */
export function createKeybindingHandlers(deps: KeybindingHandlerDeps) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      /**
       * The command catalogue the table renders.
       *
       * Rows come from `COMMANDS` in @jslab/shared -- the single list every milestone already extends, since
       * `isCommandId` gates binding, dispatch and menu clicks. Nothing here enumerates commands by hand, so a
       * command added by another milestone appears with no change to this file (R-M5D-REGISTRY-1).
       */
      "commands.catalog": (input: unknown): { commands: CommandCatalogEntry[] } => {
        parse(emptyParamsSchema, "commands.catalog", input);
        // Read at call time, not when this group was built: the main window republishes on every registry build,
        // and a window that opens after Main started must still be reflected.
        const registered = new Set(deps.registeredCommands());
        return {
          commands: COMMANDS.map((command) => ({
            id: command.id,
            title: deps.t(commandTitleKey(command.id)),
            category: command.category,
            registered: registered.has(command.id),
          })),
        };
      },
      "keybindings.get": (
        input: unknown,
      ): { rules: KeybindingRule[]; defaults: KeybindingRule[]; path: string; invalid: boolean } => {
        parse(emptyParamsSchema, "keybindings.get", input);
        // Copies: the response crosses the RPC boundary as mutable arrays, and handing out the store's own set (or
        // the module-level defaults) would let a caller edit what Main believes is on disk.
        return {
          rules: [...deps.store.rules],
          defaults: [...DEFAULT_KEYBINDINGS],
          path: deps.store.path,
          // Settings closes its editing affordances on this, so the refusal below is never reached by accident.
          invalid: deps.store.invalid,
        };
      },
      "keybindings.save": async (input: unknown): Promise<SaveResult> => {
        const { rules } = parse(keybindingsSaveParamsSchema, "keybindings.save", input);
        // An unparseable file left the store holding NO rules, so every save is computed from nothing. Writing it
        // would replace the user's broken file with an empty-ish set at the moment they opened it to repair it.
        // Checked after validation so a malformed payload is still rejected as one.
        if (deps.store.invalid) {
          deps.log("Refused to overwrite an unparseable keybindings.json", deps.store.path);
          return { ok: false, error: strings.keybindings.fileInvalid };
        }
        try {
          await deps.store.save(rules);
          return { ok: true };
        } catch (error) {
          // The raw message can carry an absolute path (EACCES). Log it; show the user a readable line (spec §18).
          deps.log("Couldn't write keybindings.json", String(error));
          return { ok: false, error: strings.keybindings.saveFailed };
        }
      },
    },
    messages: {},
  };
}

/**
 * `commands.published`, registered on the MAIN window's RPC rather than the Settings window's.
 *
 * The catalogue above is served to Settings, but the registry that knows which commands are really registered lives
 * in the main window's React tree (Finding S1). The two halves therefore sit on different wires, which is why this
 * is a separate group instead of another entry in `createKeybindingHandlers`.
 */
export function createCommandPublishHandlers(deps: { onPublished(ids: string[]): void; log: Log }) {
  const { message } = createValidators(deps.log);
  return {
    requests: {},
    messages: {
      "commands.published": message(commandsPublishedSchema, "commands.published", ({ ids }) => deps.onPublished(ids)),
    },
  };
}
