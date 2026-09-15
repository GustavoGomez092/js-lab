import {
  type EnvVars,
  MAX_DOTENV_BYTES,
  MAX_ENV_VALUE_CHARS,
  MAX_ENV_VARS,
  parseDotenv,
  validateEnvRows as validateEnvRowsBase,
} from "@jslab/shared";

export interface EnvRow {
  id: number;
  key: string;
  value: string;
  revealed: boolean;
}

/**
 * Extends Task 4's `EnvRowError` union with the client-side limit checks R-M3-T25-SAVE-1 requires
 * (`@jslab/shared`'s `envVarsSchema` enforces `MAX_ENV_VARS`/`MAX_ENV_VALUE_CHARS` server-side, but its
 * `validateEnvRows` helper doesn't check either, so a save that exceeds them would otherwise only fail
 * after a round trip to Main). Named distinctly from the shared `EnvRowError`/`validateEnvRows` (fix round 1,
 * N-1) so an editor's auto-import can't silently pick the narrower shared one and lose the limit checks.
 * `tooMany` isn't a per-row error: it carries a sentinel `index: -1`, since it's rendered at the sheet level,
 * never against a specific row (fix round 1, M-5).
 */
export type EnvTableError = { index: number; error: "invalidKey" | "duplicateKey" | "tooMany" | "valueTooLong" };

const nextId = (rows: readonly EnvRow[]) => rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;

export function rowsFromVariables(variables: EnvVars): EnvRow[] {
  return Object.entries(variables).map(([key, value], index) => ({ id: index + 1, key, value, revealed: false }));
}

export function addEnvRow(rows: readonly EnvRow[], key: string, value: string): EnvRow[] {
  return [...rows, { id: nextId(rows), key: key.trim(), value, revealed: false }];
}

export function updateEnvRow(
  rows: readonly EnvRow[],
  id: number,
  patch: Partial<Pick<EnvRow, "key" | "value" | "revealed">>,
): EnvRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

export function removeEnvRow(rows: readonly EnvRow[], id: number): EnvRow[] {
  return rows.filter((row) => row.id !== id);
}

const PASTE_LINE = /^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/;

/**
 * R25-3: paste a `.env` block into New key. Returns null for plain text that isn't a dotenv line (so an
 * ordinary pasted value doesn't get silently reinterpreted), for text over `MAX_DOTENV_BYTES` (fix round 1,
 * I-1: `parseDotenv`'s own quadratic worst case on an unterminated quote must never run on an oversized
 * paste), and for text that parses to zero entries (fix round 1, M-4: a multi-line value that merely
 * contains a newline must fall through to a normal paste, not silently vanish). Existing keys are never
 * overwritten: duplicates are appended, and R25-4's in-place duplicate error shows on Save.
 */
export function rowsFromPaste(rows: readonly EnvRow[], text: string): EnvRow[] | null {
  if (!text.includes("\n") && !PASTE_LINE.test(text)) return null;
  if (new TextEncoder().encode(text).length > MAX_DOTENV_BYTES) return null;
  const parsed = Object.entries(parseDotenv(text));
  if (parsed.length === 0) return null;
  let next: EnvRow[] = [...rows];
  for (const [key, value] of parsed) {
    next = addEnvRow(next, key, value);
  }
  return next;
}

/**
 * Validates the Environment Variables table before Save (spec §12.1). A pending input row counts, same as
 * the base validator. Also rejects (R-M3-T25-SAVE-1) more than `MAX_ENV_VARS` rows with a key, and a value
 * longer than `MAX_ENV_VALUE_CHARS` — the two server-side limits the base `validateEnvRows` doesn't check.
 * Every error a row has is reported (fix round 1, M-5): a row can carry both a key error and a value error
 * at once, and the caller renders each against its own input.
 */
export function validateEnvTable(
  rows: readonly { key: string; value: string }[],
): { ok: true; variables: EnvVars } | { ok: false; errors: EnvTableError[] } {
  const limitErrors: EnvTableError[] = [];
  rows.forEach((row, index) => {
    if (row.value.length > MAX_ENV_VALUE_CHARS) limitErrors.push({ index, error: "valueTooLong" });
  });
  const withKeys = rows.filter((row) => row.key.trim().length > 0).length;
  if (withKeys > MAX_ENV_VARS) limitErrors.push({ index: -1, error: "tooMany" });

  const base = validateEnvRowsBase(rows);
  if (base.ok) return limitErrors.length > 0 ? { ok: false, errors: limitErrors } : base;
  return { ok: false, errors: [...base.errors, ...limitErrors] };
}
