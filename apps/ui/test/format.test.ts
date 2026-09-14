import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import type { EditorHandle, OffsetEdit } from "../src/editor/editor-handle";
import { createFormatActions, FORMAT_BUSY_DELAY_MS } from "../src/format/format-actions";
import { type FormatOutcome, formatCode } from "../src/format/format-core";
import {
  createWorkerFormatter,
  formatTimeoutMs,
  shouldFormatBeforeRun,
  type WorkerLike,
} from "../src/format/formatter";
import { applyEdits, computeEdits } from "../src/format/line-diff";
import { prettierOptions } from "../src/format/prettier-options";
import type { TimerApi } from "../src/state/auto-run";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";

function manualTimers() {
  let next = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const timers: TimerApi = {
    setTimeout: (callback, ms) => {
      const id = next++;
      pending.set(id, {
        callback: () => {
          pending.delete(id);
          callback();
        },
        ms,
      });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
  };
  return { timers, pending };
}

describe("prettier options", () => {
  test("map every setting and pick the parser by language", () => {
    expect(prettierOptions(defaultSettings(), "tsx")).toEqual({
      parser: "babel-ts",
      printWidth: 80,
      tabWidth: 2,
      useTabs: false,
      semi: true,
      singleQuote: false,
      quoteProps: "as-needed",
      jsxSingleQuote: false,
      trailingComma: "all",
      bracketSpacing: true,
      bracketSameLine: false,
      arrowParens: "always",
    });
    expect(prettierOptions(defaultSettings(), "typescript").parser).toBe("typescript");
    expect(prettierOptions(defaultSettings(), "jsx").parser).toBe("babel");
  });
});

describe("formatCode", () => {
  test("formats TypeScript and TSX with the configured style", async () => {
    const options = prettierOptions(
      mergeSettings(defaultSettings(), { prettier: { semi: false, singleQuote: true } }),
      "typescript",
    );
    expect(await formatCode('const a = "x";;\nconst b   =   2', options, 0)).toMatchObject({
      ok: true,
      formatted: "const a = 'x'\nconst b = 2\n",
    });
    const tsx = await formatCode(
      'const C = (p: {n: number}) => <div className="a">{p.n}</div>',
      prettierOptions(defaultSettings(), "tsx"),
      0,
    );
    expect(tsx).toMatchObject({
      ok: true,
      formatted: 'const C = (p: { n: number }) => <div className="a">{p.n}</div>;\n',
    });
  });

  test("syntax errors are reported, and the cursor offset is mapped", async () => {
    const failed = await formatCode("const = ;", prettierOptions(defaultSettings(), "typescript"), 0);
    expect(failed.ok).toBe(false);
    expect(failed.ok ? "" : failed.error.length).toBeGreaterThan(0);
    const mapped = await formatCode("const   a=1", prettierOptions(defaultSettings(), "typescript"), 11);
    expect(mapped.ok && mapped.cursorOffset >= 0 && mapped.cursorOffset <= mapped.formatted.length).toBe(true);
  });

  // Fix round 1 (m-2): Prettier's default endOfLine is "lf", which would make every line of a CRLF
  // document differ from its formatted output (even lines that needed no change), defeating the minimal
  // line-level diff. "auto" keeps the document's own line endings.
  test("CRLF documents keep their line endings, so computeEdits touches only the changed lines", async () => {
    const options = prettierOptions(defaultSettings(), "javascript");
    const before = "const a = 1;\r\nconst   b   =   2;\r\n";
    const result = await formatCode(before, options, 0);
    expect(result.ok).toBe(true);
    const after = result.ok ? result.formatted : "";
    expect(after).toBe("const a = 1;\r\nconst b = 2;\r\n");
    const edits = computeEdits(before, after);
    expect(edits).toHaveLength(1);
    expect(edits[0]?.start).toBe("const a = 1;\r\n".length);
  });
});

describe("line diff", () => {
  const cases: [string, string][] = [
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["a\nb\nc", "a\nb\nc\n"],
    ["", "x\n"],
    ["x\ny\n", ""],
    ["one\ntwo\nthree\nfour\n", "zero\none\nthree\nfour\nfive\n"],
    ["same", "same"],
    ["a\r\nb\r\n", "a\r\nc\r\n"],
  ];

  test("applying the edits turns the old text into the new text", () => {
    for (const [before, after] of cases) expect(applyEdits(before, computeEdits(before, after))).toBe(after);
  });

  test("edits touch only changed lines", () => {
    const before = "keep1\nkeep2\nold\nkeep3\n";
    expect(computeEdits(before, "keep1\nkeep2\nnew\nkeep3\n")).toEqual([{ start: 12, end: 16, text: "new\n" }]);
    expect(computeEdits("same", "same")).toEqual([]);
  });
});

describe("formatter", () => {
  test("format before run only when enabled and not while typing", () => {
    const base = { formatOnRun: true, editorFocused: true, lastTypedAt: 10_000, now: 10_500 };
    expect(shouldFormatBeforeRun(base)).toBe(false);
    expect(shouldFormatBeforeRun({ ...base, now: 11_001 })).toBe(true);
    expect(shouldFormatBeforeRun({ ...base, editorFocused: false })).toBe(true);
    expect(shouldFormatBeforeRun({ ...base, formatOnRun: false, now: 99_999 })).toBe(false);
  });

  // Fix round 1 (m-1): a worker that fails to start (a synchronous throw from `createWorker`, inside the
  // Promise executor) must resolve the pending request instead of leaving it, and every later request,
  // hanging forever.
  test("a worker that fails to start resolves the request instead of hanging", async () => {
    const formatter = createWorkerFormatter(() => {
      throw new Error("boom");
    });
    const options = prettierOptions(defaultSettings(), "javascript");
    expect(await formatter.format("a", options, 0)).toEqual({ ok: false, error: "boom" });
  });

  test("the worker client correlates responses and recovers from a worker error", async () => {
    const workers: FakeWorker[] = [];
    class FakeWorker implements WorkerLike {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      sent: { id: number; code: string }[] = [];
      terminated = false;
      postMessage(message: { id: number; code: string }) {
        this.sent.push(message);
      }
      terminate() {
        this.terminated = true;
      }
      reply(data: unknown) {
        this.onmessage?.({ data } as MessageEvent);
      }
    }
    const formatter = createWorkerFormatter(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const options = prettierOptions(defaultSettings(), "javascript");
    const first = formatter.format("a", options, 0);
    const second = formatter.format("b", options, 0);
    const [w] = workers;
    w?.reply({ id: w.sent[1]?.id, ok: true, formatted: "b;\n", cursorOffset: 0 });
    w?.reply({ id: w.sent[0]?.id, ok: false, error: "bad" });
    expect(await second).toEqual({ ok: true, formatted: "b;\n", cursorOffset: 0 });
    expect(await first).toEqual({ ok: false, error: "bad" });
    const third = formatter.format("c", options, 0);
    w?.onerror?.({ message: "crashed" } as ErrorEvent);
    expect(await third).toEqual({ ok: false, error: "crashed" });
    void formatter.format("d", options, 0);
    expect([workers.length, w?.terminated]).toEqual([2, true]);
    formatter.dispose();
  });

  // T21-m1-timeout: a hung worker must not leave format-before-run (and every later ⌘R) waiting forever.
  test("a request that times out fails, frees the queue and restarts the worker (T21-m1-timeout)", async () => {
    expect([formatTimeoutMs(0), formatTimeoutMs(1024 * 1024), formatTimeoutMs(3 * 1024 * 1024)]).toEqual([
      10_000, 15_000, 25_000,
    ]);
    expect(formatTimeoutMs(50 * 1024 * 1024)).toBe(60_000);

    const workers: SilentWorker[] = [];
    class SilentWorker implements WorkerLike {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      sent: { id: number }[] = [];
      terminated = false;
      postMessage(message: { id: number }) {
        this.sent.push(message);
      }
      terminate() {
        this.terminated = true;
      }
    }
    const { timers, pending } = manualTimers();
    const formatter = createWorkerFormatter(
      () => {
        const worker = new SilentWorker();
        workers.push(worker);
        return worker;
      },
      { timers },
    );
    const options = prettierOptions(defaultSettings(), "javascript");
    const first = formatter.format("a", options, 0);
    const second = formatter.format("b", options, 0);
    // RR2-m2: requests run sequentially in the worker, so only the head of the queue has a timer running. The
    // second request's timer starts only once the first settles.
    expect([...pending.values()].map((timer) => timer.ms)).toEqual([10_000]);
    const [firstTimer] = [...pending.values()];
    firstTimer?.callback();
    expect(await first).toEqual({ ok: false, error: strings.format.timedOut });
    expect(await second).toEqual({ ok: false, error: strings.format.restarted });
    expect([workers[0]?.terminated, pending.size]).toEqual([true, 0]);

    const third = formatter.format("c", options, 0);
    expect(workers).toHaveLength(2);
    const [fresh] = workers.slice(1);
    fresh?.onmessage?.({
      data: { id: fresh.sent[0]?.id, ok: true, formatted: "c;\n", cursorOffset: 0 },
    } as MessageEvent);
    expect(await third).toEqual({ ok: true, formatted: "c;\n", cursorOffset: 0 });
    expect(pending.size).toBe(0);
  });

  // RR2-m2: the timer used to start when a request was posted, not when the worker actually started on it. A small
  // request queued behind a large one could then time out purely from waiting, even though the large one was still
  // well within its own budget.
  test("a small request queued behind a slow large one doesn't time out while the large one is within its budget (RR2-m2)", async () => {
    const workers: SilentWorker[] = [];
    class SilentWorker implements WorkerLike {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      sent: { id: number }[] = [];
      terminated = false;
      postMessage(message: { id: number }) {
        this.sent.push(message);
      }
      terminate() {
        this.terminated = true;
      }
    }
    const { timers, pending } = manualTimers();
    const formatter = createWorkerFormatter(
      () => {
        const worker = new SilentWorker();
        workers.push(worker);
        return worker;
      },
      { timers },
    );
    const options = prettierOptions(defaultSettings(), "javascript");
    const big = "x".repeat(6 * 1024 * 1024);
    const large = formatter.format(big, options, 0);
    const small = formatter.format("x", options, 0);
    // Only the large request (the head) has a timer; the small one queued behind it doesn't yet.
    expect([...pending.values()].map((timer) => timer.ms)).toEqual([formatTimeoutMs(big.length)]);

    const [w] = workers;
    w?.onmessage?.({ data: { id: w.sent[0]?.id, ok: true, formatted: "big;\n", cursorOffset: 0 } } as MessageEvent);
    expect(await large).toEqual({ ok: true, formatted: "big;\n", cursorOffset: 0 });

    // Only now does the small request's own (small) timer start, not counting the time it spent waiting.
    expect([...pending.values()].map((timer) => timer.ms)).toEqual([formatTimeoutMs(1)]);
    w?.onmessage?.({ data: { id: w.sent[1]?.id, ok: true, formatted: "x;\n", cursorOffset: 0 } } as MessageEvent);
    expect(await small).toEqual({ ok: true, formatted: "x;\n", cursorOffset: 0 });
  });

  // RR2-m2 related hardening: a terminated worker's handlers are nulled in `stop()`, so a late event from it
  // (which a real Worker.terminate() never fires, but is defensive) can't reach the new worker's requests.
  test("a late error from a terminated worker doesn't fail the new worker's requests (RR2-m2)", async () => {
    const workers: SilentWorker[] = [];
    class SilentWorker implements WorkerLike {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      sent: { id: number }[] = [];
      terminated = false;
      postMessage(message: { id: number }) {
        this.sent.push(message);
      }
      terminate() {
        this.terminated = true;
      }
    }
    const { timers, pending } = manualTimers();
    const formatter = createWorkerFormatter(
      () => {
        const worker = new SilentWorker();
        workers.push(worker);
        return worker;
      },
      { timers },
    );
    const options = prettierOptions(defaultSettings(), "javascript");
    const first = formatter.format("a", options, 0);
    const [firstTimer] = [...pending.values()];
    firstTimer?.callback();
    await first;

    const stale = workers[0];
    const third = formatter.format("c", options, 0);
    // A late error arrives from the already-terminated worker.
    stale?.onerror?.({ message: "late" } as ErrorEvent);
    const [fresh] = workers.slice(1);
    fresh?.onmessage?.({
      data: { id: fresh.sent[0]?.id, ok: true, formatted: "c;\n", cursorOffset: 0 },
    } as MessageEvent);
    expect(await third).toEqual({ ok: true, formatted: "c;\n", cursorOffset: 0 });
  });

  // Review rec 1: a format that takes a noticeable time says so, so ⌘R and ⌘S never look dead.
  test("a format pending past the busy delay shows Formatting…, which clears when it settles", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", language: "javascript" })),
      buffers: { t1: "a" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    let release: (outcome: FormatOutcome) => void = () => {};
    const { timers, pending } = manualTimers();
    const actions = createFormatActions({
      store,
      editor: () => null,
      formatter: {
        format: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        dispose: () => {},
      },
      timers,
    });

    const quick = actions.formatTab("t1");
    expect([...pending.values()].map((timer) => timer.ms)).toEqual([FORMAT_BUSY_DELAY_MS]);
    release({ ok: true, formatted: "a", cursorOffset: 0 });
    expect(await quick).toBe(true);
    expect([pending.size, store.getState().statusMessage]).toEqual([0, null]);

    const slow = actions.formatTab("t1");
    for (const timer of [...pending.values()]) timer.callback();
    expect(store.getState().statusMessage).toBe(strings.format.busy);
    release({ ok: true, formatted: "a;\n", cursorOffset: 0 });
    expect(await slow).toBe(true);
    expect(store.getState().statusMessage).toBeNull();

    const failing = actions.formatTab("t1");
    for (const timer of [...pending.values()]) timer.callback();
    release({ ok: false, error: strings.format.timedOut });
    expect(await failing).toBe(false);
    expect(store.getState().statusMessage).toBe(strings.format.failed(strings.format.timedOut));
  });

  test("formatTab applies minimal edits, reports failures and drops stale results", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", language: "javascript" })),
      buffers: { t1: "a\nb  =  1\n" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    let value = "a\nb  =  1\n";
    const applied: OffsetEdit[][] = [];
    const editor = {
      getValue: () => value,
      getCursorOffset: () => 0,
      applyOffsetEdits: mock((edits: OffsetEdit[]) => {
        applied.push(edits);
        value = applyEdits(value, edits);
      }),
    } as unknown as EditorHandle;
    let respond: (
      code: string,
    ) => Promise<{ ok: true; formatted: string; cursorOffset: number } | { ok: false; error: string }> = async (
      code,
    ) => ({ ok: true, formatted: code.replace("b  =  1", "b = 1;").replace("a\n", "a;\n"), cursorOffset: 0 });
    const actions = createFormatActions({
      store,
      editor: () => editor,
      formatter: { format: (code) => respond(code), dispose: () => {} },
    });
    expect(await actions.formatTab()).toBe(true);
    expect(value).toBe("a;\nb = 1;\n");
    expect(applied[0]).toEqual([{ start: 0, end: 10, text: "a;\nb = 1;\n" }]);

    respond = async () => ({ ok: false, error: "SyntaxError: Unexpected token (1:7)\n> 1 | const = ;" });
    expect(await actions.formatTab()).toBe(false);
    expect(store.getState().statusMessage).toBe("Couldn't format: SyntaxError: Unexpected token (1:7)");

    respond = async (code) => {
      value = `${value}// typed meanwhile\n`;
      return { ok: true, formatted: `${code}\n`, cursorOffset: 0 };
    };
    expect(await actions.formatTab()).toBe(false);
    expect(applied).toHaveLength(1);
  });

  // Fix round 1 (I-2): the `editor` handle is the single global Monaco editor, captured before the await.
  // If the active tab changes while Prettier runs, that handle now belongs to a different tab's model, so
  // formatTab must not read or write through it.
  test("formatTab returns false and applies no edits when the active tab changed during the format", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", language: "javascript" })),
      buffers: { t1: "a" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    store.getState().openTab(createTab({ id: "t2", language: "javascript" }), "b", false);
    const applyOffsetEdits = mock((_edits: OffsetEdit[]) => {});
    const editor = { getValue: () => "a", getCursorOffset: () => 0, applyOffsetEdits } as unknown as EditorHandle;
    let release: (outcome: { ok: true; formatted: string; cursorOffset: number }) => void = () => {};
    const actions = createFormatActions({
      store,
      editor: () => editor,
      formatter: {
        format: () =>
          new Promise((resolve) => {
            release = resolve;
          }),
        dispose: () => {},
      },
    });
    const pending = actions.formatTab("t1");
    store.getState().activateTab("t2");
    release({ ok: true, formatted: "a;", cursorOffset: 0 });
    expect(await pending).toBe(false);
    expect(applyOffsetEdits).not.toHaveBeenCalled();
  });
});
