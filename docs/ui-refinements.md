# JSLab UI refinements — evidence-based, ranked

**Base read:** `feat/jslab-m4` @ `ca68fd6`, via `git show` from the main checkout. No worktree was entered, nothing was built or run.
**Direction:** Graphite (dark, native, line-anchored output) + Daylight Rail palette. Everything below serves that direction; nothing here proposes a redesign.
**Clean room:** no RunJS artefact was opened, unpacked or read.

---

## 0. What the UI actually does today (read, not assumed)

| Area | Current behaviour | Evidence |
|---|---|---|
| Output list | Virtualized (`@tanstack/react-virtual`), auto-scrolls while pinned to bottom, 30px estimate, overscan 20 | `apps/ui/src/output/OutputPanel.tsx:72-81` |
| Line anchoring | Each row is a 3-col grid: stripe, body, right-edge `:n` button with accessible name `L<n>`, click reveals the line, hover highlights it in the editor | `apps/ui/src/output/EntryRow.tsx:42-77`, `apps/ui/src/styles.css:356-381` |
| Level stripes | 3px stripe per level; only error rows are tinted | `styles.css:1255-1277`, `:387-394` |
| Stale output | Previous run's entries kept at `opacity: .5`, labelled "Last successful run" after a failed compile | `output/stale.ts:5-13`, `styles.css:367-369` |
| Value tree | Collapsed by default, lazy handles, expired-handle message, in-flight guard, retryable expand failure | `output/ValueView.tsx:17-131` |
| Truncated strings | A real `<button class="v-more">… N more characters</button>` that fetches the rest | `ValueView.tsx:52-55` |
| Truncated collections | An **inert `<div class="v-hole">… N more</div>`** — no handler, styled only as muted text | `ValueView.tsx:127`, `styles.css:457-462` |
| Filters | 4 chips as a `radiogroup`, plus a separate Web View `<button aria-pressed>`; counts shown for All and Errors only | `output/FilterChips.tsx:5,36-68` |
| Empty states | "No output yet — press ⌘R" and "No entries match this filter" + a **Show all** button | `OutputPanel.tsx:140-152`, `strings.ts:206-208` |
| Output region | `<section class="output" aria-label="Output">`; the scroller inside is a `tabIndex={0}` div with **no role and no name** | `OutputPanel.tsx:95-105,157-161` |
| Splitter | One `role="separator"` source with `aria-orientation`/`aria-valuenow`/`min 10`/`max 90`, `tabIndex=0`, drag, double-click reset, arrows ±2, Enter reset — **and no accessible name** | `shell/SplitPane.tsx:70-85` |
| Splitter call sites | Two: editor/output (`shell/App.tsx:575`) and Console/Web View (`output/OutputTiles.tsx:110`, rendered only when the Web View preview is on) | verified by `git grep '<SplitPane'` — 2 production sites, 4 test sites |
| Notices | `<output class="banner banner-warning">` per notice + optional action + `×` dismiss; max 5, deduped by id, oldest dropped | `shell/parts.tsx:43-72`, `state/store.ts:288,422-426` |
| Status messages | A plain `<span class="status-message">`, cleared after 5s unless sticky | `shell/StatusBar.tsx:56`, `store.ts:291,705-714` |
| Palette | `combobox` + `listbox`, `aria-activedescendant`, category sections, match highlighting, keycaps from the *effective* bindings, footer legend, context badge, focus restore on close | `palette/CommandPalette.tsx:84-206` |
| Web dialogs | Non-modal `role="status"` row with a queued count — deliberately never a modal | `output/WebDialog.tsx:4-34` |
| npm failures | message + one-line hint + `<details>` log + Retry / Allow Scripts and Retry / Copy Log / Dismiss, in `role="alert"` | `npm/NpmSheet.tsx:359-392` |

**Two corrections to the brief, both measured:**

1. **`settingsTooLarge` is not at the base ref.** `STARTUP_NOTICE_IDS` at `ca68fd6` is `settingsRecovered, sessionRecovered, settingsNewer, sessionNewer, tabsDropped, unexpectedError` (`packages/rpc-schema/src/ui-rpc.ts:334-341`). The `settingsTooLarge` id exists **only on `fix/bounded-reads`** (5 hits: `ui-rpc.ts:353`, `main-services.ts:130`, `main/strings.ts:71`, 2 tests). Control: the same per-branch loop counting `unexpectedError` returns 8 files on both `feat/jslab-m4` and `fix/bounded-reads`, so the search works. It renders through the *same* `StartupNotices` banner judged in §7 below — the judgement holds, but any change to the notice id enum collides with that branch.
2. **The drag/drop coverage claim checks out.** `git grep` over `apps/ui` at the base ref finds `onDrop` only in `shell/App.tsx:520` and `tabs/TabBar.tsx:106`; the only test references are `flows.dropFiles(...)` called directly (`test/file-flows.test.ts:270,377`). Control: `git grep 'SplitPane'` over the same path returns 10 hits. So the **JSX handlers themselves** — the `types.includes("Files")` guard and the `webkitGetAsEntry().isDirectory` folder detection — are genuinely uncovered.

---

## Ranked refinements

Ranked by user value per unit of effort. Effort: **XS** ≈ under an hour, **S** ≈ half a day, **M** ≈ 1–2 days, each including tests.

---

### 1. Copy All copies a different set depending on how you invoke it — **XS**

**Now.** The Copy All *button* copies the filtered list; the Copy All *command* (palette, menu, any future chord) copies everything.

- Button: `OutputPanel.tsx:86-93` maps over `entries`, which is `applyFilter(visible, filter)` (`:58`).
- Command: `commands/app-commands.ts:66-75` maps over `visibleEntries(state.output, {showUndefined})` only — it never reads `state.outputFilter` and never calls `applyFilter`.

So with the **Errors** chip selected and 200 log rows on screen, clicking Copy All gives you the errors; running "Copy All Output" from the palette gives you all 200 rows. Nothing tells the user which they got.

**This contradicts a documented, deliberate decision.** Spec §7.2: "Copy All is filtered (M2, R-M2-T19A-1): Copy All copies the entries visible under the current filter chip, not the whole output. This intentionally changes the M1 behavior." `docs/parity.md:121` (OU-11) already flags that Copy All's multi-entry composition "has no test joining its two already-tested pieces" — this is exactly the gap that hid the divergence.

**After.** Both paths call one helper (`filteredEntriesText(state)`), so the rule has a single owner, and the command honours the chip like the button does.

**Why better.** Copying a filtered error list is the actual workflow (paste the errors into a chat/issue). Silently getting 200 log lines instead is a data-integrity surprise, not a cosmetic one.

**Files.** `commands/app-commands.ts`, `output/OutputPanel.tsx`, new tiny module or reuse `output/filters.ts`. **Tests:** `apps/ui/test/commands.test.ts` + `test/output-panel.test.tsx` (which already asserts "Copy All follows the filtered list" for the button path only).

---

### 2. You cannot move focus to the output without a mouse — **S**

**Now.** There is **no command to focus the output**, and no chord that reaches it. Verified against the full catalogue: `packages/shared/src/commands.ts` has no `*.focus*` command at all; `DEFAULT_KEYBINDINGS` (`packages/shared/src/keybindings.ts`) binds nothing to focusing a region.

The output scroller is `tabIndex={0}` (`OutputPanel.tsx:99-100`), so Tab *could* reach it — but from Monaco, Tab inserts a tab character. In practice a keyboard user who starts in the editor stays in the editor.

This has a second, non-obvious cost: **the palette's context is derived from live DOM focus** (`App.tsx:275-283` — `active.closest(".output") ? "output" : "editor"`), and `match.ts:67-72` filters out `context: "editor"` items and bonuses `+50` to items matching the context. So the palette's Output mode — and the whole `output.show*` / `output.copyAll` group — is only comfortably reachable if you first clicked the output with a mouse.

**After.** Two commands — `view.focusOutput` and `view.focusEditor` — registered in the existing registry, each with a default chord, and both in the palette. Focusing the output moves DOM focus to the scroller; focusing the editor calls the existing `getEditorHandle()?.focus()`.

**Why better.** It makes the app genuinely keyboard-first (spec §6.5's own claim), and it turns the palette's context-sensitivity from an accident of mouse history into something a keyboard user can drive.

**Add two siblings while you're there:** `output.nextError` / `output.previousError`, moving the selection to the next error row *and* revealing its line in the editor via the existing `reveal(line)` (`store.ts:594-596`). Precedent: Zed binds `editor::GoToDiagnostic` / `GoToPreviousDiagnostic` to **F8 / Shift-F8** (https://zed.dev/docs/key-bindings), and VS Code uses **Alt+F8 / Shift+Alt+F8** (https://code.visualstudio.com/docs/editor/editingevolved). JSLab has the two halves already — `entryLevel(event) === "error"` (`output/filters.ts:8-23`) and `reveal` — so this is mostly wiring. It is the keyboard equivalent of the app's best pointer feature.

**Files.** `packages/shared/src/commands.ts`, `packages/shared/src/keybindings.ts`, `commands/view-commands.ts`, `output/OutputPanel.tsx` (a ref to focus). **Tests:** `test/keybindings.test.ts`, `test/palette.test.tsx`.

**Conflict watch.** `packages/shared/src/commands.ts` and `keybindings.ts` are edited by **m5h** (two tile commands + one chord) and **m5d** (keybindings UI). Land after, or coordinate the chord choice.

---

### 3. Nothing in the output is announced to assistive tech — **S–M**

**Now.** There is **no live region anywhere in the output**. Measured: `grep -F` for `aria-live`, `role="log"`, `role="status"`, `role="alert"`, `<output` across `apps/ui/src` returns 14 hits — every one of them is a banner (`shell/parts.tsx:30,53`), the activity spinner (`ActivityBar.tsx:69`), the web dialog (`WebDialog.tsx:27`), or sheet status text in the env/npm sheets. Control: `grep -F 'role='` over the same tree returns 40. `OutputPanel.tsx` and `EntryRow.tsx` contain only `aria-label` and `aria-hidden`.

So: with Auto Run on, code runs and results appear **with no user action and no announcement**. A screen-reader user gets silence whether the run produced `42` or a `TypeError`.

The status bar has the same problem from the other side: `StatusBar.tsx:56` renders `{message && <span className="status-message">{message}</span>}` — a plain span. Every transient message routed through `setStatusMessage` is silent and gone in 5 seconds (`store.ts:291,705-714`): "Couldn't format: …", "Installing zod…", "Couldn't copy the output to the clipboard.", the 64 MB `limits.tooLarge` refusal.

**After.**
- A single polite live region announcing **run outcome, not rows**: the label `runStateLabel` already computes (`shell/labels.ts:15-47`) plus an error count — e.g. "Run finished, 2 errors". Announcing 10,000 rows would be unusable; announcing the summary is the whole point.
- `.status-message` becomes an `<output>` (implicit `role="status"`), matching what `parts.tsx` already does for banners.

**Why better.** It is the difference between "the app works" and "the app is usable without sight". It also helps sighted users: the status message currently competes with a busy status bar and vanishes.

**Files.** `output/OutputPanel.tsx`, `shell/StatusBar.tsx`, `strings.ts`. **Tests:** `test/output-panel.test.tsx`, `test/layout.test.tsx`.

**Care — three rules from the specs, not taste:**
- **The live region must exist in the DOM before it has content.** MDN: "Establish the live region before updating its content. Start with an empty live region… The most reliable way to ensure that live regions are registered is to include them in the initial markup." (https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/ARIA_Live_Regions). So render the empty region unconditionally in `OutputPanel`, not only when there's something to say.
- **`role="status"` is implicitly `aria-live="polite"` + `aria-atomic="true"`** (https://www.w3.org/TR/wai-aria-1.2/#status) — which is exactly what `<output>` gives you, and what `parts.tsx` already relies on. Use polite, not `alert`: APG warns "Frequent interruptions inhibit usability for people with visual and cognitive disabilities" (https://www.w3.org/WAI/ARIA/apg/patterns/alert/).
- **Don't let an error message auto-vanish.** Today every non-sticky status message clears after 5s (`store.ts:291`). APG, on the alert pattern: "An alert that disappears too quickly can lead to failure to meet WCAG 2.0 success criterion 2.2.3." Error-severity status messages should be sticky (the mechanism already exists — `setStatusMessage(msg, {sticky: true})`).

Must not fire on every coalesced batch — tie it to `runState` transitions (`store.ts:521-540`), which already settle once per run.

---

### 4. Name **both** separators, not one — **XS (on top of m5h)**

**Now.** One `role="separator"` source (`SplitPane.tsx:72`), two production call sites (`App.tsx:575`, `OutputTiles.tsx:110`). When a browser-runtime tab shows the Web View preview, both are on screen and neither has a name: a screen reader announces two identical "separator, 55" controls.

**m5h already owns half of this, and deliberately stops halfway.** Its Task 13 (plan lines 2404-2540) adds exactly `label?: string` to `SplitPane`, a `strings.output.tiles.divider` string, and passes it **only** to the tile splitter. Its own test asserts the other one stays anonymous:

```tsx
expect(container.querySelector('[role="separator"]')?.hasAttribute("aria-label")).toBe(false);
```

That is a reasonable scope line for m5h, but the end state is one named separator and one unnamed one.

**After.** Reuse m5h's prop and pass a label from `App.tsx:575` too — "Editor and Output divider…", mirroring the tile one. Net change once m5h lands: one string, one prop, one test edit.

**The spec is explicit that two sashes must be told apart.** MDN, on `role="separator"`: a focusable separator "should include `aria-label` if there is more than one focusable separator" (https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/separator_role). The APG's preferred form is stronger still: "If the primary pane has a visible label, it is referenced by `aria-labelledby` on the separator element. Otherwise, the separator element has a label provided by `aria-label`" — and the label names **the primary pane**, not the handle (https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/). Since `OutputPanel` already renders a named region (`aria-label="Output"`, `OutputPanel.tsx:159`), `aria-labelledby` pointing at it is available and is the APG's first choice.

**Two more from the same APG page, both cheap:**
- **`Home`/`End`** jump the primary pane to its smallest/largest allowed size (optional in the pattern, trivial here — `onResize(10)` / `onResize(90)`).
- **`Enter` is specified as collapse/restore**, not reset: "If the primary pane is not collapsed, collapses the pane. If the pane is collapsed, restores the splitter to its previous position." JSLab binds Enter to *reset to default* (`SplitPane.tsx:83`). That is a deliberate, defensible deviation that matches the double-click — but it is a deviation, and worth one comment in the file so the next reader doesn't "fix" it into APG's meaning and break the double-click's twin.

**Already correct, don't change:** `aria-orientation` is set explicitly on both axes (`SplitPane.tsx:73`). This matters — for `role="separator"` the attribute **defaults to `horizontal`**, so a vertical sash that omitted it would be announced wrongly (same MDN page). `aria-valuemin`/`max` at 10/90 are honest, matching `clampEditorSize`.

**Why better.** Two named separators are distinguishable; two unnamed ones are not. This is the smallest possible delta over work already planned.

**Files.** `shell/App.tsx`, `shell/SplitPane.tsx`, `strings.ts`. **Tests:** `test/split-pane.test.tsx`, `test/layout.test.tsx` — and m5h's assertion above must be **updated, not deleted**, or the two changes will fight.

**Conflict.** Direct overlap with m5h Task 13. Sequence it after m5h merges and amend that one assertion.

---

### 5. Disabled commands vanish from the palette instead of explaining themselves — **S**

**Now.** `palette/match.ts:67`: `if (!item.enabled) return null` — a disabled command is filtered out before matching. So with nothing running, typing "Kill" or "Stop" in the palette gives **"No matching commands"** (`strings.ts:184`), which is exactly what a typo gives. Same for "Reopen Closed Tab" with an empty stack (`app-commands.ts:96`), "Reveal in Finder" on an unsaved tab (`:108-111`), and "Toggle Web View" on a `bun` tab (`view-commands.ts:35-38`).

The app already knows *why* in every case — `isEnabled` is a predicate per command — and it already has the vocabulary for it: the status-bar Web View button shows `strings.shell.webView.unavailable` as its `title` for precisely this situation (`StatusBar.tsx:92-93`).

**After.** Disabled items still rank and render, greyed, with `aria-disabled="true"`, not selectable by Enter, and carrying their reason in the existing `.palette-desc` slot (the slot is already there — `CommandPalette.tsx:174`). Optional `description()` already exists on `CommandSpec` and is already used for "currently on"/"current"/"limit 2000".

**Why better.** "This command exists but not right now, because X" is a different message from "no such command". It also makes the palette a place you can *learn* the app, which is the Daylight Rail brief.

**Precedent.** VS Code degrades rather than empties: as of v1.83, "A query no longer has to 'fuzzily' match to show up in the results. If there are fuzzy results, those still show up at the top and **similar commands** follow" (https://code.visualstudio.com/updates/v1_83). Alfred goes further and treats the empty state as a place to offer something — configured **fallback searches** shown "either only when there are no results or intelligently at the end of relevant results" (https://www.alfredapp.com/help/features/default-results/fallback-searches/). JSLab's `matchTitle` already returns a scored subsequence match (`match.ts:23-34`), so the ranking machinery for a "similar commands" tail is present.

**Files.** `palette/match.ts`, `palette/items.ts`, `palette/CommandPalette.tsx`, `styles.css`, plus `isEnabled` reasons in `commands/*`. **Tests:** `test/palette.test.tsx`.

---

### 6. After m5h, the inert `… N more` still exists — for objects — **XS**

**Now.** `ValueView.tsx:127` renders `<div className="v-hole">… {shown.more} more</div>` for *any* value carrying `more`. It is inert, and `.v-hole` is styled only as muted text (`styles.css:457-462`) — shared with array holes (`<N empty items>`, `format.ts:109`).

**m5h Task 10 fixes the collection half** (plan lines 1996-2115): the div becomes a `<button>` reading "… N more entries", paging via a new `offset`, appending pages, with the button disappearing when nothing is left. Good, and it explicitly reuses the `.v-more` "… N more characters" voice.

**But m5h draws a deliberate scope boundary** (plan line 160): "this plan pages **collections** — `array`, `typedArray`, `map`, `set` — and not object properties… Objects keep today's behaviour: `maxProps: 1000` on expand with an honest `more` count and no paging button."

So after m5h, an object with 1,500 properties still shows the **inert** `… 500 more` — visually near-identical to the clickable `… 500 more entries` one row below it in a nested tree. Same muted grey, same leading ellipsis, one is a button and one is dead.

**After.** Give the object case its own honest wording and styling so it never reads as a broken button — e.g. `500 more properties not shown` (no leading `…`, not button-shaped, `.v-hole-note`). One string, one branch.

**Wording precedent.** Node's `util.inspect` elides with literally `... ${remaining} more item${remaining > 1 ? 's' : ''}` (https://github.com/nodejs/node/commit/91ab769940), which is where the "… N more" idiom in this codebase comes from and why it reads as *collection* language. Reserving that phrasing for the paged, clickable collection case and giving objects different words is therefore also the more faithful choice, not just the clearer one.

**Why better.** An affordance that looks clickable and isn't is worse than plain text. This is the cheapest way to keep m5h's boundary from becoming a UI lie.

**Files.** `output/ValueView.tsx`, `strings.ts`, `styles.css`. **Tests:** `test/value-view.test.tsx`.

**Conflict.** Same lines as m5h Task 10. Land after it; it is a 3-line follow-up, not a competing design.

---

### 7. The notice banner: one severity for six (soon seven) different events — **S–M**

**Now.** Every notice renders identically: `<output className="banner banner-warning">` (`parts.tsx:53`), yellow-on-elevated (`styles.css:599-602`), message + optional action + a floated `×` (`styles.css:618-624`).

Judged against what it must carry: `settingsRecovered`, `sessionRecovered`, `settingsNewer`, `sessionNewer`, `tabsDropped`, `unexpectedError` (`ui-rpc.ts:334-341`), plus `settingsTooLarge` on `fix/bounded-reads`. These are not the same severity — "Settings were reset because the file was unreadable" is a *recovery* the user should know about; "Something went wrong" is an *error* with a Copy Debug Log action (`App.tsx:550-553`).

Specific problems, each from the code:
- **No severity distinction.** One class for all seven ids.
- **They stack and push the app down.** `.notices` is `display:flex; flex-direction:column` (`styles.css:605-608`) in normal flow between the toolbar and `.app-main` (`App.tsx:546-555`). Five notices (`MAX_NOTICES = 5`, `store.ts:288`) each with padding `6px 12px` plus a border take a visible slice of the editor, and nothing auto-dismisses.
- **Dismiss is a bare floated `×`** roughly 20×20 (`styles.css:618-624`), well under a comfortable target, and there is no "dismiss all".

**What's genuinely good and should stay:** dedup by id, a bounded queue that drops oldest, per-notice actions, `<output>` (so it *is* announced), and an accessible name that includes the message (`strings.shell.dismiss`).

**After.** A severity field on the notice (`info` | `warning` | `error`) driving colour and an icon; informational recoveries auto-dismiss after a timeout while errors persist; a "Dismiss all" when more than two are stacked; a slightly larger dismiss target.

**Why better.** The notice surface is the app's voice for "something happened to your data". Today it shouts everything in the same tone, and five of them eat the editor.

**Precedent, and one caution.** VS Code's own UX guidelines say to "**Show one notification at a time**", to "Respect the user's attention by only sending notifications when absolutely necessary", and — the interesting one for a startup-notice surface — to "**Add a Do not show again option for every notification**" (https://code.visualstudio.com/api/ux-guidelines/notifications). Its Notification Center (a status-bar bell with an unread count) is what makes dismissal safe, and its Do Not Disturb draws exactly the severity line proposed here: global DND "also hides error notifications, while the extension-specific filter still allows error notifications to show" (https://code.visualstudio.com/docs/getstarted/userinterface).
**Caution:** do **not** auto-dismiss the error severity — same WCAG 2.2.3 point as §3. Auto-dismiss belongs only to the informational recoveries.

**Files.** `packages/rpc-schema/src/ui-rpc.ts` (the `severity` field), `apps/desktop/src/main/startup-notices.ts`, `shell/parts.tsx`, `styles.css`, `strings.ts`. **Tests:** `test/app.test.tsx`, `apps/desktop/test/main-services.test.ts`.

**Conflict.** Touches the notice schema — **collides directly with `fix/bounded-reads`**, which is adding `settingsTooLarge` to the same enum. Do this after that branch merges.

---

### 8. Hovering a row highlights the editor line; focusing it does not — **XS**

**Now.** `EntryRow.tsx:48-49` wires `onMouseEnter`/`onMouseLeave` → `setHoveredLine`, which drives the editor's `.line-hover` decoration (`styles.css:240-242`). There is no focus equivalent. The row's only focusable child is the `:n` button (`EntryRow.tsx:66-76`) and any action buttons.

So a keyboard user tabbing through output rows gets no indication of which editor line each row belongs to — the exact connection that makes line-anchored output worth having.

**After.** Add `onFocus`/`onBlur` beside the existing mouse handlers on the `:n` button, calling the same `onHover`.

**Why better.** Two props for parity between pointer and keyboard on the app's signature feature.

**Files.** `output/EntryRow.tsx`. **Tests:** `test/entry-row.test.tsx` (which already covers the hover path).

---

### 9. Filter chips count two of four categories — **XS**

**Now.** `FilterChips.tsx:5`: `const COUNTED = new Set(["all", "errors"])`. So chips read "All 12", "Results", "Logs", "Errors 3". The counts for all four already exist — `filterCounts` computes every one (`output/filters.ts:39-47`).

**After.** Show all four counts (or none). The data is already there and already memoized (`OutputPanel.tsx:57`).

**Why better.** "Logs" vs "Logs 47" is the difference between a label and a fact; and asymmetry reads as a bug. Low value, near-zero effort — included because it is free.

**Caveat.** Chips are fixed-width-ish at `font: 500 11.5px` (`styles.css:1288-1293`); adding two numbers widens the row. m5e's Task 14 display-width budget for CJK locales is the constraint to check against, not English.

**Files.** `output/FilterChips.tsx`. **Tests:** `test/output-filters.test.tsx`.

---

### 10. Make the two window-level drop handlers testable — **S**

**Now.** `App.tsx:517-529` holds two inline JSX handlers with real logic in them: the `types.includes("Files")` guard in both, and folder detection via `[...event.dataTransfer.items].filter(item => item.webkitGetAsEntry?.()?.isDirectory).map(item => item.getAsFile()?.name ?? "")`. Measured uncovered (see §0, correction 2).

The repo already has the right pattern for this: `tabs/TabBar.tsx` keeps its drag handlers thin and puts the arithmetic in a pure module, `tabs/reorder.ts` — m5h's plan cites exactly this precedent (plan line 174).

**After.** Extract `filesFromDrop(dataTransfer): { files: File[]; folders: Set<string> } | null` into `files/drop.ts`, returning `null` when the drag carries no `Files`. `App.tsx` becomes two one-liners; the logic gets unit tests with a fake `DataTransfer`.

**Why better.** This is the path a dropped file takes into the app, and the folder branch drives a user-visible notice (`strings.files.folderDrop`). It is also the one piece of `App.tsx` that a tile drag could plausibly break.

**Conflict.** m5h Task 5 plans to test the App-drop ↔ tile-drag interaction in `apps/ui/isolated/app.test.tsx`. Extracting the function makes that test easier, but coordinate so both aren't written twice.

**Files.** new `files/drop.ts`, `shell/App.tsx`. **Tests:** new `test/drop.test.ts`.

---

### 11. The value tree has no keyboard navigation and no Expand All — **S** *(added after the precedent review; ranks ~6th by value/effort)*

**Now.** Each expandable node is a real `<button className="v-toggle" aria-expanded={open}>` (`ValueView.tsx:97`), so Tab reaches it and Enter/Space toggles it. That is the floor, and it works. What's missing above the floor:

- **No arrow-key navigation.** Left/Right do nothing on a focused node.
- **No Expand All.** Spec §7.2 lists it in the entry `⋯` menu ("Explain Result, Copy, Copy as JSON, Expand All"), and `docs/parity.md:113` (OU-03) records that no test covers an aggregate Expand All "(only per-node expand is tested)". In the shipped UI there is **no entry menu at all** — confirmed by reading `EntryRow.tsx:42-77`, and stated outright in parity OU-11: "there is no right-click context menu or per-entry Copy in the current UI/tests at all".

So inspecting a 6-level object means six separate Tab-and-Enter trips.

**After.** On a focused `.v-toggle`: **Right** expands (or moves into the first child), **Left** collapses (or moves to the parent). Plus one modified activation that expands the whole subtree.

**Precedent.** Chrome DevTools' object tree: "**Left/Right** collapse/expand a node", and **Alt-click** (Windows: Control+Alt) on a disclosure arrow "expands all sub-properties" recursively (https://developer.chrome.com/docs/devtools/shortcuts). Firefox's Web Console uses the same Right-expand / Left-collapse (https://firefox-source-docs.mozilla.org/devtools-user/web_console/rich_output/index.html). Both are decades-settled conventions for exactly this widget.

**Why better.** The value tree is where a scratchpad user actually spends their attention, and it is currently the least keyboard-navigable part of the app.

**Care — this one has a real trap.** Expand-all over **lazy handles** would fan out into many `run.expand` RPCs at once (`ValueView.tsx:74-93` fires one per node). Bound it: expand only already-loaded children, or cap depth, and never let one keystroke issue an unbounded request storm. The existing `requestInFlight` guard is per-node, not global.

**Files.** `output/ValueView.tsx`, `styles.css`. **Tests:** `test/value-view.test.tsx`.

**Conflict.** m5h Task 10 rewrites this component's children-rendering and `ExpandHandle` signature. Land after m5h.

---

## Explicitly **not** proposed

- **A second resizer / resize handles on the Web View.** Already ruled on and already shipped: drag + double-click reset + arrow keys + per-tab persistence (`SplitPane.tsx:38-85`, `store.ts:479-488`). m5h's ruling R-M5H-BOTTOM-1 says so at length and it is correct.
- **Virtualizing inside the value tree.** m5h Task 10 rejects it with a concrete reason — a second virtualizer inside a row measured by the outer one fights it. Agreed.
- **Tabs for the filter chips.** `FilterChips.tsx:7-25` already documents why they are a `radiogroup` and not a `tablist`: the chips narrow one list, none owns a panel, and `aria-controls` would point at nothing. That reasoning is right; don't "fix" it.
- **A welcome/empty-state design.** M5a already ships a real first-run welcome tab (`apps/desktop/src/main/welcome.ts`) — five numbered samples covering Auto Log, `//?`, logpoints, fetch and React, in `tsx`, with fetch and React commented so nothing runs or hits the network at launch. It is good. The remaining first-run surface, the output panel's "No output yet — press ⌘R", is also already right.

---

## Already good — leave alone

1. **The error row.** Name + message, code frame, source-mapped clickable frames, collapsed internal-frame count, and *contextual* actions — "Install `x`" on a module-not-found, "Set Working Directory…" on a relative-import failure, "Change…" on a `WorkingDirectoryError` (`EntryRow.tsx:119-172`). This is better than most devtools manage.
2. **The npm failure card** (`NpmSheet.tsx:359-392`). Classified error → one-line fix hint → `<details>` raw log → Retry / Allow Scripts and Retry / Copy Log / Dismiss, in `role="alert"`. This is the best error surface in the app and should be the model the notice banner (§7) moves toward.
3. **The command palette.** `combobox`+`listbox` with `aria-activedescendant`, focus restore to the real opener with a fallback, a scrim `mousedown` `preventDefault` so the restored focus sticks, a panel-level `mousedown` guard so clicking padding doesn't blur the input, and a close chord that follows a *rebound* `view.commandPalette` rather than a hard-coded ⌘⇧P (`CommandPalette.tsx:54-55,66-73,86-108`). Five separate focus bugs already fixed. Don't touch the focus handling.
4. **Keycaps come from the effective bindings everywhere** — toolbar, activity bar, palette, status messages, empty state (`App.tsx:244-250,298-306`). A user who rebinds Run sees their own chord in the empty output panel. Rare and correct.
5. **The non-blocking web dialog** (`WebDialog.tsx`). A FIFO queue, `role="status"`, no backdrop, no focus trap, a "N more waiting" count — the right answer to a runtime that cannot block, and the doc comment explains why.
6. **Stale-output handling.** Dimming + "Last successful run" + keeping the last good output above a new syntax error, with transpile errors deliberately excluded from dimming because they belong to the code in the editor (`state/output.ts:61-74`, `output/stale.ts`).
7. **`SplitPane`'s drag teardown.** Listeners removed on unmount mid-drag *and* when the second pane is hidden mid-drag — both with tests (`SplitPane.tsx:17-36`, `test/split-pane.test.tsx`). Only the missing name (§4) needs work.
8. **The output's empty and no-match states.** Quiet, centered, no icon, and the no-match one offers the fix (`Show all`) rather than just reporting (`OutputPanel.tsx:140-152`).
9. **`FilterChips`' accessibility reasoning**, and `TileHeader`'s on m5h — both chose a role by arguing from what the structure actually is. Keep that habit.

---

## Localisation note

Every string proposed above must go through `apps/ui/src/strings.ts`, never inline JSX. **m5e** converts that module's 351 plain leaves and 69 functions into `t()` calls with namespaced keys, keeping the module's *shape and import path unchanged* (m5e plan lines 63-73, 237), and adds a Biome `noJsxLiterals` rule. So: add to `strings.ts` in the existing shape and the sweep will pick it up. Two constraints from that plan worth respecting now:

- **No string concatenation for sentences** — m5e interpolates via i18next vars.
- **Width budgets**: m5e Task 13-14 flags that the bundled fonts have no CJK coverage and gates width-critical labels with a display-width budget. §9's chip counts and §7's notice severity labels are width-critical; keep them short.

---

## Inspiration, and what was rejected

Sources were read as public documentation only. **No RunJS binary, `app.asar`, bundled JS or anything under `/Applications/RunJS.app` was opened, sought or referenced** — by me or by the research agent, which carried the constraint verbatim.

### What I looked at

**Line-anchored / inline results:** Quokka.js (inline decorations + Value Explorer + run modes), Xcode Playgrounds (results sidebar, Quick Look, "Show Result" inline views), Swift Playgrounds, Jupyter/JupyterLab (`In[n]`/`Out[n]`, iopub rate limits), Observable (`invalidation`), Pluto.jl (reactive re-run), Chrome DevTools Live Expressions, VS Code notebook output limits.
**Value inspection:** Node `util.inspect` defaults and elision text, Chrome DevTools object tree + keyboard, Firefox Web Console rich output.
**Splitters:** W3C ARIA APG *Window Splitter*, MDN `separator` role, react-resizable-panels, VS Code (as a negative result).
**Notices:** VS Code notification UX guidelines + Notification Center + Do Not Disturb, WAI-ARIA 1.2 `status`/`alert`, APG *Alert*, MDN ARIA Live Regions, Adrian Roselli on toasts.
**Palettes:** VS Code Command Palette / Quick Open prefixes and fuzzy matching, Sublime Text Goto Anything, Raycast Action Panel + frecency + aliases, Alfred fallback searches, VS Code Keyboard Shortcuts editor.
**Inline diagnostics & empty states:** Zed, Nova, JetBrains Fleet, VS Code `viewsWelcome`, NN/g on empty states.

### What I took, and where it landed

| Idea | Source | Lands in |
|---|---|---|
| A focusable separator needs a name; ≥2 separators must each be named; prefer `aria-labelledby` → the primary pane | APG Window Splitter; MDN `separator` role | §4 |
| `aria-orientation` defaults to `horizontal` for `separator` | MDN | §4 (confirms JSLab is already right) |
| Home/End to min/max; Enter = collapse/restore (JSLab deviates deliberately) | APG Window Splitter | §4 |
| A live region must exist in the markup *before* it has content | MDN ARIA Live Regions | §3 |
| `role="status"` ⇒ polite + atomic; reserve assertive for genuine interruption | WAI-ARIA 1.2; APG Alert | §3 |
| "An alert that disappears too quickly" can fail WCAG 2.2.3 | APG Alert | §3, §7 |
| One notification at a time; "Do not show again"; a bell/history makes dismissal safe; DND still shows errors | VS Code notification guidelines + UI docs | §7 |
| Degrade to "similar commands" instead of an empty result; offer fallbacks rather than "no results" | VS Code v1.83; Alfred | §5 |
| `... N more items` is *collection* language, from Node | Node commit 91ab769940 | §6 |
| F8 / Shift-F8 (Zed), Alt+F8 (VS Code) to walk diagnostics | Zed; VS Code | §2 |
| Left/Right collapse/expand; Alt-click expands a subtree | Chrome DevTools; Firefox | §11 |
| Inline diagnostics as "a lens to the right of the code" | Zed | Validates the Graphite line-anchored direction — no change needed |
| An empty state should give one direct actionable pathway (a button), not prose | NN/g; VS Code `viewsWelcome` | Validates the existing "Show all" button and `press ⌘R` keycap |

### What I rejected, and why

- **"Store as global variable" (`temp1`, `temp2`…)** — DevTools' best large-value idea, and it does not fit. It only pays off if you have a REPL prompt to poke the stored value with. JSLab's output panel has no input line (`OutputPanel.tsx` renders a toolbar and a scroller, nothing else), and adding one is a different product. Storing a value into a place the user cannot type at is theatre.
- **Jupyter's iopub rate limit** (1 MB/s over a 3 s window, after which the server *silently* stops forwarding output) — rejected outright as an anti-pattern. JSLab already does the honest version: an explicit `truncated { dropped }` event and a visible "Output truncated: N more entries were dropped. Raise the limit in Settings → Advanced." (`strings.ts:200-201`). Don't trade a counted, fixable cap for silent loss.
- **Jupyter's execution-count staleness model** — the report found it is the documented user complaint, with no "this cell was edited" marker at all. JSLab's dim + "Last successful run" is strictly better and already shipped. Keep it.
- **Pluto.jl's reactive re-run of dependent cells** — structurally inapplicable. JSLab runs a whole file in a fresh realm per run (spec §5.12); there are no cells and no dependency graph to be reactive over.
- **Quokka's separate Value Explorer panel** — rejected as a *new region*. JSLab already has the output area's two positions plus the side bar (which M5a and M5b are both filling); a third inspection region fights the Graphite layout rather than serving it. The transferable half — an escape hatch for an enormous value — is already being answered by m5h's paging.
- **VS Code notebooks' "Open output in text editor"** — deferred rather than rejected. Genuinely the right answer for a 1 MB string, but it needs a read-only tab kind that doesn't exist yet; M5a's `TranspiledPanel` is the nearest thing. Revisit post-v1.
- **Raycast-style frecency ranking in the palette** — rejected *for the no-query list*. `match.ts:76-80` currently orders the empty-query palette by fixed category order, which makes it a stable, learnable menu (~105 rows, deliberately uncapped per FB-m1). Frecency would reshuffle that list under the user between openings. It would be defensible for the *queried* case only, which is a smaller, later change.
- **VS Code as the splitter model** — rejected as a source. Its accessibility documentation doesn't mention sashes or split resizing at all, and keyboard resizing exists only as `workbench.action.increaseViewSize`-style commands with known gaps. APG and MDN are the authorities here.

### Claims the research could not verify (do not cite these as fact)

The agent flagged these as unverified against primary sources, and I have not used any of them as load-bearing evidence: Chrome DevTools' `[0 … 99]` array-bucketing thresholds; VS Code's "recently used" top-50 palette section; VS Code's literal "No matching commands" empty-state string; VS Code's per-severity notification auto-dismiss timings (maintainer evidence suggests extension notifications don't auto-close at all); and whether the APG page literally specifies `tabindex="0"` or a percent unit for `aria-valuenow`.
