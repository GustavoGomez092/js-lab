/** Every user-visible Main string, kept in one place for M5 i18n extraction (spec §17). */
export const strings = {
  log: {
    keybindingsInvalid: (path: string) => `keybindings.json at ${path} is not valid JSON; using the default keymap`,
    safeMode: (reason: string) => `starting in Safe Mode (${reason})`,
    e2eEnabled: (path: string) => `E2E automation enabled on ${path}`,
    restartRequested: "Restart in Safe Mode requested",
    relaunchFailed: "Could not relaunch JSLab after Restart in Safe Mode; quitting without reopening",
    fatalError: "Unhandled error; quitting",
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
    sessionReset: "Your tabs couldn't be restored because session.json was unreadable.",
    sessionRestored: "Your tabs were restored from the backup because session.json was unreadable.",
    settingsNewer: (version: number) =>
      `settings.json was written by a newer version of JSLab (version ${version}). Changes made in this window won't be saved to it.`,
    sessionNewer: (version: number) =>
      `session.json was written by a newer version of JSLab (version ${version}). Tab changes in this window won't be saved to it.`,
    tabsDropped: (count: number) =>
      `${count} ${count === 1 ? "tab" : "tabs"} in session.json couldn't be read and were skipped. Their buffer files were kept.`,
  },
} as const;
