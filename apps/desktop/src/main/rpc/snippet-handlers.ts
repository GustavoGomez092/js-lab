import {
  emptyParamsSchema,
  MAX_SNIPPETS_FILE_BYTES,
  type MainMessages,
  type MainRequests,
  type SaveResult,
  type Snippet,
  type SnippetsExported,
  type SnippetsImported,
  snippetsExportParamsSchema,
  snippetsSaveParamsSchema,
} from "@jslab/rpc-schema";
import { parseSnippetsFile, snippetsFileContent } from "@jslab/shared";
import { FileTooLargeError } from "../files/bounded-read";
import type { SnippetStore } from "../services/snippet-store";
import { strings } from "../strings";
import { createValidators, type Log } from "./validate";

/** Spec §13.1: the default file name the Export dialog offers. */
export const SNIPPETS_EXPORT_NAME = "jslab-snippets.json";

export interface SnippetHandlerDeps {
  snippets: Pick<SnippetStore, "snippets" | "save">;
  openDialog(options: { startingFolder: string }): Promise<string[]>;
  saveDialog(options: { defaultName: string; defaultDir: string }): Promise<string | null>;
  /** Bounded at the *read*: refuses past `maxBytes` before allocating, never by measuring what it already read. */
  readFile(path: string, maxBytes: number): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  documentsDir: string;
  send: { imported(payload: SnippetsImported): void; exported(payload: SnippetsExported): void };
  log: Log;
}

/**
 * The snippet library on the wire (spec §13). Ruling R-M5b-8: this module parses an imported file but never merges
 * or stores it -- overwrite / keep both / skip is the panel's decision, and the panel then saves through
 * `snippets.save` like any other edit. So a refused import leaves `snippets.json` byte-identical.
 */
export function createSnippetHandlers(deps: SnippetHandlerDeps) {
  const { parse, message } = createValidators(deps.log);

  return {
    requests: {
      "snippets.list": (input: unknown): { snippets: Snippet[] } => {
        parse(emptyParamsSchema, "snippets.list", input);
        return { snippets: deps.snippets.snippets };
      },
      "snippets.save": (input: unknown): Promise<SaveResult> => {
        // parse runs synchronously before any await, so an invalid payload throws InvalidPayloadError rather than
        // returning a rejected promise -- and the store never sees it.
        const { snippets } = parse(snippetsSaveParamsSchema, "snippets.save", input);
        return deps.snippets.save(snippets).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        );
      },
    },
    messages: {
      "snippets.importDialog": message(emptyParamsSchema, "snippets.importDialog", async () => {
        const [path] = await deps.openDialog({ startingFolder: deps.documentsDir });
        // A cancelled dialog is not a failure: say nothing, exactly as file.openDialog does.
        if (!path) return;
        let text: string;
        try {
          // R-M5b-S2: the cap belongs to the read. `readFile` refuses from the opened handle's `fstat`, before it
          // allocates, so a multi-gigabyte file -- or a FIFO -- never reaches Main's heap at all. The shape this
          // replaced read the whole file and *then* measured the string, which bounded the parse and not the
          // read: by the time that check ran, the hazard the cap exists for had already happened.
          text = await deps.readFile(path, MAX_SNIPPETS_FILE_BYTES);
        } catch (error) {
          if (error instanceof FileTooLargeError) {
            deps.send.imported({ ok: false, reason: "tooLarge", detail: strings.snippets.tooLarge });
            return;
          }
          deps.send.imported({
            ok: false,
            reason: "unreadable",
            detail: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        const parsed = ((): SnippetsImported => {
          try {
            return parseSnippetsFile(JSON.parse(text) as unknown);
          } catch (error) {
            return {
              ok: false as const,
              reason: "notObject" as const,
              detail: error instanceof Error ? error.message : String(error),
            };
          }
        })();
        deps.send.imported(parsed);
      }),
      "snippets.exportDialog": message(snippetsExportParamsSchema, "snippets.exportDialog", async ({ snippets }) => {
        let path: string | null;
        try {
          path = await deps.saveDialog({ defaultName: SNIPPETS_EXPORT_NAME, defaultDir: deps.documentsDir });
        } catch (error) {
          deps.send.exported({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        if (path === null) {
          deps.send.exported({ cancelled: true });
          return;
        }
        try {
          await deps.writeFile(path, snippetsFileContent(snippets));
          deps.send.exported({ ok: true, path });
        } catch (error) {
          deps.send.exported({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      }),
    },
  };
}

// M4's lesson (a hand-written validator that silently omitted five message kinds, wedging every connection that
// sent one) in type form: the wire schema and this module's handlers cannot drift apart. A `snippets.*` entry added
// to MainRequests/MainMessages with no handler here fails typecheck, and a handler here with no schema entry fails
// too. Same idiom as apps/ui/src/view-messages.ts's `_allViewMessagesListed` (m-5).
type SnippetHandlers = ReturnType<typeof createSnippetHandlers>;
type RequestDrift =
  | Exclude<Extract<keyof MainRequests, `snippets.${string}`>, keyof SnippetHandlers["requests"]>
  | Exclude<keyof SnippetHandlers["requests"], Extract<keyof MainRequests, `snippets.${string}`>>;
type MessageDrift =
  | Exclude<Extract<keyof MainMessages, `snippets.${string}`>, keyof SnippetHandlers["messages"]>
  | Exclude<keyof SnippetHandlers["messages"], Extract<keyof MainMessages, `snippets.${string}`>>;
const _noRequestDrift: [RequestDrift] extends [never] ? true : false = true;
const _noMessageDrift: [MessageDrift] extends [never] ? true : false = true;
