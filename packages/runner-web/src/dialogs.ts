/**
 * The non-blocking `alert`/`confirm`/`prompt` shim (spec §5.12, M0-S4).
 *
 * M0-S4 found that inside an `<electrobun-webview>`, WKWebView's own `alert`/`confirm`/`prompt` do NOT block: they
 * return `undefined`/`false`/`null` in about 1ms with no user interaction. JSLab's own shim exists not to fix
 * blocking (there is nothing to fix) but to (a) show the user *something* for `alert` -- a real browser at least
 * paints a panel; a page that silently drops it is confusing -- via JSLab's own non-blocking dialog, and (b) make
 * the limitation legible with a console warning, since a script written for a real browser that calls `confirm()`
 * expecting to pause for an answer will otherwise silently misbehave.
 *
 * The globals are **replaced outright**, never delegated to the native implementation first: this is what makes
 * "does a native panel flash behind the shim" categorically unobservable from here (there is no native call for one
 * to flash from) -- and it is why this module must be installed in the bootstrap's first statement, before any user
 * code can run and call one of these before the shim is in place (see `bootstrap.ts`).
 */

/** The three globals this module replaces; a real page, or a fake built for tests. */
export interface DialogGlobal {
  alert?(message?: unknown): void;
  confirm?(message?: unknown): boolean;
  prompt?(message?: unknown, defaultValue?: string): string | null;
  /** Only `warn` is used, and only after `console` is itself wrapped by `console-hook.ts` -- see the module doc. */
  console?: Pick<Console, "warn">;
}

/** Where `alert`'s text goes to be shown as JSLab's own non-blocking dialog. */
export interface DialogPushSink {
  /** Pushes one `dialog` event onto the current run's buffer; a no-op without an active run (mirrors every other
   *  `run?.buffer.push(...) ?? null` call site in `bootstrap.ts`). */
  push(body: { kind: "dialog"; text: string }): void;
}

export interface DialogShimOptions {
  global?: DialogGlobal;
  sink: DialogPushSink;
}

export interface DialogShimHandle {
  /** Resets the once-per-run warning flag. Call when a new run starts (spec: "once per run, not once per call"). */
  startRun(): void;
}

/**
 * One shared warning for all three functions -- "the limitation" is singular (a script expecting a blocking
 * dialog), not three separate limitations -- so calling `alert` then `confirm` then `prompt` in the same run warns
 * once, not three times.
 */
const SECTION_SIGN = String.fromCharCode(167);
export const DIALOG_WARNING =
  `alert/confirm/prompt cannot block this runtime (spec ${SECTION_SIGN}5.12): alert shows a message without ` +
  "waiting for it to be dismissed, confirm always answers false, and prompt always answers null.";

/**
 * Installs the shim. Call this as `startRunnerWeb`'s first statement (`bootstrap.ts`), before `console` itself is
 * wrapped by `installConsole` -- that's safe because `warnOnce` below reads `g.console.warn` at call time, once a
 * run actually calls one of these, by which point `installConsole` has already run; nothing here calls `console`
 * during installation itself.
 */
export function installDialogShim(options: DialogShimOptions): DialogShimHandle {
  const g = options.global ?? (globalThis as unknown as DialogGlobal);
  const { sink } = options;
  let warned = false;

  const warnOnce = (): void => {
    if (warned) return;
    warned = true;
    g.console?.warn(DIALOG_WARNING);
  };

  g.alert = (message?: unknown): void => {
    warnOnce();
    // `String(message)` matches the platform's own ToString conversion for a bare `alert()` call (shows "undefined"),
    // the same as a real browser.
    sink.push({ kind: "dialog", text: String(message) });
  };

  g.confirm = (_message?: unknown): boolean => {
    warnOnce();
    return false;
  };

  g.prompt = (_message?: unknown, _defaultValue?: string): string | null => {
    warnOnce();
    return null;
  };

  return {
    startRun(): void {
      warned = false;
    },
  };
}
