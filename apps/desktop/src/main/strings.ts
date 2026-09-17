/** Every user-visible Main string, kept in one place for M5 i18n extraction (spec §17). */
export const strings = {
  window: {
    settingsTitle: "JSLab Settings",
  },
  log: {
    keybindingsInvalid: (path: string) => `keybindings.json at ${path} is not valid JSON; using the default keymap`,
    safeMode: (reason: string) => `starting in Safe Mode (${reason})`,
    e2eEnabled: (path: string) => `E2E automation enabled on ${path}`,
    cliSocket: (path: string) => `jslab CLI socket listening on ${path}`,
    /** A second instance: the first one owns the socket, so `jslab` reaches that one and this one just runs. */
    cliSocketFailed: "Couldn't start the jslab CLI socket; the jslab command can't reach this instance",
    restartRequested: "Restart in Safe Mode requested",
    relaunchFailed: "Could not relaunch JSLab after Restart in Safe Mode; quitting without reopening",
    startupFailed: "startup failed",
    startupDialogFailed: "startup failure dialog could not be shown",
    startupLogFailed: "the startup-failure log call itself failed",
    uncaughtException: "Uncaught exception",
    unhandledRejection: "Unhandled rejection",
    noticeFailed: "Couldn't show the unexpected-error notice",
    /** RR1-m1: the quit flush now covers session and settings, not session alone. */
    quitFlushFailed: "Couldn't save the session and settings before quitting",
    quitFlushTimedOut: (timeoutMs: number) =>
      `Couldn't save the session and settings within ${timeoutMs} ms before quitting; quitting anyway`,
    /** RR1-m2: a settings write that hung. */
    settingsWriteTimedOut: (timeoutMs: number) => `settings.json write did not finish within ${timeoutMs} ms`,
    settingsWriteFailed: "Couldn't save settings.json",
    npmHomeNpmrcMoved: (path: string) =>
      `Moved an .npmrc found in npm-home to ${path}; npm operations never read one there`,
    npmPostChangeFailed: "npm post-change step failed",
    npmTypesCheckFailed: "Couldn't check the registry for types",
    /** Fix round 1 (I-2): packages/package.json exists but isn't a readable manifest; never replaced silently. */
    npmManifestUnreadable: (path: string) => `npm's package.json at ${path} could not be read as JSON`,
    /** FR-12 (fix round 2): the same anti-pattern as npmManifestUnreadable, in the registry-selection path. */
    npmNpmrcUnreadable: (path: string) => `npm's .npmrc at ${path} could not be read`,
    /** Names the size, so an oversized .npmrc never surfaces as a generic I/O or parse failure. */
    npmNpmrcTooLarge: (path: string, size: number, maxBytes: number) =>
      `npm's .npmrc at ${path} is ${size} bytes, over the ${maxBytes}-byte limit, and was not read`,
    /** Fix round 1 (M-1): an onOperation subscriber threw; the queue's own bookkeeping must still proceed. */
    npmOperationEventFailed: "npm operation event could not be delivered",
    /** M4: the vendor cache's post-npm-change wipe (spec §11.3) failed; the cache may now serve a stale chunk. */
    vendorCacheInvalidateFailed: "Couldn't clear the web runner's vendor cache after a package change",
    loginShellFailed: (reason: string) =>
      `Couldn't read the login shell environment (${reason}); using the app's environment`,
    /** Spec §9.3: the raw cause can quote an absolute path, so it goes here and never to the user (spec §18). */
    themeUnreadable: "Couldn't read the selected theme file",
  },
  dialogs: {
    startupFailed: (message: string) => `JSLab couldn't start: ${message}`,
  },
  files: {
    tooLarge: (name: string) => `${name} is larger than 50 MB and can't be opened.`,
    notText: (name: string) => `${name} isn't a text file.`,
    unreadable: (name: string) => `${name} couldn't be read.`,
    expired: "That file request expired. Open the file again.",
    confirmExpired: "That save request expired. Save again.",
    tabGone: "That tab is no longer open.",
    openInAnotherTab: (name: string) => `${name} is already open in another tab.`,
    /**
     * B1: refused rather than written. The tab is showing an empty editor because its buffer file couldn't be
     * read, so saving it would replace the user's real file with text JSLab invented.
     */
    bufferUnreadable: "JSLab couldn't read this tab's contents, so it won't save over the file on disk.",
  },
  snippets: {
    tooLarge: "That file is larger than 5 MB, so it isn't a snippet library.",
  },
  /** Themes → Import VS Code Theme… (spec §9.3). Never quotes a path: the raw cause goes to the log instead. */
  themes: {
    unreadable: "That theme file couldn't be read.",
    tooLarge: "That file is too large to import.",
    notJson: "That file isn't a valid VS Code theme.",
    pickExpired: "That import expired. Choose the file again.",
    /**
     * Task 4 finding 1: a theme whose name slugs onto a built-in id is written, reported as imported, and then
     * hidden forever -- `listThemes` lets a built-in win, so the file exists but no surface ever offers it.
     * Refusing up front is the disclosure that finding asked for: nothing is written and the user is told why.
     */
    builtinName: "JSLab already has a built-in theme with that name. Rename the theme and import it again.",
    /**
     * R-M5d-AA-1: imported syntax colours are painted exactly as the theme wrote them, so unlike the built-ins they
     * are not lifted to WCAG AA in the editor. Saying so is cheaper than silently lifting them, which would make a
     * theme the user chose for its appearance look wrong to them.
     */
    lowContrastSyntax: "Some of its syntax colours are hard to read on its editor background.",
    /** `semanticTokenColors` is accepted by the format and then dropped, which nothing else would explain. */
    semanticDropped: "Its semantic token colours aren't supported, so some code may look plainer.",
  },
  notices: {
    copySaved: (file: string) => ` A copy was saved as ${file}`,
    settingsReset: "Settings were reset because the file was unreadable.",
    settingsRestored: "Settings were restored from the backup because the file was unreadable.",
    settingsRestoredMissing: "Settings were restored from the backup because settings.json was missing.",
    sessionReset: "Your tabs couldn't be restored because session.json was unreadable.",
    sessionRestored: "Your tabs were restored from the backup because session.json was unreadable.",
    sessionRestoredMissing: "Your tabs were restored from the backup because session.json was missing.",
    /** Spec §20 "Unexpected Main exception": a non-blocking notice; the app keeps running (FA-I3). */
    unexpectedError: "Something went wrong. Choose Help → Copy Debug Log to report it.",
    /**
     * D1: a settings change that could not be written, because rewriting settings.json would exceed the cap its own
     * reader applies. The user's question is "why can't I change my settings?", so this names the file and the
     * reason rather than saying a write failed -- and says the change is lost on restart, which is the part they
     * would otherwise discover only by losing it. Worded after `settingsNewer`, which is the same situation.
     */
    settingsTooLarge: (bytes: number, maxBytes: number) =>
      `settings.json is too large for JSLab to save (${bytes} bytes; the limit is ${maxBytes}). Changes made in this window won't be saved to it and will be lost when JSLab restarts. Choose Help → Copy Debug Log to find the file.`,
    settingsNewer: (version: number) =>
      `settings.json was written by a newer version of JSLab (version ${version}). Changes made in this window won't be saved to it.`,
    sessionNewer: (version: number) =>
      `session.json was written by a newer version of JSLab (version ${version}). Tab changes in this window won't be saved to it.`,
    tabsDropped: (count: number) =>
      `${count} ${count === 1 ? "tab" : "tabs"} in session.json couldn't be read and were skipped. Their buffer files were kept.`,
    /**
     * F1: one unreadable buffer used to fail the whole `app.bootstrap`, leaving a failure screen whose only
     * control re-ran the same request. Those tabs now open without their contents instead.
     *
     * B1: the previous wording claimed "The file on disk won't be overwritten." That was false for a file-backed
     * tab -- and it was the sentence most likely to make the user press Save on ⌘W's prompt, which truncated the
     * file. It is true now (`file.save` and Save As both refuse such a tab, and the tab opens read-only), so the
     * notice describes what the user can see, and promises only what is actually enforced.
     */
    buffersUnreadable: (count: number) =>
      count === 1
        ? "1 tab's contents couldn't be read, so it opened empty and read-only. JSLab won't save it over its file."
        : `${count} tabs' contents couldn't be read, so they opened empty and read-only. JSLab won't save them over their files.`,
  },
  cli: {
    /** Shown as a notice after Help → Install/Uninstall `jslab` Command… (spec §16.1). */
    installFailed: (message: string) => `Couldn't install the jslab command: ${message}`,
  },
  /** Settings → Keybindings (spec §6.5). Never quotes a path: the raw cause goes to the log instead (spec §18). */
  keybindings: {
    saveFailed: "Couldn't save your keybindings. Your changes are still here.",
    /**
     * Refusing to write over a keybindings.json we could not parse.
     *
     * When the file is unparseable the store holds no rules, so any save from Settings would replace the user's
     * broken file with a set derived from nothing -- destroying the very text they opened the file to repair.
     */
    fileInvalid: "keybindings.json isn't valid JSON. Open it, fix it, then relaunch JSLab.",
  },
  runs: {
    /** Spec §12.2. */
    workingDirectoryNotFound: (path: string) => `Working directory not found: ${path}`,
  },
} as const;
