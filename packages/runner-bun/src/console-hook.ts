import type { ConsoleLevel, EncodedValue, GeneratedPosition, RawRunEventBody } from "@jslab/rpc-schema";
import { parseStack } from "@jslab/serializer";

export interface ConsoleSink {
  push(body: RawRunEventBody): number | null;
  encode(value: unknown): EncodedValue;
  entryBase(): string | null;
}

export function callSite(stack: string | undefined, entryBase: string | null): GeneratedPosition | undefined {
  if (!entryBase) return undefined;
  const frame = parseStack(stack ?? "").find((f) => f.file?.endsWith(entryBase));
  return frame?.line ? { line: frame.line, column: frame.column ?? 1 } : undefined;
}

export function installConsole(sink: ConsoleSink, target: Console = console): void {
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
      args: args.map((a) => sink.encode(a)),
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
}

export function installStdio(push: (kind: "stdout" | "stderr", text: string) => void): void {
  for (const kind of ["stdout", "stderr"] as const) {
    const stream = process[kind];
    stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      push(kind, typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") cb();
      return true;
    }) as typeof stream.write;
  }
}
