import type { OutputFilter } from "../state/store";
import { strings } from "../strings";
import { OUTPUT_FILTERS } from "./filters";

const COUNTED: ReadonlySet<OutputFilter> = new Set(["all", "errors"]);

export function FilterChips(props: {
  counts: Record<OutputFilter, number>;
  filter: OutputFilter;
  onChange(filter: OutputFilter): void;
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={strings.output.filterLabel}>
      {OUTPUT_FILTERS.map((filter) => {
        const count = props.counts[filter];
        const label =
          COUNTED.has(filter) && count > 0
            ? `${strings.output.filters[filter]} ${count}`
            : strings.output.filters[filter];
        return (
          // biome-ignore lint/a11y/useSemanticElements: chips are styled buttons with a visible label and count; a native radio input has no text content
          <button
            key={filter}
            type="button"
            role="radio"
            aria-checked={props.filter === filter}
            className={`chip${props.filter === filter ? " on" : ""}`}
            onClick={() => props.onChange(filter)}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
