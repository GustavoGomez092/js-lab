import type * as Babel from "@babel/standalone";
import type { BuildOptions } from "./types";

export type Plugins = NonNullable<NonNullable<Parameters<typeof Babel.transform>[1]>["plugins"]>;

/** The spec §8 Build defaults. */
export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  decorators: "2023-11",
  pipelineOperator: false,
  doExpressions: false,
  throwExpressions: false,
  functionSent: false,
  regexpModifiers: true,
  optionalChainingAssign: true,
};

/** Babel 8 plugins for the enabled proposals (spec §5.4 "Enabled proposal plugins"). */
export function proposalPlugins(build: BuildOptions): Plugins {
  const plugins: Plugins = [];
  if (build.decorators !== "none") plugins.push(["proposal-decorators", { version: build.decorators }]);
  if (build.pipelineOperator) plugins.push(["proposal-pipeline-operator", { proposal: "hack", topicToken: "%" }]);
  if (build.doExpressions) plugins.push("proposal-do-expressions");
  if (build.throwExpressions) plugins.push("proposal-throw-expressions");
  if (build.functionSent) plugins.push("proposal-function-sent");
  if (build.regexpModifiers) plugins.push("transform-regexp-modifiers");
  if (build.optionalChainingAssign) plugins.push(["proposal-optional-chaining-assign", { version: "2023-07" }]);
  return plugins;
}
