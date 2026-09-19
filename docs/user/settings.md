# Settings

<kbd>⌘,</kbd> opens a searchable Settings window with nine tabs: General, Editor, Formatting, Appearance,
Keybindings, AI, NPM, Build and Advanced. Every field has help text, and changes apply live — nothing needs a
relaunch except a UI language change, which says so.

## General

Auto Run, Auto Log, the default runtime and language for new tabs, Format on Run, Confirm Close (ask before
closing any tab), and the UI language.

## Editor

Line Numbers, Line Wrap, Vim Keys, Close Brackets, Invisibles, Active Line, Autocomplete, Linting, Hover Info
(with its delay), Signatures (parameter hints), Format on Save, and Minimap.

## Formatting

Every Prettier option JSLab exposes: Print Width, Tab Width, Use Tabs, Semicolons, Single Quote, Quote Props,
JSX Single Quote, Trailing Comma, Bracket Spacing, Bracket Same Line and Arrow Parens. See
[Formatting](formatting.md) for the defaults and how they're applied.

## Appearance

Theme (with separate Light/Dark choices and Follow System Appearance), font and font size, font ligatures, UI
scale, panel visibility (Tab Bar, Activity Bar, Status Bar, Side Bar), split layout, and the output panel's
highlighting and line-number toggles. See [Themes and appearance](themes.md).

## Keybindings

Every command with its shortcut, scope and source (default or yours), and a way to record, reset or clear one.
See [Keybindings](keybindings.md).

## AI

- **Provider** — which AI service answers questions about your code. **None** turns AI Chat off. Only
  **Ollama (Local)** actually works today; the picker only offers what ships, though a value written by a
  future build round-trips unrecognized rather than being erased. See [AI chat](ai-chat.md) for why.
- **Ollama Model** — the model name to ask for. Blank uses the default that ships with this version.
- **Ollama Base URL** — blank uses the standard endpoint, `http://localhost:11434`.
- **Send Recent Output** — include the most recent run's output as context, up to 20 KB.

## NPM

Allow Install Scripts, Auto-install `@types`, and an `.npmrc` editor with Reset and Save. See
[npm packages and the working directory](npm-packages.md).

## Build

Which syntax proposals the transform enables — decorators mode (standard, TypeScript legacy, or none),
pipeline operator, do expressions, throw expressions, `function.sent`, RegExp modifiers, and optional-chaining
assignment.

## Advanced

Show Undefined, Loop Protection (on/off and its iteration limit), the Auto Run delay, the unresponsive-run
timeout, the output panel's entry cap, and the Auto Updates toggle and channel (stable/canary) — the toggle
itself has no signed build to check against yet; see [Troubleshooting](troubleshooting.md).
