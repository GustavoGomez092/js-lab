/**
 * Task 10 (spec §5.13): the real source `crypto.ts` imports for its `createHmac` polyfill.
 * See `create-hash-entry.ts` for why this file exists and how production bundling bypasses it.
 */
export { default } from "create-hmac/browser.js";
