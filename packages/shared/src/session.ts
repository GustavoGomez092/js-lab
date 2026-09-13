import { z } from "zod";
import { LANGUAGES, type Language, RUNTIMES } from "./settings";

export const tabStateSchema = z.object({
  id: z.string().min(1),
  title: z.string().catch("Untitled"),
  titleIsCustom: z.boolean().catch(false),
  language: z.enum(LANGUAGES).catch("typescript"),
  runtime: z.enum(RUNTIMES).catch("bun"),
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

export const sessionSchema = z.object({
  version: z.literal(1).catch(1),
  window: windowStateSchema,
  tabOrder: z.array(z.string()).catch([]),
  activeTabId: z.string().catch(""),
  tabs: z.record(z.string(), tabStateSchema).catch({}),
});

export type TabState = z.infer<typeof tabStateSchema>;
export type WindowState = z.infer<typeof windowStateSchema>;
export type Session = z.infer<typeof sessionSchema>;

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
