# The output panel

Every result, log and error appears as a row in the output panel, tagged with the line that produced it. Click
a row's line number to jump the editor there; hovering a row highlights that line.

## Filters

Filter chips — **All**, **Results**, **Logs** and **Errors** — each show a live count. Switch chips to narrow
what's shown; **Copy All** (below) copies only the entries the current filter shows.

## Reading a row

- Errors are tinted, marked in the editor margin, and show stack frames mapped back to your source lines —
  click a frame to jump there.
- Objects, arrays, Maps and Sets expand on click, one level at a time. **Alt+Right**, or Alt-click on the
  disclosure arrow, expands everything under a value at once. A large collection (an Array, Map, Set or typed
  array) offers "… N more entries" to load the next page; a plain object's own properties are not paged — past
  the property cap it states its true remaining count with no button.
- `http://` and `https://` links in results, console arguments, stdout/stderr and error messages are clickable:
  Cmd/Ctrl-click, or Tab to them and press Enter/Space. Other schemes (`javascript:`, `data:`, `file:`, and any
  URL carrying credentials) are never made clickable.
- A syntax error keeps the last successful output on screen, dimmed and labeled, instead of clearing it.
- Very large output is bounded — a huge string or a huge number of entries is truncated rather than freezing
  the window, with a note showing how many entries were dropped and pointing at Settings → Advanced to raise
  the cap (`output.maxEntries`, 10,000 by default).

## Copying a row

Right-click a row (or open its per-row menu button, or press Shift+F10 / the Menu key while it's focused) for:

- **Copy** — the row's value as plain text.
- **Copy as JSON** — the row's value as JSON. It can't throw and never yields bare `undefined`: circular
  references become `"[Circular]"`, `undefined` stays the string `"undefined"`, `NaN`/`±Infinity` keep their
  names instead of collapsing to `null`, and Map entries serialize as pairs so keys `1` and `"1"` can't
  collapse into each other. It serializes exactly what's on screen and never re-fetches, so a truncated value
  copies as the truncated text.
- **Explain Result** — sends the row to [AI Chat](ai-chat.md) with a prompt like "Explain why line `<L>`
  produces this result:" (or, for a stdout/stderr row with no result line, "Explain why the code produces this
  output:"). This ships for Ollama only today; see [AI chat](ai-chat.md) for what that means. With no AI
  provider configured the panel still opens, with nothing queued to send.

Right-clicking empty space in the output panel offers **Copy All** (every entry the current filter shows) and
**Clear** (<kbd>⌘K</kbd>).

## Highlighting and line numbers

Settings → Appearance has independent toggles for syntax highlighting in the output (`output.highlighting`)
and line numbers on each row (`output.showLineNumbers`).
