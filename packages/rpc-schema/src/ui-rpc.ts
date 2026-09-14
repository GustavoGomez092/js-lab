import type { CommandId, KeybindingRule, TabState } from "@jslab/shared";
import { LANGUAGES, RUNTIMES, SETTINGS_SECTIONS, type Session, type Settings } from "@jslab/shared";
import { z } from "zod";
import type { RunEvent, RunState } from "./events";
import type { EncodedValue } from "./values";

// Inbound payloads (UI → Main) are validated with these schemas before use (spec §18).

// Tab ids are created with crypto.randomUUID(). Main joins them into paths (runs/<tabId>/…), so only letters,
// digits, "_" and "-" are accepted: no separators, dots, whitespace or control characters (spec §18).
const tabId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Largest file JSLab opens, by dialog or by drop (spec §10.2 as amended in Task 25). Bigger files are refused. */
export const MAX_OPEN_FILE_BYTES = 50 * 1024 * 1024;

/**
 * One cap for a tab's whole text at the RPC boundary: buffer.changed, run.start, tab.create and file.save (Task 10).
 * A UTF-8 file of MAX_OPEN_FILE_BYTES decodes to at most that many UTF-16 units, so every file JSLab opens keeps at
 * least 14 MB of editing headroom. Above the cap the UI stops auto-saving and running the tab and says so (Task 13),
 * so an edit is never dropped silently by Main's validation.
 */
export const MAX_TEXT_CHARS = 64 * 1024 * 1024;

/** Requests without parameters still validate their input (spec §18). */
export const emptyParamsSchema = z.object({});

export const runStartParamsSchema = z.object({
  tabId,
  code: z.string().max(MAX_TEXT_CHARS),
  language: z.enum(["typescript", "javascript", "tsx", "jsx"]),
  logpoints: z.array(z.number().int().positive()).max(10_000),
  reason: z.enum(["auto", "manual"]),
});

export const tabParamsSchema = z.object({ tabId });

export const runExpandParamsSchema = z.object({
  tabId,
  runId: z.uuid(),
  handleId: z.string().regex(/^h\d+$/),
});

export const bufferChangedSchema = z.object({ tabId, content: z.string().max(MAX_TEXT_CHARS) });

const languageSchema = z.enum(LANGUAGES);
const runtimeSchema = z.enum(RUNTIMES);

export const tabPatchSchema = z.object({
  tabId,
  patch: z
    .object({
      title: z.string().max(200),
      titleIsCustom: z.boolean(),
      language: languageSchema,
      runtime: runtimeSchema,
      layout: z
        .object({
          orientation: z.enum(["horizontal", "vertical"]),
          editorSize: z.number().min(10).max(90),
          outputVisible: z.boolean(),
        })
        .partial(),
    })
    .partial(),
});

export const tabCreateParamsSchema = z.object({
  language: languageSchema.optional(),
  runtime: runtimeSchema.optional(),
  title: z.string().max(200).optional(),
  content: z.string().max(MAX_TEXT_CHARS).optional(),
});

export const tabReorderSchema = z.object({ tabOrder: z.array(tabId).min(1).max(500) });

const MAX_VIEW_STATE_CHARS = 200_000;
export const tabViewStateSchema = z
  .object({ tabId, viewState: z.unknown() })
  .refine((value) => (JSON.stringify(value.viewState ?? null)?.length ?? 0) <= MAX_VIEW_STATE_CHARS, {
    message: "viewState is too large",
  });

const settingValue = z.union([z.boolean(), z.number().finite(), z.string().max(200)]);

/**
 * `settings.update` patch: known sections only, scalar values only. Out-of-range values are repaired by
 * mergeSettings, never rejected.
 */
export const settingsUpdateParamsSchema = z.object({
  patch: z.partialRecord(z.enum(SETTINGS_SECTIONS), z.record(z.string().min(1).max(64), settingValue)),
});
export type SettingsUpdateParams = z.infer<typeof settingsUpdateParamsSchema>;

export const E2E_UI_METHODS = ["type", "key", "command", "state", "output"] as const;
export type E2EUiMethod = (typeof E2E_UI_METHODS)[number];

/** Main → UI: one E2E automation call, answered with an `e2e.response` message (spec §22.3). */
export interface E2ERequest {
  reqId: number;
  method: E2EUiMethod;
  params: unknown;
}

export const e2eResponseSchema = z.object({
  reqId: z.number().int().positive(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(10_000).optional(),
});
export type E2EResponse = z.infer<typeof e2eResponseSchema>;

export type RunStartParams = z.infer<typeof runStartParamsSchema>;
export type TabParams = z.infer<typeof tabParamsSchema>;
export type RunExpandParams = z.infer<typeof runExpandParamsSchema>;
export type BufferChanged = z.infer<typeof bufferChangedSchema>;
export type TabPatch = z.infer<typeof tabPatchSchema>;
export type TabCreateParams = z.infer<typeof tabCreateParamsSchema>;
export type TabReorder = z.infer<typeof tabReorderSchema>;
export type TabViewState = z.infer<typeof tabViewStateSchema>;
export type TabWithContent = { tab: TabState; content: string };
export type TabCloseResult = { ok: true; activeTabId: string; replacement: TabWithContent | null };

export type { CommandId };

export interface DiagnosticPayload {
  severity: "error" | "warning";
  code: string;
  message: string;
  line: number;
  column: number;
}

export interface BootstrapPayload {
  settings: Settings;
  session: Session;
  buffers: Record<string, string>;
  safeMode: { active: boolean; reason: "crashLoop" | "shift" | null };
  versions: { app: string; bun: string };
  /** True only when the app was launched with JSLAB_E2E=1; the UI then installs the automation agent. */
  e2e?: boolean;
  keybindings?: KeybindingRule[];
}

/** Requests handled by Main, called by the UI. */
export type MainRequests = {
  "app.bootstrap": { params: Record<string, never>; response: BootstrapPayload };
  "run.start": { params: RunStartParams; response: { runId: string } };
  "run.expand": { params: RunExpandParams; response: EncodedValue | null };
  "tab.create": { params: TabCreateParams; response: { tab: TabState } };
  "tab.close": { params: TabParams; response: TabCloseResult };
  "tab.reopen": { params: Record<string, never>; response: TabWithContent | null };
  "settings.update": { params: SettingsUpdateParams; response: Settings };
};

/** Messages received by Main, sent by the UI. */
export type MainMessages = {
  "run.stop": TabParams;
  "run.kill": TabParams;
  "run.wait": TabParams;
  "buffer.changed": BufferChanged;
  "tab.patch": TabPatch;
  "ui.heartbeat": Record<string, never>;
  "e2e.response": E2EResponse;
  "tab.activate": TabParams;
  "tab.reorder": TabReorder;
  "tab.viewState": TabViewState;
};

/** Messages received by the UI, sent by Main. */
export type ViewMessages = {
  "run.events": { tabId: string; runId: string; events: RunEvent[] };
  "run.state": { tabId: string; runId: string; state: RunState; activeHandles?: number };
  "run.diagnostics": { tabId: string; runId: string; diagnostics: DiagnosticPayload[] };
  "menu.command": { command: CommandId };
  "e2e.request": E2ERequest;
  "settings.changed": { settings: Settings };
};
