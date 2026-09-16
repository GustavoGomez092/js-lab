/**
 * Task 10 (spec §5.13): `polyfill-plugin.ts` imports `@jslab/runner-web/polyfills/*` with `{ type: "text" }`.
 *
 * TypeScript resolves a bare specifier against the *real* target file whenever one exists, regardless of import
 * attributes it doesn't understand (it has no built-in notion of `type: "text"`) -- an ambient `declare module`
 * for the real `.ts`/`.js` subpath would simply lose to that real resolution and never apply. So
 * `packages/runner-web/package.json`'s `exports` map publishes each of these under a **`.txt`-suffixed** subpath
 * that maps to the same real file: TypeScript cannot resolve `*.txt` as source, so it falls back to the ambient
 * declaration below (the same mechanism any bundler's raw-text asset import relies on), while Bun's own resolver
 * follows the exports map to the real file exactly as it does for any other subpath.
 */
declare module "@jslab/runner-web/polyfills/*.txt" {
  const content: string;
  export default content;
}

/**
 * `apps/desktop`'s own `tsc -p .` type-checks `@jslab/runner-web`'s source transitively (its `package.json`
 * `exports` point at real `.ts` files, not pre-built `.d.ts`), which reaches `crypto.ts`'s two vendor-entry
 * imports -- but a *separate* `tsc` invocation never auto-includes another package's own ambient `.d.ts` files
 * just because it resolves an unrelated `.ts` file in the same directory (TS only honors a `.d.ts` a project's
 * own `tsconfig.json` `include` actually reaches). `packages/runner-web/src/polyfills/vendor/browser-entries.d.ts`
 * declares the identical module for `@jslab/runner-web`'s own `tsc` run; this is that same declaration, duplicated
 * for this program.
 */
declare module "create-hash/browser.js" {
  function createHash(algorithm: string): {
    update(data: string | Uint8Array, inputEncoding?: string): ReturnType<typeof createHash>;
    digest(encoding: "hex" | "base64" | "latin1"): string;
    digest(): Uint8Array;
  };
  export default createHash;
}

declare module "create-hmac/browser.js" {
  function createHmac(
    algorithm: string,
    key: string | Uint8Array,
  ): {
    update(data: string | Uint8Array, inputEncoding?: string): ReturnType<typeof createHmac>;
    digest(encoding: "hex" | "base64" | "latin1"): string;
    digest(): Uint8Array;
  };
  export default createHmac;
}
