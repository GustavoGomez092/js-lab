import { createRoot } from "react-dom/client";
import { createPrettierWorkerFormatter } from "./format/worker-client";
import { createRpcApi } from "./rpc";
import { App } from "./shell/App";
import { showStartupFailure } from "./shell/startup-failure";
import { createAppStore } from "./state/store";
import "./styles.css";
import { registerBundledFontFaces } from "./themes/font-faces";

const root = document.getElementById("root");
if (!root) throw new Error("#root element is missing from index.html");

registerBundledFontFaces();
const api = createRpcApi();
const store = createAppStore();

api
  .bootstrap()
  .then((payload) => {
    store.getState().hydrate(payload);
    createRoot(root).render(
      <App store={store} api={api} e2e={payload.e2e === true} formatter={createPrettierWorkerFormatter()} />,
    );
  })
  .catch((error: unknown) => {
    showStartupFailure(root, error, { heartbeat: () => api.heartbeat(), reload: () => window.location.reload() });
  });
