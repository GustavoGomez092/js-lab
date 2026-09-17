import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { readBoundedTextSync } from "../files/bounded-read";
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
    // `path` must always be assigned, even if the folder can't be created (I-2): a constructor failure falls
    // back to console-only logging (via write()'s own append-failure retry below) instead of throwing into Main.
    this.path = join(options.dir, options.fileName ?? "main.log");
    try {
      mkdirSync(options.dir, { recursive: true });
      this.#size = existsSync(this.path) ? statSync(this.path).size : 0;
    } catch {
      this.#size = 0;
    }
  }

  write(level: LogLevel, message: string, detail?: unknown): void {
    if (level === "debug" && !this.options.debug) return;
    const raw = `${(this.options.now ?? (() => new Date()))().toISOString()} ${level.toUpperCase()} ${message}${formatDetail(detail)}`;
    const line = `${(this.options.redact ?? ((text: string) => text))(raw)}\n`;
    const bytes = Buffer.byteLength(line);
    // Every filesystem operation below (including rotation) is guarded: logging must never throw into Main,
    // whatever goes wrong on disk (I-2).
    try {
      if (this.#size > 0 && this.#size + bytes > (this.options.maxBytes ?? 5 * 1024 * 1024)) this.#rotate();
    } catch {
      // A rotation failure (a rotated slot replaced by something unwritable, for example) must not stop logging;
      // the live file just keeps growing past maxBytes instead of throwing.
    }
    this.#append(line, bytes);
    (this.options.echo ?? ((text: string) => console.error(text)))(line.trimEnd());
  }

  /** Appends one line, recreating a deleted logs folder and retrying once before giving up silently (I-2). */
  #append(line: string, bytes: number): void {
    try {
      appendFileSync(this.path, line);
      this.#size += bytes;
      return;
    } catch {
      // Falls through to the recovery attempt below.
    }
    try {
      mkdirSync(this.options.dir, { recursive: true });
      appendFileSync(this.path, line);
      this.#size += bytes;
    } catch {
      // Give up silently; the caller still echoes the line to the console below.
    }
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
      // A missing live file (deleted from under us, or not yet created) must not stop reading older rotated
      // files behind it (I-2): continue past it rather than breaking out of the loop.
      if (!existsSync(file)) continue;
      // Bounded by this log's own rotation size -- the one number that says how big a file this class intends to
      // produce. A file past it is one whose rotation has been failing (see `write`, which keeps appending rather
      // than throwing), and the debug report reads the older, bounded slots instead of pulling an unbounded file
      // into Main. `readFileSync` here would block Main's thread outright on a FIFO left at a log path.
      let text: string;
      try {
        text = readBoundedTextSync(file, this.options.maxBytes ?? 5 * 1024 * 1024);
      } catch {
        continue;
      }
      lines.unshift(...text.split("\n").filter(Boolean));
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
