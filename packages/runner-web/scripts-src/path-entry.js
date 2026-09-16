// Task 10 (spec §5.13) / fix round 2: synthetic entry for generating vendor/path-browserify.js.
//
// `path` is a recognized Node builtin name (same trap as events-entry.js): imported by path so the real npm
// package (not Bun's own internal `path` shim) is what gets inlined.
//
// `path-browserify/index.js` ends with `module.exports = posix` -- a single object assignment, not a literal
// `exports.foo =`/`module.exports.foo =` per member -- which is exactly the shape Bun's CJS->ESM named-export
// synthesis does not pick up (the same class of gap `stream-entry.js`/`punycode-entry.js` already route around).
// `path` was the one of the ten §5.13 sync builtins built directly from the package entry with no synthetic
// entry, so `import { join } from 'path'` failed to build in both the bare and `node:`-prefixed spellings
// (fix round 2, B0/functional gap) even though the default form (`import path from 'path'`) worked.
import path from "../node_modules/path-browserify/index.js";

export default path;
export const resolve = path.resolve;
export const normalize = path.normalize;
export const isAbsolute = path.isAbsolute;
export const join = path.join;
export const relative = path.relative;
export const dirname = path.dirname;
export const basename = path.basename;
export const extname = path.extname;
export const format = path.format;
export const parse = path.parse;
export const sep = path.sep;
export const delimiter = path.delimiter;
export const win32 = path.win32;
export const posix = path.posix;
