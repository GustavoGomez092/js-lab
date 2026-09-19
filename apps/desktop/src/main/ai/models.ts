import { AI_PROVIDERS, type AiProvider, type Settings } from "@jslab/shared";
import manifest from "./models.json";

/**
 * The per-provider defaults (spec §14.3: "The default model per provider comes from
 * `apps/desktop/src/main/ai/models.json`, which is updated each release").
 *
 * A JSON file rather than a TypeScript constant because the spec names that path, and because a release process
 * that has to edit a `.ts` file to bump a model name is one that will eventually edit code by accident. It is a
 * static import, so the bundler inlines it into Main's compiled output -- there is no file read at runtime, and
 * therefore no path that can be missing from the app bundle.
 */
export interface ProviderDefaults {
  /** The model used when `ai.model.<provider>` is blank. */
  defaultModel: string;
  /** The endpoint used when `ai.baseUrl.<provider>` is blank (spec §8: "Blank = the provider's standard endpoint"). */
  defaultBaseUrl: string;
}

/**
 * Typed as a total map over `AI_PROVIDERS` and CHECKED below, rather than asserted. A manifest missing a provider
 * would otherwise surface as `undefined.defaultModel` at the moment a user first selects that provider.
 */
export const AI_MODEL_MANIFEST = manifest as Record<AiProvider, ProviderDefaults>;

/** Which providers the manifest is missing, if any. Empty in a correct build; `models.test.ts` pins that. */
export function missingManifestProviders(): AiProvider[] {
  return AI_PROVIDERS.filter((provider) => {
    const entry = AI_MODEL_MANIFEST[provider] as ProviderDefaults | undefined;
    return typeof entry?.defaultModel !== "string" || typeof entry?.defaultBaseUrl !== "string";
  });
}

/**
 * The model to ask for: the user's setting when they have one, otherwise the manifest's default.
 *
 * Blank is not a value here, it is the absence of one -- which is what keeps `models.json` the single owner of
 * the default (spec §14.3). Resolving it at request time rather than at settings-write time is what lets a
 * release move the default forward for every user who never overrode it.
 */
export function resolveModel(provider: AiProvider, configured: string): string {
  const trimmed = configured.trim();
  return trimmed === "" ? (AI_MODEL_MANIFEST[provider]?.defaultModel ?? "") : trimmed;
}

/** The endpoint to call, with the same blank-means-default rule (spec §8). Trailing slashes are dropped. */
export function resolveBaseUrl(provider: AiProvider, configured: string): string {
  const trimmed = configured.trim();
  const chosen = trimmed === "" ? (AI_MODEL_MANIFEST[provider]?.defaultBaseUrl ?? "") : trimmed;
  return chosen.replace(/\/+$/, "");
}

/**
 * Reads `ai.model.<provider>` / `ai.baseUrl.<provider>`.
 *
 * The section's field names really do contain a dot (spec §8 writes the key as `ai.model.ollama`), so this reads
 * the field by its composed name rather than by walking a nested object -- there is no nested object to walk.
 *
 * It lives beside `resolveModel`/`resolveBaseUrl` because it is the other half of the same job: this reads the
 * configured value, those turn a blank one into the manifest's default. TL-23's model list resolves the base URL
 * exactly as `ai.send` does, and a second private copy of this would be the seam where the two could drift.
 */
export function readProviderSetting(settings: Settings, field: "model" | "baseUrl", provider: AiProvider): string {
  const values = settings.ai as unknown as Record<string, unknown>;
  const value = values[`${field}.${provider}`];
  return typeof value === "string" ? value : "";
}
