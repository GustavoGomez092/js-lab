# Themes and appearance

JSLab ships **Graphite**, a dark native theme, and **Graphite Light** — the defaults — and can follow the
macOS appearance automatically (**Follow System Appearance**, Settings → Appearance). Other built-in themes:
Dracula, One Dark, Monokai, Material Darker, Ayu Dark, Ayu Mirage, SynthWave '84, Shades of Purple, Nord,
Night Owl, Catppuccin Mocha, GitHub Dark, Solarized Dark, Tomorrow Night, GitHub Light, Solarized Light,
Catppuccin Latte, Ayu Light and Visual Studio Light. Every built-in theme meets WCAG AA contrast on its
text/background pairs. All of them are free — there's no paid tier.

Pick a theme from the **Themes** menu, the command palette, or Settings → Appearance, which also lets you set
separate **Light Theme** and **Dark Theme** choices for when Follow System Appearance is on.

## Importing a VS Code theme

**Themes → Import VS Code Theme…** accepts a `.json` theme file or a `.vsix` extension package (a `.vsix` that
bundles several themes shows a picker). JSLab maps the TextMate scopes to the editor and derives the window's
own chrome colors from the theme, raising contrast where the original theme would otherwise leave a surface
unreadable. Imported themes are saved under your data folder's `themes/` folder and appear immediately in the
Themes menu, the command palette and the Appearance picker.

## Other appearance settings

Settings → Appearance also covers:

- **Font** — six bundled coding fonts (JetBrains Mono, Fira Code, DejaVu Sans Mono, Hack, Ubuntu Mono, Source
  Code Pro), then your installed system fonts — plus **Font Size** and **Font Ligatures**.
- **UI Scale** — the same value <kbd>⌘=</kbd>/<kbd>⌘−</kbd>/<kbd>⌘0</kbd> change.
- Panel visibility: Tab Bar for a single tab, Activity Bar, Status Bar, Side Bar, and split **Layout**
  (horizontal or vertical).
- Output **Highlighting** and **Show Line Numbers** — see [the output panel](output-panel.md).

## Language

Settings → General → Language changes the UI's own display language. JSLab ships English, Spanish, Japanese,
Chinese and Portuguese, though only English is fully translated today — see [Translating
JSLab](translating.md). JSLab needs to restart to apply a language change, and tells you so.
