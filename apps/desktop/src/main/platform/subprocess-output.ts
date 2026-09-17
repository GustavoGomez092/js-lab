/**
 * Caps for subprocess output Main buffers in its own heap.
 *
 * Main spawns short-lived helper binaries and reads what they print. `Bun.spawn`/`Bun.spawnSync` buffer a piped
 * stream with no limit unless `maxBuffer` is given, and -- measured on Bun 1.4.0 -- Bun drains the child's pipe
 * EAGERLY into its own buffer even when nothing ever reads `proc.stdout`: a child emitting 1 MiB chunks grew the
 * parent's RSS by 3.6 GB in two seconds with no reader attached at all, and by 10.8 GB when the stream was
 * consumed the way these call sites consumed it. Ceasing to read therefore bounds nothing. Only ending the child
 * does, and that is what `maxBuffer` does: at the limit Bun kills it with `killSignal` (default SIGTERM).
 *
 * A child that ignores SIGTERM is bounded all the same, because Bun also closes the pipe and the writer then dies
 * of EPIPE. Measured: a SIGTERM-ignoring flooder stopped at +1 MB with the default signal and +1 MB with
 * `killSignal: "SIGKILL"`, so no call site passes `killSignal` -- the default is provably sufficient.
 *
 * `maxBuffer` is enforced at pipe-read granularity rather than to the byte: a 1,024-byte cap retained 66,560
 * bytes, and a 65,536-byte cap retained 131,072 -- in both cases the cap plus one 64 KiB read. Every cap here is
 * therefore a bound on the ORDER of what Main retains, never an exact byte count, and a cap below 64 KiB buys
 * nothing over 64 KiB because that one read lands either way.
 */

/** One pipe read: the floor below which a smaller cap retains no less. Measured on Bun 1.4.0 (see above). */
export const SUBPROCESS_READ_GRANULARITY_BYTES = 64 * 1024;

/**
 * A helper whose entire legitimate output is one short, structured value: `osascript` printing a POSIX path for
 * the save dialog (a pathname, so at most PATH_MAX -- `getconf PATH_MAX /` reports 1024 on macOS), `osascript`
 * printing `$.NSEvent.modifierFlags` as a decimal integer (measured: 2 bytes), `sw_vers -productVersion`
 * (measured: 7 bytes), and `screencapture`'s stderr, which is only ever a diagnostic line bound for a log.
 *
 * The largest of those is a pathname at 1024 bytes, so this is 64x the biggest legitimate output. It is not
 * larger out of generosity: it is exactly SUBPROCESS_READ_GRANULARITY_BYTES, below which a smaller number would
 * claim a tightness Bun cannot actually deliver.
 */
export const MAX_SHORT_SUBPROCESS_OUTPUT_BYTES = SUBPROCESS_READ_GRANULARITY_BYTES;

/**
 * `system_profiler SPFontsDataType -json` -- the one helper whose output is a genuine document rather than a
 * single value: every installed font family, as JSON.
 *
 * Anchored on a measurement, and deliberately NOT presented as derived. On this machine the real scan produced
 * 2,258,402 bytes (2.15 MiB) in 9 seconds. There is no principled upper bound on how many fonts a user may
 * install, so no exact number is derivable here; 32 MiB is that measurement with a ~15x margin, and saying so is
 * more honest than dressing a round number up as a derivation.
 *
 * Being wrong in the tight direction is bounded and non-fatal: `runSystemProfiler` throws, and
 * `SystemFontsService.refresh` already logs the failure, keeps whatever list was cached and backs off for
 * SYSTEM_FONTS_RETRY_MS. A refused scan costs the font list, never the app.
 */
export const MAX_SYSTEM_PROFILER_OUTPUT_BYTES = 32 * 1024 * 1024;
