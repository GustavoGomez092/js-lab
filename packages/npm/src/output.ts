import type { NpmErrorKind, NpmOpError, NpmSearchResult } from "@jslab/rpc-schema";
import { stripAnsi } from "./ansi";

export interface OutdatedEntry {
  name: string;
  current: string;
  update: string;
  latest: string;
}

const cellsOf = (line: string): string[] | null => {
  const separator = line.includes("│") ? "│" : line.includes("|") ? "|" : null;
  if (!separator) return null;
  const cells = line.split(separator).map((cell) => cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
};

/** Parses `bun outdated` (spec §11.3). The column order comes from the header row. */
export function parseOutdated(text: string): OutdatedEntry[] {
  const entries: OutdatedEntry[] = [];
  let columns: { name: number; current: number; update: number; latest: number } | null = null;
  for (const raw of stripAnsi(text).split("\n")) {
    const cells = cellsOf(raw);
    if (!cells || cells.every((cell) => /^[-─┼═:+\s]*$/.test(cell))) continue;
    if (!columns) {
      const index = (label: string) => cells.findIndex((cell) => cell.toLowerCase() === label);
      const found = {
        name: index("package"),
        current: index("current"),
        update: index("update"),
        latest: index("latest"),
      };
      if (found.name >= 0 && found.current >= 0 && found.latest >= 0) columns = found;
      continue;
    }
    const name = (cells[columns.name] ?? "").replace(/\s+\((?:dev|peer|optional)\)$/, "");
    if (!name) continue;
    const current = cells[columns.current] ?? "";
    const latest = cells[columns.latest] ?? "";
    entries.push({ name, current, update: columns.update >= 0 ? (cells[columns.update] ?? current) : current, latest });
  }
  return entries;
}

/** The packages a `bun add` reports as installed ("installed name@version"). */
export function parseInstalled(text: string): { name: string; version: string }[] {
  const installed: { name: string; version: string }[] = [];
  for (const match of stripAnsi(text).matchAll(/^installed ((?:@[^@\s/]+\/)?[^@\s]+)@(\S+?)(?:\s|$)/gm)) {
    installed.push({ name: match[1] as string, version: match[2] as string });
  }
  return installed;
}

export const MAX_NPM_LOG_CHARS = 64_000;

const RULES: [NpmErrorKind, RegExp][] = [
  ["disk", /ENOSPC|no space left|EACCES|EPERM|EROFS|permission denied/i],
  [
    "network",
    /ConnectionRefused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|UnableToConnect|ConnectionClosed|NetworkUnreachable|getaddrinfo|certificate/i,
  ],
  ["noMatchingVersion", /no version matching|no matching version|ETARGET/i],
  ["notFound", /\b404\b|not found|E404/i],
  ["peerConflict", /peer dep|incorrect peer|ERESOLVE|conflicting peer/i],
  ["nativeBuild", /node-gyp|gyp ERR|prebuild-install|make: \*\*\*|binding\.gyp/i],
  ["scriptBlocked", /blocked \d+ (?:pre|post)?install/i],
];

/** Spec §11.3: a failed operation's kind (for the one-line hint) and its raw log. Null for a success. */
export function classifyNpmFailure(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): NpmOpError | null {
  if (result.exitCode === 0 && !result.timedOut) return null;
  const log = stripAnsi(`${result.stdout}\n${result.stderr}`).trim().slice(-MAX_NPM_LOG_CHARS);
  if (result.timedOut) return { kind: "timeout", log };
  const kind = RULES.find(([, pattern]) => pattern.test(log))?.[0] ?? "unknown";
  return { kind, log };
}

/** A non-fatal condition on a successful operation (Bun blocks untrusted install scripts). */
export function detectNotice(result: { stdout: string; stderr: string }): NpmErrorKind | null {
  return /blocked \d+ (?:pre|post)?install/i.test(stripAnsi(`${result.stdout}\n${result.stderr}`))
    ? "scriptBlocked"
    : null;
}

/** `GET <registry>/-/v1/search` (spec §11.3). */
export function parseSearchResponse(json: unknown): NpmSearchResult[] {
  const objects = (json as { objects?: unknown })?.objects;
  if (!Array.isArray(objects)) return [];
  return objects.flatMap((object): NpmSearchResult[] => {
    const pkg = (object as { package?: Record<string, unknown> }).package;
    if (typeof pkg?.name !== "string") return [];
    const weekly = (object as { downloads?: { weekly?: unknown } }).downloads?.weekly;
    return [
      {
        name: pkg.name,
        version: typeof pkg.version === "string" ? pkg.version : "",
        description: typeof pkg.description === "string" ? pkg.description : "",
        weeklyDownloads: typeof weekly === "number" ? weekly : null,
      },
    ];
  });
}
