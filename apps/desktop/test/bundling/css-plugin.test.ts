import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cssInject, cssModuleSource } from "../../src/main/bundling/css-plugin";
import { NotARegularFileError } from "../../src/main/fs/bounded-read";

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

type OnLoad = (args: { path: string; namespace: string }) => unknown;

/** The single `onLoad` hook `cssInject` registers, pulled out of a stub builder. */
function onLoadHook(): OnLoad {
  const captured: OnLoad[] = [];
  const builder = {
    onResolve() {},
    onLoad(_constraints: { filter: RegExp }, cb: OnLoad) {
      captured.push(cb);
    },
  };
  cssInject().setup(builder as never);
  const hook = captured[0];
  if (!hook) throw new Error("onLoad was never registered");
  return hook;
}

describe("cssInject", () => {
  test("its onLoad hook reads the CSS file from disk and returns loader output built from cssModuleSource", async () => {
    const cssPath = join(dir, "styles.css");
    await writeFile(cssPath, "a { color: blue; }");

    const result = (await onLoadHook()({ path: cssPath, namespace: "file" })) as {
      contents: string;
      loader: string;
    };

    expect(result.loader).toBe("js");
    expect(result.contents).toBe(cssModuleSource("a { color: blue; }"));
  });

  /**
   * F-CSS. This read is exempt from a size cap on purpose -- a cap would break legitimately large stylesheets --
   * but the exemption was written as though size were the only hazard. `Bun.file(path).text()` on a FIFO never
   * settles, and the path here is whatever Bun resolved for the build, i.e. it can come straight out of
   * `node_modules`. A third-party `.css` that is a FIFO hung the bundle promise forever. The size exemption still
   * stands; what the file *is* now gets checked before it is read.
   */
  test("its onLoad hook refuses a .css that is a FIFO instead of hanging on it forever", async () => {
    const cssPath = join(dir, "styles.css");
    expect(await Bun.spawn(["mkfifo", cssPath]).exited).toBe(0);

    await expect(onLoadHook()({ path: cssPath, namespace: "file" })).rejects.toBeInstanceOf(NotARegularFileError);
  }, 5000);

  test("its onLoad hook still reads a stylesheet far larger than any byte cap would allow", async () => {
    // The exemption is the point: a 12 MB stylesheet is unusual but legitimate, and must not be refused.
    const cssPath = join(dir, "huge.css");
    const huge = `a { color: blue; }${" ".repeat(12 * 1024 * 1024)}`;
    await writeFile(cssPath, huge);

    const result = (await onLoadHook()({ path: cssPath, namespace: "file" })) as { contents: string };

    expect(result.contents).toBe(cssModuleSource(huge));
  });
});
