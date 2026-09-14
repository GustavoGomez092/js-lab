import { createRoot } from "react-dom/client";
import { strings } from "../strings";
import { registerBundledFontFaces } from "../themes/font-faces";
import "../styles.css";
import { SettingsApp } from "./SettingsApp";
import { createSettingsApi } from "./settings-rpc";

const root = document.getElementById("root");
if (!root) throw new Error("#root element is missing from settings.html");

registerBundledFontFaces();
const api = createSettingsApi();
api
  .get()
  .then(({ settings, e2e }) => createRoot(root).render(<SettingsApp api={api} initial={settings} e2e={e2e} />))
  .catch((error: unknown) => {
    root.textContent = strings.settings.loadFailed(error instanceof Error ? error.message : String(error));
  });
