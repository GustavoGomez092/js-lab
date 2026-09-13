import type { TransformOptions, TransformResult } from "@jslab/transform";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ id: number; source: string; options: TransformOptions }>) => {
  const { id, source } = event.data;
  if (source === "__exit__") {
    process.exit(1);
  }
  const result: TransformResult = {
    ok: true,
    code: source,
    map: { version: 3, sources: [], names: [], mappings: "" },
    diagnostics: [],
  };
  self.postMessage({ id, result });
};
