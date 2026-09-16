// Task 10 (spec §5.13) / fix round 1: synthetic entry for generating vendor/util.js.
//
// `util` is a recognized Node builtin name (same trap as events-entry.js/url-entry.js): imported by path.
// Measured: even though `util.js`'s own source uses literal `exports.foo = ...` assignments (which Bun *does*
// synthesize named exports from when building this file standalone), that synthesis did not carry through once
// the flattened output was fed back into a *second*, separate `Bun.build` call (the real production path) --
// so the named members are re-exported explicitly here too, for the same reliability as every other entry.
import util from "../node_modules/util/util.js";

export default util;
export const promisify = util.promisify;
export const inherits = util.inherits;
export const inspect = util.inspect;
export const format = util.format;
export const deprecate = util.deprecate;
export const callbackify = util.callbackify;
export const types = util.types;
export const isArray = util.isArray;
export const isBuffer = util.isBuffer;
export const debuglog = util.debuglog;
