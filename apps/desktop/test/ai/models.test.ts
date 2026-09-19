import { describe, expect, test } from "bun:test";
import { AI_PROVIDERS } from "@jslab/shared";
import { AI_MODEL_MANIFEST, missingManifestProviders, resolveBaseUrl, resolveModel } from "../../src/main/ai/models";

describe("the AI model manifest (spec §14.3)", () => {
  /**
   * The manifest is keyed by provider and read with `AI_MODEL_MANIFEST[provider]`, so a missing entry surfaces
   * as `undefined.defaultModel` at the moment a user first selects that provider -- which is the worst possible
   * time to find out. Totality is checked here instead.
   */
  test("every provider in the seam has a default model and base URL", () => {
    expect(missingManifestProviders()).toEqual([]);
    expect(Object.keys(AI_MODEL_MANIFEST).sort()).toEqual([...AI_PROVIDERS].sort());
  });

  test("a blank model setting resolves to the manifest's default, and a set one wins", () => {
    // Anchored to the literal the manifest actually ships, not to `AI_MODEL_MANIFEST.ollama.defaultModel` --
    // reading the default back out of the manifest would pass for any value, including an empty string.
    expect(resolveModel("ollama", "")).toBe("qwen2.5:7b-instruct");
    expect(resolveModel("ollama", "   ")).toBe("qwen2.5:7b-instruct");
    expect(resolveModel("ollama", "mistral:latest")).toBe("mistral:latest");
    expect(resolveModel("ollama", "  mistral:latest  ")).toBe("mistral:latest");
  });

  test("a blank base URL resolves to the provider's standard endpoint (spec §8)", () => {
    expect(resolveBaseUrl("ollama", "")).toBe("http://localhost:11434");
    expect(resolveBaseUrl("ollama", "http://192.168.1.9:11434")).toBe("http://192.168.1.9:11434");
  });

  /**
   * Adapters build `${baseUrl}/api/chat`, so a base URL the user pasted with a trailing slash would otherwise
   * produce `http://host:11434//api/chat`. Ollama happens to tolerate that; not every provider does.
   */
  test("trailing slashes are dropped so the adapter's path join cannot double up", () => {
    expect(resolveBaseUrl("ollama", "http://localhost:11434/")).toBe("http://localhost:11434");
    expect(resolveBaseUrl("ollama", "http://localhost:11434///")).toBe("http://localhost:11434");
  });
});
