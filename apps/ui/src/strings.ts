import { t } from "./i18n";

/** Every user-visible UI string, resolved through i18next (spec §17). Keys are this object's own paths. */
export const strings = {
  install: {
    /** Spec §6.3. */
    package: (name: string) => t("install.package", { name }),
    types: (name: string) => t("install.types", { name }),
    /** R23-1: shown in the status bar right after npm.install dispatches. */
    started: (spec: string, keys: string | null) =>
      keys ? t("install.startedWithKeys", { spec, keys }) : t("install.started", { spec }),
  },
  completions: {
    /** The detail line on an installed-package import suggestion: the version in node_modules (spec §6.1). */
    packageDetail: (version: string | null) =>
      version === null ? t("completions.packageDetailNone") : t("completions.packageDetail", { version }),
  },
  logpoints: {
    /** Spec §6.3: the glyph-margin dot's tooltip. */
    tooltip: t("logpoints.tooltip"),
    /** Spec §5.5: "A logpoint on a line with no loggable statement is shown hollow, with a tooltip." */
    noValue: t("logpoints.noValue"),
    // The two command titles that used to sit here moved to the command catalogue (`packages/shared/src/commands.ts`)
    // in M5a Task 5, where every other menu, palette and keybinding title lives; they were dead duplicates here.
  },
  transpiled: {
    title: t("transpiled.title"),
    /** Spec §7.4: "a toggle hides the instrumentation calls". */
    hideInstrumentation: t("transpiled.hideInstrumentation"),
    empty: t("transpiled.empty"),
    failed: t("transpiled.failed"),
    /** R-M5a-7: shown while the editor's source differs from the source that produced the output on screen. */
    stale: t("transpiled.stale"),
  },
  commands: {
    failed: (title: string, error: unknown) =>
      t("commands.failed", { title, error: error instanceof Error ? error.message : String(error) }),
    onOff: (on: boolean) => (on ? t("commands.on") : t("commands.off")),
    loopLimit: (limit: number) => t("commands.loopLimit", { limit }),
    current: t("commands.current"),
    copyFailed: t("commands.copyFailed"),
    folder: (name: string) => t("commands.folder", { name }),
  },
  limits: {
    tooLarge: t("limits.tooLarge"),
  },
  format: {
    failed: (message: string) => t("format.failed", { message }),
    busy: t("format.busy"),
    timedOut: t("format.timedOut"),
    restarted: t("format.restarted"),
    crashed: t("format.crashed"),
    disposed: t("format.disposed"),
  },
  // Carried item T11-m4: a tab action (create/close/reopen/...) that Main rejects reports a status message
  // instead of leaving an unhandled rejection.
  tabs: {
    actionFailed: (error: unknown) =>
      t("tabs.actionFailed", { error: error instanceof Error ? error.message : String(error) }),
    list: t("tabs.list"),
    newTab: t("tabs.newTab"),
    close: (title: string) => t("tabs.close", { title }),
    unsaved: t("tabs.unsaved"),
    rename: t("tabs.rename"),
    closeOne: t("tabs.closeOne"),
    closeOthers: t("tabs.closeOthers"),
    closeToRight: t("tabs.closeToRight"),
    reveal: t("tabs.reveal"),
    copyPath: t("tabs.copyPath"),
    renameTitle: t("tabs.renameTitle"),
    renameLabel: t("tabs.renameLabel"),
    renameHelp: t("tabs.renameHelp"),
    cancel: t("tabs.cancel"),
    save: t("tabs.save"),
    // Task 15 (spec §5.12, EX-35): the per-tab audio indicator's accessible name, carrying the tab title so a
    // screen reader user with several tabs open can tell which one it's about (the motivating scenario for this
    // whole task) -- and its current state (playing vs. muted), announced honestly, not just drawn.
    audio: {
      mute: (title: string) => t("tabs.audio.mute", { title }),
      unmute: (title: string) => t("tabs.audio.unmute", { title }),
    },
  },
  files: {
    saved: (name: string) => t("files.saved", { name }),
    saveFailed: (error: string) => t("files.saveFailed", { error }),
    saveChanges: (name: string) => t("files.saveChanges", { name }),
    saveChangesDetail: t("files.saveChangesDetail"),
    dontSave: t("files.dontSave"),
    cancel: t("files.cancel"),
    save: t("files.save"),
    closeTitle: (name: string) => t("files.closeTitle", { name }),
    closeDetail: t("files.closeDetail"),
    close: t("files.close"),
    largeTitle: t("files.largeTitle"),
    large: (name: string, size: string) => t("files.large", { name, size }),
    open: t("files.open"),
    pasteTitle: t("files.pasteTitle"),
    paste: (size: string) => t("files.paste", { size }),
    pasteButton: t("files.pasteButton"),
    locationTitle: t("files.locationTitle"),
    location: (path: string) => t("files.location", { path }),
    notText: (name: string) => t("files.notText", { name }),
    /**
     * B1: ⌘S / Save As on a tab whose contents Main couldn't read. The UI refuses before asking Main, so the
     * empty placeholder can never be written over the user's real file. (Main refuses it again, independently.)
     */
    unreadableBuffer: t("files.unreadableBuffer"),
    tooLarge: (name: string) => t("files.tooLarge", { name }),
    // Branch B (R-M3-SPIKE-1 NO-GO): a dropped folder can't carry its path into the webview on Electrobun 2.0.1.
    folderDrop: t("files.folderDrop"),
  },
  fonts: {
    fallback: (font: string) => t("fonts.fallback", { font }),
    // m-2 (fix round 1): the default font itself can fail its own check; don't claim to "fall back to
    // JetBrains Mono" from JetBrains Mono.
    bundledUnavailable: t("fonts.bundledUnavailable"),
  },
  /** Themes → Import VS Code Theme… (spec §9.3). */
  themes: {
    imported: (name: string) => t("themes.imported", { name }),
    pickTitle: t("themes.pickTitle"),
    pickHelp: (count: number) => t("themes.pickHelp", { count }),
    cancel: t("themes.cancel"),
    // The caveats an import reports (low-contrast syntax, dropped semantic colours) are Main's own strings: Main
    // decides which of them apply and sends them as ready-to-show text on the result.
  },
  shell: {
    run: t("shell.run"),
    stop: t("shell.stop"),
    autoRun: t("shell.autoRun"),
    activity: t("shell.activity"),
    running: t("shell.running"),
    on: t("shell.on"),
    off: t("shell.off"),
    snippets: t("shell.snippets"),
    npm: t("shell.npm"),
    aiChat: t("shell.aiChat"),
    settings: t("shell.settings"),
    laterMilestone: t("shell.laterMilestone"),
    safeMode: t("shell.safeMode"),
    sideBarPlaceholder: t("shell.sideBarPlaceholder"),
    split: { horizontal: t("shell.split.horizontal"), vertical: t("shell.split.vertical") },
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
      editorOutput: t("shell.splitter.editorOutput"),
      outputWebView: t("shell.splitter.outputWebView"),
    },
    // M4 Task 8 (ruling R-M4-T8-DISABLED-1): mirrors the runtime <select>'s own disabled-option idiom -- native
    // `disabled` plus this string as the button's `title`, for the one runtime that never creates a webview.
    webView: {
      show: t("shell.webView.show"),
      hide: t("shell.webView.hide"),
      unavailable: t("shell.webView.unavailable"),
    },
    cursor: (line: number, column: number) => t("shell.cursor", { line, column }),
    runtime: t("shell.runtime"),
    language: t("shell.language"),
    workingDirectory: {
      // R24-1: the ellipsis signals that this opens a picker and matches the menu title.
      set: t("shell.workingDirectory.set"),
      setHelp: t("shell.workingDirectory.setHelp"),
      change: (path: string) => t("shell.workingDirectory.change", { path }),
      // R24-2: the chip keeps naming the problem and its fix after the output that reported it scrolls away.
      missing: (path: string) => t("shell.workingDirectory.missing", { path }),
      clear: t("shell.workingDirectory.clear"),
    },
    /** A button's tooltip with its shortcut, when it has one (FB-m3). */
    withKeys: (label: string, keys: string | null) => (keys ? t("shell.withKeys", { label, keys }) : label),
    dismiss: (message: string) => t("shell.dismiss", { message }),
    unresponsive: {
      title: t("shell.unresponsive.title"),
      body: t("shell.unresponsive.body"),
      wait: t("shell.unresponsive.wait"),
      kill: t("shell.unresponsive.kill"),
    },
    /**
     * B1: shown above the editor whenever the ACTIVE tab is one of these, for as long as it is. The startup
     * notice alone was not enough -- it is dismissible and names a count, while this says which tab the user is
     * looking at right now is not showing its file. Without it an empty editor is indistinguishable from a
     * genuinely empty file, which is the trap that made saving look reasonable.
     */
    unreadableBuffer: t("shell.unreadableBuffer"),
    safeModeBanner: {
      crashLoop: t("shell.safeModeBanner.crashLoop"),
      manual: t("shell.safeModeBanner.manual"),
      shift: t("shell.safeModeBanner.shift"),
    },
    runState: {
      /** The Run chord follows the effective bindings; omits the keycap when the binding was removed. */
      safeModePaused: (keys: string | null) =>
        keys ? t("shell.runState.safeModePaused", { keys }) : t("shell.runState.safeModePausedNoKeys"),
      paused: (keys: string | null) => (keys ? t("shell.runState.paused", { keys }) : t("shell.runState.pausedNoKeys")),
      running: t("shell.runState.running"),
      // The parameter is renamed to `count`: i18next selects a plural form from a variable of that exact
      // name. It stays positional, so no call site changes.
      settled: (count: number) => t("shell.runState.settled", { count }),
      stopping: t("shell.runState.stopping"),
      stopped: t("shell.runState.stopped"),
      killed: t("shell.runState.killed"),
      failed: t("shell.runState.failed"),
      unresponsive: t("shell.runState.unresponsive"),
    },
  },
  notices: {
    copyDebugLog: t("notices.copyDebugLog"),
    /** UI item 7: one control to clear a stack, shown only once more than two are up at the same time. */
    dismissAll: t("notices.dismissAll"),
  },
  startup: {
    failed: (message: string) => t("startup.failed", { message }),
    retry: t("startup.retry"),
    /**
     * F1: Try Again re-runs the identical bootstrap, so on its own it is an infinite loop for any failure that
     * isn't transient. These give the user somewhere else to go -- the tab files themselves, and a report.
     */
    stuck: t("startup.stuck"),
    openDataFolder: t("startup.openDataFolder"),
    copyDebugLog: t("startup.copyDebugLog"),
  },
  palette: {
    label: t("palette.label"),
    categories: {
      run: t("palette.categories.run"),
      file: t("palette.categories.file"),
      tab: t("palette.categories.tab"),
      edit: t("palette.categories.edit"),
      format: t("palette.categories.format"),
      view: t("palette.categories.view"),
      tools: t("palette.categories.tools"),
      runtime: t("palette.categories.runtime"),
      language: t("palette.categories.language"),
      theme: t("palette.categories.theme"),
      help: t("palette.categories.help"),
      app: t("palette.categories.app"),
    },
    placeholder: t("palette.placeholder"),
    context: { editor: t("palette.context.editor"), output: t("palette.context.output") },
    themeItem: (name: string) => t("palette.themeItem", { name }),
    empty: t("palette.empty"),
    /** R-M4-PALETTE-HIDE-1: marks a listed-but-disabled command, so it reads as "exists, not right now" rather
     * than as the typo that `empty` above describes. `CommandSpec.isEnabled` returns a bare boolean and carries
     * no reason, so this is deliberately generic -- the per-command "why" would need an API that does not exist. */
    unavailable: t("palette.unavailable"),
    footer: {
      keys: {
        run: t("palette.footer.keys.run"),
        move: t("palette.footer.keys.move"),
        close: t("palette.footer.keys.close"),
      },
      run: t("palette.footer.run"),
      move: t("palette.footer.move"),
      close: t("palette.footer.close"),
    },
  },
  output: {
    filters: {
      all: t("output.filters.all"),
      results: t("output.filters.results"),
      logs: t("output.filters.logs"),
      errors: t("output.filters.errors"),
    },
    filterLabel: t("output.filterLabel"),
    /** R-WEBVIEW-TAB-1: the control beside the filter chips that fills the output panel with the Web View. */
    webViewTab: t("output.webViewTab"),
    copyAll: t("output.copyAll"),
    clear: t("output.clear"),
    jumpToLine: (line: number) => t("output.jumpToLine", { line }),
    truncated: (dropped: number) => t("output.truncated", { dropped }),
    /**
     * OU-02: the exact number of collection entries beyond the pages already loaded, never an unqualified
     * ellipsis. Distinct from `truncated` above, which is about *console entries* dropped by the output cap.
     */
    // Formatted before interpolation: i18next renders a bare number as "1234", losing the separator.
    moreEntries: (remaining: number) => t("output.moreEntries", { remaining: remaining.toLocaleString("en-US") }),
    region: t("output.region"),
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
      runFinished: (entries: number, errors: number) => t("output.announce.runFinished", { entries, errors }),
    },
    lastSuccessfulRun: t("output.lastSuccessfulRun"),
    copied: t("output.copied"),
    copyFailed: t("output.copyFailed"),
    noMatches: t("output.noMatches"),
    showAll: t("output.showAll"),
    noOutput: (keys: string | null) => (keys ? t("output.noOutput", { keys }) : t("output.noOutputNoKeys")),
    tableIndex: t("output.tableIndex"),
    uncaughtInPromise: t("output.uncaughtInPromise"),
    internalFrames: (count: number) => t("output.internalFrames", { count }),
    /** A clickable stack-frame line (RR2-m5). */
    frame: (fn: string, line: number, column: number) => t("output.frame", { fn, line, column }),
    anonymous: t("output.anonymous"),
    /** Spec §6.3: a runtime module-not-found error offers to install the missing package. */
    installPackage: (name: string) => t("output.installPackage", { name }),
    /** Spec §12.2: a WorkingDirectoryError row offers to change the working directory. */
    changeWorkingDirectory: t("output.changeWorkingDirectory"),
    /** R24-4: a relative module-not-found row offers to set a working directory when the tab has none. */
    setWorkingDirectory: t("output.setWorkingDirectory"),
  },
  webDialog: {
    /** Task 13 (spec §5.12): JSLab's own non-blocking stand-in for `alert()`. */
    region: t("webDialog.region"),
    dismiss: t("webDialog.dismiss"),
    queued: (count: number) => t("webDialog.queued", { count }),
  },
  env: {
    title: t("env.title"),
    help: t("env.help"),
    key: t("env.key"),
    value: t("env.value"),
    keyOf: (row: number) => t("env.keyOf", { row }),
    valueOf: (key: string) => t("env.valueOf", { key }),
    reveal: (key: string) => t("env.reveal", { key }),
    hide: (key: string) => t("env.hide", { key }),
    remove: (key: string) => t("env.remove", { key }),
    // Fix round 1 (M-6): New value is masked by default, with its own toggle (no key to name yet).
    revealNew: t("env.revealNew"),
    hideNew: t("env.hideNew"),
    newKey: t("env.newKey"),
    newValue: t("env.newValue"),
    add: t("env.add"),
    save: t("env.save"),
    cancel: t("env.cancel"),
    // R25-6: the reveal button's visible word, with the keycap glyphs kept out of the accessible name.
    showButton: t("env.showButton"),
    hideButton: t("env.hideButton"),
    empty: t("env.empty"),
    // R25-2: a failed load disables Save, so a transient read failure can't wipe every saved variable.
    loadFailed: t("env.loadFailed"),
    saveFailed: (error: string) => t("env.saveFailed", { error }),
    // R25-5: states the "next run" effect, since env changes have no other visible effect. Zero is not a
    // plural of the other two -- removing everything says something different -- so it keeps its own key.
    saved: (count: number) => (count === 0 ? t("env.savedNone") : t("env.saved", { count })),
    // R25-3: shown after a .env block is pasted into New key.
    pasted: (count: number) => t("env.pasted", { count }),
    // R-M3-T25-SAVE-1: the client-side limit checks that mirror @jslab/shared's envVarsSchema.
    tooMany: (max: number) => t("env.tooMany", { max }),
    valueTooLong: (key: string, max: number) => t("env.valueTooLong", { key, max }),
    errors: {
      invalidKey: t("env.errors.invalidKey"),
      duplicateKey: t("env.errors.duplicateKey"),
    },
  },
  snippets: {
    title: t("snippets.title"),
    searchLabel: t("snippets.searchLabel"),
    searchPlaceholder: t("snippets.searchPlaceholder"),
    list: t("snippets.list"),
    newSnippet: t("snippets.newSnippet"),
    // Spec §13.1: the editor context menu's own entry. It deliberately reads the same as the `snippets.create`
    // command title -- the command catalogue and the UI strings are separate surfaces (note for M5e Phase B).
    createAction: t("snippets.createAction"),
    // Spec §13.1 actions.
    insert: t("snippets.insert"),
    insertInNewTab: t("snippets.insertInNewTab"),
    copy: t("snippets.copy"),
    edit: t("snippets.edit"),
    delete: t("snippets.delete"),
    deleteButton: t("snippets.deleteButton"),
    cancel: t("snippets.cancel"),
    // Spec §13.1: the confirmation is worded exactly like this.
    deleteTitle: (name: string) => t("snippets.deleteTitle", { name }),
    deleteMessage: t("snippets.deleteMessage"),
    deleted: (name: string) => t("snippets.deleted", { name }),
    undo: t("snippets.undo"),
    copied: t("snippets.copied"),
    copyFailed: t("snippets.copyFailed"),
    preview: t("snippets.preview"),
    // Empty states: 0 in the library, and 0 matching the query, say different things (M5 UI research §1).
    empty: t("snippets.empty"),
    noMatches: (query: string) => t("snippets.noMatches", { query }),
    createNamed: (query: string) => t("snippets.createNamed", { query }),
    import: t("snippets.import"),
    export: t("snippets.export"),
    importFailed: t("snippets.importFailed"),
    // Two more hand-rolled plurals than the plan's inventory lists. The pluralized number is passed as
    // `count` (i18next's form selector) while the other counts keep their own names.
    imported: (added: number, overwritten: number, skipped: number) =>
      t("snippets.imported", { count: added, overwritten, skipped }),
    conflicts: (conflicts: number, total: number) => t("snippets.conflicts", { count: total, conflicts }),
    overwrite: t("snippets.overwrite"),
    keepBoth: t("snippets.keepBoth"),
    skip: t("snippets.skip"),
    exportedTo: (path: string) => t("snippets.exportedTo", { path }),
    exportCancelled: t("snippets.exportCancelled"),
    exportFailed: (error: string) => t("snippets.exportFailed", { error }),
    loadFailed: t("snippets.loadFailed"),
    saveFailed: (error: string) => t("snippets.saveFailed", { error }),
    // The New Snippet form (spec §13.1).
    newTitle: t("snippets.newTitle"),
    editTitle: t("snippets.editTitle"),
    nameLabel: t("snippets.nameLabel"),
    nameHelp: t("snippets.nameHelp"),
    descriptionLabel: t("snippets.descriptionLabel"),
    languageLabel: t("snippets.languageLabel"),
    languageNone: t("snippets.languageNone"),
    bodyLabel: t("snippets.bodyLabel"),
    bodyHelp: t("snippets.bodyHelp"),
    save: t("snippets.save"),
    nameRequired: t("snippets.nameRequired"),
    nameInvalid: t("snippets.nameInvalid"),
    nameTaken: t("snippets.nameTaken"),
  },
  npm: {
    title: t("npm.title"),
    // The sheet's own exit control, in the header. Deliberately distinct from `remove` below: that one is the
    // destructive row action, and the two must never read as the same control.
    close: t("npm.close"),
    searchLabel: t("npm.searchLabel"),
    searchPlaceholder: t("npm.searchPlaceholder"),
    // Formatted before interpolation, for the thousands separator; see output.moreEntries.
    weekly: (count: number) => t("npm.weekly", { downloads: count.toLocaleString("en-US") }),
    add: (name: string) => t("npm.add", { name }),
    addButton: t("npm.addButton"),
    // R26-3: a result with a pending install shows this instead of Add.
    adding: t("npm.adding"),
    // R26-2: a result already in the installed table shows this instead of Add.
    installedVersion: (version: string) => t("npm.installedVersion", { version }),
    name: t("npm.name"),
    version: t("npm.version"),
    latest: t("npm.latest"),
    // Shown in a Latest cell once an outdated check has succeeded and found nothing newer, so the cell reports a
    // real state instead of rendering blank.
    upToDate: t("npm.upToDate"),
    // Shown in a Latest cell when no outdated check has succeeded yet, so "is there a newer one" is simply unknown.
    latestUnknown: t("npm.latestUnknown"),
    update: (name: string) => t("npm.update", { name }),
    updateButton: t("npm.updateButton"),
    remove: (name: string) => t("npm.remove", { name }),
    // The row's destructive action carries a word, not a glyph: an unlabelled × under a blank column header was
    // being mistaken for the sheet's (previously missing) close control.
    removeButton: t("npm.removeButton"),
    updateAll: t("npm.updateAll"),
    // R26-1: the toolbar's Update All tooltip, distinct from its (unchanged) accessible name.
    // `majors` keeps the placeholder name `majorCount`: `count` is taken by the form selector, and i18next
    // would otherwise pluralize on the wrong number.
    updateAllTitle: (count: number, majors: number) =>
      majors > 0
        ? t("npm.updateAllTitle.withMajors", { count, majorCount: majors })
        : t("npm.updateAllTitle.plain", { count }),
    showTypes: t("npm.showTypes"),
    allowScripts: t("npm.allowScripts"),
    // R26-5: shown only once the first list has loaded, so a load-in-progress sheet never flashes "no packages".
    none: t("npm.none"),
    noResults: (query: string) => t("npm.noResults", { query }),
    typesHidden: (count: number) => t("npm.typesHidden", { count }),
    log: t("npm.log"),
    // R26-3 adds a `queued` count; do-not-change list R-M3: this is one of the two allowed signature changes.
    // Each `kind` is its own key rather than an English verb spliced into a sentence -- a construction that
    // does not survive translation. Every key is a STRING LITERAL: the key check's call-site scan matches
    // only a double-quoted literal, so a template-literal key would be invisible to it and would read as
    // unused. (This comment says it in words for the same reason: the scan reads comments too.)
    running: (kind: string, target: string, queued: number) => {
      const body =
        kind === "remove"
          ? t("npm.running.removing", { target })
          : kind === "update"
            ? t("npm.running.updating", { target })
            : kind === "updateAll"
              ? t("npm.running.updatingAll")
              : t("npm.running.installing", { target });
      return queued > 0 ? t("npm.running.queued", { body, count: queued }) : body;
    },
    // R26-3: shown in the affected row's Latest cell while that row has a queued or running operation.
    rowStatus: (kind: string, status: string) => {
      if (status === "queued") return t("npm.rowStatus.queued");
      return kind === "remove"
        ? t("npm.rowStatus.removing")
        : kind === "update" || kind === "updateAll"
          ? t("npm.rowStatus.updating")
          : t("npm.rowStatus.installing");
    },
    // R26-4 adds `kind`; do-not-change list R-M3: the second of the two allowed signature changes.
    failed: (kind: string, target: string) =>
      kind === "updateAll"
        ? t("npm.failed.updateAll")
        : kind === "remove"
          ? t("npm.failed.remove", { target })
          : kind === "update"
            ? t("npm.failed.update", { target })
            : t("npm.failed.install", { target }),
    // R26-4: the failure-card action row.
    retry: t("npm.retry"),
    allowAndRetry: t("npm.allowAndRetry"),
    copyLog: t("npm.copyLog"),
    dismiss: t("npm.dismiss"),
    scriptBlocked: t("npm.scriptBlocked"),
    // R26-1: the Major badge and its tooltip.
    major: t("npm.major"),
    majorTitle: (name: string, from: string | null, to: string | null) =>
      t("npm.majorTitle", { name, from: from ?? "?", to: to ?? "?" }),
    // R26-1: "Checked N min ago", above the installed table.
    checkedAgo: (minutes: number) =>
      minutes < 1 ? t("npm.checkedAgo.justNow") : t("npm.checkedAgo.minutes", { minutes }),
    // R26-6: reported in the status bar when a finished operation's sheet isn't open to show it inline.
    done: (kind: string, target: string, keys: string | null) => {
      const body =
        kind === "remove"
          ? t("npm.done.removed", { target })
          : kind === "update"
            ? t("npm.done.updated", { target })
            : kind === "updateAll"
              ? t("npm.done.updatedAll")
              : t("npm.done.installed", { target });
      return keys ? t("npm.done.withKeys", { body, keys }) : body;
    },
    doneFailed: (kind: string, target: string, hint: string) =>
      t("npm.doneFailed", { failure: strings.npm.failed(kind, target), hint }),
    outdatedFailed: (hint: string) => t("npm.outdatedFailed", { hint }),
    hints: {
      network: t("npm.hints.network"),
      notFound: t("npm.hints.notFound"),
      noMatchingVersion: t("npm.hints.noMatchingVersion"),
      peerConflict: t("npm.hints.peerConflict"),
      scriptBlocked: t("npm.hints.scriptBlocked"),
      nativeBuild: t("npm.hints.nativeBuild"),
      disk: t("npm.hints.disk"),
      timeout: t("npm.hints.timeout"),
      unknown: t("npm.hints.unknown"),
    },
  },
  settings: {
    windowTitle: t("settings.windowTitle"),
    search: t("settings.search"),
    results: t("settings.results"),
    restartRequired: t("settings.restartRequired"),
    tabs: {
      general: t("settings.tabs.general"),
      editor: t("settings.tabs.editor"),
      formatting: t("settings.tabs.formatting"),
      appearance: t("settings.tabs.appearance"),
      keybindings: t("settings.tabs.keybindings"),
      npm: t("settings.tabs.npm"),
      build: t("settings.tabs.build"),
      advanced: t("settings.tabs.advanced"),
    },
    keybindings: {
      title: t("settings.keybindings.title"),
      help: t("settings.keybindings.help"),
      search: t("settings.keybindings.search"),
      columns: {
        command: t("settings.keybindings.columns.command"),
        keybinding: t("settings.keybindings.columns.keybinding"),
        when: t("settings.keybindings.columns.when"),
        source: t("settings.keybindings.columns.source"),
      },
      source: {
        default: t("settings.keybindings.source.default"),
        user: t("settings.keybindings.source.user"),
        none: t("settings.keybindings.source.none"),
      },
      unregistered: t("settings.keybindings.unregistered"),
      conflict: (titles: string) => t("settings.keybindings.conflict", { titles }),
      openFile: t("settings.keybindings.openFile"),
      empty: t("settings.keybindings.empty"),
      loadFailed: t("settings.keybindings.loadFailed"),
      change: t("settings.keybindings.change"),
      capture: (title: string) => t("settings.keybindings.capture", { title }),
      capturing: (title: string) => t("settings.keybindings.capturing", { title }),
      captureHint: t("settings.keybindings.captureHint"),
      reset: t("settings.keybindings.reset"),
      resetRow: (title: string) => t("settings.keybindings.resetRow", { title }),
      resetAll: t("settings.keybindings.resetAll"),
      rejected: {
        bareKey: t("settings.keybindings.rejected.bareKey"),
        reserved: t("settings.keybindings.rejected.reserved"),
      },
      saveFailed: t("settings.keybindings.saveFailed"),
      // Spec §18: the path is never quoted here -- Main logs the raw cause instead.
      fileInvalid: t("settings.keybindings.fileInvalid"),
    },
    groups: {
      dark: t("settings.groups.dark"),
      light: t("settings.groups.light"),
      bundled: t("settings.groups.bundled"),
      monospace: t("settings.groups.monospace"),
      installed: t("settings.groups.installed"),
    },
    loadingFonts: t("settings.loadingFonts"),
    fontsUnavailable: t("settings.fontsUnavailable"),
    openDataFolder: t("settings.openDataFolder"),
    resetAll: t("settings.resetAll"),
    confirmReset: t("settings.confirmReset"),
    restartSafeMode: t("settings.restartSafeMode"),
    loadFailed: (message: string) => t("settings.loadFailed", { message }),
    npmrc: {
      title: t("settings.npmrc.title"),
      help: t("settings.npmrc.help"),
      privacyNote: t("settings.npmrc.privacyNote"),
      editorLabel: t("settings.npmrc.editorLabel"),
      save: t("settings.npmrc.save"),
      reset: t("settings.npmrc.reset"),
      saved: t("settings.npmrc.saved"),
      resetDone: t("settings.npmrc.resetDone"),
      resetFailed: t("settings.npmrc.resetFailed"),
      /**
       * A failed load leaves `saved` null, which disables Save *and* Reset -- a `.npmrc` that is present but
       * unreadable must never be written over sight unseen. So this message has to say that Reset is off because
       * of this, and what the remedy is, since JSLab cannot repair the file itself. The code is best-effort:
       * `saveFailed`'s arrives in the response payload, but a failed load arrives as a rejection.
       */
      loadFailed: (code: string | null) =>
        code === "EFBIG"
          ? t("settings.npmrc.loadFailedTooLarge")
          : code
            ? t("settings.npmrc.loadFailed", { code })
            : t("settings.npmrc.loadFailedNoCode"),
      saveFailed: (code: string | null) =>
        code ? t("settings.npmrc.saveFailed", { code }) : t("settings.npmrc.saveFailedNoCode"),
      examples: t("settings.npmrc.examples"),
      exampleText: t("settings.npmrc.exampleText"),
      warnings: {
        missingEquals: (line: number) => t("settings.npmrc.warnings.missingEquals", { line }),
        registryNotUrl: (line: number) => t("settings.npmrc.warnings.registryNotUrl", { line }),
      },
    },
    fields: {
      "run.autoRun": { label: t("settings.run.autoRun.label"), help: t("settings.run.autoRun.help") },
      "run.autoLog": { label: t("settings.run.autoLog.label"), help: t("settings.run.autoLog.help") },
      "run.defaultRuntime": {
        label: t("settings.run.defaultRuntime.label"),
        help: t("settings.run.defaultRuntime.help"),
      },
      "run.defaultLanguage": {
        label: t("settings.run.defaultLanguage.label"),
        help: t("settings.run.defaultLanguage.help"),
      },
      "run.formatOnRun": {
        label: t("settings.run.formatOnRun.label"),
        help: t("settings.run.formatOnRun.help"),
      },
      "tabs.confirmClose": { label: t("settings.tabs.confirmClose.label"), help: t("settings.tabs.confirmClose.help") },
      "app.uiLanguage": {
        label: t("settings.app.uiLanguage.label"),
        help: t("settings.app.uiLanguage.help"),
      },
      "editor.lineNumbers": {
        label: t("settings.editor.lineNumbers.label"),
        help: t("settings.editor.lineNumbers.help"),
      },
      "editor.lineWrap": { label: t("settings.editor.lineWrap.label"), help: t("settings.editor.lineWrap.help") },
      "editor.vimKeys": { label: t("settings.editor.vimKeys.label"), help: t("settings.editor.vimKeys.help") },
      "editor.closeBrackets": {
        label: t("settings.editor.closeBrackets.label"),
        help: t("settings.editor.closeBrackets.help"),
      },
      "editor.invisibles": { label: t("settings.editor.invisibles.label"), help: t("settings.editor.invisibles.help") },
      "editor.activeLine": { label: t("settings.editor.activeLine.label"), help: t("settings.editor.activeLine.help") },
      "editor.autocomplete": {
        label: t("settings.editor.autocomplete.label"),
        help: t("settings.editor.autocomplete.help"),
      },
      "editor.linting": { label: t("settings.editor.linting.label"), help: t("settings.editor.linting.help") },
      "editor.hoverInfo": { label: t("settings.editor.hoverInfo.label"), help: t("settings.editor.hoverInfo.help") },
      "editor.hoverDelayMs": {
        label: t("settings.editor.hoverDelayMs.label"),
        help: t("settings.editor.hoverDelayMs.help"),
      },
      "editor.signatures": { label: t("settings.editor.signatures.label"), help: t("settings.editor.signatures.help") },
      "editor.formatOnSave": {
        label: t("settings.editor.formatOnSave.label"),
        help: t("settings.editor.formatOnSave.help"),
      },
      "editor.minimap": { label: t("settings.editor.minimap.label"), help: t("settings.editor.minimap.help") },
      "prettier.printWidth": {
        label: t("settings.prettier.printWidth.label"),
        help: t("settings.prettier.printWidth.help"),
      },
      "prettier.tabWidth": { label: t("settings.prettier.tabWidth.label"), help: t("settings.prettier.tabWidth.help") },
      "prettier.useTabs": { label: t("settings.prettier.useTabs.label"), help: t("settings.prettier.useTabs.help") },
      "prettier.semi": { label: t("settings.prettier.semi.label"), help: t("settings.prettier.semi.help") },
      "prettier.singleQuote": {
        label: t("settings.prettier.singleQuote.label"),
        help: t("settings.prettier.singleQuote.help"),
      },
      "prettier.quoteProps": {
        label: t("settings.prettier.quoteProps.label"),
        help: t("settings.prettier.quoteProps.help"),
      },
      "prettier.jsxSingleQuote": {
        label: t("settings.prettier.jsxSingleQuote.label"),
        help: t("settings.prettier.jsxSingleQuote.help"),
      },
      "prettier.trailingComma": {
        label: t("settings.prettier.trailingComma.label"),
        help: t("settings.prettier.trailingComma.help"),
      },
      "prettier.bracketSpacing": {
        label: t("settings.prettier.bracketSpacing.label"),
        help: t("settings.prettier.bracketSpacing.help"),
      },
      "prettier.bracketSameLine": {
        label: t("settings.prettier.bracketSameLine.label"),
        help: t("settings.prettier.bracketSameLine.help"),
      },
      "prettier.arrowParens": {
        label: t("settings.prettier.arrowParens.label"),
        help: t("settings.prettier.arrowParens.help"),
      },
      "appearance.theme": { label: t("settings.appearance.theme.label"), help: t("settings.appearance.theme.help") },
      "appearance.followSystem": {
        label: t("settings.appearance.followSystem.label"),
        help: t("settings.appearance.followSystem.help"),
      },
      "appearance.lightTheme": {
        label: t("settings.appearance.lightTheme.label"),
        help: t("settings.appearance.lightTheme.help"),
      },
      "appearance.darkTheme": {
        label: t("settings.appearance.darkTheme.label"),
        help: t("settings.appearance.darkTheme.help"),
      },
      "appearance.font": {
        label: t("settings.appearance.font.label"),
        help: t("settings.appearance.font.help"),
      },
      "appearance.fontSize": {
        label: t("settings.appearance.fontSize.label"),
        help: t("settings.appearance.fontSize.help"),
      },
      "appearance.fontLigatures": {
        label: t("settings.appearance.fontLigatures.label"),
        help: t("settings.appearance.fontLigatures.help"),
      },
      "appearance.uiScale": {
        label: t("settings.appearance.uiScale.label"),
        help: t("settings.appearance.uiScale.help"),
      },
      "view.tabBarForSingleTab": {
        label: t("settings.view.tabBarForSingleTab.label"),
        help: t("settings.view.tabBarForSingleTab.help"),
      },
      "view.activityBar": { label: t("settings.view.activityBar.label"), help: t("settings.view.activityBar.help") },
      "view.statusBar": { label: t("settings.view.statusBar.label"), help: t("settings.view.statusBar.help") },
      "view.sideBar": { label: t("settings.view.sideBar.label"), help: t("settings.view.sideBar.help") },
      "view.layout": { label: t("settings.view.layout.label"), help: t("settings.view.layout.help") },
      "output.highlighting": {
        label: t("settings.output.highlighting.label"),
        help: t("settings.output.highlighting.help"),
      },
      "output.showLineNumbers": {
        label: t("settings.output.showLineNumbers.label"),
        help: t("settings.output.showLineNumbers.help"),
      },
      "run.showUndefined": { label: t("settings.run.showUndefined.label"), help: t("settings.run.showUndefined.help") },
      "run.loopProtection": {
        label: t("settings.run.loopProtection.label"),
        help: t("settings.run.loopProtection.help"),
      },
      "run.loopProtectionMaxIterations": {
        label: t("settings.run.loopProtectionMaxIterations.label"),
        help: t("settings.run.loopProtectionMaxIterations.help"),
      },
      "run.autoRunDelayMs": {
        label: t("settings.run.autoRunDelayMs.label"),
        help: t("settings.run.autoRunDelayMs.help"),
      },
      "run.unresponsiveTimeoutMs": {
        label: t("settings.run.unresponsiveTimeoutMs.label"),
        help: t("settings.run.unresponsiveTimeoutMs.help"),
      },
      "output.maxEntries": {
        label: t("settings.output.maxEntries.label"),
        help: t("settings.output.maxEntries.help"),
      },
      "updates.auto": { label: t("settings.updates.auto.label"), help: t("settings.updates.auto.help") },
      "updates.channel": {
        label: t("settings.updates.channel.label"),
        help: t("settings.updates.channel.help"),
      },
      "npm.allowInstallScripts": {
        label: t("settings.npm.allowInstallScripts.label"),
        help: t("settings.npm.allowInstallScripts.help"),
      },
      "npm.autoInstallTypes": {
        label: t("settings.npm.autoInstallTypes.label"),
        help: t("settings.npm.autoInstallTypes.help"),
      },
      "build.decorators": {
        label: t("settings.build.decorators.label"),
        help: t("settings.build.decorators.help"),
      },
      "build.pipelineOperator": {
        label: t("settings.build.pipelineOperator.label"),
        help: t("settings.build.pipelineOperator.help"),
      },
      "build.doExpressions": {
        label: t("settings.build.doExpressions.label"),
        help: t("settings.build.doExpressions.help"),
      },
      "build.throwExpressions": {
        label: t("settings.build.throwExpressions.label"),
        help: t("settings.build.throwExpressions.help"),
      },
      "build.functionSent": {
        label: t("settings.build.functionSent.label"),
        help: t("settings.build.functionSent.help"),
      },
      "build.regexpModifiers": {
        label: t("settings.build.regexpModifiers.label"),
        help: t("settings.build.regexpModifiers.help"),
      },
      "build.optionalChainingAssign": {
        label: t("settings.build.optionalChainingAssign.label"),
        help: t("settings.build.optionalChainingAssign.help"),
      },
    } as Record<string, { label: string; help: string }>,
    options: {
      runtime: {
        "browser-node": t("settings.options.runtime.browser-node"),
        bun: t("settings.options.runtime.bun"),
        browser: t("settings.options.runtime.browser"),
      },
      language: {
        typescript: t("settings.options.language.typescript"),
        javascript: t("settings.options.language.javascript"),
        tsx: t("settings.options.language.tsx"),
        jsx: t("settings.options.language.jsx"),
      },
      uiLanguage: {
        system: t("settings.options.uiLanguage.system"),
        en: t("settings.options.uiLanguage.en"),
        es: t("settings.options.uiLanguage.es"),
        ja: t("settings.options.uiLanguage.ja"),
        zh: t("settings.options.uiLanguage.zh"),
        pt: t("settings.options.uiLanguage.pt"),
      },
      quoteProps: {
        "as-needed": t("settings.options.quoteProps.as-needed"),
        consistent: t("settings.options.quoteProps.consistent"),
        preserve: t("settings.options.quoteProps.preserve"),
      },
      trailingComma: {
        all: t("settings.options.trailingComma.all"),
        es5: t("settings.options.trailingComma.es5"),
        none: t("settings.options.trailingComma.none"),
      },
      arrowParens: { always: t("settings.options.arrowParens.always"), avoid: t("settings.options.arrowParens.avoid") },
      layout: { horizontal: t("settings.options.layout.horizontal"), vertical: t("settings.options.layout.vertical") },
      channel: { stable: t("settings.options.channel.stable"), canary: t("settings.options.channel.canary") },
      decorators: {
        none: t("settings.options.decorators.none"),
        "2023-11": t("settings.options.decorators.2023-11"),
        legacy: t("settings.options.decorators.legacy"),
      },
    },
  },
};
