import { nextZoom, type Settings } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import type { CommandSpec } from "./registry";

type ViewKey = keyof Pick<Settings["view"], "activityBar" | "statusBar" | "sideBar" | "tabBarForSingleTab">;

/** View menu commands (spec §7.4 View). App-wide toggles persist through Main; layout is per tab. */
export function createViewCommands(store: AppStore, api: Pick<MainApi, "updateSettings">): CommandSpec[] {
  const s = () => store.getState();

  const zoom = (direction: -1 | 0 | 1) => async () => {
    const settings = s().settings;
    if (!settings) return;
    const uiScale = nextZoom(settings.appearance.uiScale, direction);
    s().updateSettings(await api.updateSettings({ appearance: { uiScale } }));
  };

  const toggleView = (id: CommandSpec["id"], key: ViewKey): CommandSpec => ({
    id,
    run: async () => {
      const settings = s().settings;
      if (!settings) return;
      s().updateSettings(await api.updateSettings({ view: { [key]: !settings.view[key] } }));
    },
    description: () => strings.commands.onOff(Boolean(s().settings?.view[key])),
  });

  return [
    { id: "view.zoomIn", run: zoom(1) },
    { id: "view.zoomOut", run: zoom(-1) },
    { id: "view.zoomReset", run: zoom(0) },
    {
      id: "view.toggleOutput",
      run: () => s().toggleOutputVisible(),
      description: () => strings.commands.onOff(Boolean(s().tab?.layout.outputVisible)),
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
