/**
 * Task 10 (spec §5.13): the real source `crypto.ts` imports for its `createHash` polyfill.
 *
 * Resolves normally here (a real relative import against a real `create-hash` dependency, per
 * `packages/runner-web/package.json`) so `bun test`/`tsc` exercise the genuine implementation with no bundler
 * involved. `apps/desktop/src/main/bundling/polyfill-plugin.ts` never reads this file at all: it intercepts this
 * exact specifier (by namespace, since it only matches imports made *from inside* the plugin's own virtual
 * `crypto` module) and serves `vendor/create-hash.js`'s pre-flattened, dependency-free text instead. Both paths
 * carry the same `create-hash@1.2.0` `browser.js` entry -- see the Task 10 report for why `browser.js` and not
 * `index.js` (the `main` field delegates to Node's real `crypto`, which does not exist inside a page).
 */
export { default } from "create-hash/browser.js";
