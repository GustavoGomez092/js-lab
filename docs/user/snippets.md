# Snippets

<kbd>⌘B</kbd> opens the Snippets panel in the side bar (pressing it again hides the panel, or switches to it
if another side-bar panel is showing).

## Using a snippet

A snippet's **name is its trigger**: type the name in the editor and press <kbd>Tab</kbd> to expand it — even
after you've typed the whole name, autocomplete still narrows down to that one exact match. From the panel
itself you can **Insert**, **Insert in New Tab**, **Copy**, **Edit** or **Delete** the selected snippet; search
by name or description with the panel's search field. Deleting asks for confirmation and stays undoable until
your next change.

A snippet's body can carry cursor placeholders — `$0` marks where the cursor lands after expansion, and `$1`,
`${1:like this}` and so on are tab stops. A body with none of these is inserted literally, `$` left alone.

## Creating a snippet

**Create Snippet…**, from the Edit menu or the editor's context menu, starts a new snippet from your current
selection — or the whole buffer if nothing is selected.

## Import and export

Snippets → Import… and Snippets → Export… (or the panel's own Import/Export buttons) move the whole library as
JSON, in a documented `jslab-snippets` format:

```json
{ "format": "jslab-snippets", "version": 1, "snippets": [] }
```

Importing **merges** with your existing library by name (case-insensitively): a name conflict asks whether to
overwrite, keep both, or skip, and every imported snippet is given a fresh id regardless of what the file's
own id said — an imported file can never alias or overwrite an existing snippet just by claiming its id.

> Inserting a snippet is live code: if Auto Run is on, an inserted snippet runs like anything else you type —
> including one you just imported from someone else's library.
