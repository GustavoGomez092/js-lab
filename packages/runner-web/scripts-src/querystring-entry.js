// Task 10 (spec §5.13) / fix round 1: synthetic entry for generating vendor/querystring-es3.js.
//
// `querystring-es3` is not a recognized Node builtin name, so the bare-name trap doesn't apply here -- this
// wrapper exists only to add `escape`/`unescape`, which the package itself doesn't provide (Node's real
// `querystring.escape`/`.unescape` are, in practice, thin wrappers around `encodeURIComponent`/
// `decodeURIComponent`, so re-exposing those directly is a faithful match).
import qs from "../node_modules/querystring-es3/index.js";

// Named, not declared, as `escape`/`unescape`: those are restricted (deprecated-global) names a local
// `const`/`export const` declaration must not shadow (biome's `noShadowRestrictedNames`); an export alias sidesteps
// that without changing what the module actually exports.
const escapeQuery = globalThis.encodeURIComponent;
// Task 9f (item 1): `decodeURIComponent` was exported directly, so malformed percent input -- a lone `"%"`, a
// truncated `"%E0%A4%A"` -- threw `URIError` where Node's `querystring.unescape` returns the input unchanged.
// Node's own implementation wraps the decode and falls back on failure; a runtime whose entire purpose is Node
// compatibility must not diverge on input this ordinary (a hand-written query string is routinely malformed).
const unescapeQuery = function (text) {
  try {
    return globalThis.decodeURIComponent(text);
  } catch {
    return text;
  }
};

// Task 9f (item 1, second half -- found by the test written for the first): both helpers also have to hang off the
// **default** export. `querystring.unescape(...)` via a default import is how Node's own API is normally reached,
// and `querystring-es3`'s own object carries neither helper, so `qs.unescape` was `undefined` -- a `TypeError` at
// the call site. Assigning onto a copy keeps the package's own object untouched and preserves function identity.
const querystring = Object.assign({}, qs, { escape: escapeQuery, unescape: unescapeQuery });

export default querystring;
export const parse = querystring.parse;
export const decode = querystring.decode;
export const stringify = querystring.stringify;
export const encode = querystring.encode;

export { escapeQuery as escape, unescapeQuery as unescape };
