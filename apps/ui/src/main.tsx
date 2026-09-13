import { createRoot } from "react-dom/client";
import { createRpcApi } from "./rpc";
import { App } from "./shell/App";
import { createAppStore } from "./state/store";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element is missing from index.html");

const api = createRpcApi();
const store = createAppStore();

api
  .bootstrap()
  .then((payload) => {
    store.getState().hydrate(payload);
    createRoot(root).render(<App store={store} api={api} />);
  })
  .catch((error: unknown) => {
    root.textContent = `JSLab failed to start: ${error instanceof Error ? error.message : String(error)}`;
  });
