import type { CommandId } from "@jslab/shared";
import type { AppStore, OutputFilter } from "../state/store";
import type { CommandSpec } from "./registry";

const FILTER_COMMANDS: [CommandId, OutputFilter][] = [
  ["output.showAll", "all"],
  ["output.showResults", "results"],
  ["output.showLogs", "logs"],
  ["output.showErrors", "errors"],
];

export function createOutputCommands(store: AppStore): CommandSpec[] {
  return FILTER_COMMANDS.map(([id, filter]) => ({ id, run: () => store.getState().setOutputFilter(filter) }));
}
