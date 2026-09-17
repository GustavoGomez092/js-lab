import type { Snippet } from "@jslab/shared";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";

/**
 * TEMPORARY STUB, replaced wholesale by Task 8, which owns this file and its tests.
 *
 * It exists so Task 7's panel can compile and so the New/Edit branch is reachable and testable. The props are
 * spelled exactly as Task 8's form declares them, so Task 8 is a drop-in replacement rather than a rewrite of the
 * panel. (The plan's suggested one-line stub, `export function SnippetForm(): null`, does not typecheck: the panel
 * passes it five props, and a zero-parameter component accepts none.)
 */
interface FormProps {
  store: AppStore;
  api: Pick<MainApi, "snippetsSave">;
  /** The snippet being edited, or null for a new one. */
  initial: Snippet | null;
  /** The body to start from: the edited snippet's, or a selection from Create Snippet… (spec §13.1). */
  body: string;
  onDone(): void;
}

export function SnippetForm(_props: FormProps): null {
  return null;
}
