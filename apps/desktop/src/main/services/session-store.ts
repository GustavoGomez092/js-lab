import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  bufferFileName,
  defaultSession,
  normalizeSession,
  parseSession,
  type Session,
  type SessionParseResult,
  type TabState,
  tabStateSchema,
  type WindowState,
  windowStateSchema,
} from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";
import { createDebouncedWriter, type DebouncedWriter, loadJson, type Recovery } from "../persistence/json-store";

export type TabPatch = Partial<Pick<TabState, "title" | "language">> & { layout?: Partial<TabState["layout"]> };

/** A repaired tab's old buffer is moved only when its old id can't escape the buffers folder. */
const isPlainFileName = (name: string) => /^[^/\\\0]+$/.test(name) && name !== "." && name !== "..";

/** Owns session.json and the per-tab buffer files (spec §10.1). */
export class SessionStore {
  #session: Session;
  readonly #sessionWriter: DebouncedWriter;
  readonly #bufferWriters = new Map<string, DebouncedWriter>();
  // Tabs whose buffer file exists but couldn't be read: never write over it, or an edit would replace real code.
  readonly #unreadableBuffers = new Set<string>();
  // Repaired tab ids (R-M1-18) whose old buffer failed to move for a reason other than "nothing to move" (ENOENT):
  // the old file is left in place, and readBuffers surfaces this the same way as any other unreadable buffer.
  readonly #repairErrors = new Map<string, unknown>();

  private constructor(
    private readonly dataDir: string,
    session: Session,
    readonly recovered: Recovery,
    delayMs: number,
    /** The version stored in a session.json written by a newer JSLab, or null. While set, session.json is never written (I4). */
    readonly newerVersion: number | null = null,
    /** Keys of tab entries that failed validation and were skipped; their buffer files are left untouched. */
    readonly droppedTabs: readonly string[] = [],
  ) {
    this.#session = session;
    this.#sessionWriter = createDebouncedWriter(
      (data) =>
        this.newerVersion === null
          ? writeFileAtomic(join(dataDir, "session.json"), data, { backup: true })
          : Promise.resolve(),
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
    // loadJson retries the same parser on session.json.bak, so the report describes the file that was actually used.
    const parsed: { report: SessionParseResult | null } = { report: null };
    const parser = {
      parse(input: unknown): Session {
        parsed.report = parseSession(input);
        return parsed.report.session;
      },
    };
    const { value, recovered } = await loadJson(join(dataDir, "session.json"), parser, () => defaultSession(newTab));
    const session = normalizeSession(value, newTab);
    const report = parsed.report;
    const newerVersion = report?.newerThanBuild ? report.fileVersion : null;
    const store = new SessionStore(
      dataDir,
      session,
      recovered,
      options.delayMs ?? 500,
      newerVersion,
      report?.droppedTabs ?? [],
    );
    // R-M1-18: a repaired tab keeps its content when its old id is a plain file name.
    const repairedTabIds = report?.repairedTabIds ?? [];
    for (const [from, to] of repairedTabIds) {
      const tab = session.tabs[to];
      if (!tab || !isPlainFileName(from)) continue;
      const oldPath = join(dataDir, "buffers", bufferFileName({ id: from, language: tab.language }));
      try {
        await rename(oldPath, join(dataDir, "buffers", bufferFileName(tab)));
      } catch (error) {
        // No old buffer to move is fine (the tab had no unsaved content yet); anything else means the repaired
        // tab's content is stuck at the old path and must not look like an empty buffer.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") store.#repairErrors.set(to, error);
      }
    }
    // No backup after a recovery: `session.json` still holds the corrupt/stale primary, and backing it up would clobber
    // a good `.bak` that recovery just read from (ruling I1). A repair of a valid file keeps its backup. A newer file
    // is never rewritten (I4).
    if ((recovered !== "none" || repairedTabIds.length > 0) && newerVersion === null) {
      await writeFileAtomic(join(dataDir, "session.json"), `${JSON.stringify(session, null, 2)}\n`, {
        backup: recovered === "none",
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
      if (this.#repairErrors.has(id)) this.#failUnreadable(id, this.#repairErrors.get(id));
      try {
        buffers[id] = await readFile(this.#bufferPath(tab), "utf8");
        this.#unreadableBuffers.delete(id);
      } catch (error) {
        // No file yet is an empty buffer; anything else (EACCES, EISDIR, EIO) must never look like empty content.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          buffers[id] = "";
          continue;
        }
        this.#failUnreadable(id, error);
      }
    }
    return buffers;
  }

  /** Marks a tab's buffer unreadable so `setBuffer` never overwrites it, and reports why (shared by both callers). */
  #failUnreadable(id: string, error: unknown): never {
    this.#unreadableBuffers.add(id);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't read the buffer for tab ${id}: ${reason}`, { cause: error });
  }

  setBuffer(tabId: string, content: string): void {
    if (!this.#session.tabs[tabId] || this.#unreadableBuffers.has(tabId)) return;
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
