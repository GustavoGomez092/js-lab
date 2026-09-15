import { createWorkerFormatter, type Formatter } from "./formatter";
import PrettierWorker from "./prettier.worker?worker";

/** Vite-only: never import this module in unit tests. */
export function createPrettierWorkerFormatter(): Formatter {
  return createWorkerFormatter(() => new PrettierWorker());
}
