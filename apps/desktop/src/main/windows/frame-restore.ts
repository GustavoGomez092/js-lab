/** A window frame in screen points, as `BrowserWindow#getFrame()` reports it. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The part of Electrobun's `Display` (devkit `api/sdks/main/proc/native.ts:3068-3074`) that restoring needs. */
export interface DisplayInfo {
  id: number;
  /** The whole display, menu bar and Dock included. */
  bounds: Rect;
  workArea: Rect;
  isPrimary: boolean;
}

export interface SavedFrame extends Rect {
  displayId?: string | undefined;
  fullscreen?: boolean | undefined;
}

/** The M1 frame, used when no display information is available at all. */
export const DEFAULT_FRAME: Rect = { x: 120, y: 80, width: 1280, height: 820 };

const rectOf = ({ x, y, width, height }: Rect): Rect => ({ x, y, width, height });
const centerOf = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const contains = (area: Rect, point: { x: number; y: number }) =>
  point.x >= area.x && point.x < area.x + area.width && point.y >= area.y && point.y < area.y + area.height;

const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * The display whose work area holds the frame's center; otherwise the display whose full bounds the frame overlaps
 * most, so a frame centered over the menu bar or Dock strip still records a display (FA-m6). Saving a frame records
 * its id (spec §10.1).
 */
export function displayForFrame(frame: Rect, displays: readonly DisplayInfo[]): DisplayInfo | null {
  const center = centerOf(frame);
  const byCenter = displays.find((display) => contains(display.workArea, center));
  if (byCenter) return byCenter;
  let best: DisplayInfo | null = null;
  let bestArea = 0;
  for (const display of displays) {
    const area = overlap(frame, display.bounds);
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

/**
 * The main window frame to persist after a move, resize or full-screen change (spec §10.1). In full screen the
 * windowed frame is kept, so leaving full screen after a relaunch returns to a normal size; with no windowed frame
 * saved yet (the first toggle), the current frame is saved with `fullscreen: true` (FA-m6).
 */
export function frameToSave(input: {
  fullScreen: boolean;
  frame: Rect;
  previous: SavedFrame | null;
  displays: readonly DisplayInfo[];
}): SavedFrame {
  if (input.fullScreen && input.previous) return { ...input.previous, fullscreen: true };
  const display = displayForFrame(input.frame, input.displays);
  return {
    ...rectOf(input.frame),
    ...(display ? { displayId: String(display.id) } : {}),
    fullscreen: input.fullScreen,
  };
}

/** Shrinks the frame to fit the area, then moves it fully inside. */
function clampInto(frame: Rect, area: Rect): Rect {
  const width = Math.min(frame.width, area.width);
  const height = Math.min(frame.height, area.height);
  return {
    x: Math.round(Math.min(Math.max(frame.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(frame.y, area.y), area.y + area.height - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function centerIn(size: { width: number; height: number }, area: Rect): Rect {
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/**
 * Spec §10.1: "Restored if the display still exists, otherwise centered on the primary display."
 * - A saved `displayId` that still exists: the frame, clamped into that display's work area.
 * - No `displayId` (M1 sessions): the display under the frame's center, if there is one, the same way.
 * - Otherwise the saved size, centered on the primary display. No saved frame: the default size, centered there.
 * - No display information (native FFI unavailable): the saved frame, or DEFAULT_FRAME, unchanged.
 */
export function restoreFrame(
  saved: SavedFrame | null,
  displays: readonly DisplayInfo[],
): { frame: Rect; fullscreen: boolean } {
  const fullscreen = saved?.fullscreen === true;
  const primary = displays.find((display) => display.isPrimary) ?? displays[0] ?? null;
  if (!primary) return { frame: saved ? rectOf(saved) : DEFAULT_FRAME, fullscreen };
  if (!saved) return { frame: centerIn(DEFAULT_FRAME, primary.workArea), fullscreen: false };
  const target =
    saved.displayId !== undefined
      ? (displays.find((display) => String(display.id) === saved.displayId) ?? null)
      : displayForFrame(saved, displays);
  if (target) return { frame: clampInto(saved, target.workArea), fullscreen };
  return { frame: centerIn(saved, primary.workArea), fullscreen };
}
