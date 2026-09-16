import { z } from "zod";
import { DEFAULT_LANGUAGE, DEFAULT_RUNTIME, LANGUAGES, type Language, RUNTIMES } from "./settings";

export const MAX_CLOSED_TABS = 20;
/**
 * Tab ids name buffer files and must pass the rpc-schema `tabId` validator (M1 fix wave: letters, digits, `_`, `-`,
 * at most 100 characters). Ids created by JSLab are UUIDs.
 */
export const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const LAYOUT_ORIENTATIONS = ["horizontal", "vertical"] as const;
/** M4 Task 8, spec §7.1 / Appendix C: the Web View tile's arrangement relative to the Console tile. */
export const TILE_ARRANGEMENTS = ["stacked", "side-by-side"] as const;
export const TILE_KINDS = ["console", "webview"] as const;
export type TileKind = (typeof TILE_KINDS)[number];
/** Session file format version. M1 wrote 1; M2 wrote 2; M4 Task 8 writes 3 (see SESSION_MIGRATIONS). */
export const SESSION_VERSION = 3;

const defaultTileOrder = (): TileKind[] => ["console", "webview"];

const defaultTiles = () => ({
  arrangement: "stacked" as const,
  order: defaultTileOrder(),
  webviewVisible: false,
  consoleSize: 55,
});

const defaultLayout = () => ({
  orientation: "horizontal" as const,
  editorSize: 55,
  outputVisible: true,
  tiles: defaultTiles(),
});

/**
 * Ruling R-M4-T8-VERSION-1: every field defaults independently via its own `.catch()`, rather than the whole
 * object being gated on SESSION_VERSION, so a later additive field (Task 15's `muted`) needs no further bump.
 */
export const tabTilesSchema = z
  .object({
    arrangement: z.enum(TILE_ARRANGEMENTS).catch("stacked"),
    // A valid order names both tiles exactly once; a missing one, a duplicate, or a third value falls back to the
    // default order on its own, without discarding arrangement/webviewVisible/consoleSize alongside it.
    order: z
      .array(z.enum(TILE_KINDS))
      .refine((order) => order.length === 2 && new Set(order).size === 2)
      .catch(() => defaultTileOrder()),
    webviewVisible: z.boolean().catch(false),
    consoleSize: z.number().min(10).max(90).catch(55),
  })
  .catch(defaultTiles);

export const tabLayoutSchema = z
  .object({
    orientation: z.enum(LAYOUT_ORIENTATIONS).catch("horizontal"),
    editorSize: z.number().min(10).max(90).catch(55),
    outputVisible: z.boolean().catch(true),
    tiles: tabTilesSchema,
  })
  .catch(defaultLayout);

const optionalPath = z.string().min(1).max(4096).nullable().catch(null);

export const tabStateSchema = z.object({
  id: z.string().min(1),
  title: z.string().catch("Untitled"),
  titleIsCustom: z.boolean().catch(false),
  // As built by the M1 fix wave (final review M13): the settings defaults, so new tabs and repaired fields agree.
  language: z.enum(LANGUAGES).catch(DEFAULT_LANGUAGE),
  runtime: z.enum(RUNTIMES).catch(DEFAULT_RUNTIME),
  filePath: optionalPath,
  lastSavedHash: z.string().max(64).nullable().catch(null),
  workingDirectory: optionalPath,
  gistId: z.string().max(100).nullable().catch(null),
  layout: tabLayoutSchema,
  // Monaco ICodeEditorViewState, stored as opaque JSON (spec §10.1). `.optional()` is required so a missing key
  // doesn't fail zod's object() required-field check before the transform ever runs (zod 4.6.4).
  viewState: z
    .unknown()
    .optional()
    .transform((value) => value ?? null),
});

export const closedTabSchema = z.object({
  tab: tabStateSchema,
  closedAt: z.number().catch(0),
});

export const windowStateSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    // FA-m6: no minimum window size is set natively, so a smaller frame is clamped rather than forgotten.
    width: z.number().transform((width) => Math.max(400, width)),
    height: z.number().transform((height) => Math.max(300, height)),
    // Spec §10.1 / Appendix C: the display the frame was on (Electrobun `Display.id`, stored as a string) and whether
    // the window was full screen. Optional in the type, so `BrowserWindow#getFrame()` results still fit `setWindow`.
    displayId: z.string().min(1).max(100).optional().catch(undefined),
    fullscreen: z.boolean().optional().catch(undefined),
  })
  .nullable()
  .catch(null);

/** Keeps each record entry that parses; one bad entry never discards its siblings. */
function tolerantRecord<T>(schema: z.ZodType<T>) {
  return z
    .record(z.string(), z.unknown())
    .catch({})
    .transform((entries) => {
      const out: Record<string, T> = {};
      for (const [key, value] of Object.entries(entries)) {
        const parsed = schema.safeParse(value);
        if (parsed.success) out[key] = parsed.data;
      }
      return out;
    });
}

function tolerantArray<T>(schema: z.ZodType<T>, max: number) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items
        .flatMap((item) => {
          const parsed = schema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
        .slice(0, max),
    );
}

// A loose object: keys written by a newer JSLab survive a read (final review I4).
export const sessionSchema = z.looseObject({
  version: z.number().int().min(1).catch(SESSION_VERSION),
  window: windowStateSchema,
  settingsWindow: windowStateSchema,
  tabOrder: z.array(z.string()).catch([]),
  activeTabId: z.string().catch(""),
  tabs: tolerantRecord(tabStateSchema),
  closedStack: tolerantArray(closedTabSchema, MAX_CLOSED_TABS),
  lastDirectory: z.string().min(1).max(4096).nullable().catch(null),
});

export type TabTiles = z.infer<typeof tabTilesSchema>;
export type TabLayout = z.infer<typeof tabLayoutSchema>;
export type TabState = z.infer<typeof tabStateSchema>;
export type ClosedTab = z.infer<typeof closedTabSchema>;
export type WindowState = z.infer<typeof windowStateSchema>;
export type Session = z.infer<typeof sessionSchema>;

type RawSession = Record<string, unknown>;

function isObject(value: unknown): value is RawSession {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `SESSION_MIGRATIONS[n]` upgrades a version-n session file to version n + 1. Unknown keys always pass through. */
export const SESSION_MIGRATIONS: Record<number, (raw: RawSession) => RawSession> = {
  // v1 (M1) → v2 (M2): the new tab fields, closedStack, settingsWindow and lastDirectory all have schema defaults.
  1: (raw) => ({ ...raw, version: 2 }),
  // v2 (M2) → v3 (M4 Task 8): layout.tiles is additive with its own `.catch()` defaults (R-M4-T8-VERSION-1) --
  // a no-op bump, exactly like v1 → v2 was. Keeps `tiles` and Task 15's `muted` sharing this one bump.
  2: (raw) => ({ ...raw, version: 3 }),
};

export interface SessionParseResult {
  session: Session;
  /** The version stored in the file; a file without one is version 1. */
  fileVersion: number;
  /** True when a newer JSLab wrote the file. Callers must never write it back (final review I4). */
  newerThanBuild: boolean;
  /** Keys of tab entries that failed validation and were skipped. Their buffer files are left untouched. */
  droppedTabs: string[];
  /** `[old id, new id]` for tabs whose hand-edited ids failed TAB_ID_PATTERN and were replaced (R-M1-18). */
  repairedTabIds: [string, string][];
}

/**
 * Gives every tab whose id fails TAB_ID_PATTERN (a hand-edited session.json) a fresh id, so Main's validated RPC
 * accepts its edits instead of dropping them silently (R-M1-18). Only tabs stored under their own id are repaired;
 * normalizeSession still drops the others. Closed-stack entries with such ids are dropped.
 */
export function repairTabIds(session: Session): { session: Session; repairedTabIds: [string, string][] } {
  const renames = new Map<string, string>();
  for (const [key, tab] of Object.entries(session.tabs)) {
    if (tab.id === key && !TAB_ID_PATTERN.test(key)) renames.set(key, crypto.randomUUID());
  }
  // FA-m1: closed-stack ids name files under buffers/closed/, so an unsafe one is dropped whether or not any open tab
  // needs a repair.
  const closedStack = session.closedStack.filter((entry) => TAB_ID_PATTERN.test(entry.tab.id));
  if (renames.size === 0) {
    const safe = closedStack.length === session.closedStack.length ? session : { ...session, closedStack };
    return { session: safe, repairedTabIds: [] };
  }
  const rename = (id: string) => renames.get(id) ?? id;
  const tabs: Record<string, TabState> = {};
  for (const [key, tab] of Object.entries(session.tabs)) {
    const id = rename(key);
    tabs[id] = tab.id === key ? { ...tab, id } : tab;
  }
  return {
    session: {
      ...session,
      tabs,
      tabOrder: session.tabOrder.map(rename),
      activeTabId: rename(session.activeTabId),
      closedStack,
    },
    repairedTabIds: [...renames],
  };
}

export function parseSession(input: unknown): SessionParseResult {
  if (!isObject(input)) throw new Error("session.json must contain an object");
  const stored = input.version;
  const fileVersion = typeof stored === "number" && Number.isInteger(stored) && stored >= 1 ? stored : 1;
  let raw: RawSession = input;
  for (let version = fileVersion; version < SESSION_VERSION; version++) {
    const migrate = SESSION_MIGRATIONS[version];
    if (!migrate) throw new Error(`No session migration from version ${version}`);
    raw = migrate(raw);
  }
  const parsed = sessionSchema.parse(raw);
  const rawTabs = isObject(raw.tabs) ? Object.keys(raw.tabs) : [];
  const { session, repairedTabIds } = repairTabIds(parsed);
  return {
    session,
    fileVersion,
    newerThanBuild: fileVersion > SESSION_VERSION,
    droppedTabs: rawTabs.filter((key) => !Object.hasOwn(parsed.tabs, key)),
    repairedTabIds,
  };
}

/** Parser for `loadJson`: throws on a non-object, so recovery falls back to session.json.bak, then defaults. */
export const sessionParser = {
  parse(input: unknown): Session {
    return parseSession(input).session;
  },
};

/** The one literal file extension table; tabs.ts's `LANGUAGE_EXTENSIONS` re-exports this instead of duplicating it. */
export const EXTENSIONS: Record<Language, string> = { typescript: "ts", tsx: "tsx", javascript: "js", jsx: "jsx" };

export function bufferFileName(tab: Pick<TabState, "id" | "language">): string {
  return `${tab.id}.${EXTENSIONS[tab.language]}`;
}

/** Content of a closed tab lives in `buffers/closed/` until it is reopened or evicted (spec §10.1). */
export function closedBufferFileName(tab: Pick<TabState, "id" | "language">): string {
  return `closed/${bufferFileName(tab)}`;
}

export function createTab(overrides: Partial<TabState> = {}): TabState {
  return tabStateSchema.parse({ id: crypto.randomUUID(), title: "Untitled", ...overrides });
}

/**
 * Repairs cross-field invariants:
 * - every tab is stored under its own id
 * - every ordered id exists, and every tab is ordered
 * - there is an active tab
 * - reopenable entries are not open
 */
export function normalizeSession(session: Session, newTab: () => TabState = () => createTab()): Session {
  const tabs: Record<string, TabState> = {};
  for (const [key, tab] of Object.entries(session.tabs)) if (tab.id === key) tabs[key] = tab;
  const tabOrder = session.tabOrder.filter((id, index, all) => id in tabs && all.indexOf(id) === index);
  for (const id of Object.keys(tabs)) if (!tabOrder.includes(id)) tabOrder.push(id);
  if (tabOrder.length === 0) {
    const tab = newTab();
    tabs[tab.id] = tab;
    tabOrder.push(tab.id);
  }
  const activeTabId = tabOrder.includes(session.activeTabId) ? session.activeTabId : (tabOrder[0] as string);
  const closedStack = session.closedStack.filter((entry) => !(entry.tab.id in tabs));
  return { ...session, tabs, tabOrder, activeTabId, closedStack };
}

export function defaultSession(newTab: () => TabState = () => createTab()): Session {
  return normalizeSession(sessionSchema.parse({}), newTab);
}
