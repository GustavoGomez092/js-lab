import { SETTINGS_SECTIONS, type Session, type Settings } from "@jslab/shared";
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

export const runStartParamsSchema = z.object({
  tabId,
  code: z.string().max(5_000_000),
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

export const bufferChangedSchema = z.object({ tabId, content: z.string().max(5_000_000) });

export const tabPatchSchema = z.object({
  tabId,
  patch: z
    .object({
      title: z.string().max(200),
      language: z.enum(["typescript", "javascript", "tsx", "jsx"]),
      layout: z.object({ orientation: z.enum(["horizontal", "vertical"]), editorSize: z.number().min(10).max(90) }),
    })
    .partial(),
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

export type CommandId = "run.start" | "run.stop" | "run.kill" | "output.clear" | "editor.clear";

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
}

/** Requests handled by Main, called by the UI. */
export type MainRequests = {
  "app.bootstrap": { params: Record<string, never>; response: BootstrapPayload };
  "run.start": { params: RunStartParams; response: { runId: string } };
  "run.expand": { params: RunExpandParams; response: EncodedValue | null };
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
};

/** Messages received by the UI, sent by Main. */
export type ViewMessages = {
  "run.events": { tabId: string; runId: string; events: RunEvent[] };
  "run.state": { tabId: string; runId: string; state: RunState; activeHandles?: number };
  "run.diagnostics": { tabId: string; runId: string; diagnostics: DiagnosticPayload[] };
  "menu.command": { command: CommandId };
  "e2e.request": E2ERequest;
};
