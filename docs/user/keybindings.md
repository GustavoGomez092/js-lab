# Keybindings and the command palette

## Command palette

<kbd>⌘⇧P</kbd> opens the command palette and searches every command. Matches are highlighted, results are
grouped by section, toggle commands show whether they're currently on, and each result shows its shortcut, if
it has one.

## Default keybindings

These are JSLab's real shipped defaults (macOS). A shortcut marked **editor** only fires while the editor has
focus; everything else fires anywhere in the window.

### Run

| Shortcut | Command |
|---|---|
| <kbd>⌘R</kbd> | Run |
| <kbd>⇧⌘R</kbd> | Stop |
| <kbd>⌥⌘R</kbd> | Kill |
| <kbd>⌥⌘A</kbd> | Toggle Auto Run |
| <kbd>⌥⌘L</kbd> | Toggle Auto Log |
| <kbd>⌥⇧F</kbd> | Format Code |

### Files and tabs

| Shortcut | Command |
|---|---|
| <kbd>⌘O</kbd> | Open… |
| <kbd>⌘S</kbd> | Save |
| <kbd>⇧⌘S</kbd> | Save As… |
| <kbd>⌘T</kbd> | New Tab |
| <kbd>⌘W</kbd> | Close Tab |
| <kbd>⇧⌘T</kbd> | Reopen Closed Tab |
| <kbd>⌥⌘T</kbd> | Close Other Tabs |
| <kbd>⌥⌘→</kbd> / <kbd>⌃⇥</kbd> | Next Tab |
| <kbd>⌥⌘←</kbd> / <kbd>⌃⇧⇥</kbd> | Previous Tab |
| <kbd>⌘1</kbd>–<kbd>⌘9</kbd> | Go to Tab 1–9 |

### Editing (editor only)

| Shortcut | Command |
|---|---|
| <kbd>⇥</kbd> | Expand snippet (only when a snippet name sits before the caret — otherwise Tab indents as normal) |
| <kbd>⌘/</kbd> | Toggle Line Comment |
| <kbd>⌥⌘/</kbd> | Toggle Block Comment |
| <kbd>⌥⇧⌘/</kbd> | Toggle Magic Comment |
| <kbd>F9</kbd> | Toggle Logpoint |
| <kbd>⌃Space</kbd> | Trigger Suggestions |
| <kbd>F1</kbd> | Show Hover |
| <kbd>⌘F1</kbd> | Show Diagnostic |
| <kbd>⌘F</kbd> | Find |
| <kbd>⌥⌘F</kbd> | Replace |
| <kbd>⌘G</kbd> | Find Next |
| <kbd>⇧⌘G</kbd> | Find Previous |
| <kbd>⌃G</kbd> | Go to Line… |
| <kbd>⌃⇧K</kbd> | Delete Line |
| <kbd>⌘L</kbd> | Select Line |
| <kbd>⇧⌘L</kbd> | Split Selection into Lines |
| <kbd>⇧⌘↩</kbd> | Insert Line Before |
| <kbd>⌘↩</kbd> | Insert Line After |
| <kbd>⌘D</kbd> | Select Next Occurrence |
| <kbd>⇧⌘Space</kbd> | Expand Selection |
| <kbd>⇧⌘M</kbd> | Select to Bracket |
| <kbd>⌘M</kbd> | Go to Bracket |
| <kbd>⌃⌘↑</kbd> | Move Line Up |
| <kbd>⌃⌘↓</kbd> | Move Line Down |
| <kbd>⌘J</kbd> | Join Lines |
| <kbd>⇧⌘D</kbd> | Duplicate Line |
| <kbd>F5</kbd> | Sort Lines |
| <kbd>⌘F5</kbd> | Sort Lines (Case-Insensitive) |
| <kbd>⇧⌘F5</kbd> | Reverse Sort Lines (Case-Insensitive) |
| <kbd>⌘⌫</kbd> | Delete to Line Start |
| <kbd>⌃⇧↑</kbd> | Add Cursor Above |
| <kbd>⌃⇧↓</kbd> | Add Cursor Below |

### Editing (anywhere)

| Shortcut | Command |
|---|---|
| <kbd>⌘K</kbd> | Clear Output |
| <kbd>⇧⌘F9</kbd> | Clear All Logpoints |

### View and layout

| Shortcut | Command |
|---|---|
| <kbd>⌘,</kbd> | Settings… |
| <kbd>⌘=</kbd> | Zoom In |
| <kbd>⌘−</kbd> | Zoom Out |
| <kbd>⌘0</kbd> | Actual Size |
| <kbd>⌥⌘\\</kbd> | Toggle Vertical Split |
| <kbd>⌥⌘W</kbd> | Toggle Web View |
| <kbd>⌥⌘O</kbd> | Focus Output |
| <kbd>⌥⌘E</kbd> | Focus Editor |
| <kbd>⌃⌘F</kbd> | Toggle Full Screen |
| <kbd>⇧⌘P</kbd> | Show Command Palette |

### Tools

| Shortcut | Command |
|---|---|
| <kbd>⌘I</kbd> | NPM Packages… |
| <kbd>⌘B</kbd> | Snippets… |
| <kbd>⌃⌘I</kbd> | AI Chat… |

Environment Variables has no default shortcut — open it from Tools → Environment Variables… or the command
palette.

## Customizing shortcuts

Settings → Keybindings lists every command with its current shortcut, where it applies, and whether that
binding is JSLab's default or one you set. Click a row and press the keys you want to record a new shortcut;
JSLab warns if another command already answers to that chord, and offers a reset per command or for the whole
keymap. Changes apply to the running app immediately — including what the menu bar shows — with no relaunch
needed.

Overrides are also readable and hand-editable as `keybindings.json` in your data folder (see
[Troubleshooting](troubleshooting.md) for where that is): an array of `{ "key": "...", "command": "..." }`
rules, applied on top of the defaults in file order. Prefixing a command id with `-` (for example
`"-run.start"` on `cmd+r`) removes that default binding instead of adding a new one.
