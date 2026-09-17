import type { BunPlugin } from "bun";

/**
 * Builds the JS source a `.css` import is replaced with: a module whose only job is to append a `<style>` element
 * carrying the stylesheet text (spec §5.12, §5.11's `cssInject`). The CSS text is embedded in a template literal,
 * so anything that would end the literal early or splice in an expression -- a backslash, a backtick, or `${` --
 * is escaped first. Order matters: backslashes must be doubled before the characters that follow get their own
 * backslash added, or those added backslashes would themselves be doubled.
 */
export function cssModuleSource(css: string): string {
  const escaped = css.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return [
    'const __jlStyle = document.createElement("style");',
    `__jlStyle.textContent = \`${escaped}\`;`,
    "document.head.appendChild(__jlStyle);",
    "",
  ].join("\n");
}

/** `cssInject` (spec §5.12): the third of `Bun.build`'s three plugins. A `.css` import becomes an injected `<style>`. */
export function cssInject(): BunPlugin {
  return {
    name: "jslab-css-inject",
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const contents = await Bun.file(args.path).text();
        return { contents: cssModuleSource(contents), loader: "js" };
      });
    },
  };
}
