import { describe, expect, mock, test } from "bun:test";
import type * as Monaco from "monaco-editor";
import { createMonacoBody, createTextareaBody } from "../src/snippets/body-editor";

function fakeMonaco() {
  const created: { value: string; language: string; options: Record<string, unknown> }[] = [];
  const dispose = mock(() => {});
  const focus = mock(() => {});
  let current = "";
  const monaco = {
    editor: {
      create: (_host: HTMLElement, options: Record<string, unknown>) => {
        current = String(options.value ?? "");
        created.push({ value: current, language: String(options.language ?? ""), options });
        return { getValue: () => current, focus, dispose };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, created, dispose, focus };
}

describe("the snippet body editor (spec §13.1, R-M5b-5)", () => {
  test("creates a Monaco editor for the snippet's language and reads its value back", () => {
    const { monaco, created, dispose, focus } = fakeMonaco();
    const factory = createMonacoBody(monaco, (language) => (language === "javascript" ? "javascript" : "typescript"));
    const host = document.createElement("div");
    const handle = factory(host, { value: "await fetch($0)", language: "javascript" });
    expect(created[0]?.value).toBe("await fetch($0)");
    expect(created[0]?.language).toBe("javascript");
    // A body field is not the main editor: no minimap, no line numbers, and it lays itself out.
    const options = created[0]?.options ?? {};
    expect(options).toMatchObject({ automaticLayout: true, lineNumbers: "off" });
    expect((options.minimap as { enabled: boolean } | undefined)?.enabled).toBe(false);
    expect(handle.getValue()).toBe("await fetch($0)");
    handle.focus();
    expect(focus).toHaveBeenCalled();
    handle.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  test("the host element it is given is the one Monaco mounts into", () => {
    // Pins the `host` argument itself. Passing a different element -- or a fresh one -- would leave the form's body
    // field empty on screen while every value-level assertion above still passed.
    const hosts: HTMLElement[] = [];
    const monaco = {
      editor: {
        create: (host: HTMLElement) => {
          hosts.push(host);
          return { getValue: () => "", focus: () => {}, dispose: () => {} };
        },
      },
    } as unknown as typeof Monaco;
    const host = document.createElement("div");
    createMonacoBody(monaco, () => "typescript")(host, { value: "x", language: null });
    // toBe, not toEqual: two empty <div>s are STRUCTURALLY equal, so `toEqual([host])` passed even when the
    // factory mounted into a different element of its own making. Identity is the entire assertion here.
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toBe(host);
  });

  test("the language hint is mapped through languageId, not passed through raw", () => {
    // `tsx` is a real JSLab Language but NOT a Monaco language id -- Monaco would reject it. The mapping is the
    // whole point of the injected `languageId`, so a factory that forwarded `language` unchanged must fail here.
    const { monaco, created } = fakeMonaco();
    const factory = createMonacoBody(monaco, (language) => (language === "javascript" ? "javascript" : "typescript"));
    factory(document.createElement("div"), { value: "", language: "tsx" });
    expect(created[0]?.language).toBe("typescript");
  });

  test("the textarea fallback is a real editing surface with an accessible name", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const handle = createTextareaBody("Body")(host, { value: "console.log($0)", language: null });
    const field = host.querySelector("textarea");
    expect(field?.value).toBe("console.log($0)");
    expect(field?.getAttribute("aria-label")).toBe("Body");
    if (field) field.value = "changed";
    expect(handle.getValue()).toBe("changed");
    handle.dispose();
    expect(host.querySelector("textarea")).toBeNull();
    host.remove();
  });

  test("the textarea fallback focuses the field itself, not merely its host", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const handle = createTextareaBody("Body")(host, { value: "", language: null });
    handle.focus();
    // A `focus()` that did nothing, or focused the host <div>, would leave the user typing into nowhere.
    expect(document.activeElement).toBe(host.querySelector("textarea"));
    handle.dispose();
    host.remove();
  });
});
