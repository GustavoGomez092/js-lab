# Bun vs Node: what's different in JSLab's Bun runtime

JSLab's **Bun** runtime runs your code with the Bun that ships inside JSLab (1.4.0). Bun aims to be Node-compatible, and most code written for Node runs unchanged. These are the differences you are most likely to notice.

## The three runtimes

Each tab picks one runtime, from the status bar or Actions → Runtime. New tabs open in **Bun**; change that under Settings → General → Default Runtime.

| Runtime | What your code gets | Web View tile |
|---|---|---|
| **Bun** (default) | Bun and Node globals, the full Node API surface, no DOM | — |
| **Browser & Node APIs** | A real page (DOM and web APIs) *plus* a Node compatibility layer | Yes |
| **Browser** | A real page only — no Node APIs at all | Yes |

The two browser runtimes run your code in a WebKit page, so they can render to the **Web View** tile (⌥⌘W, or View → Web View). Your code is bundled before it runs, so `import` from an installed package works in all three.

### What's different in "Browser & Node APIs"

This runtime is a browser page with Node bolted on, not a Node process, so parts of Node behave differently:

- **Only the async APIs are available for files and processes.** `fs/promises`, callback-style `fs.*` and `child_process.exec`/`execFile`/`spawn` work, bridged out to JSLab. The synchronous versions (`fs.readFileSync` and friends) refuse with a message naming the async alternative and offering to switch the tab to Bun. `http`, `net`, `tls`, `dgram`, `worker_threads` and `vm` refuse the same way.
- **`process` is a snapshot.** `env`, `cwd()`, `platform`, `argv` and `versions` are captured when the page loads, and `nextTick` runs on the microtask queue. **`process.memoryUsage()` isn't available here** — use the Bun runtime for it.
- **Shared built-ins aren't always the same object.** `stream`, `events` and `buffer` each carry their own copy of what they depend on, so `new Readable() instanceof EventEmitter` can be `false`, and a `Buffer` produced by one module may not be recognised by another. Code that branches on `instanceof` across these modules can take the wrong branch.
- **A command's environment can differ from Bun's.** A `child_process` call made without an explicit `env` inherits JSLab's own environment rather than the layered one (**Environment Variables**, then the working folder's `.env`) that a Bun run sees. Pass `env` yourself when it matters.
- **`fetch` has no CORS.** It's routed through JSLab, so cross-origin requests succeed. In the **Browser** runtime `fetch` is the page's own, and CORS applies exactly as it would in Safari.

### What's different in both browser runtimes

- **`alert`, `confirm` and `prompt` can't block.** An embedded web view gives them no way to wait for you, so `alert` shows a JSLab notice and returns immediately, `confirm` always returns `false`, and `prompt` always returns `null`. A console warning says so once per run.
- **`import * as ns` can show extra keys.** Packages are bundled in two halves that join inside the page, and a namespace object can carry the default export's own keys as well. The values are the same as under Bun; only enumerating or spreading the namespace (`Object.keys(ns)`, `{...ns}`) differs.
- **The speaker icon tracks live audio only.** A tab shows a speaker icon while an `AudioContext` is running or a media element is playing, and clicking it mutes that tab. An `OfflineAudioContext` render isn't tracked, and a live context stays `suspended` until a user gesture, as the browser's autoplay policy requires.

The rest of this page is about the **Bun** runtime.

## The engine

- Bun runs on JavaScriptCore (the engine in Safari), not V8. Anything tied to V8 behaves differently:
  - The `v8` module is only partly available, and heap snapshots don't use V8's format.
  - Node's `--inspect` flags don't apply.
  - Stack trace text is formatted differently. JSLab maps positions back to your code and renders stacks itself, so the output panel looks the same either way.

## Built-in modules

- `node:inspector`, `node:trace_events` and `node:repl` are partial or missing.
- `node:vm` works, with edge-case differences in how contexts behave.
- `worker_threads` supports most APIs; some options are missing.
- Native addons built on N-API generally work. Addons that use V8's C++ API directly don't.

## Module resolution

- Resolution is looser than Node's, closer to a bundler's: extensionless imports such as `import "./util"` work, and `require` is allowed inside ES modules.
- Packages you install from **NPM Packages** are available in every tab without restarting, through `NODE_PATH`.
- With a **working directory** set, `<working directory>/node_modules` is searched before JSLab's packages.

## Environment and files

- JSLab turns off Bun's automatic `.env` loading. With a working directory, JSLab reads that folder's `.env` itself, after **Environment Variables** and before `JSLAB=1`, so the result is the same in every run.
- With a working directory, `process.cwd()`, `__dirname` and `import.meta.dir` are that folder, and `__filename` and `import.meta.path` are `<working directory>/<tab title>.<extension>`. Relative imports written as string literals resolve there too. An import whose path is computed at run time (`import(name)`) resolves against the run's own folder instead.
- A working folder's `.env` file is read only up to 1 MiB; anything past that limit is ignored. `.env` parsing is JSLab's own, not Bun's: JSLab passes `--no-env-file` to the runner and reads the file itself, so the result is the same regardless of what Bun's own `.env` support does.
- `BUN_OPTIONS` is stripped from every layer of the run's environment; it never reaches your code's process. `NODE_OPTIONS` is passed through unchanged, but the bundled Bun ignores it, so setting it has no effect on a run.
- A working folder's `bunfig.toml` is never applied to a run: JSLab always launches with `--config=/dev/null`, so nothing in that file changes how your code executes.

## Ending a run

- `process.exit()` ends the run after its output is delivered. Code that catches the exit (for example in `try/catch`) doesn't keep running: later output is dropped, and timers or servers it starts are stopped.

## Packages that install differently

- Install scripts (`postinstall` and friends) are blocked unless **Allow install scripts** is on in the NPM sheet or Settings → NPM.
- npm operations use JSLab's own `.npmrc` (Settings → NPM), never your `~/.npmrc`. A git dependency over SSH authenticates through your SSH agent (`SSH_AUTH_SOCK`) or `GIT_SSH_COMMAND`, because npm operations don't see your home folder's `~/.ssh`.
