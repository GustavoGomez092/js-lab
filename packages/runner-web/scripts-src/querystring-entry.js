// Task 10 (spec §5.13) / fix round 1: synthetic entry for generating vendor/querystring-es3.js.
//
// `querystring-es3` is not a recognized Node builtin name, so the bare-name trap doesn't apply here -- this
// wrapper exists only to add `escape`/`unescape`, which the package itself doesn't provide (Node's real
// `querystring.escape`/`.unescape` are, in practice, thin wrappers around `encodeURIComponent`/
// `decodeURIComponent`, so re-exposing those directly is a faithful match).
import qs from "../node_modules/querystring-es3/index.js";

export default qs;
export const parse = qs.parse;
export const decode = qs.decode;
export const stringify = qs.stringify;
export const encode = qs.encode;
// Named, not declared, as `escape`/`unescape`: those are restricted (deprecated-global) names a local
// `const`/`export const` declaration must not shadow (biome's `noShadowRestrictedNames`); an export alias sidesteps
// that without changing what the module actually exports.
const escapeQuery = globalThis.encodeURIComponent;
const unescapeQuery = globalThis.decodeURIComponent;

export { escapeQuery as escape, unescapeQuery as unescape };
