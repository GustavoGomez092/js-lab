# M5e Manual QA Checklist

Internationalisation: the `i18next` runtime, locale resolution, the extracted string catalogue and the language
switcher.

## Baseline at 4045dbd

Measured on branch `feat/jslab-m5e` at commit `4045dbd` (the merge of `origin/main` into this branch), in a fresh
worktree, **before** any M5e change. Every later "expected: PASS" in the M5e plan means *these* numbers plus the
tests that task adds — not a figure remembered from another milestone.

> [!NOTE]
> The M5e plan's Task 1 names this baseline `## Baseline at 7f696bd`. That commit is a real ancestor but sits
> **18 commits behind** the branch point measured here, so the heading records the commit actually measured.

> [!IMPORTANT]
> **The plan's devkit setup command does not work.** Task 1 says to run
> `cp -a "$HOME/.hutch/releases/electrobun/2.0.1/devkit" apps/desktop/.hutch/devkit`, but that release tree
> contains no `devkit` directory — only per-platform folders (`macos-arm64`). Copying is the wrong mechanism:
> `apps/desktop`'s own `postinstall` already runs `hutch electrobun sync`, which *projects* the devkit into
> `apps/desktop/.hutch/devkit` and then strips the legacy `baseUrl` via `scripts/devkit-tsconfig.ts`. The
> postinstall only needs `hutch` to be reachable, so install with it on `PATH`:
>
> ```bash
> export PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$HOME/.hutch/bin:$PATH"
> bun --version   # must print 1.4.0
> bun install --frozen-lockfile
> ```
>
> With `hutch` absent from `PATH` the postinstall exits 1, which aborts the install and leaves a half-linked
> tree — `happy-dom` dangles and the UI suites then report a plausible-looking but fake test count.

The suite gate is the **real** two-Bun form. `bun14 run test` uses 1.4.0 only as the task runner, while each
package's script is `bun test ./test`, so the inner binary would still come from `PATH`. Use a bare
`bun run test` under the toolchain `PATH` above, never a bare root `bun test` (a single process cross-contaminates
globals and invents ~250 failures).

- **`bun run lint --max-diagnostics=300`**: exit 0 — **14 warnings, 16 infos** (unchanged from the M4 baseline).
- **`bun run typecheck`**: exit 0 across **13 packages**, each reporting individually.
- **`bun run test`** (Bun 1.4.0): **1383 pass, 0 fail**. Banner set: `bun test v1.4.0 (34cbb9a40)` — a single
  distinct banner, confirming every inner binary was 1.4.0.

Per-package totals making up the 1383:

| Package | Pass | Package | Pass |
| --- | ---: | --- | ---: |
| `@jslab/desktop` | 536 | `@jslab/transform` | 67 |
| `@jslab/ui` (`./test`) | 356 | `@jslab/shared` | 62 |
| `@jslab/runner-web` | 118 | `@jslab/npm` | 52 |
| `@jslab/ui` (`./isolated`) | 43 | `@jslab/rpc-schema` | 45 |
| `@jslab/serializer` | 42 | `@jslab/runner-bun` | 29 |
| `@jslab/e2e` | 11 | `@jslab/runner-shared` | 9 |
| `@jslab/themes` | 8 | `@jslab/test-registry` | 5 |
