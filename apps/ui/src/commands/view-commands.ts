import { nextZoom, type Settings } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import type { CommandSpec } from "./registry";
import { writeSetting } from "./settings-writer";
import { toggleSettingCommand } from "./toggle-setting";

type ViewKey = keyof Pick<Settings["view"], "activityBar" | "statusBar" | "sideBar" | "tabBarForSingleTab">;

/** View menu commands (spec §7.4 View). App-wide toggles persist through Main; layout is per tab. */
export function createViewCommands(store: AppStore, api: Pick<MainApi, "updateSettings">): CommandSpec[] {
  const s = () => store.getState();

  // FB-m6, T15-m5: each press steps from the last requested zoom, so rapid presses aren't lost.
  const zoom = (direction: -1 | 0 | 1) => () =>
    writeSetting(store, api, "appearance.uiScale", (uiScale) => nextZoom(Number(uiScale), direction));

  const toggleView = (id: CommandSpec["id"], key: ViewKey): CommandSpec =>
    toggleSettingCommand(id, `view.${key}`, store, api, () => strings.commands.onOff(Boolean(s().settings?.view[key])));

  return [
    { id: "view.zoomIn", run: zoom(1) },
    { id: "view.zoomOut", run: zoom(-1) },
    { id: "view.zoomReset", run: zoom(0) },
    {
      id: "view.toggleOutput",
      run: () => s().toggleOutputVisible(),
      description: () => strings.commands.onOff(Boolean(s().tab?.layout.outputVisible)),
    },
    {
      id: "view.toggleWebView",
      // spec §7.1: only a runtime that can host a webview gets a Web View tile, so a `bun` tab has nothing to
      // toggle. The status-bar button dispatches this same command, so both honour this one rule.
      isEnabled: () => {
        const runtime = s().tab?.runtime;
        return runtime !== undefined && runtime !== "bun";
      },
      run: () => s().toggleWebviewVisible(),
      description: () => strings.commands.onOff(Boolean(s().tab?.layout.tiles.webviewVisible)),
    },
    toggleView("view.toggleSideBar", "sideBar"),
    toggleView("view.toggleActivityBar", "activityBar"),
    toggleView("view.toggleStatusBar", "statusBar"),
    toggleView("view.toggleTabBar", "tabBarForSingleTab"),
    { id: "view.layoutHorizontal", run: () => s().setOrientation("horizontal") },
    { id: "view.layoutVertical", run: () => s().setOrientation("vertical") },
    { id: "view.toggleLayout", run: () => s().toggleOrientation() },
  ];
}
