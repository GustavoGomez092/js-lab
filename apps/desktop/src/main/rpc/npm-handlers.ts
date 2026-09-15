import {
  emptyParamsSchema,
  type NpmListResult,
  type NpmSearchResponse,
  npmInstallParamsSchema,
  npmListParamsSchema,
  npmNameParamsSchema,
  npmSearchParamsSchema,
} from "@jslab/rpc-schema";
import type { NpmService } from "../services/npm-service";
import { createValidators, type Log } from "./validate";

export interface NpmHandlerDeps {
  npm: Pick<NpmService, "install" | "remove" | "update" | "updateAll" | "list" | "search">;
  log: Log;
}

/** The NPM sheet (spec §11.2): long operations are messages; results arrive as npm.op, npm.log and npm.changed. */
export function createNpmHandlers(deps: NpmHandlerDeps) {
  const { parse, message } = createValidators(deps.log);
  return {
    requests: {
      "npm.list": (input: unknown): Promise<NpmListResult> =>
        deps.npm.list({ refreshOutdated: parse(npmListParamsSchema, "npm.list", input).refreshOutdated }),
      "npm.search": (input: unknown): Promise<NpmSearchResponse> =>
        deps.npm.search(parse(npmSearchParamsSchema, "npm.search", input).query),
    },
    messages: {
      "npm.install": message(npmInstallParamsSchema, "npm.install", ({ spec }) => void deps.npm.install(spec)),
      "npm.remove": message(npmNameParamsSchema, "npm.remove", ({ name }) => void deps.npm.remove(name)),
      "npm.update": message(npmNameParamsSchema, "npm.update", ({ name }) => void deps.npm.update(name)),
      "npm.updateAll": message(emptyParamsSchema, "npm.updateAll", () => void deps.npm.updateAll()),
    },
  };
}
