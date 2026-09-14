import { strings } from "./strings";

export interface ErrorPolicyDeps {
  log(message: string, detail?: unknown): void;
  /** Shows the blocking "JSLab couldn't start" dialog. */
  showFatal(message: string): Promise<void> | void;
  quit(code: number): void;
  /** Sends the non-blocking "Something went wrong" notice to the main window, if it is open. */
  notify(): void;
}

/**
 * What Main does with an error nothing else handled (spec §20, FA-I3).
 * - Until startup finishes (`markStarted`), an uncaught error, or `start()` rejecting, fails fast: it is logged, one
 *   dialog is shown and JSLab quits with exit code 1. `fail` runs once; later calls share the first one.
 * - After startup, uncaught exceptions and unhandled rejections are logged and shown as a notice, and JSLab keeps
 *   running.
 */
export function createErrorPolicy(deps: ErrorPolicyDeps) {
  let started = false;
  let failing: Promise<void> | null = null;
  let exitCode = 0;

  const fail = (error: unknown): Promise<void> => {
    if (failing) return failing;
    exitCode = 1;
    failing = (async () => {
      try {
        deps.log(strings.log.startupFailed, error);
      } catch (logError) {
        // The dialog and quit below must still happen even if the pre-quit log call itself throws (RR1-m3).
        try {
          deps.log(strings.log.startupLogFailed, logError);
        } catch {
          // Nothing more can be done if logging keeps throwing; fall through to the dialog and quit.
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      try {
        await deps.showFatal(message);
      } catch (dialogError) {
        deps.log(strings.log.startupDialogFailed, dialogError);
      }
      deps.quit(1);
    })();
    return failing;
  };

  return {
    /** 1 once startup failed, so the quit that follows keeps a failure exit code. */
    get exitCode(): number {
      return exitCode;
    },
    markStarted(): void {
      started = true;
    },
    fail,
    onUncaught(kind: "exception" | "rejection", error: unknown): void {
      deps.log(kind === "exception" ? strings.log.uncaughtException : strings.log.unhandledRejection, error);
      if (!started) {
        void fail(error);
        return;
      }
      try {
        deps.notify();
      } catch (notifyError) {
        deps.log(strings.log.noticeFailed, notifyError);
      }
    },
  };
}

export type ErrorPolicy = ReturnType<typeof createErrorPolicy>;
