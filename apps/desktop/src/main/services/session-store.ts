import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  bufferFileName,
  defaultSession,
  normalizeSession,
  type Session,
  sessionSchema,
  type TabState,
  tabStateSchema,
  type WindowState,
  windowStateSchema,
} from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";
import { createDebouncedWriter, type DebouncedWriter, loadJson, type Recovery } from "../persistence/json-store";

export type TabPatch = Partial<Pick<TabState, "title" | "language">> & { layout?: Partial<TabState["layout"]> };

/** Owns session.json and the per-tab buffer files (spec §10.1). */
export class SessionStore {
  #session: Session;
  readonly #sessionWriter: DebouncedWriter;
  readonly #bufferWriters = new Map<string, DebouncedWriter>();

  private constructor(
    private readonly dataDir: string,
    session: Session,
    readonly recovered: Recovery,
    delayMs: number,
  ) {
    this.#session = session;
    this.#sessionWriter = createDebouncedWriter(
      (data) => writeFileAtomic(join(dataDir, "session.json"), data, { backup: true }),
      delayMs,
    );
    this.delayMs = delayMs;
  }

  private readonly delayMs: number;

  static async open(
    dataDir: string,
    options: { newTab?: () => TabState; delayMs?: number } = {},
  ): Promise<SessionStore> {
    const newTab = options.newTab ?? (() => tabStateSchema.parse({ id: crypto.randomUUID() }));
    const { value, recovered } = await loadJson(join(dataDir, "session.json"), sessionSchema, () =>
      defaultSession(newTab),
    );
    const session = normalizeSession(value, newTab);
    const store = new SessionStore(dataDir, session, recovered, options.delayMs ?? 500);
    if (recovered !== "none") {
      await writeFileAtomic(join(dataDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, {
        backup: true,
      });
    }
    return store;
  }

  get session(): Session {
    return this.#session;
  }

  async readBuffers(): Promise<Record<string, string>> {
    const buffers: Record<string, string> = {};
    for (const id of this.#session.tabOrder) {
      const tab = this.#session.tabs[id];
      if (!tab) continue;
      buffers[id] = await readFile(this.#bufferPath(tab), "utf8").catch(() => "");
    }
    return buffers;
  }

  setBuffer(tabId: string, content: string): void {
    if (!this.#session.tabs[tabId]) return;
    let writer = this.#bufferWriters.get(tabId);
    if (!writer) {
      writer = createDebouncedWriter(async (data) => {
        const tab = this.#session.tabs[tabId];
        if (tab) await writeFileAtomic(this.#bufferPath(tab), data);
      }, this.delayMs);
      this.#bufferWriters.set(tabId, writer);
    }
    writer.schedule(content);
  }

  async patchTab(tabId: string, patch: TabPatch): Promise<void> {
    const tab = this.#session.tabs[tabId];
    if (!tab) return;
    const next = tabStateSchema.parse({ ...tab, ...patch, layout: { ...tab.layout, ...patch.layout } });
    if (next.language !== tab.language) {
      await this.#bufferWriters.get(tabId)?.flush();
      await rename(this.#bufferPath(tab), this.#bufferPath(next)).catch(() => {});
    }
    this.#session = { ...this.#session, tabs: { ...this.#session.tabs, [tabId]: next } };
    this.#scheduleSave();
  }

  setWindow(frame: WindowState): void {
    this.#session = { ...this.#session, window: windowStateSchema.parse(frame) };
    this.#scheduleSave();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#bufferWriters.values()].map((writer) => writer.flush()));
    this.#scheduleSave();
    await this.#sessionWriter.flush();
  }

  #bufferPath(tab: Pick<TabState, "id" | "language">): string {
    return join(this.dataDir, "buffers", bufferFileName(tab));
  }

  #scheduleSave(): void {
    this.#sessionWriter.schedule(`${JSON.stringify(this.#session, null, 2)}\n`);
  }
}
