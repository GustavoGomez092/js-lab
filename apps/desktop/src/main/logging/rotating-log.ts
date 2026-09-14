import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Redactor } from "./redact";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface RotatingLogOptions {
  dir: string;
  fileName?: string;
  /** Default 5 MB (spec §20). */
  maxBytes?: number;
  /** Total files kept, including the live one. Default 5. */
  maxFiles?: number;
  debug?: boolean;
  redact?: Redactor;
  /** Mirrors every line, default console.error, so dev terminals still show logs. */
  echo?: (line: string) => void;
  now?: () => Date;
}

function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === "") return "";
  if (typeof detail === "string") return ` ${detail}`;
  if (detail instanceof Error) return ` ${detail.stack ?? `${detail.name}: ${detail.message}`}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

export class RotatingLog {
  readonly path: string;
  #size: number;

  constructor(private readonly options: RotatingLogOptions) {
    mkdirSync(options.dir, { recursive: true });
    this.path = join(options.dir, options.fileName ?? "main.log");
    this.#size = existsSync(this.path) ? statSync(this.path).size : 0;
  }

  write(level: LogLevel, message: string, detail?: unknown): void {
    if (level === "debug" && !this.options.debug) return;
    const raw = `${(this.options.now ?? (() => new Date()))().toISOString()} ${level.toUpperCase()} ${message}${formatDetail(detail)}`;
    const line = `${(this.options.redact ?? ((text: string) => text))(raw)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#size > 0 && this.#size + bytes > (this.options.maxBytes ?? 5 * 1024 * 1024)) this.#rotate();
    try {
      appendFileSync(this.path, line);
      this.#size += bytes;
    } catch {
      // Logging must never crash Main; a full disk is reported by the toast path (spec §20).
    }
    (this.options.echo ?? ((text: string) => console.error(text)))(line.trimEnd());
  }

  error(message: string, detail?: unknown): void {
    this.write("error", message, detail);
  }

  warn(message: string, detail?: unknown): void {
    this.write("warn", message, detail);
  }

  info(message: string, detail?: unknown): void {
    this.write("info", message, detail);
  }

  debug(message: string, detail?: unknown): void {
    this.write("debug", message, detail);
  }

  /** The newest `count` lines, reading into rotated files when the live file is short. */
  tail(count = 500): string[] {
    const lines: string[] = [];
    const maxFiles = this.options.maxFiles ?? 5;
    for (let index = 0; index < maxFiles && lines.length < count; index++) {
      const file = index === 0 ? this.path : `${this.path}.${index}`;
      if (!existsSync(file)) break;
      const fileLines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      lines.unshift(...fileLines);
    }
    return lines.slice(-count);
  }

  #rotate(): void {
    const maxFiles = this.options.maxFiles ?? 5;
    rmSync(`${this.path}.${maxFiles - 1}`, { force: true });
    for (let index = maxFiles - 2; index >= 1; index--) {
      if (existsSync(`${this.path}.${index}`)) renameSync(`${this.path}.${index}`, `${this.path}.${index + 1}`);
    }
    if (existsSync(this.path)) renameSync(this.path, `${this.path}.1`);
    this.#size = 0;
  }
}
