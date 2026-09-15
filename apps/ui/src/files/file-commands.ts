import type { MainApi } from "../api";
import type { CommandSpec } from "../commands/registry";
import type { FileFlows } from "./file-flows";

export function createFileCommands(flows: FileFlows, api: Pick<MainApi, "appCommand">): CommandSpec[] {
  return [
    { id: "file.open", run: () => flows.open() },
    { id: "file.save", run: async () => void (await flows.save()) },
    { id: "file.saveAs", run: async () => void (await flows.saveAs()) },
    { id: "app.closeWindow", run: () => api.appCommand("closeWindow") },
  ];
}
