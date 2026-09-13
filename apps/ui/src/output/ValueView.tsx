import type { EncodedValue } from "@jslab/rpc-schema";
import { useState } from "react";
import { childrenOf, formatPrimitive, summarize } from "./format";

export type ExpandHandle = (handle: string) => Promise<EncodedValue | null>;

interface ValueViewProps {
  value: EncodedValue;
  expand: ExpandHandle;
  nested?: boolean;
  label?: string;
}

const EXPIRED = "Value no longer available. Re-run to inspect.";

export function ValueView({ value, expand, nested = false, label }: ValueViewProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<EncodedValue | "expired" | null>(null);
  const [loading, setLoading] = useState(false);

  const lazyHandle = value.t === "handle" || value.t === "getter" ? value.handle : null;
  const shown = loaded && loaded !== "expired" ? loaded : value;
  const labelNode = label !== undefined ? <span className="v-key">{label}: </span> : null;

  if (value.t === "string" && value.truncated) {
    const truncated = value.truncated;
    const full = loaded && loaded !== "expired" && loaded.t === "string" ? loaded.v : null;
    return (
      <span className="v v-string">
        {labelNode}
        {formatPrimitive(full !== null ? { t: "string", v: full } : value, nested)}
        {full === null && (
          <button
            type="button"
            className="v-more"
            onClick={async () => setLoaded((await expand(truncated.handle)) ?? "expired")}
          >
            … {truncated.total - value.v.length} more characters
          </button>
        )}
      </span>
    );
  }

  const primitive = formatPrimitive(shown, nested);
  const children = childrenOf(shown);
  const expandable = lazyHandle !== null || (children !== null && children.length > 0);

  if (primitive !== null && !(lazyHandle && !loaded)) {
    return (
      <span className={`v v-${shown.t}`}>
        {labelNode}
        {primitive}
      </span>
    );
  }

  const toggle = async () => {
    if (!open && lazyHandle && loaded === null) {
      setLoading(true);
      setLoaded((await expand(lazyHandle)) ?? "expired");
      setLoading(false);
    }
    setOpen(!open);
  };

  return (
    <div className="v-node">
      <button type="button" className="v-toggle" aria-expanded={open} disabled={!expandable} onClick={toggle}>
        {expandable ? (open ? "▾ " : "▸ ") : ""}
        {labelNode}
        <span className={`v v-${shown.t}`}>{summarize(shown)}</span>
        {loading && <span className="v-loading"> …</span>}
      </button>
      {open && loaded === "expired" && <div className="v-expired">{EXPIRED}</div>}
      {open && children && (
        <div className="v-children">
          {children.map((child, index) =>
            child.value ? (
              <ValueView
                // biome-ignore lint/suspicious/noArrayIndexKey: sibling labels can repeat (map keys, holes)
                key={`${child.label}:${index}`}
                label={child.label}
                value={child.value}
                expand={expand}
                nested
              />
            ) : (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: sibling labels can repeat (map keys, holes)
                key={`${child.label}:${index}`}
                className="v-hole"
              >
                {child.label}
              </div>
            ),
          )}
          {"more" in shown && shown.more ? <div className="v-hole">… {shown.more} more</div> : null}
        </div>
      )}
    </div>
  );
}
