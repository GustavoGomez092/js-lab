/** Every user-visible Main string, kept in one place for M5 i18n extraction (spec §17). */
export const strings = {
  window: {
    settingsTitle: "JSLab Settings",
  },
  log: {
    keybindingsInvalid: (path: string) => `keybindings.json at ${path} is not valid JSON; using the default keymap`,
    safeMode: (reason: string) => `starting in Safe Mode (${reason})`,
    e2eEnabled: (path: string) => `E2E automation enabled on ${path}`,
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
    /** Fix round 1 (M-1): an onOperation subscriber threw; the queue's own bookkeeping must still proceed. */
    npmOperationEventFailed: "npm operation event could not be delivered",
    loginShellFailed: (reason: string) =>
      `Couldn't read the login shell environment (${reason}); using the app's environment`,
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
    settingsNewer: (version: number) =>
      `settings.json was written by a newer version of JSLab (version ${version}). Changes made in this window won't be saved to it.`,
    sessionNewer: (version: number) =>
      `session.json was written by a newer version of JSLab (version ${version}). Tab changes in this window won't be saved to it.`,
    tabsDropped: (count: number) =>
      `${count} ${count === 1 ? "tab" : "tabs"} in session.json couldn't be read and were skipped. Their buffer files were kept.`,
  },
  runs: {
    /** Spec §12.2. */
    workingDirectoryNotFound: (path: string) => `Working directory not found: ${path}`,
  },
} as const;
