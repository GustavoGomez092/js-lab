import {
  type EnvVars,
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
 * after a round trip to Main).
 */
export type EnvRowError = { index: number; error: "invalidKey" | "duplicateKey" | "tooMany" | "valueTooLong" };

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
 * R25-3: paste a `.env` block into New key. Returns null for plain text that isn't a dotenv line, so an
 * ordinary pasted value doesn't get silently reinterpreted. Existing keys are never overwritten: duplicates
 * are appended, and R25-4's in-place duplicate error shows on Save.
 */
export function rowsFromPaste(rows: readonly EnvRow[], text: string): EnvRow[] | null {
  if (!text.includes("\n") && !PASTE_LINE.test(text)) return null;
  let next: EnvRow[] = [...rows];
  for (const [key, value] of Object.entries(parseDotenv(text))) {
    next = addEnvRow(next, key, value);
  }
  return next;
}

/**
 * Validates the Environment Variables table before Save (spec §12.1). A pending input row counts, same as
 * the base validator. Also rejects (R-M3-T25-SAVE-1) more than `MAX_ENV_VARS` rows with a key, and a value
 * longer than `MAX_ENV_VALUE_CHARS` — the two server-side limits the base `validateEnvRows` doesn't check.
 */
export function validateEnvRows(
  rows: readonly { key: string; value: string }[],
): { ok: true; variables: EnvVars } | { ok: false; errors: EnvRowError[] } {
  const limitErrors: EnvRowError[] = [];
  rows.forEach((row, index) => {
    if (row.value.length > MAX_ENV_VALUE_CHARS) limitErrors.push({ index, error: "valueTooLong" });
  });
  const withKeys = rows.filter((row) => row.key.trim().length > 0).length;
  if (withKeys > MAX_ENV_VARS) limitErrors.push({ index: rows.length - 1, error: "tooMany" });

  const base = validateEnvRowsBase(rows);
  if (base.ok) return limitErrors.length > 0 ? { ok: false, errors: limitErrors } : base;
  return { ok: false, errors: [...base.errors, ...limitErrors] };
}
