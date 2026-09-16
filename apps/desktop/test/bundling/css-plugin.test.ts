import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cssInject, cssModuleSource } from "../../src/main/bundling/css-plugin";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-css-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cssModuleSource", () => {
  test("wraps CSS text into a module that appends a <style> element with that text", () => {
    const source = cssModuleSource("body { color: red; }");

    const appended: Array<{ textContent?: string }> = [];
    const document = {
      head: { appendChild: (el: { textContent?: string }) => appended.push(el) },
      createElement: (tag: string) => ({ tagName: tag }),
    };
    new Function("document", source)(document);

    expect(appended).toHaveLength(1);
    expect(appended[0]?.textContent).toBe("body { color: red; }");
  });

  test("escapes characters that would otherwise break out of the generated template literal", () => {
    const tricky = 'content: "a`b"; /* ${evil} */\n\\backslash';
    const source = cssModuleSource(tricky);

    const appended: Array<{ textContent?: string }> = [];
    const document = {
      head: { appendChild: (el: { textContent?: string }) => appended.push(el) },
      createElement: (tag: string) => ({ tagName: tag }),
    };
    // Throws a SyntaxError if the escaping is wrong (an unescaped ` or ${ would break out of the template).
    new Function("document", source)(document);

    expect(appended[0]?.textContent).toBe(tricky);
  });
});

describe("cssInject", () => {
  test("its onLoad hook reads the CSS file from disk and returns loader output built from cssModuleSource", async () => {
    const cssPath = join(dir, "styles.css");
    await writeFile(cssPath, "a { color: blue; }");

    type OnLoad = (args: { path: string; namespace: string }) => unknown;
    const captured: OnLoad[] = [];
    const builder = {
      onResolve() {},
      onLoad(_constraints: { filter: RegExp }, cb: OnLoad) {
        captured.push(cb);
      },
    };
    cssInject().setup(builder as never);
    const onLoadCallback = captured[0];
    if (!onLoadCallback) throw new Error("onLoad was never registered");

    const result = (await onLoadCallback({ path: cssPath, namespace: "file" })) as {
      contents: string;
      loader: string;
    };

    expect(result.loader).toBe("js");
    expect(result.contents).toBe(cssModuleSource("a { color: blue; }"));
  });
});
