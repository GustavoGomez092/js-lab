import { z } from "zod";
import { DEFAULT_LANGUAGE, DEFAULT_RUNTIME, LANGUAGES, type Language, RUNTIMES } from "./settings";

export const tabStateSchema = z.object({
  id: z.string().min(1),
  title: z.string().catch("Untitled"),
  titleIsCustom: z.boolean().catch(false),
  language: z.enum(LANGUAGES).catch(DEFAULT_LANGUAGE),
  runtime: z.enum(RUNTIMES).catch(DEFAULT_RUNTIME),
  layout: z
    .object({
      orientation: z.enum(["horizontal", "vertical"]).catch("horizontal"),
      editorSize: z.number().min(10).max(90).catch(55),
    })
    .catch(() => ({ orientation: "horizontal" as const, editorSize: 55 })),
});

export const windowStateSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().min(400),
    height: z.number().min(300),
  })
  .nullable()
  .catch(null);

/** Session file format version. M1 wrote 1; M2 writes 2 (see SESSION_MIGRATIONS). */
export const SESSION_VERSION = 2;

/** Keeps each record entry that parses; one bad entry never discards its siblings (final review I4). */
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

// A loose object: keys written by a newer JSLab survive a read (final review I4).
export const sessionSchema = z.looseObject({
  version: z.number().int().min(1).catch(SESSION_VERSION),
  window: windowStateSchema,
  tabOrder: z.array(z.string()).catch([]),
  activeTabId: z.string().catch(""),
  tabs: tolerantRecord(tabStateSchema),
});

export type TabState = z.infer<typeof tabStateSchema>;
export type WindowState = z.infer<typeof windowStateSchema>;
export type Session = z.infer<typeof sessionSchema>;

type RawSession = Record<string, unknown>;

function isObject(value: unknown): value is RawSession {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `SESSION_MIGRATIONS[n]` upgrades a version-n session file to version n + 1. Unknown keys always pass through. */
export const SESSION_MIGRATIONS: Record<number, (raw: RawSession) => RawSession> = {
  // v1 (M1) → v2 (M2): M2's new tab and session fields all have schema defaults, so only the version changes.
  1: (raw) => ({ ...raw, version: 2 }),
};

export interface SessionParseResult {
  session: Session;
  /** The version stored in the file; a file without one is version 1. */
  fileVersion: number;
  /** True when a newer JSLab wrote the file. Callers must never write it back (final review I4). */
  newerThanBuild: boolean;
  /** Keys of tab entries that failed validation and were skipped. Their buffer files are left untouched. */
  droppedTabs: string[];
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
  const session = sessionSchema.parse(raw);
  const rawTabs = isObject(raw.tabs) ? Object.keys(raw.tabs) : [];
  return {
    session,
    fileVersion,
    newerThanBuild: fileVersion > SESSION_VERSION,
    droppedTabs: rawTabs.filter((key) => !Object.hasOwn(session.tabs, key)),
  };
}

/** Parser for `loadJson`: throws on a non-object, so recovery falls back to session.json.bak, then defaults. */
export const sessionParser = {
  parse(input: unknown): Session {
    return parseSession(input).session;
  },
};

const EXTENSIONS: Record<Language, string> = { typescript: "ts", tsx: "tsx", javascript: "js", jsx: "jsx" };

export function bufferFileName(tab: Pick<TabState, "id" | "language">): string {
  return `${tab.id}.${EXTENSIONS[tab.language]}`;
}

export function createTab(overrides: Partial<TabState> = {}): TabState {
  return tabStateSchema.parse({ id: crypto.randomUUID(), title: "Untitled", ...overrides });
}

/** Repairs cross-field invariants: every ordered id exists, every tab is ordered, and there is an active tab. */
export function normalizeSession(session: Session, newTab: () => TabState = () => createTab()): Session {
  const tabs = { ...session.tabs };
  const tabOrder = session.tabOrder.filter((id, index, all) => id in tabs && all.indexOf(id) === index);
  for (const id of Object.keys(tabs)) if (!tabOrder.includes(id)) tabOrder.push(id);
  if (tabOrder.length === 0) {
    const tab = newTab();
    tabs[tab.id] = tab;
    tabOrder.push(tab.id);
  }
  const activeTabId = tabOrder.includes(session.activeTabId) ? session.activeTabId : (tabOrder[0] as string);
  return { ...session, tabs, tabOrder, activeTabId };
}

export function defaultSession(newTab: () => TabState = () => createTab()): Session {
  return normalizeSession(sessionSchema.parse({}), newTab);
}
