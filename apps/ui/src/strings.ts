/** Every user-visible UI string added from M2 on, kept in one place for M5 i18n extraction (spec §17). */
const NL = String.fromCharCode(10);

export const strings = {
  install: {
    /** Spec §6.3. */
    package: (name: string) => `Install package ${name}`,
    types: (name: string) => `Install ${name}`,
    /** R23-1: shown in the status bar right after npm.install dispatches. */
    started: (spec: string, keys: string | null) =>
      keys ? `Installing ${spec}… ${keys} shows progress.` : `Installing ${spec}…`,
  },
  completions: {
    /** The detail line on an installed-package import suggestion: the version in node_modules (spec §6.1). */
    packageDetail: (version: string | null) => (version === null ? "installed" : `v${version}`),
  },
  logpoints: {
    /** Spec §6.3: the glyph-margin dot's tooltip. */
    tooltip: "Logpoint — this line's value is shown in the output",
    /** Spec §5.5: "A logpoint on a line with no loggable statement is shown hollow, with a tooltip." */
    noValue: "Logpoint has no value to log on this line",
    // The two command titles that used to sit here moved to the command catalogue (`packages/shared/src/commands.ts`)
    // in M5a Task 5, where every other menu, palette and keybinding title lives; they were dead duplicates here.
  },
  transpiled: {
    title: "Transpiled Output",
    /** Spec §7.4: "a toggle hides the instrumentation calls". */
    hideInstrumentation: "Hide instrumentation",
    empty: "Run this tab to see its transpiled output.",
    failed: "Couldn't read the transpiled output.",
    /** R-M5a-7: shown while the editor's source differs from the source that produced the output on screen. */
    stale: "Stale — run to refresh",
  },
  commands: {
    failed: (title: string, error: unknown) =>
      `${title} failed: ${error instanceof Error ? error.message : String(error)}`,
    onOff: (on: boolean) => (on ? "currently on" : "currently off"),
    loopLimit: (limit: number) => `limit ${limit}`,
    current: "current",
    copyFailed: "Couldn't copy the output to the clipboard.",
    folder: (name: string) => `folder: ${name}`,
  },
  limits: {
    tooLarge: "This tab is larger than 64 MB. JSLab stops saving and running it until it's smaller.",
  },
  format: {
    failed: (message: string) => `Couldn't format: ${message}`,
    busy: "Formatting…",
    timedOut: "formatting took too long, so the formatter was restarted",
    restarted: "the formatter was restarted",
    crashed: "the formatter stopped unexpectedly",
    disposed: "the formatter was closed",
  },
  // Carried item T11-m4: a tab action (create/close/reopen/...) that Main rejects reports a status message
  // instead of leaving an unhandled rejection.
  tabs: {
    actionFailed: (error: unknown) =>
      `Couldn't complete that action: ${error instanceof Error ? error.message : String(error)}`,
    list: "Tabs",
    newTab: "New Tab",
    close: (title: string) => `Close ${title}`,
    unsaved: "Unsaved changes",
    rename: "Rename…",
    closeOne: "Close",
    closeOthers: "Close Others",
    closeToRight: "Close to the Right",
    reveal: "Reveal in Finder",
    copyPath: "Copy Path",
    renameTitle: "Rename Tab",
    renameLabel: "Tab name",
    renameHelp: "Leave empty to use the first line of code as the title.",
    cancel: "Cancel",
    save: "Rename",
    // Task 15 (spec §5.12, EX-35): the per-tab audio indicator's accessible name, carrying the tab title so a
    // screen reader user with several tabs open can tell which one it's about (the motivating scenario for this
    // whole task) -- and its current state (playing vs. muted), announced honestly, not just drawn.
    audio: {
      mute: (title: string) => `Mute ${title} (currently playing audio)`,
      unmute: (title: string) => `Unmute ${title} (currently muted)`,
    },
  },
  files: {
    saved: (name: string) => `Saved ${name}`,
    saveFailed: (error: string) => `Couldn't save: ${error}`,
    saveChanges: (name: string) => `Save changes to ${name}?`,
    saveChangesDetail: "Your changes will be lost if you don't save them.",
    dontSave: "Don't Save",
    cancel: "Cancel",
    save: "Save",
    closeTitle: (name: string) => `Close "${name}"?`,
    closeDetail: "Its contents are kept in Reopen Closed Tab.",
    close: "Close",
    largeTitle: "Open a large file?",
    large: (name: string, size: string) => `${name} is ${size}. Large files can make JSLab slow.`,
    open: "Open",
    pasteTitle: "Paste a large amount of text?",
    paste: (size: string) => `Pasting ${size} may make JSLab slow. Continue?`,
    pasteButton: "Paste",
    locationTitle: "Save to this location?",
    location: (path: string) => `Save as ${path}?`,
    notText: (name: string) => `${name} isn't a text file.`,
    /**
     * B1: ⌘S / Save As on a tab whose contents Main couldn't read. The UI refuses before asking Main, so the
     * empty placeholder can never be written over the user's real file. (Main refuses it again, independently.)
     */
    unreadableBuffer: "JSLab couldn't read this tab's contents, so it won't save over the file on disk.",
    tooLarge: (name: string) => `${name} is larger than 50 MB and can't be opened.`,
    // Branch B (R-M3-SPIKE-1 NO-GO): a dropped folder can't carry its path into the webview on Electrobun 2.0.1.
    folderDrop:
      "A dropped folder can't become the working directory here. Use Actions → Set Working Directory… or the status bar.",
  },
  fonts: {
    fallback: (font: string) => `Font "${font}" isn't available; using JetBrains Mono.`,
    // m-2 (fix round 1): the default font itself can fail its own check; don't claim to "fall back to
    // JetBrains Mono" from JetBrains Mono.
    bundledUnavailable: "The bundled code font couldn't load; using the system monospace font.",
  },
  /** Themes → Import VS Code Theme… (spec §9.3). */
  themes: {
    imported: (name: string) => `Imported ${name}.`,
    pickTitle: "Choose a theme",
    pickHelp: (count: number) => `That extension contains ${count} themes. Choose the one to import.`,
    cancel: "Cancel",
    // The caveats an import reports (low-contrast syntax, dropped semantic colours) are Main's own strings: Main
    // decides which of them apply and sends them as ready-to-show text on the result.
  },
  shell: {
    run: "Run",
    stop: "Stop",
    autoRun: "Auto Run",
    activity: "Activity",
    running: "Running",
    on: "on",
    off: "off",
    snippets: "Snippets",
    npm: "NPM Packages",
    aiChat: "AI Chat",
    settings: "Settings",
    laterMilestone: "Arrives in a later version",
    safeMode: "Safe Mode",
    sideBarPlaceholder: "This panel arrives in a later version.",
    split: { horizontal: "Side by side", vertical: "Stacked" },
    /**
     * Accessible names for the two draggable splitters (`SplitPane`'s `role="separator"`).
     *
     * Both are on screen together whenever a browser-runtime tab shows the Web View preview: the Editor/Output
     * splitter and the Output/Web View one. An unnamed focusable separator is announced only as its role and
     * value ("separator, 55"), which is identical for both, so a screen reader user cannot tell which one they
     * are on. MDN's separator_role is explicit that a focusable separator "should include `aria-label` if there
     * is more than one focusable separator".
     *
     * These name what the splitter RESIZES, not what it is -- the role is already announced, so a trailing
     * "divider" would only repeat it. They reuse the names those panes already carry elsewhere (`output.region`
     * "Output", `output.webViewTab` "Web View", `palette.context.editor` "Editor") so a splitter is described in
     * the same words as the things it moves.
     *
     * `aria-label` rather than `aria-labelledby`: the APG windowsplitter pattern prefers `aria-labelledby` only
     * when the primary pane has a *visible* label. Neither primary pane has one -- the Editor carries no label,
     * role or id at all, and the Output `<section>` is named by its own `aria-label` (not visible text) and has
     * no `id` to reference -- so the pattern's "otherwise ... `aria-label`" branch is the one that applies.
     *
     * These two MUST stay distinct from each other; `split-pane.test.tsx` pins that.
     */
    splitter: {
      editorOutput: "Editor and Output",
      outputWebView: "Output and Web View",
    },
    // M4 Task 8 (ruling R-M4-T8-DISABLED-1): mirrors the runtime <select>'s own disabled-option idiom -- native
    // `disabled` plus this string as the button's `title`, for the one runtime that never creates a webview.
    webView: {
      show: "Show Web View",
      hide: "Hide Web View",
      unavailable: "Web View isn't available for the Bun runtime",
    },
    cursor: (line: number, column: number) => `Ln ${line}, Col ${column}`,
    runtime: "Runtime",
    language: "Language",
    workingDirectory: {
      // R24-1: the ellipsis signals that this opens a picker and matches the menu title.
      set: "Set Working Directory…",
      setHelp: "Run this tab in a folder: relative imports, .env and node_modules resolve there.",
      change: (path: string) => `Working directory: ${path}. Change…`,
      // R24-2: the chip keeps naming the problem and its fix after the output that reported it scrolls away.
      missing: (path: string) => `Working directory not found: ${path}. Change…`,
      clear: "Clear Working Directory",
    },
    /** A button's tooltip with its shortcut, when it has one (FB-m3). */
    withKeys: (label: string, keys: string | null) => (keys ? `${label} (${keys})` : label),
    dismiss: (message: string) => `Dismiss: ${message}`,
    unresponsive: {
      title: "This tab isn't responding",
      body: "Your code has been busy for a few seconds without responding. You can kill it, or keep waiting.",
      wait: "Wait",
      kill: "Kill",
    },
    /**
     * B1: shown above the editor whenever the ACTIVE tab is one of these, for as long as it is. The startup
     * notice alone was not enough -- it is dismissible and names a count, while this says which tab the user is
     * looking at right now is not showing its file. Without it an empty editor is indistinguishable from a
     * genuinely empty file, which is the trap that made saving look reasonable.
     */
    unreadableBuffer:
      "JSLab couldn't read this tab's contents. It's shown empty and read-only, so the file on disk isn't overwritten.",
    safeModeBanner: {
      crashLoop: "JSLab didn't shut down cleanly while running code. Auto Run is paused for this session.",
      manual: "Safe Mode: restarted from Help → Restart in Safe Mode. Auto Run is paused for this session.",
      shift: "Safe Mode: Shift was held at launch. Auto Run is paused for this session.",
    },
    runState: {
      /** The Run chord follows the effective bindings; omits the keycap when the binding was removed. */
      safeModePaused: (keys: string | null) => (keys ? `Safe Mode: press ${keys} to run` : "Safe Mode: paused"),
      paused: (keys: string | null) => (keys ? `Paused: press ${keys} to run` : "Paused"),
      running: "Running…",
      settled: (handles: number) => `Running: ${handles} active ${handles === 1 ? "handle" : "handles"}`,
      stopping: "Stopping…",
      stopped: "Stopped",
      killed: "Run killed",
      failed: "Failed",
      unresponsive: "Not responding",
    },
  },
  notices: {
    copyDebugLog: "Copy Debug Log",
    /** UI item 7: one control to clear a stack, shown only once more than two are up at the same time. */
    dismissAll: "Dismiss all",
  },
  startup: {
    failed: (message: string) => `JSLab failed to start: ${message}`,
    retry: "Try Again",
    /**
     * F1: Try Again re-runs the identical bootstrap, so on its own it is an infinite loop for any failure that
     * isn't transient. These give the user somewhere else to go -- the tab files themselves, and a report.
     */
    stuck: "If Try Again keeps failing, one of your tab files may be unreadable.",
    openDataFolder: "Open Data Folder",
    copyDebugLog: "Copy Debug Log",
  },
  palette: {
    label: "Command palette",
    categories: {
      run: "Run",
      file: "File",
      tab: "Tabs",
      edit: "Edit",
      format: "Format",
      view: "View",
      tools: "Tools",
      runtime: "Runtime",
      language: "Language",
      theme: "Theme",
      help: "Help",
      app: "JSLab",
    },
    placeholder: "Type a command",
    context: { editor: "Editor", output: "Output" },
    themeItem: (name: string) => `Theme: ${name}`,
    empty: "No matching commands",
    /** R-M4-PALETTE-HIDE-1: marks a listed-but-disabled command, so it reads as "exists, not right now" rather
     * than as the typo that `empty` above describes. `CommandSpec.isEnabled` returns a bare boolean and carries
     * no reason, so this is deliberately generic -- the per-command "why" would need an API that does not exist. */
    unavailable: "Unavailable now",
    footer: {
      keys: { run: "↵", move: "↑↓", close: "esc" },
      run: "run",
      move: "move",
      close: "close",
    },
  },
  output: {
    filters: { all: "All", results: "Results", logs: "Logs", errors: "Errors" },
    filterLabel: "Output filter",
    /** R-WEBVIEW-TAB-1: the control beside the filter chips that fills the output panel with the Web View. */
    webViewTab: "Web View",
    copyAll: "Copy All",
    clear: "Clear",
    jumpToLine: (line: number) => `Go to line ${line}`,
    truncated: (dropped: number) =>
      `Output truncated: ${dropped} more entries were dropped. Raise the limit in Settings → Advanced.`,
    /**
     * OU-02: the exact number of collection entries beyond the pages already loaded, never an unqualified
     * ellipsis. Distinct from `truncated` above, which is about *console entries* dropped by the output cap.
     */
    moreEntries: (remaining: number) => `… ${remaining.toLocaleString("en-US")} more entries`,
    region: "Output",
    /**
     * The output panel's polite live region (`OutputPanel`'s `<output className="visually-hidden">`).
     *
     * Deliberately a per-run SUMMARY, not a per-row announcement: a tight loop can log thousands of rows, and
     * reading each one aloud would make the app unusable with a screen reader rather than accessible.
     *
     * Phrased as labelled counts rather than "3 entries, 1 error" on purpose. It needs no plural rules, which keeps
     * it honest in locales that have none (m5e's `t()` sweep) and keeps the line inside the 120-column budget.
     */
    announce: {
      runFinished: (entries: number, errors: number) => `Run finished. Entries: ${entries}. Errors: ${errors}.`,
    },
    lastSuccessfulRun: "Last successful run",
    copied: "Copied",
    copyFailed: "Couldn't copy",
    noMatches: "No entries match this filter",
    showAll: "Show all",
    noOutput: (keys: string | null) => (keys ? `No output yet — press ${keys}` : "No output yet"),
    tableIndex: "(index)",
    uncaughtInPromise: "Uncaught (in promise) ",
    internalFrames: (count: number) => `${count} internal frames`,
    /** A clickable stack-frame line (RR2-m5). */
    frame: (fn: string, line: number, column: number) => `at ${fn} (L${line}:${column})`,
    anonymous: "<anonymous>",
    /** Spec §6.3: a runtime module-not-found error offers to install the missing package. */
    installPackage: (name: string) => `Install ${name}`,
    /** Spec §12.2: a WorkingDirectoryError row offers to change the working directory. */
    changeWorkingDirectory: "Change…",
    /** R24-4: a relative module-not-found row offers to set a working directory when the tab has none. */
    setWorkingDirectory: "Set Working Directory…",
  },
  webDialog: {
    /** Task 13 (spec §5.12): JSLab's own non-blocking stand-in for `alert()`. */
    region: "Page message",
    dismiss: "Dismiss",
    queued: (count: number) => `${count} more waiting`,
  },
  env: {
    title: "Environment Variables",
    help: "Every tab uses these variables. Paste a .env file into Key to add several at once. Changes apply from the next run.",
    key: "Key",
    value: "Value",
    keyOf: (row: number) => `Key, row ${row}`,
    valueOf: (key: string) => `Value of ${key}`,
    reveal: (key: string) => `Show value of ${key}`,
    hide: (key: string) => `Hide value of ${key}`,
    remove: (key: string) => `Remove ${key}`,
    // Fix round 1 (M-6): New value is masked by default, with its own toggle (no key to name yet).
    revealNew: "Show new value",
    hideNew: "Hide new value",
    newKey: "New key",
    newValue: "New value",
    add: "Add",
    save: "Save",
    cancel: "Cancel",
    // R25-6: the reveal button's visible word, with the keycap glyphs kept out of the accessible name.
    showButton: "Show",
    hideButton: "Hide",
    empty: "No variables yet. Type a key below, or paste a .env file.",
    // R25-2: a failed load disables Save, so a transient read failure can't wipe every saved variable.
    loadFailed:
      "Couldn't read your saved variables, so Save is off to protect them. Close this sheet and open it again.",
    saveFailed: (error: string) => `Couldn't save env.json (${error}). Your changes are still here.`,
    // R25-5: states the "next run" effect, since env changes have no other visible effect.
    saved: (count: number) =>
      count === 0
        ? "Removed all environment variables. The next run starts without them."
        : `Saved ${count} environment variable${count === 1 ? "" : "s"}. The next run uses them.`,
    // R25-3: shown after a .env block is pasted into New key.
    pasted: (count: number) =>
      `Added ${count} variable${count === 1 ? "" : "s"} from the paste. Check them, then Save.`,
    // R-M3-T25-SAVE-1: the client-side limit checks that mirror @jslab/shared's envVarsSchema.
    tooMany: (max: number) => `At most ${max} environment variables. Remove some before saving.`,
    valueTooLong: (key: string, max: number) => `${key}'s value is longer than ${max} characters.`,
    errors: {
      invalidKey: "Use letters, digits and _, and don't start with a digit.",
      duplicateKey: "Another row already uses this key.",
    },
  },
  snippets: {
    title: "Snippets",
    searchLabel: "Search snippets",
    searchPlaceholder: "Search by name or description",
    list: "Snippet library",
    newSnippet: "New Snippet",
    // Spec §13.1: the editor context menu's own entry. It deliberately reads the same as the `snippets.create`
    // command title -- the command catalogue and the UI strings are separate surfaces (note for M5e Phase B).
    createAction: "Create Snippet…",
    // Spec §13.1 actions.
    insert: "Insert",
    insertInNewTab: "Insert in New Tab",
    copy: "Copy",
    edit: "Edit",
    delete: "Delete",
    deleteButton: "Delete",
    cancel: "Cancel",
    // Spec §13.1: the confirmation is worded exactly like this.
    deleteTitle: (name: string) => `Delete snippet "${name}"?`,
    deleteMessage: "You can undo this until you make another change.",
    deleted: (name: string) => `Deleted "${name}".`,
    undo: "Undo",
    copied: "Copied",
    copyFailed: "Couldn't copy",
    preview: "Snippet preview",
    // Empty states: 0 in the library, and 0 matching the query, say different things (M5 UI research §1).
    empty: "No snippets yet. Create one, or import a library.",
    noMatches: (query: string) => `No snippets match "${query}".`,
    createNamed: (query: string) => `Create "${query}"`,
    import: "Import…",
    export: "Export…",
    importFailed: "This file isn't a valid JSLab snippets file",
    imported: (added: number, overwritten: number, skipped: number) =>
      `Imported ${added} snippet${added === 1 ? "" : "s"}, replaced ${overwritten}, skipped ${skipped}.`,
    conflicts: (conflicts: number, total: number) =>
      `${total} snippet${total === 1 ? "" : "s"} to import, ${conflicts} with a name you already use.`,
    overwrite: "Overwrite",
    keepBoth: "Keep Both",
    skip: "Skip",
    exportedTo: (path: string) => `Exported to ${path}`,
    exportCancelled: "Export cancelled.",
    exportFailed: (error: string) => `Couldn't export: ${error}`,
    loadFailed: "Couldn't read your snippets. Close and reopen the panel to try again.",
    saveFailed: (error: string) => `Couldn't save your snippets (${error}). Nothing was changed.`,
    // The New Snippet form (spec §13.1).
    newTitle: "New Snippet",
    editTitle: "Edit Snippet",
    nameLabel: "Name",
    nameHelp: "The word you type to insert this snippet. Letters, digits, _, $ and - only.",
    descriptionLabel: "Description",
    languageLabel: "Language hint",
    languageNone: "Any",
    bodyLabel: "Body",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal snippet syntax quoted to the user, not a template
    bodyHelp: "$0 is where the cursor lands; ${1:name} and $1 are tab stops.",
    save: "Save",
    nameRequired: "A snippet needs a name.",
    nameInvalid: "Use letters, digits, _, $ and - only.",
    nameTaken: "Another snippet already uses this name.",
  },
  npm: {
    title: "NPM Packages",
    // The sheet's own exit control, in the header. Deliberately distinct from `remove` below: that one is the
    // destructive row action, and the two must never read as the same control.
    close: "Close",
    searchLabel: "Search npm packages",
    searchPlaceholder: "Search npm, or type name@version",
    weekly: (count: number) => `${count.toLocaleString("en-US")} weekly downloads`,
    add: (name: string) => `Add ${name}`,
    addButton: "Add",
    // R26-3: a result with a pending install shows this instead of Add.
    adding: "Adding…",
    // R26-2: a result already in the installed table shows this instead of Add.
    installedVersion: (version: string) => `Installed ${version}`,
    name: "Name",
    version: "Installed",
    latest: "Latest",
    // Shown in a Latest cell once an outdated check has succeeded and found nothing newer, so the cell reports a
    // real state instead of rendering blank.
    upToDate: "Up to date",
    // Shown in a Latest cell when no outdated check has succeeded yet, so "is there a newer one" is simply unknown.
    latestUnknown: "—",
    update: (name: string) => `Update ${name}`,
    updateButton: "Update",
    remove: (name: string) => `Remove ${name}`,
    // The row's destructive action carries a word, not a glyph: an unlabelled × under a blank column header was
    // being mistaken for the sheet's (previously missing) close control.
    removeButton: "Remove",
    updateAll: "Update All",
    // R26-1: the toolbar's Update All tooltip, distinct from its (unchanged) accessible name.
    updateAllTitle: (count: number, majors: number) =>
      `Update ${count} package${count === 1 ? "" : "s"} to their latest versions${
        majors > 0 ? `, including ${majors} major update${majors === 1 ? "" : "s"}` : ""
      }.`,
    showTypes: "Show @types",
    allowScripts: "Allow install scripts",
    // R26-5: shown only once the first list has loaded, so a load-in-progress sheet never flashes "no packages".
    none: "No packages yet. Search above, or type name@version and press Return.",
    noResults: (query: string) => `No packages match "${query}".`,
    typesHidden: (count: number) => `${count} @types package${count === 1 ? "" : "s"} hidden.`,
    log: "Log",
    // R26-3 adds a `queued` count; do-not-change list R-M3: this is one of the two allowed signature changes.
    running: (kind: string, target: string, queued: number) => {
      const verb =
        kind === "remove" ? "Removing" : kind === "update" || kind === "updateAll" ? "Updating" : "Installing";
      const subject = kind === "updateAll" ? "all packages" : target;
      return `${verb} ${subject}…${queued > 0 ? ` ${queued} more queued.` : ""}`;
    },
    // R26-3: shown in the affected row's Latest cell while that row has a queued or running operation.
    rowStatus: (kind: string, status: string) => {
      if (status === "queued") return "Queued";
      return kind === "remove" ? "Removing…" : kind === "update" || kind === "updateAll" ? "Updating…" : "Installing…";
    },
    // R26-4 adds `kind`; do-not-change list R-M3: the second of the two allowed signature changes.
    failed: (kind: string, target: string) =>
      kind === "updateAll"
        ? "Couldn't update all packages."
        : `Couldn't ${kind === "remove" ? "remove" : kind === "update" ? "update" : "install"} ${target}.`,
    // R26-4: the failure-card action row.
    retry: "Retry",
    allowAndRetry: "Allow Scripts and Retry",
    copyLog: "Copy Log",
    dismiss: "Dismiss",
    scriptBlocked:
      "Installed without running install scripts. To run them, turn on Allow install scripts and install again.",
    // R26-1: the Major badge and its tooltip.
    major: "Major",
    majorTitle: (name: string, from: string | null, to: string | null) =>
      `${name} ${from ?? "?"} → ${to ?? "?"} is a major update and may include breaking changes.`,
    // R26-1: "Checked N min ago", above the installed table.
    checkedAgo: (minutes: number) => `Checked for updates ${minutes < 1 ? "just now" : `${minutes} min ago`}`,
    // R26-6: reported in the status bar when a finished operation's sheet isn't open to show it inline.
    done: (kind: string, target: string, keys: string | null) => {
      const verb = kind === "remove" ? "Removed" : kind === "update" || kind === "updateAll" ? "Updated" : "Installed";
      const subject = kind === "updateAll" ? "all packages" : target;
      return `${verb} ${subject}.${keys ? ` Press ${keys} to run again.` : ""}`;
    },
    doneFailed: (kind: string, target: string, hint: string) => `${strings.npm.failed(kind, target)} ${hint}`,
    outdatedFailed: (hint: string) => `Couldn't check for updates. ${hint}`,
    hints: {
      network: "Check your connection and the registry in Settings → NPM.",
      notFound: "The registry has no package with this name. Check the spelling.",
      noMatchingVersion: "No published version matches. Try name@latest.",
      peerConflict: "It needs a different version of a package you already have. The log names it.",
      scriptBlocked: "Install scripts were blocked. Turn on Allow install scripts.",
      nativeBuild: "A native module failed to build. See the log for the compiler error.",
      disk: "JSLab couldn't write the packages folder. Check disk space and permissions.",
      timeout: "Stopped after 5 minutes. Check your connection, then retry.",
      unknown: "Open the log below to see what Bun reported.",
    },
  },
  settings: {
    windowTitle: "Settings",
    search: "Search settings",
    results: "Search results",
    restartRequired: "Restart required",
    tabs: {
      general: "General",
      editor: "Editor",
      formatting: "Formatting",
      appearance: "Appearance",
      keybindings: "Keybindings",
      npm: "NPM",
      build: "Build",
      advanced: "Advanced",
    },
    keybindings: {
      title: "Keybindings",
      help: "Every JSLab command and the keys that run it.",
      search: "Search keybindings",
      columns: { command: "Command", keybinding: "Keybinding", when: "When", source: "Source" },
      source: { default: "Default", user: "User", none: "Not bound" },
      unregistered: "Not available in this window",
      conflict: (titles: string) => `Also bound to ${titles}`,
      openFile: "Open keybindings.json",
      empty: "No commands match this search",
      loadFailed: "Couldn't read the keybindings.",
      change: "Change",
      capture: (title: string) => `Change the shortcut for ${title}`,
      capturing: (title: string) => `Recording a shortcut for ${title}`,
      captureHint: "Press the keys you want, or Escape to cancel.",
      reset: "Reset",
      resetRow: (title: string) => `Reset ${title} to its default shortcut`,
      resetAll: "Reset All Keybindings",
      rejected: {
        bareKey: "Add a modifier (⌘, ⌃ or ⌥) to that key, or use a function key.",
        reserved: "That key is reserved and can't be used as a shortcut.",
      },
      saveFailed: "Couldn't save your keybindings.",
      // Spec §18: the path is never quoted here -- Main logs the raw cause instead.
      fileInvalid: "keybindings.json isn't valid JSON, so it can't be edited here. Open it, fix it, then relaunch.",
    },
    groups: {
      dark: "Dark",
      light: "Light",
      bundled: "Bundled",
      monospace: "Installed monospace",
      installed: "Installed",
    },
    loadingFonts: "Loading installed fonts…",
    fontsUnavailable: "Couldn't load installed fonts",
    openDataFolder: "Open Data Folder",
    resetAll: "Reset All Settings…",
    confirmReset: "Confirm Reset",
    restartSafeMode: "Restart in Safe Mode",
    loadFailed: (message: string) => `Settings failed to load: ${message}`,
    npmrc: {
      title: ".npmrc",
      help: "Registry and authentication for package installs. Your ~/.npmrc is never used.",
      privacyNote: "This file is readable only by you, and tokens never appear in JSLab's logs.",
      editorLabel: ".npmrc contents",
      save: "Save",
      reset: "Reset",
      saved: "Saved .npmrc",
      resetDone: "Restored the default registry",
      resetFailed: "Couldn't reset .npmrc.",
      /**
       * A failed load leaves `saved` null, which disables Save *and* Reset -- a `.npmrc` that is present but
       * unreadable must never be written over sight unseen. So this message has to say that Reset is off because
       * of this, and what the remedy is, since JSLab cannot repair the file itself. The code is best-effort:
       * `saveFailed`'s arrives in the response payload, but a failed load arrives as a rejection.
       */
      loadFailed: (code: string | null) =>
        code === "EFBIG"
          ? "Couldn't read .npmrc: it's over the size limit. Save and Reset stay off until it can be read. Open the file and fix it by hand."
          : code
            ? `Couldn't read .npmrc (${code}). Save and Reset stay off until it can be read. Open the file and fix it by hand.`
            : "Couldn't read .npmrc. Save and Reset stay off until it can be read. Open the file and fix it by hand.",
      saveFailed: (code: string | null) =>
        code
          ? `Couldn't save .npmrc (${code}). Your changes are still here.`
          : "Couldn't save .npmrc. Your changes are still here.",
      examples: "Examples",
      exampleText: `@acme:registry=https://npm.acme.dev/${NL}//npm.acme.dev/:_authToken=<token>`,
      warnings: {
        missingEquals: (line: number) => `Line ${line}: missing "=".`,
        registryNotUrl: (line: number) => `Line ${line}: registry isn't a web address.`,
      },
    },
    fields: {
      "run.autoRun": { label: "Auto Run", help: "Run code automatically as you type." },
      "run.autoLog": { label: "Auto Log", help: "Show the value of each top-level expression." },
      "run.defaultRuntime": {
        label: "Default Runtime",
        help: "Runtime for new tabs.",
      },
      "run.defaultLanguage": { label: "Default Language", help: "Language for new tabs." },
      "run.formatOnRun": {
        label: "Format on Run",
        help: "Format code with Prettier before each run, unless you are typing.",
      },
      "tabs.confirmClose": { label: "Confirm Close", help: "Ask before closing any tab." },
      "app.uiLanguage": {
        label: "Language",
        help: "Language of menus and panels. More languages arrive in a later version.",
      },
      "editor.lineNumbers": { label: "Line Numbers", help: "Show line numbers in the gutter." },
      "editor.lineWrap": { label: "Line Wrap", help: "Wrap long lines to the editor width." },
      "editor.vimKeys": { label: "Vim Keys", help: "Edit with Vim key bindings. ⌘R still runs in every mode." },
      "editor.closeBrackets": {
        label: "Close Brackets",
        help: "Insert the closing bracket or quote when you type the opening one.",
      },
      "editor.invisibles": { label: "Invisibles", help: "Render spaces and tabs." },
      "editor.activeLine": { label: "Active Line", help: "Highlight the line with the cursor." },
      "editor.autocomplete": { label: "Autocomplete", help: "Suggest completions while you type." },
      "editor.linting": { label: "Linting", help: "Show TypeScript diagnostics inline. Never blocks running code." },
      "editor.hoverInfo": { label: "Hover Info", help: "Show type information when hovering over code." },
      "editor.hoverDelayMs": {
        label: "Hover Delay",
        help: "Milliseconds before hover information appears (100–2000).",
      },
      "editor.signatures": { label: "Signatures", help: "Show parameter hints while typing a call." },
      "editor.formatOnSave": { label: "Format on Save", help: "Format code with Prettier before saving a file." },
      "editor.minimap": { label: "Minimap", help: "Show a code overview next to the scroll bar." },
      "prettier.printWidth": { label: "Print Width", help: "Line length Prettier wraps at." },
      "prettier.tabWidth": { label: "Tab Width", help: "Spaces per indentation level." },
      "prettier.useTabs": { label: "Use Tabs", help: "Indent with tabs instead of spaces." },
      "prettier.semi": { label: "Semicolons", help: "Add a semicolon at the end of every statement." },
      "prettier.singleQuote": { label: "Single Quotes", help: "Use single quotes instead of double quotes." },
      "prettier.quoteProps": { label: "Quote Props", help: "When to quote object property names." },
      "prettier.jsxSingleQuote": { label: "JSX Single Quotes", help: "Use single quotes in JSX attributes." },
      "prettier.trailingComma": { label: "Trailing Commas", help: "Where to add trailing commas." },
      "prettier.bracketSpacing": { label: "Bracket Spacing", help: "Put spaces between brackets in object literals." },
      "prettier.bracketSameLine": {
        label: "Bracket Same Line",
        help: "Put the > of a multi-line JSX element at the end of the last line.",
      },
      "prettier.arrowParens": {
        label: "Arrow Parens",
        help: "Include parentheses around a sole arrow function parameter.",
      },
      "appearance.theme": { label: "Theme", help: "Color theme for the editor and the window." },
      "appearance.followSystem": {
        label: "Follow System Appearance",
        help: "Switch between the light and dark themes below with macOS.",
      },
      "appearance.lightTheme": { label: "Light Theme", help: "Theme used in light mode when following the system." },
      "appearance.darkTheme": { label: "Dark Theme", help: "Theme used in dark mode when following the system." },
      "appearance.font": {
        label: "Font",
        help: "Font for the editor and output. Bundled fonts are listed first, then installed fonts.",
      },
      "appearance.fontSize": { label: "Font Size", help: "Font size for the editor and output (8–72)." },
      "appearance.fontLigatures": {
        label: "Font Ligatures",
        help: "Combine character pairs like => into ligatures when the font supports them.",
      },
      "appearance.uiScale": {
        label: "Zoom",
        help: "Scales the editor, output and side bar. Also changed by ⌘= and ⌘−.",
      },
      "view.tabBarForSingleTab": { label: "Tab Bar", help: "Show the tab bar even when only one tab is open." },
      "view.activityBar": { label: "Activity Bar", help: "Show the activity bar on the left." },
      "view.statusBar": { label: "Status Bar", help: "Show the status bar at the bottom." },
      "view.sideBar": { label: "Side Bar", help: "Show the side bar." },
      "view.layout": { label: "Layout", help: "Split direction for new tabs." },
      "output.highlighting": { label: "Output Highlighting", help: "Color values in the output by type." },
      "output.showLineNumbers": {
        label: "Output Line Numbers",
        help: "Show the source line next to each output entry.",
      },
      "run.showUndefined": { label: "Show Undefined", help: "Show expressions whose value is undefined." },
      "run.loopProtection": {
        label: "Loop Protection",
        help: "Stop loops that run more iterations than the limit below.",
      },
      "run.loopProtectionMaxIterations": {
        label: "Loop Limit",
        help: "Iterations before loop protection stops a loop (100–10,000,000).",
      },
      "run.autoRunDelayMs": {
        label: "Auto Run Delay",
        help: "Milliseconds after you stop typing before code runs (0–5000).",
      },
      "run.unresponsiveTimeoutMs": {
        label: "Unresponsive Timeout",
        help: "Milliseconds without a heartbeat before JSLab offers to kill a run (1000–60000).",
      },
      "output.maxEntries": {
        label: "Output Limit",
        help: "Most entries kept per run before output is truncated (100–100,000).",
      },
      "updates.auto": { label: "Automatic Updates", help: "Download and install updates automatically." },
      "updates.channel": {
        label: "Update Channel",
        help: "Stable releases, or canary builds with the newest changes.",
      },
      "npm.allowInstallScripts": {
        label: "Allow Install Scripts",
        help: "Run packages' install scripts. Each package is added to trustedDependencies; scripts run with your permissions. Applies to future installs. Packages you already trusted keep running their install scripts.",
      },
      "npm.autoInstallTypes": {
        label: "Install Types Automatically",
        help: "Install @types/<package> automatically when an installed package has no types of its own.",
      },
      "build.decorators": {
        label: "Decorators",
        help: "Decorator syntax: 2023-11 (the standard), Legacy (TypeScript experimentalDecorators) or None.",
      },
      "build.pipelineOperator": { label: "Pipeline Operator", help: "Hack-style |> with % as the topic token." },
      "build.doExpressions": { label: "Do Expressions", help: "do { … } blocks that produce a value." },
      "build.throwExpressions": {
        label: "Throw Expressions",
        help: "throw as an expression, for example value ?? throw new Error().",
      },
      "build.functionSent": { label: "function.sent", help: "The value last passed to a generator's next()." },
      "build.regexpModifiers": {
        label: "RegExp Modifiers",
        help: "Inline flags such as (?i:a) in regular expressions.",
      },
      "build.optionalChainingAssign": {
        label: "Optional Chaining Assignment",
        help: "a?.b = c assigns only when a is not null or undefined.",
      },
    } as Record<string, { label: string; help: string }>,
    options: {
      runtime: { "browser-node": "Browser & Node APIs", bun: "Bun", browser: "Browser" },
      language: { typescript: "TypeScript", javascript: "JavaScript", tsx: "TSX", jsx: "JSX" },
      uiLanguage: { system: "System", en: "English", es: "Español", ja: "日本語", zh: "中文", pt: "Português" },
      quoteProps: { "as-needed": "As needed", consistent: "Consistent", preserve: "Preserve" },
      trailingComma: { all: "All", es5: "ES5", none: "None" },
      arrowParens: { always: "Always", avoid: "Avoid" },
      layout: { horizontal: "Horizontal", vertical: "Vertical" },
      channel: { stable: "Stable", canary: "Canary" },
      decorators: { none: "None", "2023-11": "2023-11 (standard)", legacy: "Legacy (experimentalDecorators)" },
    },
  },
} as const;
