# Choosing a runtime

Each tab runs its code in one of three runtimes. Pick one from the status bar's runtime switcher or
Actions → Runtime; the default for new tabs is **Bun**, changeable under Settings → General → Default Runtime
(`run.defaultRuntime`).

| Runtime | What your code gets | Web View tile |
|---|---|---|
| **Bun** (default) | Bun and Node globals, the full Node API surface, no DOM | — |
| **Browser & Node APIs** | A real page (DOM and web APIs) *plus* a Node compatibility layer | Yes |
| **Browser** | A real page only — no Node APIs at all | Yes |

## Bun

The default. Your code runs in a separate Bun process with the full Node-compatible API surface — `fs`, `path`,
`child_process`, `http`, and so on — and no DOM. Use it for scripts, data processing, algorithm sketches and
anything that doesn't need a page. See [Bun vs Node](bun-vs-node.md) for the differences from a plain Node
process.

## Browser & Node APIs

Your code runs inside a real WebKit page — `document`, `canvas`, `requestAnimationFrame`, and everything else
a browser provides — plus a Node compatibility layer bridged out to JSLab: `fs/promises`, callback-style
`fs.*`, `child_process.exec`/`execFile`/`spawn`, and a `fetch` with no CORS restriction. Use it when you want
to render something (canvas, React, Three.js, Web Audio) but still need to read a file or spawn a process. The
synchronous `fs` functions, along with `http`, `net`, `tls`, `dgram`, `worker_threads` and `vm`, aren't
available here — see [Bun vs Node](bun-vs-node.md) for what refuses and why.

## Browser

A real page with no Node APIs at all — the same as opening a blank HTML page in Safari, with your bundled code
running in it. `fetch` behaves like a real browser's, CORS included.

## The Web View

Both browser runtimes render into a **Web View** tile beside the console. Toggle it with <kbd>⌥⌘W</kbd>,
View → Web View, or the status bar; it's per tab and comes back after a relaunch. `document`, canvas animation,
React, Three.js and Web Audio all run as they would in a browser, and packages you install are bundled into
the page for you. Logging a page element shows its opening tag, attributes and child count, and expands to its
markup. A tab playing audio shows a speaker icon in the tab bar; click it to mute that tab.

## What's different about the browser runtimes

A handful of things behave differently just because the code runs inside an embedded web view rather than a
terminal:

- `alert`, `confirm` and `prompt` can't block: `alert` shows a JSLab notice and returns immediately, `confirm`
  always returns `false`, and `prompt` always returns `null`.
- `import * as ns` can enumerate extra keys on the namespace object, because packages are bundled in two halves
  that join inside the page. The values themselves are unaffected — only `Object.keys(ns)` / `{...ns}` differ.
- The tab's speaker icon only tracks *live* audio: an `OfflineAudioContext` render isn't shown, and a live
  context stays `suspended` until a user gesture, per the browser's autoplay policy.

Full details, including everything specific to **Browser & Node APIs**, are in
[Bun vs Node](bun-vs-node.md).
