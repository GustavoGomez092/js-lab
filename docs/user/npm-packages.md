# npm packages and the working directory

## Installing packages

<kbd>⌘I</kbd>, Tools → NPM Packages…, or the activity bar opens the **NPM Packages** panel. Search the
registry as you type, or type `name@version` (exact versions and ranges both work) and press Return.
Scoped packages and `@types/*` packages install the same way; a scoped or `@types` result is hidden by default
and shown with **Show @types**.

The installed table lists each package's installed and latest version, with an update button per row and
**Update All** for everything at once. Installing a **major** version bump is flagged before it runs.

Packages install to a project shared across every tab — a package you install in one tab is available in every
other tab without restarting JSLab.

## Working directory

**Actions → Set Working Directory…** (or dropping a folder onto the window) gives a tab a working directory.
With one set:

- `<working directory>/node_modules` is searched **before** JSLab's own installed packages.
- `process.cwd()`, `__dirname` and `import.meta.dir` are that folder, and relative imports written as string
  literals resolve there too.
- A `.env` file in that folder is loaded automatically — see [Environment variables](environment-variables.md).
- The tab's title gets a "· dirname" suffix, and the status bar shows a working-directory chip.

**Actions → Clear Working Directory** removes it.

## Settings → NPM

- **Allow install scripts** (`npm.allowInstallScripts`) — off by default. `postinstall` and similar scripts are
  blocked unless this is on, or you choose **Allow Scripts and Retry** after a blocked install.
- **Auto-install `@types`** (`npm.autoInstallTypes`) — installs a matching `@types/*` package automatically
  when you add a package that has one.
- An `.npmrc` editor, with **Reset** and **Save** — JSLab always uses its own `.npmrc` here, never your
  `~/.npmrc`.

Native modules (Bun N-API addons) install like any other package, running their build scripts when install
scripts are allowed.

See [Bun vs Node](bun-vs-node.md) for how module resolution and installs differ from a plain Node/npm setup.
