#!/bin/bash
# Task 10 (spec §5.13) / fix round 1: regenerates every file in `packages/runner-web/src/polyfills/vendor/`
# from the npm packages pinned in `packages/runner-web/package.json` (`dependencies` + `devDependencies`) plus
# the synthetic entry files in this directory.
#
# Why this exists: the vendored blobs are pre-flattened, dependency-free JavaScript, embedded as text constants
# into Main's own compiled output (see `apps/desktop/src/main/bundling/polyfill-plugin.ts` and the Task 10
# report) -- nothing in the packaged app reads `node_modules` at runtime. Before fix round 1 this recipe existed
# only as prose in each vendor file's header comment, and the synthetic entry files it named did not exist in
# the repo, so the bytes could be read but not regenerated. Running this script end to end reproduces the
# committed vendor files byte-for-byte from a fresh `bun install` (barring an upstream patch release changing
# one of the pinned packages' own source, which is exactly the point: a real diff shows up here for review
# instead of silently changing what a signed build contains).
#
# Usage: bun run packages/runner-web/scripts-src/generate-vendor.sh   (or: bash <this file>)
# Prerequisite: `bun install` at the repo root (the ten devDependencies + two dependencies in
# packages/runner-web/package.json must be present in the root node_modules).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/../src/polyfills/vendor"
cd "$REPO_ROOT"

build() {
  local entry="$1"
  local outfile="$2"
  bun build "$entry" --target=browser --format=esm --minify --outfile="$outfile"
}

prepend_header() {
  local file="$1"
  local header="$2"
  local tmp
  tmp="$(mktemp)"
  printf '%s\n' "$header" >"$tmp"
  cat "$file" >>"$tmp"
  mv "$tmp" "$file"
}

# The ten §5.13 sync builtins. Three (events, url, punycode) are recognized Node builtin names, so
# `Bun.resolveSync` prefers Bun's own internal shim over the real npm package even when installed (measured;
# see the Task 10 report) -- their synthetic entries import the real file by relative path specifically to route
# around that. `assert` and `util` are also builtin names; their entries do the same for the same reason, and
# additionally re-export named members explicitly (see each entry's own comment).
build packages/runner-web/node_modules/buffer/index.js "$OUT_DIR/buffer.js"
build packages/runner-web/node_modules/path-browserify/index.js "$OUT_DIR/path-browserify.js"
build "$SCRIPT_DIR/events-entry.js" "$OUT_DIR/events.js"
build "$SCRIPT_DIR/util-entry.js" "$OUT_DIR/util.js"
build "$SCRIPT_DIR/url-entry.js" "$OUT_DIR/url.js"
build "$SCRIPT_DIR/querystring-entry.js" "$OUT_DIR/querystring-es3.js"
build packages/runner-web/node_modules/string_decoder/lib/string_decoder.js "$OUT_DIR/string_decoder.js"
build "$SCRIPT_DIR/assert-entry.js" "$OUT_DIR/assert.js"
build "$SCRIPT_DIR/stream-entry.js" "$OUT_DIR/stream-browserify.js"
build "$SCRIPT_DIR/punycode-entry.js" "$OUT_DIR/punycode.js"

# `crypto`'s createHash/createHmac. `browser.js`, not the package's `main`/`index.js` -- that entry is
# `module.exports = require('crypto').createHash`, which delegates to Node's real `crypto` and, if built for
# browser target anyway, pulls in a several-hundred-KB internal Bun `node:crypto` shim as a side effect
# (measured; see the Task 10 report).
build packages/runner-web/node_modules/create-hash/browser.js "$OUT_DIR/create-hash.js"
build packages/runner-web/node_modules/create-hmac/browser.js "$OUT_DIR/create-hmac.js"

# Headers: a license identifier (verified by reading each package's own license file -- not inferred from
# `package.json` alone, since minification strips every upstream copyright/permission notice; the full text
# lives in THIRD-PARTY-NOTICES.md, not here), the generation command, and the "do not hand-edit" pointer back
# to this script.
prepend_header "$OUT_DIR/buffer.js" "// Generated (Task 10, spec §5.13): feross/buffer@6.0.3, flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// License: MIT AND BSD-3-Clause -- feross/buffer and base64-js are MIT; the inlined ieee754 is BSD-3-Clause.
// Full license text and copyright lines for every inlined package: THIRD-PARTY-NOTICES.md.
// Do not hand-edit; edit the generation recipe in this script instead."

prepend_header "$OUT_DIR/path-browserify.js" "// Generated (Task 10, spec §5.13): path-browserify@1.0.1, flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// License: MIT. Do not hand-edit."

prepend_header "$OUT_DIR/events.js" "// Generated (Task 10, spec §5.13): events@3.3.0, flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// (entry re-exports EventEmitter/once by name; see scripts-src/events-entry.js.)
// License: MIT. Do not hand-edit."

prepend_header "$OUT_DIR/util.js" "// Generated (Task 10, spec §5.13): util@0.12.5, flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// (entry re-exports promisify/inherits/inspect/format/deprecate/callbackify/types/isArray/isBuffer/debuglog by name.)
// License: MIT. Do not hand-edit."

prepend_header "$OUT_DIR/url.js" "// Generated (Task 10, spec §5.13): url@0.11.4 (deps: punycode, qs), flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// (entry re-exports parse/resolve/resolveObject/format/Url, plus URL/URLSearchParams from globalThis.)
// License: MIT AND BSD-3-Clause -- url and punycode are MIT; the inlined qs is BSD-3-Clause.
// Full license text and copyright lines for every inlined package: THIRD-PARTY-NOTICES.md.
// Do not hand-edit."

prepend_header "$OUT_DIR/querystring-es3.js" "// Generated (Task 10, spec §5.13): querystring-es3@0.2.1, flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// (entry adds escape/unescape via global encodeURIComponent/decodeURIComponent.)
// License: MIT (confirmed against the package's own License.md text; its package.json has no top-level
// \"license\" field, only a legacy \"licenses\" array naming MIT -- checked per fix round 1, I3).
// Full license text and copyright line: THIRD-PARTY-NOTICES.md.
// Do not hand-edit."

prepend_header "$OUT_DIR/string_decoder.js" "// Generated (Task 10, spec §5.13): string_decoder@1.3.0, flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// License: MIT. Do not hand-edit."

prepend_header "$OUT_DIR/assert.js" "// Generated (Task 10, spec §5.13): assert@2.1.0, flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// (entry re-exports ok/fail/equal/.../strictEqual/deepStrictEqual/throws/rejects/ifError/AssertionError/strict.)
// License: MIT. Do not hand-edit."

prepend_header "$OUT_DIR/stream-browserify.js" "// Generated (Task 10, spec §5.13): stream-browserify@3.0.0 (dep: readable-stream), flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// (entry re-exports Readable/Writable/Duplex/Transform/PassThrough/finished/pipeline by name.)
// License: MIT. Do not hand-edit."

prepend_header "$OUT_DIR/punycode.js" "// Generated (Task 10, spec §5.13): punycode@2.3.1, flattened for the browser-node module table.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// (entry re-exports decode/encode/toASCII/toUnicode/ucs2/version by name.)
// License: MIT. Do not hand-edit."

prepend_header "$OUT_DIR/create-hash.js" "// Generated (Task 10, spec §5.13): create-hash@1.2.0 browser.js entry (deps: cipher-base, md5.js, ripemd160, sha.js, inherits), flattened.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// License: MIT AND ISC AND BSD-3-Clause -- create-hash, cipher-base, md5.js, ripemd160, safe-buffer and
// to-buffer are MIT; inherits is ISC; the inlined sha.js is itself (MIT AND BSD-3-Clause).
// Full license text and copyright lines for every inlined package: THIRD-PARTY-NOTICES.md.
// Do not hand-edit."

prepend_header "$OUT_DIR/create-hmac.js" "// Generated (Task 10, spec §5.13): create-hmac@1.1.7 browser.js entry (deps: cipher-base, create-hash, ripemd160, safe-buffer, sha.js, inherits), flattened.
// Regenerate: bash packages/runner-web/scripts-src/generate-vendor.sh (see this file for the full recipe).
// License: MIT AND ISC AND BSD-3-Clause -- create-hmac, create-hash, cipher-base, ripemd160 and safe-buffer are
// MIT; inherits is ISC; the inlined sha.js is itself (MIT AND BSD-3-Clause).
// Full license text and copyright lines for every inlined package: THIRD-PARTY-NOTICES.md.
// Do not hand-edit."

echo "Regenerated all twelve vendor files in $OUT_DIR"
wc -c "$OUT_DIR"/*.js
