# JSLab M5c: the `jslab` command-line interface — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `jslab` command — a Bun-compiled single binary that opens files, stdin or code in JSLab tabs over the existing `jslab.sock` unix socket, plus the Help-menu item that installs and uninstalls it.

**Architecture:** Nothing new is built where something already exists. M2 already shipped the NDJSON unix-socket server (`apps/desktop/src/main/cli/socket-server.ts`, `ndjson.ts`, `socket-methods.ts`) for the E2E harness; M5c registers one more method, `open`, *before* the `e2eEnabled` early return in `createSocketMethods`, and lifts the server's own start out of `index.ts`'s `if (e2eEnabled)` block so it runs in every launch. `open` creates tabs through the one existing path — `SessionStore.createTab` — and announces them to the UI through the one existing push, `rpc.send["file.opened"]`, which `apps/ui/src/files/file-flows.ts`'s `handleOpened` already renders. `--run` reuses `rpc.send["menu.command"]({ command: "run.start" })`, the same channel the application menu uses. **The UI is not modified at all.** The binary itself is a small four-module program under `apps/desktop/src/cli/`, sharing its wire contract with Main through a new `packages/rpc-schema/src/cli.ts`.

**Tech Stack:** Bun 1.4.0 (bundled) / 1.3.13 (dev), Electrobun 2.0.1, zod 4.6.4, bun:test, Biome 2.5.13, TypeScript 7.0.2.

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md` — §16 (the CLI, in full), §18 (the "CLI socket" security row), §19 (nested-binary signing, M6's job), §10.1/§10.2 (tabs and file opening), §12.2 (working directory), §7.4 (menus), §22.3 (the "CLI open/run" E2E scenario), §24 (M5's scope line).

---

## Global Constraints

Exact values, copied verbatim from the spec. Every task's requirements implicitly include this section.

- **Install location (§16.1):** "A symlink to `JSLab.app/Contents/Resources/app/bin/jslab` (a Bun-compiled single binary) is created in `~/.local/bin`. If `~/.local/bin` isn't on `PATH`, the dialog shows the line to add to the shell profile."
- **All-users install (§16.1):** "**Install for all users** instead writes to `/usr/local/bin` via `osascript … with administrator privileges`."
- **Uninstall (§16.1):** "Uninstall uses the same menu, which becomes \"Uninstall `jslab` Command…\" when a symlink is detected."
- **Usage (§16.2), verbatim:**

  ```
  jslab [file ...]                 Open files in new tabs
  jslab -                          Read code from stdin into a new tab
  jslab --run [file|-]             Open and run immediately
        --runtime bun|browser|browser-node
        --lang ts|js|tsx|jsx       (default: from extension, else settings)
        --cwd <dir>                Set the tab's working directory (default for `-`: current dir)
        --title <title>
  jslab --version | --help
  ```

- **Transport (§16.3):** "a unix domain socket at `<appdata>/jslab.sock` (mode 0600), speaking newline-delimited JSON: `{ "v":1, "id":"…", "method":"open", "params":{ "files":[…], "code":"…", "run":false, "runtime":…, "lang":…, "cwd":…, "title":… } }`. The reply is `{ "id":"…", "ok":true, "tabIds":[…] }` or `{ "id":"…", "ok":false, "error":"…" }`."
- **Autolaunch (§16.3):** "**If the app isn't running**, the CLI runs `open -b dev.jslab.app`, polls for the socket for up to 10 s, then sends the request. It never relies on process arguments, which avoids Electrobun #540."
- **Absolute paths (§16.3):** "**Paths are made absolute by the CLI** before sending."
- **Execution gate (§16.3):** "**Code runs only when `--run` is passed.**"
- **E2E isolation (§16.3):** "**E2E automation** (`JSLAB_E2E=1` at app launch only) adds `e2e.*` methods on the same socket (§22.3). They are never available in normal launches."
- **Security (§18, "CLI socket" row):** "0600 permissions under the user's app data; `--run` required to execute code; `e2e.*` only with `JSLAB_E2E=1`."
- **Signing (§19):** "Nested binaries (the `jslab` CLI) are signed with the hardened runtime." — **M6 verifies this; M5c must not attempt signing.**
- **Clean room.** Never read RunJS binaries, `app.asar`, bundled JS, or `/Applications/RunJS.app`. Parity comes from the spec and public docs only.
- **No new runtime dependency.** M5c needs none: zod, Bun's `Bun.connect`/`Bun.listen` and `node:fs` cover everything.
- **Never contact the public npm registry in a test.** Loopback Verdaccio (`packages/test-registry`) only. No task here needs either.
- **No personal paths in any committed file** — nothing rooted at a home folder, a user name, or an external volume. Use `$HOME`, `~`, or a temp dir.
- **Privilege escalation is opt-in only.** No test, gate or default code path may cause an `osascript … with administrator privileges` prompt. See "The escalation ruling" below.
- **Commit hygiene:** one commit per task, staged explicitly, on branch `feat/jslab-m5c`. Never merge, push or force-push. Every commit message ends with `Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY`.

### Gates for every task

Run all four before committing:

```bash
bunx biome check . --max-diagnostics=300                                  # lint (default truncation hides findings)
mkdir -p apps/desktop/.hutch && cp -a "$JSLAB_DEVKIT_SOURCE" apps/desktop/.hutch/devkit && bun run typecheck
bun run test                                                              # dev Bun (1.3.13)
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test    # bundled Bun (1.4.0)
```

- **`$JSLAB_DEVKIT_SOURCE`** is the `apps/desktop/.hutch/devkit` folder of a checkout that has already run `hutch electrobun sync`. **`apps/desktop/.hutch` does not exist in a fresh worktree, so the `mkdir -p` is mandatory**: without the devkit, `bun run typecheck` exits 1 *without type-checking anything*, which reads exactly like a pass-then-fail and is not one.
- **Never run the Hutch installer, `hutch init` or `hutch upgrade`.** The 1.4.0 gate uses the absolute toolchain path above and nothing else.
- **The two-Bun gate is easy to fake.** `bun14 run test` uses 1.4.0 only as the task runner; each package's script is `bun test ./test`, so the inner binary still comes from `PATH`. The `PATH="…:$PATH" bun run test` form above is the real one.
- **UI tests need the DOM preload.** A bare `bun test <path>` skips it. Use `cd apps/ui && bun test ./test/<file>`. (M5c adds no UI test, but a task that touches `apps/ui` must obey this.)
- **`bun run e2e` does NOT build.** It drives whatever bundle is on disk, so a stale bundle gives fast, confident, wrong failures. Any e2e step builds first: `bun run build:cli && (cd apps/desktop && hutch run build:dev)`.
- **Never run a bare `bun test` at the repo root**; always `bun run test`.
- **Measure your own test baseline before changing anything and report `baseline N → after M`.** No absolute total appears in this plan on purpose: absolutes go stale, deltas do not. A test added to make a total match is a defect, not a fix.

---

## As-built survey: what already exists

Read this before Task 1. **The single biggest failure mode in M5c is rebuilding what M2 already shipped.**

### The socket server's real wire protocol

`apps/desktop/src/main/cli/ndjson.ts` owns the whole protocol, and it already matches §16.3:

```ts
export const MAX_SOCKET_PATH_BYTES = 103;                          // macOS sun_path, including the NUL

export const socketRequestSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(100),
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
});

export type SocketResponse =
  | ({ id: string | null; ok: true } & Record<string, unknown>)
  | { id: string | null; ok: false; error: string };

export type SocketMethod = (params: unknown) => Promise<Record<string, unknown>>;

export async function handleLine(line: string, methods: Record<string, SocketMethod>): Promise<SocketResponse>;
export function encodeLine(value: unknown): string;               // JSON + "\n"
export function assertSocketPath(path: string): void;
export class LineBuffer { constructor(maxLineChars?: number); push(chunk: string): string[] }
```

Three facts a `SocketMethod` author must know, all from `handleLine`:
1. **Dispatch is `Object.hasOwn(methods, method)`**, so a method name is a plain own key of the table.
2. **A handler's resolved object is spread first, then `id` and `ok`** — `return { ...result, id, ok: true }` — with the comment *"id and ok are written last so a result can never spoof them."* So `open` returning `{ tabIds }` produces exactly §16.3's `{ tabIds, id, ok: true }`, and `open` must never put `id` or `ok` in its own result.
3. **A thrown error becomes `{ id, ok: false, error: message }`.** `handleLine` never throws. A zod `parse` failure inside a method is therefore already the spec's error reply — no try/catch needed.

`apps/desktop/src/main/cli/socket-server.ts` provides:

```ts
export interface SocketServer { path: string; close(): void }
export async function startSocketServer(options: {
  path: string;
  methods: Record<string, SocketMethod>;
  log(message: string, detail?: unknown): void;
}): Promise<SocketServer>;
```

It creates the socket under a `0o177` umask, `chmod 0600`s it, refuses to steal a live socket (`throw new Error(\`Another JSLab instance is listening on ${path}\`)`), replaces a stale one, and queues replies until the socket drains. **Its doc comment already says: "M5's CLI reuses this server with an `open` method."** Nothing in this file changes.

### Where the e2e guard is today, and what "before the e2e guard" must mean

There are **two** guards, not one, and both have to move:

1. **`socket-methods.ts:34-36`** — the method table:

   ```ts
   export function createSocketMethods(deps: SocketMethodDeps): Record<string, SocketMethod> {
     const methods: Record<string, SocketMethod> = {};
     if (!deps.e2eEnabled) return methods;
     // …every e2e.* method…
   ```

   The file's own doc comment already states the intent: *"`e2e.*` exists only for `JSLAB_E2E=1` launches (spec §16.3, §18). **M5 adds the CLI's always-available `open` method before the e2e guard.**"* So `open` is registered on `methods` **above** the `if (!deps.e2eEnabled) return methods;` line, and the early return stays exactly as it is.

2. **`apps/desktop/src/main/index.ts:514-547`** — the server's own start:

   ```ts
   if (e2eEnabled) {
     socketServer = await startSocketServer({ path: paths.socketPath, log, methods: createSocketMethods({ … }) });
     logger.info(strings.log.e2eEnabled(socketServer.path));
   }
   ```

   **This is the substantive conflict between §16.3 and the code as built.** Registering `open` before the table's guard achieves nothing while the server itself only exists under `JSLAB_E2E=1`: in a normal launch there is no socket file at all, so the CLI has nothing to connect to. §16.3 requires the socket in every launch. Task 3 lifts this `if` — and must do so **without** letting the server's own failure modes take startup down: `startSocketServer` throws when another JSLab already owns the path, and that throw currently lands in `start()`, whose rejection reaches `errorPolicy.fail` and exits with code 1. Under E2E that never fired (each launch gets a private `JSLAB_USER_DATA`); with a shared `~/Library/Application Support/dev.jslab.app/<channel>` it fires the moment a user opens JSLab twice. **A second instance must lose the CLI socket, not fail to start.**

### How tabs are created programmatically

There is exactly one path, and `open` reuses it end to end:

```ts
// apps/desktop/src/main/services/session-store.ts
export interface CreateTabOptions {
  language?: Language; runtime?: Runtime; title?: string; titleIsCustom?: boolean;
  filePath?: string | null; lastSavedHash?: string | null; content?: string;
  activate?: boolean;                                        // defaults to true
}
async createTab(options: CreateTabOptions = {}): Promise<TabState>   // writes the buffer, inserts after the active tab, commits
findTabByPath(path: string): TabState | undefined
```

`CreateTabOptions` has **no `workingDirectory`**, even though `tabStateSchema` does (`packages/shared/src/session.ts`) and `createTab(overrides: Partial<TabState>)` would accept it. `--cwd` therefore needs one additive field on that interface (Task 2) — nothing else.

The reference caller is `apps/desktop/src/main/rpc/file-handlers.ts`'s `openReady`, which is precisely the behaviour `jslab <file>` needs:

```ts
const existing = deps.session.findTabByPath(path);
if (existing) { focusTabId = existing.id; continue; }          // §10.2: already open → focus it
const tab = await deps.session.createTab({
  filePath: path,
  language: languageForPath(path),
  lastSavedHash: contentHash(content),
  content,
});
tabs.push({ tab, content });
…
deps.send.opened({ tabs, focusTabId, ...extra });              // rpc.send["file.opened"](payload)
```

`file.opened` is a `ViewMessages` entry carrying `FileOpened = { tabs: TabWithContent[]; focusTabId: string | null; large: LargeFile[]; errors: string[] }`, and `apps/ui/src/files/file-flows.ts`'s `handleOpened` already opens each tab in the store, activates the last, and shows `errors` in the status bar. **`open` reuses this push verbatim, so the UI needs no change.** `ui-rpc.ts` notes that `ViewMessages` payloads "are built by Main itself and never re-enter it", so they carry no validators and a new `app.notice` id needs no schema change either.

`--run` likewise reuses an existing channel: `index.ts:459` sends `rpc.send["menu.command"]({ command, args })` for every application-menu click, and the UI's command registry executes `run.start` from it. `open` dispatches the same message rather than calling `RunCoordinator.start` directly — which also sidesteps an ordering hazard, since `file.opened` and `menu.command` travel the same ordered transport into `createViewMessageRouter`'s hub.

### How the app menu is built, and where a Help item registers

`apps/desktop/src/main/menu.ts`:

```ts
export interface MenuModel {
  settings: Settings; activeTab: TabState | null; bindings: readonly ResolvedBinding[];
  themes: readonly { id: string; name: string }[]; canReopen: boolean;
}
export function buildMenu(model: MenuModel): MenuItem[];
export function menuAction(command: CommandId, arg?: string): string;            // "command:<id>"
export function commandForMenuAction(action: string): { command: CommandId; args?: unknown } | null;
export function dispatchMenuAction(action: string | undefined, target: { … }): void;
export function createMenuController(deps: { build(): MenuItem[]; apply(menu: MenuItem[]): void; delayMs?: number });
```

The Help submenu is the last entry of `buildMenu`'s returned array:

```ts
{
  label: "Help",
  submenu: [item("help.copyDebugLog"), item("help.openLogsFolder"), separator, item("help.restartSafeMode")],
},
```

`item(command)` reads its title from `commandMeta(command)` in `packages/shared/src/commands.ts` and appends the effective shortcut. A Help action that needs Main goes: `CommandId` in `commands.ts` → UI command in `apps/ui/src/commands/app-commands.ts` (`{ id: "help.openLogsFolder", run: () => deps.api.appCommand("openLogsFolder") }`) → `APP_ACTIONS` in `packages/rpc-schema/src/ui-rpc.ts` → `runAppAction` in `apps/desktop/src/main/rpc/app-handlers.ts` → an `AppHandlerDeps` callback wired in `index.ts`. That is the whole chain, and Task 7 walks it.

`createMenuController` de-duplicates by serialising the built menu, so a label that must flip (Install ↔ Uninstall) only needs `menu.refresh()` after the underlying state changes.

### How the build is configured, and where a second binary slots in

- `apps/desktop/electrobun.config.ts` — `build.copy` maps a **project-relative source** to a destination under `Resources/app`. `"dist/runner": "runner"` is why `resolveAppPaths` computes `join(resourcesFolder, "app", "runner", "bootstrap.js")`. A `"dist/bin": "bin"` rule therefore lands the binary at exactly §16.1's `JSLab.app/Contents/Resources/app/bin/jslab`. The config's own comment and `apps/desktop/test/build-wiring.test.ts` both pin the rule that a `copy` key must be project-relative with no `.`/`..` components.
- `apps/desktop/hutch.config.ts` — `build:bundles` is a `&&`-joined shell string run **inside Hutch's Cottontail shell**, where `bun` is Cottontail's pinned 0.5.0 runtime, not real Bun. Its own comments record that Cottontail's `build` command **rejects flags it does not know** (`--format` fails the whole build with "unsupported cottontail build option") and that `bunx` is the one real-Bun escape hatch. **`bun build --compile` inside `build:bundles` is therefore an unforced risk**, and `bunx` cannot invoke real Bun's bundler without pulling a `bun` package off the public registry, which the constraints forbid. Task 6 compiles the binary from a **root `package.json` script running under real Bun**, stages it at `apps/desktop/dist/bin/jslab`, and leaves `build:bundles` with only a fail-loud existence guard. `build:bundles` already stages a file this way (`cp ../../THIRD-PARTY-NOTICES.md dist/THIRD-PARTY-NOTICES.md`), so the pattern is established.
- `apps/desktop/tsconfig.json` is `"include": ["src", "test", "scripts"]`, so `src/cli/**` is type-checked with no config change.
- `apps/desktop/test/shell.test.ts` asserts `resolveAppPaths(...)` with `toEqual` against a **complete object**, so adding one `AppPaths` field fails that test until it is updated. That is expected and is part of Task 6.

### `--runtime` must accept all three runtimes — confirmed

```ts
// packages/shared/src/settings.ts
export const RUNTIMES = ["browser-node", "bun", "browser"] as const;
/** Runtimes that can execute code in this build. M4 (Task 9) turns on "browser-node" and "browser" alongside "bun". */
export const AVAILABLE_RUNTIMES: readonly Runtime[] = ["bun", "browser-node", "browser"];
```

**Yes — `--runtime` accepts `bun`, `browser` and `browser-node`, and all three must actually work.** `AVAILABLE_RUNTIMES` holds all three since M4 Task 9; `isRuntimeAvailable` returns true for each; `effectiveRuntime` no longer collapses anything to `bun`; and `apps/desktop/src/main/rpc-handlers.ts`'s `run.start` already starts a tab on its own runtime. This matches §16.2's `--runtime bun|browser|browser-node` exactly, so the CLI validates against `RUNTIMES` and does **not** narrow the set. A plan or test asserting "browser runtimes are rejected" would be re-introducing a pre-M4 assumption.

### Parity rows that belong to M5c

M5's whole row set is EX-14..16, EX-37, ED-20, OU-10, ST-08, ST-12, TL-12..23, XT-01..04, XT-08. Checked against `docs/parity.md` line by line — **exactly one of them is a CLI row:**

| Row | Text as it stands | Owner |
|---|---|---|
| **XT-03** | `` | XT-03 | `jslab` CLI (open, stdin, `--run`, `--runtime`, `--cwd`) | #23, #747, #594 | §16 | M5 | E | ⬜ | `` (`docs/parity.md:228`) | **M5c** |

Every other M5 row belongs elsewhere: EX-14..16 logpoints, EX-37 Show Transpiled Output, ED-20 the editor context menu, OU-10 the output entry menu, ST-08 i18n, ST-12 the welcome tab, TL-12..17 snippets, TL-18..23 AI chat, XT-01 the theme importer, XT-02 the keybindings UI, XT-04 Gist, XT-08 Keychain. A grep for `cli|stdin|command line|symlink|terminal` across the whole file returns XT-03 plus PL-04 (the Homebrew cask, M6) and nothing else. **M5c flips XT-03 and touches no other row.**

XT-03's Verify column is **E**, so an end-to-end scenario is required — a unit test alone cannot close it. Its parenthetical lists `open, stdin, --run, --runtime, --cwd`; §16.2 also specifies `--lang` and `--title`, and M5c implements all seven.

### The escalation ruling (decided here, deliberately, not silently)

§16.1 offers `~/.local/bin` **or** `/usr/local/bin` via `osascript … with administrator privileges`. Privilege escalation is a real user-safety surface: an admin prompt raised by a scratchpad app teaches users to approve admin prompts, and a bug behind one writes as root. This plan therefore builds it as:

1. **The default is `~/.local/bin`, with no escalation of any kind.** Help → Install `jslab` Command… takes this path. `installCli` is reachable with `scope: "user"` and no `escalate` dependency at all, and that is the only shape `index.ts` wires by default.
2. **`/usr/local/bin` is an explicit opt-in the user chooses.** It is a separate `scope: "allUsers"` argument that only ever originates from a deliberate user choice, never from a default, a fallback, or a retry after a failure. `installCli` with `scope: "allUsers"` and no `escalate` dependency **throws** rather than silently downgrading or silently escalating.
3. **A `PATH` without `~/.local/bin` produces an actionable message, never a silent failure.** `installCli` returns `{ ok, linkPath, onPath, message }`; when `onPath` is false the message names the directory and gives the exact line to paste, per §16.1's "the dialog shows the line to add to the shell profile". The install still succeeded — the message explains why the command is not yet found.
4. **No test step may trigger an administrator prompt.** Every install test runs against a temp directory passed as `home`, uses the real `node:fs` adapter, and never supplies `escalate`. One test asserts that `scope: "allUsers"` without an escalation dependency throws — which is also the proof that no test path can reach `osascript`.

---

## File Structure

**New**

| Path | Responsibility |
|---|---|
| `packages/rpc-schema/src/cli.ts` | The `open` wire contract: `cliOpenParamsSchema`, `CliOpenParams`, `CliOpenResult`, `CLI_LANG_ALIASES`. One definition shared by Main and the binary. |
| `apps/desktop/src/main/cli/open-service.ts` | Turns validated `open` params into tabs via `SessionStore.createTab`, announces them with `file.opened`, and asks for the run. |
| `apps/desktop/src/main/cli/ui-dispatch.ts` | Queues a UI command issued while the window is closed or still booting, and flushes it on the next heartbeat. |
| `apps/desktop/src/main/cli/install.ts` | Symlink install/uninstall/status, `PATH` checking, and the actionable messages. Pure over an injected fs + home + PATH. |
| `apps/desktop/src/cli/args.ts` | `parseArgs` for the §16.2 grammar. Pure. |
| `apps/desktop/src/cli/socket-path.ts` | Candidate `jslab.sock` paths (overrides first, then channels), each within `MAX_SOCKET_PATH_BYTES`. Pure. |
| `apps/desktop/src/cli/client.ts` | Connect, `open -b dev.jslab.app`, poll for up to 10 s, call, close. Pure over an injected transport, plus the real Bun transport. |
| `apps/desktop/src/cli/main.ts` | The compiled entry: argv → absolute paths → stdin → one `open` call → exit code. |
| `packages/rpc-schema/test/cli.test.ts` | Wire-contract tests. |
| `apps/desktop/test/cli/open-service.test.ts` | Tab creation, focus-existing, errors, `--run`. |
| `apps/desktop/test/cli/ui-dispatch.test.ts` | Queue and flush. |
| `apps/desktop/test/cli/install.test.ts` | Symlink logic against a temp dir. **Never escalates.** |
| `apps/desktop/test/cli/args.test.ts` | The §16.2 grammar. |
| `apps/desktop/test/cli/socket-path.test.ts` | Override precedence and the 103-byte bound. |
| `apps/desktop/test/cli/client.test.ts` | Connect / launch / poll / timeout, against a fake transport. |
| `packages/e2e/scenarios/cli.test.ts` | XT-03: the real binary against a real app. |
| `docs/qa/m5c-checklist.md` | The manual items automation must not perform (a real `~/.local/bin` install, the PATH message, the all-users opt-in). |

**Modified**

| Path | Change |
|---|---|
| `packages/rpc-schema/src/index.ts` | `export * from "./cli";` |
| `apps/desktop/src/main/cli/socket-methods.ts` | `open` registered **before** the `e2eEnabled` early return; `SocketMethodDeps.open` added. |
| `apps/desktop/src/main/services/session-store.ts` | `CreateTabOptions` gains `workingDirectory?: string \| null`. |
| `apps/desktop/src/main/index.ts` | Socket server starts in every launch, failing soft; `open` wired to the open service; the UI dispatch queue flushed on heartbeat; install/uninstall wired into `AppHandlerDeps`; `cliInstalled` fed to the menu. |
| `apps/desktop/src/main/strings.ts` | `log.cliSocket`, `log.cliSocketFailed`, and the `cli` message block. |
| `apps/desktop/src/main/app-paths.ts` | `AppPaths.cliBinary`. |
| `apps/desktop/src/main/menu.ts` | `MenuModel.cliInstalled`; the Help submenu's install/uninstall slot. |
| `packages/shared/src/commands.ts` | `help.installCli`, `help.uninstallCli`. |
| `packages/rpc-schema/src/ui-rpc.ts` | `APP_ACTIONS` gains `installCli`, `uninstallCli`. |
| `apps/desktop/src/main/rpc/app-handlers.ts` | `AppHandlerDeps.installCli` / `.uninstallCli`; two `runAppAction` cases. |
| `apps/ui/src/commands/app-commands.ts` | Two command registrations forwarding to `api.appCommand`. |
| `apps/desktop/electrobun.config.ts` | `"dist/bin": "bin"`. |
| `apps/desktop/hutch.config.ts` | `build:bundles` gains the fail-loud `dist/bin/jslab` guard. |
| `package.json` (root) | `build:cli` script. |
| `apps/desktop/test/shell.test.ts`, `apps/desktop/test/build-wiring.test.ts`, `apps/desktop/test/cli/e2e-bridge.test.ts`, `apps/desktop/test/menu.test.ts`, `apps/desktop/test/rpc/app-handlers.test.ts` | Existing assertions extended for the new field, rule, method, menu item and actions. |
| `docs/parity.md`, `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, `README.md` | XT-03 and the CLI's documentation. |

---

## Task index

| # | Task | Deliverable |
|---|---|---|
| 1 | The `open` wire contract | `packages/rpc-schema/src/cli.ts`, validated both ways, shared by Main and the binary. |
| 2 | The open service | `open` params → real tabs through `SessionStore.createTab`, unit-tested headless. |
| 3 | `open` on the socket, in every launch | Registered before the e2e guard; the server starts outside `if (e2eEnabled)` and fails soft. |
| 4 | CLI argument parsing | `parseArgs` over the §16.2 grammar, including `--help` and `--version`. |
| 5 | Socket discovery and the client | Candidate paths, connect, `open -b`, the 10 s poll, the call. |
| 6 | The binary and its build wiring | `src/cli/main.ts`, `build:cli`, the copy rule, `AppPaths.cliBinary`. |
| 7 | Install, uninstall and the Help item | `~/.local/bin` by default, `/usr/local/bin` opt-in, the actionable PATH message, the flipping menu label. |
| 8 | E2E, parity and docs | The XT-03 scenario against the real binary, then parity, README, roadmap and the QA checklist. |

Tasks 1–3 make `open` work over the socket (testable with a raw socket client the moment Task 3 lands). Tasks 4–6 produce the binary. Task 7 is the install surface. Task 8 proves and documents it.

---

### Task 1: The `open` wire contract

**Files:**
- Create: `packages/rpc-schema/src/cli.ts`
- Modify: `packages/rpc-schema/src/index.ts`
- Test: `packages/rpc-schema/test/cli.test.ts`

**Interfaces:**
- Consumes: `LANGUAGES`, `RUNTIMES`, `Language`, `Runtime` from `packages/shared/src/settings.ts`; `MAX_TEXT_CHARS` from `packages/rpc-schema/src/ui-rpc.ts` (the existing single cap for a tab's whole text at the RPC boundary).
- Produces:
  - `cliOpenParamsSchema: z.ZodType<CliOpenParams>`
  - `type CliOpenParams = { files?: string[]; code?: string; run?: boolean; runtime?: Runtime; lang?: Language; cwd?: string; title?: string }`
  - `interface CliOpenResult { tabIds: string[] }`
  - `const CLI_LANG_ALIASES: Record<"ts" | "js" | "tsx" | "jsx", Language>`
  - `const MAX_CLI_FILES = 50`, `const MAX_CLI_PATH_CHARS = 4096`

  Task 2 consumes `CliOpenParams`/`CliOpenResult`; Task 3 calls `cliOpenParamsSchema.parse`; Tasks 4 and 6 build a `CliOpenParams` and map `--lang` through `CLI_LANG_ALIASES`.

- [ ] **Step 1: Write the failing tests**

Create `packages/rpc-schema/test/cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { CLI_LANG_ALIASES, cliOpenParamsSchema, MAX_CLI_FILES, MAX_TEXT_CHARS } from "../src";

describe("cliOpenParamsSchema", () => {
  test("accepts the full §16.2 parameter set", () => {
    expect(
      cliOpenParamsSchema.parse({
        files: ["/tmp/a.ts", "/tmp/b.tsx"],
        run: true,
        runtime: "browser-node",
        lang: "tsx",
        cwd: "/tmp/project",
        title: "scratch",
      }),
    ).toEqual({
      files: ["/tmp/a.ts", "/tmp/b.tsx"],
      run: true,
      runtime: "browser-node",
      lang: "tsx",
      cwd: "/tmp/project",
      title: "scratch",
    });
  });

  test("accepts stdin code with no files", () => {
    expect(cliOpenParamsSchema.parse({ code: "1 + 1" }).code).toBe("1 + 1");
  });

  test("accepts every runtime the build offers, including both browser runtimes", () => {
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      expect(cliOpenParamsSchema.parse({ code: "1", runtime }).runtime).toBe(runtime);
    }
  });

  test("rejects a request that names neither a file nor code", () => {
    expect(() => cliOpenParamsSchema.parse({ run: true })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ files: [] })).toThrow();
  });

  test("rejects relative paths: the CLI makes them absolute before sending (§16.3)", () => {
    expect(() => cliOpenParamsSchema.parse({ files: ["a.ts"] })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ code: "1", cwd: "project" })).toThrow();
  });

  test("bounds the request so a hostile client can't exhaust Main", () => {
    expect(() => cliOpenParamsSchema.parse({ files: Array.from({ length: MAX_CLI_FILES + 1 }, () => "/tmp/a.ts") })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ code: "x".repeat(MAX_TEXT_CHARS + 1) })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ code: "1", runtime: "deno" })).toThrow();
    expect(() => cliOpenParamsSchema.parse({ code: "1", lang: "ts" })).toThrow();
  });

  test("CLI_LANG_ALIASES maps the §16.2 spellings onto the internal languages", () => {
    expect(CLI_LANG_ALIASES).toEqual({ ts: "typescript", js: "javascript", tsx: "tsx", jsx: "jsx" });
  });
});
```

The last two assertions are the point of the alias table: §16.2's flag takes `ts|js|tsx|jsx`, while the wire and `TabState.language` take `typescript|javascript|tsx|jsx`. The **binary** translates; the wire never accepts the short spelling.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/rpc-schema && bun test ./test/cli.test.ts`
Expected: FAIL — `Export named 'cliOpenParamsSchema' not found in module`.

- [ ] **Step 3: Write the contract**

Create `packages/rpc-schema/src/cli.ts`:

```ts
import { LANGUAGES, RUNTIMES } from "@jslab/shared";
import { z } from "zod";
import { MAX_TEXT_CHARS } from "./ui-rpc";

/** Spec §16.2 takes `ts|js|tsx|jsx`; the wire and `TabState.language` take the full names. The CLI translates. */
export const CLI_LANG_ALIASES = { ts: "typescript", js: "javascript", tsx: "tsx", jsx: "jsx" } as const satisfies Record<
  string,
  (typeof LANGUAGES)[number]
>;

/** One `jslab` invocation opens at most this many files, and each path is bounded like every other path on the wire. */
export const MAX_CLI_FILES = 50;
export const MAX_CLI_PATH_CHARS = 4096;

const absolute = z.string().min(1).max(MAX_CLI_PATH_CHARS).startsWith("/", "must be an absolute path");

/**
 * `open`'s params (spec §16.3). The socket is 0600 under the user's own app data, so this validates shape and
 * bounds rather than trust: a malformed request must become one error reply, never a Main-side throw.
 *
 * `runtime` accepts all three runtimes on purpose (§16.2 `--runtime bun|browser|browser-node`); every one of them
 * is in `AVAILABLE_RUNTIMES` since M4 Task 9, so none of them is narrowed here.
 */
export const cliOpenParamsSchema = z
  .object({
    files: z.array(absolute).max(MAX_CLI_FILES).optional(),
    code: z.string().max(MAX_TEXT_CHARS).optional(),
    run: z.boolean().optional(),
    runtime: z.enum(RUNTIMES).optional(),
    lang: z.enum(LANGUAGES).optional(),
    cwd: absolute.optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .refine((params) => (params.files?.length ?? 0) > 0 || params.code !== undefined, {
    message: "open needs at least one file, or code from stdin",
  });

export type CliOpenParams = z.infer<typeof cliOpenParamsSchema>;

/** Spec §16.3's success reply, minus the `id`/`ok` envelope `handleLine` adds. */
export interface CliOpenResult {
  tabIds: string[];
}
```

Add to `packages/rpc-schema/src/index.ts`, keeping the list alphabetical:

```ts
export * from "./cli";
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd packages/rpc-schema && bun test ./test/cli.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Run the gates and commit**

```bash
bunx biome check . --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add packages/rpc-schema/src/cli.ts packages/rpc-schema/src/index.ts packages/rpc-schema/test/cli.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): define the jslab open wire contract

Spec §16.3's open params and reply, shared by Main and the compiled
binary so one definition validates both ends. --runtime takes all three
runtimes, matching AVAILABLE_RUNTIMES since M4 Task 9.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 2: The open service

**Files:**
- Create: `apps/desktop/src/main/cli/open-service.ts`
- Modify: `apps/desktop/src/main/services/session-store.ts` (`CreateTabOptions`)
- Test: `apps/desktop/test/cli/open-service.test.ts`

**Interfaces:**
- Consumes: `CliOpenParams`, `CliOpenResult` (Task 1); `SessionStore.createTab`, `SessionStore.findTabByPath`; `FileOpened`, `TabWithContent` from `@jslab/rpc-schema`; `languageForPath`, `contentHash` from `@jslab/shared`; `Log` from `apps/desktop/src/main/rpc/validate.ts`.
- Produces:

  ```ts
  export interface OpenServiceDeps {
    session: Pick<SessionStore, "createTab" | "findTabByPath">;
    readFile(path: string): Promise<string>;
    defaults(): { language: Language; runtime: Runtime };
    announce(payload: FileOpened): void;
    present(options: { run: boolean }): void;
    log: Log;
  }
  export function createOpenService(deps: OpenServiceDeps): (params: CliOpenParams) => Promise<CliOpenResult>;
  ```

  Task 3 registers the returned function as the socket's `open` handler and wires every dep in `index.ts`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/test/cli/open-service.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { FileOpened } from "@jslab/rpc-schema";
import { createTab } from "@jslab/shared";
import { createOpenService, type OpenServiceDeps } from "../../src/main/cli/open-service";

function setup(files: Record<string, string> = {}, open: Record<string, string> = {}) {
  const announced: FileOpened[] = [];
  const presented: { run: boolean }[] = [];
  let next = 0;
  const deps = {
    session: {
      createTab: mock(async (options: Record<string, unknown>) => createTab({ id: `t${++next}`, ...options })),
      findTabByPath: mock((path: string) => (open[path] ? createTab({ id: open[path], filePath: path }) : undefined)),
    },
    readFile: mock(async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    }),
    defaults: () => ({ language: "typescript" as const, runtime: "bun" as const }),
    announce: (payload: FileOpened) => announced.push(payload),
    present: (options: { run: boolean }) => presented.push(options),
    log: mock(() => {}),
  } satisfies OpenServiceDeps;
  return { deps, announced, presented, open: createOpenService(deps) };
}

describe("the CLI open service", () => {
  test("opens each file in a tab, with the language from its extension", async () => {
    const { deps, announced, open } = setup({ "/w/a.ts": "const a = 1", "/w/b.jsx": "<b/>" });
    expect(await open({ files: ["/w/a.ts", "/w/b.jsx"] })).toEqual({ tabIds: ["t1", "t2"] });
    expect(deps.session.createTab.mock.calls.map(([options]) => options)).toEqual([
      { filePath: "/w/a.ts", language: "typescript", content: "const a = 1", lastSavedHash: expect.any(String), workingDirectory: null },
      { filePath: "/w/b.jsx", language: "jsx", content: "<b/>", lastSavedHash: expect.any(String), workingDirectory: null },
    ]);
    expect(announced).toHaveLength(1);
    expect(announced[0]?.tabs.map((entry) => entry.tab.id)).toEqual(["t1", "t2"]);
    expect(announced[0]).toMatchObject({ focusTabId: null, large: [], errors: [] });
  });

  test("focuses a file that is already open instead of opening it twice (§10.2)", async () => {
    const { deps, announced, open } = setup({ "/w/a.ts": "x" }, { "/w/a.ts": "already" });
    expect(await open({ files: ["/w/a.ts"] })).toEqual({ tabIds: ["already"] });
    expect(deps.session.createTab).not.toHaveBeenCalled();
    expect(announced[0]?.focusTabId).toBe("already");
  });

  test("stdin code becomes one tab, taking the language and runtime from settings unless overridden", async () => {
    const { deps, open } = setup();
    expect(await open({ code: "1 + 1" })).toEqual({ tabIds: ["t1"] });
    expect(deps.session.createTab).toHaveBeenCalledWith({
      language: "typescript",
      runtime: "bun",
      content: "1 + 1",
      workingDirectory: null,
    });
  });

  test("--runtime, --lang, --cwd and --title reach the created tab, for every runtime", async () => {
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      const { deps, open } = setup();
      await open({ code: "1", runtime, lang: "jsx", cwd: "/w/project", title: "scratch" });
      expect(deps.session.createTab).toHaveBeenCalledWith({
        language: "jsx",
        runtime,
        content: "1",
        workingDirectory: "/w/project",
        title: "scratch",
        titleIsCustom: true,
      });
    }
  });

  test("--lang overrides the extension for a file, and --cwd applies to it too", async () => {
    const { deps, open } = setup({ "/w/a.txt": "x" });
    await open({ files: ["/w/a.txt"], lang: "javascript", cwd: "/w/project" });
    expect(deps.session.createTab).toHaveBeenCalledWith({
      filePath: "/w/a.txt",
      language: "javascript",
      content: "x",
      lastSavedHash: expect.any(String),
      workingDirectory: "/w/project",
    });
  });

  test("an unreadable file is reported but never stops the others", async () => {
    const { announced, open } = setup({ "/w/a.ts": "x" });
    expect(await open({ files: ["/w/missing.ts", "/w/a.ts"] })).toEqual({ tabIds: ["t1"] });
    expect(announced[0]?.errors).toEqual(["/w/missing.ts couldn't be read."]);
  });

  test("a request whose every file failed becomes an error reply, not a silent success", async () => {
    const { open } = setup();
    await expect(open({ files: ["/w/missing.ts"] })).rejects.toThrow("/w/missing.ts couldn't be read.");
  });

  test("code runs only when run is passed (§16.3)", async () => {
    const quiet = setup({ "/w/a.ts": "x" });
    await quiet.open({ files: ["/w/a.ts"] });
    expect(quiet.presented).toEqual([{ run: false }]);

    const loud = setup({ "/w/a.ts": "x" });
    await loud.open({ files: ["/w/a.ts"], run: true });
    expect(loud.presented).toEqual([{ run: true }]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/cli/open-service.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/cli/open-service'`.

- [ ] **Step 3: Add `workingDirectory` to `CreateTabOptions`**

In `apps/desktop/src/main/services/session-store.ts`, extend the existing interface (one field; `createTab` already spreads its defined fields into `@jslab/shared`'s `createTab`, whose `tabStateSchema` has carried `workingDirectory` since M3):

```ts
export interface CreateTabOptions {
  language?: Language;
  runtime?: Runtime;
  title?: string;
  titleIsCustom?: boolean;
  filePath?: string | null;
  lastSavedHash?: string | null;
  content?: string;
  /** Spec §12.2, reachable from the CLI's `--cwd` (spec §16.2). */
  workingDirectory?: string | null;
  /** Defaults to true. */
  activate?: boolean;
}
```

- [ ] **Step 4: Write the service**

Create `apps/desktop/src/main/cli/open-service.ts`:

```ts
import type { CliOpenParams, CliOpenResult, FileOpened, TabWithContent } from "@jslab/rpc-schema";
import { contentHash, type Language, languageForPath, type Runtime } from "@jslab/shared";
import type { Log } from "../rpc/validate";
import type { SessionStore } from "../services/session-store";

export interface OpenServiceDeps {
  session: Pick<SessionStore, "createTab" | "findTabByPath">;
  readFile(path: string): Promise<string>;
  /** `run.defaultLanguage` / `run.defaultRuntime` at the moment of the call (spec §8, §16.2). */
  defaults(): { language: Language; runtime: Runtime };
  /** The existing `file.opened` push; the UI's `handleOpened` already renders it. */
  announce(payload: FileOpened): void;
  /** Focus (or reopen) the window, then run the now-active tab when `--run` was passed. */
  present(options: { run: boolean }): void;
  log: Log;
}

/**
 * `open` (spec §16.3). Every tab comes from `SessionStore.createTab` and every announcement from `file.opened`, so a
 * CLI-opened tab is indistinguishable from one opened through File → Open. A file already open is focused rather than
 * opened twice (§10.2), and a file that can't be read is reported alongside the ones that worked.
 */
export function createOpenService(deps: OpenServiceDeps): (params: CliOpenParams) => Promise<CliOpenResult> {
  return async (params) => {
    const workingDirectory = params.cwd ?? null;
    const titleFields = params.title === undefined ? {} : { title: params.title, titleIsCustom: true };
    const tabIds: string[] = [];
    const tabs: TabWithContent[] = [];
    const errors: string[] = [];
    let focusTabId: string | null = null;

    for (const path of params.files ?? []) {
      const existing = deps.session.findTabByPath(path);
      if (existing) {
        focusTabId = existing.id;
        tabIds.push(existing.id);
        continue;
      }
      let content: string;
      try {
        content = await deps.readFile(path);
      } catch (error) {
        deps.log("The jslab CLI couldn't read a file", { path, error: String(error) });
        errors.push(`${path} couldn't be read.`);
        continue;
      }
      const tab = await deps.session.createTab({
        filePath: path,
        language: params.lang ?? languageForPath(path),
        content,
        lastSavedHash: contentHash(content),
        workingDirectory,
        ...(params.runtime === undefined ? {} : { runtime: params.runtime }),
        ...titleFields,
      });
      tabIds.push(tab.id);
      tabs.push({ tab, content });
    }

    if (params.code !== undefined) {
      const defaults = deps.defaults();
      const tab = await deps.session.createTab({
        language: params.lang ?? defaults.language,
        runtime: params.runtime ?? defaults.runtime,
        content: params.code,
        workingDirectory,
        ...titleFields,
      });
      tabIds.push(tab.id);
      tabs.push({ tab, content: params.code });
    }

    // Nothing opened and something was asked for: that is a failed request, and `handleLine` turns this throw into
    // the spec's `{ id, ok: false, error }` reply rather than a success with an empty list.
    if (tabIds.length === 0) throw new Error(errors.join(" · ") || "Nothing to open");

    deps.announce({ tabs, focusTabId, large: [], errors });
    deps.present({ run: params.run === true });
    return { tabIds };
  };
}
```

Note the `runtime` spread on the file branch: a file with no `--runtime` keeps `SessionStore`'s own `tabDefaults()`, exactly as File → Open does; `--runtime` overrides it. The stdin branch has no defaults to inherit from a path, so it reads settings directly.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd apps/desktop && bun test ./test/cli/open-service.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the gates and commit**

```bash
bunx biome check . --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add apps/desktop/src/main/cli/open-service.ts apps/desktop/src/main/services/session-store.ts apps/desktop/test/cli/open-service.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): turn open requests into tabs through the existing session path

createTab and the file.opened push are reused verbatim, so a CLI-opened
tab is identical to one from File -> Open. CreateTabOptions gains
workingDirectory for --cwd (spec §12.2, §16.2).

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 3: `open` on the socket, in every launch

**Files:**
- Create: `apps/desktop/src/main/cli/ui-dispatch.ts`
- Modify: `apps/desktop/src/main/cli/socket-methods.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/strings.ts`
- Test: `apps/desktop/test/cli/ui-dispatch.test.ts`, `apps/desktop/test/cli/e2e-bridge.test.ts` (the existing method-table assertions)

**Interfaces:**
- Consumes: `createOpenService` (Task 2); `cliOpenParamsSchema`, `CliOpenParams`, `CliOpenResult` (Task 1); `startSocketServer`, `SocketMethod` (as built); `CommandId` from `@jslab/shared`.
- Produces:
  - `SocketMethodDeps.open(params: CliOpenParams): Promise<CliOpenResult>` — required in every launch.
  - ```ts
    export interface UiDispatch {
      dispatch(command: CommandId, args?: unknown): void;
      markReady(): void;
      markClosed(): void;
    }
    export function createUiDispatch(deps: {
      isOpen(): boolean;
      open(): void;
      send(message: { command: CommandId; args?: unknown }): void;
      maxPending?: number;
    }): UiDispatch;
    ```
    Task 7 reuses nothing from this; Task 8's scenario exercises it through `--run`.

- [ ] **Step 1: Write the failing `ui-dispatch` tests**

Create `apps/desktop/test/cli/ui-dispatch.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { CommandId } from "@jslab/shared";
import { createUiDispatch } from "../../src/main/cli/ui-dispatch";

function setup(startOpen: boolean) {
  const sent: { command: CommandId; args?: unknown }[] = [];
  let opened = startOpen;
  let openCalls = 0;
  const dispatch = createUiDispatch({
    isOpen: () => opened,
    open: () => {
      opened = true;
      openCalls += 1;
    },
    send: (message) => sent.push(message),
  });
  return { dispatch, sent, openCalls: () => openCalls, close: () => (opened = false) };
}

describe("createUiDispatch", () => {
  test("holds a command until the view reports ready, then sends it once", () => {
    const { dispatch, sent } = setup(true);
    dispatch.dispatch("run.start");
    expect(sent).toEqual([]);
    dispatch.markReady();
    expect(sent).toEqual([{ command: "run.start" }]);
    dispatch.markReady();
    expect(sent).toEqual([{ command: "run.start" }]);
  });

  test("sends straight through once the view is ready", () => {
    const { dispatch, sent } = setup(true);
    dispatch.markReady();
    dispatch.dispatch("run.start");
    expect(sent).toEqual([{ command: "run.start" }]);
  });

  test("reopens a closed window and delivers the command after it boots", () => {
    const { dispatch, sent, openCalls } = setup(false);
    dispatch.dispatch("run.start");
    expect(openCalls()).toBe(1);
    expect(sent).toEqual([]);
    dispatch.markReady();
    expect(sent).toEqual([{ command: "run.start" }]);
  });

  test("a closing window stops the ready state, so the next command queues again", () => {
    const { dispatch, sent, close } = setup(true);
    dispatch.markReady();
    close();
    dispatch.markClosed();
    dispatch.dispatch("run.start");
    expect(sent).toEqual([]);
    dispatch.markReady();
    expect(sent).toEqual([{ command: "run.start" }]);
  });

  test("the queue is bounded, so a window that never boots can't grow it without limit", () => {
    const sent: { command: CommandId }[] = [];
    const dispatch = createUiDispatch({ isOpen: () => true, open: () => {}, send: (m) => sent.push(m), maxPending: 2 });
    for (let index = 0; index < 5; index++) dispatch.dispatch("run.start");
    dispatch.markReady();
    expect(sent).toHaveLength(2);
  });

  test("carries args when a command has them", () => {
    const { dispatch, sent } = setup(true);
    dispatch.markReady();
    dispatch.dispatch("theme.select", { themeId: "nord" });
    expect(sent).toEqual([{ command: "theme.select", args: { themeId: "nord" } }]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/cli/ui-dispatch.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/cli/ui-dispatch'`.

- [ ] **Step 3: Write `ui-dispatch.ts`**

```ts
import type { CommandId } from "@jslab/shared";

export interface UiDispatch {
  /** Sends a UI command now if the view can receive it, otherwise queues it and opens the window. */
  dispatch(command: CommandId, args?: unknown): void;
  /** Called on every UI heartbeat: the first one after a (re)open means the view can receive commands. */
  markReady(): void;
  /** Called when the main window closes: whatever loads next has to report ready again. */
  markClosed(): void;
}

/**
 * `dispatchMenuAction` (menu.ts) drops a menu command issued while the window is closed, because the user can just
 * click again. A CLI command has no one to click again, so it waits here instead — bounded, so a view that never
 * boots can't grow the queue.
 */
export function createUiDispatch(deps: {
  isOpen(): boolean;
  open(): void;
  send(message: { command: CommandId; args?: unknown }): void;
  maxPending?: number;
}): UiDispatch {
  const maxPending = deps.maxPending ?? 20;
  let pending: { command: CommandId; args?: unknown }[] = [];
  let ready = false;

  return {
    dispatch(command, args) {
      const message = args === undefined ? { command } : { command, args };
      if (ready && deps.isOpen()) {
        deps.send(message);
        return;
      }
      if (pending.length < maxPending) pending.push(message);
      if (!deps.isOpen()) deps.open();
    },
    markReady() {
      ready = true;
      const queued = pending;
      pending = [];
      for (const message of queued) deps.send(message);
    },
    markClosed() {
      ready = false;
    },
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/desktop && bun test ./test/cli/ui-dispatch.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing method-table tests**

In `apps/desktop/test/cli/e2e-bridge.test.ts`, add `open` to the `deps` helper and replace the first `createSocketMethods` test:

```ts
  const deps = (e2eEnabled: boolean) => ({
    e2eEnabled,
    open: mock(async (params: unknown) => ({ tabIds: ["t1"], params })),
    bridge: { request: mock(async (method: string, params: unknown) => ({ method, params })) },
    mainState: () => ({ windowOpen: true }),
    screenshot: mock(async (name: string, _window?: string) => ({ path: `/shots/${name}.png` })),
    quit: mock(() => {}),
    uiAvailable: () => true,
    reopenWindow: mock(() => {}),
  });

  test("open is always available; e2e methods need JSLAB_E2E=1", () => {
    expect(Object.keys(createSocketMethods(deps(false)))).toEqual(["open"]);
    expect(Object.keys(createSocketMethods(deps(true))).sort()).toEqual([
      "e2e.command",
      "e2e.key",
      "e2e.output",
      "e2e.quit",
      "e2e.reopen",
      "e2e.screenshot",
      "e2e.state",
      "e2e.type",
      "open",
    ]);
  });

  test("open validates its params and returns only tabIds, so it can't spoof the envelope", async () => {
    const d = deps(false);
    const methods = createSocketMethods(d);
    expect(await methods.open?.({ code: "1 + 1", run: true })).toEqual({ tabIds: ["t1"], params: { code: "1 + 1", run: true } });
    await expect(methods.open?.({ files: ["relative.ts"] }) ?? Promise.resolve()).rejects.toThrow();
    await expect(methods.open?.({}) ?? Promise.resolve()).rejects.toThrow();
  });
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/cli/e2e-bridge.test.ts`
Expected: FAIL — `Object.keys(...)` is `[]` for the non-E2E case, and `methods.open` is `undefined`.

- [ ] **Step 7: Register `open` before the e2e guard**

In `apps/desktop/src/main/cli/socket-methods.ts`, add the import and the dep, then register `open` above the early return. **Do not move or weaken the early return.**

```ts
import { type CliOpenParams, type CliOpenResult, cliOpenParamsSchema, type E2EUiMethod } from "@jslab/rpc-schema";
```

```ts
export interface SocketMethodDeps {
  e2eEnabled: boolean;
  /** Spec §16.3: the CLI's method. Present in every launch, unlike everything below it. */
  open(params: CliOpenParams): Promise<CliOpenResult>;
  bridge: Pick<E2EBridge, "request">;
  // …the rest unchanged…
}
```

```ts
export function createSocketMethods(deps: SocketMethodDeps): Record<string, SocketMethod> {
  const methods: Record<string, SocketMethod> = {};
  // Spec §16.3: `open` is the CLI's method and exists in every launch, so it is registered *before* the e2e guard
  // below. A zod failure here is already the spec's `{ id, ok: false, error }` reply — `handleLine` never throws.
  methods.open = async (params) => ({ ...(await deps.open(cliOpenParamsSchema.parse(params ?? {}))) });
  if (!deps.e2eEnabled) return methods;
  // …every e2e.* method, unchanged…
```

Update the function's doc comment, replacing the forward-looking sentence with what is now true:

```ts
/**
 * The socket method table. `open` is the CLI's method and is always available (spec §16.3). `e2e.*` exists only for
 * `JSLAB_E2E=1` launches (spec §16.3, §18) and is registered after the guard below.
 */
```

- [ ] **Step 8: Start the server in every launch, failing soft**

In `apps/desktop/src/main/strings.ts`, add to the `log` block:

```ts
    cliSocket: (path: string) => `jslab CLI socket listening on ${path}`,
    cliSocketFailed: "Couldn't start the jslab CLI socket; the jslab command can't reach this instance",
```

In `apps/desktop/src/main/index.ts`, build the dispatch next to the other CLI wiring (after `e2eBridge`, before the RPC):

```ts
  const cliDispatch = createUiDispatch({
    isOpen: () => mainWindow.isOpen(),
    open: () => void mainWindow.open(),
    send: (message) => rpc.send["menu.command"](message),
  });
```

Add `cliDispatch.markReady();` to the existing `onUiHeartbeat` callback passed to `createRpcHandlers`:

```ts
        onUiHeartbeat: () => {
          sawFirstHeartbeat = true;
          lastUiHeartbeat = Date.now();
          // A CLI `--run` that arrived while the view was booting goes out as soon as it can receive it.
          cliDispatch.markReady();
        },
```

and `cliDispatch.markClosed();` to `createMainWindowController`'s `onClosed`:

```ts
  const mainWindow = createMainWindowController({
    create: createWindow,
    onClosed: () => {
      e2eBridge.rejectAll("The JSLab window closed");
      cliDispatch.markClosed();
    },
  });
```

Then replace the whole `if (e2eEnabled) { socketServer = await startSocketServer({ … }); logger.info(strings.log.e2eEnabled(socketServer.path)); }` block with an unconditional, fail-soft start. Every `createSocketMethods` argument that exists today stays exactly as it is; only `open` is new and only the `if` disappears:

```ts
  const openTabs = createOpenService({
    session,
    readFile: (path) => readFile(path, "utf8"),
    defaults: () => ({ language: settings.current.run.defaultLanguage, runtime: settings.current.run.defaultRuntime }),
    announce: (payload) => {
      if (mainWindow.isOpen()) rpc.send["file.opened"](payload);
    },
    present: ({ run }) => {
      // Focus (or reopen) the window first; a closed window's UI bootstraps the new tabs from the session it just
      // joined, so nothing is lost when `file.opened` above was skipped.
      mainWindow.open();
      if (run) cliDispatch.dispatch("run.start");
    },
    log,
  });

  // Spec §16.3: the socket serves `open` in every launch, not only under JSLAB_E2E=1. It must never take startup
  // down — `startSocketServer` refuses to steal a live socket, which is exactly what a second JSLab instance finds.
  try {
    socketServer = await startSocketServer({
      path: paths.socketPath,
      log,
      methods: createSocketMethods({
        e2eEnabled,
        open: openTabs,
        bridge: e2eBridge,
        settingsBridge: settingsE2E,
        mainState: () => ({ /* …unchanged… */ }),
        uiAvailable: (window = "main") => (window === "main" ? mainWindow.isOpen() : settingsWindow.isOpen()),
        reopenWindow: () => void mainWindow.open(),
        screenshot: async (name, window) => { /* …unchanged… */ },
        quit: () => Utils.quit(),
      }),
    });
    logger.info(e2eEnabled ? strings.log.e2eEnabled(socketServer.path) : strings.log.cliSocket(socketServer.path));
  } catch (error) {
    log(strings.log.cliSocketFailed, String(error));
  }
```

Add the imports this needs: `readFile` from `node:fs/promises` (the file already imports `mkdir, stat` from there — add it to that list), `createOpenService` from `./cli/open-service`, and `createUiDispatch` from `./cli/ui-dispatch`.

- [ ] **Step 9: Run the tests and watch them pass**

Run: `cd apps/desktop && bun test ./test/cli/`
Expected: PASS — `e2e-bridge.test.ts`, `open-service.test.ts`, `socket-server.test.ts` and `ui-dispatch.test.ts` all green.

- [ ] **Step 10: Prove the socket really serves `open` without `JSLAB_E2E`**

This is the claim the whole milestone rests on, and it is worth a direct check rather than an inference. Build and launch a dev app **without** `JSLAB_E2E`, then speak the protocol by hand:

```bash
(cd apps/desktop && hutch run build:dev)
APP="$(ls -d apps/desktop/build/dev-macos-arm64/*.app)"
JSLAB_USER_DATA="$(mktemp -d)" "$APP/Contents/MacOS/launcher" &
sleep 8
printf '{"v":1,"id":"1","method":"open","params":{"code":"1 + 1"}}\n' | nc -U "$JSLAB_USER_DATA/jslab.sock"
```

Expected: one line, `{"tabIds":["…"],"id":"1","ok":true}`, and a new tab visible in the window. Then confirm the guard still holds — `printf '{"v":1,"id":"2","method":"e2e.state"}\n' | nc -U …` must answer `{"id":"2","ok":false,"error":"Unknown method: e2e.state"}`. Quit from the app menu.

- [ ] **Step 11: Run the gates and commit**

```bash
bunx biome check . --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add apps/desktop/src/main/cli/socket-methods.ts apps/desktop/src/main/cli/ui-dispatch.ts apps/desktop/src/main/index.ts apps/desktop/src/main/strings.ts apps/desktop/test/cli/
git commit -m "$(cat <<'EOF'
feat(cli): serve open on jslab.sock in every launch

The method registers before the e2e guard, and the server itself moves
out of index.ts's `if (e2eEnabled)` -- without it there is no socket to
connect to in a normal launch. A second instance loses the CLI socket
and logs it, rather than failing startup.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 4: CLI argument parsing

**Files:**
- Create: `apps/desktop/src/cli/args.ts`
- Test: `apps/desktop/test/cli/args.test.ts`

**Interfaces:**
- Consumes: `CLI_LANG_ALIASES` (Task 1); `LANGUAGES`, `RUNTIMES`, `Language`, `Runtime` from `@jslab/shared`.
- Produces:

  ```ts
  export interface CliOptions {
    files: string[];      // as typed, still relative; Task 6 resolves them
    stdin: boolean;       // a bare "-" was given
    run: boolean;
    runtime?: Runtime;
    lang?: Language;
    cwd?: string;
    title?: string;
  }
  export type CliParse =
    | { kind: "open"; options: CliOptions }
    | { kind: "help" }
    | { kind: "version" }
    | { kind: "error"; message: string };
  export const USAGE: string;
  export function parseArgs(argv: string[]): CliParse;
  ```

  Task 6's `main.ts` switches on `CliParse["kind"]`.

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/test/cli/args.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseArgs, USAGE } from "../../src/cli/args";

describe("parseArgs", () => {
  test("no arguments is an error that shows the usage", () => {
    expect(parseArgs([])).toEqual({ kind: "error", message: `jslab needs a file or -\n${USAGE}` });
  });

  test("bare file names become files", () => {
    expect(parseArgs(["a.ts", "../b/c.tsx"])).toEqual({
      kind: "open",
      options: { files: ["a.ts", "../b/c.tsx"], stdin: false, run: false },
    });
  });

  test("- means stdin", () => {
    expect(parseArgs(["-"])).toEqual({ kind: "open", options: { files: [], stdin: true, run: false } });
  });

  test("--run opens and runs", () => {
    expect(parseArgs(["--run", "a.ts"]).kind).toBe("open");
    expect((parseArgs(["--run", "a.ts"]) as { options: { run: boolean } }).options.run).toBe(true);
  });

  test("every runtime in §16.2 is accepted, and nothing else is", () => {
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      expect((parseArgs(["--runtime", runtime, "-"]) as { options: { runtime?: string } }).options.runtime).toBe(runtime);
    }
    expect(parseArgs(["--runtime", "deno", "-"])).toEqual({
      kind: "error",
      message: "--runtime takes bun, browser or browser-node, not deno",
    });
  });

  test("--lang takes the short spellings and maps them to languages", () => {
    const mapped = (value: string) => (parseArgs(["--lang", value, "-"]) as { options: { lang?: string } }).options.lang;
    expect([mapped("ts"), mapped("js"), mapped("tsx"), mapped("jsx")]).toEqual([
      "typescript",
      "javascript",
      "tsx",
      "jsx",
    ]);
    expect(parseArgs(["--lang", "cobol", "-"])).toEqual({
      kind: "error",
      message: "--lang takes ts, js, tsx or jsx, not cobol",
    });
  });

  test("--cwd and --title carry their values", () => {
    const parsed = parseArgs(["--cwd", "/w/project", "--title", "scratch", "-"]) as { options: Record<string, unknown> };
    expect(parsed.options).toEqual({ files: [], stdin: true, run: false, cwd: "/w/project", title: "scratch" });
  });

  test("--flag=value is accepted alongside --flag value", () => {
    const parsed = parseArgs(["--runtime=browser", "--lang=jsx", "-"]) as { options: Record<string, unknown> };
    expect(parsed.options).toMatchObject({ runtime: "browser", lang: "jsx" });
  });

  test("a flag missing its value is an error, not a silently dropped flag", () => {
    expect(parseArgs(["--cwd"])).toEqual({ kind: "error", message: "--cwd needs a value" });
    expect(parseArgs(["--title", "--run", "a.ts"])).toEqual({ kind: "error", message: "--title needs a value" });
  });

  test("an unknown flag is an error", () => {
    expect(parseArgs(["--nope", "a.ts"])).toEqual({ kind: "error", message: `Unknown option --nope\n${USAGE}` });
  });

  test("--help and --version short-circuit", () => {
    expect(parseArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseArgs(["--version"])).toEqual({ kind: "version" });
    expect(parseArgs(["--run", "--help", "a.ts"])).toEqual({ kind: "help" });
  });

  test("the usage text matches the spec's own grammar", () => {
    expect(USAGE).toContain("jslab [file ...]");
    expect(USAGE).toContain("--runtime bun|browser|browser-node");
    expect(USAGE).toContain("--lang ts|js|tsx|jsx");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/cli/args.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/args'`.

- [ ] **Step 3: Write the parser**

Create `apps/desktop/src/cli/args.ts`:

```ts
import { CLI_LANG_ALIASES } from "@jslab/rpc-schema";
import type { Language, Runtime } from "@jslab/shared";

export interface CliOptions {
  /** As typed: `main.ts` makes these absolute before sending (spec §16.3). */
  files: string[];
  stdin: boolean;
  run: boolean;
  runtime?: Runtime;
  lang?: Language;
  cwd?: string;
  title?: string;
}

export type CliParse =
  | { kind: "open"; options: CliOptions }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "error"; message: string };

/** Spec §16.2, verbatim. */
export const USAGE = `jslab [file ...]                 Open files in new tabs
jslab -                          Read code from stdin into a new tab
jslab --run [file|-]             Open and run immediately
      --runtime bun|browser|browser-node
      --lang ts|js|tsx|jsx       (default: from extension, else settings)
      --cwd <dir>                Set the tab's working directory (default for \`-\`: current dir)
      --title <title>
jslab --version | --help`;

const RUNTIME_VALUES: readonly string[] = ["bun", "browser", "browser-node"];

export function parseArgs(argv: string[]): CliParse {
  const options: CliOptions = { files: [], stdin: false, run: false };
  // --help and --version win wherever they appear, so `jslab --run --help` explains rather than runs.
  if (argv.some((arg) => arg === "--help" || arg === "-h")) return { kind: "help" };
  if (argv.some((arg) => arg === "--version" || arg === "-v")) return { kind: "version" };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] as string;
    if (arg === "-") {
      options.stdin = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      options.files.push(arg);
      continue;
    }
    if (arg === "--run") {
      options.run = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    // A value that starts with "--" is the next flag, not this one's value: report the missing value instead of
    // swallowing the flag that follows.
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    const next = argv[index + 1];
    const value = inline ?? (next !== undefined && !next.startsWith("--") ? next : undefined);
    if (name === "--runtime" || name === "--lang" || name === "--cwd" || name === "--title") {
      if (value === undefined || value === "") return { kind: "error", message: `${name} needs a value` };
      if (inline === undefined) index += 1;
      if (name === "--runtime") {
        if (!RUNTIME_VALUES.includes(value)) {
          return { kind: "error", message: `--runtime takes bun, browser or browser-node, not ${value}` };
        }
        options.runtime = value as Runtime;
      } else if (name === "--lang") {
        const mapped = (CLI_LANG_ALIASES as Record<string, Language>)[value];
        if (!mapped) return { kind: "error", message: `--lang takes ts, js, tsx or jsx, not ${value}` };
        options.lang = mapped;
      } else if (name === "--cwd") {
        options.cwd = value;
      } else {
        options.title = value;
      }
      continue;
    }
    return { kind: "error", message: `Unknown option ${name}\n${USAGE}` };
  }

  if (options.files.length === 0 && !options.stdin) {
    return { kind: "error", message: `jslab needs a file or -\n${USAGE}` };
  }
  return { kind: "open", options };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/desktop && bun test ./test/cli/args.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Run the gates and commit**

```bash
bunx biome check . --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add apps/desktop/src/cli/args.ts apps/desktop/test/cli/args.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): parse the jslab command line

The spec §16.2 grammar: files, -, --run, --runtime (all three runtimes),
--lang with its short spellings, --cwd, --title, --help and --version.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 5: Socket discovery and the client

**Files:**
- Create: `apps/desktop/src/cli/socket-path.ts`, `apps/desktop/src/cli/client.ts`
- Test: `apps/desktop/test/cli/socket-path.test.ts`, `apps/desktop/test/cli/client.test.ts`

**Interfaces:**
- Consumes: `MAX_SOCKET_PATH_BYTES` from `apps/desktop/src/main/cli/ndjson.ts`; `SocketResponse`'s shape (the reply is `{ id, ok, … }`).
- Produces:

  ```ts
  // socket-path.ts
  export const APP_BUNDLE_ID = "dev.jslab.app";
  export const CLI_CHANNELS: readonly ["stable", "canary", "dev"];
  export function candidateSocketPaths(env: Record<string, string | undefined>, home: string): string[];

  // client.ts
  export interface CliConnection {
    call(method: string, params: unknown, timeoutMs?: number): Promise<Record<string, unknown>>;
    close(): void;
  }
  export interface CliTransport {
    connect(path: string): Promise<CliConnection | null>;
    launch(): Promise<void>;
    sleep(ms: number): Promise<void>;
    now(): number;
  }
  export const LAUNCH_TIMEOUT_MS: 10_000;
  export const LAUNCH_POLL_MS: 200;
  export async function connectOrLaunch(paths: string[], transport: CliTransport, allowLaunch: boolean): Promise<CliConnection>;
  export const bunTransport: CliTransport;
  ```

  Task 6's `main.ts` calls `candidateSocketPaths` then `connectOrLaunch(paths, bunTransport, allowLaunch)`.

- [ ] **Step 1: Write the failing socket-path tests**

Create `apps/desktop/test/cli/socket-path.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { candidateSocketPaths } from "../../src/cli/socket-path";

const home = "/h/me";
const support = `${home}/Library/Application Support/dev.jslab.app`;

describe("candidateSocketPaths", () => {
  test("defaults to every channel, stable first", () => {
    expect(candidateSocketPaths({}, home)).toEqual([
      `${support}/stable/jslab.sock`,
      `${support}/canary/jslab.sock`,
      `${support}/dev/jslab.sock`,
    ]);
  });

  test("JSLAB_SOCKET wins outright", () => {
    expect(candidateSocketPaths({ JSLAB_SOCKET: "/tmp/x/jslab.sock" }, home)).toEqual(["/tmp/x/jslab.sock"]);
  });

  test("JSLAB_USER_DATA points at one data folder, as a launched app's own paths do", () => {
    expect(candidateSocketPaths({ JSLAB_USER_DATA: "/tmp/u1" }, home)).toEqual(["/tmp/u1/jslab.sock"]);
  });

  test("JSLAB_CHANNEL moves one channel to the front without hiding the others", () => {
    expect(candidateSocketPaths({ JSLAB_CHANNEL: "canary" }, home)).toEqual([
      `${support}/canary/jslab.sock`,
      `${support}/stable/jslab.sock`,
      `${support}/dev/jslab.sock`,
    ]);
  });

  test("an unknown channel is ignored rather than producing a path that can't exist", () => {
    expect(candidateSocketPaths({ JSLAB_CHANNEL: "../escape" }, home)).toEqual(candidateSocketPaths({}, home));
  });

  test("a path macOS can't bind is dropped, not offered", () => {
    const deep = `/tmp/${"d".repeat(120)}`;
    expect(candidateSocketPaths({ JSLAB_USER_DATA: deep }, home)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/cli/socket-path.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/socket-path'`.

- [ ] **Step 3: Write `socket-path.ts`**

```ts
import { join } from "node:path";
import { MAX_SOCKET_PATH_BYTES } from "../main/cli/ndjson";

export const APP_BUNDLE_ID = "dev.jslab.app";

/** Electrobun lays userData out as `<appData>/dev.jslab.app/<channel>` (spec §4.5). */
export const CLI_CHANNELS = ["stable", "canary", "dev"] as const;

/**
 * Where `jslab` looks for `jslab.sock` (spec §16.3). The binary can't ask Electrobun for `Utils.paths.userData`, so
 * it reconstructs the same layout — with the two overrides a scripted launch needs, matching `resolveAppPaths`'s own
 * `JSLAB_USER_DATA`. Paths macOS could never bind (`sun_path` is 104 bytes including the NUL) are dropped here, so
 * the caller never reports a connection failure that was really a too-long path.
 */
export function candidateSocketPaths(env: Record<string, string | undefined>, home: string): string[] {
  const fits = (path: string) => Buffer.byteLength(path) <= MAX_SOCKET_PATH_BYTES;
  if (env.JSLAB_SOCKET) return [env.JSLAB_SOCKET].filter(fits);
  if (env.JSLAB_USER_DATA) return [join(env.JSLAB_USER_DATA, "jslab.sock")].filter(fits);
  const preferred = CLI_CHANNELS.find((channel) => channel === env.JSLAB_CHANNEL);
  const order = preferred ? [preferred, ...CLI_CHANNELS.filter((channel) => channel !== preferred)] : CLI_CHANNELS;
  const support = join(home, "Library", "Application Support", APP_BUNDLE_ID);
  return order.map((channel) => join(support, channel, "jslab.sock")).filter(fits);
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/desktop && bun test ./test/cli/socket-path.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the failing client tests**

Create `apps/desktop/test/cli/client.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { type CliConnection, type CliTransport, connectOrLaunch, LAUNCH_TIMEOUT_MS } from "../../src/cli/client";

function connection(label: string): CliConnection {
  return { call: async () => ({ label }), close: () => {} };
}

/** A transport whose socket appears after `appearAfterMs` of simulated time. Nothing real is launched. */
function fakeTransport(options: { live?: string; appearAfterMs?: number }) {
  let elapsed = 0;
  let launched = 0;
  const transport: CliTransport = {
    connect: mock(async (path: string) => {
      if (options.live === path) return connection(path);
      if (options.appearAfterMs !== undefined && launched > 0 && elapsed >= options.appearAfterMs) {
        return connection(path);
      }
      return null;
    }),
    launch: mock(async () => {
      launched += 1;
    }),
    sleep: async (ms: number) => {
      elapsed += ms;
    },
    now: () => elapsed,
  };
  return { transport, launches: () => launched };
}

describe("connectOrLaunch", () => {
  test("uses the first live socket and never launches anything", async () => {
    const { transport, launches } = fakeTransport({ live: "/b/jslab.sock" });
    const connected = await connectOrLaunch(["/a/jslab.sock", "/b/jslab.sock"], transport, true);
    expect(await connected.call("open", {})).toEqual({ label: "/b/jslab.sock" });
    expect(launches()).toBe(0);
  });

  test("launches the app and polls until the socket appears (§16.3)", async () => {
    const { transport, launches } = fakeTransport({ appearAfterMs: 1000 });
    const connected = await connectOrLaunch(["/a/jslab.sock"], transport, true);
    expect(await connected.call("open", {})).toEqual({ label: "/a/jslab.sock" });
    expect(launches()).toBe(1);
  });

  test("gives up after the 10 s the spec allows, naming the socket it waited for", async () => {
    const { transport } = fakeTransport({});
    await expect(connectOrLaunch(["/a/jslab.sock"], transport, true)).rejects.toThrow(
      `JSLab didn't answer on /a/jslab.sock within ${LAUNCH_TIMEOUT_MS / 1000} s`,
    );
  });

  test("with launching off, a missing socket fails immediately and nothing is launched", async () => {
    const { transport, launches } = fakeTransport({});
    await expect(connectOrLaunch(["/a/jslab.sock"], transport, false)).rejects.toThrow("JSLab isn't running");
    expect(launches()).toBe(0);
  });

  test("no candidate path at all is a clear error, not a hang", async () => {
    const { transport } = fakeTransport({});
    await expect(connectOrLaunch([], transport, true)).rejects.toThrow("No JSLab socket path to try");
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/cli/client.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/client'`.

- [ ] **Step 7: Write `client.ts`**

```ts
import { APP_BUNDLE_ID } from "./socket-path";

export interface CliConnection {
  call(method: string, params: unknown, timeoutMs?: number): Promise<Record<string, unknown>>;
  close(): void;
}

export interface CliTransport {
  /** Resolves with a connection, or null when nothing is listening on `path`. Never throws. */
  connect(path: string): Promise<CliConnection | null>;
  launch(): Promise<void>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Spec §16.3: "polls for the socket for up to 10 s". */
export const LAUNCH_TIMEOUT_MS = 10_000;
export const LAUNCH_POLL_MS = 200;
export const CALL_TIMEOUT_MS = 30_000;

/**
 * Spec §16.3: try each candidate socket; if none answers and launching is allowed, run `open -b dev.jslab.app` and
 * poll for up to 10 s. Arguments are never passed to the app — the request goes over the socket, which is what
 * avoids Electrobun #540.
 */
export async function connectOrLaunch(
  paths: string[],
  transport: CliTransport,
  allowLaunch: boolean,
): Promise<CliConnection> {
  if (paths.length === 0) throw new Error("No JSLab socket path to try");
  for (const path of paths) {
    const connection = await transport.connect(path);
    if (connection) return connection;
  }
  const [first] = paths as [string, ...string[]];
  if (!allowLaunch) throw new Error(`JSLab isn't running, and launching is off (no socket at ${first})`);

  await transport.launch();
  const deadline = transport.now() + LAUNCH_TIMEOUT_MS;
  while (transport.now() < deadline) {
    await transport.sleep(LAUNCH_POLL_MS);
    for (const path of paths) {
      const connection = await transport.connect(path);
      if (connection) return connection;
    }
  }
  throw new Error(`JSLab didn't answer on ${first} within ${LAUNCH_TIMEOUT_MS / 1000} s`);
}

/** The real transport: a Bun unix socket, and `open -b` for the launch. */
export const bunTransport: CliTransport = {
  connect: (path) => bunConnect(path),
  launch: async () => {
    const proc = Bun.spawn(["/usr/bin/open", "-b", APP_BUNDLE_ID], { stdout: "ignore", stderr: "pipe" });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`Couldn't launch JSLab: ${(await new Response(proc.stderr).text()).trim()}`);
  },
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};

/**
 * One NDJSON connection (`apps/desktop/src/main/cli/ndjson.ts` is the other end). Deliberately minimal: `jslab`
 * makes one call and exits, so there is no reconnect, no queue and no keepalive.
 */
async function bunConnect(path: string): Promise<CliConnection | null> {
  let onData: (chunk: string) => void = () => {};
  let onClose: () => void = () => {};
  let socket: Awaited<ReturnType<typeof Bun.connect<undefined>>>;
  const decoder = new TextDecoder();
  try {
    socket = await Bun.connect<undefined>({
      unix: path,
      socket: {
        data: (_socket, data) => onData(decoder.decode(data, { stream: true })),
        close: () => onClose(),
        error: () => onClose(),
      },
    });
  } catch {
    return null;
  }

  return {
    call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        let buffered = "";
        const timer = setTimeout(() => reject(new Error(`JSLab didn't reply to ${method} within ${timeoutMs} ms`)), timeoutMs);
        const settle = (finish: () => void) => {
          clearTimeout(timer);
          onData = () => {};
          onClose = () => {};
          finish();
        };
        onClose = () => settle(() => reject(new Error("The JSLab socket closed before replying")));
        onData = (chunk) => {
          buffered += chunk;
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const reply = JSON.parse(line) as { ok?: boolean; error?: string } & Record<string, unknown>;
            settle(() => (reply.ok ? resolve(reply) : reject(new Error(reply.error ?? `${method} failed`))));
            return;
          }
        };
        socket.write(`${JSON.stringify({ v: 1, id: "1", method, params })}\n`);
      });
    },
    close: () => socket.end(),
  };
}
```

- [ ] **Step 8: Run them and watch them pass**

Run: `cd apps/desktop && bun test ./test/cli/client.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 9: Run the gates and commit**

```bash
bunx biome check . --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add apps/desktop/src/cli/socket-path.ts apps/desktop/src/cli/client.ts apps/desktop/test/cli/socket-path.test.ts apps/desktop/test/cli/client.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): find jslab.sock, launch JSLab if needed, and speak NDJSON

Candidate paths follow Electrobun's userData layout with JSLAB_SOCKET /
JSLAB_USER_DATA / JSLAB_CHANNEL overrides. Missing app: `open -b
dev.jslab.app`, then poll for up to 10 s (spec §16.3).

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 6: The binary and its build wiring

**Files:**
- Create: `apps/desktop/src/cli/main.ts`
- Modify: `package.json` (root), `apps/desktop/electrobun.config.ts`, `apps/desktop/hutch.config.ts`, `apps/desktop/src/main/app-paths.ts`
- Test: `apps/desktop/test/build-wiring.test.ts`, `apps/desktop/test/shell.test.ts`

**Interfaces:**
- Consumes: `parseArgs`, `USAGE`, `CliParse` (Task 4); `candidateSocketPaths`, `connectOrLaunch`, `bunTransport` (Task 5); `cliOpenParamsSchema`'s shape (Task 1).
- Produces:
  - `apps/desktop/dist/bin/jslab` — the compiled binary, copied into the bundle at `Resources/app/bin/jslab`.
  - `AppPaths.cliBinary: string` — the symlink target Task 7 installs.

- [ ] **Step 1: Write the failing build-wiring and path tests**

Add to `apps/desktop/test/build-wiring.test.ts`:

```ts
describe("build wiring: the jslab CLI binary", () => {
  test("electrobun.config.ts copies dist/bin into the bundle's app/bin folder", () => {
    // Spec §16.1: the symlink points at JSLab.app/Contents/Resources/app/bin/jslab, and `copy`'s destinations are
    // relative to Resources/app — the same reason "dist/runner": "runner" produces app/runner/bootstrap.js.
    expect(electrobunConfig.build?.copy?.["dist/bin"]).toBe("bin");
  });

  test("the root build:cli script compiles the entry to that staged folder with real Bun", () => {
    const scripts = (rootPackage.scripts ?? {}) as Record<string, string>;
    expect(scripts["build:cli"]).toBe(
      "bun build apps/desktop/src/cli/main.ts --compile --outfile apps/desktop/dist/bin/jslab",
    );
  });

  test("build:bundles refuses to build a bundle whose CLI binary was never staged", () => {
    // Cottontail rejects build flags it doesn't know (see hutch.config.ts's own notes on --format), so --compile
    // never runs inside it. The guard turns a forgotten `bun run build:cli` into a loud failure instead of an app
    // that ships without its CLI.
    const bundles = (hutchConfig.scripts as Record<string, string>)["build:bundles"] ?? "";
    expect(bundles).toContain("test -x dist/bin/jslab");
    expect(bundles).toContain("bun run build:cli");
    expect(bundles).not.toContain("--compile");
  });
});
```

Add the import `import rootPackage from "../../../package.json";` at the top of that file.

In `apps/desktop/test/shell.test.ts`, add `cliBinary` to the `toEqual` object in "derives data and bundle locations":

```ts
      // Spec §16.1: the symlink target Help -> Install `jslab` Command… creates.
      cliBinary: "/Applications/JSLab.app/Contents/Resources/app/bin/jslab",
```

and a case to "honors development overrides":

```ts
    expect(resolveAppPaths({ ...input, env: { JSLAB_CLI_BINARY: "/src/jslab" } }).cliBinary).toBe("/src/jslab");
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/build-wiring.test.ts ./test/shell.test.ts`
Expected: FAIL — `copy["dist/bin"]` is `undefined`, `scripts["build:cli"]` is `undefined`, and the `AppPaths` object is missing `cliBinary`.

- [ ] **Step 3: Write the entry**

Create `apps/desktop/src/cli/main.ts`:

```ts
#!/usr/bin/env bun
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parseArgs, USAGE } from "./args";
import { bunTransport, connectOrLaunch } from "./client";
import { candidateSocketPaths } from "./socket-path";

const VERSION = "0.0.1";

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    console.log(`jslab ${VERSION}`);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    return 2;
  }

  const { options } = parsed;
  const cwd = process.cwd();
  // Spec §16.3: paths are made absolute by the CLI before sending, so Main never resolves anything relative to its
  // own process. Spec §16.2: `-` defaults its working directory to the current one.
  const files = options.files.map((file) => (isAbsolute(file) ? file : resolve(cwd, file)));
  const workingDirectory = options.cwd === undefined ? (options.stdin ? cwd : undefined) : resolve(cwd, options.cwd);

  const params: Record<string, unknown> = {};
  if (files.length > 0) params.files = files;
  if (options.stdin) params.code = await readStdin();
  if (options.run) params.run = true;
  if (options.runtime !== undefined) params.runtime = options.runtime;
  if (options.lang !== undefined) params.lang = options.lang;
  if (workingDirectory !== undefined) params.cwd = workingDirectory;
  if (options.title !== undefined) params.title = options.title;

  const paths = candidateSocketPaths(process.env, homedir());
  // A scripted or sandboxed run (the E2E suite included) must never launch the user's installed JSLab.
  const allowLaunch = process.env.JSLAB_CLI_NO_LAUNCH !== "1";
  const connection = await connectOrLaunch(paths, bunTransport, allowLaunch);
  try {
    const reply = await connection.call("open", params);
    const tabIds = Array.isArray(reply.tabIds) ? reply.tabIds : [];
    console.log(tabIds.join("\n"));
    return 0;
  } finally {
    connection.close();
  }
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
```

- [ ] **Step 4: Wire the build**

Root `package.json`, in `scripts` (keep it next to the other build-ish entries):

```json
    "build:cli": "bun build apps/desktop/src/cli/main.ts --compile --outfile apps/desktop/dist/bin/jslab",
```

`apps/desktop/electrobun.config.ts`, inside `build.copy`:

```ts
      // Spec §16.1: the `jslab` binary ships at Resources/app/bin/jslab, which is what the install symlink points
      // at. `bun build --compile` runs from the repo root under real Bun (`bun run build:cli`) and stages the
      // binary here, because Hutch's Cottontail shell rejects build flags it doesn't know — see hutch.config.ts.
      "dist/bin": "bin",
```

`apps/desktop/hutch.config.ts`, as the **first** entry of the `bundles` array so it fails before anything else is built:

```ts
const bundles = [
  // Spec §16.1's binary is compiled by the root `bun run build:cli` under real Bun, never here: Cottontail's
  // `build` rejects flags it doesn't know (`--format` fails the whole build with "unsupported cottontail build
  // option"), and `bunx` can't reach real Bun's bundler without pulling a package off the public registry. A
  // missing binary must be loud — a bundle that silently ships without its CLI looks fine until someone runs
  // `jslab` and gets "command not found" with no explanation.
  'test -x dist/bin/jslab || { echo "dist/bin/jslab is missing: run \\`bun run build:cli\\` from the repo root first" >&2; exit 1; }',
  "bun build ../../packages/runner-bun/src/bootstrap.ts --target bun --outfile dist/runner/bootstrap.js",
  // …the rest unchanged…
```

`apps/desktop/src/main/app-paths.ts`, in `AppPaths` and `resolveAppPaths`:

```ts
  /** Spec §16.1: the Bun-compiled `jslab` binary the install symlink points at. */
  cliBinary: string;
```

```ts
    cliBinary: input.env.JSLAB_CLI_BINARY ?? join(appDir, "bin", "jslab"),
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd apps/desktop && bun test ./test/build-wiring.test.ts ./test/shell.test.ts`
Expected: PASS.

- [ ] **Step 6: Compile the binary and drive it against a real app**

```bash
bun run build:cli
apps/desktop/dist/bin/jslab --help                       # the §16.2 usage
apps/desktop/dist/bin/jslab --version                    # jslab 0.0.1
apps/desktop/dist/bin/jslab --runtime deno -             # exits 2 with the runtime message
(cd apps/desktop && hutch run build:dev)                 # now passes the new guard
APP="$(ls -d apps/desktop/build/dev-macos-arm64/*.app)"
test -x "$APP/Contents/Resources/app/bin/jslab"          # the copy rule really landed it
DATA="$(mktemp -d)"
JSLAB_USER_DATA="$DATA" "$APP/Contents/MacOS/launcher" &
sleep 8
echo 'console.log("from stdin")' | JSLAB_USER_DATA="$DATA" JSLAB_CLI_NO_LAUNCH=1 apps/desktop/dist/bin/jslab --run --runtime browser-node -
```

Expected: the last command prints one tab id, and the app shows a new `browser-node` tab whose output reads `from stdin`. Quit from the app menu.

- [ ] **Step 7: Run the gates and commit**

```bash
bunx biome check . --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add apps/desktop/src/cli/main.ts apps/desktop/src/main/app-paths.ts apps/desktop/electrobun.config.ts apps/desktop/hutch.config.ts apps/desktop/test/build-wiring.test.ts apps/desktop/test/shell.test.ts package.json
git commit -m "$(cat <<'EOF'
feat(cli): compile the jslab binary and ship it in the bundle

`bun run build:cli` compiles with real Bun and stages dist/bin/jslab;
electrobun copies it to Resources/app/bin/jslab, the path §16.1's symlink
targets. build:bundles only guards that it was staged -- Cottontail
rejects build flags it doesn't know, so --compile never runs inside it.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 7: Install, uninstall and the Help item

**Files:**
- Create: `apps/desktop/src/main/cli/install.ts`
- Modify: `packages/shared/src/commands.ts`, `packages/rpc-schema/src/ui-rpc.ts`, `apps/desktop/src/main/menu.ts`, `apps/desktop/src/main/rpc/app-handlers.ts`, `apps/desktop/src/main/index.ts`, `apps/desktop/src/main/strings.ts`, `apps/ui/src/commands/app-commands.ts`
- Test: `apps/desktop/test/cli/install.test.ts`, `apps/desktop/test/menu.test.ts`, `apps/desktop/test/rpc/app-handlers.test.ts`

**Interfaces:**
- Consumes: `AppPaths.cliBinary` (Task 6); `MenuModel` and `buildMenu` (`apps/desktop/src/main/menu.ts`); `AppHandlerDeps`, `runAppAction` (`apps/desktop/src/main/rpc/app-handlers.ts`); `APP_ACTIONS` (`packages/rpc-schema/src/ui-rpc.ts`).
- Produces:

  ```ts
  export type InstallScope = "user" | "allUsers";
  export const USER_BIN_SUBPATH = ".local/bin";
  export const SYSTEM_BIN_DIR = "/usr/local/bin";
  export interface CliInstallFs {
    mkdir(dir: string): Promise<void>;
    symlink(target: string, link: string): Promise<void>;
    readlink(link: string): Promise<string | null>;
    unlink(link: string): Promise<void>;
  }
  export interface CliInstallDeps {
    home: string;
    path: string;                                  // the login shell's PATH (spec §4.6), not Main's own
    target: string;                                // AppPaths.cliBinary
    fs: CliInstallFs;
    escalate?(argv: string[]): Promise<void>;      // only ever called for scope "allUsers"
  }
  export interface CliInstallStatus { installed: boolean; linkPath: string | null; onPath: boolean }
  export interface CliInstallResult { ok: boolean; linkPath: string; onPath: boolean; message: string }
  export const nodeInstallFs: CliInstallFs;
  export function userLinkPath(home: string): string;
  export function isOnPath(path: string, dir: string, home: string): boolean;
  export async function cliStatus(deps: CliInstallDeps): Promise<CliInstallStatus>;
  export async function installCli(deps: CliInstallDeps, scope: InstallScope): Promise<CliInstallResult>;
  export async function uninstallCli(deps: CliInstallDeps): Promise<CliInstallResult>;
  ```

  `MenuModel` gains `cliInstalled: boolean`; `AppHandlerDeps` gains `installCli(): void` and `uninstallCli(): void`; `APP_ACTIONS` gains `"installCli"` and `"uninstallCli"`.

**No test in this task may raise an administrator prompt.** Every one runs against `mkdtemp` as `home`, with the real `node:fs` adapter and **no** `escalate` dependency.

- [ ] **Step 1: Write the failing install tests**

Create `apps/desktop/test/cli/install.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliStatus,
  installCli,
  isOnPath,
  nodeInstallFs,
  uninstallCli,
  userLinkPath,
} from "../../src/main/cli/install";

let home = "";
let target = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jslab-home-"));
  target = join(home, "app", "bin", "jslab");
  await Bun.write(target, "#!/bin/sh\n");
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** The real fs, a temp home, and deliberately no `escalate`: nothing here can reach osascript. */
const deps = (path: string) => ({ home, path, target, fs: nodeInstallFs });

describe("the jslab install", () => {
  test("creates ~/.local/bin and links the binary there, with no escalation", async () => {
    const result = await installCli(deps(`${home}/.local/bin:/usr/bin`), "user");
    expect(result).toEqual({
      ok: true,
      linkPath: userLinkPath(home),
      onPath: true,
      message: `jslab is installed at ${userLinkPath(home)}.`,
    });
    expect(await readlink(userLinkPath(home))).toBe(target);
  });

  test("a PATH without the folder still installs, and says exactly what to add (§16.1)", async () => {
    const result = await installCli(deps("/usr/bin:/bin"), "user");
    expect(result.ok).toBe(true);
    expect(result.onPath).toBe(false);
    expect(result.message).toBe(
      `jslab is installed at ${userLinkPath(home)}, but ${join(home, ".local", "bin")} isn't on your PATH. ` +
        `Add this line to your shell profile:\n\n    export PATH="$HOME/.local/bin:$PATH"`,
    );
  });

  test("re-installing over an existing link replaces it rather than failing", async () => {
    await installCli(deps("/usr/bin"), "user");
    const moved = join(home, "app", "bin", "jslab2");
    await Bun.write(moved, "#!/bin/sh\n");
    const result = await installCli({ ...deps("/usr/bin"), target: moved }, "user");
    expect(result.ok).toBe(true);
    expect(await readlink(userLinkPath(home))).toBe(moved);
  });

  test("a real file in the way is refused rather than deleted", async () => {
    const link = userLinkPath(home);
    await nodeInstallFs.mkdir(join(home, ".local", "bin"));
    await writeFile(link, "someone else's jslab");
    const result = await installCli(deps("/usr/bin"), "user");
    expect(result.ok).toBe(false);
    expect(result.message).toBe(`${link} already exists and isn't a symlink; remove it and try again.`);
    expect(await Bun.file(link).text()).toBe("someone else's jslab");
  });

  test("status reports whether the link exists and whether it is findable", async () => {
    expect(await cliStatus(deps("/usr/bin"))).toEqual({ installed: false, linkPath: null, onPath: false });
    await installCli(deps(`${home}/.local/bin`), "user");
    expect(await cliStatus(deps(`${home}/.local/bin`))).toEqual({
      installed: true,
      linkPath: userLinkPath(home),
      onPath: true,
    });
  });

  test("status ignores a symlink that points somewhere else entirely", async () => {
    await nodeInstallFs.mkdir(join(home, ".local", "bin"));
    await symlink("/usr/bin/true", userLinkPath(home));
    expect(await cliStatus(deps("/usr/bin"))).toMatchObject({ installed: false });
  });

  test("uninstall removes the link and reports it", async () => {
    await installCli(deps("/usr/bin"), "user");
    const result = await uninstallCli(deps("/usr/bin"));
    expect(result.ok).toBe(true);
    expect(result.message).toBe(`jslab was removed from ${userLinkPath(home)}.`);
    expect(await cliStatus(deps("/usr/bin"))).toMatchObject({ installed: false });
  });

  test("uninstalling when nothing is installed says so instead of failing", async () => {
    const result = await uninstallCli(deps("/usr/bin"));
    expect(result).toMatchObject({ ok: true, message: "jslab wasn't installed." });
  });

  test("all-users install never escalates on its own: without an escalation hook it refuses", async () => {
    const result = await installCli(deps("/usr/bin"), "allUsers");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Installing for all users isn't available in this build.");
  });

  test("all-users install runs exactly one privileged command, and only when asked for", async () => {
    const escalate = mock(async (_argv: string[]) => {});
    const result = await installCli({ ...deps("/usr/local/bin"), escalate }, "allUsers");
    expect(result).toMatchObject({ ok: true, linkPath: "/usr/local/bin/jslab", onPath: true });
    expect(escalate.mock.calls).toEqual([[["/bin/ln", "-sfn", target, "/usr/local/bin/jslab"]]]);
    // The user-scope install is untouched by it, which is what keeps the default path escalation-free.
    expect(await cliStatus(deps("/usr/bin"))).toMatchObject({ installed: false });
  });
});

describe("isOnPath", () => {
  test("matches an entry exactly, including a trailing slash, and expands a leading ~", () => {
    expect(isOnPath("/a:/h/.local/bin:/b", "/h/.local/bin", "/h")).toBe(true);
    expect(isOnPath("/a:/h/.local/bin/:/b", "/h/.local/bin", "/h")).toBe(true);
    expect(isOnPath("/a:~/.local/bin:/b", "/h/.local/bin", "/h")).toBe(true);
    expect(isOnPath("/a:$HOME/.local/bin:/b", "/h/.local/bin", "/h")).toBe(true);
    expect(isOnPath("/a:/h/.local/binary:/b", "/h/.local/bin", "/h")).toBe(false);
    expect(isOnPath("", "/h/.local/bin", "/h")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/cli/install.test.ts`
Expected: FAIL — `Cannot find module '../../src/main/cli/install'`.

- [ ] **Step 3: Write `install.ts`**

```ts
import { mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";

export type InstallScope = "user" | "allUsers";

/** Spec §16.1. The user scope is the default and never escalates; the all-users scope is an explicit opt-in. */
export const USER_BIN_SUBPATH = ".local/bin";
export const SYSTEM_BIN_DIR = "/usr/local/bin";
export const LINK_NAME = "jslab";

export interface CliInstallFs {
  mkdir(dir: string): Promise<void>;
  symlink(target: string, link: string): Promise<void>;
  /** The link's target, or null when `link` is missing or is not a symlink. Never throws. */
  readlink(link: string): Promise<string | null>;
  unlink(link: string): Promise<void>;
}

export const nodeInstallFs: CliInstallFs = {
  mkdir: (dir) => mkdir(dir, { recursive: true }).then(() => undefined),
  symlink: (target, link) => symlink(target, link),
  readlink: (link) => readlink(link).then((value) => value, () => null),
  unlink: (link) => unlink(link),
};

export interface CliInstallDeps {
  home: string;
  /** The PATH the user's login shell exports (spec §4.6). A GUI app's own PATH is not what a terminal sees. */
  path: string;
  /** `AppPaths.cliBinary`. */
  target: string;
  fs: CliInstallFs;
  /**
   * Runs one privileged command. Supplied **only** for a deliberate all-users install; its absence is why the
   * default path can't escalate even by mistake.
   */
  escalate?(argv: string[]): Promise<void>;
}

export interface CliInstallStatus {
  installed: boolean;
  linkPath: string | null;
  onPath: boolean;
}

export interface CliInstallResult {
  ok: boolean;
  linkPath: string;
  onPath: boolean;
  message: string;
}

export function userBinDir(home: string): string {
  return join(home, USER_BIN_SUBPATH);
}

export function userLinkPath(home: string): string {
  return join(userBinDir(home), LINK_NAME);
}

/** A PATH entry matches when it names the same folder, allowing a trailing slash and a `~` or `$HOME` prefix. */
export function isOnPath(path: string, dir: string, home: string): boolean {
  return path.split(":").some((entry) => {
    if (!entry) return false;
    const expanded = entry.startsWith("~/")
      ? join(home, entry.slice(2))
      : entry.startsWith("$HOME/")
        ? join(home, entry.slice(6))
        : entry;
    return expanded.replace(/\/+$/, "") === dir.replace(/\/+$/, "");
  });
}

/** Both scopes' link paths, user first: status reports whichever one actually points at this build. */
function linkPaths(home: string): string[] {
  return [userLinkPath(home), join(SYSTEM_BIN_DIR, LINK_NAME)];
}

export async function cliStatus(deps: CliInstallDeps): Promise<CliInstallStatus> {
  for (const linkPath of linkPaths(deps.home)) {
    if ((await deps.fs.readlink(linkPath)) === deps.target) {
      const dir = linkPath === userLinkPath(deps.home) ? userBinDir(deps.home) : SYSTEM_BIN_DIR;
      return { installed: true, linkPath, onPath: isOnPath(deps.path, dir, deps.home) };
    }
  }
  return { installed: false, linkPath: null, onPath: false };
}

export async function installCli(deps: CliInstallDeps, scope: InstallScope): Promise<CliInstallResult> {
  if (scope === "allUsers") return installForAllUsers(deps);

  const dir = userBinDir(deps.home);
  const linkPath = userLinkPath(deps.home);
  const onPath = isOnPath(deps.path, dir, deps.home);
  const existing = await deps.fs.readlink(linkPath);
  if (existing === null && (await pathExists(linkPath))) {
    return { ok: false, linkPath, onPath, message: `${linkPath} already exists and isn't a symlink; remove it and try again.` };
  }
  try {
    await deps.fs.mkdir(dir);
    // Replace our own (or a stale) link rather than failing with EEXIST; a real file was refused above.
    if (existing !== null) await deps.fs.unlink(linkPath);
    await deps.fs.symlink(deps.target, linkPath);
  } catch (error) {
    return { ok: false, linkPath, onPath, message: `Couldn't install jslab at ${linkPath}: ${String(error)}` };
  }
  return {
    ok: true,
    linkPath,
    onPath,
    message: onPath
      ? `jslab is installed at ${linkPath}.`
      : `jslab is installed at ${linkPath}, but ${dir} isn't on your PATH. Add this line to your shell profile:\n\n    export PATH="$HOME/.local/bin:$PATH"`,
  };
}

/**
 * Spec §16.1's "Install for all users". This is the **only** path that escalates, it is never a fallback from the
 * user-scope install, and it runs exactly one command with a fixed argv — no shell, no interpolation.
 */
async function installForAllUsers(deps: CliInstallDeps): Promise<CliInstallResult> {
  const linkPath = join(SYSTEM_BIN_DIR, LINK_NAME);
  const onPath = isOnPath(deps.path, SYSTEM_BIN_DIR, deps.home);
  if (!deps.escalate) {
    return { ok: false, linkPath, onPath, message: "Installing for all users isn't available in this build." };
  }
  try {
    await deps.escalate(["/bin/ln", "-sfn", deps.target, linkPath]);
  } catch (error) {
    return { ok: false, linkPath, onPath, message: `Couldn't install jslab at ${linkPath}: ${String(error)}` };
  }
  return { ok: true, linkPath, onPath, message: `jslab is installed at ${linkPath}.` };
}

export async function uninstallCli(deps: CliInstallDeps): Promise<CliInstallResult> {
  const status = await cliStatus(deps);
  if (!status.installed || status.linkPath === null) {
    return { ok: true, linkPath: userLinkPath(deps.home), onPath: status.onPath, message: "jslab wasn't installed." };
  }
  const linkPath = status.linkPath;
  const privileged = linkPath === join(SYSTEM_BIN_DIR, LINK_NAME);
  try {
    if (privileged) {
      if (!deps.escalate) {
        return { ok: false, linkPath, onPath: status.onPath, message: `Removing ${linkPath} needs an administrator.` };
      }
      await deps.escalate(["/bin/rm", "-f", linkPath]);
    } else {
      await deps.fs.unlink(linkPath);
    }
  } catch (error) {
    return { ok: false, linkPath, onPath: status.onPath, message: `Couldn't remove ${linkPath}: ${String(error)}` };
  }
  return { ok: true, linkPath, onPath: status.onPath, message: `jslab was removed from ${linkPath}.` };
}

async function pathExists(path: string): Promise<boolean> {
  return await Bun.file(path)
    .exists()
    .catch(() => false);
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/desktop && bun test ./test/cli/install.test.ts`
Expected: PASS, 12 tests. **No administrator prompt appears.** If one does, stop: a dependency leaked an `escalate` it should not have.

- [ ] **Step 5: Write the failing menu and handler tests**

In `apps/desktop/test/menu.test.ts`, extend the `model` helper with `cliInstalled: false,` and add:

```ts
  test("the Help menu offers one install slot whose label follows the installed state (§16.1)", () => {
    const fresh = buildMenu(model());
    expect(byLabel(fresh, "Install jslab Command")).toMatchObject({ action: menuAction("help.installCli") });
    expect(byLabel(fresh, "Uninstall jslab Command")).toBeUndefined();

    const installed = buildMenu(model({ cliInstalled: true }));
    expect(byLabel(installed, "Uninstall jslab Command")).toMatchObject({ action: menuAction("help.uninstallCli") });
    expect(byLabel(installed, "Install jslab Command")).toBeUndefined();
  });
```

In `apps/desktop/test/rpc/app-handlers.test.ts`, add to that file's existing `deps` factory `installCli: mock(() => {}), uninstallCli: mock(() => {}),` and a test:

```ts
  test("installCli and uninstallCli reach Main, and nothing else changes", async () => {
    const { handlers, deps } = setup();
    handlers.messages["app.command"]({ action: "installCli" });
    handlers.messages["app.command"]({ action: "uninstallCli" });
    await Bun.sleep(0);
    expect(deps.installCli).toHaveBeenCalledTimes(1);
    expect(deps.uninstallCli).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/desktop && bun test ./test/menu.test.ts ./test/rpc/app-handlers.test.ts`
Expected: FAIL — no such menu item, and `"installCli"` is not an `AppAction`.

- [ ] **Step 7: Walk the command chain**

`packages/shared/src/commands.ts`, in the `help` block:

```ts
  { id: "help.installCli", title: "Install jslab Command…", category: "help" },
  // The menu shows exactly one of this pair (spec §16.1), so only the install half is offered in the palette;
  // uninstall stays menu- and keybinding-dispatchable, the same way npm.install does.
  { id: "help.uninstallCli", title: "Uninstall jslab Command…", category: "help", palette: false },
```

`packages/rpc-schema/src/ui-rpc.ts`, in `APP_ACTIONS`:

```ts
  "installCli",
  "uninstallCli",
```

(`SETTINGS_APP_ACTIONS` is unchanged: the Settings window never installs the CLI.)

`apps/ui/src/commands/app-commands.ts`, beside the other Help commands:

```ts
    { id: "help.installCli", run: () => deps.api.appCommand("installCli") },
    { id: "help.uninstallCli", run: () => deps.api.appCommand("uninstallCli") },
```

`apps/desktop/src/main/rpc/app-handlers.ts` — two `AppHandlerDeps` fields and two `runAppAction` cases:

```ts
  /** Spec §16.1: Help → Install `jslab` Command…. Defaults to ~/.local/bin and never escalates. */
  installCli(): void;
  uninstallCli(): void;
```

```ts
    case "installCli":
      deps.installCli();
      return;
    case "uninstallCli":
      deps.uninstallCli();
      return;
```

`apps/desktop/src/main/menu.ts` — `MenuModel` gains the flag and the Help submenu gains the slot:

```ts
export interface MenuModel {
  settings: Settings;
  activeTab: TabState | null;
  bindings: readonly ResolvedBinding[];
  themes: readonly { id: string; name: string }[];
  canReopen: boolean;
  /** Spec §16.1: the one slot reads "Uninstall…" once a symlink to this build is detected. */
  cliInstalled: boolean;
}
```

```ts
    {
      label: "Help",
      submenu: [
        item("help.copyDebugLog"),
        item("help.openLogsFolder"),
        separator,
        model.cliInstalled ? item("help.uninstallCli") : item("help.installCli"),
        separator,
        item("help.restartSafeMode"),
      ],
    },
```

- [ ] **Step 8: Wire it in `index.ts`**

In `apps/desktop/src/main/strings.ts`, add a top-level block beside `files` and `notices`:

```ts
  cli: {
    /** Shown as a notice after Help → Install/Uninstall `jslab` Command… (spec §16.1). */
    installFailed: (message: string) => `Couldn't install the jslab command: ${message}`,
  },
```

In `apps/desktop/src/main/index.ts`, next to the other CLI wiring:

```ts
  // Spec §16.1. Under E2E the "home" is this launch's private data folder, so a scenario can assert the symlink
  // without ever writing into the real ~/.local/bin. `escalate` is deliberately omitted: the default install is
  // ~/.local/bin and nothing in JSLab raises an administrator prompt on its own (see the M5c plan's ruling).
  const cliInstallDeps = {
    home: e2eEnabled ? paths.dataDir : homedir(),
    path: baseEnv.PATH ?? "",
    target: paths.cliBinary,
    fs: nodeInstallFs,
  };
  let cliInstalled = false;
  const refreshCliInstalled = async () => {
    cliInstalled = (await cliStatus(cliInstallDeps)).installed;
    menu.refresh();
  };
  const reportCliResult = (result: CliInstallResult) => {
    log(result.message);
    if (mainWindow.isOpen()) rpc.send["app.notice"]({ id: "cliInstall", message: result.message });
    void refreshCliInstalled();
  };
```

`app.notice` is a `ViewMessages` entry built by Main and never re-validated (`ui-rpc.ts`: *"`ViewMessages` payloads are built by Main itself and never re-enter it"*), so the new `cliInstall` id needs no schema change.

Add the two callbacks to `appHandlerDeps`:

```ts
    installCli: () =>
      void installCli(cliInstallDeps, "user").then(reportCliResult, (error: unknown) =>
        log(strings.cli.installFailed(String(error))),
      ),
    uninstallCli: () =>
      void uninstallCli(cliInstallDeps).then(reportCliResult, (error: unknown) =>
        log(strings.cli.installFailed(String(error))),
      ),
```

Pass the flag to the menu model and prime it once at startup:

```ts
        canReopen: session.session.closedStack.length > 0,
        cliInstalled,
```

```ts
  menu.refresh();
  void refreshCliInstalled();
```

Add the imports: `cliStatus`, `installCli`, `uninstallCli`, `nodeInstallFs` and `type CliInstallResult` from `./cli/install`.

- [ ] **Step 9: Run the tests and watch them pass**

Run: `cd apps/desktop && bun test ./test/cli/install.test.ts ./test/menu.test.ts ./test/rpc/app-handlers.test.ts`
Expected: PASS.

- [ ] **Step 10: Run the gates and commit**

```bash
bunx biome check . --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
git add apps/desktop/src/main/cli/install.ts apps/desktop/src/main/menu.ts apps/desktop/src/main/index.ts apps/desktop/src/main/strings.ts apps/desktop/src/main/rpc/app-handlers.ts apps/ui/src/commands/app-commands.ts packages/shared/src/commands.ts packages/rpc-schema/src/ui-rpc.ts apps/desktop/test/
git commit -m "$(cat <<'EOF'
feat(cli): install and uninstall jslab from the Help menu

Default is ~/.local/bin with no privilege escalation; /usr/local/bin is
an explicit opt-in that refuses rather than escalating when no
escalation hook is supplied. A PATH without ~/.local/bin gets the exact
export line, never a silent failure. No test can reach osascript.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

### Task 8: E2E, parity and docs

**Files:**
- Create: `packages/e2e/scenarios/cli.test.ts`, `docs/qa/m5c-checklist.md`
- Modify: `docs/parity.md` (XT-03), `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, `README.md`
- Test: the scenarios themselves, then every suite

**Interfaces:**
- Consumes: `launchApp`, `LaunchedApp`, `waitFor`, `activeTab` from `packages/e2e/src`; the compiled binary at `apps/desktop/dist/bin/jslab` (Task 6); `JSLAB_SOCKET` / `JSLAB_CLI_NO_LAUNCH` (Tasks 5, 6).
- Produces: XT-03 flipped to ✅, with the scenario paths named in the row.

- [ ] **Step 1: Build, then write the failing scenario**

```bash
bun run build:cli && (cd apps/desktop && hutch run build:dev)
```

**`bun run e2e` does not build.** Skipping this step tests a stale bundle and produces confident, misleading failures.

Create `packages/e2e/scenarios/cli.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, REPO_ROOT, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

const CLI = join(REPO_ROOT, "apps/desktop/dist/bin/jslab");

/** Runs the compiled binary against one launch's own socket. It never launches the user's installed JSLab. */
async function jslab(app: LaunchedApp, args: string[], stdin?: string) {
  if (!existsSync(CLI)) throw new Error(`No jslab binary at ${CLI}. Build it first: bun run build:cli`);
  const proc = Bun.spawn([CLI, ...args], {
    env: {
      ...process.env,
      JSLAB_SOCKET: join(app.userData, "jslab.sock"),
      JSLAB_CLI_NO_LAUNCH: "1",
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("the jslab CLI (XT-03)", () => {
  test("opens a file in a new tab, with the language from its extension", async () => {
    const app = await launchApp();
    apps.push(app);
    const dir = await mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), "jslab-cli-"));
    const file = join(dir, "hello.tsx");
    await writeFile(file, "const greeting: string = 'hi'\n");

    const before = (await app.state()).ui.tabOrder;
    const result = await jslab(app, [file]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).not.toBe("");

    const state = await waitFor(async () => {
      const next = await app.state();
      return next.ui.tabOrder.length > before.length ? next : null;
    });
    const tab = activeTab(state);
    expect(tab.filePath).toBe(file);
    expect(tab.language).toBe("tsx");
    expect(tab.code).toBe("const greeting: string = 'hi'\n");
  });

  test("reads stdin, and runs only when --run is passed (§16.3)", async () => {
    const app = await launchApp();
    apps.push(app);

    await jslab(app, ["-"], "console.log('quiet')\n");
    await waitFor(async () => (activeTab(await app.state()).code.includes("quiet") ? true : null));
    expect(await app.output()).toEqual([]);

    await jslab(app, ["--run", "-"], "console.log('loud')\n");
    await app.waitForOutput((entries) => entries.some((entry) => entry.text === "loud"));
  });

  test("--runtime selects any of the three runtimes, and --cwd and --title reach the tab", async () => {
    const app = await launchApp();
    apps.push(app);
    const dir = await mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), "jslab-cwd-"));
    for (const runtime of ["bun", "browser", "browser-node"] as const) {
      await jslab(app, ["--runtime", runtime, "--cwd", dir, "--title", `cli-${runtime}`, "-"], "1 + 1\n");
      const state = await waitFor(async () => {
        const tab = activeTab(await app.state());
        return tab.title === `cli-${runtime}` ? tab : null;
      });
      expect(state.runtime).toBe(runtime);
      expect(state.workingDirectory).toBe(dir);
    }
  });

  test("a second jslab for an already-open file focuses that tab instead of opening another", async () => {
    const app = await launchApp();
    apps.push(app);
    const dir = await mkdtemp(join(process.env.JSLAB_E2E_TMPDIR ?? tmpdir(), "jslab-dup-"));
    const file = join(dir, "once.ts");
    await writeFile(file, "1\n");
    await jslab(app, [file]);
    const opened = await waitFor(async () => {
      const state = await app.state();
      return state.ui.tabs.some((tab) => tab.filePath === file) ? state : null;
    });
    await jslab(app, [file]);
    await Bun.sleep(500);
    const after = await app.state();
    expect(after.ui.tabOrder.length).toBe(opened.ui.tabOrder.length);
  });

  test("a bad request is one clear error and a non-zero exit, never a partial open", async () => {
    const app = await launchApp();
    apps.push(app);
    const before = (await app.state()).ui.tabOrder.length;
    const missing = await jslab(app, [join(app.userData, "nope.ts")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("couldn't be read");
    expect((await app.state()).ui.tabOrder.length).toBe(before);

    const bogus = await jslab(app, ["--runtime", "deno", "-"], "1\n");
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("--runtime takes bun, browser or browser-node");
  });

  test("Help → Install jslab Command links the binary and the menu item flips to Uninstall (§16.1)", async () => {
    const app = await launchApp();
    apps.push(app);
    // Under JSLAB_E2E the install's "home" is this launch's data folder, so nothing touches the real ~/.local/bin.
    const link = join(app.userData, ".local", "bin", "jslab");
    const labels = async () =>
      JSON.stringify((await app.state()).main.menu ?? []);

    expect(await labels()).toContain("Install jslab Command");
    await app.command("help.installCli");
    await waitFor(() => (existsSync(link) ? true : null));
    await waitFor(async () => ((await labels()).includes("Uninstall jslab Command") ? true : null));

    await app.command("help.uninstallCli");
    await waitFor(() => (existsSync(link) ? null : true));
    await waitFor(async () => ((await labels()).includes("Install jslab Command") ? true : null));
  });
});
```

- [ ] **Step 2: Run the scenario and watch it fail, then pass**

Run: `cd packages/e2e && bun test ./scenarios/cli.test.ts --timeout 180000`

Run it once **before** rebuilding to see it fail for the stated reason (no binary, or an old bundle without `open`), then rebuild and run again. Expected: PASS, 6 scenarios.

- [ ] **Step 3: Flip the parity row**

In `docs/parity.md`, replace line 228's row with:

```markdown
| XT-03 | `jslab` CLI (open, stdin, `--run`, `--runtime`, `--cwd`) | #23, #747, #594 | §16 | M5 | E | ✅ `packages/e2e/scenarios/cli.test.ts` (open, stdin, `--run`, all three `--runtime` values, `--cwd`, `--title`, install/uninstall); unit: `apps/desktop/test/cli/`, `packages/rpc-schema/test/cli.test.ts` |
```

**Only this row changes.** No other M5 row is M5c's, and a row may not claim coverage it does not have.

- [ ] **Step 4: Update the roadmap, README and QA checklist**

`docs/superpowers/plans/2026-09-12-jslab-roadmap.md`, M5 feature 5:

```markdown
  5. CLI: `jslab` binary and the socket `open` method on the existing `jslab.sock` server (M2), install/uninstall menu. **Done (M5c)** — plan: `docs/superpowers/plans/2026-09-16-jslab-m5c-cli.md`.
```

`README.md` — add after the `bun run e2e` block:

````markdown
### The `jslab` command

```bash
bun run build:cli    # compile apps/desktop/dist/bin/jslab (real Bun; run it before `hutch run build`)
```

The binary ships inside the app at `Resources/app/bin/jslab`. Help → Install `jslab` Command… symlinks it into
`~/.local/bin`; if that folder isn't on your `PATH`, the message tells you the line to add. Installing for all
users writes to `/usr/local/bin` and is the only action that asks for an administrator password.

```bash
jslab notes.ts                       # open a file in a new tab
echo 'fetch("…")' | jslab --run -    # run code from stdin
jslab --runtime browser --cwd . app.tsx
```
````

and change the roadmap table's M5 row scope note to mention the CLI is done where the table is regenerated at M5's close (leave the row's status to the milestone, not to M5c).

Create `docs/qa/m5c-checklist.md` following `docs/qa/m3-checklist.md`'s structure, covering only what automation must not do:

```markdown
# M5c Manual QA Checklist — the `jslab` command

Run against the packaged canary build, using the M2 launch procedure in `docs/qa/m3-checklist.md`. Build the CLI
first: `bun run build:cli`, then `cd apps/desktop && hutch run build`.

Automated tests install into a temporary folder and never escalate, so these three items have no automated cover.

- [ ] **A real install.** Help → Install `jslab` Command…, then in a **new** terminal run `which jslab` and
      `jslab --version`. Expect `~/.local/bin/jslab` and `jslab 0.0.1`. Remove it afterwards with Help →
      Uninstall `jslab` Command… and confirm `which jslab` finds nothing.
- [ ] **The PATH message.** In a shell whose profile does not add `~/.local/bin`, install and read the notice.
      Expect it to name `~/.local/bin` and show `export PATH="$HOME/.local/bin:$PATH"` verbatim.
- [ ] **All users, deliberately.** Only if you intend to: choose the all-users install, approve the
      administrator prompt once, confirm `/usr/local/bin/jslab` exists, then uninstall. Confirm the prompt
      appears **only** for this choice — the default install must never raise one.
- [ ] **Autolaunch.** Quit JSLab entirely, then run `jslab --run -` from a terminal with `echo '1+1' |`. Expect
      JSLab to launch, open a tab and show `2` within 10 s.
```

- [ ] **Step 5: Run every suite and report real numbers**

```bash
bunx biome check . --max-diagnostics=300
bun run typecheck
bun run test
PATH="$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64:$PATH" bun run test
bun run build:cli && (cd apps/desktop && hutch run build:dev) && bun run e2e
```

Report `baseline N → after M` for unit and for e2e, measured — not copied from this plan.

- [ ] **Step 6: Commit**

```bash
git add packages/e2e/scenarios/cli.test.ts docs/qa/m5c-checklist.md docs/parity.md docs/superpowers/plans/2026-09-12-jslab-roadmap.md README.md
git commit -m "$(cat <<'EOF'
test(cli): prove the jslab command end to end, and flip XT-03

Six scenarios drive the compiled binary against a real app: a file,
stdin, --run's gate, all three --runtime values with --cwd and --title,
the already-open focus rule, error exits, and the Help install item.
XT-03 is the only M5 parity row M5c owns.

Claude-Session: https://claude.ai/code/session_01TkACTWB5JoX7SjLxB8BauY
EOF
)"
```

---

## Self-review

**1. Spec coverage.** Every §16 requirement maps to a task:

| Spec | Requirement | Task |
|---|---|---|
| §16.1 | Symlink to `Resources/app/bin/jslab` in `~/.local/bin` | 6 (the path), 7 (the symlink) |
| §16.1 | "If `~/.local/bin` isn't on `PATH`, the dialog shows the line to add" | 7 (`installCli`'s message; the notice in `index.ts`) |
| §16.1 | Install for all users via `/usr/local/bin` + `osascript` | 7 (`installForAllUsers`, opt-in, refuses without an escalation hook) |
| §16.1 | The menu item becomes "Uninstall…" when a symlink is detected | 7 (`MenuModel.cliInstalled`, `cliStatus`) |
| §16.2 | `jslab [file ...]` | 4, 6, 8 |
| §16.2 | `jslab -` (stdin) | 4, 6, 8 |
| §16.2 | `--run` | 2 (`present`), 3 (`cliDispatch`), 4, 8 |
| §16.2 | `--runtime bun\|browser\|browser-node` | 1 (`RUNTIMES`), 4, 8 (all three exercised) |
| §16.2 | `--lang ts\|js\|tsx\|jsx`, defaulting from extension then settings | 1 (`CLI_LANG_ALIASES`), 2 (`languageForPath` / `defaults()`), 4 |
| §16.2 | `--cwd <dir>`, defaulting to the current dir for `-` | 2 (`workingDirectory`), 6 (`main.ts`'s default), 8 |
| §16.2 | `--title <title>` | 2, 4, 8 |
| §16.2 | `--version` / `--help` | 4, 6 |
| §16.3 | Unix socket at `<appdata>/jslab.sock`, mode 0600, NDJSON | as-built (`socket-server.ts`); 5 (the client side) |
| §16.3 | `open`'s params and the `{ id, ok, tabIds }` reply | 1, 2, 3 |
| §16.3 | `open -b dev.jslab.app` + a 10 s poll, never process arguments | 5 |
| §16.3 | "Paths are made absolute by the CLI" | 1 (the schema refuses relative), 6 (`main.ts` resolves) |
| §16.3 | "Code runs only when `--run` is passed" | 2 (`present({ run })`), 8 (the scenario asserts silence without it) |
| §16.3 | `e2e.*` never available in normal launches | 3 (`open` registers *above* the untouched guard; Task 3 Step 10 verifies `e2e.state` is refused) |
| §18 | 0600 under the user's app data; `--run` required; `e2e.*` gated | as-built + 2 + 3 |
| §19 | Nested-binary signing | **M6's, stated explicitly in Global Constraints; M5c does not attempt it** |
| §22.3 | The "CLI open/run" E2E scenario | 8 |

**2. Placeholder scan.** No "TBD", no "add appropriate error handling", no "similar to Task N". Every code step carries the real code. Every error message in the plan is the literal string the tests assert. The one deliberately deferred item — signing — is named as M6's with a spec citation, not left vague. `$JSLAB_DEVKIT_SOURCE` and `$HOME` are environment variables the executor supplies, used to keep personal paths out of the committed file, not placeholders for undecided content.

**3. Type consistency.** Checked name by name across tasks:

- `CliOpenParams` / `CliOpenResult` (Task 1) are the exact types of `SocketMethodDeps.open` (Task 3) and of `createOpenService`'s returned function (Task 2). `CliOpenResult` is `{ tabIds: string[] }` in all three.
- `cliOpenParamsSchema` is parsed in exactly one place (Task 3's method), so the binary never double-validates.
- `CLI_LANG_ALIASES` maps to `Language`, which is what `CliOptions.lang` (Task 4) and `CreateTabOptions.language` (Task 2) both are. The wire carries `Language`, never `"ts"`.
- `CliOptions` (Task 4) is consumed only by `main.ts` (Task 6), which converts it to the wire shape field by field.
- `CliTransport` / `CliConnection` (Task 5) are used by `connectOrLaunch` and by `main.ts`; `bunTransport` satisfies `CliTransport`.
- `AppPaths.cliBinary` (Task 6) is `CliInstallDeps.target` (Task 7) — one string, one meaning.
- `MenuModel.cliInstalled` (Task 7) is set from `cliStatus(...).installed` (Task 7), the same boolean in both.
- `UiDispatch.dispatch` takes `CommandId`, which is what `rpc.send["menu.command"]` already carries.
- `CreateTabOptions.workingDirectory` (Task 2) is `string | null`, matching `tabStateSchema.workingDirectory`'s `optionalPath`; `CliOpenParams.cwd` is `string | undefined` and Task 2 converts with `?? null` in one place.
- Existing tests that must be updated because a type widened are named in the tasks that widen them: `shell.test.ts` (Task 6, `toEqual` on the whole `AppPaths`), `e2e-bridge.test.ts` (Task 3, the method-table keys), `menu.test.ts` and `app-handlers.test.ts` (Task 7).

**4. Gaps found and closed during review.**
- The original task split registered `open` before the method-table guard but left `startSocketServer` inside `if (e2eEnabled)` — which would have shipped a CLI with no socket to talk to in any normal launch. Task 3 now moves both, and fails soft on a second instance.
- `CreateTabOptions` had no `workingDirectory`, so `--cwd` had nowhere to land. Task 2 adds it.
- `--run` originally called `RunCoordinator.start` directly, which races the `file.opened` push and bypasses the UI's own run bookkeeping. It now reuses `menu.command`, with `createUiDispatch` covering the closed/booting window.
- `bun build --compile` inside `build:bundles` was the obvious placement and is the one Cottontail is most likely to reject. Task 6 compiles under real Bun from the repo root and leaves a fail-loud guard, which also makes the wiring testable without Hutch.
