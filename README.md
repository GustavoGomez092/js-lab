# JSLab

An open-source JavaScript and TypeScript playground for the desktop. Write code and see results next to each line as you type.

JSLab is MIT licensed and under active development. See `docs/superpowers/specs/2026-09-12-jslab-design.md` for the design and `docs/superpowers/plans/` for the roadmap.

## Development

Requirements: macOS (arm64), [Bun](https://bun.sh) 1.3.13 or newer. CI and the packaged app use Bun 1.4.0.

```bash
bun install
bun run test        # unit and integration tests for every package
bun run typecheck
bun run lint
```

## Layout

- `apps/desktop`: Electrobun main process
- `apps/ui`: React + Monaco webview UI
- `packages/*`: shared libraries (transform, serializer, runner, schemas)
