import type { CommandCategory, CommandId, KeybindingRule, TabState } from "@jslab/shared";
import {
  type ConversationTurn,
  conversationTurnSchema,
  DEFAULT_RUNTIME,
  type EnvVars,
  envVarsSchema,
  keybindingRuleSchema,
  LANGUAGES,
  MAX_CONVERSATION_TURNS,
  MAX_SNIPPETS,
  RUNTIMES,
  SETTINGS_SECTIONS,
  type Session,
  type Settings,
  type Snippet,
  snippetSchema,
} from "@jslab/shared";
import type { ThemeDefinition } from "@jslab/themes";
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
  /**
   * OU-02: the index of the first collection entry to return. Omitted means 0 -- exactly what every caller sent
   * before this field existed. No upper bound is needed: the encoder clamps (`#take`), and an offset past the end
   * is a well-defined empty page rather than an error.
   */
  offset: z.number().int().min(0).optional(),
});

/** Spec §7.4 / Appendix A: the latest Babel output for a tab, optionally without the instrumentation calls. */
export const runTranspiledParamsSchema = z.object({ tabId, hideInstrumentation: z.boolean() });

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
      // Final review (E): `.catch` for the same reason `tiles` is `.partial()` and `muted` degrades -- every field
      // inside this patch object must fail on its own or not at all. Without it an unrecognised runtime (a
      // version-skewed renderer mid-auto-update, a future build naming a runtime this Main doesn't know) failed the
      // whole `safeParse`, so Main silently dropped the ENTIRE patch -- a legitimate simultaneous title or language
      // change with it -- logging only "Rejected invalid tab.patch payload" with nothing user-visible. Matches
      // `runStartParamsSchema.runtime` (`.catch("bun")`) and `tabStateSchema.runtime` (`.catch(DEFAULT_RUNTIME)`).
      // Applied here rather than on the shared `runtimeSchema`, so `tabCreateParamsSchema` keeps rejecting outright.
      runtime: runtimeSchema.catch(DEFAULT_RUNTIME),
      layout: z
        .object({
          orientation: z.enum(["horizontal", "vertical"]),
          editorSize: z.number().min(10).max(90),
          outputVisible: z.boolean(),
          // M4 Task 8 (ruling R-M4-T8-PATCH-1): added alongside the three fields above -- this whitelist is the
          // one place a new `tabLayoutSchema` (packages/shared) field must also be named, or it is silently
          // stripped in transit (the UI updates, nothing persists, no error anywhere).
          // Fix round 1 (F5): `.partial()` here too, matching its parent `layout` -- otherwise a `tiles` patch
          // that omits even one field (a future partial patch, e.g. Task 15's `muted` alone) fails validation and
          // takes the *whole* tab.patch down with it, language/runtime/title included.
          tiles: z
            .object({
              webviewVisible: z.boolean(),
              consoleSize: z.number().min(10).max(90),
            })
            .partial(),
          // Task 15 (spec §5.12, EX-35): a sibling field of `tiles`, not nested inside it -- named here for the
          // same reason `tiles` is (R-M4-T8-PATCH-1's comment above), or it is silently stripped in transit.
          muted: z.boolean(),
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
  "zoomWindow",
  "closeWindow",
  "openSettings",
  "installCli",
  "uninstallCli",
  "openKeybindingsFile",
  // ST-11 (spec §7.4): Help → Documentation / Report Issue / What's New. Each opens a page in the user's
  // default browser through Main's one external-link path; the UI never learns the URLs.
  "openDocumentation",
  "reportIssue",
  "openWhatsNew",
  // M6: Help → About → Open-Source Notices…. Main stages THIRD-PARTY-NOTICES.md into the bundle and owns its
  // path (`app-paths.ts`'s `noticesFile`), so the UI names the action and never a filesystem path (spec §18).
  "openThirdPartyNotices",
] as const;
export type AppAction = (typeof APP_ACTIONS)[number];
export const appCommandSchema = z.object({ action: z.enum(APP_ACTIONS) });

/** The only app actions the Settings window sends (spec §7.5, FA-m11): it can't close or resize the main window. */
export const SETTINGS_APP_ACTIONS = [
  "resetSettings",
  "openDataFolder",
  "restartSafeMode",
  // Spec §6.5: Settings → Keybindings offers "Open keybindings.json", so this one is sent by the Settings window
  // rather than the main window. It opens a file in the user's editor; it cannot touch the main window.
  "openKeybindingsFile",
] as const satisfies readonly AppAction[];
export type SettingsAppAction = (typeof SETTINGS_APP_ACTIONS)[number];
export const settingsAppCommandSchema = z.object({ action: z.enum(SETTINGS_APP_ACTIONS) });

export const fileSaveParamsSchema = z.object({ tabId, content: z.string().max(MAX_TEXT_CHARS) });
export const fileConfirmLargeSchema = z.object({ tokens: z.array(z.uuid()).min(1).max(100) });
export const fileConfirmSaveAsSchema = z.object({ token: z.uuid(), confirmed: z.boolean() });

// ---------- M5d Task 10: the command catalogue and keybindings on the Settings wire (spec §6.5) ----------

/**
 * One row of Settings → Keybindings.
 *
 * Rows are derived from `COMMANDS` in @jslab/shared -- the single list every milestone already extends, since
 * `isCommandId` gates binding, dispatch and menu clicks -- so a command added by another milestone appears in the
 * editor with no change to M5d's code (R-M5D-REGISTRY-1). Nothing here enumerates commands by hand.
 */
export interface CommandCatalogEntry {
  id: CommandId;
  title: string;
  category: CommandCategory;
  /** True when the running main window has this command registered. */
  registered: boolean;
}

/**
 * `commands.published` (UI → Main): the ids the main window's `CommandRegistry` actually holds. Validated because it
 * crosses into Main (spec §18). The catalogue only ever *annotates* its rows with these, so an id Main does not
 * recognise is harmless -- it simply matches no row.
 */
export const commandsPublishedSchema = z.object({ ids: z.array(z.string().min(1).max(100)).max(1000) });

/**
 * `keybindings.save`: the whole override set, replacing the file's contents rather than patching it.
 * `keybindingRuleSchema` is the same per-rule validator the read path uses, so the Settings window cannot write a
 * rule that a later launch would silently drop.
 */
export const keybindingsSaveParamsSchema = z.object({
  rules: z.array(keybindingRuleSchema).max(500),
});

// ---------- M5d Task 8: Themes → Import VS Code Theme… (spec §9.3) ----------

/** What the UI is told about a theme that was just imported; its full definition arrives on `theme.changed`. */
export interface ImportedTheme {
  id: string;
  name: string;
  type: "dark" | "light";
}

/** One `contributes.themes` entry offered when a `.vsix` declares more than one. `path` is an archive entry name. */
export interface VsixChoice {
  label: string;
  path: string;
}

/**
 * Three outcomes: the theme was imported, a multi-theme `.vsix` needs the user to choose, or nothing was imported.
 *
 * `ok: false` with an EMPTY `error` is a cancelled dialog -- a non-event the UI must report as nothing at all, not
 * as a failure. `notes` carries the honest caveats about what the conversion could not preserve (R-M5d-AA-1 and the
 * dropped `semanticTokenColors`), so a theme that converts to something plainer than the file says why.
 */
export type ThemeImportResult =
  | { ok: true; theme: ImportedTheme; notes: string[] }
  | { ok: true; choices: VsixChoice[]; token: string }
  | { ok: false; error: string };

export const themeImportPickParamsSchema = z.object({
  token: z.uuid(),
  // An archive entry name the manifest declared, never a filesystem path (spec §18).
  path: z.string().min(1).max(512),
});
export type ThemeImportPickParams = z.infer<typeof themeImportPickParamsSchema>;

// ---------- M4 Task 9a: the Main ⇄ UI web-runner bridge (spec §5.12) ----------

/**
 * A browser-mode tab's `<electrobun-webview>` lives in the UI process (Task 8's `WebViewTile`), but the runtime
 * that drives it -- `WebAdapter` (`apps/desktop/src/main/runtimes/web-adapter.ts`) -- lives in Main. These messages
 * are that seam: Main asks the UI to act on one tab's element (`webRunner.ensure` / `.execute` / `.reload` /
 * `.destroy`, typed in `ViewMessages`), and the UI reports what the element did back (`webRunner.ready` / `.exit` /
 * `.message`, validated here because they cross into Main).
 *
 * Only the UI → Main direction carries validators: `ViewMessages` payloads are built by Main itself and never
 * re-enter it, exactly as every other `ViewMessages` entry is left unvalidated.
 */
export const webRunnerTabSchema = z.object({ tabId, generation: z.number().int().positive() });

/**
 * `webRunner.message`: one page → host envelope, relayed verbatim. `raw` is deliberately only checked for being a
 * plain object -- enough to route it -- and never interpreted here: the envelope's own `{seq, message}` shape is
 * `createSequencedWebviewHost`'s to check (`web-adapter.ts`), and the page-side bridge already validated the
 * reverse direction. A record keeps every key it was given, so nothing inside `raw` is stripped in transit.
 */
export const webRunnerMessageParamsSchema = z.object({ tabId, raw: z.record(z.string(), z.unknown()) });

export type WebRunnerTabParams = z.infer<typeof webRunnerTabSchema>;
export type WebRunnerMessageParams = z.infer<typeof webRunnerMessageParamsSchema>;

// ---------- M3: npm, environment variables, working directory, types and .npmrc (spec §6.2, §11, §12) ----------

/**
 * npm's own package-name length limit. Exported because the UI must not re-derive it: `type-feeder.ts` filters
 * names against this before sending `types.package`, and a UI copy that drifted from the schema's would make
 * Main reject the request -- which `type-feeder.ts` only logs, so autocomplete would silently stop appearing.
 * Same rule as `packages/shared/src/env-vars.ts`: the limit is exported once and imported on both sides.
 */
export const MAX_PACKAGE_NAME_CHARS = 214;

/** Most package names one `types.package` request may carry; the UI chunks its requests to this size. */
export const MAX_PACKAGES_PER_REQUEST = 50;

/** Most relative specifiers one `types.local` request may carry; the UI truncates to this length. */
export const MAX_LOCAL_SPECIFIERS_PER_REQUEST = 200;

/** npm package names: an optional @scope, lowercase URL-safe characters, at most 214 characters. */
export const npmNameSchema = z
  .string()
  .min(1)
  .max(MAX_PACKAGE_NAME_CHARS)
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

// ---------- OU-13: URLs in output text, opened in the user's browser (spec §18) ----------

/**
 * The only schemes JSLab will hand to the OS from output text, as an ALLOWLIST.
 *
 * Output is produced by the user's own running program: a script can `console.log` any string it likes, and
 * OU-13 turns strings into things the user clicks. Deciding by "which schemes are dangerous" is the wrong shape
 * -- `javascript:`, `data:`, `vbscript:` and `file:` are merely the ones we thought of today -- so nothing is
 * clickable unless its scheme is named right here.
 */
export const EXTERNAL_URL_PROTOCOLS = ["http:", "https:"] as const;

/** Longest URL that may be linkified or opened; the same bound `npmSpecSchema` already puts on a tarball URL. */
export const MAX_EXTERNAL_URL_CHARS = 2048;

/**
 * Whether `raw` holds a character the WHATWG URL parser would SILENTLY REMOVE: it strips leading and trailing
 * C0 controls and spaces, and it deletes every tab, LF and CR anywhere in the input.
 *
 * That removal is both halves of the classic bypass. It is how a tab inside `java<TAB>script:`, or a leading
 * control character, reaches the parser as a bare `javascript:` scheme; and it is a display/destination split,
 * because without this rule the text `ht<TAB>tps://evil.example` would render as itself while opening
 * `https://evil.example`. Refusing these outright makes `new URL(raw)` see exactly the characters the user sees,
 * so the protocol check below is a check on the literal text rather than on a normalised rewrite of it.
 *
 * Written as a code-point scan rather than a character class so this file stays pure ASCII -- the equivalent
 * regex has to spell out control characters, and a literal one in source is a hazard the tooling trips over.
 */
function hasHiddenChars(raw: string): boolean {
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether `raw` may be turned into something the user can click, and handed to `openExternal`.
 *
 * The single authority for that question. The UI imports it to decide what becomes a link at all, and Main
 * re-validates with it at the RPC boundary (`linkOpenParamsSchema`), so a UI that was somehow talked into
 * sending a `javascript:` URL still cannot make Main open one.
 */
export function isSafeExternalUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > MAX_EXTERNAL_URL_CHARS) return false;
  if (hasHiddenChars(raw)) return false;
  /**
   * The authority form (`scheme://host`), spelled out in the text itself.
   *
   * For a "special" scheme the WHATWG parser fills in a missing authority: `new URL("https:example")` yields
   * `https://example/`. Without this rule the row would display `https:example` while opening something with a
   * `//` in it -- the same display/destination split `hasHiddenChars` above exists to prevent.
   *
   * Deliberately generic rather than an `^https?://` test: it says only that the text must name a host, leaving
   * WHICH schemes are allowed entirely to the allowlist below. That separation is what keeps the allowlist
   * load-bearing -- `ftp://example.com` and `file:///etc/passwd` both satisfy this line and are refused there.
   */
  const schemeEnd = raw.indexOf(":");
  if (schemeEnd < 0 || !raw.startsWith("//", schemeEnd + 1)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  // `new URL` lower-cases the scheme, so `JaVaScRiPt:` is compared here as `javascript:` and fails the allowlist.
  if (!(EXTERNAL_URL_PROTOCOLS as readonly string[]).includes(parsed.protocol)) return false;
  // `https://user:pass@evil.example` puts `user` where a reader looks for the host. Rather than trying to render
  // that safely, it is simply never clickable -- it stays ordinary selectable, copyable text.
  return parsed.username === "" && parsed.password === "";
}

/**
 * `link.open` (UI → Main). The URL crosses into Main, so Main validates it with the very rule the UI used to
 * decide the thing was clickable (spec §18) -- one allowlist, checked on both sides of the wire.
 */
export const linkOpenParamsSchema = z.object({
  url: z.string().max(MAX_EXTERNAL_URL_CHARS).refine(isSafeExternalUrl),
});

export const MAX_NPMRC_CHARS = 65_536;
/**
 * The cap the *read* side enforces. `MAX_NPMRC_CHARS` bounded `npmrc.save` and nothing ever bounded the read, so
 * a `.npmrc` grown by `npm config set`, `npm login` or any package's postinstall was read whole on every search
 * and every registry resolve. Four bytes per char is UTF-8's worst case, so everything `npmrc.save` accepts stays
 * readable while a multi-GB file is still refused before it is allocated.
 */
export const MAX_NPMRC_BYTES = 4 * MAX_NPMRC_CHARS;

export const npmInstallParamsSchema = z.object({ spec: npmSpecSchema });
export const npmNameParamsSchema = z.object({ name: npmNameSchema });
export const npmSearchParamsSchema = z.object({ query: z.string().trim().min(1).max(MAX_PACKAGE_NAME_CHARS) });
export const npmListParamsSchema = z.object({ refreshOutdated: z.boolean() });
export const npmrcSaveParamsSchema = z.object({ content: z.string().max(MAX_NPMRC_CHARS) });
export const envSaveParamsSchema = z.object({ variables: envVarsSchema });

/** Spec §13.4: the largest snippets file an import will read. Bigger files are refused without being parsed. */
export const MAX_SNIPPETS_FILE_BYTES = 5 * 1024 * 1024;
export const snippetsSaveParamsSchema = z.object({ snippets: z.array(snippetSchema).max(MAX_SNIPPETS) });
export const snippetsExportParamsSchema = snippetsSaveParamsSchema;

/** The result of `snippets.importDialog`: parsed records, or the reason the file was refused (spec §13.4). */
export type SnippetsImported = { ok: true; snippets: Snippet[] } | { ok: false; reason: string; detail: string };
export type SnippetsExported = { ok: true; path: string } | { ok: false; error: string } | { cancelled: true };
export type { Snippet };
export const packageTypesParamsSchema = z.object({
  tabId,
  packages: z.array(npmNameSchema).min(1).max(MAX_PACKAGES_PER_REQUEST),
});
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
    .max(MAX_LOCAL_SPECIFIERS_PER_REQUEST),
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
  /** Every command in the shared catalogue, annotated with what the running main window registered (Finding S1). */
  "commands.catalog": { params: Record<string, never>; response: { commands: CommandCatalogEntry[] } };
  "keybindings.get": {
    params: Record<string, never>;
    /** `invalid` is true when keybindings.json could not be parsed at startup, so Settings must not write over it. */
    response: { rules: KeybindingRule[]; defaults: KeybindingRule[]; path: string; invalid: boolean };
  };
  "keybindings.save": { params: { rules: KeybindingRule[] }; response: SaveResult };
};

export type SettingsWindowMessages = {
  "app.command": { action: SettingsAppAction };
  "e2e.response": E2EResponse;
};

export type SettingsViewMessages = {
  "settings.changed": { settings: Settings };
  "e2e.request": E2ERequest;
  /**
   * Finding K1 on the Settings side: the whole override set after a save, never a delta. The main window gets the
   * same push through `ViewMessages`; this is what keeps the Keybindings pane showing what is actually on disk when
   * the file is changed by something other than the pane itself.
   */
  "keybindings.changed": { rules: KeybindingRule[] };
};

export const STARTUP_NOTICE_IDS = [
  "settingsRecovered",
  "sessionRecovered",
  "settingsNewer",
  "sessionNewer",
  "tabsDropped",
  // F1: one tab whose buffer file can't be read no longer fails the whole `app.bootstrap`. The app opens with that
  // tab empty (Main keeps it in its unreadable set, so nothing overwrites the file on disk) and says so here.
  "buffersUnreadable",
  "unexpectedError",
  /**
   * D1: a settings change that cannot be written, because settings.json is large enough that JSLab's own rewrite of
   * it would exceed the cap its reader applies. Like `unexpectedError` this is raised after startup, not from
   * `startupNotices`; unlike it, the condition persists, so it is raised once per session rather than per change.
   */
  "settingsTooLarge",
  /**
   * Spec §16.1: the result of Help → Install/Uninstall `jslab` Command…. `app.notice` is the one Main → UI message
   * the UI re-validates before showing (FA-I3), so this id has to be listed here or the install result is dropped.
   */
  "cliInstall",
  /**
   * Spec §17: "Changing the language needs a restart (a notice is shown)." Raised by `settings.onChange` in the
   * main window, where the menus built in the old language still are — the Settings window's own field carries a
   * static "Restart required" badge, but the user is looking at the menus.
   */
  "languageChanged",
] as const;

export const NOTICE_SEVERITIES = ["info", "warning", "error"] as const;

/** How loudly a notice speaks (UI item 7): its colour, its icon, and whether it may dismiss itself. */
export type NoticeSeverity = (typeof NOTICE_SEVERITIES)[number];

/**
 * The severity each notice id speaks in unless Main overrides it. Total by construction: an id added to
 * STARTUP_NOTICE_IDS without an entry here fails typecheck. That is the point — a missing severity would
 * otherwise surface as a banner in the wrong tone, which is exactly the class of defect that hides.
 *
 * `settingsTooLarge` is a `warning` rather than an `error` deliberately: Main's own strings word it after
 * `settingsNewer` ("the same situation") and it has that id's consequence — settings changes silently lost at
 * restart. Only `warning` and `error` persist, so nothing about it auto-dismisses either way.
 */
export const DEFAULT_NOTICE_SEVERITY: Record<(typeof STARTUP_NOTICE_IDS)[number], NoticeSeverity> = {
  // JSLab already put things right, and is telling the user so.
  settingsRecovered: "info",
  sessionRecovered: "info",
  cliInstall: "info",
  // Nothing is broken and nothing was lost — the user asked for a language and is being told when they will see
  // it. `info` also means it dismisses itself after NOTICE_AUTO_DISMISS_MS, which is right for a confirmation
  // the user just triggered and would otherwise have to clear by hand.
  languageChanged: "info",
  // Still usable, but degraded: changes that will not be saved, tabs that did not come back.
  settingsNewer: "warning",
  sessionNewer: "warning",
  tabsDropped: "warning",
  buffersUnreadable: "warning",
  settingsTooLarge: "warning",
  unexpectedError: "error",
};

/**
 * Something Main wants the user to know (spec §20): at startup, recovered files, newer files and skipped tabs; later,
 * an unexpected Main error (FA-I3) or a settings write refused as too large (D1), sent as an `app.notice` message.
 */
export interface StartupNotice {
  id: (typeof STARTUP_NOTICE_IDS)[number];
  message: string;
  /**
   * Set only where the id alone cannot say: `cliInstall` reports both a successful install and a failed one
   * (`CliInstallResult.ok`). Every other id takes its severity from DEFAULT_NOTICE_SEVERITY.
   */
  severity?: NoticeSeverity;
}

/** A notice's severity: Main's override if it sent one, otherwise the id's own. Never undefined. */
export function noticeSeverity(notice: StartupNotice): NoticeSeverity {
  return notice.severity ?? DEFAULT_NOTICE_SEVERITY[notice.id];
}

/** `app.notice` (Main → UI): validated by the UI before it is shown (FA-I3). */
export const appNoticeSchema = z.object({
  id: z.enum(STARTUP_NOTICE_IDS),
  message: z.string().min(1).max(2000),
  severity: z.enum(NOTICE_SEVERITIES).optional(),
});

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

// ---------- TL-18/TL-19/TL-21: AI chat (spec §14) ----------

/**
 * One turn of a conversation. `system` never crosses this wire in the UI → Main direction -- the system prompt is
 * bundled with the app (spec §14.2) and built in Main, so a renderer cannot replace the assistant's instructions.
 */
export const AI_ROLES = ["user", "assistant"] as const;
export type AiRole = (typeof AI_ROLES)[number];
export interface AiMessage {
  role: AiRole;
  content: string;
}

/** One message's text on the wire. Main trims history to the model's budget; this only bounds a single turn. */
export const MAX_AI_MESSAGE_CHARS = 100_000;
/** Most turns one request may carry. Main trims oldest-first inside this (spec §14.2). */
export const MAX_AI_HISTORY_MESSAGES = 200;
/**
 * The run output the UI may attach (spec §14.2 caps what is SENT to the model at 20 KB).
 *
 * Wider than that budget on purpose: the UI sends the tail of the output and Main owns the 20 KB truncation, so
 * the cap that reaches the model is decided in one place. Without a wire bound, though, a run that printed
 * megabytes would ship all of it to Main just to be thrown away.
 */
export const MAX_AI_OUTPUT_CHARS = 200_000;

export const aiMessageSchema = z.object({
  role: z.enum(AI_ROLES),
  content: z.string().max(MAX_AI_MESSAGE_CHARS),
});

/**
 * `ai.send` (UI → Main). Carries the request's whole context, because Main holds none of it: the conversation
 * lives in the UI store and the run output exists only in the renderer.
 *
 * `requestId` is what `ai.chunk` / `ai.done` / `ai.error` are correlated by, and what `ai.stop` names. A reply
 * for a request the panel has abandoned is therefore identifiable and dropped, rather than being appended to
 * whatever conversation happens to be on screen.
 */
export const aiSendParamsSchema = z.object({
  requestId: z.uuid(),
  tabId,
  prompt: z.string().min(1).max(MAX_AI_MESSAGE_CHARS),
  code: z.string().max(MAX_TEXT_CHARS),
  language: z.enum(LANGUAGES),
  runtime: z.enum(RUNTIMES).catch(DEFAULT_RUNTIME),
  /** The tab's working-directory name (not its path): spec §14.2 marks the code with the WD name. */
  workingDirectoryName: z.string().max(200).optional(),
  /** Rendered run output, already tail-trimmed by the UI. Absent when `ai.includeOutput` is off (spec §8). */
  output: z.string().max(MAX_AI_OUTPUT_CHARS).optional(),
  history: z.array(aiMessageSchema).max(MAX_AI_HISTORY_MESSAGES),
});
export type AiSendParams = z.infer<typeof aiSendParamsSchema>;

/** `ai.stop`: abort the named in-flight request. Really aborts the HTTP request (spec §14.1's Stop button). */
export const aiStopParamsSchema = z.object({ requestId: z.uuid() });

/**
 * `ai.conversationSave` (UI → Main): the transcript to write to `ai/conversation.json` (spec §14.3).
 *
 * The WHOLE conversation, never a delta -- the same rule `snippets.save` follows (R-M5b-6). The UI is the only
 * holder of the conversation, so a delta protocol would oblige Main to keep a second copy to apply deltas to,
 * and the two could then disagree about what the user is actually looking at.
 */
export const conversationSaveParamsSchema = z.object({
  messages: z.array(conversationTurnSchema).max(MAX_CONVERSATION_TURNS),
});
export type ConversationSaveParams = z.infer<typeof conversationSaveParamsSchema>;

/**
 * How an AI request failed, classified so the panel can say something useful and offer Retry (spec §14.3 names
 * 401, 429, network and context-too-long). Same shape as `NpmErrorKind`: Main classifies, the UI translates -- so
 * no provider message has to be a translated string coming out of Main.
 */
export const AI_ERROR_KINDS = [
  "auth",
  "rateLimit",
  "network",
  "contextTooLong",
  "modelNotFound",
  "http",
  /** The stream stopped producing bytes without ending (spec-silent; see `ai/stream.ts`). */
  "stalled",
  /** The response exceeded the streaming byte cap without ending. */
  "tooLarge",
  /** No provider configured, or one this build does not implement. */
  "notConfigured",
  "unknown",
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

export interface AiError {
  requestId: string;
  kind: AiErrorKind;
  /**
   * The provider's own words, for the detail line. Never a key and never a translated string: it is a remote
   * server's text, so the panel shows it as data beneath a translated headline.
   */
  detail: string;
}

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
export type RunTranspiledParams = z.infer<typeof runTranspiledParamsSchema>;
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
  /**
   * B1: the tabs whose buffer file exists but couldn't be read, by id -- not just how many.
   *
   * These ids are exactly the `session.tabOrder` entries missing from `buffers` above. Main deliberately omits
   * them rather than inventing `""`, and the UI needs to know WHICH they are to preserve that distinction: with
   * only a count it turned every absence into an empty buffer, which then read as an ordinary unsaved edit and
   * offered to save it over the user's real file. A tab named here has unknown content, so the UI shows it
   * read-only and never saves it.
   */
  unreadableBuffers?: string[];
  safeMode: { active: boolean; reason: "crashLoop" | "manual" | "shift" | null };
  /**
   * M6: `electrobun` joins `app` and `bun` so the About dialog can name the framework version the app is
   * actually running on -- until now only the debug report knew it (`logging/debug-report.ts`), because the
   * bootstrap payload carried just the two.
   *
   * Optional purely so the ~70 existing test fixtures that build `{ app, bun }` keep compiling; Main always
   * sends all three, which `apps/desktop/test/rpc-handlers.test.ts` pins against a literal rather than
   * against the constant Main itself reads.
   */
  versions: { app: string; bun: string; electrobun?: string };
  /** True only when the app was launched with JSLAB_E2E=1; the UI then installs the automation agent. */
  e2e?: boolean;
  keybindings?: KeybindingRule[];
  notices?: StartupNotice[];
  /** Spec §9.3: the themes imported into `<appdata>/themes/`, so the first paint already offers them (Finding T1). */
  userThemes?: ThemeDefinition[];
  /**
   * Spec §14.3: "the current conversation is kept in `ai/conversation.json` and restored at launch".
   *
   * Omitted rather than sent empty, exactly as `keybindings` and `userThemes` above are, so a fresh profile's
   * payload carries no empty array and the UI's own initial state stands.
   */
  conversation?: ConversationTurn[];
}

/** Requests handled by Main, called by the UI. */
export type MainRequests = {
  "app.bootstrap": { params: Record<string, never>; response: BootstrapPayload };
  "run.start": { params: RunStartParams; response: { runId: string } };
  "run.expand": { params: RunExpandParams; response: EncodedValue | null };
  /**
   * R-M5a-7: `source` is the exact source Main transpiled to produce `code`, so the panel can say when what it
   * shows is output for code the user has since edited. Re-deriving that UI-side from the last `run.start` payload
   * is unsound -- after a run that fails to transpile, Main still serves the previous successful transform.
   */
  "run.transpiled": { params: RunTranspiledParams; response: { code: string; source: string } | null };
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
  "snippets.list": { params: Record<string, never>; response: { snippets: Snippet[] } };
  "snippets.save": { params: { snippets: Snippet[] }; response: SaveResult };
  /** Spec §9.3: Main opens its own file dialog -- the UI never names a path (spec §18). */
  "theme.import": { params: Record<string, never>; response: ThemeImportResult };
  /** The second half of a multi-theme `.vsix` import: `token` names the archive Main already holds. */
  "theme.importPick": { params: ThemeImportPickParams; response: ThemeImportResult };
};

/**
 * Every `MainRequests` method paired with the schema Main validates its params against (spec §18).
 *
 * Exhaustive by type: a new entry in `MainRequests` fails to compile here until it is registered. That is what lets
 * the UI's per-request timeout table (`apps/ui/src/rpc-timeouts.ts`) be checked against the *schema* rather than
 * against a hand-written list -- a request whose params admit a `MAX_TEXT_CHARS` string is detected here instead of
 * being remembered. `emptyParamsSchema` is the entry for requests that take no params.
 */
export const MAIN_REQUEST_PARAMS_SCHEMAS: Record<keyof MainRequests, z.ZodType> = {
  "app.bootstrap": emptyParamsSchema,
  "run.start": runStartParamsSchema,
  "run.expand": runExpandParamsSchema,
  "tab.create": tabCreateParamsSchema,
  "tab.close": tabParamsSchema,
  "tab.reopen": emptyParamsSchema,
  "settings.get": emptyParamsSchema,
  "settings.update": settingsUpdateParamsSchema,
  "file.save": fileSaveParamsSchema,
  "npm.list": npmListParamsSchema,
  "npm.search": npmSearchParamsSchema,
  "types.package": packageTypesParamsSchema,
  "types.local": localTypesParamsSchema,
  "env.get": emptyParamsSchema,
  "env.save": envSaveParamsSchema,
  "run.transpiled": runTranspiledParamsSchema,
  "snippets.list": emptyParamsSchema,
  "snippets.save": snippetsSaveParamsSchema,
  "theme.import": emptyParamsSchema,
  "theme.importPick": themeImportPickParamsSchema,
};

/** The `MainRequests` method names at runtime, derived from the exhaustive table above so they cannot drift. */
export const MAIN_REQUEST_NAMES = Object.keys(MAIN_REQUEST_PARAMS_SCHEMAS) as (keyof MainRequests)[];

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
  /**
   * OU-13: open a URL the user activated in an output row, through Main's ONE external-link path (`openExternal`
   * in index.ts, which E2E runs record to `e2e-external.txt` instead of launching a browser). A message rather
   * than a request because nothing is returned and nothing waits on it -- exactly like `app.command`'s Help links.
   */
  "link.open": { url: string };
  /** Spec §13.1 Options menu: opens the file dialog, parses the chosen file, and answers with `snippets.imported`. */
  "snippets.importDialog": Record<string, never>;
  /** Spec §13.1 Options menu: saveDialog with the default name `jslab-snippets.json`; answers `snippets.exported`. */
  "snippets.exportDialog": { snippets: Snippet[] };
  "ui.stateFlushed": Record<string, never>;
  /**
   * M4 §5.12 / T9e: the tab's page reached `dom-ready` -- it is safe to inject script into it now. `generation`
   * is the counter Main minted for the entry this event's element belongs to (see `webRunner.ensure` below); Main
   * drops the event rather than acting on it when that no longer matches the tab's current entry, which is what
   * keeps a late `dom-ready` from a destroyed-and-replaced webview from waking the wrong one.
   */
  "webRunner.ready": WebRunnerTabParams;
  /**
   * M4 §5.12 / T9e: the tab's webview died or was torn down by something other than Main's own `webRunner.destroy`.
   * Carries the same `generation` correlation as `webRunner.ready`, for the same reason: a crash reported by an
   * element Main has already replaced must not tear down the replacement.
   */
  "webRunner.exit": WebRunnerTabParams;
  /**
   * M4 §5.12: one page → host envelope, relayed from the element's `host-message` event. `raw` is `unknown` on the
   * wire -- it is whatever the page handed the element -- and becomes a routable object only once
   * `webRunnerMessageParamsSchema` has validated it on Main's side.
   */
  "webRunner.message": { tabId: string; raw: unknown };
  /**
   * M5d Task 10: the ids the main window's `CommandRegistry` holds, published on every registry build. The registry
   * lives in the main window's React tree and the keybindings editor lives in the *Settings* window (Finding S1), so
   * this message is how the catalogue served to Settings can say which of its rows the running window really has.
   */
  "commands.published": { ids: string[] };
  /**
   * Spec §14.3: "the UI sends `ai.send`". A message and not a request, because the answer is a STREAM -- the
   * reply arrives as many `ai.chunk`s and one terminator, which no single request/response pair can express.
   */
  "ai.send": AiSendParams;
  /** Spec §14.1's Stop button. Aborts the real HTTP request, so the model stops being billed/computed. */
  "ai.stop": { requestId: string };
  /**
   * Spec §14.3: write the conversation to `ai/conversation.json`. A message, not a request: nothing waits on
   * the write and nothing is returned, exactly like `buffer.changed`, and Main debounces it the same way.
   */
  "ai.conversationSave": ConversationSaveParams;
};

/** Messages received by the UI, sent by Main. */
export type ViewMessages = {
  "run.events": { tabId: string; runId: string; events: RunEvent[] };
  "run.state": { tabId: string; runId: string; state: RunState; activeHandles?: number };
  /**
   * Task 15 (spec §5.12, EX-35): pushed whenever a tab's audio-active state flips -- true while any AudioContext
   * the web runner tracks is running or any media element is playing, false the instant neither is true anymore.
   * Event-driven from the runner's own handle tracking (`packages/runner-web/src/handles.ts`), never polled.
   */
  "run.audio": { tabId: string; active: boolean };
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
  /**
   * Spec §9.3: the whole set of imported themes after one was added, never a delta -- `registerUserThemes` replaces
   * the registry wholesale, and the four surfaces of Finding T1 read it on their next lookup.
   */
  "theme.changed": { themes: ThemeDefinition[] };
  /**
   * Finding K1: the whole override set after a save, never a delta -- the UI re-resolves it against
   * `DEFAULT_KEYBINDINGS`, so the key dispatcher, the palette's keycaps and the chrome's keycaps all follow a
   * saved keybindings.json without a relaunch.
   */
  "keybindings.changed": { rules: KeybindingRule[] };
  "npm.op": NpmOperation;
  "npm.log": { opId: string; text: string };
  "npm.changed": NpmListResult;
  "wd.changed": { tabId: string; tab: TabState };
  "snippets.imported": SnippetsImported;
  "snippets.exported": SnippetsExported;
  /**
   * Spec §16.3: a tab Main changed on its own, so the UI's store can follow. `jslab --title` on an ALREADY-OPEN file
   * is the first sender -- `file.opened` announces only tabs that were just created, and the UI's `openTab` ignores
   * an id it already holds, so without this the tab bar kept the old title and the UI's own `tab.patch` pushed that
   * stale title back over the rename. Same shape and same UI handler (`applyTabUpdate`) as `wd.changed`.
   */
  "tab.updated": { tabId: string; tab: TabState };
  "app.flushState": Record<string, never>;
  /**
   * M4 §5.12: make sure this tab has a live `<electrobun-webview>`, creating one if the tab's own Web View toggle
   * has never been switched on. Sent by `WebviewSource.ensure()` before every run, which is what lets a run on an
   * untouched `browser` tab work at all -- Task 9's lazy creation otherwise leaves it with no webview to drive.
   *
   * T9e: `generation` is the monotonic-per-tab counter Main mints the moment it creates this entry. The UI records
   * it as the tab's current generation and stamps every `webRunner.ready` / `.exit` it forwards for this tab with
   * it, until a later `webRunner.ensure` replaces it -- see `apps/ui/src/output/webview-host.ts`.
   */
  "webRunner.ensure": { tabId: string; generation: number };
  /** M4 §5.12: run `js` inside the tab's page (the element's own `executeJavascript`). */
  "webRunner.execute": { tabId: string; js: string };
  /** M4 §5.12: reload the tab's page, for the fresh realm/DOM every run starts from. */
  "webRunner.reload": { tabId: string };
  /**
   * M4 §5.12: tear the tab's webview down for good (Kill, tab dispose, a timed-out reset). T9e: carries the entry's
   * own `generation`, paired with `webRunner.ensure` above, so Main's side of the wire is symmetric even though the
   * UI does not need to gate on it -- Main only ever destroys an entry after removing it from its own map, so a
   * `webRunner.ensure` for a replacement is never sent ahead of the `webRunner.destroy` for what it replaces.
   */
  "webRunner.destroy": { tabId: string; generation: number };
  /** Spec §14.3: one piece of the assistant's reply. `text` is appended verbatim, in arrival order. */
  "ai.chunk": { requestId: string; text: string };
  /**
   * The stream ended. `stopped` is true when it ended because the user pressed Stop, so the panel can mark the
   * reply as interrupted rather than complete -- a distinction `ai.done` alone cannot carry.
   */
  "ai.done": { requestId: string; stopped: boolean };
  "ai.error": AiError;
};
