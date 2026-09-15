# Bun vs Node: what's different in JSLab's Bun runtime

JSLab's **Bun** runtime runs your code with the Bun that ships inside JSLab (1.4.0). Bun aims to be Node-compatible, and most code written for Node runs unchanged. These are the differences you are most likely to notice.

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

Not yet checked against Bun's compatibility page for Bun 1.4.0.
