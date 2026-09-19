# Environment variables

Tools → Environment Variables… (no default shortcut — open it from the Tools menu or the command palette)
opens a table of key/value pairs that every tab's run sees, in addition to whatever your login shell already
exports.

- Add a row, type a key and value, and **Save**. Keys must start with a letter or underscore and contain only
  letters, digits and underscores; a key can't repeat. Up to 500 variables are allowed.
- **Paste a whole `.env` file into the Key field** to add several variables at once — JSLab parses it and fills
  in the rows for you to review before saving.
- Values are masked by default; **Show**/**Hide** reveals one.
- Changes apply starting with the **next run** — a run already in progress keeps its old environment.

Variables are stored in `env.json` under your data folder, created with `0600` permissions (readable only by
your user account).

## Layering

For a Bun-runtime run, the environment is built in this order, later layers winning:

1. Your login shell's environment.
2. These Environment Variables.
3. The working directory's `.env` file, if one is set — see [npm packages and the working
   directory](npm-packages.md).
4. `JSLAB=1`, always set on every run so your code can detect it's running inside JSLab.

JSLab's own `JSLAB_*` variables and `BUN_OPTIONS` never reach a run, whichever layer they came from — JSLab
owns the Bun flags a run starts with. See [Bun vs Node](bun-vs-node.md) for the browser-runtime differences
(a `child_process` call there without an explicit `env` inherits JSLab's own environment rather than this
layered one).
