import { join } from "node:path";
import { SOURCE_LOCALE } from "@jslab/shared";
import { createTranslator, type Translate } from "./i18n";

/**
 * Every user-visible Main string, resolved through the translator (spec §17).
 *
 * A factory rather than a module-scope object, because Main's translator needs `AppPaths.localesDir`, which is
 * only known once `resolveAppPaths` has run inside the bootstrap. Taking `t` as a parameter keeps that ordering
 * explicit and keeps the module testable without a filesystem.
 */
export function createStrings(t: Translate) {
  return {
    window: {
      settingsTitle: t("main.window.settingsTitle"),
    },
    log: {
      keybindingsInvalid: (path: string) => t("main.log.keybindingsInvalid", { path }),
      safeMode: (reason: string) => t("main.log.safeMode", { reason }),
      e2eEnabled: (path: string) => t("main.log.e2eEnabled", { path }),
      cliSocket: (path: string) => t("main.log.cliSocket", { path }),
      /** A second instance: the first one owns the socket, so `jslab` reaches that one and this one just runs. */
      cliSocketFailed: t("main.log.cliSocketFailed"),
      restartRequested: t("main.log.restartRequested"),
      relaunchFailed: t("main.log.relaunchFailed"),
      startupFailed: t("main.log.startupFailed"),
      startupDialogFailed: t("main.log.startupDialogFailed"),
      startupLogFailed: t("main.log.startupLogFailed"),
      uncaughtException: t("main.log.uncaughtException"),
      unhandledRejection: t("main.log.unhandledRejection"),
      noticeFailed: t("main.log.noticeFailed"),
      /** RR1-m1: the quit flush now covers session and settings, not session alone. */
      quitFlushFailed: t("main.log.quitFlushFailed"),
      quitFlushTimedOut: (timeoutMs: number) => t("main.log.quitFlushTimedOut", { timeoutMs }),
      /** RR1-m2: a settings write that hung. */
      settingsWriteTimedOut: (timeoutMs: number) => t("main.log.settingsWriteTimedOut", { timeoutMs }),
      settingsWriteFailed: t("main.log.settingsWriteFailed"),
      npmHomeNpmrcMoved: (path: string) => t("main.log.npmHomeNpmrcMoved", { path }),
      npmPostChangeFailed: t("main.log.npmPostChangeFailed"),
      npmTypesCheckFailed: t("main.log.npmTypesCheckFailed"),
      /** Fix round 1 (I-2): packages/package.json exists but isn't a readable manifest; never replaced silently. */
      npmManifestUnreadable: (path: string) => t("main.log.npmManifestUnreadable", { path }),
      /** FR-12 (fix round 2): the same anti-pattern as npmManifestUnreadable, in the registry-selection path. */
      npmNpmrcUnreadable: (path: string) => t("main.log.npmNpmrcUnreadable", { path }),
      /** Names the size, so an oversized .npmrc never surfaces as a generic I/O or parse failure. */
      npmNpmrcTooLarge: (path: string, size: number, maxBytes: number) =>
        t("main.log.npmNpmrcTooLarge", { path, size, maxBytes }),
      /** Fix round 1 (M-1): an onOperation subscriber threw; the queue's own bookkeeping must still proceed. */
      npmOperationEventFailed: t("main.log.npmOperationEventFailed"),
      /** M4: the vendor cache's post-npm-change wipe (spec §11.3) failed; the cache may now serve a stale chunk. */
      vendorCacheInvalidateFailed: t("main.log.vendorCacheInvalidateFailed"),
      loginShellFailed: (reason: string) => t("main.log.loginShellFailed", { reason }),
      /** Spec §9.3: the raw cause can quote an absolute path, so it goes here and never to the user (spec §18). */
      themeUnreadable: t("main.log.themeUnreadable"),
    },
    // No `dialogs` group: the one startup dialog (`index.ts`'s `showFatal`) fires before `resolveAppPaths` has
    // run, so there is no translator to reach and it shows an English literal by design. A catalogue entry that
    // no surface can render is exactly the dead copy the unused-key sweep exists to prevent, and the sweep could
    // not have seen it -- the `t()` call in this file would have counted as its use.
    files: {
      tooLarge: (name: string) => t("main.files.tooLarge", { name }),
      notText: (name: string) => t("main.files.notText", { name }),
      unreadable: (name: string) => t("main.files.unreadable", { name }),
      expired: t("main.files.expired"),
      confirmExpired: t("main.files.confirmExpired"),
      tabGone: t("main.files.tabGone"),
      openInAnotherTab: (name: string) => t("main.files.openInAnotherTab", { name }),
      /**
       * B1: refused rather than written. The tab is showing an empty editor because its buffer file couldn't be
       * read, so saving it would replace the user's real file with text JSLab invented.
       */
      bufferUnreadable: t("main.files.bufferUnreadable"),
    },
    snippets: {
      tooLarge: t("main.snippets.tooLarge"),
    },
    /** Themes → Import VS Code Theme… (spec §9.3). Never quotes a path: the raw cause goes to the log instead. */
    themes: {
      unreadable: t("main.themes.unreadable"),
      tooLarge: t("main.themes.tooLarge"),
      notJson: t("main.themes.notJson"),
      pickExpired: t("main.themes.pickExpired"),
      /**
       * Task 4 finding 1: a theme whose name slugs onto a built-in id is written, reported as imported, and then
       * hidden forever -- `listThemes` lets a built-in win, so the file exists but no surface ever offers it.
       * Refusing up front is the disclosure that finding asked for: nothing is written and the user is told why.
       */
      builtinName: t("main.themes.builtinName"),
      /**
       * R-M5d-AA-1: imported syntax colours are painted exactly as the theme wrote them, so unlike the built-ins they
       * are not lifted to WCAG AA in the editor. Saying so is cheaper than silently lifting them, which would make a
       * theme the user chose for its appearance look wrong to them.
       */
      lowContrastSyntax: t("main.themes.lowContrastSyntax"),
      /** `semanticTokenColors` is accepted by the format and then dropped, which nothing else would explain. */
      semanticDropped: t("main.themes.semanticDropped"),
    },
    notices: {
      copySaved: (file: string) => t("main.notices.copySaved", { file }),
      settingsReset: t("main.notices.settingsReset"),
      settingsRestored: t("main.notices.settingsRestored"),
      settingsRestoredMissing: t("main.notices.settingsRestoredMissing"),
      sessionReset: t("main.notices.sessionReset"),
      sessionRestored: t("main.notices.sessionRestored"),
      sessionRestoredMissing: t("main.notices.sessionRestoredMissing"),
      /** Spec §20 "Unexpected Main exception": a non-blocking notice; the app keeps running (FA-I3). */
      unexpectedError: t("main.notices.unexpectedError"),
      /**
       * D1: a settings change that could not be written, because rewriting settings.json would exceed the cap its own
       * reader applies. The user's question is "why can't I change my settings?", so this names the file and the
       * reason rather than saying a write failed -- and says the change is lost on restart, which is the part they
       * would otherwise discover only by losing it. Worded after `settingsNewer`, which is the same situation.
       */
      settingsTooLarge: (bytes: number, maxBytes: number) => t("main.notices.settingsTooLarge", { bytes, maxBytes }),
      settingsNewer: (version: number) => t("main.notices.settingsNewer", { version }),
      sessionNewer: (version: number) => t("main.notices.sessionNewer", { version }),
      tabsDropped: (count: number) => t("main.notices.tabsDropped", { count }),
      /**
       * F1: one unreadable buffer used to fail the whole `app.bootstrap`, leaving a failure screen whose only
       * control re-ran the same request. Those tabs now open without their contents instead.
       *
       * B1: the previous wording claimed "The file on disk won't be overwritten." That was false for a file-backed
       * tab -- and it was the sentence most likely to make the user press Save on ⌘W's prompt, which truncated the
       * file. It is true now (`file.save` and Save As both refuse such a tab, and the tab opens read-only), so the
       * notice describes what the user can see, and promises only what is actually enforced.
       */
      buffersUnreadable: (count: number) => t("main.notices.buffersUnreadable", { count }),
    },
    cli: {
      /** Shown as a notice after Help → Install/Uninstall `jslab` Command… (spec §16.1). */
      installFailed: (message: string) => t("main.cli.installFailed", { message }),
    },
    /** Settings → Keybindings (spec §6.5). Never quotes a path: the raw cause goes to the log instead (spec §18). */
    keybindings: {
      saveFailed: t("main.keybindings.saveFailed"),
      /**
       * Refusing to write over a keybindings.json we could not parse.
       *
       * When the file is unparseable the store holds no rules, so any save from Settings would replace the user's
       * broken file with a set derived from nothing -- destroying the very text they opened the file to repair.
       */
      fileInvalid: t("main.keybindings.fileInvalid"),
    },
    runs: {
      /** Spec §12.2. */
      workingDirectoryNotFound: (path: string) => t("main.runs.workingDirectoryNotFound", { path }),
    },
  };
}

export type MainStrings = ReturnType<typeof createStrings>;

/**
 * Where the default `strings` below finds English before the bootstrap installs the real translator.
 *
 * `JSLAB_LOCALES_DIR` is the same override `resolveAppPaths` honours. Otherwise this is the repo layout, which is
 * what unit tests and `bun dev` see: seventeen Main modules import `strings` at module scope and six test files
 * assert its English text, so a default that resolved to keys would turn every one of those into a failure and
 * force a translator install into tests that have nothing to do with i18n. In a packaged build this path does not
 * exist, `createTranslator` degrades to returning the key, and `installStrings` replaces it in `start()` before
 * any string is read -- see the two-stage install in `index.ts`.
 */
const DEFAULT_LOCALES_DIR =
  process.env.JSLAB_LOCALES_DIR ?? join(import.meta.dir, "..", "..", "..", "ui", "src", "i18n", "locales");

/**
 * The live binding the rest of Main imports. Reassigned once (or twice) during startup by `installStrings`; every
 * importer reads it through the ES live binding at call time, so no call site changes and no module has to thread
 * a `strings` parameter through its own callers.
 */
export let strings: MainStrings = createStrings(createTranslator({ dir: DEFAULT_LOCALES_DIR, locale: SOURCE_LOCALE }));

/** Rebuilds `strings` against `t`. Called from the bootstrap once the locales directory and the locale are known. */
export function installStrings(t: Translate): void {
  strings = createStrings(t);
}
