import { type TransformOptions, transform } from "@jslab/transform";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ id: number; source: string; options: TransformOptions }>) => {
  const { id, source, options } = event.data;
  try {
    self.postMessage({ id, result: transform(source, options) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
