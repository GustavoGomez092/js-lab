import { redactRegistryUrl } from "@jslab/npm/npmrc";
import { MAX_NPM_LOG_CHARS } from "@jslab/npm/output";
import { parseInstallSpec } from "@jslab/npm/specifiers";
import type { InstalledPackage, NpmOperation, NpmSearchResult } from "@jslab/rpc-schema";
import type { TimerApi } from "../state/auto-run";
import { strings } from "../strings";

export const SEARCH_DEBOUNCE_MS = 300;
export const HIGHLIGHT_MS = 2000;
export const MAX_NPM_OPERATIONS = 50;
// R-M3-T26-IMPORT-1/LOGCAP-2: the per-operation log cap comes from @jslab/npm (never a UI-local duplicate),
// imported through the browser-safe `./output` subpath so `apps/ui` never touches the package's Node-only root.
export { MAX_NPM_LOG_CHARS };

export function visibleInstalled(installed: readonly InstalledPackage[], showTypes: boolean): InstalledPackage[] {
  return showTypes ? [...installed] : installed.filter((pkg) => !pkg.name.startsWith("@types/"));
}

/** A plain package name searches the registry; a version, range, git, URL or path spec installs on Enter. */
export function shouldSearch(query: string): boolean {
  const spec = parseInstallSpec(query);
  return spec?.kind === "registry" && spec.range === null && query.trim().length >= 2;
}

export function installTargetFor(query: string, results: readonly NpmSearchResult[]): string | null {
  const spec = parseInstallSpec(query);
  if (!spec) return null;
  if (spec.kind !== "registry" || spec.range !== null) return spec.raw;
  return results.some((result) => result.name === spec.name) ? spec.name : null;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSearchScheduler(
  search: (query: string) => void,
  timers: TimerApi = defaultTimers,
  delayMs = SEARCH_DEBOUNCE_MS,
) {
  let handle: unknown = null;
  return {
    input(query: string) {
      if (handle !== null) timers.clearTimeout(handle);
      handle = timers.setTimeout(() => {
        handle = null;
        search(query);
      }, delayMs);
    },
    cancel() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}

export function isHighlighted(lastAdded: { name: string; at: number } | null, name: string, now: number): boolean {
  return lastAdded?.name === name && now - lastAdded.at < HIGHLIGHT_MS;
}

/** R26-1: true when the leading integer differs, or the major is 0 and the minor differs. Parses `^(\d+)\.(\d+)`. */
export function isMajorUpdate(current: string | null, latest: string | null): boolean {
  const parse = (value: string | null) => value?.match(/^(\d+)\.(\d+)/);
  const from = parse(current);
  const to = parse(latest);
  if (!from || !to) return false;
  if (from[1] !== to[1]) return true;
  return from[1] === "0" && from[2] !== to[2];
}

/** R26-1: minutes since `checkedAt`, floored and never negative. */
export function minutesSince(checkedAt: number, now: number): number {
  return Math.floor(Math.max(0, now - checkedAt) / 60_000);
}

/**
 * R26-3: the latest queued or running operation targeting `name`, or (when `hasLatest`, i.e. the row has an
 * available update) any queued or running `updateAll`, since that operation also touches every outdated row.
 * For the installed table only; a search result row uses `pendingInstallFor` instead (M-6).
 */
export function pendingFor(
  operations: readonly NpmOperation[],
  name: string,
  hasLatest = false,
): NpmOperation | undefined {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const op = operations[index];
    if (!op || (op.status !== "queued" && op.status !== "running")) continue;
    if (op.target === name || (hasLatest && op.kind === "updateAll")) return op;
  }
  return undefined;
}

/** M-6: the package name an install spec targets, so `zod@4.6.4` still counts as `zod`. Git/URL specs pass through. */
export function specName(spec: string): string {
  const parsed = parseInstallSpec(spec);
  return parsed?.kind === "registry" ? parsed.name : spec;
}

/**
 * M-6: a result row shows "Adding…" only for a pending *install* of this exact package (matched by name, not by
 * the literal spec string, so a versioned or ranged install still counts) — never a pending update or remove
 * whose target happens to equal the name.
 */
export function pendingInstallFor(operations: readonly NpmOperation[], name: string): NpmOperation | undefined {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const op = operations[index];
    if (!op || (op.status !== "queued" && op.status !== "running")) continue;
    if (op.kind === "install" && specName(op.target) === name) return op;
  }
  return undefined;
}

/** R26-6: null while queued or running; a status-bar sentence for a finished operation, once the sheet is closed. */
export function operationStatusMessage(op: NpmOperation, runKeys: string | null): string | null {
  if (op.status === "succeeded") return strings.npm.done(op.kind, op.target, runKeys);
  if (op.status === "failed" && op.error)
    return strings.npm.doneFailed(op.kind, op.target, strings.npm.hints[op.error.kind]);
  return null;
}

// M-6 (parked, closed here): a URL-shaped substring, up to whitespace or a quote (matches redactRegistryUrl's
// contract, which parses a bare URL).
// Fix round 2 (I-2): the scheme is bounded ({0,31}); an unbounded `*` let the engine retry the whole run at
// every starting position within a long token-like run with no `://`, which is quadratic (measured: 64k chars
// took 2.2 s, 128k took 9.7 s). `git+https://tok@github.com/x` still matches (9-char scheme).
const URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s"']+/g;
// Fix round 2 (M-1): case-insensitive `_authToken`/`_auth`/`_password`, with or without a leading `//host/path:`
// npmrc-style prefix (left untouched: only the value is replaced), the JSON/colon form (`"_authToken": "…"`),
// and a single- or double-quoted value that may itself contain spaces. `_authToken` stays ahead of `_auth` so
// the longer key wins. No nested quantifiers over the same class, so this stays linear-time.
const AUTH_VALUE_PATTERN = /(_authToken|_auth|_password)(["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|\S+)/gi;
// Fix round 2 (M-1): an HTTP Authorization header value (Bearer or Basic token), case-insensitive.
const AUTHORIZATION_HEADER_PATTERN = /(authorization:\s*(?:bearer|basic)\s+)(\S+)/gi;
// Fix round 2 (M-1): when a URL-shaped match doesn't actually get its credentials stripped by `redactRegistryUrl`
// (for example a quote inside the password stops the URL_PATTERN match short, so it never parses as a full URL),
// this catches any remaining `//<userinfo>@` fragment directly. A no-op on an already-redacted URL, which has no
// more `@` between `//` and the next `/`. A single negated-class scan, so it stays linear-time.
const USERINFO_FALLBACK_PATTERN = /\/\/[^@\s/]*@/g;

/**
 * R-M3-T26-M6-1 (parked M-6), extended in fix round 2 (I-2, M-1): masks registry credentials before a log
 * reaches the store, the drawer or Copy Log. `redactRegistryUrl` (spec §11.5) already strips URL userinfo with
 * no separate "marker" text, so a masked value elsewhere uses the same no-marker convention: `***`. Never
 * throws. Every pass here is linear-time (bounded quantifiers, or a single unambiguous scan) — see I-2.
 */
export function maskCredentials(text: string): string {
  try {
    const withoutUrlCredentials = text.replace(URL_PATTERN, (match) => redactRegistryUrl(match));
    const withoutUserinfo = withoutUrlCredentials.replace(USERINFO_FALLBACK_PATTERN, "//***@");
    const withoutAuthValues = withoutUserinfo.replace(
      AUTH_VALUE_PATTERN,
      (_full, key: string, separator: string, value: string) => {
        const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : "";
        return `${key}${separator}${quote}***${quote}`;
      },
    );
    return withoutAuthValues.replace(AUTHORIZATION_HEADER_PATTERN, (_full, prefix: string) => `${prefix}***`);
  } catch {
    return text;
  }
}

/** Fix round 2 (I-1): past this many carried characters, flush anyway rather than wait indefinitely for a boundary. */
export const LOG_CARRY_BOUND_CHARS = 4096;

const isBoundaryChar = (ch: string): boolean =>
  ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\v";

/**
 * Fix round 2 (I-1): Main forwards every pipe read as its own `npm.log` chunk, so a credential can split across
 * two chunks anywhere. Splits `pending` (the previous carry plus the new chunk) into a `ready` prefix — up to
 * and including the last whitespace/newline, safe to mask and store now — and the unmasked `carry` remainder to
 * hold until the next chunk completes it. When there's no boundary, or the remainder itself would exceed
 * `LOG_CARRY_BOUND_CHARS`, the whole thing is treated as if it ended at a boundary instead of waiting forever.
 */
export function splitLogChunk(pending: string): { ready: string; carry: string } {
  let boundary = -1;
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const ch = pending[index];
    if (ch !== undefined && isBoundaryChar(ch)) {
      boundary = index;
      break;
    }
  }
  const ready = boundary === -1 ? "" : pending.slice(0, boundary + 1);
  const carry = boundary === -1 ? pending : pending.slice(boundary + 1);
  return carry.length > LOG_CARRY_BOUND_CHARS ? { ready: ready + carry, carry: "" } : { ready, carry };
}
