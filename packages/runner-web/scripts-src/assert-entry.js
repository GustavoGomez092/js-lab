// Task 10 (spec §5.13) / fix round 1: synthetic entry for generating vendor/assert.js.
//
// `assert` is a recognized Node builtin name (same trap as events-entry.js): imported by path so the real npm
// package (not Bun's own internal `assert` shim) is what gets inlined. Named members are re-exported explicitly
// for the same reliability reason as util-entry.js (named-export synthesis proved unreliable once the flattened
// output crosses into a second, separate `Bun.build` call -- the real production path).
import assert from "../node_modules/assert/build/assert.js";

export default assert;
export const ok = assert.ok;
export const fail = assert.fail;
export const equal = assert.equal;
export const notEqual = assert.notEqual;
export const deepEqual = assert.deepEqual;
export const notDeepEqual = assert.notDeepEqual;
export const strictEqual = assert.strictEqual;
export const notStrictEqual = assert.notStrictEqual;
export const deepStrictEqual = assert.deepStrictEqual;
export const notDeepStrictEqual = assert.notDeepStrictEqual;
export const throws = assert.throws;
export const rejects = assert.rejects;
export const doesNotThrow = assert.doesNotThrow;
export const doesNotReject = assert.doesNotReject;
export const ifError = assert.ifError;
export const AssertionError = assert.AssertionError;
export const strict = assert.strict;
