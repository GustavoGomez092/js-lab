import { describe, expect, mock, test } from "bun:test";
import type { EncodedValue } from "@jslab/rpc-schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { childrenOf, summarize, tableModel } from "../src/output/format";
import { ValueView } from "../src/output/ValueView";

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
    expect(container.querySelector(".v-hole")?.textContent).toContain("7 more entries");
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
