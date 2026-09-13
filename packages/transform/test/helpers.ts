import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "../src/transform";
import type { TransformOptions } from "../src/types";

export const baseOptions: TransformOptions = {
  language: "typescript",
  autoLog: true,
  loopProtection: true,
  loopProtectionMaxIterations: 2000,
  logpoints: [],
};

export interface Call {
  kind: "log" | "mc";
  line: number;
  value: unknown;
}

export async function runInstrumented(source: string, options: Partial<TransformOptions> = {}) {
  const result = transform(source, { ...baseOptions, ...options });
  if (!result.ok) throw new Error(`transform failed: ${result.diagnostics[0]?.message}`);
  const calls: Call[] = [];
  (globalThis as Record<string, unknown>).__jl = {
    log(line: number, value: unknown) {
      calls.push({ kind: "log", line, value });
      return value;
    },
    mc(line: number, _column: number, value: unknown, format?: (v: unknown) => unknown) {
      calls.push({ kind: "mc", line, value: format ? format(value) : value });
      return value;
    },
  };
  const file = join(tmpdir(), `jslab-transform-${crypto.randomUUID()}.mjs`);
  await Bun.write(file, result.code);
  try {
    await import(file);
  } finally {
    await unlink(file);
  }
  return { calls, result };
}
