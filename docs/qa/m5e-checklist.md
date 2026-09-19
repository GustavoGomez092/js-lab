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

## Translation provenance

- [x] **`en` is complete and real.** Extracted from copy that shipped in M1–M4; no string was invented. 760 keys.
- [ ] **Native-speaker review of `es`** — the seeded strings are drafts. Unchecked until a Spanish speaker has read them.
- [ ] **Native-speaker review of `ja`** — as above.
- [ ] **Native-speaker review of `zh`** — as above.
- [ ] **Native-speaker review of `pt`** — as above.
- [ ] **Full coverage for all four locales.** An M6 parity-gate obligation, verified with `bun run --cwd apps/ui i18n:check --strict`. Out of scope for M5e; see `docs/user/translating.md`.

Do not tick a review box on the strength of the implementation plan, an automated translation, or a spot check
by a non-speaker. The point of shipping a small seed with English fallback is that an unreviewed string is
absent rather than wrong.

**What the four files actually contain, stated plainly.** 25 seeded keys each, out of a 760-key catalogue —
3.3% per language, 100 strings of the 3040 that full coverage would mean. The values are **drafts produced
during implementation and read by no native speaker of any of the four languages.** They were kept to short,
unambiguous chrome — the eleven menu section titles, seven settings tab names, five command verbs,
`files.cancel` and `settings.restartRequired` — where the correct term is not in dispute. No term of art
(`Auto Log`, `magic comment`, `logpoint`, `loop protection`, `spare`, `trailing comma`) is seeded, because
machine or unreviewed output for those is wrong in ways the reader cannot detect.

Coverage recorded in `apps/ui/src/i18n/coverage.json` is `es 23, ja 25, zh 25, pt 24` — not 25 each, because a
value identical to English is not counted as a translation: `NPM` is a product name in all five, `General` and
`Editor` are already Spanish, and `Editor` is already Portuguese. Those are correct answers that score zero,
which is the gate behaving as designed (`apps/ui/src/i18n/check.ts`).

Provenance cannot be recorded inside the locale files themselves: JSON carries no comments, and any extra key
would be a key `en.json` lacks, which the check fails by design. This checklist and `docs/user/translating.md`
are therefore the only provenance surfaces — keep them in step with the files.

### Size floor

`MIN_KEYS` was ratcheted 464 → 700 in this task (`apps/ui/src/i18n/check.ts`). 464 was the pre-sweep count and
sat 296 keys below the shipped 760, so it would have stayed silent through a catalogue that lost a third of
itself. `keys.json` does not already cover that case: the extractor rewrites the manifest *from* `en.json`, so
after a regeneration against a truncated tree the two agree perfectly and every drift list is empty — the floor
is then the only remaining check. 700 keeps ~60 keys of headroom so a legitimate deletion needs no edit here.

## Layout under translation (Task 14)

### What the width budget is, and what it is not

`apps/ui/src/i18n/width.ts` caps the length of 27 short labels — the eleven menu titles, the eight settings tab
names, the "Restart required" badge, two status-bar items, the three runtime options and the palette
placeholder. It counts columns, not pixels: a CJK character counts two, a combining accent none.

**It does not check layout, and nothing else does either.** The unit suite runs under happy-dom, which has no
layout engine — `getBoundingClientRect()` returns zeros and text is never measured — so no test in this
repository can assert that a translated label fits its control.

> [!IMPORTANT]
> The M5e plan says the real check is "the screenshot pass in Task 15". **It is not.** Task 15 contains two
> `app.screenshot()` calls that assert nothing — one of them wrapped in `.catch(() => {})` — and no baseline
> image is compared to anything. There is no automated layout coverage for any locale. The boxes below are the
> only real check, and none of them has been performed.

The one genuine browser measurement JSLab has is the output filter-chip row (commit `59a7b62`, ruling
`R-UI9-COUNTS-1`): worst-case CJK with three-digit counts came out ~32% wider with **no** new wrapping and
**no** truncation. The chips are therefore deliberately left out of the budget — a real measurement beats a
column count — and that 32% is a pixel figure that neither derives nor validates the column numbers.

### Manual checks (none performed)

- [ ] **Menu bar in `ja` and `zh`.** Set Settings → General → Language to Japanese, restart, then Chinese.
      Every menu-bar section title is fully visible; the bar does not crowd, clip or reflow.
- [ ] **Settings nav column in `es` and `pt`.** All eight tab labels fit the 180px column without wrapping or
      being cut off. `Compilación` (11 columns) and `Formatação` (10) are the long ones.
- [ ] **Status bar at minimum window width, CJK locale.** Run-state text, the Safe Mode badge, the layout
      toggle and both selects stay on one line without overlapping — the row is `white-space: nowrap`.
- [ ] **"Restart required" badge in `es`.** `Requiere reiniciar` (18 columns, the widest shipped translation)
      sits beside the Language field label without pushing the control off its row.
- [ ] **The restart notice.** With the main window open, change the language. A dismissible info banner appears
      in the main window naming the restart, and clears itself after 8s (`info`, `NOTICE_AUTO_DISMISS_MS`).
- [ ] **`<html lang>`.** With VoiceOver on and a `ja` UI, the interface is announced in a Japanese voice rather
      than an English one reading Japanese text.
