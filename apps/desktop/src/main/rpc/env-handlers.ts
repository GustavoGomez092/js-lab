import { type EnvVars, emptyParamsSchema, envSaveParamsSchema, type SaveResult } from "@jslab/rpc-schema";
import type { EnvStore } from "../services/env-store";
import { createValidators, type Log } from "./validate";

export interface EnvHandlerDeps {
  env: Pick<EnvStore, "variables" | "save">;
  log: Log;
}

/** Tools → Environment Variables… (spec §12.1). Values are never logged. */
export function createEnvHandlers(deps: EnvHandlerDeps) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      "env.get": (input: unknown): { variables: EnvVars } => {
        parse(emptyParamsSchema, "env.get", input);
        return { variables: deps.env.variables };
      },
      "env.save": (input: unknown): Promise<SaveResult> => {
        const { variables } = parse(envSaveParamsSchema, "env.save", input);
        return deps.env.save(variables).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        );
      },
    },
    messages: {},
  };
}
