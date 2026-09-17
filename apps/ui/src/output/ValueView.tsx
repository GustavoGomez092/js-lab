import type { EncodedValue } from "@jslab/rpc-schema";
import { type KeyboardEvent as ReactKeyboardEvent, useRef, useState } from "react";
import { strings } from "../strings";
import { childrenOf, formatPrimitive, summarize } from "./format";

/** OU-02: `offset` asks for a page of a collection; omitted, it means the first page, exactly as before. */
export type ExpandHandle = (handle: string, offset?: number) => Promise<EncodedValue | null>;

interface ValueViewProps {
  value: EncodedValue;
  expand: ExpandHandle;
  nested?: boolean;
  label?: string;
}

const EXPIRED = "Value no longer available. Re-run to inspect.";
const EXPAND_FAILED = "Couldn't expand value. Try again.";

/**
 * §11 arrow-key navigation. The tree's rows are the `.v-toggle` buttons; a primitive row is a bare `<span>` and
 * cannot hold focus, so "the first child" can only mean the first row that can.
 *
 * These read the rendered DOM rather than threading refs through the recursion on purpose: every `ValueView` owns
 * its own `open` state and nothing else's, so a parent holds no handle on a child's row and a child none on its
 * parent's. The DOM is the one place the relationship already exists.
 */
const nodeOf = (button: HTMLElement) => button.closest<HTMLElement>(".v-node");

const ownToggle = (node: Element | null | undefined) => {
  const own = [...(node?.children ?? [])].find((child) => child.classList.contains("v-toggle"));
  return own instanceof HTMLButtonElement && !own.disabled ? own : null;
};

/** The first focusable row inside this node's own children container, or null when it has none. */
function firstChildToggle(button: HTMLElement): HTMLButtonElement | null {
  const children = [...(nodeOf(button)?.children ?? [])].find((child) => child.classList.contains("v-children"));
  // A row's own toggle precedes its descendants' in document order, so the first enabled toggle under this
  // container always belongs to a DIRECT child -- never to a grandchild of an already-open sibling.
  const toggles = children ? [...children.querySelectorAll<HTMLButtonElement>(".v-toggle")] : [];
  return toggles.find((toggle) => !toggle.disabled) ?? null;
}

/** The row of the node that contains this one, or null at the root of an entry. */
const parentToggle = (button: HTMLElement) => ownToggle(nodeOf(button)?.parentElement?.closest(".v-node"));

export function ValueView({ value, expand, nested = false, label }: ValueViewProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<EncodedValue | "expired" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // OU-02: pages after the first, in order. The first page is `shown` itself, so this stays empty for every value
  // small enough to arrive whole -- which is almost all of them.
  const [pages, setPages] = useState<EncodedValue[]>([]);
  const [pageError, setPageError] = useState<string | null>(null);
  // Guards against a second in-flight expand while the first hasn't settled yet (state updates
  // triggered by the first click aren't visible to a synchronous second click's render).
  const requestInFlight = useRef(false);

  const lazyHandle = value.t === "handle" || value.t === "getter" || value.t === "function" ? value.handle : null;
  const shown = loaded && loaded !== "expired" ? loaded : value;
  const labelNode = label !== undefined ? <span className="v-key">{label}: </span> : null;

  if (value.t === "string" && value.truncated) {
    const truncated = value.truncated;
    const full = loaded && loaded !== "expired" && loaded.t === "string" ? loaded.v : null;
    const loadRest = async () => {
      if (requestInFlight.current) return;
      requestInFlight.current = true;
      setLoading(true);
      try {
        setLoaded((await expand(truncated.handle)) ?? "expired");
        setError(null);
      } catch {
        setError(EXPAND_FAILED);
      } finally {
        setLoading(false);
        requestInFlight.current = false;
      }
    };
    return (
      <span className="v v-string">
        {labelNode}
        {formatPrimitive(full !== null ? { t: "string", v: full } : value, nested)}
        {full === null && (
          <button type="button" className="v-more" onClick={loadRest}>
            … {truncated.total - value.v.length} more characters
          </button>
        )}
        {error && <span className="v-error"> {error}</span>}
      </span>
    );
  }

  const primitive = formatPrimitive(shown, nested);
  const children = childrenOf(shown);
  const expandable = lazyHandle !== null || (children !== null && children.length > 0);

  // OU-02. The rows on screen are every page's children in order; the paging state comes from the last page
  // loaded. `expandable` above deliberately still reads the first page's `children`, unchanged.
  const lastPage = pages.at(-1) ?? shown;
  const allChildren = children === null ? null : [...children, ...pages.flatMap((page) => childrenOf(page) ?? [])];
  const remaining = "more" in lastPage ? (lastPage.more ?? 0) : 0;
  // `next` and `handle` are written by the encoder exactly when `more` is, so a pageable remainder always has
  // both. An object is the boundary case: it reports `more` and a `handle` but never a `next`, because object
  // properties are not paged (spec §5.9 lists them as a row separate from collection entries).
  const nextOffset = "next" in lastPage ? lastPage.next : undefined;
  const nextHandle = "handle" in lastPage ? (lastPage.handle ?? null) : null;

  const loadMore = async () => {
    if (requestInFlight.current || nextOffset === undefined || nextHandle === null) return;
    requestInFlight.current = true;
    setLoading(true);
    try {
      const page = await expand(nextHandle, nextOffset);
      // A null reply means the handle expired with the run; say so instead of leaving a button that does nothing.
      if (page === null) setPageError(EXPIRED);
      else {
        setPages([...pages, page]);
        setPageError(null);
      }
    } catch {
      setPageError(EXPAND_FAILED);
    } finally {
      setLoading(false);
      requestInFlight.current = false;
    }
  };

  if (primitive !== null && !(lazyHandle && !loaded)) {
    return (
      <span className={`v v-${shown.t}`}>
        {labelNode}
        {primitive}
      </span>
    );
  }

  const toggle = async () => {
    if (lazyHandle && loaded === null && !open) {
      if (requestInFlight.current) return;
      requestInFlight.current = true;
      setLoading(true);
      try {
        setLoaded((await expand(lazyHandle)) ?? "expired");
        setError(null);
        setOpen(true);
      } catch {
        // Leave `open` false so the node's own guard lets a later click retry the same expand.
        setError(EXPAND_FAILED);
      } finally {
        setLoading(false);
        requestInFlight.current = false;
      }
      return;
    }
    if (open) {
      // OU-02: collapsing drops the loaded pages, so re-expanding never shows a page fetched for a value that is
      // no longer the one on screen -- a fresh run replaces `value` while this component stays mounted.
      setPages([]);
      setPageError(null);
    }
    setOpen(!open);
  };

  // §11: Right expands and then moves inward; Left collapses and then moves outward -- the mapping Chrome
  // DevTools and Firefox's Web Console have both used for years, so it is what a user arrives already knowing.
  // Anything this does not handle is left completely untouched: no `preventDefault`, no `stopPropagation`. That
  // is what keeps Tab able to leave the tree, and keeps a modified chord reaching the window-level resolver in
  // `App.tsx` rather than being eaten here.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowRight") {
      if (!open) {
        // A collapsed lazy handle costs exactly the one `run.expand` a click would have cost -- no more.
        if (!expandable) return;
        event.preventDefault();
        void toggle();
        return;
      }
      const child = firstChildToggle(event.currentTarget);
      if (!child) return;
      event.preventDefault();
      child.focus();
      return;
    }
    if (event.key !== "ArrowLeft") return;
    if (open) {
      event.preventDefault();
      void toggle();
      return;
    }
    const parent = parentToggle(event.currentTarget);
    if (!parent) return;
    event.preventDefault();
    parent.focus();
  };

  return (
    <div className="v-node">
      <button
        type="button"
        className="v-toggle"
        aria-expanded={open}
        disabled={!expandable}
        onClick={toggle}
        onKeyDown={onKeyDown}
      >
        {expandable ? (open ? "▾ " : "▸ ") : ""}
        {labelNode}
        <span className={`v v-${shown.t}`}>{summarize(shown)}</span>
        {loading && <span className="v-loading"> …</span>}
      </button>
      {error && <div className="v-error">{error}</div>}
      {open && loaded === "expired" && <div className="v-expired">{EXPIRED}</div>}
      {open && allChildren && (
        <div className="v-children">
          {allChildren.map((child, index) =>
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
          {remaining > 0 && nextOffset !== undefined && nextHandle !== null ? (
            <button type="button" className="v-more" onClick={loadMore}>
              {strings.output.moreEntries(remaining)}
            </button>
          ) : remaining > 0 ? (
            // An object's properties are not paged, so the count is still stated -- it just is not a button that
            // could promise a page `run.expand` can never return.
            <div className="v-hole">{strings.output.moreEntries(remaining)}</div>
          ) : null}
          {pageError && <div className="v-error">{pageError}</div>}
        </div>
      )}
    </div>
  );
}
