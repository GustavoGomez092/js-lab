# Formatting

JSLab formats your code with [Prettier](https://prettier.io). <kbd>⌥⇧F</kbd> (Format Code) formats the
current tab in a single undo step, preserving folds, scroll position and cursor position.

## Automatic formatting

- **Format on Run** (Settings → General) formats before every run.
- **Format on Save** (Settings → Editor) formats when you save.

## Options

Settings → Formatting exposes every option JSLab supports, with these defaults:

| Setting | Default |
|---|---|
| Print Width | 80 |
| Tab Width | 2 |
| Use Tabs | Off |
| Semicolons | On |
| Single Quote | Off |
| Quote Props | As needed |
| JSX Single Quote | Off |
| Trailing Comma | All |
| Bracket Spacing | On |
| Bracket Same Line | Off |
| Arrow Parens | Always |

Formatting applies minimal edits rather than replacing the whole buffer, which is what lets your folds, scroll
position and cursor survive a format.
