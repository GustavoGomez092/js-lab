import { emptyParamsSchema } from "@jslab/rpc-schema";
import type { SystemFontsService } from "../platform/system-fonts";
import { createValidators, type Log } from "./validate";

export function createFontHandlers(deps: { fonts: Pick<SystemFontsService, "list">; log: Log }) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      "fonts.list": (input: unknown) => {
        parse(emptyParamsSchema, "fonts.list", input);
        return deps.fonts.list();
      },
    },
    messages: {},
  };
}
