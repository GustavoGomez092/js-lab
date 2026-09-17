import type { ConsoleLevel, EncodedValue, GeneratedPosition, RawRunEventBody } from "@jslab/rpc-schema";
import { parseStack } from "@jslab/serializer";

// Identical to packages/runner-bun/src/console-hook.ts: nothing here is Bun-specific (`performance.now()`,
// `new Error().stack` and `parseStack` all work the same in a webview), so the web runner mirrors it verbatim.

export interface ConsoleSink {
  push(body: RawRunEventBody): number | null;
  /** Encodes one call's arguments against a shared per-event size budget (spec §5.9). */
  encodeMany(values: unknown[]): EncodedValue[];
  entryBase(): string | null;
}

export function callSite(stack: string | undefined, entryBase: string | null): GeneratedPosition | undefined {
  if (!entryBase) return undefined;
  const frame = parseStack(stack ?? "").find((f) => f.file?.endsWith(entryBase));
  return frame?.line ? { line: frame.line, column: frame.column ?? 1 } : undefined;
}

/**
 * Wraps `target`'s console methods and returns a function that clears the per-run state this keeps: the group
 * depth, the `console.count` tallies and the `console.time` timers.
 *
 * Unlike the Bun runner (where every run gets a fresh process), a webview host is deliberately never unmounted between
 * runs, so this closure really does live for the page's whole lifetime. Without the reset, an unmatched
 * `console.group()` left every later run indented, and `count`/`time` labels carried across runs.
 */
export function installConsole(sink: ConsoleSink, target: Console = console): () => void {
  let depth = 0;
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();

  const emit = (level: ConsoleLevel, args: unknown[], extra: { label?: string; withStack?: boolean } = {}) => {
    const stack = new Error().stack;
    sink.push({
      kind: "console",
      level,
      at: callSite(stack, sink.entryBase()),
      groupDepth: depth,
      args: sink.encodeMany(args),
      ...(extra.label !== undefined ? { label: extra.label } : {}),
      ...(extra.withStack
        ? { stack: parseStack(stack ?? "").filter((f) => f.file?.endsWith(sink.entryBase() ?? "\0")) }
        : {}),
    });
  };

  const elapsed = (label: string, extra: unknown[], end: boolean) => {
    const start = timers.get(label);
    if (start === undefined) {
      emit("warn", [`Timer '${label}' does not exist`]);
      return;
    }
    if (end) timers.delete(label);
    emit("time", [`${label}: ${(performance.now() - start).toFixed(3)}ms`, ...extra], { label });
  };

  Object.assign(target, {
    log: (...a: unknown[]) => emit("log", a),
    info: (...a: unknown[]) => emit("info", a),
    warn: (...a: unknown[]) => emit("warn", a),
    error: (...a: unknown[]) => emit("error", a),
    debug: (...a: unknown[]) => emit("debug", a),
    dir: (value: unknown) => emit("dir", [value]),
    dirxml: (...a: unknown[]) => emit("log", a),
    table: (data: unknown) => emit("table", [data]),
    trace: (...a: unknown[]) => emit("trace", a.length > 0 ? a : ["Trace"], { withStack: true }),
    assert: (condition?: unknown, ...a: unknown[]) => {
      if (!condition) emit("assert", a.length > 0 ? a : ["Assertion failed"]);
    },
    count: (label = "default") => {
      const n = (counts.get(label) ?? 0) + 1;
      counts.set(label, n);
      emit("count", [`${label}: ${n}`], { label });
    },
    countReset: (label = "default") => {
      counts.delete(label);
    },
    time: (label = "default") => {
      timers.set(label, performance.now());
    },
    timeLog: (label = "default", ...a: unknown[]) => elapsed(label, a, false),
    timeEnd: (label = "default") => elapsed(label, [], true),
    group: (...a: unknown[]) => {
      emit("group", a);
      depth++;
    },
    groupCollapsed: (...a: unknown[]) => {
      emit("groupCollapsed", a);
      depth++;
    },
    groupEnd: () => {
      depth = Math.max(0, depth - 1);
    },
    clear: () => {
      sink.push({ kind: "console", level: "clear", groupDepth: 0, args: [] });
    },
  });

  return () => {
    depth = 0;
    counts.clear();
    timers.clear();
  };
}
