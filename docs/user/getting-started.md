# Getting started

JSLab is a scratchpad: open a tab, type JavaScript or TypeScript, and see the result beside the line that
produced it. There's no project to create and no build step.

## First launch

The first time JSLab opens it starts on a **welcome tab** — a short TypeScript sample that shows Auto Log, a
magic comment, a `fetch` call and a small React snippet (the network call and the React import ship commented
out, so nothing runs or fails before you've touched anything). Every later launch restores your previous
session instead: the tabs, their code, your cursor and scroll position, and the window's size and display all
come back as you left them.

## Running code

- Type, and JSLab runs your code a moment after you stop (**Auto Run**). Turn it off in Settings → General, or
  toggle it from the command palette.
- <kbd>⌘R</kbd> runs on demand. <kbd>⌘⇧R</kbd> stops the run; <kbd>⌘⌥R</kbd> kills it outright.
- Every top-level expression is logged automatically (**Auto Log**) — no `console.log` needed. Results, logs and
  errors appear in the output panel beside the line that produced them; click a row to jump the editor to that
  line.
- A **syntax error** keeps the last successful output on screen, dimmed, instead of clearing it.
- If your code hangs, JSLab detects an unresponsive run and offers to kill the tab rather than freezing the
  editor with it — each run happens in its own process, so a crash or infinite loop never takes the app down.

## Tabs

<kbd>⌘T</kbd> opens a new tab, <kbd>⌘W</kbd> closes the current one (closing the last tab opens a fresh one
instead of quitting), and <kbd>⌘1</kbd>–<kbd>⌘9</kbd> jump straight to a tab. A tab's title comes from its
first line until you save it, at which point it takes the file's name. **Open** (<kbd>⌘O</kbd>) and **Save
As** work with `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `.json` and `.txt` files, or you
can drop a file onto the window. Dropping a folder instead sets it as the tab's working directory — see
[NPM packages and the working directory](npm-packages.md).

## Where to go next

- [Choosing a runtime](runtimes.md) — Bun, Browser & Node APIs, or Browser, and when each makes sense.
- [The editor and live output](editor-and-output.md) — magic comments, Auto Log, logpoints, loop protection.
- [The output panel](output-panel.md) — filters, copying, Explain Result.
- [Keybindings and the command palette](keybindings.md) — every default shortcut, and how to change one.
