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

## Phase A (mechanism, Tasks 1–7)

Each row is the automated gate at that task's commit, measured on the real Bun 1.4.0 gate described above.
`@jslab/ui` prints **two** totals lines (`./test` and `./isolated`); every figure here is their sum.

| Task | Commit | What it added | `bun run test` |
| --- | --- | --- | ---: |
| 1 | `67c7ceb` | i18next pinned exactly, license gate | 1385 |
| 1 fix | `2c6351a` | license gate also imports the package | 1386 |
| 2 | `bfdc7d7` | `packages/shared/src/locale.ts` resolver | 1391 |
| 3 | `56be885` | `withLocale`, both windows open on a locale-bearing URL | 1396 |
| 4 | `8e62475` | locale files staged into the packaged build | 1399 |
| 5 | `7307cd0` | Main's dependency-free `t()` | 1405 |
| 6 | `c68e369` | UI i18next init from `?lng=` | 1415 |
| 7 | this commit | lint rule, key check, CI step, `translating.md` | 1441 |

### Phase A exit gate

Run from the repo root with the toolchain `PATH` above. All four exit 0:

```bash
bun run lint --max-diagnostics=300
bun run typecheck
bun run i18n:check
bun run test
```

- **`lint`**: exit 0 — **14 warnings, 16 infos**, 534 files, Biome **2.5.13**. Unchanged from the baseline:
  enabling `noJsxLiterals` added **no** diagnostic, because the pre-existing offenders are exempted by name.
- **`typecheck`**: exit 0 across **13 packages**.
- **`i18n:check`**: exit 0, printing `i18n: 2 keys in en.json (bootstrap)` and `i18n: ok`.
- **`bun run test`**: **1441 pass, 0 fail**.

### Carried debt this phase records

- [ ] **`noJsxLiterals` exemptions.** Eight components still hold hard-coded JSX text and are named one file at
  a time in `biome.json` → `overrides`: `env/EnvVarsSheet.tsx`, `npm/NpmSheet.tsx`, `output/EntryRow.tsx`,
  `output/ValueView.tsx`, `shell/StatusBar.tsx`, `shell/Toolbar.tsx`, `shell/parts.tsx`, `tabs/TabBar.tsx`.
  Most are typographic marks (`×`, `▶`, `■`, `+`, `⌘↵`, `…`, `:`); two are real prose, both in `ValueView.tsx`
  (`… {n} more characters` and `… {n} more`). Phase B rewrites these files and must empty that list. A unit
  test pins the list, so adding a ninth file is a deliberate, reviewable diff.
- [ ] **The check runs in `--bootstrap` mode.** The size floor (`MIN_KEYS` = 464), the committed `keys.json`
  manifest and the unused-key sweep cannot be true until the extraction sweep produces the real catalogue.
  The unknown-key check, the per-locale `extra` check and the coverage ratchet run now. Task 11 drops the flag
  from `apps/ui/package.json` and from `.github/workflows/ci.yml` in the same commit as the full catalogue.
