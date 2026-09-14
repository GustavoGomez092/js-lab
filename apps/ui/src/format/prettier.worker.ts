import { formatCode } from "./format-core";
import type { PrettierFormatOptions } from "./prettier-options";

interface FormatRequest {
  id: number;
  code: string;
  options: PrettierFormatOptions;
  cursorOffset: number;
}

self.onmessage = async (event: MessageEvent<FormatRequest>) => {
  const { id, code, options, cursorOffset } = event.data;
  self.postMessage({ id, ...(await formatCode(code, options, cursorOffset)) });
};
