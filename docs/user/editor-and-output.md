# The editor and live output

JSLab's editor is Monaco (the engine behind VS Code) with TypeScript, JavaScript, TSX and JSX modes, bracket
matching, folding, multi-cursor editing, and optional Vim keys (Settings → Editor → Vim Keys).

## Auto Run and Auto Log

- **Auto Run** (`run.autoRun`) runs your code a short delay after you stop typing — the delay is
  `run.autoRunDelayMs` in Settings → Advanced, 300 ms by default. <kbd>⌘R</kbd> always runs immediately,
  whether or not Auto Run is on.
- **Auto Log** (`run.autoLog`) logs the value of each top-level expression automatically, no `console.log`
  needed. A leading string literal at the top of a file is logged too (`"use strict"` is not, since it's a
  directive). Turn off Auto Log to see only what you explicitly log.
- **Show Undefined** (`run.showUndefined`, Settings → Advanced) controls whether an expression whose value is
  `undefined` gets its own row.

## Magic comments

A magic comment logs exactly what you ask for, regardless of Auto Log:

- `value //?` — logs `value`.
- `/*?*/` inline, mid-expression or before a block's opening brace.
- `//? $.length` — logs an expression built from the value (`$`), such as its `.length`.

<kbd>⌘⌥⇧/</kbd> (Toggle Magic Comment) adds or removes one on the current line.

## Logpoints

A **logpoint** logs a line without editing its text. Click the gutter beside a line, or press <kbd>F9</kbd>
with the caret on it, to toggle one; <kbd>⇧⌘F9</kbd> clears every logpoint in the tab. Logpoints:

- Follow their line as you edit above or below them.
- Belong to one tab and are **not saved** — they reset when the tab is closed or the app restarts.
- Trigger a run on their own: toggling one schedules a run even if nothing else changed.

## Loop protection

`for`, `while`, `do…while`, `for…in` and `for…of` loops are stopped automatically after too many iterations, so
a typo like `while (true)` can't hang a run. The default limit is 2,000 iterations
(`run.loopProtectionMaxIterations`, Settings → Advanced, adjustable up to 10,000,000), and the whole feature can
be turned off there too, or toggled from the command palette (Toggle Loop Protection).

## Show Transpiled Output

Actions → Show Transpiled Output puts the Babel output for the current tab in the side bar — with or without
the Auto Log / logpoint / loop-protection instrumentation, via a toggle in the panel. It refreshes on each run
and tells you when you've edited past the run that produced what's on screen.

## Stopping a run

<kbd>⌘⇧R</kbd> stops a run gracefully; if it doesn't respond, JSLab escalates to a kill after 500 ms.
<kbd>⌘⌥R</kbd> kills it outright. If your code stops responding entirely, JSLab shows a **Tab Unresponsive**
prompt (Settings → Advanced → `run.unresponsiveTimeoutMs`, 3 seconds by default) offering to kill the tab or
keep waiting.

## Zoom

<kbd>⌘=</kbd> / <kbd>⌘−</kbd> / <kbd>⌘0</kbd> scale the editor, output panel and window chrome together
(`appearance.uiScale`).

See also: [the output panel](output-panel.md) for what happens to everything this page logs, and
[keybindings](keybindings.md) for the full shortcut table.
