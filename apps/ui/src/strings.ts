/** Every user-visible UI string added from M2 on, kept in one place for M5 i18n extraction (spec §17). */
export const strings = {
  commands: {
    failed: (title: string, error: unknown) =>
      `${title} failed: ${error instanceof Error ? error.message : String(error)}`,
    onOff: (on: boolean) => (on ? "currently on" : "currently off"),
    loopLimit: (limit: number) => `limit ${limit}`,
    current: "current",
    copyFailed: "Couldn't copy the output to the clipboard.",
  },
  limits: {
    tooLarge: "This tab is larger than 64 MB. JSLab stops saving and running it until it's smaller.",
  },
  // Carried item T11-m4: a tab action (create/close/reopen/...) that Main rejects reports a status message
  // instead of leaving an unhandled rejection.
  tabs: {
    actionFailed: (error: unknown) =>
      `Couldn't complete that action: ${error instanceof Error ? error.message : String(error)}`,
  },
  fonts: {
    fallback: (font: string) => `Font "${font}" isn't available; using JetBrains Mono.`,
    // m-2 (fix round 1): the default font itself can fail its own check; don't claim to "fall back to
    // JetBrains Mono" from JetBrains Mono.
    bundledUnavailable: "The bundled code font couldn't load; using the system monospace font.",
  },
} as const;
