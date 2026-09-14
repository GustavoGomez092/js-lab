import { nextZoom } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import type { CommandSpec } from "./registry";

/** View menu commands. Zoom lands here; Task 16 appends the layout toggles. */
export function createViewCommands(store: AppStore, api: Pick<MainApi, "updateSettings">): CommandSpec[] {
  const zoom = (direction: -1 | 0 | 1) => async () => {
    const settings = store.getState().settings;
    if (!settings) return;
    const uiScale = nextZoom(settings.appearance.uiScale, direction);
    store.getState().updateSettings(await api.updateSettings({ appearance: { uiScale } }));
  };
  return [
    { id: "view.zoomIn", run: zoom(1) },
    { id: "view.zoomOut", run: zoom(-1) },
    { id: "view.zoomReset", run: zoom(0) },
  ];
}
