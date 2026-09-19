import { describe, expect, mock, test } from "bun:test";
import type { EncodedValue } from "@jslab/rpc-schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { childrenOf, summarize, tableModel } from "../src/output/format";
import { EXPAND_ALL_MAX_DEPTH, ValueView } from "../src/output/ValueView";

const noExpand = async () => null;
const num = (v: string): EncodedValue => ({ t: "number", v });
const str = (v: string): EncodedValue => ({ t: "string", v });

describe("ValueView", () => {
  test("prints top-level strings verbatim and nested strings quoted", () => {
    const { container } = render(
      <ValueView
        value={{ t: "object", id: 1, ctor: "Object", props: [[{ k: "name" }, str("Ada")]] }}
        expand={noExpand}
      />,
    );
    render(<ValueView value={str("hello")} expand={noExpand} />);
    expect(screen.getByText("hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Object/ }));
    expect(container.textContent).toContain('name: "Ada"');
  });

  test("renders special numbers exactly", () => {
    render(<ValueView value={num("-0")} expand={noExpand} />);
    expect(screen.getByText("-0")).toBeTruthy();
  });

  test("renders typed array items by constructor, keeping NaN and -0 exact", () => {
    const { container } = render(
      <ValueView
        value={{ t: "typedArray", ctor: "Float64Array", length: 3, items: ["NaN", "-0", 1.5] }}
        expand={noExpand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Float64Array\(3\)/ }));
    const rows = [...container.querySelectorAll(".v-children > .v")].map((row) => [row.className, row.textContent]);
    expect(rows).toEqual([
      ["v v-number", "0: NaN"],
      ["v v-number", "1: -0"],
      ["v v-number", "2: 1.5"],
    ]);
    expect(childrenOf({ t: "typedArray", ctor: "BigInt64Array", length: 1, items: ["1"] })).toEqual([
      { label: "0", value: { t: "bigint", v: "1" } },
    ]);
    expect(childrenOf({ t: "typedArray", ctor: "BigData", length: 1, items: [7] })).toEqual([
      { label: "0", value: { t: "number", v: "7" } },
    ]);
  });

  test("objects start collapsed and expand on click", () => {
    render(
      <ValueView
        value={{ t: "array", id: 1, ctor: "Array", length: 2, items: [[0, num("1")], { hole: 1 }] }}
        expand={noExpand}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Array\(2\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("<1 empty items>")).toBeTruthy();
  });

  test("loads handles lazily through expand", async () => {
    const expand = mock(
      async () => ({ t: "object", id: 2, ctor: "Deep", props: [[{ k: "d" }, num("1")]] }) as EncodedValue,
    );
    const { container } = render(
      <ValueView value={{ t: "handle", handle: "h1", preview: "Object {…}" }} expand={expand} />,
    );
    expect(expand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Object/ }));
    await waitFor(() => expect(container.textContent).toContain("d: 1"));
    expect(expand).toHaveBeenCalledWith("h1");
  });

  test("shows an explanation when a handle has expired", async () => {
    render(<ValueView value={{ t: "handle", handle: "h9", preview: "Object {…}" }} expand={noExpand} />);
    fireEvent.click(screen.getByRole("button", { name: /Object/ }));
    await waitFor(() => expect(screen.getByText(/no longer available/)).toBeTruthy());
  });

  test("loads the rest of a truncated string", async () => {
    const expand = mock(async () => str("abcdefgh"));
    render(<ValueView value={{ t: "string", v: "abcd", truncated: { total: 8, handle: "h2" } }} expand={expand} />);
    fireEvent.click(screen.getByRole("button", { name: /4 more characters/ }));
    await waitFor(() => expect(screen.getByText("abcdefgh")).toBeTruthy());
  });

  test("summarizes promises and errors", () => {
    render(<ValueView value={{ t: "promise", id: 1, state: "pending" }} expand={noExpand} />);
    render(<ValueView value={{ t: "error", name: "TypeError", message: "bad", stack: [] }} expand={noExpand} />);
    expect(screen.getByText("Promise { <pending> }")).toBeTruthy();
    expect(screen.getByText("TypeError: bad")).toBeTruthy();
  });

  test("shows a retryable message when expanding fails", async () => {
    let calls = 0;
    const expand = mock(async (): Promise<EncodedValue | null> => {
      calls++;
      if (calls === 1) throw new Error("rpc failed");
      return { t: "object", id: 2, ctor: "Deep", props: [[{ k: "d" }, num("1")]] };
    });
    const { container } = render(
      <ValueView value={{ t: "handle", handle: "h1", preview: "Object {…}" }} expand={expand} />,
    );
    const toggle = screen.getByRole("button", { name: /Object/ });
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.getByText(/Couldn't expand/)).toBeTruthy());
    fireEvent.click(toggle);
    await waitFor(() => expect(container.textContent).toContain("d: 1"));
    expect(expand).toHaveBeenCalledTimes(2);
  });

  test("does not expand the same node twice while a request is in flight", async () => {
    let resolveExpand: (value: EncodedValue) => void = () => {};
    const expand = mock(
      () =>
        new Promise<EncodedValue>((resolve) => {
          resolveExpand = resolve;
        }),
    );
    const { container } = render(
      <ValueView value={{ t: "handle", handle: "h1", preview: "Object {…}" }} expand={expand} />,
    );
    const toggle = screen.getByRole("button", { name: /Object/ });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(expand).toHaveBeenCalledTimes(1);
    resolveExpand({ t: "object", id: 2, ctor: "Deep", props: [[{ k: "d" }, num("1")]] });
    await waitFor(() => expect(container.textContent).toContain("d: 1"));
  });

  test("expands a function to show its source", async () => {
    const source = "function foo() { return 1; }";
    const expand = mock(async (): Promise<EncodedValue | null> => ({ t: "string", v: source }));
    render(<ValueView value={{ t: "function", name: "foo", kind: "function", handle: "h3" }} expand={expand} />);
    fireEvent.click(screen.getByRole("button", { name: /foo/ }));
    await waitFor(() => expect(screen.getByText(source)).toBeTruthy());
    expect(expand).toHaveBeenCalledWith("h3");
  });

  /**
   * OU-02 Task C. The collection overflow row was an inert `<div className="v-hole">… N more</div>`: Tasks A and
   * B taught the wire to page, but nothing in the UI could ask for a page. These pin the control, the offset it
   * sends, the append, and the identity that catches a page disagreeing with the remainder it advertises.
   */
  const collectionPage = (from: number, values: number[], more: number): EncodedValue => ({
    t: "array",
    id: 1,
    ctor: "Array",
    length: 5,
    items: values.map((v, i): [number, EncodedValue] => [from + i, num(String(v))]),
    // The first page carries no `from`; absent means 0 (`encode.ts` `#take`).
    ...(from > 0 ? { from } : {}),
    // `#array` writes `handle` exactly when `page.more` is set, so `more`, `next` and `handle` always travel together.
    ...(more > 0 ? { more, next: from + values.length, handle: "h1" } : {}),
  });

  const moreButton = () => screen.queryByRole("button", { name: /more entries/ });
  /** The remainder the affordance currently promises, or 0 when it is absent. */
  const advertisedRemainder = () => {
    const match = /([\d,]+) more entries/.exec(moreButton()?.textContent ?? "");
    return match?.[1] ? Number(match[1].replace(/,/g, "")) : 0;
  };

  test("a collection past its page offers a button, not an inert div (OU-02)", () => {
    const { container } = render(<ValueView value={collectionPage(0, [10, 11], 3)} expand={noExpand} />);
    fireEvent.click(screen.getByRole("button", { name: /Array\(5\)/ }));
    expect(moreButton()?.textContent).toContain("3 more entries");
    // The overflow row is no longer one of the muted, unclickable hole divs.
    expect([...container.querySelectorAll(".v-hole")].map((node) => node.textContent)).toEqual([]);
  });

  test("clicking it loads the next page at the right offset and appends rather than replaces (OU-02)", async () => {
    const expand = mock(
      async (_handle: string, offset = 0): Promise<EncodedValue | null> =>
        offset === 2 ? collectionPage(2, [12, 13], 1) : collectionPage(4, [14], 0),
    );
    const { container } = render(<ValueView value={collectionPage(0, [10, 11], 3)} expand={expand} />);
    fireEvent.click(screen.getByRole("button", { name: /Array\(5\)/ }));
    const rows = () => [...container.querySelectorAll(".v-children > .v")].map((row) => row.textContent);

    expect(rows()).toEqual(["0: 10", "1: 11"]);
    // Task B's identity, read off the screen: rows loaded + remainder promised == the collection's true size, at
    // every page. This is what catches a page and its `more`/`next` describing different edges.
    expect(rows().length + advertisedRemainder()).toBe(5);

    fireEvent.click(moreButton() as HTMLElement);
    await waitFor(() => expect(container.textContent).toContain("2: 12"));
    expect(expand).toHaveBeenLastCalledWith("h1", 2);
    expect(rows()).toEqual(["0: 10", "1: 11", "2: 12", "3: 13"]);
    expect(rows().length + advertisedRemainder()).toBe(5);

    fireEvent.click(moreButton() as HTMLElement);
    await waitFor(() => expect(container.textContent).toContain("4: 14"));
    expect(expand).toHaveBeenLastCalledWith("h1", 4);
    expect(rows()).toEqual(["0: 10", "1: 11", "2: 12", "3: 13", "4: 14"]);
    expect(rows().length + advertisedRemainder()).toBe(5);
  });

  test("the last page shows no button, and an exhausted page omits `more` instead of sending 0 (OU-02)", async () => {
    const final = collectionPage(2, [12, 13, 14], 0);
    // Task B pinned `toBeUndefined()` on an exhausted page: absence, not a zero. Asserted here so the fixture is
    // provably the shape the encoder emits, rather than one that would satisfy `remaining > 0` by accident.
    expect(final.t === "array" && final.more).toBeUndefined();
    const expand = mock(async (): Promise<EncodedValue | null> => final);
    const { container } = render(<ValueView value={collectionPage(0, [10, 11], 3)} expand={expand} />);
    fireEvent.click(screen.getByRole("button", { name: /Array\(5\)/ }));
    expect(moreButton()).not.toBeNull();

    fireEvent.click(moreButton() as HTMLElement);
    await waitFor(() => expect(container.textContent).toContain("4: 14"));
    expect(moreButton()).toBeNull();
  });

  test("an object's overflow states its count but is not a button (OU-02 boundary)", () => {
    // Objects are deliberately not paged -- spec §5.9 lists object properties and collection entries as separate
    // rows -- so an object carries `more` and a `handle` but never `next`. A button here would promise a page
    // `run.expand` can never return. Kills the mutant "render a button whenever remaining > 0".
    const { container } = render(
      <ValueView
        value={{ t: "object", id: 1, ctor: "Object", props: [[{ k: "a" }, num("1")]], more: 7, handle: "h4" }}
        expand={noExpand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Object/ }));
    expect(moreButton()).toBeNull();
    // "properties", not "entries" -- §5.9 treats them as different rows, and with the element type being the
    // only other difference, the noun is what distinguishes them when read aloud. Kills "reuse
    // `output.moreEntries` for the object branch too".
    expect(container.querySelector(".v-hole")?.textContent).toContain("7 more properties");
  });

  test("collection rows are labelled with their real index once a later page is loaded (OU-02)", () => {
    // `array` items carry true indices in their tuples and `map` labels by key, so only `set` and `typedArray`
    // -- which label by position -- can restart at 0 on a later page.
    const set = render(
      <ValueView
        value={{ t: "set", id: 1, size: 12_000, from: 10_000, items: [num("1"), num("2")] }}
        expand={noExpand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Set\(12000\)/ }));
    expect([...set.container.querySelectorAll(".v-children > .v")].map((row) => row.textContent)).toEqual([
      "10000: 1",
      "10001: 2",
    ]);

    const typed = render(
      <ValueView
        value={{ t: "typedArray", ctor: "Uint8Array", length: 4, from: 2, items: [7, 8] }}
        expand={noExpand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Uint8Array\(4\)/ }));
    expect([...typed.container.querySelectorAll(".v-children > .v")].map((row) => row.textContent)).toEqual([
      "2: 7",
      "3: 8",
    ]);
  });

  test("child-label holes stay inert divs; only the overflow row became a control (OU-02)", () => {
    const { container } = render(
      <ValueView
        value={{ t: "array", id: 1, ctor: "Array", length: 4, items: [[0, num("1")], { hole: 2 }, [3, num("4")]] }}
        expand={noExpand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Array\(4\)/ }));
    // `v-hole` serves two unrelated purposes in this file; the child-label one is not the paging affordance.
    expect([...container.querySelectorAll(".v-hole")].map((node) => [node.tagName, node.textContent])).toEqual([
      ["DIV", "<2 empty items>"],
    ]);
    expect(container.querySelectorAll(".v-hole button")).toHaveLength(0);
  });

  test("a page whose handle expired says so instead of failing silently (OU-02)", async () => {
    render(<ValueView value={collectionPage(0, [10, 11], 3)} expand={noExpand} />);
    fireEvent.click(screen.getByRole("button", { name: /Array\(5\)/ }));
    fireEvent.click(moreButton() as HTMLElement);
    await waitFor(() => expect(screen.getByText(/no longer available/)).toBeTruthy());
  });

  test("collapsing a node drops the pages it had loaded (OU-02)", async () => {
    const expand = mock(async (): Promise<EncodedValue | null> => collectionPage(2, [12, 13], 1));
    const { container } = render(<ValueView value={collectionPage(0, [10, 11], 3)} expand={expand} />);
    const toggle = () => screen.getByRole("button", { name: /Array\(5\)/ });
    fireEvent.click(toggle());
    fireEvent.click(moreButton() as HTMLElement);
    await waitFor(() => expect(container.textContent).toContain("2: 12"));

    fireEvent.click(toggle()); // collapse
    fireEvent.click(toggle()); // re-expand
    // A fresh run replaces `value` while this component stays mounted, so stale pages must not survive a collapse.
    expect(container.textContent).not.toContain("2: 12");
    expect(container.textContent).toContain("0: 10");
    expect(advertisedRemainder()).toBe(3);
  });

  test("the string affordance is a sibling of the new one, not a casualty of it (OU-02)", () => {
    const { container } = render(
      <ValueView value={{ t: "string", v: "abcd", truncated: { total: 8, handle: "h2" } }} expand={noExpand} />,
    );
    // Both affordances share `.v-more`, so only the wording tells them apart: a truncated string must keep its
    // own label and never pick up the collection's.
    expect(container.querySelector(".v-more")?.textContent).toContain("4 more characters");
    expect(moreButton()).toBeNull();
  });
});

/**
 * §11. Arrow-key navigation over the value tree. Right expands, or moves into the first child once open; Left
 * collapses, or moves to the parent once closed. Chrome DevTools and Firefox's Web Console both use exactly this
 * mapping, so it is what a user arrives already knowing.
 *
 * The rows are `<button className="v-toggle">`, not a `role="tree"`: Tab already reaches them and Enter/Space
 * already toggles them, and claiming `tree` would owe the APG the rest of the pattern (roving tabindex,
 * `aria-level`, `aria-setsize`, Home/End, typeahead) that this widget does not implement. These pin the
 * behaviour on the structure that actually ships.
 */
describe("ValueView: arrow-key navigation (§11)", () => {
  /** An object two levels deep, all of it already loaded -- so nothing here can reach `expand`. */
  const nested = (): EncodedValue => ({
    t: "object",
    id: 1,
    ctor: "Outer",
    props: [
      [{ k: "first" }, { t: "object", id: 2, ctor: "Inner", props: [[{ k: "leaf" }, num("1")]] }],
      [{ k: "second" }, num("2")],
    ],
  });

  const togglesIn = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>(".v-toggle")];

  test("Right expands a collapsed node, exactly as Enter does", () => {
    const { container } = render(<ValueView value={nested()} expand={noExpand} />);
    const root = togglesIn(container)[0] as HTMLButtonElement;
    expect(root.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(root.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("second: 2");
  });

  test("Right on an open node moves focus into its first child rather than re-toggling it", () => {
    const { container } = render(<ValueView value={nested()} expand={noExpand} />);
    const root = togglesIn(container)[0] as HTMLButtonElement;
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowRight" });

    fireEvent.keyDown(root, { key: "ArrowRight" });
    // Still open: the second Right must navigate, not collapse what the first one opened.
    expect(root.getAttribute("aria-expanded")).toBe("true");
    const inner = togglesIn(container).find((button) => button.textContent?.includes("Inner"));
    expect(document.activeElement).toBe(inner as HTMLButtonElement);
  });

  test("Left collapses an open node, then moves to the parent from the closed child", () => {
    const { container } = render(<ValueView value={nested()} expand={noExpand} />);
    const root = togglesIn(container)[0] as HTMLButtonElement;
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowRight" });
    const inner = togglesIn(container).find((b) => b.textContent?.includes("Inner")) as HTMLButtonElement;

    inner.focus();
    fireEvent.keyDown(inner, { key: "ArrowRight" });
    expect(inner.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(inner, { key: "ArrowLeft" });
    expect(inner.getAttribute("aria-expanded")).toBe("false");
    // Focus has not moved yet: the first Left spent itself on the collapse.
    expect(document.activeElement).toBe(inner);

    fireEvent.keyDown(inner, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(root);
    // Collapsing the child must not have collapsed the parent on the way past.
    expect(root.getAttribute("aria-expanded")).toBe("true");
  });

  test("Right into a child skips primitive rows, which are spans and cannot hold focus", () => {
    // `first` is an object (focusable); `second` is a number rendered as a bare <span>. Moving "into the first
    // child" can only mean the first row that can actually take focus.
    const { container } = render(
      <ValueView
        value={{
          t: "object",
          id: 1,
          ctor: "Outer",
          props: [
            [{ k: "alpha" }, num("1")],
            [{ k: "beta" }, { t: "object", id: 2, ctor: "Inner", props: [[{ k: "leaf" }, num("2")]] }],
          ],
        }}
        expand={noExpand}
      />,
    );
    const root = togglesIn(container)[0] as HTMLButtonElement;
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowRight" });
    fireEvent.keyDown(root, { key: "ArrowRight" });
    expect(document.activeElement).toBe(togglesIn(container).find((b) => b.textContent?.includes("Inner")) ?? null);
  });

  test("Right expands a lazy handle through exactly one expand, the same as a click", async () => {
    const expand = mock(
      async () => ({ t: "object", id: 2, ctor: "Deep", props: [[{ k: "d" }, num("1")]] }) as EncodedValue,
    );
    const { container } = render(
      <ValueView value={{ t: "handle", handle: "h1", preview: "Object {…}" }} expand={expand} />,
    );
    const root = togglesIn(container)[0] as HTMLButtonElement;
    fireEvent.keyDown(root, { key: "ArrowRight" });
    await waitFor(() => expect(container.textContent).toContain("d: 1"));
    // One keystroke, one RPC -- Right must not both toggle and separately fetch.
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith("h1");
  });

  test("the arrows never trap focus: at the root Left does nothing and leaves other keys alone", () => {
    const { container } = render(<ValueView value={nested()} expand={noExpand} />);
    const root = togglesIn(container)[0] as HTMLButtonElement;
    root.focus();

    // Collapsed root, no parent to move to: the key must fall through untouched so nothing swallows it.
    expect(fireEvent.keyDown(root, { key: "ArrowLeft" })).toBe(true);
    expect(document.activeElement).toBe(root);
    expect(root.getAttribute("aria-expanded")).toBe("false");

    // Tab must stay the browser's, or the tree becomes a focus trap.
    expect(fireEvent.keyDown(root, { key: "Tab" })).toBe(true);
    // A modified Right belongs to whoever bound it, not to the tree.
    expect(fireEvent.keyDown(root, { key: "ArrowRight", metaKey: true })).toBe(true);
    expect(root.getAttribute("aria-expanded")).toBe("false");
  });

  test("a non-expandable row ignores both arrows instead of throwing", () => {
    const { container } = render(
      <ValueView value={{ t: "object", id: 1, ctor: "Empty", props: [] }} expand={noExpand} />,
    );
    const root = togglesIn(container)[0] as HTMLButtonElement;
    expect(root.disabled).toBe(true);
    expect(fireEvent.keyDown(root, { key: "ArrowRight" })).toBe(true);
    expect(root.getAttribute("aria-expanded")).toBe("false");
  });
});

/**
 * §11 Expand All. Spec §7.2 lists it in the entry `⋯` menu and `docs/parity.md` OU-03 records that nothing
 * covers it. There is no entry menu in the shipped UI, so it arrives as the modified activation DevTools uses:
 * Alt+Right, and Alt-click on the row.
 *
 * The bound is the feature. `ValueView` fires one `run.expand` per node and `requestInFlight` is per-node, so a
 * recursive expand-all over lazy handles would issue an unthrottled storm of RPCs. These pin that it issues none.
 */
describe("ValueView: Expand All (§11)", () => {
  const obj = (ctor: string, props: [string, EncodedValue][], id = 1): EncodedValue => ({
    t: "object",
    id,
    ctor,
    props: props.map(([k, v]): [{ k: string }, EncodedValue] => [{ k }, v]),
  });
  const rootToggle = (c: HTMLElement) => c.querySelector(".v-toggle") as HTMLButtonElement;
  const openCount = (c: HTMLElement) => c.querySelectorAll('.v-toggle[aria-expanded="true"]').length;
  const altRight = (el: HTMLElement) => fireEvent.keyDown(el, { key: "ArrowRight", altKey: true });

  test("Alt+Right opens the whole already-loaded subtree in one keystroke", async () => {
    const { container } = render(
      <ValueView
        value={obj("Root", [
          ["a", obj("A", [["b", obj("B", [["c", num("1")]], 2)]], 3)],
          ["d", obj("D", [["e", num("2")]], 4)],
        ])}
        expand={noExpand}
      />,
    );
    altRight(rootToggle(container));
    // Root, A, B and D -- every expandable node in the payload, from one keystroke.
    await waitFor(() => expect(openCount(container)).toBe(4));
    expect(container.textContent).toContain("c: 1");
    expect(container.textContent).toContain("e: 2");
  });

  test("a cascade issues ZERO expand calls and leaves lazy handles collapsed but still openable", async () => {
    const expand = mock(async (): Promise<EncodedValue | null> => obj("Never", [["n", num("0")]], 9));
    const { container } = render(
      <ValueView
        value={obj("Root", [
          ["loaded", obj("Loaded", [["x", num("1")]], 2)],
          ["lazy", { t: "handle", handle: "h1", preview: "Object {…}" }],
        ])}
        expand={expand}
      />,
    );
    altRight(rootToggle(container));
    await waitFor(() => expect(openCount(container)).toBe(2)); // root + the already-loaded child, never the handle

    // THE MEASUREMENT: one keystroke over a subtree containing a lazy handle costs no RPCs at all.
    expect(expand).toHaveBeenCalledTimes(0);
    const lazy = [...container.querySelectorAll<HTMLButtonElement>(".v-toggle")].find((b) =>
      b.textContent?.includes("Object {…}"),
    ) as HTMLButtonElement;
    expect(lazy.getAttribute("aria-expanded")).toBe("false");
    // Skipped, not disabled: the user can still open this one deliberately and pay for exactly this one node.
    expect(lazy.disabled).toBe(false);
    fireEvent.click(lazy);
    await waitFor(() => expect(expand).toHaveBeenCalledTimes(1));
  });

  test("the cascade stops at the depth cap instead of opening an arbitrarily deep payload", async () => {
    const chain = (depth: number): EncodedValue =>
      depth === 0 ? num("0") : obj(`L${depth}`, [["child", chain(depth - 1)]], depth);
    const { container } = render(<ValueView value={chain(EXPAND_ALL_MAX_DEPTH + 3)} expand={noExpand} />);
    altRight(rootToggle(container));
    // The activated node, plus EXPAND_ALL_MAX_DEPTH levels beneath it, and no further.
    await waitFor(() => expect(openCount(container)).toBe(EXPAND_ALL_MAX_DEPTH + 1));
    expect(container.querySelectorAll('.v-toggle[aria-expanded="false"]').length).toBeGreaterThan(0);
  });

  test("Alt-click on the row does the same as Alt+Right, and a plain click still just toggles", async () => {
    const value = obj("Root", [["a", obj("A", [["b", num("1")]], 2)]]);
    const alt = render(<ValueView value={value} expand={noExpand} />);
    fireEvent.click(rootToggle(alt.container), { altKey: true });
    await waitFor(() => expect(openCount(alt.container)).toBe(2));

    const plain = render(<ValueView value={value} expand={noExpand} />);
    fireEvent.click(rootToggle(plain.container));
    // A plain click opens exactly the node it hit -- the child stays closed.
    expect(openCount(plain.container)).toBe(1);
  });

  test("Alt+Right on an unloaded handle costs exactly one expand, then cascades into what arrived", async () => {
    const expand = mock(
      async (): Promise<EncodedValue | null> => obj("Deep", [["inner", obj("Inner", [["leaf", num("7")]], 3)]], 2),
    );
    const { container } = render(
      <ValueView value={{ t: "handle", handle: "h1", preview: "Object {…}" }} expand={expand} />,
    );
    altRight(rootToggle(container));
    await waitFor(() => expect(container.textContent).toContain("leaf: 7"));
    // The activated node pays what a plain click would have paid, and not one RPC more.
    expect(expand).toHaveBeenCalledTimes(1);
    expect(openCount(container)).toBe(2);
  });
});

/**
 * Task 14 shipped the `dom` encoding with no consumer in the UI, so `console.log(someElement)` arrived as an
 * output entry that rendered as the empty string. Spec §5.9 asks for tag, attributes, child count and an
 * outerHTML preview; these assert what the user actually sees, not what the serializer emits.
 */
describe("ValueView: DOM nodes (spec §5.9)", () => {
  const markup = '<div id="app" class="row"><b>hi</b>!</div>';
  const element: EncodedValue = {
    t: "dom",
    nodeType: 1,
    tag: "DIV",
    attrs: [
      ["id", "app"],
      ["class", "row"],
    ],
    childCount: 2,
    outerHTML: markup,
  };
  const toggleOf = (container: HTMLElement) => container.querySelector(".v-toggle") as HTMLElement;

  test("a logged element shows its tag, attributes and child count instead of an empty entry", () => {
    const { container } = render(<ValueView value={element} expand={noExpand} />);
    // The leading caret is the collapsed-node affordance every structured value gets.
    expect(container.textContent).toBe('▸ <div id="app" class="row"> (2 children)');
  });

  test("expands to every attribute, the child count and the outerHTML preview", () => {
    const { container } = render(<ValueView value={element} expand={noExpand} />);
    fireEvent.click(toggleOf(container));
    expect([...container.querySelectorAll(".v-children > .v")].map((row) => row.textContent)).toEqual([
      'id: "app"',
      'class: "row"',
      "childCount: 2",
      `outerHTML: ${JSON.stringify(markup)}`,
    ]);
  });

  test("a truncated outerHTML preview offers the rest through its handle", async () => {
    const full = `<div>${"x".repeat(50)}</div>`;
    const expand = mock(async (): Promise<EncodedValue | null> => ({ t: "string", v: full }));
    const { container } = render(
      <ValueView
        value={{
          t: "dom",
          nodeType: 1,
          tag: "DIV",
          attrs: [],
          childCount: 0,
          outerHTML: full.slice(0, 10),
          truncated: { total: full.length, handle: "h9" },
        }}
        expand={expand}
      />,
    );
    fireEvent.click(toggleOf(container));
    fireEvent.click(container.querySelector(".v-more") as HTMLElement);
    await waitFor(() => expect(container.textContent).toContain(full));
    expect(expand).toHaveBeenCalledWith("h9");
  });

  test("summaries read naturally, and a case-sensitive tag keeps its own spelling", () => {
    const node = (tag: string, childCount: number): EncodedValue => ({
      t: "dom",
      nodeType: 1,
      tag,
      attrs: [],
      childCount,
      outerHTML: "",
    });
    // tagName is uppercase for HTML, so it prints the way the markup does; an SVG tag is already cased and stays.
    expect(summarize(node("SPAN", 1))).toBe("<span> (1 child)");
    expect(summarize(node("SPAN", 0))).toBe("<span>");
    expect(summarize(node("linearGradient", 0))).toBe("<linearGradient>");
  });
});

describe("tableModel", () => {
  test("uses the union of row keys as columns", () => {
    const row = (props: [string, EncodedValue][]): EncodedValue => ({
      t: "object",
      id: 1,
      ctor: "Object",
      props: props.map(([k, v]) => [{ k }, v]),
    });
    const model = tableModel({
      t: "array",
      id: 1,
      ctor: "Array",
      length: 2,
      items: [
        [0, row([["a", num("1")]])],
        [1, row([["b", num("2")]])],
      ],
    });
    expect(model?.columns).toEqual(["a", "b"]);
    expect(model?.rows.map((r) => r.key)).toEqual(["0", "1"]);
  });

  test("puts primitive rows in a Values column", () => {
    expect(tableModel({ t: "array", id: 1, ctor: "Array", length: 1, items: [[0, num("5")]] })?.columns).toEqual([
      "Values",
    ]);
  });
});
