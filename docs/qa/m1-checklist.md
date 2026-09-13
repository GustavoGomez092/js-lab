# M1 Manual QA Checklist

Run against a packaged canary build (`cd apps/desktop && hutch run build`), on macOS arm64, starting from a clean data folder. Launch it the way M0-S1 recorded:
- The canary `.app` (`JSLab-canary.app`) is a self-extracting installer. On first launch it extracts into the data folder below.
- Copy it to internal disk first. Launched from an external/removable volume, it stalls on a hidden removable-volume permission prompt.
- **R-M1-14: always launch with the shell's working directory set to an internal-disk directory before exec'ing the launcher — e.g. `cd` into the copy's own folder first.** At startup Bun opens its current working directory. If that cwd is itself on an external/removable volume (for example, a shell left `cd`'d into a worktree checked out on such a volume), macOS raises a `kTCCServiceSystemPolicyRemovableVolumes` consent prompt — and a script-launched, backgrounded app has no session to show that prompt in, so the process hangs forever in the underlying `openat` syscall, before ever creating a window. A normal Finder/LaunchServices double-click launch uses `cwd=/` and is never affected; this only bites scripted/background launches whose invoking shell happens to be sitting in a directory on a non-internal volume. `cd`-ing into the internal-disk copy (or any internal-disk directory) before exec'ing the launcher avoids it entirely.
- Set `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`, so the installer panel closes without a click.

From the repository root (the build step above leaves the shell in `apps/desktop`, so return first):

```bash
cd "$(git rev-parse --show-toplevel)"
rm -rf "$HOME/Library/Application Support/dev.jslab.app/canary"
QA_DIR="<an internal-disk working directory>"   # e.g. mktemp -d; must NOT be on an external/removable volume
cp -R "apps/desktop/build/canary-macos-arm64/JSLab-canary.app" "$QA_DIR/"
cd "$QA_DIR"   # R-M1-14: cwd must be internal disk before exec'ing the launcher
ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "$QA_DIR/JSLab-canary.app/Contents/MacOS/launcher" &
```

- Use this explicit path. `find build -name '*.app' | head -1` can pick the dev app instead of the canary.
- Relaunch with the same `launcher` command (from the same internal-disk cwd).
- To quit from a script, use a scoped, zsh-safe per-PID teardown — never a bare `pkill` on a broad name, and never word-split an unquoted PID list:

  ```bash
  pids=( $(pgrep -f "$QA_DIR/") $(pgrep -f "Library/Application Support/dev.jslab.app/canary") )
  for p in "${pids[@]}"; do kill -TERM "$p"; done
  sleep 5
  survivors=( $(pgrep -f "$QA_DIR/") $(pgrep -f "Library/Application Support/dev.jslab.app/canary") )
  for p in "${survivors[@]}"; do kill -KILL "$p"; done
  ```

  because `osascript -e 'quit app …'` does not quit the app. Items that test a clean quit (Q14) still use ⌘Q.

Each item passes only if the result matches exactly. Record failures as issues and link them in the M1 PR.

**Status legend:** ✅ passed with scripted/automated evidence from this repo (cited inline) · `PENDING USER` needs a human at the keyboard (typing, clicking, ⌘Q, Shift-at-launch, Safe Mode interaction, or visual inspection) — none of these were ticked without evidence.

## Launch and editing

- [ ] **Q1 First launch.** PENDING USER. The app opens one window with one tab and the status bar reads `Paused: press ⌘R to run`. Nothing appears in the output until you type.
  - Automated evidence (see "Automation notes" below, root cause R-M1-14): with the launcher's cwd fixed to internal disk, the canary boots cleanly — Main and exactly one warm runner process start within ~2 s and stay alive with no crash and no reload loop; the WKWebView loads its single page and both `views://`-style scheme handlers register and serve their resources without error; no CSP/RPC/uncaught-exception strings and no removable-volume TCC prompt appear in the unified log. This automated evidence confirms the app **opens** (one window, one page, no error) but does **not** confirm the item's full wording — the actual on-screen tab count, the exact status-bar text, and "nothing appears in the output until you type" are visual/content assertions that need a human to read the screen. Kept `PENDING USER` for that reason.
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

It then built the packaged canary app (`cd apps/desktop && hutch run build`, produced `apps/desktop/build/canary-macos-arm64/JSLab-canary.app`) and attempted a fully scripted, no-interaction launch and exercise, per the constraint that no human was available to type, click, use ⌘Q, hold Shift at launch, or view the screen.

**First attempt — boot hang, root-caused (R-M1-14).** The first scripted launch reproducibly hung during startup: Main never created a window, never wrote `settings.json`/`session.json`, and never spawned a warm runner, even after 6+ minutes; `sample` showed the main thread blocked 100% of the time in a single `openat`/`__ulock_wait` call stack. Root cause: the launching shell's *working directory* was itself on an external volume (the git worktree), and Bun opens its cwd at startup. That triggered a `kTCCServiceSystemPolicyRemovableVolumes` consent prompt (confirmed in the unified log: `tccd AUTHREQ_PROMPTING service=kTCCServiceSystemPolicyRemovableVolumes`, with the canary launcher as subject, at the exact launch timestamp) which a backgrounded, non-interactive process has no session to display — so the underlying `openat` blocked forever. This is not a JSLab defect: a normal Finder/LaunchServices launch always uses `cwd=/` and is unaffected. See R-M1-14 in the launch procedure above.

**Second attempt — cwd fixed, clean boot.** Relaunched with the shell `cd`'d into `$QA_DIR` (internal disk) before exec'ing the launcher (`builtin cd "$QA_DIR" && ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "$QA_DIR/JSLab-canary.app/Contents/MacOS/launcher" > "$QA_DIR/canary-2.log" 2>&1 &`), against the already-extracted canary data dir (no re-extraction needed). Verified by script only:
- **(i) processes alive with internal-disk cwd:** Main (`…/Contents/MacOS/bun … Resources/main.js`) and the runner (`…/Contents/Resources/app/runner/bootstrap.js --no-env-file`) both appeared within 2 s of launch and stayed alive for the full observation window (2 min 27 s). `lsof -a -p <pid> -d cwd` showed Main's cwd as `$QA_DIR/JSLab-canary.app/Contents/MacOS` and the runner's cwd as `~/Library/Application Support/dev.jslab.app/canary` — both internal disk.
- **(ii) UI boots, heartbeats flow:** `sample <main pid> 1` showed the main thread parked in `mach_msg2_trap`/`__psynch_cvwait`/`semaphore_wait_trap`/`__accept`/`readv` — a healthy multi-threaded event/IPC loop, not `openat`. The unified log (`log show --predicate 'process == "bun" OR process CONTAINS "WebKit"'`) shows a `WebContent` process (WKWebView) starting, `WebPage::registerURLSchemeHandler: Registered handler 1 …` and `… handler 8 …` for the app's custom (`views://`-style) schemes, then `WebURLSchemeTaskProxy::startLoading` / `didReceiveData` / `didComplete` twelve times (the page plus its bundled assets) with `FrameLoader::setState: main frame load completed` exactly twice within 17 ms at startup (the normal initial-load pattern, not a reload loop — no further loads occurred over the following 2+ minutes). No "UI heartbeat missed; reloading the view" string appeared at any point.
- **(iii) no removable-volume prompt:** `log show --predicate 'subsystem == "com.apple.TCC"'` over the launch window shows zero `AUTHREQ_PROMPTING` events and the only `RemovableVolumes` mention is an unrelated `sandboxd` (pid 420, audit token pid 4400) request over a minute later, attributed to neither the launcher, Main, nor the runner PID.
- **(iv) exactly one runner:** `pgrep -fl "Contents/Resources/app/runner/bootstrap.js"` matched exactly one PID throughout the observation window.
- No CSP violation, uncaught-exception, or app-level RPC error strings appear anywhere in the captured log; the only `E`-level lines are benign ad-hoc-signing noise (`CFPasteboardRef`/XPC bootstrap-lookup failures for the sandboxed WebContent helper reaching the system pasteboard — expected for a locally-built, non-notarized app, unrelated to JSLab's own CSP/RPC boundary).

Teardown: PIDs matched strictly via `pgrep -f "$QA_DIR/"` into a zsh array, each sent `SIGTERM` individually, waited 5 s; the runner had already exited (cascaded from Main's shutdown) and the remaining two exited cleanly — no `SIGKILL` was needed. Re-checked with `pgrep`/`ps`: zero matches remained, including the WebKit helper processes (Networking/GPU/WebContent), which exited when Main quit.

**Conclusion:** the canary build boots correctly once launched with an internal-disk working directory. Every Q1–Q16 item above is still `PENDING USER` because none of their full wording (visual tab/status-bar content, typed-input behavior, dialogs, ⌘-key interaction, Safe Mode banners) can be confirmed without a human at the keyboard — but the previously-suspected "boot hang" is now understood, resolved for the scripted-evidence purposes of this task, and documented as a launch-procedure caveat (R-M1-14) rather than a product defect.

Every pending item here (and the boot investigation above) becomes an M2 E2E scenario per the M1 plan's `R-GOAL-1` ruling (a minimal `packages/e2e` harness with a gated `e2e.*` socket in Main), so this checklist's coverage is expected to convert into scripted, repeatable E2E tests rather than staying a manual checklist long-term.
