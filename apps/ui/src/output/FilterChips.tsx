import type { OutputFilter } from "../state/store";
import { strings } from "../strings";
import { OUTPUT_FILTERS } from "./filters";

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
 *
 * **R-UI9-COUNTS-1: all four chips carry a count, always (including zero).** All four counts are already
 * computed and memoized (`filterCounts`, `OutputPanel.tsx`); showing only two read as an asymmetry bug, not a
 * design choice. This does widen the row -- measured (Chromium, `-apple-system` fallback, so a proxy for the
 * app's actual WebKit rendering, not identical to it): English, today's two-count shape, is ~232px; all four
 * counted in English is ~260px (+12%); a representative ja label set with all four counted is ~257px, about
 * the same; and a deliberately extreme case (ja labels, every count at 3 digits) is ~306px (+32% over today).
 * None of that changes whether the row wraps or truncates -- `.chips`/`.output-tabs` do neither today, with or
 * without this change, and the output panel has no width floor tied to the chip row (`SplitPane.tsx` has no
 * pixel `min-width`) -- so a narrow-enough panel can already outrun the row before this change. A ~30-70px
 * worst-case widening does not newly break that; it does not clear the bar for "none" in R-UI9-COUNTS-1's
 * ruling. m5e Task 14 will replace this proxy with its real display-width budget mechanism.
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
          // R-UI9-COUNTS-1: all four chips carry their count, including zero -- a zero count is a fact
          // ("no errors") the user should see, not an absence that reads as "unknown" or "unavailable".
          const label = `${strings.output.filters[filter]} ${count}`;
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
