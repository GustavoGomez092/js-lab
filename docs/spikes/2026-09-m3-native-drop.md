# M3 Spike: Native Folder Drop on Electrobun 2.0.1

**Question:** Can Electrobun 2.0.1 deliver the file system path of a folder (or file) dropped onto the JSLab window to Main, so a folder drop sets the tab's working directory (spec §12.2) and a file drop opens a file-backed tab (TF-11)?

**Method:** read-only source audit of the devkit and Hutch's Electrobun 2.0.1 sources under `~/.hutch`, plus a scripted scan of event names. No app launch, no OS input.

**Note on source location (controller ruling R-M3-T6-1):** Task 1 is being implemented concurrently in `.worktrees/jslab-m3` and may regenerate its `apps/desktop/.hutch/devkit`. All devkit reads below were done against the sibling worktree `.worktrees/jslab-m0-m1`, which holds the identical pinned Electrobun 2.0.1. Paths below are shown relative to that worktree's repo root (`apps/desktop/.hutch/devkit/...`) per the privacy rule.

## Evidence

### Step 1a — `grep -rn -i -e "drop" -e "dragg" apps/desktop/.hutch/devkit/api/sdks/main apps/desktop/.hutch/devkit/api/preload | grep -v "\.test\.ts:"`

```
apps/desktop/.hutch/devkit/api/sdks/main/proc/native.ts:3767:		restoreWindowFocusAfterExternalDrop: (params: { windowId: number }) => {
apps/desktop/.hutch/devkit/api/sdks/main/ui/ui.ts:83:	 * Pressing and dragging this node moves the host window (frameless
apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts:494:		// Drop JS-side references first so late callbacks cannot target a stale view.
apps/desktop/.hutch/devkit/api/preload/dragRegions.ts:69: * Rewrites only app-region declaration names. WKWebView drops the unsupported
apps/desktop/.hutch/devkit/api/preload/index.ts:21:import { initExternalDropFocusRestoration } from "./externalDropFocus";
apps/desktop/.hutch/devkit/api/preload/index.ts:74:initExternalDropFocusRestoration();
apps/desktop/.hutch/devkit/api/preload/.generated/compiled.ts:5:  (bundled copy of the same preload sources, including externalDropFocus and dragRegions — no additional matches)
apps/desktop/.hutch/devkit/api/preload/externalDropFocus.ts:7:export function initExternalDropFocusRestoration(
apps/desktop/.hutch/devkit/api/preload/externalDropFocus.ts:16:		"drop",
apps/desktop/.hutch/devkit/api/preload/externalDropFocus.ts:23:				void requestFocus("restoreWindowFocusAfterExternalDrop", {
```

Every "drag"/"drop" hit resolves to one of: (1) window-move drag-region CSS handling (`dragRegions.ts` — app-region drag-to-move, unrelated to file drops), (2) an unrelated code comment (`ui.ts:83`, `BrowserView.ts:494`), or (3) the Windows-only focus-restore preload (`externalDropFocus.ts` / its wiring in `preload/index.ts:21,74` and the RPC target `native.ts:3767`).

`externalDropFocus.ts` (read in full):
```ts
export function initExternalDropFocusRestoration(
	targetWindow = window, platform = window.__electrobunPlatform,
	requestFocus = request, schedule = (callback) => setTimeout(callback),
) {
	if (platform !== "windows") return;
	targetWindow.addEventListener("drop", (event) => {
		const types = Array.from(event.dataTransfer?.types ?? []);
		if (!types.includes("Files")) return;
		...
		void requestFocus("restoreWindowFocusAfterExternalDrop", {
			windowId: targetWindow.__electrobunWindowId,
		})...
	}, true);
}
```
It listens for the browser `drop` DOM event in the *webview's* JS (not a Main-process event), gated to `platform === "windows"` only, and its only purpose is to re-activate the native window after focus is lost to Explorer during a drag. The RPC it sends, `restoreWindowFocusAfterExternalDrop`, is handled in Main at `apps/desktop/.hutch/devkit/api/sdks/main/proc/native.ts:3767`:
```ts
restoreWindowFocusAfterExternalDrop: (params: { windowId: number }) => {
	if (!getWindowPtr(params.windowId)) return false;
	core_.symbols.activateWindow(params.windowId);
	return true;
},
```
Payload is `{ windowId: number }` only — no path, no dropped-item metadata. This is exactly the brief's disqualified candidate ("A preload that only restores focus... does not count").

### Step 1b — `grep -n -e "on(" -e "Event" apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts | head -80`

```
2:import electrobunEventEmitter from "../events/eventEmitter";
21:const webviewTagCreatedEvent = Symbol("webview-tag-browser-view-created");
250:		ffi.request.evaluateJavascriptWithNoCompletion({ id: this.id, js });
336:	on(
350:		electrobunEventEmitter.on(specificName, handler);
578:	static on(name: "created", handler: BrowserViewCreatedHandler) {
579:		electrobunEventEmitter.on(webviewTagCreatedEvent, handler);
584:		electrobunEventEmitter.off(webviewTagCreatedEvent, handler);
596:	electrobunEventEmitter.emit(webviewTagCreatedEvent, view);
```

The instance `on()` method (`BrowserView.ts:336-351`) has a closed, literal union of event names:
```ts
on(
	name:
		| "will-navigate" | "did-navigate" | "did-navigate-in-page"
		| "did-commit-navigation" | "dom-ready"
		| "download-started" | "download-progress"
		| "download-completed" | "download-failed",
	handler: (event: unknown) => void,
) { ... }
```
No `drop`/`drag`/`file` name appears in this union — it is exhaustive (navigation + download lifecycle only).

### Step 1c — `grep -n -e "on(" -e "Event" apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserWindow.ts | head -80`

```
2:import electrobunEventEmitter from "../events/eventEmitter";
78:electrobunEventEmitter.on("close", (event: { data: { id: number } }) => {
374:	setPosition(x: number, y: number) {
377:		return ffi.request.setWindowPosition({ winId: this.id, x, y });
385:	setWindowButtonPosition(x: number, y: number) {
386:		return ffi.request.setWindowButtonPosition({ winId: this.id, x, y });
387:	getWindowButtonPosition(): { x: number; y: number } {
439:	on(name: string, handler: (event: unknown) => void) {
441:		electrobunEventEmitter.on(specificName, handler);
```

`BrowserWindow.on()` (line 439) takes an unconstrained `string`, so it forwards to whatever `electrobunEventEmitter` names the native layer actually emits — it does not by itself prove any drop event exists. Grepping `proc/native.ts` (the only place native code calls into `electrobunEventEmitter.emit(...)`) for every emitted event name found just 7 call sites, none drop/drag/file related: a generic `emit(name, payload)` wrapper (line 1199) used for RPC dispatch, `wgpu-pointer-*`, `wgpu-key-*`, `window-text-*`, and `ui-tag-mount`. No `drop`, `drag`, or `file` event is ever emitted from the native side.

### Step 1d — native source file search

```bash
find apps/desktop/.hutch/devkit -type f \( -name "*.zig" -o -name "*.mm" -o -name "*.m" -o -name "*.swift" -o -name "*.h" \) | head -40
```
Result: `apps/desktop/.hutch/devkit/zig-sdk/electrobun.zig` (only file).

```bash
find "$HOME/.hutch" -type f -path "*lectrobun*" \( -name "*.zig" -o -name "*.mm" -o -name "*.m" -o -name "*.swift" -o -name "*.h" \) 2>/dev/null | head -40
```
Result: `~/.hutch/releases/electrobun/2.0.1/macos-arm64/zig-sdk/electrobun.zig` (only file; byte-identical to the devkit copy — `diff` returned no differences).

Per-file check required by the brief:
```bash
grep -n -e "registerForDraggedTypes" -e "performDragOperation" -e "draggingEntered" -e "NSPasteboardTypeFileURL" -e "NSFilenamesPboardType" ~/.hutch/releases/electrobun/2.0.1/macos-arm64/zig-sdk/electrobun.zig
```
No matches for any of the five Cocoa drag/drop symbols. The only "drop" hit in this file at all is an unrelated comment (`// Drop the core's pointer to our trampoline before unloading the ...`).

**No Objective-C/Swift/header source ships with this Hutch release.** Listing the release tree's non-source files (`find ~/.hutch/releases/electrobun/2.0.1/macos-arm64 -maxdepth 2 -type f`) shows the macOS window/webview native layer is distributed only as compiled binaries — `libElectrobunCore.dylib`, `libNativeWrapper.dylib`, `libwebgpu_dawn.dylib`, `libasar.dylib`, plus helper executables (`launcher`, `process_helper`, `extractor`, `bsdiff`/`bspatch`). Any `NSDraggingDestination`/`registerForDraggedTypes:`/`performDragOperation:` implementation, if it exists, is inside these compiled dylibs, not in readable source — out of scope for a read-only source audit (and not disassembled, per the read-only rule).

### Step 2 — scripted event-name scan

Script (`spike-drop-events.ts`, written to a `mktemp -d "$TMPDIR/jslab-spike-XXXXXX"` folder, run against the sibling worktree root, then deleted) scans the four Main-process files for every dashed literal string and filters for `drop|drag|file`:

```
core/BrowserView.ts: 10 dashed names; drop-like: []
core/BrowserWindow.ts: 0 dashed names; drop-like: []
proc/native.ts: 17 dashed names; drop-like: []
events/eventEmitter.ts: 0 dashed names; drop-like: []
```

Zero drop-like event names in any of the four core Main-process files.

## Decision

**NO-GO**, because no Main-process API or event in Electrobun 2.0.1's readable source carries a dropped item's file system path: `BrowserView.on()`'s literal event union is limited to navigation/download lifecycle names, `BrowserWindow`/`native.ts` emit no drop/drag/file event (0 of 7 `emit()` call sites), and the only drop-adjacent code path (`externalDropFocus.ts` → `restoreWindowFocusAfterExternalDrop`) is a Windows-only webview `drop` listener whose Main-side RPC payload is `{ windowId: number }` — no path, and it exists solely to refocus the window. The native macOS drag/drop implementation, if any, is compiled into `libElectrobunCore.dylib`/`libNativeWrapper.dylib` with no accompanying Objective-C/Swift/header source in this Hutch release, so it cannot be confirmed to exist or to carry a path via a read-only source audit.

- GO → Task 24 Step 6 Branch A (native drop sets the WD; TF-11 gains file-backed drops).
- **NO-GO → Task 24 Step 6 Branch B** (WD by picker, chip and menu only; the folder-drop notice points at Actions → Set Working Directory…; TF-11 and spec §7.3/§12.2 record the deviation).

## Upstream

File-drop paths for `BrowserWindow`/`BrowserView` are an Electrobun feature request. JSLab revisits this when the pinned Electrobun changes. If Electrobun's native macOS layer already implements Cocoa drag/drop internally (plausible, since it isn't visible in source), it is not currently surfaced through any documented/typed Main-process API or event — so it is unusable from JSLab without an upstream change either way.

## Unverified / out of scope

- Whether `libElectrobunCore.dylib` / `libNativeWrapper.dylib` internally implement `NSDraggingDestination` (e.g. already call `registerForDraggedTypes:`/`performDragOperation:`) without exposing it to JS/Main could not be checked — that would require disassembling a compiled binary, which is outside the read-only source-audit scope of this spike.
- Windows and Linux native backends were not present as readable source in this Hutch release either (same devkit/`~/.hutch` search covered all platforms); only the shared `zig-sdk/electrobun.zig` file was found across the whole release tree.
