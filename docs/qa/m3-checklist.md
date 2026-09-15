# M3 Manual QA Checklist

Run against the packaged canary build on macOS arm64, from a fresh canary data folder (an existing one is moved into `$JSLAB_QA_DIR`, never deleted), using the M2 launch procedure:
- Copy the `.app` to internal disk first.
- Launch it with `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`, from a shell whose working directory is on internal disk (R-M1-14).
- Quit from the app menu. When a script must stop it, use only the scoped, zsh-safe teardown below (R-M1-13).

These items use the real npm registry (`registry.npmjs.org`) on purpose: automated suites never do.

```bash
export PATH="$HOME/.hutch/bin:$PATH"
REPO="$(git rev-parse --show-toplevel)"
builtin cd "$REPO/apps/desktop" && hutch run build && builtin cd "$REPO"
: "${JSLAB_QA_DIR:?set JSLAB_QA_DIR to a folder under the session scratchpad (internal disk)}"
APP="$(ls -d apps/desktop/build/canary-macos-arm64/*.app)"
# Move an existing canary data folder into the QA folder instead of deleting it (R-M2-T25-1).
[ -d "$HOME/Library/Application Support/dev.jslab.app/canary" ] && mv "$HOME/Library/Application Support/dev.jslab.app/canary" "$JSLAB_QA_DIR/canary-data-backup-$(date +%Y%m%d-%H%M%S)"
cp -R "$APP" "$JSLAB_QA_DIR/"
builtin cd "$JSLAB_QA_DIR"
ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "$JSLAB_QA_DIR/$(basename "$APP")/Contents/MacOS/launcher" &
JSLAB_QA_PID=$!
builtin cd "$REPO"
```

Scripted teardown (R-M1-13):

```bash
pids=( $(pgrep -f "$JSLAB_QA_DIR/") $(pgrep -f "Library/Application Support/dev.jslab.app/canary") )
for p in "${pids[@]}"; do kill -TERM "$p"; done
sleep 5
survivors=( $(pgrep -f "$JSLAB_QA_DIR/") $(pgrep -f "Library/Application Support/dev.jslab.app/canary") )
for p in "${survivors[@]}"; do kill -KILL "$p"; done
```

Each item passes only if the result matches exactly. Items marked **(E)** are also covered by an automated scenario.

## Packages
- [ ] **Q1 NPM sheet (TL-01, TL-06).** ⌘I, Tools → NPM Packages… and the activity bar open the sheet. The installed table's header stays visible while scrolling. A package you add is highlighted for about 2 s. Show @types toggles `@types/*` rows. (E: tools, npm-panel) — **verified (I):** the ⌘I shortcut opens the sheet (by the passing `tools` and `npm-panel` dev-build scenarios), and the Tools menu's "NPM Packages…" item is present, enabled and correctly labeled. **Pending user:** actually opening it from the Tools menu or the activity bar (no scenario clicks either), the sticky header, the add-highlight and the Show @types toggle (the last two also need a real install).
- [ ] **Q2 Real install (TL-02, TL-03).** Typing `zod` shows registry results with descriptions and weekly downloads. **Add** installs it; `zod@3` installs that range's newest version exactly. — pending user (real registry).
- [ ] **Q3 Git and tarball specs (TL-03).** `github:colinhacks/zod#main` or an `https://…tgz` URL installs. With install scripts off, the notice about blocked scripts appears when the package has one. — pending user (real registry).
- [ ] **Q4 Update and remove (TL-06).** A package pinned to an old version shows **Update** with the newest version; Update, Remove and Update all do what they say, and the log drawer streams output. — pending user (real registry).
- [ ] **Q5 Native module (TL-08).** With Allow install scripts on, `better-sqlite3` installs and `new (require("better-sqlite3"))(":memory:")` runs in a Bun tab. — pending user (real registry).
- [ ] **Q6 Errors (TL-09).** A misspelled package shows "No package with that name…"; with Wi-Fi off, an install shows the network hint; the log disclosure holds the raw output. — pending user (real registry).
- [ ] **Q7 Private registry (TL-10).** In Settings → NPM, add a scoped registry with a token and Save. Installing from that scope works; Help → Copy Debug Log contains no token. Your `~/.npmrc` (if any) is unchanged and unused. — pending user (real registry).
- [ ] **Q8 git over SSH (M0-S8 follow-up).** With your SSH agent running, `git+ssh://git@github.com/<a public repo>.git` installs. Without the agent it fails with an SSH authentication error in the log (documented limitation). — pending user (real registry, SSH agent state).

## Editor
- [ ] **Q9 Types and autocomplete (ED-08, ED-13, ED-14).** After installing zod, `import { z } from "zod"; z.` suggests `object`, `string`, …; hovering `z.object` shows its type. In a Bun tab `Bun.` and `process.` complete. (E: typescript, npm suite) — **verified (I):** in a Bun tab, `Bun` and `process` are recognized, correctly typed globals with no diagnostic error (their type info is loaded), and the same dev-build `typescript` scenario proves member completion works in general (`list.` suggests `map`/`filter`). **Pending user:** completions and hover specifically for `Bun.`/`process.` members, and the zod-derived completions and hover (need a real install).
- [ ] **Q10 Diagnostics, hover and hints (ED-09..ED-12).** A type error is underlined; ⌘F1 shows it; F1 shows hover info; typing `JSON.stringify(` shows parameter hints. Settings → Editor → Linting off removes the underline. — pending user: hover (F1), ⌘F1 and parameter hints need a GUI read.
- [ ] **Q11 Install assist (ED-26).** `import dayjs from "dayjs"` offers **Install package dayjs** in the lightbulb (⌘.). Running code that imports a missing package shows **Install dayjs** on the error row. — pending user: the lightbulb (⌘.) needs a GUI read.
- [x] **Q12 Automatic types (XT-12).** With Install Types Automatically on, installing `lodash` also installs `@types/lodash`. (E: npm suite) — verified (I) by the passing npm-suite dev-build scenario.

## Working directory and environment
- [ ] **Q13 Working directory (EX-30..EX-33, TF-19).** Actions → Set Working Directory… shows the folder picker; the status bar chip shows the folder name with the full path as its tooltip, and × clears it; the tab reads "title · folder". Relative imports, `__dirname`, `fs.readFileSync("./x")`, the folder's `.env` and its `node_modules` all work. (E: working-directory) — **verified (I):** the picker-driven WD flow (setting the WD, the chip, ×, relative imports/`__dirname`/`fs`/`.env`/`node_modules`), by the passing `working-directory` dev-build scenario. **Pending user:** the visual chip tooltip and tab-label read.
- [ ] **Q14 Missing folder.** Rename the working directory in Finder and run: the error "Working directory not found: …" shows **Change…**, which opens the picker. — pending user: the Finder rename needs a GUI action.
- [ ] **Q15 Folder drop (TF-11).** Dropping a folder onto the window shows the notice pointing at Set Working Directory (Branch B), or sets the working directory (Branch A, per R-M3-SPIKE-1). — pending user: the drop needs a GUI/OS-level drop, never scripted (R-CI-1's E2E rule).
- [ ] **Q16 Environment Variables (TL-11).** Values are masked until the eye toggle; Save persists and the next run sees them; Cancel discards; `env.json` is readable only by you (`ls -l` shows `-rw-------`). (E: environment) — **verified (I):** Save persisting, the next run seeing the values, and `env.json`'s 0600 mode, by the passing `environment` dev-build scenario. **Pending user:** the mask/eye-toggle visual and Cancel-discard read.
- [ ] **Q17 Login shell PATH.** Launched from the Dock (not a terminal), a package whose install script needs a tool from your shell `PATH` (for example `git`) installs, and `process.env.PATH` in a run includes your shell's additions. — pending user: a Dock launch needs a GUI action.

## Settings, docs and diagnostics
- [ ] **Q18 Bun vs Node doc.** `docs/user/bun-vs-node.md` matches Bun's compatibility page for Bun 1.4.0 (its last line records the check). — pending user: this dispatch had no web access, so `docs/user/bun-vs-node.md`'s last line records "Not yet checked against Bun's compatibility page for Bun 1.4.0."; a person must check it against the live page.
- [x] **Q19a Build tab, Pipeline Operator (LB-05).** Settings → Build → Pipeline Operator on makes `5 |> % * 2` run. (E: settings-window) — verified (I) by the passing `settings-window` dev-build scenario.
- [ ] **Q19b Build tab, Decorators Legacy (LB-07).** Settings → Build → Decorators Legacy makes a TypeScript `@decorator` on a class method compile with no editor error. — pending user: no automated scenario covers this; a person must check that a `@decorator` on a class method compiles with no editor error once the setting is on.
- [ ] **Q20 .npmrc editor (TL-10).** Settings → NPM shows `.npmrc` with ini highlighting; Save is disabled until you edit; Reset restores `registry=https://registry.npmjs.org/`. (E: settings-window) — **verified (I):** Save persisting the edited content with 0600 mode, and Reset restoring the default registry, by the passing `settings-window` dev-build scenario. **Pending user:** the Save-disabled-until-edited button state and the ini syntax-highlighting visual read (no scenario checks the button's enabled/disabled state).
- [ ] **Q21 Debug report (FA-m12).** Help → Copy Debug Log contains `~` where your home folder would appear, no environment variable values and no `.npmrc` content. — pending user: a visual read of the copied log.
- [x] **Q22 Quit keeps edits (X1, X5).** Type a line and quit with ⌘Q within a second; relaunch; the line is there. (E: quit-flush) — verified (I) by the passing `quit-flush` dev-build scenario.

## Known limitations (record, don't fix in M3)
- **Editor types above the working directory.** A relative import that leaves the working directory (`../../x` above it) runs, but gets no editor types.
- **Computed imports.** `import(name)` with a computed path resolves against the run's folder, not the working directory.
- **git over SSH** needs an SSH agent or `GIT_SSH_COMMAND`, because npm operations don't see `~/.ssh` (M0-S8).
- **Update all** updates every installed package to its latest version, including ones that are already current.
- **Browser runtimes** get their editor types now, but run in M4.
- **Install-script trust isn't revoked.** Turning off Allow Install Scripts stops future installs from running scripts; it doesn't revoke `trustedDependencies` trust already granted to packages installed while it was on (R-M3-T11-TRUST-1).
- **Outdated check time limit.** An outdated-packages check is capped at 30 s, and is cancelled without an error whenever you install, remove or update a package while it's running (R-M3-OUTDATED-1).

## Automated suites
- [x] **Q23 Totals.** What each opt-in suite covers (R-M3-T28-F1-1): `bun run e2e:npm` (opt-in, against the local test registry) drives installs through the app — install assist and `@types`, install scripts and automatic types, a dead scoped registry, and the M3 exit scenario (zod with types); it does not drive Update or Remove. `bun run test:npm` (the npm service against the local test registry) covers install, the outdated check, update, remove and install scripts.

  Record: `bun run test` per package (local Bun and the Bun 1.4.0 shim); `bun run test:npm`; `bun run e2e` on the dev build.

  **Dev-build results, 2026-09-15 (BASE f9c5ca9):**
  - `bun run lint`, `bun run typecheck`: exit 0.
  - `bun run test` (local Bun 1.3.13): 921 pass, 0 fail (shared 56, themes 8, rpc-schema 18, npm 51, serializer 31, transform 67, test-registry 5, e2e 11, runner-bun 38, ui 327 [284 `./test` + 43 `./isolated`], desktop 309).
  - `bun run test` (Bun 1.4.0 shim): 921 pass, 0 fail — same per-package counts as above.
  - `bun run test:npm`: 8 pass, 0 fail across 2 files (`@jslab/test-registry` integration: 3 pass; `@jslab/desktop` integration-npm: 5 pass).
  - `bun run e2e` (dev build): 60 pass, 0 fail across 24 files.
  - `bun run e2e:npm` (dev build): 4 pass, 0 fail across 1 file.

  **Canary totals: pending user (R-M3-T30-CANARY-1).** This autonomous run skips the packaged canary: warming a canary copy writes into `~/Library/Application Support/dev.jslab.app/canary`, and the M1/M2 canary procedure moves existing `~/Library` data and tears down by process-name pattern, both out of scope for an unattended run. Use the canary launch and teardown procedure in `docs/qa/m2-checklist.md`, then run `bun run e2e` and `bun run e2e:npm` against the canary copy the same way. The packaging step itself is verified by the green Release workflow run (35023774328 on commit f9c5ca9), which builds and signs the same canary.

## Packages (added after the Task 28 review, R-M3-T28-F1-1)
- [ ] **Q24 Update and remove, npm panel.** In the NPM Packages sheet, **Update** on an outdated package moves it to the newer version, and **Remove** deletes it from the installed list. Needs a person: no automated E2E scenario drives the panel's Update or Remove buttons (only `npm.install` is a registered UI command); the npm service's update/remove behavior is covered by `bun run test:npm`, but clicking the panel buttons themselves is not.
