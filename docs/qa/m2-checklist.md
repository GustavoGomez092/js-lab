# M2 Manual QA Checklist

Run against the packaged canary build on macOS arm64, from a fresh canary data folder (an existing one is moved into `$JSLAB_QA_DIR`, never deleted), using the M0-S1 launch procedure as corrected in M1:
- Copy the `.app` to internal disk first.
- Launch it with `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`, from a shell whose working directory is on internal disk (R-M1-14). Bun opens its cwd at startup, and a cwd on an external volume (such as a worktree checkout) blocks forever on a hidden removable-volume consent prompt.
- Quit from the app menu. When a script must stop it, use the scoped, zsh-safe teardown below (R-M1-13) and nothing broader.

```bash
export PATH="$HOME/.hutch/bin:$PATH"
REPO="$(git rev-parse --show-toplevel)"
builtin cd "$REPO/apps/desktop" && hutch run build && builtin cd "$REPO"
: "${JSLAB_QA_DIR:?set JSLAB_QA_DIR to a folder under the session scratchpad (internal disk, R-M1-8)}"
APP="$(ls -d apps/desktop/build/canary-macos-arm64/*.app)"
# Move an existing canary data folder into the QA folder instead of deleting it: it may hold canary state from earlier QA.
[ -d "$HOME/Library/Application Support/dev.jslab.app/canary" ] && mv "$HOME/Library/Application Support/dev.jslab.app/canary" "$JSLAB_QA_DIR/canary-data-backup-$(date +%Y%m%d-%H%M%S)"
cp -R "$APP" "$JSLAB_QA_DIR/"
builtin cd "$JSLAB_QA_DIR"  # R-M1-14: internal-disk cwd before exec'ing the launcher
ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "$JSLAB_QA_DIR/$(basename "$APP")/Contents/MacOS/launcher" &
JSLAB_QA_PID=$!
builtin cd "$REPO"
```

Scripted teardown (R-M1-13). The canary self-extracts and may be reparented, so it is found by its QA and data paths only, collected into zsh arrays and signalled one PID at a time:

```bash
pids=( $(pgrep -f "$JSLAB_QA_DIR/") $(pgrep -f "Library/Application Support/dev.jslab.app/canary") )
for p in "${pids[@]}"; do kill -TERM "$p"; done
sleep 5
survivors=( $(pgrep -f "$JSLAB_QA_DIR/") $(pgrep -f "Library/Application Support/dev.jslab.app/canary") )
for p in "${survivors[@]}"; do kill -KILL "$p"; done
```

**Warm-up before `bun run e2e` (R-M2-FINAL-8 A).** A freshly copied canary hasn't self-extracted yet — it is only a launcher plus `.tar.zst` until it is launched once. `launchApp` now refuses to spawn such a copy (it would otherwise relaunch outside the harness's process tree, untracked, and possibly against the real canary data folder), so warm the copy first using the launch procedure above: launch it, wait for the window, then quit from the app menu (or the scoped teardown below). Only after that warm-up does `JSLAB_E2E_APP="$JSLAB_QA_DIR/$(basename "$APP")" bun run e2e` (Q33) have a self-extracted bundle to run against.

**Screenshots and permissions:**
- Scenario screenshots need Screen Recording access for the launched JSLab. JSLab checks it with `Utils.screenCapture.hasAccess()`, which never prompts. Without access, each capture is skipped and logged as `skipped: no screen-recording permission`, and the scenarios still pass.
- Nothing in this checklist or in the harness requests the permission. Granting it is optional and manual (System Settings → Privacy & Security → Screen Recording). `JSLAB_E2E_SKIP_SCREENSHOTS=1` skips captures without asking the app.

Each item passes only if the result matches exactly. Items marked **(E)** are also covered by an automated scenario; this pass checks them by eye.

**Run status (Task 25, 2026-09-14, R-M1-3).** The implementer had no GUI access, so nothing below was checked by eye:
- `[x]` marks an item that a scenario passing on both the dev build and the packaged canary fully covers. The scenario is named inline.
- **✅ covered** marks the scenario-covered part of an item that is otherwise pending.
- **Pending user:** says what a person still has to check. Tick the item once it passes.

## Window and layout
- [ ] **Q1 Chrome.**
  - The window is dark Graphite, with the traffic lights inset in a 38px toolbar row.
  - Dragging empty toolbar space moves the window.
  - The Auto Run and Run buttons are clickable.
  - Title bar (T16):
    - Dragging the toolbar row moves the window, and clicking toolbar buttons or tabs doesn't drag it.
    - The traffic lights don't overlap any control and stay vertically centered at 50%, 100% and 200% UI zoom.
    - The title-bar strip doesn't swallow clicks on the Safe Mode banner or on startup notices.
    - The full-screen transition keeps the toolbar usable.
  - **Pending user:** the whole item: colors, window dragging, traffic-light placement at each zoom, banner clicks and full screen are visual or pointer checks.
- [ ] **Q2 Activity bar.**
  - It is 48px wide, with Run/Stop, Snippets, NPM Packages (disabled), AI Chat and Settings at the bottom.
  - Snippets and AI Chat toggle the side bar placeholder.
  - **Pending user:** the width, the icon order and the side bar toggles by click.
- [ ] **Q3 Split.**
  - Dragging the divider resizes the split, and double-clicking it resets to 50/50.
  - The status bar's split toggle switches to stacked. (E)
  - **✅ covered:** the split toggle (`packages/e2e/scenarios/layout.test.ts`, "toolbar, activity bar and status bar render; toggles hide them and persist").
  - **Pending user:** dragging the divider and the double-click reset.
- [ ] **Q4 Status bar.**
  - It is 28px high, with the run state dot and label on the left.
  - On the right: runtime (browser runtimes disabled), language, split toggle and `Ln x, Col y`.
  - With Vim Keys on, the Vim mode shows.
  - **Pending user:** the height, the left/right placement and the disabled browser runtimes, by eye.
- [ ] **Q5 Zoom (ED-27).** ⌘= / ⌘− / ⌘0 scale the editor text, the output and the chrome together, and persist after relaunch.
  - **Pending user:** that the output and chrome scale together with the editor, and that the zoom persists after a relaunch.
- [ ] **Q34 Window restore (TF-14, spec §10.1).**
  - Move the window to an external display, quit, disconnect that display and relaunch: the window opens centered on the built-in display. (E: the off-screen restore scenario)
  - A window that was full screen at quit reopens full screen.
  - Reconnect the display, move the window there, quit and relaunch: it reopens on that display.
  - **✅ covered:** the off-screen restore (`packages/e2e/scenarios/files.test.ts`, "a window saved on a display that no longer exists opens on the primary display").
  - **Pending user:** disconnecting a real display, full-screen restore, and reopening on a reconnected display.

## Tabs
- [ ] **Q6 Tab bar (TF-01, TF-02).**
  - ⌘T adds a tab after the active one, with an accent underline on the active tab.
  - Titles use the custom title when one is set, then the file name, then the first non-empty code line.
  - **Pending user:** the accent underline on the active tab, a visual check.
- [ ] **Q7 Middle-click (TF-03).** Middle-clicking a tab closes it.
  - **Pending user:** the middle-click, a pointer check.
- [ ] **Q8 Context menu (TF-04, TF-15).**
  - Right-click → Rename…, Close, Close Others, Close to the Right, Reveal in Finder, Copy Path.
  - The file items are disabled for scratch tabs.
  - A saved tab's tooltip shows its full path.
  - **Pending user:** the right-click menu, its disabled file items, and the tooltip.
- [ ] **Q9 Drag reorder.** Dragging a tab shows an insertion marker, and the order survives relaunch.
  - View state (T12): fold most of a long file, quit and relaunch. The folds, the cursor and the scroll position come back.
  - **Pending user:** the drag, the insertion marker, and the relaunch checks for the order and for a heavily folded file.
- [x] **Q10 Tab bar for one tab (TF-07).** View → Tab Bar off hides the bar with one tab open. It returns with a second tab.
  - Covered by `packages/e2e/scenarios/tab-bar.test.ts` ("titles come from the first line, and the bar hides for a single tab when configured").

## Files
- [ ] **Q11 Open (TF-10).**
  - ⌘O shows a native dialog filtered to js/jsx/ts/tsx/mjs/cjs/mts/cts/json/txt.
  - Multi-select opens tabs, and an already-open file is focused instead.
  - The dialog's `allowedFileTypes` filter greys out other files, such as `.png` and `.md` (T10, T18).
  - **Pending user:** the real native dialog: its file-type filter and multi-select. The scenario answers the dialog through a scripted E2E file.
- [ ] **Q12 Save As dialog (M0-S6 pending checks).**
  - Choosing a different folder and name saves there.
  - Cancel changes nothing.
  - A name containing `"` saves with that exact name.
  - The dialog appears in front of the window, or comes forward with one click.
  - An untouched dialog left for at least 60 s never saves on its own. If it resolves to the default path, JSLab shows "Save to this location?" and nothing is written until you confirm.
  - When the default folder is on a volume that is no longer mounted, Save As still opens a dialog and saves to the folder you pick (T10, T18).
  - Save As through the real dialog into a folder reached through a symlink (for example under `/tmp`) still asks "Save to this location?" when the name is left at the default (T10, T18).
  - **Pending user:** every part: the real `osascript` dialog. The scenario scripts the dialog's answer.
- [ ] **Q13 Unsaved changes (TF-09).** Closing a modified file asks "Save changes to x.ts?". Save, Don't Save (⌘D) and Cancel each do what they say.
  - **✅ covered:** Don't Save (⌘D) (`packages/e2e/scenarios/files.test.ts`, "closing a modified file asks to save, and ⌘D discards").
  - **Pending user:** Save and Cancel in the prompt. Only Don't Save is scripted.
- [ ] **Q14 Drag and drop (TF-11).**
  - Dropping two `.ts` files opens two tabs. Each is an unsaved scratch copy titled with the file's name and with no file path: ⌘S asks Save As, there's no dirty dot, and Reveal in Finder and Copy Path are disabled (a deviation until a native drop lands in M3).
  - Dropping a PNG shows "isn't a text file".
  - Dropping a folder shows the working-directory notice.
  - Dropping a file onto the Monaco editor area opens it as a tab instead of inserting its text (T18).
  - **Pending user:** every drop: Finder drag and drop can't be scripted.
- [ ] **Q15 Large files (TF-12, ED-25).**
  - Opening a 6 MB file asks first.
  - Pasting more than 5 MB of text asks "Pasting 5.x MB may make JSLab slow. Continue?". Cancel pastes nothing.
  - Open a file of about 6 MB in a normal window and edit it: the editor stays responsive and the watchdog never reloads the view (T18).
  - **Pending user:** the large paste and its Cancel, and responsiveness while editing a 6 MB file. The open confirmation is scripted in `packages/e2e/scenarios/files.test.ts`.
- [ ] **Q16 Window lifecycle (TF-21).**
  - ⌘W on the only empty tab closes the window, and the app stays in the Dock.
  - Clicking the Dock icon reopens it with the tabs restored.
  - Close the window while a long run is in progress, then reopen it: no errors appear in the output, the notices or `main.log` (T18).
  - **Pending user:** the Dock click, since the scenario reopens through `e2e.reopen`, and closing during a long run.

## Editor
- [ ] **Q17 Editing commands (ED-15..ED-19).**
  - Find (⌘F), Replace (⌘⌥F), Go to Line (⌃G), toggle line/block comment (⌘/, ⌘⌥/), Toggle Magic Comment (⌘⌥⇧/).
  - Tab indents a selection.
  - Bracket match highlight and fold markers work.
  - Menu (T22): ⌘Q quits and ⌘H hides; ⌘W still closes the tab; Backspace still deletes in the editor.
  - **Pending user:** every shortcut through the real keyboard and native menu, and the highlight and fold markers by eye.
- [ ] **Q18 Line editing (ED-21).** Duplicate (⌘⇧D), move up/down (⌘⌃↑/↓), join (⌘J), select line (⌘L) and delete line (⌃⇧K) behave as their names say.
  - **Pending user:** each line-editing shortcut. Only the keymap and action ids are tested.
- [ ] **Q19 Editor settings (ED-01..ED-07).** Toggling Line Wrap, Close Brackets, Font Ligatures, Line Numbers, Invisibles and Active Line in Settings changes the editor immediately.
  - **Pending user:** that each toggle visibly changes the editor.
- [ ] **Q20 Vim (ED-02).**
  - With Vim Keys on, the editor starts in NORMAL, `i` enters INSERT, and ⌘R runs in every mode.
  - `"+y` copies to the system clipboard.
  - ⌘R runs in Vim INSERT and VISUAL modes, and Vim keeps working after switching tabs and back (T15).
  - **Pending user:** ⌘R in INSERT and VISUAL, the `"+` register (no scenario may write the real clipboard), and Vim after tab switches.
- [ ] **Q21 Editor context menu (ED-20).** Right-clicking the editor shows Monaco's context menu. Create Snippet… arrives in M5.
  - **Pending user:** the right-click menu.

## Formatting
- [ ] **Q22 Format Code (ED-22, XT-11).**
  - ⌥⇧F formats. A fold elsewhere in the file stays folded, and the scroll position stays.
  - One ⌘Z undoes the whole format.
  - A slow format shows "Formatting…" in the status bar, and a hung formatter times out with "Couldn't format" (T21 timeout).
  - **Pending user:** the fold, the scroll position and one-step undo, by eye, and the "Formatting…" and timeout messages.
- [x] **Q23 Format on run and save (ED-23, XT-05).** With Format on Run on, a manual run formats first, except while you are typing (the editor has focus and you typed in the last second). With Format on Save on, a save formats first, right away, even while you are typing.
  - Covered by `packages/e2e/scenarios/format.test.ts` ("format on run formats before a manual run when not typing", "format on save writes formatted code").

## Settings, themes and output
- [ ] **Q24 Settings window (ST-01, ST-02).**
  - ⌘, opens a 760×560 window with General, Editor, Formatting, Appearance and Advanced.
  - Every field shows help text, and search finds "print width".
  - The window remembers its position.
  - With the main window closed, ⌘, opens or focuses Settings (R-M2-T24-6).
  - **Pending user:** the window size and position memory, every field's help text, and ⌘, with the main window closed.
- [ ] **Q25 Themes (ST-03, ST-04).**
  - Every theme in the Themes menu applies to the editor and the chrome with readable text, and the checkmark follows.
  - Follow System Appearance switches with macOS.
  - The Themes menu shows a checkmark on the active theme (T22).
  - Actions → Runtime shows the browser runtimes greyed out (T22).
  - **Pending user:** readability of every theme, the native menu checkmark and greyed items, and switching with macOS.
- [ ] **Q26 Fonts (ST-05, ST-06).**
  - The Font picker lists the six bundled fonts, then installed monospace fonts, then others.
  - Choosing an installed font applies it.
  - Font Size applies.
  - If installed fonts can't be scanned, the Font picker says "Couldn't load installed fonts", and JSLab doesn't rescan for 10 minutes (R-M2-T24-6).
  - **Pending user:** the picker order with the real installed fonts, that a chosen font renders, and the scan-failure message.
- [ ] **Q27 View toggles (ST-07, TF-17).** Tab Bar, Activity Bar, Status Bar, Side Bar and Output toggles work from View and from Settings, and persist.
  - **✅ covered:** the Settings path (`packages/e2e/scenarios/settings-window.test.ts`, "a change in Settings applies live in the main window and persists").
  - **Pending user:** the toggles from the native View menu.
- [ ] **Q28 Output (OU-16).**
  - Rows show a 3px level stripe and a `:n` anchor on the right; only error rows are tinted.
  - Hovering highlights the editor line, and clicking jumps to it.
  - The filter chips narrow the list.
  - Output Highlighting off removes value colors.
  - Copy All copies only the entries visible under the current filter chip (R-M2-T19A-1): switch to Errors, press Copy All, and only error entries are copied.
  - The 3px level stripes use the result, log and error colors, and only error rows are tinted, in both Graphite and Graphite Light (T19A).
  - `console.log("x".repeat(1_000_000))` and `process.stdout.write("y".repeat(2_000_000))` keep JSLab responsive and each show one truncated entry (R-M2-T19B-1/2).
  - Minimize JSLab during a long logging run for a few minutes, then restore it: the UI stays responsive (FB-I1).
  - **Pending user:** stripe colors and tint in both themes, hover and click, filtered Copy All (the real clipboard), the two large writes, and the minimized logging run.
- [ ] **Q29 Command palette.**
  - ⌘⇧P opens a 520px palette over a scrim, with an EDITOR (or OUTPUT, after clicking the output) badge.
  - Typing "tog" highlights "Tog" in the accent color.
  - It shows RUN/VIEW sections, "currently on" descriptions and keycaps.
  - ↑↓, ↵ and esc behave as the footer says.
  - Clicking inside the palette panel (the footer, a label) keeps ↑↓, ↵ and esc working (R-M2-T20-1).
  - The empty palette lists every section, including Theme and Help (FB-m1).
  - **Pending user:** the size, scrim, badge, highlight color and keycaps by eye, the keys after clicking inside the panel, and scrolling the empty palette to Theme and Help.

## Help
- [x] **Q30 Copy Debug Log (ST-10).** Pasting shows JSON with versions, macOS, arch, settings and the last log lines, with no secrets.
  - Covered by `packages/e2e/scenarios/help.test.ts` ("Copy Debug Log produces a redacted report and logs rotate under logs/").
- [ ] **Q31 Open Logs Folder.** Finder opens `…/dev.jslab.app/canary/logs` containing `main.log`.
  - **Pending user:** Finder opening. The scenario only checks the path recorded in `e2e-opened.txt`.
- [ ] **Q32 Restart in Safe Mode.** The app quits and relaunches with the banner "Safe Mode: restarted from Help → Restart in Safe Mode."
  - Recovery notice (T9-m2): quit, move `settings.json` away while `settings.json.bak` exists, and relaunch. Then do the same with `session.json` and `session.json.bak`. Check that each notice's wording reads correctly for a missing file rather than a corrupt one. The notices currently say "…restored from the backup because the file was unreadable." and "Your tabs were restored from the backup because session.json was unreadable."
  - An unexpected error after startup shows a notice with a Copy Debug Log button, and the app keeps running (spec §20).
  - **Pending user:** the relaunch itself (E2E suppresses `open -n`; the scenario checks only that the next launch is in Safe Mode), the recovery-notice wording for a missing file, and the unexpected-error notice if one occurs.

## Known limitations (record, don't fix in M2)
- **Main crash.** If JSLab's Main process crashes or is force-quit, a running runner exits, but processes its user code spawned keep running. They are in the runner's own process group, and nothing signals it (R-M1-18 N3). A runner that exits on its own, and every Kill, Stop and quit, does take them with it.
- **Expanding after Stop.** A stopped run's runner is recycled at once (R-M1-18), so expanding a value from that run shows "Couldn't expand value. Try again." Run again to inspect it.
- **Large stdout/stderr writes.** A single stdout/stderr write larger than about 256 KB is shown truncated, ending with '…' and the number of bytes not shown (R-M2-T19B-1).
- **Long error text.** Error messages are clipped at 16 KB and error names at 1 KB (R-M2-T19B-1/2).

## Automated suite
- [x] **Q33 Canary E2E.** `JSLAB_E2E_APP="$JSLAB_QA_DIR/$(basename "$APP")" bun run e2e` → 48 pass, 0 fail.
  - **Dev build** (`hutch run build:dev`, then `bun run e2e`): 48 pass, 0 fail, 17 files, 472 s.
  - **Packaged canary** (`JSLab-canary.app` copied to `$JSLAB_QA_DIR`): 48 pass, 0 fail, 17 files, 487 s.
    - The first run of that copy was 47 pass, 1 fail. Its first launch (`themes.test.ts`) self-extracted the app, and the extracted app never opened `jslab.sock` in the scenario's data folder before the 45 s wait ran out, which is the first-launch case in the M2 plan (Task 25, Step 4).
    - That launch's launcher and Main were still running after the run. They were stopped with the scoped R-M1-13 teardown. The copy was already extracted, so the suite was rerun without a separate warm-up.
    - **R-M2-FINAL-8 A residual fix:** `launchApp` now refuses to spawn a canary copy that hasn't self-extracted yet, instead of letting its self-extractor relaunch the real app untracked (see the Warm-up note above). Warm a freshly copied canary once with the launch procedure above before pointing `bun run e2e` at it with `JSLAB_E2E_APP`.
  - **M2 residual fix rerun** (2026-09-14, `hutch run build:dev` then `bun run e2e` against the dev build): 48 pass, 0 fail, 17 files, 575.07 s. Post-run `ps -axo pid,etime,command | grep -F -e 'dev-macos-arm64' -e 'JSLab-canary' | grep -v grep` found no survivors. Canary was not rerun for this residual fix (not required); its recorded result above (48/48) stands.
  - **Unit and integration suite** (`bun run lint && bun run typecheck && bun run test`): lint and typecheck exit 0. 628 tests pass, 0 fail: shared 42, rpc-schema 14, serializer 31, transform 54, runner-bun 35, desktop 207, ui 226, themes 8, e2e 11. That is 13 more than the pre-residual-fix total of 615 (desktop +1 RR1-m3, ui +11, e2e +1 R-M2-FINAL-8 A), and 360 more than the M1 final of 268 (`bae17c4`).
  - Review fix rounds added tests beyond the plan's count of 497: R-M2-T2-1, then each task's fix rounds.
  - The final review fix waves added more: Wave 1 took the suite from 561 to 586 tests (and 47 to 48 scenarios), Wave 2 took it to 615, and the M2 residual fix (this pass) took it to 628.
