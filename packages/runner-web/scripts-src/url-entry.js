// Task 10 (spec §5.13) / fix round 1: synthetic entry for generating vendor/url.js.
//
// `url` is a recognized Node builtin name (same trap as events-entry.js): imported by path, not by bare
// specifier, so the real npm package's `url.js` (which internally `require`s `qs` and `punycode` -- both real
// npm dependencies) is what gets inlined, not Bun's own internal `url` shim.
//
// `URL`/`URLSearchParams` are not polyfilled at all: the npm `url` package predates the WHATWG URL API, so
// these are re-exposed straight from the page's own native globals.
import { format, parse, resolve, resolveObject, Url } from "../node_modules/url/url.js";

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export { format, parse, resolve, resolveObject, Url };
export default { parse, resolve, resolveObject, format, Url, URL, URLSearchParams };
