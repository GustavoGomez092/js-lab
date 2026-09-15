import {
  type LocalTypesResult,
  localTypesParamsSchema,
  type PackageTypesResult,
  packageTypesParamsSchema,
} from "@jslab/rpc-schema";
import type { TypesService } from "../services/types-service";
import { createValidators, type Log } from "./validate";

export interface TypesHandlerDeps {
  types: Pick<TypesService, "packages" | "local">;
  log: Log;
}

/** The editor's type feeder (spec §6.2). */
export function createTypesHandlers(deps: TypesHandlerDeps) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      "types.package": (input: unknown): Promise<{ packages: PackageTypesResult[] }> => {
        const { tabId, packages } = parse(packageTypesParamsSchema, "types.package", input);
        return deps.types.packages(tabId, packages).then((results) => ({ packages: results }));
      },
      "types.local": (input: unknown): Promise<LocalTypesResult> => {
        const { tabId, specifiers } = parse(localTypesParamsSchema, "types.local", input);
        return deps.types.local(tabId, specifiers);
      },
    },
    messages: {},
  };
}
