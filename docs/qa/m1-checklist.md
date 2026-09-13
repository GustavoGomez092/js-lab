# M1 Manual QA Checklist

Run against a packaged canary build (`cd apps/desktop && hutch run build`), on macOS arm64, starting from a clean data folder. Launch it the way M0-S1 recorded:
- The canary `.app` (`JSLab-canary.app`) is a self-extracting installer. On first launch it extracts into the data folder below.
- Copy it to internal disk first. Launched from an external volume (`/Volumes/...`), it stalls on a hidden removable-volume permission prompt.
- Set `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`, so the installer panel closes without a click.

From the repository root (the build step above leaves the shell in `apps/desktop`, so return first):

```bash
cd "$(git rev-parse --show-toplevel)"
rm -rf ~/Library/Application\ Support/dev.jslab.app/canary
QA_DIR="<an internal-disk working directory>"   # e.g. mktemp -d; must NOT be under /Volumes
cp -R "apps/desktop/build/canary-macos-arm64/JSLab-canary.app" "$QA_DIR/"
ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "$QA_DIR/JSLab-canary.app/Contents/MacOS/launcher" &
```

- Use this explicit path. `find build -name '*.app' | head -1` can pick the dev app instead of the canary.
- Relaunch with the same `launcher` command.
- To quit from a script, kill by PID (`pkill -f "$QA_DIR/JSLab-canary.app"`), because `osascript -e 'quit app …'` does not quit the app. Items that test a clean quit (Q14) still use ⌘Q.

Each item passes only if the result matches exactly. Record failures as issues and link them in the M1 PR.

**Status legend:** ✅ passed with scripted/automated evidence from this repo (cited inline) · `PENDING USER` needs a human at the keyboard (typing, clicking, ⌘Q, Shift-at-launch, Safe Mode interaction, or visual inspection) — none of these were ticked without evidence.

## Launch and editing

- [ ] **Q1 First launch.** PENDING USER. The app opens one window with one tab and the status bar reads `Paused: press ⌘R to run`. Nothing appears in the output until you type.
  - Automated attempt: launching the packaged canary headlessly (background process, no interactive session) reproducibly hung during startup — the main process never created a window, never wrote `settings.json`/`session.json`, and never spawned a warm runner, even after 6+ minutes. `sample` showed the main thread blocked 100% of the time in a single `openat` syscall. See "Automation notes" below. This needs to be confirmed/refuted with a real interactive launch before M1 exit.
- [ ] **Q2 Auto Run.** PENDING USER. Type `1 + 1`. About 300 ms after you stop typing, the output shows `2` with an `L1` badge.
- [ ] **Q3 TypeScript.** PENDING USER.

  ```ts
  const a: number = 2
  console.log('hi', a)
  a * 21
  ```

  The output shows `hi 2` (L2) and `42` (L3).
- [ ] **Q4 Magic comments.** PENDING USER. `[1, 2, 3].map((n) => n * 2) //?` shows `Array(3)`, which expands to `0: 2, 1: 4, 2: 6`. `'abc'.toUpperCase() /*?*/ .length` shows `ABC`.
- [ ] **Q5 Line links.** PENDING USER.
  - Clicking an `L3` badge moves the caret to line 3.
  - Hovering an entry highlights its line in the editor.
- [ ] **Q6 Errors.** PENDING USER.
  - `JSON.parse('{')` shows `SyntaxError: …`, with a red squiggle on that line.
  - A syntax error such as `const x = ;` shows a code frame, keeps the previous output dimmed, and adds a squiggle at the error column.

## Values and async work

- [ ] **Q7 Deep values.** PENDING USER. `({ a: { b: { c: { d: 1 } } } })` expands level by level down to `d: 1`.
- [ ] **Q8 Promises.** PENDING USER. `new Promise((r) => setTimeout(() => r(7), 500))` first shows `Promise { <pending> }`, which changes to `Promise { <fulfilled> }` with the result `7`.
- [ ] **Q9 Stop.** PENDING USER. `setInterval(() => console.log(Date.now()), 200)` keeps logging and the status reads `Running: 1 active handle`. ⇧⌘R stops the logging, and the status reads `Stopped`.

## Recovery

- [ ] **Q10 Loop protection.** PENDING USER. `while (true) {}` fails immediately with `RangeError: Potential infinite loop: exceeded 2000 iterations (line 1)…`.
- [ ] **Q11 Unresponsive.** PENDING USER.
  1. Set `run.loopProtection` to `false` in `settings.json` and relaunch.
  2. Type `while (true) {}` and press ⌘R.
  3. After about 3 s, the dialog "This tab isn't responding" appears.
  4. Click **Wait**: the dialog returns about 3 s later.
  5. Click **Kill**: the status reads `Run killed`, and editing still works.
- [ ] **Q12 Crash-loop protection.** PENDING USER.
  1. With loop protection still off, run `while (true) {}` and force-quit JSLab while the run is active.
  2. Relaunch. The Safe Mode banner reads "JSLab didn't shut down cleanly…", nothing runs, and typing does not auto-run.
  3. ⌘R still runs.
- [ ] **Q13 Shift safe mode.** PENDING USER. Hold Shift while launching. A banner mentions Shift and Auto Run stays paused.

## Persistence

- [ ] **Q14 Restore.** PENDING USER. Type code, change the language to JavaScript, drag the split divider, then quit with ⌘Q. On relaunch the code, language, split size and window frame are restored, and nothing runs until you edit.
- [ ] **Q15 Output cap.** PENDING USER. `for (let i = 0; i < 20000; i++) console.log(i)` shows 10,000 entries plus the notice "Output truncated: 10000 more entries were dropped…", and scrolling stays smooth.
- [ ] **Q16 Clipboard.** PENDING USER. In the editor, ⌘C/⌘V work and ⌘Z undoes. **Copy All** in the output toolbar copies every entry as text.

## Automation notes

This task ran the full automated suite from a clean install (`rm -rf node_modules && bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test`): lint exit 0 (2 known warnings in `packages/runner-bun/test/bootstrap.test.ts`), typecheck 7/7, **233 tests total** (shared 12, rpc-schema 5, serializer 20, transform 51, runner-bun 20, desktop 70, ui 55), 0 fail.

It then built the packaged canary app (`cd apps/desktop && hutch run build`, produced `apps/desktop/build/canary-macos-arm64/JSLab-canary.app`) and attempted a fully scripted, no-interaction launch and exercise, per the constraint that no human was available to type, click, use ⌘Q, hold Shift at launch, or view the screen. That scripted launch surfaced a real finding:

- The self-extraction/install phase completed normally (log confirms extraction and installer steps).
- After installation, the launcher's child process (the actual app, `Contents/MacOS/bun … Resources/main.js`) never progressed past startup: no window was ever registered as visible-and-ready, no `settings.json`/`session.json`/`runs/` were created under `~/Library/Application Support/dev.jslab.app/canary`, and no warm runner (`bootstrap.js`, expected from `spares.prepare()` in `src/main/index.ts`) ever appeared in the process list, even ~7 minutes after launch.
- `sample <pid> 3 -mayDie` taken twice (1 s and 3 s windows) showed the main thread 100% of the time in the identical `openat`/`__ulock_wait` call stack — a genuine hang, not slow-but-progressing work.
- The launcher redirects the actual app process's stdout/stderr to `/dev/null` (confirmed via `lsof -p <pid>`), so the app's own `console.error("[jslab] …")` diagnostics (including the "UI heartbeat missed; reloading the view" string) are not observable through the log file captured at launch time; only the self-extractor's own messages appear there.
- This means item (i) of the launch verification (process runs from the launched canary copy) is confirmed; items (ii)–(iv) (UI boot, no uncaught/CSP/RPC errors, exactly one warm-spare runner) could **not** be confirmed, because the process appears to hang before reaching any of that logic.

This is filed as a concern for the M1 owner to investigate before relying on the canary build for the manual pass below — it may be specific to headless/background launching (no foreground login/UI session driving the launch), or it may be a genuine startup defect. Every Q1–Q16 item above is therefore `PENDING USER`: none can be honestly marked passed from this run, and Q1 in particular should be re-attempted first, interactively, to see whether the hang reproduces outside a backgrounded script.

Every pending item here (and the boot investigation above) becomes an M2 E2E scenario per the M1 plan's `R-GOAL-1` ruling (a minimal `packages/e2e` harness with a gated `e2e.*` socket in Main), so this checklist's coverage is expected to convert into scripted, repeatable E2E tests rather than staying a manual checklist long-term.
