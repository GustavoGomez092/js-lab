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
