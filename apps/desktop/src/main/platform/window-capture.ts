import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";

/**
 * Window-only screenshots for E2E runs.
 * Upstream gap: Electrobun 2.0.1 exposes the native window pointer (`BrowserWindow#ptr`) but no CGWindowID.
 * On macOS that pointer is an NSWindow, and `-[NSWindow windowNumber]` is the CGWindowID `screencapture -l` takes.
 * Nothing here ever captures the whole screen.
 */
export function screencaptureArgs(windowNumber: number, outPath: string): string[] {
  if (!Number.isInteger(windowNumber) || windowNumber <= 0) {
    throw new Error("Window id unavailable; refusing to capture the full screen");
  }
  return ["screencapture", "-x", "-o", "-l", String(windowNumber), outPath];
}

type Objc = ReturnType<typeof loadObjc>;
let objc: Objc | null | undefined;

function loadObjc() {
  return dlopen("/usr/lib/libobjc.A.dylib", {
    sel_registerName: { args: [FFIType.ptr], returns: FFIType.ptr },
    objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i64 },
  });
}

export function windowNumberOf(nsWindow: Pointer | null): number | null {
  if (!nsWindow || process.platform !== "darwin") return null;
  if (objc === undefined) {
    try {
      objc = loadObjc();
    } catch {
      objc = null;
    }
  }
  if (!objc) return null;
  const name = Buffer.from("windowNumber\0");
  const selector = objc.symbols.sel_registerName(ptr(name));
  if (!selector) return null;
  const value = Number(objc.symbols.objc_msgSend(nsWindow, selector));
  return Number.isInteger(value) && value > 0 ? value : null;
}

export const SCREEN_RECORDING_SKIP = "no screen-recording permission";

export type CaptureResult = { path: string } | { skipped: string };

/**
 * `hasAccess` is `() => Utils.screenCapture.hasAccess()` in Main (devkit `api/sdks/main/core/Utils.ts:349-356`,
 * `CGPreflightScreenCaptureAccess`, which never prompts). Without access the capture is skipped, so `screencapture`
 * can't raise the macOS Screen Recording prompt. `Utils.screenCapture.requestAccess()` is never called.
 */
export async function captureWindow(
  windowNumber: number | null,
  outPath: string,
  hasAccess: () => boolean,
): Promise<CaptureResult> {
  if (!hasAccess()) return { skipped: SCREEN_RECORDING_SKIP };
  const proc = Bun.spawn(screencaptureArgs(windowNumber ?? 0, outPath), { stdout: "ignore", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`screencapture exited with ${code}: ${await new Response(proc.stderr).text()}`);
  return { path: outPath };
}
