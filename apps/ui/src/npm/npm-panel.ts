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

/** R26-6: null while queued or running; a status-bar sentence for a finished operation, once the sheet is closed. */
export function operationStatusMessage(op: NpmOperation, runKeys: string | null): string | null {
  if (op.status === "succeeded") return strings.npm.done(op.kind, op.target, runKeys);
  if (op.status === "failed" && op.error)
    return strings.npm.doneFailed(op.kind, op.target, strings.npm.hints[op.error.kind]);
  return null;
}

// M-6 (parked, closed here): a URL-shaped substring, up to whitespace or a quote (matches redactRegistryUrl's
// contract, which parses a bare URL). No nested quantifiers, so this stays linear-time.
const URL_PATTERN = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']+/g;
// `_authToken`, `_auth` and `_password` values, with or without a leading `//host/path:` npmrc-style prefix
// (left untouched, since only the value after `=` is replaced) and optional spaces around `=`.
const AUTH_VALUE_PATTERN = /(_authToken|_auth|_password)(\s*=\s*)(\S+)/g;

/**
 * R-M3-T26-M6-1 (parked M-6): masks registry credentials before a log reaches the store, the drawer or Copy Log.
 * `redactRegistryUrl` (spec §11.5) already strips URL userinfo with no separate "marker" text, so an `_authToken`/
 * `_auth`/`_password` value (which isn't itself a URL) is masked with the same no-marker convention: `***`.
 * Never throws; both passes are single, non-backtracking regex scans.
 */
export function maskCredentials(text: string): string {
  try {
    const withoutUrlCredentials = text.replace(URL_PATTERN, (match) => {
      try {
        return redactRegistryUrl(match);
      } catch {
        return match;
      }
    });
    return withoutUrlCredentials.replace(AUTH_VALUE_PATTERN, (_full, key: string, eq: string) => `${key}${eq}***`);
  } catch {
    return text;
  }
}
