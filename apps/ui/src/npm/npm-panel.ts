import { lastLineBreakEnd, maskCredentials } from "@jslab/npm/mask";
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
// R-M3-T26-FIX-3: the one masker lives in @jslab/npm (shared with Main); re-exported for existing UI imports.
export { MAX_NPM_LOG_CHARS, maskCredentials };

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

/**
 * R26-6: null while queued or running; a status-bar sentence for a finished operation, once the sheet is closed.
 * Fix round 3 (R-1): the caller passes Main's own operation, whose target may carry a credential, so the target is
 * masked here; that covers the status bar and the E2E snapshot's `statusMessage`.
 */
export function operationStatusMessage(op: NpmOperation, runKeys: string | null): string | null {
  const target = maskCredentials(op.target);
  if (op.status === "succeeded") return strings.npm.done(op.kind, target, runKeys);
  if (op.status === "failed" && op.error)
    return strings.npm.doneFailed(op.kind, target, strings.npm.hints[op.error.kind]);
  return null;
}

/**
 * Fix round 3 (NI-1, NI-2): defense in depth behind Main's per-stream line masking. Credentials can contain
 * whitespace (`Authorization: Bearer <token>`, `_auth = <value>`), so the carry holds only the text after the last
 * line break (`\n` or `\r`), never after whitespace. `ready` is `carry` plus the new text through its last line
 * break (complete lines, safe to mask as a whole); the remainder becomes the new carry. `carry` never holds a line
 * break, so only `text` is scanned. A remainder past MAX_NPM_LOG_CHARS is returned whole in `ready` (masked as one
 * piece by the caller, never appended raw): a credential is split only by a single line longer than 64,000
 * characters, which is accepted.
 */
export function splitLogChunk(carry: string, text: string): { ready: string; carry: string } {
  const breakEnd = lastLineBreakEnd(text);
  const ready = breakEnd === -1 ? "" : carry + text.slice(0, breakEnd);
  const rest = breakEnd === -1 ? carry + text : text.slice(breakEnd);
  return rest.length > MAX_NPM_LOG_CHARS ? { ready: ready + rest, carry: "" } : { ready, carry: rest };
}
