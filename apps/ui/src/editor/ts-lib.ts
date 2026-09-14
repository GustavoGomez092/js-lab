/**
 * TypeScript `lib` for every editor model. `dom` declares `console`, timers and `fetch`.
 * M3's type feeder (spec §6.1–6.2) replaces this with per-runtime libs plus bundled bun-types/@types/node.
 */
export const EDITOR_TS_LIB: readonly string[] = ["esnext", "dom", "dom.iterable"];
