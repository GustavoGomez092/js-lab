import { describe, expect, test } from "bun:test";
import type { BootstrapPayload, RunEvent } from "@jslab/rpc-schema";
import {
  createTab,
  defaultSession,
  defaultSettings,
  mergeSettings,
  normalizeSession,
  sessionSchema,
  type TabState,
} from "@jslab/shared";
import { MAX_NPM_LOG_CHARS, maskCredentials } from "../src/npm/npm-panel";
import { createAppStore, STATUS_MESSAGE_MS, shouldAutoRun } from "../src/state/store";

function payload(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1", title: "scratch" })),
    buffers: { t1: "1 + 1" },
    safeMode: { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.3.13" },
    ...overrides,
  };
}

const log = (seq: number): RunEvent => ({ kind: "console", level: "log", groupDepth: 0, args: [], seq, t: 0 });

describe("app store", () => {
  test("hydrate loads the active tab and its buffer without arming auto-run", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.tab?.id).toBe("t1");
    expect(s.code).toBe("1 + 1");
    expect(s.autoRunArmed).toBe(false);
    expect(shouldAutoRun(s)).toBe(false);
  });

  test("runtime notices from Main are added once per id and capped at the 5 newest (FA-I3)", () => {
    const store = createAppStore();
    store.getState().hydrate(payload({ notices: [{ id: "settingsNewer", message: "newer" }] }));
    store.getState().addNotice({ id: "unexpectedError", message: "Something went wrong." });
    store.getState().addNotice({ id: "unexpectedError", message: "Something went wrong." });
    expect(store.getState().notices.map((n) => n.id)).toEqual(["settingsNewer", "unexpectedError"]);
    store.getState().dismissNotice("unexpectedError");
    store.getState().addNotice({ id: "unexpectedError", message: "Something went wrong." });
    expect(store.getState().notices.map((n) => n.id)).toEqual(["settingsNewer", "unexpectedError"]);

    const full = createAppStore();
    const ids = ["settingsRecovered", "sessionRecovered", "settingsNewer", "sessionNewer", "tabsDropped"] as const;
    full.getState().hydrate(payload({ notices: ids.map((id) => ({ id, message: id })) }));
    full.getState().addNotice({ id: "unexpectedError", message: "Something went wrong." });
    expect(full.getState().notices.map((n) => n.id)).toEqual([...ids.slice(1), "unexpectedError"]);
  });

  /**
   * CodeRabbit finding 5, at BOTH sites. `resolve(tabId)` returns `null` for two entirely different situations:
   * "the caller named no tab, so use the active one" and "the caller named a tab that no longer exists". The
   * `!id` branch then applied the change to `get().output`, which mirrors the **active** tab -- so an operation
   * aimed at a dead tab silently hit the live one instead. A late `clearOutput` for a tab the user just closed
   * would wipe the output they are actually looking at.
   *
   * CodeRabbit flagged only `dismissWebDialog`; `clearOutput` directly above it has the identical shape and is
   * covered here too.
   */
  test("clearOutput aimed at a tab that no longer exists leaves the live tab's output alone (CodeRabbit 5)", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().receiveState("r1", "transpiling", 0, "t1");
    store.getState().receiveEvents("r1", [log(1)], "t1");
    expect(store.getState().output.entries).toHaveLength(1);

    store.getState().clearOutput("a-tab-that-was-closed");

    // Untouched: an explicit but unknown tabId is not the same request as "no tabId given".
    expect(store.getState().output.entries).toHaveLength(1);
  });

  test("dismissWebDialog aimed at a tab that no longer exists leaves the live tab's dialog alone (CodeRabbit 5)", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    // "transpiling" specifically: `applyRunState` adopts a new runId only from that state (every run announces it
    // first), and treats any other state for an unknown run as a stale message -- so a dialog sent after, say,
    // "evaluating" would never reach the queue at all.
    store.getState().receiveState("r1", "transpiling", 0, "t1");
    store.getState().receiveEvents("r1", [{ kind: "dialog", text: "hi", seq: 1, t: 0 } as unknown as RunEvent], "t1");
    const shown = store.getState().output.dialogs;
    expect(shown).toHaveLength(1);

    store.getState().dismissWebDialog(String(shown[0]?.key), "a-tab-that-was-closed");

    expect(store.getState().output.dialogs).toHaveLength(1);
  });

  // The legitimate "no tabId given, act on the active tab" case must keep working -- the fix distinguishes the
  // two meanings `resolve` used to collapse together, rather than refusing whenever it returns null.
  test("clearOutput with no tabId still clears the active tab", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().receiveState("r1", "transpiling", 0, "t1");
    store.getState().receiveEvents("r1", [log(1)], "t1");
    expect(store.getState().output.entries).toHaveLength(1);

    store.getState().clearOutput();

    expect(store.getState().output.entries).toEqual([]);
  });

  test("the first edit arms auto-run", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().editCode("2 + 2");
    expect(store.getState().code).toBe("2 + 2");
    expect(shouldAutoRun(store.getState())).toBe(true);
  });

  test("switching a tab's runtime arms auto-run on its own (spec §5.2, M4 Task 9)", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    expect(shouldAutoRun(store.getState())).toBe(false);
    store.getState().setRuntime("browser");
    expect(store.getState().tab?.runtime).toBe("browser");
    expect(shouldAutoRun(store.getState())).toBe(true);
  });

  test("auto-run stays off in safe mode and when disabled in settings", () => {
    const safe = createAppStore();
    safe.getState().hydrate(payload({ safeMode: { active: true, reason: "crashLoop" } }));
    safe.getState().editCode("x");
    expect(shouldAutoRun(safe.getState())).toBe(false);

    const disabled = createAppStore();
    disabled.getState().hydrate(payload({ settings: mergeSettings(defaultSettings(), { run: { autoRun: false } }) }));
    disabled.getState().editCode("x");
    expect(shouldAutoRun(disabled.getState())).toBe(false);
  });

  test("run events and states flow through the output reducer", () => {
    const store = createAppStore();
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveEvents("r1", [log(1), log(2)]);
    store.getState().receiveState("r1", "idle");
    expect(store.getState().output.entries).toHaveLength(2);
    expect(store.getState().output.runState).toBe("idle");
    store.getState().clearOutput();
    expect(store.getState().output.entries).toEqual([]);

    // Fix round 1 (I-1): workingDirectoryMissing goes true on a WorkingDirectoryError event, and false again once
    // a new run's leftover entries are actually cleared -- the same moment `stale` flips back to false.
    store.getState().receiveState("r2", "transpiling");
    store.getState().receiveEvents("r2", [
      {
        kind: "error",
        phase: "runner",
        name: "WorkingDirectoryError",
        message: "Working directory not found: /work/api",
        stack: [],
        seq: 1,
        t: 0,
      },
    ]);
    expect(store.getState().output.workingDirectoryMissing).toBe(true);
    store.getState().receiveState("r3", "transpiling");
    store.getState().receiveState("r3", "evaluating");
    expect([store.getState().output.stale, store.getState().output.workingDirectoryMissing]).toEqual([false, false]);
  });

  test("diagnostics are kept only for the current run and reset when a new run starts", () => {
    const store = createAppStore();
    const warning = { severity: "warning" as const, code: "magic-comment-no-value", message: "m", line: 1, column: 1 };
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveDiagnostics("r1", [warning]);
    store.getState().receiveDiagnostics("old", []);
    expect(store.getState().diagnostics).toEqual([warning]);
    store.getState().receiveState("r2", "transpiling");
    expect(store.getState().diagnostics).toEqual([]);
  });

  test("reveal requests carry an increasing nonce so repeated clicks re-trigger", () => {
    const store = createAppStore();
    store.getState().reveal(4);
    store.getState().reveal(4);
    expect(store.getState().revealRequest).toEqual({ line: 4, nonce: 2 });
  });

  test("layout changes are clamped and toggle orientation", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setEditorSize(99);
    store.getState().toggleOrientation();
    expect(store.getState().tab?.layout).toEqual({
      orientation: "vertical",
      editorSize: 90,
      outputVisible: true,
      tiles: { webviewVisible: false, consoleSize: 55 },
      muted: false,
    });
  });

  test("hydrate loads every tab with its own buffer and output, and switching swaps the mirrors", () => {
    const store = createAppStore();
    const session = normalizeSession(
      sessionSchema.parse({
        tabOrder: ["a", "b"],
        activeTabId: "b",
        tabs: { a: createTab({ id: "a" }), b: createTab({ id: "b" }) },
        closedStack: [{ tab: createTab({ id: "c" }), closedAt: 1 }],
      }),
    );
    store.getState().hydrate(payload({ session, buffers: { a: "1", b: "2" } }));
    expect([store.getState().activeTabId, store.getState().code, store.getState().closedCount]).toEqual(["b", "2", 1]);
    store.getState().receiveState("r1", "transpiling", undefined, "a");
    store.getState().receiveEvents("r1", [log(1)], "a");
    expect(store.getState().output.entries).toHaveLength(0);
    store.getState().activateTab("a");
    expect([store.getState().code, store.getState().output.entries.length]).toEqual(["1", 1]);

    // M-2 (fix round 1): applyTabUpdate marks the output stale only for the ACTIVE tab's own WD change.
    store.getState().activateTab("b");
    expect(store.getState().output.stale).toBe(false);
    // A background tab's ("a") WD change must not mark the active tab's ("b") output stale.
    store.getState().applyTabUpdate({ ...(store.getState().tabs.a as TabState), workingDirectory: "/work/api" });
    expect(store.getState().output.stale).toBe(false);
    // An active-tab update with the same WD (null -> null here) doesn't mark it stale either.
    store
      .getState()
      .applyTabUpdate({ ...(store.getState().tabs.b as TabState), title: "renamed", titleIsCustom: true });
    expect(store.getState().output.stale).toBe(false);
  });

  test("openTab inserts after the active tab; removing the last tab clears the mirrors", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().openTab(createTab({ id: "t2" }), "two");
    store.getState().activateTab("t1");
    store.getState().openTab(createTab({ id: "t3" }), "three");
    expect(store.getState().tabOrder).toEqual(["t1", "t3", "t2"]);
    store.getState().removeTab("t3");
    expect(store.getState().activeTabId).toBe("t2");
    store.getState().removeTab("t2");
    store.getState().removeTab("t1");
    expect([store.getState().activeTabId, store.getState().tab, store.getState().code]).toEqual([null, null, ""]);
  });

  test("rename, Main tab updates and reorder", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setViewState("t1", { scrollTop: 40 });
    store.getState().renameTab("t1", "  mine ");
    expect(store.getState().tab).toMatchObject({ title: "mine", titleIsCustom: true });
    store.getState().applyTabUpdate(createTab({ id: "t1", filePath: "/a.ts", lastSavedHash: "h" }));
    expect(store.getState().tab).toMatchObject({ filePath: "/a.ts", viewState: { scrollTop: 40 } });
    store.getState().openTab(createTab({ id: "t2" }), "");
    store.getState().reorderTabs(["t2"]);
    expect(store.getState().tabOrder).toEqual(["t1", "t2"]);
    store.getState().reorderTabs(["t2", "t1"]);
    expect(store.getState().tabOrder).toEqual(["t2", "t1"]);
  });

  test("focus, modal, output filter, status message, cursor and editor size reset", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setFocus("output");
    store.getState().openModal({ kind: "palette", context: "output" });
    store.getState().setOutputFilter("errors");
    store.getState().setStatusMessage("Formatted");
    store.getState().setCursor({ line: 3, column: 9 });
    store.getState().setEditorSize(80);
    store.getState().resetEditorSize();
    const s = store.getState();
    expect([s.focus, s.modal?.kind, s.outputFilter, s.statusMessage, s.cursor, s.tab?.layout.editorSize]).toEqual([
      "output",
      "palette",
      "errors",
      "Formatted",
      { line: 3, column: 9 },
      50,
    ]);
    store.getState().closeModal();
    expect(store.getState().modal).toBeNull();
  });

  // FB-m5: "Saved foo.ts" and "Couldn't format: …" used to stay in the status bar forever.
  test("non-sticky status messages clear after the delay or on the next edit; sticky ones stay (FB-m5)", () => {
    let next = 1;
    const pending = new Map<number, { callback: () => void; ms: number }>();
    const store = createAppStore({
      timers: {
        setTimeout: (callback, ms) => {
          pending.set(next, { callback, ms });
          return next++;
        },
        clearTimeout: (id) => void pending.delete(id as number),
      },
    });
    store.getState().hydrate(payload());
    const fire = () => {
      for (const [id, timer] of [...pending]) {
        pending.delete(id);
        timer.callback();
      }
    };

    store.getState().setStatusMessage("Saved a.ts");
    expect([...pending.values()].map((timer) => timer.ms)).toEqual([STATUS_MESSAGE_MS]);
    fire();
    expect(store.getState().statusMessage).toBeNull();

    store.getState().setStatusMessage("Couldn't save");
    store.getState().setStatusMessage("Saved b.ts");
    expect(pending.size).toBe(1);
    store.getState().editCode("2 + 2");
    expect([store.getState().statusMessage, pending.size]).toEqual([null, 0]);

    store.getState().setStatusMessage("Formatting…", { sticky: true });
    expect(pending.size).toBe(0);
    store.getState().editCode("3 + 3");
    fire();
    expect(store.getState().statusMessage).toBe("Formatting…");
    store.getState().clearTransientStatus();
    expect(store.getState().statusMessage).toBe("Formatting…");
    store.getState().setStatusMessage("Saved c.ts");
    store.getState().clearTransientStatus();
    expect(store.getState().statusMessage).toBeNull();
  });

  test("run messages for an unknown tabId leave the store unchanged (m-6)", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    const before = store.getState();
    store.getState().receiveEvents("r1", [log(1)], "ghost");
    store.getState().receiveState("r1", "transpiling", undefined, "ghost");
    store.getState().receiveDiagnostics("r1", [], "ghost");
    const after = store.getState();
    expect([after.tabs, after.buffers, after.runtimes, after.output, after.diagnostics]).toEqual([
      before.tabs,
      before.buffers,
      before.runtimes,
      before.output,
      before.diagnostics,
    ]);
  });

  // LOGCAP-2 keeps the log stream per opId, so the store test below no longer asserts on a single flat string.
  test("the npm slice keeps the list, upserts operations and marks a newly added package (spec §11.2)", () => {
    const store = createAppStore();
    const before = store.getState().packagesRevision;
    store.getState().receiveNpmList(
      {
        installed: [{ name: "zod", version: "4.6.4", latest: null }],
        outdatedCheckedAt: null,
        outdatedError: null,
        revision: 1,
      },
      500,
    );
    expect([store.getState().npm.loaded, store.getState().npm.lastAdded]).toEqual([true, null]);
    expect(store.getState().packagesRevision).toBe(before + 1);
    store.getState().receiveNpmList(
      {
        installed: [{ name: "zod", version: "4.6.4", latest: "4.7.0" }],
        outdatedCheckedAt: 1,
        outdatedError: null,
        revision: 2,
      },
      900,
    );
    expect(store.getState().packagesRevision).toBe(before + 1);
    store.getState().receiveNpmList(
      {
        installed: [
          { name: "fixture-a", version: "1.0.0", latest: null },
          { name: "zod", version: "4.6.4", latest: "4.7.0" },
        ],
        outdatedCheckedAt: 1,
        outdatedError: null,
        revision: 3,
      },
      1000,
    );
    expect(store.getState().npm.lastAdded).toEqual({ name: "fixture-a", at: 1000 });
    expect(store.getState().packagesRevision).toBe(before + 2);
    const op = { id: "op1", kind: "install", target: "zod", status: "running", error: null, notice: null } as const;
    store.getState().receiveNpmOperation(op);
    store.getState().receiveNpmOperation({ ...op, status: "succeeded" });
    expect(store.getState().npm.operations.map((o) => o.status)).toEqual(["succeeded"]);

    // Fix round 2 (N-3): trimming to MAX_NPM_OPERATIONS evicts the oldest *finished* operations first, and never
    // a queued or running one while a finished one is still available to evict.
    const fresh = createAppStore();
    for (let i = 0; i < 49; i += 1) {
      fresh.getState().receiveNpmOperation({
        id: `f${i}`,
        kind: "install",
        target: `pkg${i}`,
        status: "succeeded",
        error: null,
        notice: null,
      });
    }
    fresh.getState().receiveNpmOperation({
      id: "running1",
      kind: "install",
      target: "still-running",
      status: "running",
      error: null,
      notice: null,
    });
    expect(fresh.getState().npm.operations.map((o) => o.id)).toContain("running1");
    // One more finished op pushes the total to 51: the oldest finished (f0) is evicted, not the running one.
    fresh.getState().receiveNpmOperation({
      id: "f49",
      kind: "install",
      target: "pkg49",
      status: "succeeded",
      error: null,
      notice: null,
    });
    const ids = fresh.getState().npm.operations.map((o) => o.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain("f0");
    expect(ids).toContain("running1");
    expect(ids).toContain("f49");
  });

  // R-M3-OUTDATED-1: receiveNpmList is no longer last-writer-wins. A push and a response can arrive in either
  // order (the E2E flake's root cause); the higher revision always wins, whichever order delivery takes.
  test("an older npm list result never overwrites a newer one", () => {
    const store = createAppStore();
    store.getState().receiveNpmList({
      installed: [],
      outdatedCheckedAt: 10,
      outdatedError: { kind: "network", log: "x" },
      revision: 5,
    });
    store.getState().receiveNpmList({ installed: [], outdatedCheckedAt: null, outdatedError: null, revision: 4 });
    expect(store.getState().npm.outdatedError?.kind).toBe("network");

    // The reverse order (response first, then push) ends at the same, newer state too.
    const reversed = createAppStore();
    reversed.getState().receiveNpmList({ installed: [], outdatedCheckedAt: null, outdatedError: null, revision: 4 });
    reversed.getState().receiveNpmList({
      installed: [],
      outdatedCheckedAt: 10,
      outdatedError: { kind: "network", log: "x" },
      revision: 5,
    });
    expect(reversed.getState().npm.outdatedError?.kind).toBe("network");

    // An equal revision re-applies (idempotent), rather than being treated as stale.
    reversed.getState().receiveNpmList({ installed: [], outdatedCheckedAt: 20, outdatedError: null, revision: 5 });
    expect(reversed.getState().npm.outdatedError).toBeNull();
    expect(reversed.getState().npm.outdatedCheckedAt).toBe(20);
  });

  // R-M3-T26-LOGCAP-2 (parked R-M3-T18-LOGCAP-1): a per-opId cap, trimmed from the front, one buffer per operation.
  test("appendNpmLog caps each operation's own buffer at MAX_NPM_LOG_CHARS and leaves other operations untouched", () => {
    const store = createAppStore();
    store.getState().appendNpmLog("op1", "a".repeat(30_000));
    store.getState().appendNpmLog("op1", "b".repeat(30_000));
    store.getState().appendNpmLog("op1", "c".repeat(30_000));
    // Fix round 3: the carry holds text after the last line break (never after whitespace), so a complete line
    // (here, ending in a newline) is stored immediately. The 30,000-char runs above have no line break: they
    // stay carried until the third one pushes the carry past MAX_NPM_LOG_CHARS, which flushes it whole.
    const NL = String.fromCharCode(10);
    store.getState().appendNpmLog("op2", `untouched${NL}`);
    expect(store.getState().npm.logs.op1?.length).toBe(MAX_NPM_LOG_CHARS);
    expect(store.getState().npm.logs.op1?.endsWith("c".repeat(30_000))).toBe(true);
    expect(store.getState().npm.logs.op2).toBe(`untouched${NL}`);
  });

  // Fix round 2 (I-1): Main forwards every pipe read as its own npm.log chunk, so a credential can split across
  // two chunks at any point. A hidden per-opId carry holds the unmasked tail back until a whitespace boundary
  // (or a terminal op, or the 4 KiB carry bound) so the store never holds the split-open credential in clear.
  test("credentials split across log chunks are never stored in clear, both mid-stream and at the terminal flush", () => {
    const NL = String.fromCharCode(10);
    const splits: [string, string, string][] = [
      ["token-value", "//registry.example/:_authToken=abc", `123${NL}`],
      ["key", "//registry.example/:_authTo", `ken=abc123${NL}`],
      ["url-password-after-scheme", "GET https://user:sec", `ret@registry.example/zod${NL}`],
      ["url-password-in-userinfo", "GET https:", `//user:secret@registry.example/zod${NL}`],
    ];
    const store = createAppStore();
    for (const [opId, a, b] of splits) {
      store.getState().appendNpmLog(opId, a);
      // Mid-stream: the split-open half must never appear, even before the boundary-completing chunk arrives.
      expect((store.getState().npm.logs[opId] ?? "").includes("secret")).toBe(false);
      expect((store.getState().npm.logs[opId] ?? "").includes("abc123")).toBe(false);
      store.getState().appendNpmLog(opId, b);
      store.getState().receiveNpmOperation({
        id: opId,
        kind: "install",
        target: "fixture-a",
        status: "succeeded",
        error: null,
        notice: null,
      });
      const final = store.getState().npm.logs[opId] ?? "";
      expect(final.includes("secret")).toBe(false);
      expect(final.includes("abc123")).toBe(false);
      expect(final.includes("registry.example")).toBe(true);
    }

    // The terminal flush itself: a carry with no trailing whitespace at all is still masked and flushed once the
    // operation finishes, not left dangling forever.
    store.getState().appendNpmLog("op5", "_authToken=abc123");
    expect(store.getState().npm.logs.op5 ?? "").toBe("");
    store.getState().receiveNpmOperation({
      id: "op5",
      kind: "install",
      target: "fixture-a",
      status: "failed",
      error: { kind: "unknown", log: "" },
      notice: null,
    });
    expect((store.getState().npm.logs.op5 ?? "").includes("abc123")).toBe(false);

    // Masking is idempotent: re-masking an already-masked buffer (as the terminal flush of an already-masked
    // segment would) changes nothing further.
    const masked = maskCredentials("https://user:secret@registry.example/ _authToken=abc123");
    expect(maskCredentials(masked)).toBe(masked);
  });

  // Fix round 3 (NI-1, NI-2): credentials can contain whitespace, so a whitespace carry stored their values in
  // clear; and a forced flush of a long line re-joined a split credential. The carry is now line-based, and a
  // line past MAX_NPM_LOG_CHARS is masked as one piece.
  test("whitespace-containing credentials are never stored in clear under any chunking", () => {
    const NL = String.fromCharCode(10);
    const store = createAppStore();
    let seq = 0;
    const fragments = (secret: string) => {
      const parts: string[] = [];
      for (let index = 0; index + 3 <= secret.length; index += 1) parts.push(secret.slice(index, index + 3));
      return parts;
    };
    const assertClean = (opId: string, secret: string, where: string) => {
      const stored = store.getState().npm.logs[opId] ?? "";
      for (const fragment of fragments(secret)) {
        if (stored.includes(fragment)) throw new Error(`${where}: ${JSON.stringify(fragment)} in ${stored}`);
      }
      expect(stored.includes(secret)).toBe(false);
    };
    const finish = (opId: string) =>
      store.getState().receiveNpmOperation({
        id: opId,
        kind: "install",
        target: "fixture-a",
        status: "failed",
        error: { kind: "unknown", log: "" },
        notice: null,
      });
    const deliver = (chunks: string[], secret: string, label: string) => {
      seq += 1;
      const opId = `ws${seq}`;
      for (const [index, chunk] of chunks.entries()) {
        store.getState().appendNpmLog(opId, chunk);
        assertClean(opId, secret, `${label} after chunk ${index}`);
      }
      finish(opId);
      assertClean(opId, secret, `${label} after the terminal flush`);
      expect((store.getState().npm.logs[opId] ?? "").includes("***")).toBe(true);
    };

    const cases: [string, string][] = [
      ["Authorization: Bearer abc12345", "abc12345"],
      ["_auth = abc123", "abc123"],
      ['"_authToken": "abc123"', "abc123"],
    ];
    for (const [line, secret] of cases) {
      for (const text of [`${line}${NL}`, line]) {
        for (let offset = 0; offset <= text.length; offset += 1) {
          deliver([text.slice(0, offset), text.slice(offset)], secret, `${JSON.stringify(text)} split at ${offset}`);
        }
        deliver(text.split(""), secret, `${JSON.stringify(text)} one character at a time`);
      }
    }

    // A single line longer than MAX_NPM_LOG_CHARS with a credential near the middle, and no whitespace at all,
    // delivered in 1,000-character chunks whose boundary splits the credential, and as one chunk.
    const longLine = `${"x".repeat(39_990)}https://user:secret@registry.example/${"y".repeat(40_000)}`;
    const thousands: string[] = [];
    for (let index = 0; index < longLine.length; index += 1000) thousands.push(longLine.slice(index, index + 1000));
    for (const [label, chunks] of [
      ["1,000-character chunks", thousands],
      ["one chunk", [longLine]],
    ] as [string, string[]][]) {
      seq += 1;
      const opId = `long${seq}`;
      for (const chunk of chunks) {
        store.getState().appendNpmLog(opId, chunk);
        const stored = store.getState().npm.logs[opId] ?? "";
        expect(stored.includes("secret")).toBe(false);
        expect(stored.includes("user:")).toBe(false);
      }
      finish(opId);
      const stored = store.getState().npm.logs[opId] ?? "";
      if (stored.includes("secret")) throw new Error(`${label}: the long line kept the password`);
      expect(stored.includes("secret")).toBe(false);
      expect(stored.includes("https://registry.example/")).toBe(true);
    }
  });

  // Fix round 2 (M-2): a spec or a raw log can itself carry a credential (an install spec URL, a registry error
  // echoing the auth token). receiveNpmOperation masks both once, on arrival, so every consumer (the running
  // line, the failure card, the R26-6 status bar, the E2E snapshot) only ever sees masked data. Retry still needs
  // the real spec, kept in a private, non-rendered, non-exported rawTargets map.
  test("operations are stored with masked targets and logs, and rawTargets keeps the raw spec for retry", () => {
    const store = createAppStore();
    const rawTarget = "git+https://ghp_FAKE@github.com/o/r.git";
    store.getState().receiveNpmOperation({
      id: "op1",
      kind: "install",
      target: rawTarget,
      status: "failed",
      error: { kind: "unknown", log: "install failed: _authToken=abc123" },
      notice: null,
    });
    const stored = store.getState().npm.operations[0];
    expect(stored?.target.includes("ghp_FAKE")).toBe(false);
    expect(stored?.error?.log.includes("abc123")).toBe(false);
    expect(store.getState().npm.rawTargets.op1).toBe(rawTarget);
  });
});
