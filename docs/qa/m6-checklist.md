# M6 Manual QA Checklist

Shipping: the About dialog and open-source notices, the user manual, the §23 performance budgets, and the two
M6 rows that were already awaiting a human (file associations and the Help links).

Every item below is something **no automated test can close**. Where a claim *is* covered automatically, this
file says so and names the test, so a tick here means a person confirmed the part a harness cannot reach — not
that the feature was never tested.

## What is deliberately not here

Signing, notarization, the updater and the Homebrew cask (PL-01, PL-03, PL-04, ST-09) are **out of scope** by
the owner's decision of 2026-09-19: JSLab is open source and will not pay for an Apple Developer ID. Nothing
in this checklist asks you to verify them.

## Build to test against

These need a **packaged** build, not `hutch run build:dev` — three of the items below are specifically about
what happens inside the app bundle.

```bash
bun run build:cli                     # the CLI is copied into the bundle; run this first
cd apps/desktop && hutch run build    # hutch lives at ~/.hutch/bin/hutch and is off PATH on purpose
```

`hutch run build` is a **hutch** script (declared in `apps/desktop/hutch.config.ts`, not in any `package.json`),
and it builds the **canary** channel — `hutch electrobun build --env=canary`, the same command CI runs. So the
app you are testing is **JSLab-canary.app**, which is what the README's quarantine instruction names and what
Finder will offer for Q11. Artifacts land in `apps/desktop/artifacts/`: a `.dmg`, a `.tar.zst` and an
`update.json`.

macOS will refuse the first launch, because the build is unsigned by design. Control-click the app in
Applications → **Open** → confirm, or run
`xattr -dr com.apple.quarantine "/Applications/JSLab-canary.app"` once.

## About and open-source notices (ST-13)

- [ ] **Q1 About opens from both places, and there is only one of it (ST-13).** The app menu's first item and
  Help → About JSLab both open the same dialog. The **native** macOS About panel must be gone — if two
  different "About JSLab" windows exist, the swap is incomplete. (Unit: `apps/desktop/test/menu.test.ts` pins
  that no item carries `role: "about"` and that exactly two entries dispatch `help.about`.)
- [ ] **Q2 The versions shown are real (ST-13).** The dialog names the app version, the Bun version and the
  Electrobun version. Check the Bun version against `bun --version` in the bundled runtime and the app version
  against the release you built. A version that reads "0.0.0" or is missing means the bootstrap payload lost a
  field.
- [ ] **Q3 Open-Source Notices really opens, in a packaged build.** This is the one that matters most: the
  path is pinned at three wiring points (`app-paths.ts` `noticesFile`, the `hutch.config.ts` staging step and
  the `electrobun.config.ts` copy, tied together by `apps/desktop/test/build-wiring.test.ts`) but **has never
  been observed end to end**. Click it: `THIRD-PARTY-NOTICES.md` must open in the default handler. If nothing
  happens, the file is not landing in `Resources/app/` in a packaged build.
- [ ] **Q4 The notices file is the real one.** What opens should be ~1,578 lines naming the vendored polyfills
  (buffer, assert, util, stream-browserify, create-hash, create-hmac, string_decoder, url, punycode,
  path-browserify, events, querystring-es3) with their licence texts — not a stub and not the repo README.

## User manual (M6 item 5)

- [ ] **Q5 The manual is accurate on screen, not just resolvable.** `packages/shared/test/docs-links.test.ts`
  proves every link resolves and every page is reachable from the index; it proves **nothing** about whether
  the instructions are right. Work through `docs/user/getting-started.md` on a clean profile and confirm each
  step matches what the app actually does.
- [ ] **Q6 The shortcut table matches the running app (docs/user/keybindings.md).** Spot-check ten chords
  against the app, including at least one you rebound yourself in Settings → Keybindings. The table was
  generated from `DEFAULT_KEYBINDINGS`, so an error here means the defaults changed without the manual.
- [ ] **Q7 The AI page does not overpromise.** `docs/user/ai-chat.md` must say Ollama is the only provider
  that works today. If the page reads as though OpenAI or Anthropic are selectable, it is wrong — the picker
  offers only Ollama and None.

## Performance budgets (M6 item 6)

- [ ] **Q8 Re-measure on the hardware the budgets are written for.** `bun run bench`. The shipped numbers were
  taken on an **Apple M4 Pro against dev sources**; §23 states its budgets for an **M1 release build**, so the
  recorded PASSes do not prove a PASS on target. Run it on an M1 against a release build and record what you
  get. The harness prints this caveat above every run.
- [ ] **Q9 The five skipped budgets are still honestly unmeasurable.** Cold start, idle memory, output render
  at 10,000 entries, typing latency in a 5,000-line file, and DMG size are skipped with reasons recorded in
  `apps/desktop/bench/budgets.ts`. Confirm the reasons still hold — in particular, measure **cold start to
  editor interactive** and **idle memory** by hand against the 1.5 s and 300 MB budgets, since those two are
  the ones a user feels immediately.
- [ ] **Q10 The DMG is within budget.** §23 allows ≤ 80 MB. Measure the artifact the build actually produced:
  `ls -lh apps/desktop/artifacts/*.dmg`. This is the one §23 budget that needs no special hardware — any
  machine that can build the app can check it — and the benchmark harness skips it precisely because it needs
  a release build rather than dev sources.

## Carried over: already M6 rows, still needing a human

- [ ] **Q11 File associations (TF-20).** In Finder, right-click a `.ts` file → Open With: JSLab appears, and
  opening it opens that file in a tab. JSLab must **not** be the default for `.js`/`.ts` unless the user sets
  it — `LSHandlerRank: "Alternate"` exists so JSLab never outranks the user's own editor (ruling R7).
  Re-check all eight extensions: js, jsx, ts, tsx, mjs, cjs, mts, cts.
- [ ] **Q12 The Help links reach a browser (ST-11).** Documentation, Report Issue and What's New each open in
  the default browser, not in-app. All three targets returned HTTP 200 when last checked, and
  `apps/desktop/test/rpc/app-handlers.test.ts` pins the exact URLs, but that a click really reaches the
  browser takes a packaged build.
- [ ] **Q13 Documentation still points somewhere sensible.** It currently opens the repository README, not the
  new manual — deliberately: `docs/user/` on `main` holds `bun-vs-node.md` alone, so a link to the manual
  would 404 until this branch ships. **Once it has shipped, this is the follow-up:** re-point
  `HELP_URLS.documentation` at the manual and update the literal in `app-handlers.test.ts` with it.
