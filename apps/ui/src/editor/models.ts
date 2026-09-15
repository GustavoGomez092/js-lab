import type { Language } from "@jslab/shared";

export interface ModelLike {
  getValue(): string;
  setValue(value: string): void;
  dispose(): void;
}

/** One Monaco model per tab (spec §6.1). Framework-free, so it can be tested without Monaco. */
export class ModelCache<M extends ModelLike> {
  readonly #entries = new Map<string, { model: M; language: Language }>();

  constructor(private readonly create: (tabId: string, language: Language, value: string) => M) {}

  get(tabId: string): M | undefined {
    return this.#entries.get(tabId)?.model;
  }

  /** True when `ensure(tabId, language, …)` would return the existing model unchanged. */
  matches(tabId: string, language: Language): boolean {
    return this.#entries.get(tabId)?.language === language;
  }

  /**
   * Returns the tab's model; a language change creates a new one from the current content. The previous model is
   * returned undisposed: the caller attaches the new model first, then disposes it (T12-m3).
   */
  ensure(tabId: string, language: Language, value: string): { model: M; recreated: boolean; previous: M | null } {
    const entry = this.#entries.get(tabId);
    if (entry && entry.language === language) return { model: entry.model, recreated: false, previous: null };
    const model = this.create(tabId, language, entry ? entry.model.getValue() : value);
    this.#entries.set(tabId, { model, language });
    return { model, recreated: entry !== undefined, previous: entry?.model ?? null };
  }

  prune(openIds: ReadonlySet<string>): string[] {
    const removed: string[] = [];
    for (const [tabId, entry] of this.#entries) {
      if (openIds.has(tabId)) continue;
      entry.model.dispose();
      this.#entries.delete(tabId);
      removed.push(tabId);
    }
    return removed;
  }

  disposeAll(): void {
    for (const entry of this.#entries.values()) entry.model.dispose();
    this.#entries.clear();
  }
}
