# JSLab

An open-source JavaScript and TypeScript playground for the desktop. Write code and see results next to each line as you type.

JSLab is MIT licensed and under active development. See `docs/superpowers/specs/2026-09-12-jslab-design.md` for the design and `docs/superpowers/plans/` for the roadmap.

## Development

### Prerequisites

- macOS (arm64).
- [Bun](https://bun.sh) 1.3.13 or newer. CI and the packaged app use the Bun 1.4.0 that Electrobun bundles.
- [Hutch](https://github.com/blackboardsh/hutch) **0.24.3**, installed and on your `PATH`. `bun install` runs `hutch electrobun sync` to fetch the pinned Electrobun 2.0.1 devkit and fails loudly without Hutch. Hutch installs to `~/.hutch/bin`; shells that don't load your profile need `export PATH="$HOME/.hutch/bin:$PATH"` first.
- **Never run `hutch upgrade`.** The Electrobun version and devkit are pinned to Hutch 0.24.3.

```bash
bun install
bun run test        # unit and integration tests for every package
bun run typecheck
bun run lint
```

### Launching the app from scripts

Scripted or background launches (test harnesses, QA scripts, CI jobs) must start the app with a working directory on an internal disk. When the working directory is on an external or removable volume, macOS asks for removable-volume access. A background launch can't show that prompt, so the app hangs at startup. Launching from Finder, or from an interactive terminal where the prompt can appear, is not affected.

## Layout

- `apps/desktop`: Electrobun main process
- `apps/ui`: React + Monaco webview UI
- `packages/*`: shared libraries (transform, serializer, runner, schemas)
