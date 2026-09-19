import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  bufferFileName,
  closedBufferFileName,
  createTab,
  defaultSession,
  type Language,
  normalizeSession,
  parseSession,
  pushClosed,
  type Runtime,
  type Session,
  type SessionParseResult,
  type TabLayout,
  type TabState,
  type TabTiles,
  tabAfterClose,
  tabStateSchema,
  type WindowState,
  windowStateSchema,
} from "@jslab/shared";
import { readRegularFileText } from "../fs/bounded-read";
import { writeFileAtomic } from "../persistence/atomic-write";
import {
  createDebouncedWriter,
  type DebouncedWriter,
  loadJson,
  type PrimaryFile,
  type Recovery,
} from "../persistence/json-store";

export type TabPatch = Partial<
  Pick<TabState, "title" | "titleIsCustom" | "language" | "runtime" | "filePath" | "lastSavedHash">
> & {
  // Fix round 1 (F5): `tiles` is itself partial -- a caller may patch just `webviewVisible`, say -- so it is
  // merged field-by-field against the tab's existing tiles below, not spread wholesale (which would silently
  // reset every omitted tiles field to its schema default).
  layout?: Partial<Omit<TabLayout, "tiles">> & { tiles?: Partial<TabTiles> };
};

export interface CreateTabOptions {
  language?: Language;
  runtime?: Runtime;
  title?: string;
  titleIsCustom?: boolean;
  filePath?: string | null;
  lastSavedHash?: string | null;
  content?: string;
  /** Spec §12.2, reachable from the CLI's `--cwd` (spec §16.2). */
  workingDirectory?: string | null;
  /** Defaults to true. */
  activate?: boolean;
}

export interface SessionStoreOptions {
  newTab?: () => TabState;
  delayMs?: number;
  /** Defaults for new tabs, read from settings at creation time (spec §8: defaultLanguage, defaultRuntime, view.layout). */
  tabDefaults?: () => Partial<TabState>;
  /** Timer-path write failures (as-built createDebouncedWriter onError). */
  onWriteError?: (error: unknown) => void;
  /**
   * Spec §7.5: the welcome tab's content, applied only on a genuinely first launch -- no session.json and no
   * backup (R-M5a-5). A corrupt or recovered file is never a first run, so a user's tabs are never replaced.
   */
  firstRun?: { title: string; content: string; language: Language };
}

/** A repaired tab's old buffer is moved only when its old id can't escape the buffers folder (Task 4 Step 11). */
const isPlainFileName = (name: string) => /^[^/\\\0]+$/.test(name) && name !== "." && name !== "..";

/** Owns session.json and the per-tab buffer files (spec §10.1). */
export class SessionStore {
  #session: Session;
  readonly #sessionWriter: DebouncedWriter;
  readonly #bufferWriters = new Map<string, DebouncedWriter>();
  readonly #listeners = new Set<(session: Session) => void>();
  // As built by the M1 fix wave: tabs whose buffer file exists but couldn't be read are never written over.
  readonly #unreadableBuffers = new Set<string>();
  /** The first-run content this launch was given, so `setBuffer` can tell an edit from a resend of the same bytes. */
  #firstRunContent: string | null = null;
  // Repaired tab ids (R-M1-18) whose old buffer failed to move for a reason other than "nothing to move" (ENOENT):
  // the old file is left in place, and readBuffers surfaces this the same way as any other unreadable buffer
  // (R-M2-T4-1, commit ed16be9).
  readonly #repairErrors = new Map<string, unknown>();

  private constructor(
    private readonly dataDir: string,
    session: Session,
    readonly recovered: Recovery,
    private readonly delayMs: number,
    private readonly tabDefaults: () => Partial<TabState>,
    private readonly onWriteError: (error: unknown) => void = (error) =>
      console.error("[jslab] session write failed", error),
    /** Task 4 (I4): the version of a session.json written by a newer JSLab; while set, session.json is never written. */
    readonly newerVersion: number | null = null,
    /** Task 4 (I4): keys of tab entries skipped because they failed validation. */
    readonly droppedTabs: readonly string[] = [],
    /** FA-m4: what was wrong with session.json at load, and the corrupt copy saved this launch. */
    readonly primary: PrimaryFile = "ok",
    readonly corruptCopy: string | null = null,
  ) {
    this.#session = session;
    this.#sessionWriter = createDebouncedWriter(
      (data) =>
        this.newerVersion === null
          ? writeFileAtomic(join(dataDir, "session.json"), data, { backup: true })
          : Promise.resolve(),
      delayMs,
      this.onWriteError,
    );
  }

  static async open(dataDir: string, options: SessionStoreOptions = {}): Promise<SessionStore> {
    const tabDefaults = options.tabDefaults ?? (() => ({}));
    const newTab = options.newTab ?? (() => createTab(tabDefaults()));
    // Task 4 (I4): loadJson retries the parser on session.json.bak, so the report describes the file actually used.
    const parsed: { report: SessionParseResult | null } = { report: null };
    const parser = {
      parse(input: unknown): Session {
        parsed.report = parseSession(input);
        return parsed.report.session;
      },
    };
    // The byte cap is waived here, and only the byte cap: session.json grows with the tab count and each tab's
    // stored view state, so any number chosen would eventually discard a session the user really has. The reader
    // still opens O_NONBLOCK and fstats the handle it will read, so a FIFO at session.json is refused instead of
    // blocking Main forever -- reported as corrupt, recovered from the .bak or defaults, and then renamed over by
    // the rewrite below, so the profile heals itself.
    const { value, recovered, primary, corruptCopy } = await loadJson(
      join(dataDir, "session.json"),
      parser,
      () => defaultSession(newTab),
      Number.POSITIVE_INFINITY,
    );
    const report = parsed.report;
    const newerVersion = report?.newerThanBuild ? report.fileVersion : null;
    const session = normalizeSession(value, newTab);
    const store = new SessionStore(
      dataDir,
      session,
      recovered,
      options.delayMs ?? 500,
      tabDefaults,
      options.onWriteError,
      newerVersion,
      report?.droppedTabs ?? [],
      primary,
      corruptCopy,
    );
    // Set on every launch, not only the first one: a welcome tab the user has not touched is still pristine after a
    // relaunch, and `setBuffer` needs this to recognise the resend of those same bytes (R-M5a-REGRESSION-2).
    store.#firstRunContent = options.firstRun?.content ?? null;
    // R-M5a-5: `loadJson` reports this exact pair only when neither session.json nor session.json.bak could be
    // read. A corrupt primary recovers to "defaults" and a good backup to "backup" -- neither is a first launch,
    // so a returning user's tabs are never replaced by the sample.
    if (primary === "missing" && recovered === "none" && options.firstRun) {
      const [onlyId] = session.tabOrder;
      const tab = onlyId ? session.tabs[onlyId] : undefined;
      // Only ever the single tab `defaultSession` just created for an empty folder.
      if (onlyId && tab && session.tabOrder.length === 1) {
        const welcome: TabState = {
          ...tab,
          title: options.firstRun.title,
          titleIsCustom: true,
          language: options.firstRun.language,
          // R-M5a-REGRESSION-2: nothing of the user's is here yet, so ⌘W should still close the window.
          pristine: true,
        };
        // `store.session` is this same object graph, and nothing has been committed, scheduled or written yet, so
        // amending it here is equivalent to having created the tab this way -- true at this point and nowhere else.
        session.tabs[onlyId] = welcome;
        await writeFileAtomic(join(dataDir, "buffers", bufferFileName(welcome)), options.firstRun.content);
      }
    }
    // Task 4 Step 11 (R-M1-18): a repaired tab keeps its content when its old id is a plain file name.
    const repairedTabIds = report?.repairedTabIds ?? [];
    for (const [from, to] of repairedTabIds) {
      const tab = session.tabs[to];
      if (!tab || !isPlainFileName(from)) continue;
      const oldPath = join(dataDir, "buffers", bufferFileName({ id: from, language: tab.language }));
      try {
        await rename(oldPath, join(dataDir, "buffers", bufferFileName(tab)));
      } catch (error) {
        // No old buffer to move is fine (the tab had no unsaved content yet); anything else means the repaired
        // tab's content is stuck at the old path and must not look like an empty buffer (R-M2-T4-1).
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") store.#repairErrors.set(to, error);
      }
    }
    // As built (M1 T12 ruling): persist a recovered session at once, without a backup, so the good .bak survives.
    // A repair of a valid file keeps its backup. A session.json from a newer JSLab is never rewritten (I4).
    if ((recovered !== "none" || repairedTabIds.length > 0) && newerVersion === null) {
      await writeFileAtomic(join(dataDir, "session.json"), `${JSON.stringify(store.session, null, 2)}\n`, {
        backup: recovered === "none",
      });
    }
    return store;
  }

  get session(): Session {
    return this.#session;
  }

  onChange(listener: (session: Session) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async readBuffers(): Promise<Record<string, string>> {
    const buffers: Record<string, string> = {};
    for (const id of this.#session.tabOrder) buffers[id] = await this.readBuffer(id);
    return buffers;
  }

  async readBuffer(tabId: string): Promise<string> {
    const tab = this.#session.tabs[tabId];
    if (!tab) return "";
    if (this.#repairErrors.has(tabId)) this.#failUnreadable(tabId, this.#repairErrors.get(tabId));
    try {
      const content = await readRegularFileText(this.#bufferPath(tab));
      this.#unreadableBuffers.delete(tabId);
      return content;
    } catch (error) {
      // As built by the M1 fix wave (final review T12): only a missing file is an empty buffer. Any other error
      // (EACCES, EISDIR, EIO) is surfaced, and the tab's buffer is never written, so an edit can't replace real code.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      this.#failUnreadable(tabId, error);
    }
  }

  /** Marks a tab's buffer unreadable so `setBuffer` never overwrites it, and reports why (shared by both callers). */
  #failUnreadable(id: string, error: unknown): never {
    this.#unreadableBuffers.add(id);
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Couldn't read the buffer for tab ${id}: ${reason}`, { cause: error });
  }

  setBuffer(tabId: string, content: string): void {
    const tab = this.#session.tabs[tabId];
    if (!tab || this.#unreadableBuffers.has(tabId)) return;
    // R-M5a-REGRESSION-2: the welcome tab stops being pristine as soon as it no longer holds what JSLab wrote
    // there. Comparing the content, rather than treating any write as an edit, is defensive rather than
    // load-bearing: `createBufferSync` only flushes what `pushContent` pushed from `onDidChangeContent`, so an
    // untouched welcome tab never sends `buffer.changed` at all and no identical-bytes write is known to reach
    // here. The comparison means that if one ever did, it still could not retire the flag behind the user's back.
    if (tab.pristine && content !== this.#firstRunContent)
      this.#commit({ ...this.#session, tabs: { ...this.#session.tabs, [tabId]: { ...tab, pristine: false } } });
    this.#writerFor(tabId).schedule(content);
  }

  /**
   * True while this tab's buffer file exists but couldn't be read, so JSLab does not know the tab's real text.
   *
   * B1: `setBuffer` has always consulted this set, but it guards only the internal buffer file under
   * `<dataDir>/buffers/`. The tab's `filePath` -- the user's own source file -- is written by `file-handlers.ts`
   * through `FileService`, which never saw this. Exposing it lets that path refuse too, so the rule is the same
   * wherever a tab's text gets written: a tab whose content JSLab couldn't read is never written anywhere.
   *
   * Cleared by a later successful `readBuffer` (the file was repaired) and by `closeTab`.
   */
  isBufferUnreadable(tabId: string): boolean {
    return this.#unreadableBuffers.has(tabId);
  }

  async createTab(options: CreateTabOptions = {}): Promise<TabState> {
    const { content = "", activate = true, ...fields } = options;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const tab = createTab({ ...this.tabDefaults(), ...defined });
    await writeFileAtomic(this.#bufferPath(tab), content);
    const order = this.#insertAfterActive(this.#session.tabOrder, tab.id);
    this.#commit({
      ...this.#session,
      tabs: { ...this.#session.tabs, [tab.id]: tab },
      tabOrder: order,
      activeTabId: activate ? tab.id : this.#session.activeTabId,
    });
    return tab;
  }

  async closeTab(tabId: string): Promise<{ closed: boolean; replacement: TabState | null; activeTabId: string }> {
    const tab = this.#session.tabs[tabId];
    if (!tab) return { closed: false, replacement: null, activeTabId: this.#session.activeTabId };

    await this.#bufferWriters.get(tabId)?.flush();
    const closedPath = join(this.dataDir, "buffers", closedBufferFileName(tab));
    await mkdir(dirname(closedPath), { recursive: true });
    try {
      await rename(this.#bufferPath(tab), closedPath);
    } catch (error) {
      // Same rule as readBuffer/reopenClosed: only a missing buffer (never written) becomes an empty closed
      // entry. Anything else (EACCES, EIO, …) must not silently lose the tab's content — the close is aborted,
      // with nothing yet deleted from #bufferWriters/#unreadableBuffers and no session mutation performed, so
      // the tab stays open and fully usable (fix round 1).
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFileAtomic(closedPath, "");
    }
    this.#bufferWriters.delete(tabId);
    this.#unreadableBuffers.delete(tabId);
    // Spec §10.1 keeps a .bak of every buffer write; a closed tab's backup has nothing left to protect.
    await unlink(`${this.#bufferPath(tab)}.bak`).catch(() => {});

    const { stack, evicted } = pushClosed(this.#session.closedStack, { tab, closedAt: Date.now() });
    // FA-m5: a newer JSLab's session.json (never rewritten) may still list an evicted tab, so its buffer stays.
    if (this.newerVersion === null) {
      for (const entry of evicted) {
        await unlink(join(this.dataDir, "buffers", closedBufferFileName(entry.tab))).catch(() => {});
      }
    }

    const nextActive = tabAfterClose(this.#session.tabOrder, tabId, this.#session.activeTabId);
    const { [tabId]: _removed, ...tabs } = this.#session.tabs;
    this.#commit({
      ...this.#session,
      tabs,
      tabOrder: this.#session.tabOrder.filter((id) => id !== tabId),
      activeTabId: nextActive ?? "",
      closedStack: stack,
    });

    if (nextActive) return { closed: true, replacement: null, activeTabId: nextActive };
    const replacement = await this.createTab();
    return { closed: true, replacement, activeTabId: replacement.id };
  }

  async reopenClosed(): Promise<{ tab: TabState; content: string } | null> {
    const [entry, ...rest] = this.#session.closedStack;
    if (!entry) return null;
    const { tab } = entry;
    const closedPath = join(this.dataDir, "buffers", closedBufferFileName(tab));
    // Same rule as readBuffer: a closed buffer that exists but can't be read is never replaced by an empty one.
    const content = await readRegularFileText(closedPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    await writeFileAtomic(this.#bufferPath(tab), content);
    // FA-m5: the newer file still lists this closed entry, so its closed buffer is left in place.
    if (this.newerVersion === null) await unlink(closedPath).catch(() => {});
    const withoutTab = this.#session.tabOrder.filter((id) => id !== tab.id);
    const order = this.#insertAfterActive(withoutTab, tab.id);
    this.#commit({
      ...this.#session,
      tabs: { ...this.#session.tabs, [tab.id]: tab },
      tabOrder: order,
      activeTabId: tab.id,
      closedStack: rest,
    });
    return { tab, content };
  }

  activateTab(tabId: string): void {
    if (!this.#session.tabs[tabId] || this.#session.activeTabId === tabId) return;
    this.#commit({ ...this.#session, activeTabId: tabId });
  }

  reorderTabs(order: string[]): void {
    const current = this.#session.tabOrder;
    const isPermutation =
      order.length === current.length &&
      new Set(order).size === order.length &&
      order.every((id) => current.includes(id));
    if (!isPermutation) return;
    this.#commit({ ...this.#session, tabOrder: [...order] });
  }

  async patchTab(tabId: string, patch: TabPatch): Promise<void> {
    const tab = this.#session.tabs[tabId];
    if (!tab) return;
    // Fix round 1 (F5): `tiles` gets its own merge, not a spread -- `{ ...tab.layout, ...patch.layout }` alone
    // would replace the whole `tiles` object with whatever the patch carries, silently dropping any field the
    // patch omitted (a partial `{ webviewVisible: true }` patch would reset consoleSize to
    // their schema defaults instead of leaving them alone).
    const layout = patch.layout
      ? { ...tab.layout, ...patch.layout, tiles: { ...tab.layout.tiles, ...patch.layout.tiles } }
      : tab.layout;
    const next = tabStateSchema.parse({ ...tab, ...patch, layout });
    if (next.language !== tab.language) {
      await this.#bufferWriters.get(tabId)?.flush();
      await rename(this.#bufferPath(tab), this.#bufferPath(next)).catch(() => {});
      await rename(`${this.#bufferPath(tab)}.bak`, `${this.#bufferPath(next)}.bak`).catch(() => {});
    }
    this.#commit({ ...this.#session, tabs: { ...this.#session.tabs, [tabId]: next } });
  }

  setViewState(tabId: string, viewState: unknown): void {
    const tab = this.#session.tabs[tabId];
    if (!tab) return;
    this.#commit({
      ...this.#session,
      tabs: { ...this.#session.tabs, [tabId]: { ...tab, viewState: viewState ?? null } },
    });
  }

  /** Spec §12.2: the tab's working directory, or null to clear it. Returns the updated tab. */
  setWorkingDirectory(tabId: string, workingDirectory: string | null): TabState | null {
    const tab = this.#session.tabs[tabId];
    if (!tab) return null;
    const next: TabState = { ...tab, workingDirectory };
    this.#commit({ ...this.#session, tabs: { ...this.#session.tabs, [tabId]: next } });
    return next;
  }

  findTabByPath(path: string): TabState | null {
    return Object.values(this.#session.tabs).find((tab) => tab.filePath === path) ?? null;
  }

  setWindow(frame: WindowState): void {
    this.#commit({ ...this.#session, window: windowStateSchema.parse(frame) });
  }

  setSettingsWindow(frame: WindowState): void {
    this.#commit({ ...this.#session, settingsWindow: windowStateSchema.parse(frame) });
  }

  setLastDirectory(directory: string): void {
    this.#commit({ ...this.#session, lastDirectory: directory });
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#bufferWriters.values()].map((writer) => writer.flush()));
    this.#scheduleSave();
    await this.#sessionWriter.flush();
  }

  #writerFor(tabId: string): DebouncedWriter {
    let writer = this.#bufferWriters.get(tabId);
    if (!writer) {
      writer = createDebouncedWriter(
        async (data) => {
          const tab = this.#session.tabs[tabId];
          // Spec §10.1: "Everything is written atomically … and the previous file is kept as .bak".
          if (tab) await writeFileAtomic(this.#bufferPath(tab), data, { backup: true });
        },
        this.delayMs,
        this.onWriteError,
      );
      this.#bufferWriters.set(tabId, writer);
    }
    return writer;
  }

  /** Shared by createTab and reopenClosed: inserts `id` right after the active tab (spec §7.3). */
  #insertAfterActive(order: readonly string[], id: string): string[] {
    const next = [...order];
    const activeIndex = next.indexOf(this.#session.activeTabId);
    next.splice(activeIndex < 0 ? next.length : activeIndex + 1, 0, id);
    return next;
  }

  #bufferPath(tab: Pick<TabState, "id" | "language">): string {
    return join(this.dataDir, "buffers", bufferFileName(tab));
  }

  #commit(session: Session): void {
    this.#session = session;
    this.#scheduleSave();
    for (const listener of this.#listeners) listener(session);
  }

  #scheduleSave(): void {
    // FA-m9: serialized when the write starts, not on every commit.
    this.#sessionWriter.schedule(() => `${JSON.stringify(this.#session, null, 2)}\n`);
  }
}
