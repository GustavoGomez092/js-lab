// Task 10 (spec §5.13) / fix round 1: synthetic entry for generating vendor/events.js.
//
// `events` is itself a recognized Node builtin name -- `import EE from "events"` here would resolve to Bun's
// own internal browser shim instead of the real npm package (measured: `Bun.resolveSync("events", cwd)` returns
// `"node:events"` even with the real package installed), so this imports the real file by path instead.
//
// The npm package's own module shape (`module.exports = EventEmitter; module.exports.once = once;`) assigns
// `once` onto the exported identifier rather than via a literal `exports.foo =`/`module.exports.foo =`
// assignment, which is the one pattern Bun's CJS->ESM named-export synthesis picks up automatically -- so
// without this wrapper, `import { EventEmitter } from 'events'` would fail to build.
import EE from "../node_modules/events/events.js";

export default EE;
export const EventEmitter = EE;
export const once = EE.once;
