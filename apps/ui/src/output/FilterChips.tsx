import type { OutputFilter } from "../state/store";
import { strings } from "../strings";
import { OUTPUT_FILTERS } from "./filters";

const COUNTED: ReadonlySet<OutputFilter> = new Set(["all", "errors"]);

/**
 * The output panel's header row: the four filter chips, plus -- for a runtime that can host one -- the Web View
 * control that fills the whole panel with the Web View (R-WEBVIEW-TAB-1).
 *
 * **Why this is not one `tablist` of five tabs.** The four chips are genuinely filters: they narrow one list that
 * stays on screen, none of them owns a panel, and `aria-controls` would have nothing to point at for any of them.
 * Giving them `role="tab"` would describe a structure that does not exist, and would make the one control that
 * DOES swap the panel body indistinguishable from the four that don't. So the radiogroup keeps exactly its four
 * filters -- which is why `filterLabel` ("Output filter") is still an honest name for it, rather than a name
 * stretched to cover a fifth member that is not a filter -- and the Web View control sits beside the group as its
 * own real `<button>` carrying `aria-pressed`, the accurate state for "this view is showing". A real `<button>`
 * also clears both lint gates here: `useSemanticElements` rejects `role="group"` on a `<div>`, and
 * `useAriaPropsSupportedByRole` makes `aria-label` on a roleless `<div>` an error.
 *
 * Choosing a filter while the Web View is showing returns to the log list (`setOutputFilter`, state/store.ts), so
 * for a pointer user the row still behaves as the single tab strip the design asks for, without lying about it to
 * assistive technology. That is also why a chip reads as unchecked while the Web View is up: exactly one control
 * in this row is "on" at a time, and the list the filter applies to is not on screen.
 */
export function FilterChips(props: {
  counts: Record<OutputFilter, number>;
  filter: OutputFilter;
  onChange(filter: OutputFilter): void;
  /** spec §7.1: absent for a `bun` tab, which never has a Web View and so gets no control for one. */
  webView?: { selected: boolean; onSelect(): void };
}) {
  const showingWebView = props.webView?.selected ?? false;
  return (
    <div className="output-tabs">
      <div className="chips" role="radiogroup" aria-label={strings.output.filterLabel}>
        {OUTPUT_FILTERS.map((filter) => {
          const count = props.counts[filter];
          const label =
            COUNTED.has(filter) && count > 0
              ? `${strings.output.filters[filter]} ${count}`
              : strings.output.filters[filter];
          const on = props.filter === filter && !showingWebView;
          return (
            // biome-ignore lint/a11y/useSemanticElements: chips are styled buttons with a visible label and count; a native radio input has no text content
            <button
              key={filter}
              type="button"
              role="radio"
              aria-checked={on}
              className={`chip${on ? " on" : ""}`}
              onClick={() => props.onChange(filter)}
            >
              {label}
            </button>
          );
        })}
      </div>
      {props.webView && (
        <button
          type="button"
          aria-pressed={showingWebView}
          className={`chip${showingWebView ? " on" : ""}`}
          onClick={props.webView.onSelect}
        >
          {strings.output.webViewTab}
        </button>
      )}
    </div>
  );
}
