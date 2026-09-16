/**
 * Task 10 (spec §5.13): the `browser-node` `crypto` polyfill.
 *
 * `randomUUID`, `getRandomValues` and `webcrypto` are the real, native Web Crypto API already on every page --
 * nothing to polyfill there, just re-exposed under Node's names. `createHash`/`createHmac` have no Web Crypto
 * equivalent (`subtle.digest` is async-only; Node's are sync), so they come from a bundled polyfill instead.
 *
 * The two vendor imports below resolve two different ways depending on who's asking:
 * - `bun test`/`tsc` resolve them as ordinary relative imports, against the real `create-hash`/`create-hmac`
 *   dependencies declared in `packages/runner-web/package.json` (see `vendor/create-hash-entry.ts`'s own comment)
 *   -- so a unit test here exercises the genuine hashing implementation, not a stand-in.
 * - `apps/desktop/src/main/bundling/polyfill-plugin.ts` never reads `vendor/create-hash-entry.ts` at all: when it
 *   loads *this* file under its own virtual namespace, it also intercepts these two exact specifiers (by
 *   namespace, not by resolving them as real files) and serves `vendor/create-hash.js`/`vendor/create-hmac.js`'s
 *   pre-flattened, dependency-free text instead -- the same `browser.js` entry, just with every transitive
 *   `require()` already inlined so nothing needs a real `node_modules` at app runtime.
 */
import createHash from "./vendor/create-hash-entry";
import createHmac from "./vendor/create-hmac-entry";

export interface CryptoPolyfill {
  webcrypto: Crypto;
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
  createHash: typeof createHash;
  createHmac: typeof createHmac;
}

export function createCryptoPolyfill(webcrypto: Crypto = globalThis.crypto): CryptoPolyfill {
  return {
    webcrypto,
    randomUUID: () => webcrypto.randomUUID(),
    getRandomValues: (array) => webcrypto.getRandomValues(array as unknown as Uint8Array) as unknown as typeof array,
    createHash,
    createHmac,
  };
}

const cryptoPolyfill = createCryptoPolyfill();
export default cryptoPolyfill;

// Fix round 1 (I1): Node's real `crypto` module supports both `import crypto from 'crypto'` and
// `import { createHash } from 'crypto'` -- the latter is the more common spelling in real code, and it built to
// a hard "no matching export" failure without these. One named export per default-export property, so the two
// import forms can never drift apart again.
export const webcrypto = cryptoPolyfill.webcrypto;
export const randomUUID = cryptoPolyfill.randomUUID;
export const getRandomValues = cryptoPolyfill.getRandomValues;
export { createHash, createHmac };
