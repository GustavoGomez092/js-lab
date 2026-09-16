// Task 10 (spec §5.13) / fix round 1: synthetic entry for generating vendor/punycode.js.
//
// `punycode` is a recognized Node builtin name (same trap as events-entry.js): imported by path so the real
// npm package (not Bun's own internal `punycode` shim) is what gets inlined. `module.exports = punycode` (a
// pre-built object, not a literal `exports.foo =` assignment per member) doesn't get automatic named-export
// synthesis, so each member is re-exported explicitly here.
import punycode from "../node_modules/punycode/punycode.js";

export default punycode;
export const decode = punycode.decode;
export const encode = punycode.encode;
export const toASCII = punycode.toASCII;
export const toUnicode = punycode.toUnicode;
export const ucs2 = punycode.ucs2;
export const version = punycode.version;
