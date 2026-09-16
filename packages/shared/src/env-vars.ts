import { z } from "zod";

/** Spec §12.1: keys match this pattern and are unique; values are strings. */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_VARS = 500;
export const MAX_ENV_KEY_CHARS = 256;
export const MAX_ENV_VALUE_CHARS = 32_768;

export type EnvVars = Record<string, string>;

export const envVarsSchema = z
  .record(z.string().max(MAX_ENV_KEY_CHARS).regex(ENV_KEY_PATTERN), z.string().max(MAX_ENV_VALUE_CHARS))
  .refine((variables) => Object.keys(variables).length <= MAX_ENV_VARS, {
    message: `At most ${MAX_ENV_VARS} environment variables`,
  });

/** `env.json` (spec §4.5, §12.1). */
export const envFileSchema = z.object({ version: z.literal(1), variables: envVarsSchema });

export type EnvRowError = { index: number; error: "invalidKey" | "duplicateKey" };

/** Validates the Environment Variables table before Save (spec §12.1). Keys are trimmed. */
export function validateEnvRows(
  rows: readonly { key: string; value: string }[],
): { ok: true; variables: EnvVars } | { ok: false; errors: EnvRowError[] } {
  const errors: EnvRowError[] = [];
  const seen = new Set<string>();
  const variables: EnvVars = {};
  rows.forEach((row, index) => {
    const key = row.key.trim();
    if (key.length > MAX_ENV_KEY_CHARS || !ENV_KEY_PATTERN.test(key)) {
      errors.push({ index, error: "invalidKey" });
      return;
    }
    if (seen.has(key)) {
      errors.push({ index, error: "duplicateKey" });
      return;
    }
    seen.add(key);
    variables[key] = row.value;
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, variables };
}
