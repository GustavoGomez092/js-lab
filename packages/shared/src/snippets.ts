import { z } from "zod";
import { LANGUAGES, type Language } from "./settings";

/** Spec §13.4: the `format` discriminator of an exported library. */
export const SNIPPETS_FORMAT = "jslab-snippets";
/** Spec §13.4: the current file version. Bumping it means adding a SNIPPET_MIGRATIONS entry. */
export const SNIPPETS_VERSION = 1;

export const MAX_SNIPPETS = 2000;
export const MAX_SNIPPET_NAME_CHARS = 100;
export const MAX_SNIPPET_DESCRIPTION_CHARS = 200;
export const MAX_SNIPPET_BODY_CHARS = 20_000;

/** Spec §13.1: the name is the autocomplete trigger, and must match this exactly. */
export const SNIPPET_NAME_PATTERN = /^[\w$-]+$/;

export function isValidSnippetName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_SNIPPET_NAME_CHARS && SNIPPET_NAME_PATTERN.test(name);
}

/**
 * Ruling R-M5b-9: an opaque safe string, not a strict UUID. JSLab mints UUIDs itself, but a hand-authored or
 * hand-edited library must not be refused over a cosmetic field -- and it cannot alias an existing record either,
 * because `mergeSnippets` always issues a fresh id for anything it adds.
 */
const snippetId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_-]+$/);

/** An ISO timestamp, checked by parsing rather than by pattern, so any spelling Date understands round-trips. */
const isoTimestamp = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => Number.isFinite(Date.parse(value)), { message: "not an ISO 8601 timestamp" });

/** Spec §13.4. Unknown keys are dropped rather than rejected, so a newer build's extra field can't smuggle anything in. */
export const snippetSchema = z.object({
  id: snippetId,
  name: z.string().min(1).max(MAX_SNIPPET_NAME_CHARS).regex(SNIPPET_NAME_PATTERN),
  description: z.string().max(MAX_SNIPPET_DESCRIPTION_CHARS),
  body: z.string().max(MAX_SNIPPET_BODY_CHARS),
  language: z.enum(LANGUAGES).nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export type Snippet = z.infer<typeof snippetSchema>;

export const snippetsFileSchema = z.object({
  format: z.literal(SNIPPETS_FORMAT),
  version: z.number().int().min(1),
  snippets: z.array(snippetSchema).max(MAX_SNIPPETS),
});

export function newSnippet(
  fields: { name: string; description?: string; body: string; language?: Language | null },
  now: () => string = () => new Date().toISOString(),
  newId: () => string = () => crypto.randomUUID(),
): Snippet {
  const at = now();
  return {
    id: newId(),
    name: fields.name,
    description: (fields.description ?? "").trim(),
    body: fields.body,
    language: fields.language ?? null,
    createdAt: at,
    updatedAt: at,
  };
}

export type SnippetsFileReason =
  | "notObject"
  | "wrongFormat"
  | "newerVersion"
  | "invalidSnippets"
  | "duplicateNames"
  | "duplicateIds";

export type SnippetsFileResult =
  | { ok: true; snippets: Snippet[] }
  | { ok: false; reason: SnippetsFileReason; detail: string };

const key = (name: string) => name.toLowerCase();

/**
 * Spec §13.4. Every failure is a value, never an exception: this runs on a file the user picked, which may have been
 * hand-edited or come from anywhere (ruling R-M5b-8). Nothing here touches the stored library.
 */
export function parseSnippetsFile(input: unknown): SnippetsFileResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, reason: "notObject", detail: "The file's top level isn't a JSON object." };
  }
  const record = input as Record<string, unknown>;
  if (record.format !== SNIPPETS_FORMAT) {
    return {
      ok: false,
      reason: "wrongFormat",
      detail: `Expected "format": "${SNIPPETS_FORMAT}", found ${JSON.stringify(record.format ?? null)}.`,
    };
  }
  if (typeof record.version === "number" && record.version > SNIPPETS_VERSION) {
    return {
      ok: false,
      reason: "newerVersion",
      detail: `This file is version ${record.version}; this JSLab reads version ${SNIPPETS_VERSION}.`,
    };
  }
  const parsed = snippetsFileSchema.safeParse(record);
  if (!parsed.success) {
    return { ok: false, reason: "invalidSnippets", detail: parsed.error.issues[0]?.message ?? "Invalid snippets." };
  }
  const { snippets } = parsed.data;
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const snippet of snippets) {
    if (names.has(key(snippet.name))) {
      return { ok: false, reason: "duplicateNames", detail: `Two snippets are named "${snippet.name}".` };
    }
    if (ids.has(snippet.id)) {
      return { ok: false, reason: "duplicateIds", detail: `Two snippets share the id "${snippet.id}".` };
    }
    names.add(key(snippet.name));
    ids.add(snippet.id);
  }
  return { ok: true, snippets };
}

/** The exact bytes of an exported or saved library (spec §13.4), newline-terminated like every other JSLab file. */
export function snippetsFileContent(snippets: readonly Snippet[]): string {
  return `${JSON.stringify({ format: SNIPPETS_FORMAT, version: SNIPPETS_VERSION, snippets }, null, 2)}\n`;
}

export type ConflictPolicy = "overwrite" | "keepBoth" | "skip";

/** `base`, else `base-2`, `base-3`, … -- all still matching SNIPPET_NAME_PATTERN, since `-` is in it. */
export function uniqueSnippetName(existing: readonly Snippet[], base: string): string {
  const taken = new Set(existing.map((snippet) => key(snippet.name)));
  if (!taken.has(key(base))) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(key(candidate))) return candidate;
  }
}

export interface MergeResult {
  snippets: Snippet[];
  added: number;
  overwritten: number;
  skipped: number;
  renamed: number;
}

/**
 * Spec §13.1: "Import… (merge; name conflicts get an overwrite, keep both, or skip choice)". Conflicts are decided by
 * name, case-insensitively (ruling R-M5b-9), and an overwrite keeps the existing record's id and createdAt so the
 * library's own identity is stable; everything added gets a fresh id, so an imported file can never claim one.
 */
export function mergeSnippets(
  existing: readonly Snippet[],
  incoming: readonly Snippet[],
  policy: ConflictPolicy,
  newId: () => string = () => crypto.randomUUID(),
): MergeResult {
  const snippets = [...existing];
  let added = 0;
  let overwritten = 0;
  let skipped = 0;
  let renamed = 0;
  for (const candidate of incoming) {
    const index = snippets.findIndex((snippet) => key(snippet.name) === key(candidate.name));
    if (index >= 0) {
      const current = snippets[index];
      if (!current) continue;
      if (policy === "skip") {
        skipped += 1;
        continue;
      }
      if (policy === "overwrite") {
        snippets[index] = {
          ...candidate,
          id: current.id,
          createdAt: current.createdAt,
          updatedAt: candidate.updatedAt,
        };
        overwritten += 1;
        continue;
      }
    }
    if (snippets.length >= MAX_SNIPPETS) continue;
    const name = index >= 0 ? uniqueSnippetName(snippets, candidate.name) : candidate.name;
    if (name !== candidate.name) renamed += 1;
    snippets.push({ ...candidate, id: newId(), name });
    added += 1;
  }
  return { snippets, added, overwritten, skipped, renamed };
}
