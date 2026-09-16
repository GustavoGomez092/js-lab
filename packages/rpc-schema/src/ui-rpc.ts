import type { CommandId, KeybindingRule, TabState } from "@jslab/shared";
import {
  type EnvVars,
  envVarsSchema,
  LANGUAGES,
  RUNTIMES,
  SETTINGS_SECTIONS,
  type Session,
  type Settings,
} from "@jslab/shared";
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
  // M4: the run's runtime. `.catch` keeps an older or malformed UI from failing the whole request, matching how
  // every other self-repairing field in this package behaves.
  runtime: z.enum(RUNTIMES).catch("bun"),
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
  titleIsCustom: z.boolean().optional(),
  content: z.string().max(MAX_TEXT_CHARS).optional(),
});

export const tabReorderSchema = z.object({ tabOrder: z.array(tabId).min(1).max(500) });

const MAX_VIEW_STATE_CHARS = 200_000;
export const tabViewStateSchema = z
  .object({ tabId, viewState: z.unknown() })
  .refine((value) => (JSON.stringify(value.viewState ?? null)?.length ?? 0) <= MAX_VIEW_STATE_CHARS, {
    message: "viewState is too large",
  });

export const APP_ACTIONS = [
  "copyDebugLog",
  "openLogsFolder",
  "restartSafeMode",
  "openDataFolder",
  "resetSettings",
  "toggleFullScreen",
  "closeWindow",
  "openSettings",
] as const;
export type AppAction = (typeof APP_ACTIONS)[number];
export const appCommandSchema = z.object({ action: z.enum(APP_ACTIONS) });

/** The only app actions the Settings window sends (spec §7.5, FA-m11): it can't close or resize the main window. */
export const SETTINGS_APP_ACTIONS = [
  "resetSettings",
  "openDataFolder",
  "restartSafeMode",
] as const satisfies readonly AppAction[];
export type SettingsAppAction = (typeof SETTINGS_APP_ACTIONS)[number];
export const settingsAppCommandSchema = z.object({ action: z.enum(SETTINGS_APP_ACTIONS) });

export const fileSaveParamsSchema = z.object({ tabId, content: z.string().max(MAX_TEXT_CHARS) });
export const fileConfirmLargeSchema = z.object({ tokens: z.array(z.uuid()).min(1).max(100) });
export const fileConfirmSaveAsSchema = z.object({ token: z.uuid(), confirmed: z.boolean() });

// ---------- M3: npm, environment variables, working directory, types and .npmrc (spec §6.2, §11, §12) ----------

/** npm package names: an optional @scope, lowercase URL-safe characters, at most 214 characters. */
export const npmNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/);

/** One `bun add` argument: a registry name with an optional range or tag, a git URL, or a tarball URL (spec §11.2, §18). */
export const npmSpecSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (spec) =>
      /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9._^~<>=*|+-]{1,256})?$/.test(spec) ||
      /^(?:git\+(?:https|ssh)|git):\/\/\S+$/.test(spec) ||
      /^https?:\/\/\S+$/.test(spec),
  );

export const MAX_NPMRC_CHARS = 65_536;

export const npmInstallParamsSchema = z.object({ spec: npmSpecSchema });
export const npmNameParamsSchema = z.object({ name: npmNameSchema });
export const npmSearchParamsSchema = z.object({ query: z.string().trim().min(1).max(214) });
export const npmListParamsSchema = z.object({ refreshOutdated: z.boolean() });
export const npmrcSaveParamsSchema = z.object({ content: z.string().max(MAX_NPMRC_CHARS) });
export const envSaveParamsSchema = z.object({ variables: envVarsSchema });
export const packageTypesParamsSchema = z.object({ tabId, packages: z.array(npmNameSchema).min(1).max(50) });
export const localTypesParamsSchema = z.object({
  tabId,
  specifiers: z
    .array(
      z
        .string()
        .min(2)
        .max(1024)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the class intentionally excludes control characters
        .regex(/^\.\.?\/[^\0-\x1f\\]*$/),
    )
    .min(1)
    .max(200),
});

export type NpmOpKind = "install" | "remove" | "update" | "updateAll";
export type NpmErrorKind =
  | "network"
  | "notFound"
  | "noMatchingVersion"
  | "peerConflict"
  | "scriptBlocked"
  | "nativeBuild"
  | "disk"
  | "timeout"
  | "unknown";

/** A classified npm failure (spec §11.3): the UI maps `kind` to a one-line hint and shows `log` in the log drawer. */
export interface NpmOpError {
  kind: NpmErrorKind;
  log: string;
}

export interface NpmOperation {
  id: string;
  kind: NpmOpKind;
  /** The spec or package name the operation acts on; "" for updateAll. */
  target: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: NpmOpError | null;
  /** A non-fatal condition on success, such as "scriptBlocked". */
  notice: NpmErrorKind | null;
}

export interface InstalledPackage {
  name: string;
  /** The version in node_modules, or null when it isn't installed there. */
  version: string | null;
  /** The newest version from the last `bun outdated`, or null when current or unknown. */
  latest: string | null;
}

export interface NpmListResult {
  installed: InstalledPackage[];
  outdatedCheckedAt: number | null;
  outdatedError: NpmOpError | null;
  /**
   * R-M3-OUTDATED-1: a monotonically increasing counter, stamped by `NpmService` at the moment this result's data
   * snapshot is taken (not when it's sent), so the UI store can drop a reply that loses a delivery-order race
   * against a newer `npm.changed` push instead of letting it overwrite fresher data (last-writer-wins was the bug).
   */
  revision: number;
}

export interface NpmSearchResult {
  name: string;
  version: string;
  description: string;
  weeklyDownloads: number | null;
}

export interface NpmSearchResponse {
  results: NpmSearchResult[];
  error: NpmOpError | null;
}

/** One declaration file registered with Monaco, at a `file:///` path. */
export interface TypeFile {
  path: string;
  content: string;
}

export interface PackageTypesResult {
  name: string;
  files: TypeFile[];
  /** Other packages the declarations import (requested separately). */
  dependencies: string[];
  /** `@types/<name>` when the package has no types and that package is installed or available. */
  typesPackage: string | null;
  hasTypes: boolean;
  truncated: boolean;
}

export interface LocalTypesResult {
  files: TypeFile[];
  /** Bare packages the local files import (requested separately). */
  packages: string[];
  truncated: boolean;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

export type { EnvVars };

export type FileSaveParams = z.infer<typeof fileSaveParamsSchema>;
export type LargeFile = { token: string; path: string; size: number };
export type FileOpened = { tabs: TabWithContent[]; focusTabId: string | null; large: LargeFile[]; errors: string[] };
export type FileSaveResult = { ok: true; tab: TabState } | { ok: false; error: string } | { needsSaveAs: true };

export type SystemFontList = { monospace: string[]; other: string[] };

/** Settings window ⇄ Main (spec §7.5): a separate, narrower RPC than the main window's. */
export type SettingsWindowRequests = {
  "settings.get": { params: Record<string, never>; response: { settings: Settings; e2e: boolean } };
  "settings.update": { params: SettingsUpdateParams; response: Settings };
  "fonts.list": { params: Record<string, never>; response: { fonts: SystemFontList | null; refreshing: boolean } };
  "npmrc.get": { params: Record<string, never>; response: { content: string } };
  "npmrc.save": { params: { content: string }; response: SaveResult };
  "npmrc.reset": { params: Record<string, never>; response: { content: string } };
};

export type SettingsWindowMessages = {
  "app.command": { action: SettingsAppAction };
  "e2e.response": E2EResponse;
};

export type SettingsViewMessages = {
  "settings.changed": { settings: Settings };
  "e2e.request": E2ERequest;
};

export const STARTUP_NOTICE_IDS = [
  "settingsRecovered",
  "sessionRecovered",
  "settingsNewer",
  "sessionNewer",
  "tabsDropped",
  "unexpectedError",
] as const;

/**
 * Something Main wants the user to know (spec §20): at startup, recovered files, newer files and skipped tabs; later,
 * an unexpected Main error (FA-I3), sent as an `app.notice` message.
 */
export interface StartupNotice {
  id: (typeof STARTUP_NOTICE_IDS)[number];
  message: string;
}

/** `app.notice` (Main → UI): validated by the UI before it is shown (FA-I3). */
export const appNoticeSchema = z.object({ id: z.enum(STARTUP_NOTICE_IDS), message: z.string().min(1).max(2000) });

const settingValue = z.union([z.boolean(), z.number().finite(), z.string().max(200)]);

/** Most keys one `settings.update` section may carry (FA-m7): loose sections keep unknown keys, so this bounds junk. */
export const MAX_SETTINGS_PATCH_KEYS = 64;

/**
 * `settings.update` patch: known sections only, scalar values only, at most 64 keys per section. Out-of-range values
 * are repaired by mergeSettings, never rejected.
 */
export const settingsUpdateParamsSchema = z.object({
  patch: z.partialRecord(
    z.enum(SETTINGS_SECTIONS),
    z
      .record(z.string().min(1).max(64), settingValue)
      .refine((section) => Object.keys(section).length <= MAX_SETTINGS_PATCH_KEYS, {
        message: `A settings section patch may set at most ${MAX_SETTINGS_PATCH_KEYS} keys`,
      }),
  ),
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
  safeMode: { active: boolean; reason: "crashLoop" | "manual" | "shift" | null };
  versions: { app: string; bun: string };
  /** True only when the app was launched with JSLAB_E2E=1; the UI then installs the automation agent. */
  e2e?: boolean;
  keybindings?: KeybindingRule[];
  notices?: StartupNotice[];
}

/** Requests handled by Main, called by the UI. */
export type MainRequests = {
  "app.bootstrap": { params: Record<string, never>; response: BootstrapPayload };
  "run.start": { params: RunStartParams; response: { runId: string } };
  "run.expand": { params: RunExpandParams; response: EncodedValue | null };
  "tab.create": { params: TabCreateParams; response: { tab: TabState } };
  "tab.close": { params: TabParams; response: TabCloseResult };
  "tab.reopen": { params: Record<string, never>; response: TabWithContent | null };
  "settings.get": { params: Record<string, never>; response: { settings: Settings; e2e: boolean } };
  "settings.update": { params: SettingsUpdateParams; response: Settings };
  "file.save": { params: FileSaveParams; response: FileSaveResult };
  "npm.list": { params: { refreshOutdated: boolean }; response: NpmListResult };
  "npm.search": { params: { query: string }; response: NpmSearchResponse };
  "types.package": { params: { tabId: string; packages: string[] }; response: { packages: PackageTypesResult[] } };
  "types.local": { params: { tabId: string; specifiers: string[] }; response: LocalTypesResult };
  "env.get": { params: Record<string, never>; response: { variables: EnvVars } };
  "env.save": { params: { variables: EnvVars }; response: SaveResult };
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
  "app.command": { action: AppAction };
  "file.openDialog": Record<string, never>;
  "file.confirmLarge": { tokens: string[] };
  "file.saveAsDialog": FileSaveParams;
  "file.confirmSaveAs": { token: string; confirmed: boolean };
  "tab.revealInFinder": TabParams;
  "tab.copyPath": TabParams;
  "npm.install": { spec: string };
  "npm.remove": { name: string };
  "npm.update": { name: string };
  "npm.updateAll": Record<string, never>;
  "wd.pick": TabParams;
  "wd.clear": TabParams;
  "ui.stateFlushed": Record<string, never>;
};

/** Messages received by the UI, sent by Main. */
export type ViewMessages = {
  "run.events": { tabId: string; runId: string; events: RunEvent[] };
  "run.state": { tabId: string; runId: string; state: RunState; activeHandles?: number };
  "run.diagnostics": { tabId: string; runId: string; diagnostics: DiagnosticPayload[] };
  "menu.command": { command: CommandId; args?: unknown };
  "e2e.request": E2ERequest;
  "settings.changed": { settings: Settings };
  "file.opened": FileOpened;
  "file.saved": { tabId: string; tab: TabState };
  "file.saveAsConfirm": { token: string; tabId: string; path: string };
  "file.saveCancelled": { tabId: string };
  "file.saveFailed": { tabId: string; error: string };
  "app.notice": StartupNotice;
  "npm.op": NpmOperation;
  "npm.log": { opId: string; text: string };
  "npm.changed": NpmListResult;
  "wd.changed": { tabId: string; tab: TabState };
  "app.flushState": Record<string, never>;
};
