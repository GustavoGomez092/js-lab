// Task 10 (spec §5.13) / fix round 1: synthetic entry for generating vendor/stream-browserify.js.
//
// `stream-browserify` is not a recognized Node builtin name, so the bare specifier resolves to the real npm
// package normally (no path-import workaround needed here, unlike events/url above).
//
// The package assigns its named members onto the exported identifier (`Stream.Readable = require(...)` where
// `Stream === module.exports`), which Bun's CJS->ESM named-export synthesis does not pick up (it only catches a
// literal `exports.foo =`/`module.exports.foo =` assignment) -- without this wrapper, `import { Readable } from
// 'stream'` would fail to build.
import Stream from "stream-browserify";

export default Stream;
export const Readable = Stream.Readable;
export const Writable = Stream.Writable;
export const Duplex = Stream.Duplex;
export const Transform = Stream.Transform;
export const PassThrough = Stream.PassThrough;
export const finished = Stream.finished;
export const pipeline = Stream.pipeline;
