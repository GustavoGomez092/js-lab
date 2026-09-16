/**
 * `create-hash`/`create-hmac` ship no types, and their `main` field (`index.js`) delegates to Node's real
 * `crypto` -- only the `browser.js` entry (what `create-hash-entry.ts`/`create-hmac-entry.ts` import) has the
 * pure-JS implementation this polyfill needs, so a `@types/*` package would describe the wrong file anyway.
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
