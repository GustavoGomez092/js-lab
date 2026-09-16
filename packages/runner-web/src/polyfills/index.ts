/**
 * Task 10 (spec §5.13): the testable half of the `browser-node` Node API layer.
 *
 * This barrel is for `packages/runner-web/test/polyfills.test.ts` and anything else that wants the pure factories
 * directly. It is **not** consumed by `apps/desktop/src/main/bundling/polyfill-plugin.ts` -- that file text-imports
 * `process.ts`/`os.ts`/`crypto.ts` individually (see each file's own comment for why), and reads the ten sync
 * builtins straight out of `./vendor/*.js`. Nothing here is wired into `packages/runner-web/src/index.ts`'s own
 * barrel or `bootstrap.ts`: the polyfills are consumed entirely inside a tab's bundled code, never by the runner
 * bootstrap itself (see the Task 10 report).
 */

export { type CryptoPolyfill, createCryptoPolyfill } from "./crypto";
export { createOsPolyfill, type OsCpuSnapshot, type OsPolyfill, type OsSnapshot } from "./os";
export { createProcessPolyfill, type ProcessPolyfill, type ProcessSnapshot } from "./process";
