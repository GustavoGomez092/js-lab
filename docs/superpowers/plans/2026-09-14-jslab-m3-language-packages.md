# JSLab M3: Language & Packages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install an npm package, import it with types and autocomplete, and use it from a working-directory file. Along the way JSLab gains per-runtime TypeScript editor configuration with bundled Node and Bun types, an `.npmrc`-isolated npm service with a packages sheet, install assist, an environment variables sheet, per-tab working directories, and the Build settings tab. Every user-visible behavior has an end-to-end scenario.

**Architecture:**
- **Foundations first.** The debug report stops leaking home paths and unknown settings (FA-m12) before any npm or env data exists. Settings move to v3 with `npm` and `build` sections. The app data folder gains `packages/`, `npm-home/` and `env.json`. The zod schemas for every new payload land before any service or UI uses them.
- **npm isolation per M0-S8.** A new pure package, `@jslab/npm`, owns spec parsing, `.npmrc` reading, the isolated spawn environment (`HOME=<dataDir>/npm-home`, an explicit `BUN_INSTALL_CACHE_DIR`, and `BUN_CONFIG_*`/`NPM_CONFIG_*`/`npm_config_*` stripped), output parsers, error classification, the operation queue and the `.d.ts` closure collector. Main's `NpmService` and `TypesService` wrap it with real spawn, fetch and file system adapters.
- **A local registry for tests.** A new private package, `@jslab/test-registry`, starts Verdaccio (a pinned devDependency) under a temp folder on a free port, tracks its PID, publishes fixture packages from folders generated at test time, and tears Verdaccio down by PID. The npm integration suite and the npm E2E suite are opt-in (`bun run test:npm`, `bun run e2e:npm`); `bun run test` and `bun run e2e` never start a registry.
- **The editor's TypeScript environment is per runtime.** Monaco's TypeScript defaults are global, so a framework-free `TsEnvironment` computes compiler options, diagnostics options and the extra-lib set for the shown tab (its runtime, `build.decorators`, `editor.linting`, its working-directory types) and re-applies them whenever the shown tab or those inputs change. `@types/node`, `undici-types` and `bun-types` ship as lazily loaded Vite chunks.
- **Working directory per tab.** Main builds each tab's runner spawn configuration from that tab's working directory: `cwd`, `NODE_PATH=<WD>/node_modules:<packages>/node_modules`, and the environment layered login shell → `env.json` → the WD's `.env` → `JSLAB=1`. The transform rewrites `__dirname`, `__filename`, `import.meta.dir/path` and relative specifiers against the WD. Spares are keyed by that configuration, so a WD, env or `.env` change recycles them.

**Tech Stack:**
- Everything pinned in M1 and M2: Electrobun 2.0.1 + Hutch 0.24.3, Bun (bundled 1.4.0), TypeScript 7.0.2, Biome 2.5.13, React 19.3.0, Vite 8.3.0, `monaco-editor` 0.56.0 (TypeScript 5.9.3 inside its worker), zustand 5.0.15, zod 4.6.4, `@babel/standalone` 8.0.5, happy-dom 20.14.5, `@testing-library/react` 16.3.3, `prettier` 3.8.3, `monaco-vim` 0.4.2.
- New in M3, all already resolved in `bun.lock` except Verdaccio:
  - `bun-types` 1.4.2, `@types/node` 22.20.2 and `undici-types` 6.21.0 as exact `devDependencies` of `@jslab/ui`. They are the versions the lockfile already holds through `@types/bun` 1.4.2, so installing them needs no new download.
  - `verdaccio` as an exact `devDependency` of `@jslab/test-registry` (ruling R-M3-REG-1: the user chose Verdaccio). Task 8 Step 1 pins the newest 6.x exactly, after confirming its MIT license.

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md`. Read §4.5, §4.6 (`loginShellEnv`), §5.2–§5.4, §6.1–§6.3, §6.5 (the `Cmd+I` row), §7.4 (Actions and Tools), §7.5, §8 (NPM and Build rows), §11, §12, §18, §20, §22.1–§22.3 and §26 before starting. Also read `docs/spikes/2026-09-m0-report.md` §S3 (dotenv control, `NODE_PATH`) and §S8 (the whole section; its Decision is binding), and `docs/parity.md` rows EX-30..33, LB-05, LB-07, ED-08..14, ED-26, TL-01..11, XT-12, TF-11, TF-18, TF-19 and ST-01.

**Prerequisite:** M2 is complete, including the M2 residual fix and the two CI commits (`d8974ab` adds `.github/workflows/release.yml` and `docs/history/`; `d481b19` makes `packages/transform/test/helpers.ts` import from a fresh `mkdtemp` folder). M3 runs on the `feat/jslab-m3` worktree, which starts at `d481b19`. Repo history was rewritten on 2026-09-14: commit ids cited in older docs map through `docs/history/2026-09-14-commit-map.txt`, and file contents and line numbers are unaffected. **Pre-flight (done):** every `path:line` anchor and quoted as-built snippet in this plan was re-verified against `d481b19`, and the line numbers were corrected in place. Each task's implementer still checks that every name under **Consumes** exists with the stated signature. If the code differs (for example after an unplanned commit), follow the code, keep this plan's behavior, and note the deviation in the commit body.

## Global Constraints

- **Clean room.** Never read RunJS binaries, `app.asar` or bundled JS (spec §0). Tell every research subagent this explicitly.
- **License and pins.** MIT license, with no GPL-family dependencies. Pin every dependency exactly, never with `^` or `~`, including `devDependencies`. Electrobun stays at 2.0.1 (`hutch.config.ts` `electrobun: { version: "2.0.1" }`).
- **Hutch.**
  - Hutch 0.24.3 is already installed at `~/.hutch`. NEVER run the Hutch installer, `hutch init` or `hutch upgrade`, and never edit `~/.zshrc`, any other shell profile, or `~/.hutch`.
  - Prefix every command that runs `bun install`, `hutch …`, `bun run lint|typecheck|test|test:npm` or `bun run e2e|e2e:npm` with `export PATH="$HOME/.hutch/bin:$PATH" && `.
  - Never run `tsc` directly; always use `bun run typecheck` (the devkit tsconfig is regenerated by `hutch electrobun prepare`).
  - Inside `hutch.config.ts` scripts, `bun` is Hutch's Cottontail runtime: never write `bun run` or `bun x` there; use `cd <dir> && bunx <bin>`.
  - `bun install` steps follow the M2 practice: the controller records its environment checks before and after. The implementer runs `bun install` only where a step says so.
- **Shell (zsh).** Use `builtin cd`. No zsh glob qualifiers. Collect PIDs into arrays (`pids=( $(pgrep -P "$pid") )`) and signal one PID at a time in a `for p in "${pids[@]}"` loop. Never hide `kill` errors without re-checking with `ps`.
- **Process roles.** User code never runs in Main (spec §4.1). Every UI → Main payload, including Settings-window and E2E-agent payloads, is zod-validated in Main before use (spec §18). An invalid request throws `InvalidPayloadError`; an invalid message is logged and dropped.
- **No blocking native dialogs in RPC handlers.** The working-directory folder picker uses the message + result-message pattern (`wd.pick` → `wd.changed`), like the M2 Open dialog.
- **Strings.** New user-visible strings live in `apps/ui/src/strings.ts` or `apps/desktop/src/main/strings.ts`. `@jslab/npm` and `@jslab/test-registry` contain no user-visible strings; Main sends error *kinds*, and the UI maps them to hints.
- **TDD.** All pure logic is test-first: write the test, watch it fail, implement, watch it pass.
- **Task gates.** `bun run lint`, `bun run typecheck` and `bun run test` pass at the end of every task. E2E scenarios, the npm integration suite and the npm E2E suite are not part of `bun run test`.
  - **Formatting.** Code blocks in this plan are not pre-wrapped to Biome's 120-column layout, and `biome check` fails on formatting. Run `export PATH="$HOME/.hutch/bin:$PATH" && bun run format` before `bun run lint`, and review the diff it makes: it may only reformat.
- **(a) Bun 1.4.0 gates (R-CI-1).** CI and the packaged app run Bun 1.4.0, which may differ from the local default `bun`. Every "Run every gate" step also runs the unit suite under Bun 1.4.0 through a temporary PATH shim, and so does every step that runs `bun run test:npm`:

  ```bash
  shim="$(mktemp -d "$TMPDIR/jslab-bun140-XXXXXX")" && ln -s "$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64/bun" "$shim/bun" && export PATH="$shim:$HOME/.hutch/bin:$PATH" && bun --version && bun run test; status=$?; rm -rf "$shim"; exit $status
  ```

  Expected: `bun --version` prints `1.4.0`, and the counts equal the local run's. Run it in a subshell (`( … )`) or its own shell call, so the `exit` and the PATH change end with it. A test that passes only on the local default is a failure.
- **(b) Temp modules (R-CI-1).** Test or runtime code that writes a module and then imports or runs it uses a fresh `mkdtemp` folder (resolved with `realpath` when a path is compared) and a `file://` URL (`pathToFileURL`), never a file created directly in `os.tmpdir()`/`$TMPDIR`. Bun 1.4.0 can't import files created directly in the symlinked macOS temp folder (`d481b19`).
- **(c) CI parity (R-CI-1).** `.github/workflows/ci.yml` (`bun install --frozen-lockfile`, `bun run lint`, `bun run typecheck`, `bun run test`) and `release.yml` (the same checks, then `hutch run build`) run on `macos-14` with Bun 1.4.0 and Hutch 0.24.3. CI was green on `d481b19` with 628 unit tests.
  - Any new root script that CI runs must work there. `test:npm` and `e2e:npm` are never added to either workflow.
  - An opt-in suite never runs in `bun run test` or `bun run e2e`. A package that hosts one gets `bunfig.toml` `[test] root = "./test"` (the FA-m17 pattern of `packages/e2e`), its `test` script names `./test`, and its opt-in folder is named so that it doesn't share a prefix with `test` or `scenarios` (`integration/`, `integration-npm/`, `npm-scenarios/`). The task that adds one confirms that the `bun run test` (or `bun run e2e`) count doesn't change; if it does, stop and report both numbers.
  - New lockfile entries must install with `--frozen-lockfile` on `macos-14`.
- **Commits.** Conventional Commits. The controller exports `JSLAB_COMMIT_TRAILER` (the session attribution line) in every dispatch. Commit with `git commit -m "<subject>" -m "$JSLAB_COMMIT_TRAILER"`. After each commit, `git status --porcelain` is empty; stage every file the task changed. No push (no remote is configured).
- **Temporary files.** Agents put temporary files in their session scratchpad, never in `/tmp`. The manual QA folder `$JSLAB_QA_DIR` is a folder under that scratchpad, on internal disk. Product and test code uses `os.tmpdir()` (`$TMPDIR` on macOS), or `JSLAB_E2E_TMPDIR` when set. Unix socket paths stay ≤ 103 bytes.
- **Privacy.** No absolute home paths, user names, session ids or external-volume paths in code, fixtures, docs or commit messages. Captured tool output is normalized (`<REGISTRY>`, `<TMP>`, `<ms>`, `<rev>`) before it is committed.
- **E2E.**
  - Every task that adds user-visible behavior in the app window adds at least one scenario: under `packages/e2e/scenarios/` when it needs no registry, under `packages/e2e/npm-scenarios/` when it does. (Task 29's app icon shows in Finder and the Dock, which scenarios can't observe; it's verified from the build output instead.)
  - Scenarios run locally against a dev build: `builtin cd apps/desktop && hutch run build:dev`, then `bun run e2e` (and `bun run e2e:npm` for the npm suite) from the repo root. The final task runs both against the packaged canary.
  - **Launch cwd.** Every scripted app launch runs with its working directory on internal disk; the harness passes `cwd: userData`.
  - **Agents never send OS input** (no System Events, no `osascript` UI scripting, no synthetic keystrokes or drops at the OS level). All automation goes through `e2e.*` on the socket.
  - **Process control is by tracked PID only.** Never `pkill -f`, `pgrep -f` or any match by name or path, except the scoped canary teardown in Task 30.
  - **The post-run `ps` check is read-only:** report survivors, never kill them.
  - **Long commands.** For `hutch run build:dev`, `bun run e2e`, `bun run e2e:npm` and `bun run test:npm`, set the shell tool `timeout` to 600000. If a run may take longer, redirect it to a log under `$TMPDIR`, start it in the background, and poll in the foreground with this one-liner until the summary appears (never end the turn to wait, never use Monitor tools or armed notifications):

    ```bash
    perl -e 'alarm 580; my $f = shift; while (1) { if (open my $h, "<", $f) { local $/; my $t = <$h>; if ($t =~ /^\s*\d+ pass\b.*?^\s*\d+ fail\b/ms) { print "$&\n"; exit 0 } } sleep 5 }' "$TMPDIR/jslab-e2e.log"
    ```

  - **After `tab.new`, wait for the new tab** with `app.newTab()`.
  - **Screenshots** are window-only through `e2e.screenshot`, gated by `Utils.screenCapture.hasAccess()`. Nothing ever requests the permission; a skip is acceptable.
- **npm environment.**
  - Never read, write, move or delete the user's `~/.npmrc`, `~/.bunfig.toml`, `$XDG_CONFIG_HOME/.bunfig.toml`, or any global npm or Bun configuration. No test sets `HOME` to the real home.
  - No global installs (`bun add -g`, `npm i -g`) anywhere, including in steps.
  - No public registry in tests. Every test `.npmrc` points at the local test registry or at a dead local port (`http://127.0.0.1:9/`). Registry traffic in tests stays on `127.0.0.1`.
  - Verdaccio runs only under a temp folder (`os.tmpdir()`), on a free port, started by `@jslab/test-registry` with its PID tracked and stopped by that PID.
  - Package caches: in production the npm service sets `BUN_INSTALL_CACHE_DIR` to the user's Bun cache (spec §11.3, M0-S8). Tests and scenarios always set it to a temp folder. Nothing ever deletes or cleans a user cache.
  - npm operations always spawn `process.execPath` (the bundled Bun) with `cwd=<dataDir>/packages`.
- **As built (M2), kept by every M3 edit.**
  - `SparePool` keys a spare by `Bun.hash(JSON.stringify([bunPath, bootstrapPath, cwd, env]))` and pre-warms only the active tab (`spare-pool.ts:27`, `:77`).
  - `BunRunnerProcess.start` spawns `[bunPath, "--no-env-file", bootstrapPath]` detached with `serialization: "json"` (`bun-runner-process.ts:64-79`).
  - The runner's user-facing `process.exit` flushes output and throws `EXIT_SIGNAL` (`bootstrap.ts:187-202`).
  - `createValidators(log)` / `mergeHandlers(...)` are the handler-group pattern (`rpc/validate.ts`, `rpc/workspace-handlers.ts:32`).
  - The UI view-message router lists every `ViewMessages` key in `VIEW_MESSAGES` with a type-level exhaustiveness check (`apps/ui/src/view-messages.ts:4-21`); every new view message is added there in the same task.
  - `fake-api.ts` builds a `MainApi` with `satisfies MainApi`; every new `MainApi` method is added there in the same task.
- **Monaco `lib` names (controller finding, PR #1).** Monaco `compilerOptions.lib` takes full lib file names (`lib.esnext.d.ts`), never tsconfig short names; editor type-environment tests assert real `TypeScriptWorker` diagnostics. (Short names leave the DOM lib unloaded, so the editor shows TS2584 for `console` and TS2304 for `setTimeout` and `URL`.)
- **Runtime availability.** Only `bun` executes in M3 (`AVAILABLE_RUNTIMES = ["bun"]`); browser runtimes arrive in M4. The editor's TypeScript environment is built and tested for all three runtimes now.

## Test counts

Anchor: the **M2 final** totals at `d481b19` (CI-green): **628 unit tests** — `@jslab/shared` 42, `@jslab/themes` 8, `@jslab/rpc-schema` 14, `@jslab/serializer` 31, `@jslab/transform` 54, `@jslab/runner-bun` 35, `@jslab/ui` 226, `@jslab/desktop` 207, `@jslab/e2e` 11 — and **48 scenarios**. PR #1 (the Monaco `lib` file-name fix and its `TypeScriptWorker` regression test in `apps/ui/test/ts-lib.test.ts`) lands before M3 starts. For `@jslab/ui` only, "M2 final" below means that M3 base, 226 plus the tests PR #1 adds; the controller records that number at dispatch. Every expected count below is written as **"M2 final + N"** per package. The controller turns them into numbers in each dispatch (for example `@jslab/desktop` M2 final + 11 = 218). If a runner report differs from the plan, stop and report both numbers.

New packages start at 0: `@jslab/npm` and `@jslab/test-registry`. E2E scenarios are counted separately: **scenarios** (`bun run e2e`) and **npm scenarios** (`bun run e2e:npm`, new in M3, starting at 0). The npm integration suite (`bun run test:npm`) is counted as **npm integration tests**, starting at 0.

| After task | shared | rpc-schema | transform | runner-bun | desktop | ui | npm | test-registry | scenarios | npm scenarios | npm integration |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | +0 | +0 | +0 | +0 | +2 | +0 | 0 | 0 | +0 | 0 | 0 |
| 2 | +2 | +0 | +0 | +0 | +2 | +1 | 0 | 0 | +1 | 0 | 0 |
| 3 | +2 | +0 | +0 | +0 | +6 | +1 | 0 | 0 | +1 | 0 | 0 |
| 4 | +7 | +0 | +0 | +0 | +11 | +1 | 0 | 0 | +1 | 0 | 0 |
| 5 | +7 | +4 | +0 | +0 | +11 | +1 | 0 | 0 | +1 | 0 | 0 |
| 6 | +7 | +4 | +0 | +0 | +11 | +1 | 0 | 0 | +1 | 0 | 0 |
| 7 | +7 | +4 | +0 | +0 | +11 | +1 | 10 | 0 | +1 | 0 | 0 |
| 8 | +7 | +4 | +0 | +0 | +11 | +1 | 10 | 3 | +1 | 0 | 3 |
| 9 | +7 | +4 | +0 | +0 | +11 | +1 | 10 | 4 | +1 | 0 | 3 |
| 10 | +7 | +4 | +0 | +0 | +11 | +1 | 18 | 4 | +1 | 0 | 3 |
| 11 | +7 | +4 | +0 | +0 | +16 | +1 | 21 | 4 | +1 | 0 | 3 |
| 12 | +7 | +4 | +0 | +0 | +19 | +1 | 21 | 4 | +1 | 0 | 8 |
| 13 | +7 | +4 | +0 | +0 | +21 | +1 | 26 | 4 | +1 | 0 | 8 |
| 14 | +7 | +4 | +0 | +0 | +28 | +1 | 26 | 4 | +1 | 0 | 8 |
| 15 | +7 | +4 | +6 | +0 | +29 | +1 | 26 | 4 | +1 | 0 | 8 |
| 16 | +8 | +4 | +11 | +0 | +33 | +1 | 26 | 4 | +1 | 0 | 8 |
| 17 | +8 | +4 | +11 | +1 | +34 | +1 | 26 | 4 | +1 | 0 | 8 |
| 18 | +8 | +4 | +11 | +1 | +45 | +1 | 26 | 4 | +1 | 0 | 8 |
| 19 | +8 | +4 | +11 | +1 | +47 | +5 | 26 | 4 | +2 | 0 | 8 |
| 20 | +8 | +4 | +11 | +1 | +47 | +13 | 26 | 4 | +2 | 0 | 8 |
| 21 | +8 | +4 | +11 | +1 | +47 | +18 | 26 | 4 | +4 | 0 | 8 |
| 22 | +9 | +4 | +11 | +1 | +48 | +21 | 26 | 4 | +5 | 0 | 8 |
| 23 | +9 | +4 | +11 | +1 | +48 | +29 | 26 | 4 | +6 | 0 | 8 |
| 24 | +11 | +4 | +11 | +1 | +48 | +33 (+34 Branch B) | 26 | 4 | +8 | 0 | 8 |
| 25 | +11 | +4 | +11 | +1 | +48 | +37 (+38) | 26 | 4 | +9 | 0 | 8 |
| 26 | +11 | +4 | +11 | +1 | +48 | +44 (+45) | 26 | 4 | +10 | 0 | 8 |
| 27 | +11 | +4 | +11 | +1 | +48 | +47 (+48) | 26 | 4 | +12 | 0 | 8 |
| 28 | +11 | +4 | +11 | +1 | +48 | +47 (+48) | 26 | 4 | +12 | 4 | 8 |
| 29 | +11 | +4 | +11 | +1 | +50 | +47 (+48) | 26 | 4 | +12 | 4 | 8 |
| 30 (M3 final, Branch B) | 53 | 18 | 65 | 36 | 257 | base + 48 | 26 | 4 | 60 | 4 | 8 |

The M2 final base per column is shared 42, rpc-schema 14, transform 54, runner-bun 35, desktop 207, ui 226 + PR #1's tests, scenarios 48. `@jslab/serializer` (31), `@jslab/themes` (8) and `@jslab/e2e` (11) stay at their M2 final counts. M3 adds 155 unit tests, so the M3 final total is 628 + PR #1's tests + 155 (**783** + PR #1's tests, Branch B). Task 20 keeps PR #1's regression test (moved, not deleted), so its ui delta is +8. Each task states its own delta and the running value from this table. The `ui` figures in parentheses apply when ruling R-M3-SPIKE-1 selects Task 24 Branch B (its folder-drop test). Branch A instead adds `@jslab/desktop` +1 (the `wd.set` handler test) and 1 scenario (the native-drop scenario) from Task 24 on, and no ui folder-drop test. A static `grep` of `test(` undercounts; always use the runner's reported numbers.

## File map (new or substantially changed in M3)

```
packages/shared/src/
  settings.ts           v3: npm and build sections, BuildSettings, runnerSettings().build
  migrations.ts         SETTINGS_MIGRATIONS[2] (v2 → v3)
  packages.ts           DEFAULT_REGISTRY, DEFAULT_NPMRC, DEFAULT_PACKAGES_MANIFEST
  dotenv.ts             parseDotenv (JSLab's own .env parser, spec §5.3)
  env-vars.ts           ENV_KEY_PATTERN, envVarsSchema, envFileSchema, validateEnvRows
  tabs.ts               tabLabel, scriptFileName
  commands.ts           "tools" category; tools.npmPackages, tools.environmentVariables, wd.set, wd.clear, npm.install
  keybindings.ts        cmd+i → tools.npmPackages
packages/rpc-schema/src/ui-rpc.ts          npm, env, working-directory, types and .npmrc contracts
packages/npm/                              NEW @jslab/npm (pure)
  src/specifiers.ts     packageNameFromSpecifier, parseInstallSpec, typesPackageName, NODE_BUILTINS
  src/npmrc.ts          parseNpmrc, registryFor, authTokenFor
  src/environment.ts    resolveBunCacheDir, npmEnvironment (M0-S8 isolation)
  src/ansi.ts           stripAnsi (Task 9; shared with @jslab/test-registry's normalizer)
  src/output.ts         parseOutdated, parseInstalled, classifyNpmFailure, detectNotice, parseSearchResponse
  src/queue.ts          OperationQueue (serialized, 5 min timeout)
  src/type-closure.ts   collectPackageTypes, collectLocalTypes (injected TypesFs)
  test/fixtures/bun-output/*.json          captured, normalized bun add/remove/outdated output (Task 9)
packages/test-registry/                    NEW @jslab/test-registry (private; Verdaccio lifecycle and fixtures)
  src/config.ts, src/free-port.ts, src/registry.ts, src/fixtures.ts, src/normalize.ts, scripts/capture-bun-output.ts
  bunfig.toml           [test] root = "./test" (opt-in integration/ never runs in bun run test)
apps/desktop/src/main/
  app-paths.ts          packagesDir, packagesJson, packagesNpmrc, npmHome, envFile; runnerEnvironment layering
  logging/debug-report.ts                  home-path and structured settings redaction (FA-m12)
  persistence/          json-store.ts (write-time serialization), atomic-write.ts (shouldCommit)
  platform/login-shell-env.ts              §4.6 loginShellEnv adapter
  runs/runner-config.ts tab-aware RunnerSpawnConfig (WD, NODE_PATH, env.json, .env)
  runs/spare-pool.ts    invalidateAll
  runs/run-coordinator.ts                  build settings, working directory, missing-WD error, exitRequested
  services/             packages-project.ts, env-store.ts, npm-service.ts, npm-spawn.ts, types-service.ts,
                        settings-store.ts (write timeout), session-store.ts (setWorkingDirectory)
  rpc/                  npm-handlers.ts, env-handlers.ts, wd-handlers.ts, types-handlers.ts, npmrc-handlers.ts
  quit.ts, ui-flush.ts  UI state flush before the quit flush (X1)
apps/desktop/integration-npm/              opt-in npm integration suite (bun run test:npm)
apps/desktop/bunfig.toml                   [test] root = "./test"
apps/desktop/scripts/app-icon.ts, build-app-icon.ts, assets/app-icon-1024.png, icon.iconset/   app icon (Task 29)
packages/transform/src/ build.ts (proposal plugins), working-directory.ts (WD plugin), transform.ts, types.ts
packages/runner-bun/src/bootstrap.ts       exitRequested (FW1)
apps/ui/
  vite-plugins/type-libs-plugin.ts         Vite plugin: bundled @types/node, undici-types, bun-types packs (not build/: Biome ignores **/build)
  isolated/app.test.tsx                    the module-mocked App tests, run in their own bun test process
  src/editor/           ts-environment.ts, type-libs.ts, type-feeder.ts, install-assist.ts, models.ts, tab-view.ts, Editor.tsx
  src/state/            buffer-sync.ts, store.ts (npm slice, modal kinds)
  src/npm/              NpmSheet.tsx, npm-panel.ts
  src/env/              EnvVarsSheet.tsx, env-table.ts
  src/shell/            StatusBar.tsx (WD chip), ActivityBar.tsx (NPM enabled)
  src/settings/         NpmrcEditor.tsx, npmrc-monaco.ts, fields.ts (npm/build), SettingsApp.tsx
packages/e2e/scenarios/                    typescript, types-local, tools, working-directory, environment, npm-panel
packages/e2e/npm-scenarios/packages.test.ts                 zod exit scenario, install assist, install scripts
docs/user/bun-vs-node.md, docs/qa/m3-checklist.md, docs/spikes/2026-09-m3-native-drop.md
```

## M3 decisions recorded in this plan

These refine the controller's binding defaults (R-M3-PLAN-1) or the spec, each with its reason. Task 30 amends the spec for each.

1. **No `SESSION_VERSION` bump.** The v2 session schema already stores `workingDirectory` (`packages/shared/src/session.ts:35`, `optionalPath` with a `null` default), and no M2 build ever wrote a non-null value. A version bump would add a no-op migration. Task 24 adds a round-trip test instead.
2. **The NPM Packages and Environment Variables UIs are modal sheets** (spec §7.5 table), opened from the activity bar, `Cmd+I`, the Tools menu and the palette. The side bar keeps hosting Snippets and AI Chat (M5).
3. **Babel 8 always enables `declare` fields.** `@babel/standalone` 8.0.5 throws if `allowDeclareFields` is passed, so spec §5.4's option is dropped; LB-07 is satisfied by the default. `onlyRemoveTypeImports: false` is also Babel 8's default and is passed explicitly.
4. **Regexp modifiers** use Babel's `transform-regexp-modifiers`; there is no `proposal-regexp-modifiers` in Babel 8.
5. **WD-local types** are registered at `file:///tab/<path relative to the WD>`, matching the models' `file:///tab/<tabId>.<ext>` URIs, so relative imports resolve. Imports that leave the WD (`../x` above the WD root) get no editor types (runtime resolution is unaffected).
6. **The zod fixture** for the exit scenario is the zod 4.6.4 package already installed as a workspace dependency, packed and published to the local registry at test time. No tarball is checked in, and no network is used.
7. **git-over-SSH** specs under the overridden `HOME` are a documented limitation with a unit test that `SSH_AUTH_SOCK` and `GIT_SSH_COMMAND` pass through to npm operations; a real git-over-SSH install is a manual QA item.
8. **Native folder drop** depends on the Task 6 spike. If Electrobun 2.0.1 delivers no dropped path to Main, WD is set by the picker, the chip and the menu only, and TF-11/§7.3 record the deviation.
9. **The test registry is Verdaccio (ruling R-M3-REG-1, the user's choice).** It's a pinned, MIT-licensed devDependency of `@jslab/test-registry` only: started by the opt-in suites under a temp folder on a free loopback port, stopped by tracked PID, never installed globally, never shipped in the app, and never started by `bun run test`, `bun run e2e` or CI. If it can't run under the bundled Bun 1.4.0, Task 8 stops with evidence, and the controller rules on an in-repo fake registry.
10. **App icon (branding carry).** The CI build log shows `hutch electrobun: macOS icon source not found: apps/desktop/icon.iconset`. Task 29 commits a Graphite-style source image and a generated `icon.iconset`.

## Task index

| # | Task | Phase | Parity rows |
|---|---|---|---|
| 1 | Debug report: home paths and structured settings redaction (FA-m12) | Foundations | ST-10 (kept ✅) |
| 2 | Settings v3: NPM and Build sections, fields and strings | Foundations | LB-05, ST-01 |
| 3 | Persistence hardening: write-time session serialization (FA-m9) and a settings write timeout (RR1-m2) | Foundations | (carry) |
| 4 | Data paths, the packages project, `env.json` store and the `.env` parser | Foundations | TL-11, EX-32 |
| 5 | RPC schemas for npm, env, working directory, types and `.npmrc` | Foundations | (contracts) |
| 6 | Spike: native folder drop on Electrobun 2.0.1 (read-only) — **planned stop** | Foundations | TF-11 |
| 7 | `@jslab/npm`: specifiers, `.npmrc` and the isolated npm environment | Foundations | TL-03, TL-04, TL-10 |
| 8 | `@jslab/test-registry`: Verdaccio lifecycle and fixtures (ruling R-M3-REG-1: Verdaccio) — **stop only if Verdaccio can't run under Bun 1.4.0** | Foundations | (test infra) |
| 9 | Capture real `bun add`/`remove`/`outdated` output — **planned stop if formats differ** | Foundations | TL-09 |
| 10 | `@jslab/npm`: output parsers, error classification and search parsing | Services | TL-02, TL-06, TL-09 |
| 11 | Operation queue and `NpmService` install/remove/update, with the injected S8 regression | Services | TL-03, TL-05, TL-07, TL-10 |
| 12 | `NpmService` list, outdated, search and auto `@types`; the opt-in npm integration suite | Services | TL-02, TL-06, TL-07, TL-08, TL-09, TL-10, XT-12 |
| 13 | Type closure collector and `TypesService` | Services | ED-13 |
| 14 | Runner environment: login shell, `env.json`, `.env`, `NODE_PATH`, tab-aware spares | Services | EX-32, TL-05, TL-11 |
| 15 | Transform: Build settings (proposals and decorators) | Services | LB-05, LB-07 |
| 16 | Working directory in runs: WD transform plugin, coordinator, missing-WD error | Services | EX-30, EX-31 |
| 17 | Runner exit semantics after a caught `process.exit` (FW1-exit-trycatch) | Services | (carry) |
| 18 | Main RPC handlers and composition for npm, env, WD, types and `.npmrc` | Services | TL-01..11 (Main side) |
| 19 | UI carries: buffer sync (X5), view-state flush on quit (X1), isolated App tests (T19A-mock) | UI | (carries) |
| 20 | Per-runtime TypeScript environment and bundled type libraries | UI | ED-09, ED-14 |
| 21 | Editor wiring: re-apply on show, linting, model swap order, E2E type hooks | UI | ED-08..12, ED-14 |
| 22 | MainApi additions, commands, keybindings and menus for Tools and working directory | UI | TL-01, EX-30 |
| 23 | Type feeder and install assist | UI | ED-13, ED-26, XT-12 |
| 24 | Working directory UI: chip, label suffix, picker, missing-WD action, folder drop | UI | EX-30, EX-33, TF-19, TF-11 |
| 25 | Environment Variables sheet | UI | TL-11 |
| 26 | NPM Packages sheet | UI | TL-01..07, TL-09 |
| 27 | Settings window: NPM (`.npmrc` editor) and Build tabs | UI | TL-10, LB-05, ST-01 |
| 28 | Opt-in npm E2E suite and the zod exit scenario | E2E-integration | ED-13, ED-26, TL-03..07, XT-12, EX-30 |
| 29 | App icon: Graphite source image and a generated `icon.iconset` | Branding | (carry: no icon in CI builds) |
| 30 | `docs/user/bun-vs-node.md`, M3 QA checklist, spec amendments, parity, roadmap, full runs | Docs | all of the above |

---

### Task 1: Debug report: home paths and structured settings redaction (FA-m12)

**Files:**
- Modify: `apps/desktop/src/main/logging/debug-report.ts:1-31` (rewrite)
- Modify: `apps/desktop/src/main/rpc/app-handlers.ts:1-21` (imports, `AppHandlerDeps`), `:48-60` (`runAppAction`'s `copyDebugLog` case)
- Test: `apps/desktop/test/logging/logging.test.ts:102-136` (the `debug report` describe), `packages/e2e/scenarios/help.test.ts:13-26`

**Interfaces:**
- Consumes: `createRedactor(secrets?)` and `Redactor` (`logging/redact.ts:1-26`); `SETTINGS_SECTIONS`, `defaultSettings`, `Settings` from `@jslab/shared`.
- Produces:
  - `DebugReportInput` gains `home: string`.
  - `redactHomePaths(text: string, home: string): string`
  - `redactSettings(settings: Settings, text: (value: string) => string): Record<string, unknown>`
  - `AppHandlerDeps.home?: string` (defaults to `os.homedir()`). Task 18 wires the env-store secrets into the redactor.

**Rules (spec §18, §20; carry FA-m12):**
- The report never contains the user's home folder or any `/Users/<name>` prefix. They are written as `~`.
- The `settings` part holds only schema-defined fields per section, plus `version`. Keys a hand edit added, in known or unknown sections, are dropped. Every string field goes through the secret redactor and the home redaction.
- The report never contains `.npmrc` content or `env.json` values: neither is a setting, and both are masked in log lines by the redactor (Task 18 passes env values as `secrets`).
- The top-level keys stay exactly `version, bunVersion, electrobunVersion, macOS, arch, settings, log`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/test/logging/logging.test.ts`:

1. Add `mergeSettings` and `settingsSchema` to the `@jslab/shared` import at the top of the file.
2. After the imports, add a fake home folder (built with `join`, so no literal home path appears in the source):

```ts
/** A fake macOS home folder for the FA-m12 redaction tests. */
const HOME_FIXTURE = join("/Users", "tester");
```

3. In both existing `debug report` tests (lines 103-135), add `home: HOME_FIXTURE,` to the object passed to `buildDebugReport`.
4. In the first test, replace `expect(report.settings.version).toBe(2);` (line 120) with `expect(report.settings.version).toBe(defaultSettings().version);`.
5. Append these tests inside `describe("debug report", …)`:

```ts
  test("writes the home folder and any other /Users/<name> prefix as ~ (FA-m12)", () => {
    const home = HOME_FIXTURE;
    const settings = mergeSettings(defaultSettings(), { appearance: { font: `${home}/Fonts/Custom Mono` } });
    const text = buildDebugReport({
      versions: { app: "0.3.0", bun: "1.4.0", electrobun: "2.0.1" },
      os: { macOS: "26.5.2", arch: "arm64" },
      settings,
      logLines: [`opened ${home}/proj/a.ts`, `spawn cwd "${join("/Users", "someone")}/x"`],
      redact: createRedactor(),
      home,
    });
    expect(text).not.toContain("/Users/");
    const report = JSON.parse(text);
    expect(report.settings.appearance.font).toBe("~/Fonts/Custom Mono");
    expect(report.log).toEqual(["opened ~/proj/a.ts", 'spawn cwd "~/x"']);
  });

  test("keeps only schema-defined settings fields and masks secret-looking strings (FA-m12)", () => {
    const settings = settingsSchema.parse({
      run: { autoRun: false, apiToken: "sk-proj-ABCDEFGHIJKLMNOPQRSTUV" },
      future: { password: "hunter2-value" },
      appearance: { font: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" },
    });
    const report = JSON.parse(
      buildDebugReport({
        versions: { app: "0.3.0", bun: "1.4.0", electrobun: "2.0.1" },
        os: { macOS: "26.5.2", arch: "arm64" },
        settings,
        logLines: [],
        redact: createRedactor(),
        home: HOME_FIXTURE,
      }),
    );
    expect(Object.keys(report)).toEqual(["version", "bunVersion", "electrobunVersion", "macOS", "arch", "settings", "log"]);
    expect(report.settings.run.autoRun).toBe(false);
    expect(report.settings.run).not.toHaveProperty("apiToken");
    expect(report.settings).not.toHaveProperty("future");
    expect(report.settings.appearance.font).toBe("[REDACTED]");
  });
```

In `packages/e2e/scenarios/help.test.ts`, add `import { homedir } from "node:os";` and, directly after the `const report = JSON.parse(…)` line in the first test, add:

```ts
  expect(readFileSync(clip, "utf8")).not.toContain(homedir());
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/logging/logging.test.ts`
Expected: FAIL. The new tests report `<HOME_FIXTURE>/Fonts/Custom Mono` where `~/Fonts/Custom Mono` is expected, and `apiToken` present in `report.settings.run`. The typecheck-level `home` property is accepted at runtime.

- [ ] **Step 3: Implement the redaction**

Replace `apps/desktop/src/main/logging/debug-report.ts` with:

```ts
import { defaultSettings, SETTINGS_SECTIONS, type Settings } from "@jslab/shared";
import type { Redactor } from "./redact";

export interface DebugReportInput {
  versions: { app: string; bun: string; electrobun: string };
  os: { macOS: string; arch: string };
  settings: Settings;
  logLines: string[];
  redact: Redactor;
  /** The user's home folder. Every occurrence in the report is written as `~` (FA-m12). */
  home: string;
}

const USERS_PREFIX = /\/Users\/[^/\s"',}\]]+/g;

/** Writes the home folder, and any other `/Users/<name>` prefix, as `~` (FA-m12). */
export function redactHomePaths(text: string, home: string): string {
  const withoutHome = home.length > 1 ? text.split(home).join("~") : text;
  return withoutHome.replace(USERS_PREFIX, "~");
}

/**
 * The settings part of the report (FA-m12): only the fields the schema defines, so keys a hand edit added never leave
 * the machine, and every string field goes through `text`. `.npmrc` content and env.json values are not settings and
 * never appear here.
 */
export function redactSettings(settings: Settings, text: (value: string) => string): Record<string, unknown> {
  const defaults = defaultSettings() as unknown as Record<string, Record<string, unknown>>;
  const current = settings as unknown as Record<string, Record<string, unknown> | undefined>;
  const out: Record<string, unknown> = { version: settings.version };
  for (const section of SETTINGS_SECTIONS) {
    const known = defaults[section] ?? {};
    const values = current[section] ?? {};
    const kept: Record<string, unknown> = {};
    for (const key of Object.keys(known)) {
      const value = values[key];
      kept[key] = typeof value === "string" ? text(value) : value;
    }
    out[section] = kept;
  }
  return out;
}

/**
 * Help → Copy Debug Log (spec §20). Redaction runs on each free-text field BEFORE JSON.stringify, not on the finished
 * JSON text: a pattern that eats trailing characters (I-1) could otherwise consume the quote, comma or brace that
 * JSON.stringify placed around it and corrupt the report.
 */
export function buildDebugReport(input: DebugReportInput): string {
  const text = (value: string) => redactHomePaths(input.redact(value), input.home);
  return JSON.stringify(
    {
      version: input.versions.app,
      bunVersion: input.versions.bun,
      electrobunVersion: input.versions.electrobun,
      macOS: input.os.macOS,
      arch: input.os.arch,
      settings: redactSettings(input.settings, text),
      log: input.logLines.slice(-500).map(text),
    },
    null,
    2,
  );
}
```

In `apps/desktop/src/main/rpc/app-handlers.ts`:

1. Add `import { homedir } from "node:os";` as the first import.
2. Add this member to `AppHandlerDeps`, after `redact: Redactor;`:

```ts
  /** The home folder written as `~` in the debug report (FA-m12); defaults to `os.homedir()`. */
  home?: string;
```

3. In `runAppAction`, replace the `buildDebugReport({ … })` argument object in the `copyDebugLog` case with:

```ts
        buildDebugReport({
          versions: deps.versions,
          os: deps.os,
          settings: deps.settings.current,
          logLines: deps.logTail(500),
          redact: deps.redact,
          home: deps.home ?? homedir(),
        }),
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/logging/logging.test.ts test/rpc/app-handlers.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/desktop` M2 final + 2; every other package at its M2 final count.

- [ ] **Step 6: Run the changed scenario**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/help.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: `3 pass`, `0 fail`. Then a read-only `ps -o pid,command -p <each PID the harness reported>` shows no survivors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/logging/debug-report.ts apps/desktop/src/main/rpc/app-handlers.ts apps/desktop/test/logging/logging.test.ts packages/e2e/scenarios/help.test.ts
git commit -m "fix(desktop): redact home paths and unknown settings from the debug report" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 2: Settings v3: NPM and Build sections, fields and strings

**Files:**
- Modify: `packages/shared/src/settings.ts:15-28` (constants), `:115-133` (sections), `:180-196` (runner settings)
- Modify: `packages/shared/src/migrations.ts:10-20`
- Modify: `apps/ui/src/settings/fields.ts:1-8`, `:84-92`
- Modify: `apps/ui/src/strings.ts:178-184` (`settings.tabs`), `:304-318` (`settings.fields` end, `settings.options`)
- Test: `packages/shared/test/settings.test.ts:81`, `packages/shared/test/migrations.test.ts:1-37`, `apps/ui/test/settings-fields.test.ts:1-20`, `apps/desktop/test/services/services.test.ts:64`, `packages/e2e/scenarios/settings.test.ts:15-17`, `packages/e2e/scenarios/help.test.ts:21` (line 20 before Task 1's insertion), `packages/e2e/scenarios/settings-window.test.ts` (append)

**Interfaces:**
- Consumes: `section`, `bool`, `choice` helpers (`settings.ts:33-43`); `SETTINGS_MIGRATIONS` (`migrations.ts:10`).
- Produces (`@jslab/shared`):
  - `SETTINGS_VERSION = 3`
  - `DECORATOR_MODES = ["none", "2023-11", "legacy"] as const`, `type DecoratorMode`
  - `settings.npm: { allowInstallScripts: boolean; autoInstallTypes: boolean }`
  - `settings.build: { decorators: DecoratorMode; pipelineOperator; doExpressions; throwExpressions; functionSent; regexpModifiers; optionalChainingAssign }` (booleans)
  - `interface BuildSettings` and `buildSettings(settings: Settings): BuildSettings`
  - `RunnerSettings.build: BuildSettings`
  - `SETTINGS_SECTIONS` ends with `"npm", "build"`
- Produces (`@jslab/ui`): `SettingsTab` gains `"npm" | "build"`; `SETTINGS_TABS` order General, Editor, Formatting, Appearance, NPM, Build, Advanced (spec §8, minus Keybindings/AI from M5).

**Rules (spec §8 NPM and Build rows):**
- Defaults: `npm.allowInstallScripts` false, `npm.autoInstallTypes` false, `build.decorators` `2023-11`, `build.pipelineOperator/doExpressions/throwExpressions/functionSent` false, `build.regexpModifiers/optionalChainingAssign` true.
- v2 → v3 keeps every v2 value and unknown key; the new sections come from schema defaults.
- The `.npmrc` editor is not a settings field (Task 27).

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/settings.test.ts`: add `buildSettings` to the import from `../src/settings`, change `expect(s.version).toBe(2);` (line 81) to `expect(s.version).toBe(3);`, and append inside `describe("settings", …)`:

```ts
  test("v3 adds the NPM and Build sections with the spec §8 defaults", () => {
    const s = defaultSettings();
    expect(s.npm).toEqual({ allowInstallScripts: false, autoInstallTypes: false });
    expect(s.build).toEqual({
      decorators: "2023-11",
      pipelineOperator: false,
      doExpressions: false,
      throwExpressions: false,
      functionSent: false,
      regexpModifiers: true,
      optionalChainingAssign: true,
    });
    expect(settingsSchema.parse({ build: { decorators: "stage-1" } }).build.decorators).toBe("2023-11");
    expect(runnerSettings(s).build).toEqual(buildSettings(s));
  });
```

Replace the body of `packages/shared/test/migrations.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { migrateSettings, parseSettings, settingsParser } from "../src/migrations";

describe("settings migrations", () => {
  test("v1 → v3 keeps user values and unknown keys and moves the untouched M1 theme to Graphite", () => {
    const s = parseSettings({
      version: 1,
      run: { autoRun: false },
      appearance: { theme: "dracula", fontSize: 18 },
      future: { flag: true },
    }) as ReturnType<typeof parseSettings> & { future?: unknown };
    expect(s.version).toBe(3);
    expect(s.run.autoRun).toBe(false);
    expect(s.appearance).toMatchObject({ theme: "graphite", fontSize: 18, darkTheme: "graphite" });
    expect(s.future).toEqual({ flag: true });
  });

  test("a hand-edited v1 theme other than the M1 default is kept", () => {
    expect(parseSettings({ version: 1, appearance: { theme: "nord" } }).appearance.theme).toBe("nord");
  });

  test("a missing version is treated as v1, and a newer file is read without migrating", () => {
    expect(migrateSettings({ appearance: { theme: "dracula" } })).toEqual({
      version: 3,
      appearance: { theme: "graphite" },
    });
    const future = parseSettings({ version: 4, editor: { lineWrap: false } });
    expect(future.version).toBe(3);
    expect(future.editor.lineWrap).toBe(false);
  });

  test("v2 → v3 keeps every v2 value and fills the npm and build sections", () => {
    const s = parseSettings({ version: 2, editor: { lineWrap: false }, build: { pipelineOperator: true } });
    expect(s.version).toBe(3);
    expect(s.editor.lineWrap).toBe(false);
    expect(s.build.pipelineOperator).toBe(true);
    expect(s.npm.allowInstallScripts).toBe(false);
    expect(migrateSettings({ version: 2 })).toEqual({ version: 3 });
  });

  test("the file parser rejects non-objects so loadJson falls back to the backup", () => {
    expect(() => settingsParser.parse([1, 2])).toThrow("settings.json must contain an object");
    expect(() => settingsParser.parse("x")).toThrow();
    expect(settingsParser.parse({}).version).toBe(3);
  });
});
```

`apps/ui/test/settings-fields.test.ts`: change the import line (line 3) to `import { coerceFieldValue, type FieldDef, fieldsFor, SETTINGS_FIELDS, SETTINGS_TABS } from "../src/settings/fields";`, change the `SETTINGS_TABS` expectation (line 18) to

```ts
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      "general",
      "editor",
      "formatting",
      "appearance",
      "npm",
      "build",
      "advanced",
    ]);
```

and append inside `describe("settings fields", …)`:

```ts
  test("the NPM and Build tabs list their §8 fields in spec order", () => {
    expect(fieldsFor("npm", "").map((field) => field.key)).toEqual(["npm.allowInstallScripts", "npm.autoInstallTypes"]);
    expect(fieldsFor("build", "").map((field) => field.key)).toEqual([
      "build.decorators",
      "build.pipelineOperator",
      "build.doExpressions",
      "build.throwExpressions",
      "build.functionSent",
      "build.regexpModifiers",
      "build.optionalChainingAssign",
    ]);
    const decorators = SETTINGS_FIELDS.find((field) => field.key === "build.decorators") as FieldDef;
    expect(coerceFieldValue(decorators, "legacy")).toBe("legacy");
    expect(coerceFieldValue(decorators, "stage-1")).toBeNull();
  });
```

`apps/desktop/test/services/services.test.ts:64`: add `SETTINGS_VERSION` to the `@jslab/shared` import and replace `.version).toBe(2);` with `.version).toBe(SETTINGS_VERSION);`.

E2E: in `packages/e2e/scenarios/settings.test.ts` lines 15 and 17 and in `packages/e2e/scenarios/help.test.ts`'s `expect(report.settings.version).toBe(2);` (line 21 after Task 1's inserted line), replace `toBe(2)` with `toBe(3)`. Append to `packages/e2e/scenarios/settings-window.test.ts`, inside `describe("Settings window", …)`:

```ts
  test("the NPM and Build tabs show their fields and apply live (ST-01, LB-05)", async () => {
    app = await launchApp();
    await openSettings();
    await current().settingsCommand("settings.tab", { tab: "build" });
    await waitFor(async () => (await current().settingsState())?.fieldCount === 7 || null);
    await current().settingsCommand("settings.set", { key: "build.pipelineOperator", value: true });
    await waitFor(async () => (await current().state()).ui.settings?.build?.pipelineOperator === true || null);
    await current().settingsCommand("settings.tab", { tab: "npm" });
    await waitFor(async () => (await current().settingsState())?.fieldCount === 2 || null);
  });
```

- [ ] **Step 2: Run the unit tests and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/shared && bun test test/settings.test.ts test/migrations.test.ts`
Expected: FAIL: `Expected: 3 Received: 2`, and `buildSettings` is not exported.

- [ ] **Step 3: Implement the settings changes**

In `packages/shared/src/settings.ts`:

1. Replace `export const SETTINGS_VERSION = 2;` with `export const SETTINGS_VERSION = 3;`, and directly after it add:

```ts
/** `build.decorators` (spec §8 Build): standard 2023-11 decorators, TypeScript's legacy decorators, or no decorators. */
export const DECORATOR_MODES = ["none", "2023-11", "legacy"] as const;
export type DecoratorMode = (typeof DECORATOR_MODES)[number];
```

2. In `settingsSchema`, after the `updates: section({ … }),` entry, add:

```ts
  npm: section({
    allowInstallScripts: bool(false),
    autoInstallTypes: bool(false),
  }),
  build: section({
    decorators: choice(DECORATOR_MODES, "2023-11"),
    pipelineOperator: bool(false),
    doExpressions: bool(false),
    throwExpressions: bool(false),
    functionSent: bool(false),
    regexpModifiers: bool(true),
    optionalChainingAssign: bool(true),
  }),
```

3. In `SETTINGS_SECTIONS`, after `"updates",` add `"npm",` and `"build",`.

4. Replace the `RunnerSettings` interface and `runnerSettings` function (lines 180-196) with:

```ts
/** The Build tab (spec §8): syntax proposals the transform enables, and the editor's decorator mode. */
export interface BuildSettings {
  decorators: DecoratorMode;
  pipelineOperator: boolean;
  doExpressions: boolean;
  throwExpressions: boolean;
  functionSent: boolean;
  regexpModifiers: boolean;
  optionalChainingAssign: boolean;
}

export function buildSettings(settings: Settings): BuildSettings {
  const build = settings.build;
  return {
    decorators: build.decorators,
    pipelineOperator: build.pipelineOperator,
    doExpressions: build.doExpressions,
    throwExpressions: build.throwExpressions,
    functionSent: build.functionSent,
    regexpModifiers: build.regexpModifiers,
    optionalChainingAssign: build.optionalChainingAssign,
  };
}

export interface RunnerSettings {
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  maxEntries: number;
  unresponsiveTimeoutMs: number;
  build: BuildSettings;
}

export function runnerSettings(settings: Settings): RunnerSettings {
  return {
    autoLog: settings.run.autoLog,
    loopProtection: settings.run.loopProtection,
    loopProtectionMaxIterations: settings.run.loopProtectionMaxIterations,
    maxEntries: settings.output.maxEntries,
    unresponsiveTimeoutMs: settings.run.unresponsiveTimeoutMs,
    build: buildSettings(settings),
  };
}
```

In `packages/shared/src/migrations.ts`, add this entry to `SETTINGS_MIGRATIONS` after the `1:` entry:

```ts
  // v2 (M2) → v3 (M3): the npm and build sections are filled by the schema's defaults; every v2 value is kept.
  2: (raw) => ({ ...raw, version: 3 }),
```

In `apps/ui/src/settings/fields.ts`:

1. Change the first import to `import { DECORATOR_MODES, LANGUAGES, RUNTIMES, type SettingKey, UI_LANGUAGES } from "@jslab/shared";`.
2. Replace lines 4-8 with:

```ts
export type SettingsTab = "general" | "editor" | "formatting" | "appearance" | "npm" | "build" | "advanced";

export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = (
  ["general", "editor", "formatting", "appearance", "npm", "build", "advanced"] as const
).map((id) => ({ id, label: strings.settings.tabs[id] }));
```

3. In `SETTINGS_FIELDS`, directly before `{ key: "run.showUndefined", tab: "advanced", kind: bool },`, add:

```ts
  { key: "npm.allowInstallScripts", tab: "npm", kind: bool },
  { key: "npm.autoInstallTypes", tab: "npm", kind: bool },

  { key: "build.decorators", tab: "build", kind: choices(o.decorators, DECORATOR_MODES) },
  { key: "build.pipelineOperator", tab: "build", kind: bool },
  { key: "build.doExpressions", tab: "build", kind: bool },
  { key: "build.throwExpressions", tab: "build", kind: bool },
  { key: "build.functionSent", tab: "build", kind: bool },
  { key: "build.regexpModifiers", tab: "build", kind: bool },
  { key: "build.optionalChainingAssign", tab: "build", kind: bool },

```

In `apps/ui/src/strings.ts`:

1. In `settings.tabs`, after `appearance: "Appearance",` add `npm: "NPM",` and `build: "Build",`.
2. In `settings.fields`, after the `"updates.channel"` entry, add:

```ts
      "npm.allowInstallScripts": {
        label: "Allow Install Scripts",
        help: "Run packages' install scripts. Each package is added to trustedDependencies; scripts run with your permissions.",
      },
      "npm.autoInstallTypes": {
        label: "Install Types Automatically",
        help: "Install @types/<package> automatically when an installed package has no types of its own.",
      },
      "build.decorators": {
        label: "Decorators",
        help: "Decorator syntax: 2023-11 (the standard), Legacy (TypeScript experimentalDecorators) or None.",
      },
      "build.pipelineOperator": { label: "Pipeline Operator", help: "Hack-style |> with % as the topic token." },
      "build.doExpressions": { label: "Do Expressions", help: "do { … } blocks that produce a value." },
      "build.throwExpressions": {
        label: "Throw Expressions",
        help: "throw as an expression, for example value ?? throw new Error().",
      },
      "build.functionSent": { label: "function.sent", help: "The value last passed to a generator's next()." },
      "build.regexpModifiers": { label: "RegExp Modifiers", help: "Inline flags such as (?i:a) in regular expressions." },
      "build.optionalChainingAssign": {
        label: "Optional Chaining Assignment",
        help: "a?.b = c assigns only when a is not null or undefined.",
      },
```

3. In `settings.options`, after `channel: { stable: "Stable", canary: "Canary" },` add:

```ts
      decorators: { none: "None", "2023-11": "2023-11 (standard)", legacy: "Legacy (experimentalDecorators)" },
```

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/shared && bun test && builtin cd ../../apps/ui && bun test test/settings-fields.test.ts && builtin cd ../desktop && bun test test/services/services.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/shared` M2 final + 2; `@jslab/ui` M2 final + 1; `@jslab/desktop` M2 final + 2.

- [ ] **Step 6: Run the changed scenarios**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/settings.test.ts ./scenarios/help.test.ts ./scenarios/settings-window.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: every test passes, 0 fail. Scenarios total: M2 final + 1. Read-only `ps` check: no survivors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared apps/ui/src/settings/fields.ts apps/ui/src/strings.ts apps/ui/test/settings-fields.test.ts apps/desktop/test/services/services.test.ts packages/e2e/scenarios
git commit -m "feat(shared): settings v3 with the npm and build sections and their settings tabs" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 3: Persistence hardening: write-time session serialization (FA-m9) and a settings write timeout (RR1-m2)

**Files:**
- Modify: `apps/desktop/src/main/persistence/json-store.ts:63-103` (`DebouncedWriter`, `createDebouncedWriter`)
- Modify: `apps/desktop/src/main/persistence/atomic-write.ts:4-9` (options), `:37-45` (before the rename)
- Modify: `apps/desktop/src/main/services/session-store.ts:373-375` (`#scheduleSave`)
- Modify: `apps/desktop/src/main/services/settings-store.ts:29-64` (options, constructor), `:66-94` (`open`)
- Modify: `apps/desktop/src/main/main-services.ts:12-24` (options), `:45` (`SettingsStore.open`)
- Modify: `apps/desktop/src/main/index.ts:153-161` (pass `log`)
- Modify: `apps/desktop/src/main/strings.ts` (`log` section)
- Test: `apps/desktop/test/persistence/persistence.test.ts`, `apps/desktop/test/services/services.test.ts`

**Interfaces:**
- Consumes: `writeFileAtomic`, `AtomicWriteOptions`; `SettingsStore.open(dataDir, options)`; `SessionStore`.
- Produces:
  - `type WriteData = string | (() => string)`; `DebouncedWriter.schedule(data: WriteData): void`. A function is called once, when its write starts.
  - `AtomicWriteOptions.shouldCommit?(): boolean`. When it returns false just before the rename, the temp file is removed and the target is left untouched.
  - `SETTINGS_WRITE_TIMEOUT_MS = 10_000`; `SettingsStoreOptions.writeTimeoutMs?: number`, `SettingsStoreOptions.onWriteError?(error: unknown): void`.
  - `MainServicesOptions.log?: (message: string, detail?: unknown) => void`.
  - `strings.log.settingsWriteTimedOut(ms: number): string`, `strings.log.settingsWriteFailed`.

**Rules (carries FA-m9, RR1-m2; spec §10.1):**
- FA-m9: every session commit schedules a function, so the JSON is built once per write instead of once per commit, and the written file always holds the latest session.
- RR1-m2: a settings write that doesn't finish within `writeTimeoutMs` fails its `update`/`reset`, is reported through `onWriteError`, and lets later writes proceed with the latest snapshot. A timed-out write that finishes later never renames its stale snapshot over a newer file (`shouldCommit` compares a write generation).
- Quit stays bounded at 2 s (unchanged).

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/test/persistence/persistence.test.ts`, make sure `readdir` and `readFile` are imported from `node:fs/promises`, then append inside `describe("writeFileAtomic", …)`:

```ts
  test("leaves the target untouched and removes its temp file when shouldCommit returns false (RR1-m2)", async () => {
    const path = join(dir, "s.json");
    await writeFileAtomic(path, "old");
    await writeFileAtomic(path, "new", { shouldCommit: () => false });
    expect(await readFile(path, "utf8")).toBe("old");
    expect((await readdir(dir)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
```

and inside `describe("createDebouncedWriter", …)`:

```ts
  test("a scheduled function is serialized once, when its write starts (FA-m9)", async () => {
    const writes: string[] = [];
    let state = 0;
    let serialized = 0;
    const writer = createDebouncedWriter(async (data) => void writes.push(data), 10_000);
    for (let i = 1; i <= 3; i++) {
      state = i;
      writer.schedule(() => {
        serialized++;
        return `state ${state}`;
      });
    }
    state = 4;
    await writer.flush();
    expect(serialized).toBe(1);
    expect(writes).toEqual(["state 4"]);
  });
```

In `apps/desktop/test/services/services.test.ts`, add `spyOn` to the `bun:test` import, then append inside `describe("SettingsStore", …)`:

```ts
  test("a hung write times out and is reported, later updates still land, and the late write never commits (RR1-m2)", async () => {
    const { writeFileAtomic } = await import("../../src/main/persistence/atomic-write");
    const errors: unknown[] = [];
    let calls = 0;
    let releaseFirst: () => void = () => {};
    // The first write's own promise, so the test waits for it to finish instead of sleeping.
    let firstWrite: Promise<void> = Promise.resolve();
    const store = await SettingsStore.open(dir, {
      writeTimeoutMs: 30,
      onWriteError: (error) => errors.push(error),
      write: (path, data, options) => {
        calls++;
        if (calls !== 1) return writeFileAtomic(path, data, options);
        firstWrite = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        }).then(() => writeFileAtomic(path, data, options));
        return firstWrite;
      },
    });
    await expect(store.update({ appearance: { uiScale: 1.25 } })).rejects.toThrow("did not finish within 30 ms");
    expect(await store.update({ appearance: { uiScale: 1.5 } })).toBe(store.current);
    releaseFirst();
    await firstWrite;
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).appearance.uiScale).toBe(1.5);
    expect(errors).toHaveLength(1);
  });
```

and append inside the `SessionStore` describe block (the one that uses `openSession`):

```ts
  test("the session is serialized when it is written, so every commit before the write lands (FA-m9)", async () => {
    const store = await openSession({ delayMs: 10_000 });
    const id = store.session.activeTabId;
    const stringify = spyOn(JSON, "stringify");
    for (let i = 0; i < 50; i++) store.setViewState(id, { scrollTop: i });
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    await store.flush();
    expect(JSON.parse(await readFile(join(dir, "session.json"), "utf8")).tabs[id].viewState).toEqual({ scrollTop: 49 });
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/persistence/persistence.test.ts test/services/services.test.ts`
Expected: FAIL: `"old"` becomes `"new"` (no `shouldCommit`); `writes` receives a function instead of `"state 4"`; `JSON.stringify` called 50 times; the settings update never rejects (the test times out at 5000 ms).

- [ ] **Step 3: Implement**

`apps/desktop/src/main/persistence/atomic-write.ts`: add to `AtomicWriteOptions`:

```ts
  /**
   * Checked just before the rename. When it returns false, the temp file is removed and the target is left untouched,
   * so a write that finished late never replaces a newer file (RR1-m2).
   */
  shouldCommit?(): boolean;
```

and directly after `await chmod(tmp, mode);` insert:

```ts
    if (options.shouldCommit && !options.shouldCommit()) {
      await unlink(tmp).catch(() => {});
      return;
    }
```

`apps/desktop/src/main/persistence/json-store.ts`: replace the `DebouncedWriter` interface and `createDebouncedWriter` (from `export interface DebouncedWriter` to the end of the file) with:

```ts
/** What a writer writes: the text itself, or a function that builds it when the write starts (FA-m9). */
export type WriteData = string | (() => string);

export interface DebouncedWriter {
  schedule(data: WriteData): void;
  flush(): Promise<void>;
}

/**
 * Coalesces rapid writes; writes run sequentially and `flush` resolves after the last one lands. A scheduled function
 * is called once, when its write starts, so the newest state is written and nothing is serialized per change.
 */
export function createDebouncedWriter(
  write: (data: string) => Promise<void>,
  delayMs = 500,
  onError: (error: unknown) => void = (error) => console.error("[jslab] persistence write failed", error),
): DebouncedWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: WriteData | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const scheduled = pending;
    pending = null;
    if (scheduled !== null) {
      // Chain from the settled promise so past failures don't block future writes.
      const next = inflight
        .catch(() => {})
        .then(() => write(typeof scheduled === "function" ? scheduled() : scheduled));
      inflight = next;
      return next;
    }
    // No pending data: wait for any in-flight write to settle, then resolve.
    return inflight.catch(() => {});
  };

  return {
    schedule(data) {
      pending = data;
      clearTimeout(timer);
      timer = setTimeout(() => {
        run().catch(onError);
      }, delayMs);
    },
    flush: run,
  };
}
```

`apps/desktop/src/main/services/session-store.ts`: replace `#scheduleSave` (lines 373-375) with:

```ts
  #scheduleSave(): void {
    // FA-m9: serialized when the write starts, not on every commit.
    this.#sessionWriter.schedule(() => `${JSON.stringify(this.#session, null, 2)}\n`);
  }
```

`apps/desktop/src/main/strings.ts`: in `log`, after `quitFlushTimedOut`, add:

```ts
    /** RR1-m2: a settings write that hung. */
    settingsWriteTimedOut: (timeoutMs: number) => `settings.json write did not finish within ${timeoutMs} ms`,
    settingsWriteFailed: "Couldn't save settings.json",
```

`apps/desktop/src/main/services/settings-store.ts`:

1. Add `import { strings } from "../strings";`.
2. Replace `SettingsStoreOptions` with:

```ts
/** RR1-m2: a settings write that takes longer than this fails and lets later writes proceed. */
export const SETTINGS_WRITE_TIMEOUT_MS = 10_000;

export interface SettingsStoreOptions {
  /** The atomic file write (injectable for tests). */
  write?: SettingsWrite;
  writeTimeoutMs?: number;
  /** Called with each failed or timed-out write (RR1-m2). */
  onWriteError?(error: unknown): void;
}
```

3. Add `#generation = 0;` as a private field after `readonly #writer: DebouncedWriter;`.
4. Replace the constructor parameter list and body with:

```ts
  private constructor(
    private readonly path: string,
    settings: Settings,
    readonly recovered: Recovery,
    readonly newerVersion: number | null,
    private readonly write: SettingsWrite,
    readonly primary: PrimaryFile = "ok",
    readonly corruptCopy: string | null = null,
    private readonly writeTimeoutMs: number = SETTINGS_WRITE_TIMEOUT_MS,
    private readonly onWriteError: (error: unknown) => void = (error) =>
      console.error(`[jslab] ${strings.log.settingsWriteFailed}`, error),
  ) {
    this.#settings = settings;
    // A zero delay: a write starts on the next flush, which update/reset call at once. Failures reject that flush.
    this.#writer = createDebouncedWriter((data) => this.#timedWrite(data), 0, () => {});
  }
```

Keep the existing doc comment on `newerVersion` and `primary` above those parameters.

5. In `open`, replace the `new SettingsStore(…)` call with:

```ts
    const store = new SettingsStore(
      path,
      value,
      recovered,
      newerVersion,
      options.write ?? writeFileAtomic,
      primary,
      corruptCopy,
      options.writeTimeoutMs ?? SETTINGS_WRITE_TIMEOUT_MS,
      options.onWriteError,
    );
```

6. Add this private method after `#snapshot()`:

```ts
  /**
   * One queued write, bounded by writeTimeoutMs (RR1-m2). Each write takes a new generation; a write that finishes after
   * a newer one started is not committed.
   */
  #timedWrite(data: string): Promise<void> {
    const generation = ++this.#generation;
    const write = this.write(this.path, data, { backup: true, shouldCommit: () => generation === this.#generation });
    write.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(strings.log.settingsWriteTimedOut(this.writeTimeoutMs))), this.writeTimeoutMs);
    });
    return Promise.race([write, timeout])
      .finally(() => clearTimeout(timer))
      .catch((error: unknown) => {
        this.onWriteError(error);
        throw error;
      });
  }
```

`apps/desktop/src/main/main-services.ts`: add to `MainServicesOptions`:

```ts
  /** Main's log (index.ts passes the rotating log). Defaults to console.error. */
  log?: (message: string, detail?: unknown) => void;
```

and at the top of `createMainServices`, after `const { paths } = options;`:

```ts
  const log = options.log ?? ((message: string, detail?: unknown) => console.error(`[jslab] ${message}`, detail ?? ""));
```

Replace `const settings = await SettingsStore.open(paths.dataDir);` with:

```ts
  const settings = await SettingsStore.open(paths.dataDir, {
    onWriteError: (error) => log(strings.log.settingsWriteFailed, String(error)),
  });
```

and add `import { strings } from "./strings";`.

`apps/desktop/src/main/index.ts`: in the `createMainServices({ … })` call (lines 153-161), add `log,` after `shiftHeld,`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/persistence/persistence.test.ts test/services/services.test.ts test/main-services.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/desktop` M2 final + 6. No scenario changes in this task.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main apps/desktop/test/persistence/persistence.test.ts apps/desktop/test/services/services.test.ts
git commit -m "fix(desktop): serialize the session at write time and bound each settings write" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 4: Data paths, the packages project, `env.json` store and the `.env` parser

**Files:**
- Create: `packages/shared/src/packages.ts`, `packages/shared/src/dotenv.ts`, `packages/shared/src/env-vars.ts`
- Create: `apps/desktop/src/main/services/packages-project.ts`, `apps/desktop/src/main/services/env-store.ts`
- Modify: `packages/shared/src/index.ts:1-6`
- Modify: `apps/desktop/src/main/app-paths.ts:13-46`
- Modify: `apps/desktop/src/main/main-services.ts:26-36` (`MainServices`), `:46-52` (after the session store), `:75-88` (returned object)
- Modify: `apps/desktop/src/main/strings.ts` (`log`)
- Test: `packages/shared/test/dotenv.test.ts`, `packages/shared/test/env-vars.test.ts`, `apps/desktop/test/services/env-store.test.ts`, `apps/desktop/test/services/packages-project.test.ts`, `apps/desktop/test/shell.test.ts:12-24`, `apps/desktop/test/main-services.test.ts:35-60`

**Interfaces:**
- Consumes: `writeFileAtomic` (with `mode`), `AppPaths`.
- Produces (`@jslab/shared`):
  - `DEFAULT_REGISTRY = "https://registry.npmjs.org/"`, `DEFAULT_NPMRC = "registry=https://registry.npmjs.org/\n"`, `defaultPackagesManifest(): PackagesManifest`, `interface PackagesManifest { name: string; private: boolean; dependencies: Record<string, string>; trustedDependencies: string[] }`
  - `MAX_DOTENV_BYTES = 1_048_576`, `parseDotenv(text: string): Record<string, string>`
  - `ENV_KEY_PATTERN`, `MAX_ENV_VARS = 500`, `MAX_ENV_KEY_CHARS = 256`, `MAX_ENV_VALUE_CHARS = 32_768`, `type EnvVars = Record<string, string>`, `envVarsSchema`, `envFileSchema`, `type EnvRowError = { index: number; error: "invalidKey" | "duplicateKey" }`, `validateEnvRows(rows): { ok: true; variables: EnvVars } | { ok: false; errors: EnvRowError[] }`
- Produces (`@jslab/desktop`):
  - `AppPaths` gains `packagesDir`, `packagesJson`, `packagesNpmrc`, `npmHome`, `envFile`.
  - `ensurePackagesProject(paths: PackagesProjectPaths, log: Log, now?: () => number): Promise<void>`
  - `class EnvStore { static open(path: string, options?: { write?: EnvWrite; now?: () => number }): Promise<EnvStore>; readonly recovered: "none" | "defaults"; get variables(): EnvVars; secrets(): string[]; save(variables: EnvVars): Promise<EnvVars>; onChange(listener: (variables: EnvVars) => void): () => void }`, `ENV_FILE_MODE = 0o600`
  - `MainServices.env: EnvStore`

**Rules (spec §4.5, §5.3, §11.1, §11.3, §12.1, §18):**
- `packages/` holds `package.json` (`{ "name": "jslab-packages", "private": true, "dependencies": {}, "trustedDependencies": [] }`) and `.npmrc` (default `registry=https://registry.npmjs.org/`, mode 0600 because it may hold tokens). Existing files are never overwritten.
- `npm-home/` exists, mode 0700, and never contains an `.npmrc`. One found there is moved out of `npm-home` and logged.
- `env.json` is `{ "version": 1, "variables": { KEY: "value" } }`, mode 0600, written atomically without a `.bak` (a backup would copy secrets). A loose mode is tightened to 0600 at open. A corrupt file is moved to `env.corrupt-<ts>.json` (mode 0600) and the store starts empty.
- Keys match `^[A-Za-z_][A-Za-z0-9_]*$` and are unique; values are strings.
- `.env` parsing is JSLab's own: `KEY=VALUE` lines, optional `export `, `#` comments, inline `#` comments only for unquoted values after whitespace, single quotes literal, double quotes with `\n \r \t \" \\` escapes and multi-line values, CRLF tolerated, invalid lines skipped, a later key wins, and no `${VAR}` expansion.

- [ ] **Step 1: Write the failing shared tests**

`packages/shared/test/dotenv.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseDotenv } from "../src/dotenv";

describe("parseDotenv (spec §5.3: JSLab parses the WD's .env itself)", () => {
  test("reads plain, exported, empty and quoted values and ignores comments", () => {
    const text = [
      "# comment",
      "",
      "A=1",
      "export B = two words  # trailing comment",
      "C=",
      'D="quoted # not a comment"',
      "E='single $HOME \\n'",
    ].join("\n");
    expect(parseDotenv(text)).toEqual({
      A: "1",
      B: "two words",
      C: "",
      D: "quoted # not a comment",
      E: "single $HOME \\n",
    });
  });

  test("unescapes double-quoted values, which may span lines", () => {
    expect(parseDotenv('F="x\\ny"\nG="first\nsecond"\nH=after')).toEqual({ F: "x\ny", G: "first\nsecond", H: "after" });
  });

  test("skips invalid lines, tolerates CRLF, lets a later key win and never expands variables", () => {
    expect(parseDotenv("1BAD=x\r\nOK=1\r\nOK=2\r\nREF=${OK}\r\nnot a line")).toEqual({ OK: "2", REF: "${OK}" });
  });
});
```

`packages/shared/test/env-vars.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { envFileSchema, validateEnvRows } from "../src/env-vars";

describe("environment variables (spec §12.1)", () => {
  test("rows validate keys and uniqueness, case-sensitively, and trim keys", () => {
    expect(validateEnvRows([{ key: " API_URL ", value: "https://x" }, { key: "api_url", value: "y" }])).toEqual({
      ok: true,
      variables: { API_URL: "https://x", api_url: "y" },
    });
    expect(
      validateEnvRows([
        { key: "1A", value: "" },
        { key: "A-B", value: "" },
        { key: "OK", value: "1" },
        { key: "OK", value: "2" },
      ]),
    ).toEqual({
      ok: false,
      errors: [
        { index: 0, error: "invalidKey" },
        { index: 1, error: "invalidKey" },
        { index: 3, error: "duplicateKey" },
      ],
    });
  });

  test("env.json has a version and string values under valid keys", () => {
    expect(envFileSchema.parse({ version: 1, variables: { TOKEN: "s3cr3t" } }).variables).toEqual({ TOKEN: "s3cr3t" });
    expect(envFileSchema.safeParse({ version: 1, variables: { "1BAD": "x" } }).success).toBe(false);
    expect(envFileSchema.safeParse({ version: 1, variables: { A: 1 } }).success).toBe(false);
    expect(envFileSchema.safeParse({ variables: {} }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/shared && bun test test/dotenv.test.ts test/env-vars.test.ts`
Expected: FAIL, `Cannot find module "../src/dotenv"` and `Cannot find module "../src/env-vars"`.

- [ ] **Step 3: Implement the shared modules**

`packages/shared/src/packages.ts`:

```ts
/** The shared npm project in `<dataDir>/packages` (spec §11.1, §11.5). */
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";
export const DEFAULT_NPMRC = `registry=${DEFAULT_REGISTRY}\n`;

export interface PackagesManifest {
  name: string;
  private: boolean;
  dependencies: Record<string, string>;
  trustedDependencies: string[];
}

export function defaultPackagesManifest(): PackagesManifest {
  return { name: "jslab-packages", private: true, dependencies: {}, trustedDependencies: [] };
}
```

`packages/shared/src/dotenv.ts`:

```ts
/** A WD `.env` larger than this is ignored (spec §5.3). */
export const MAX_DOTENV_BYTES = 1024 * 1024;

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;
const ESCAPES: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };

function closingQuote(text: string, quote: string): number {
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\\") {
      index++;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return -1;
}

/**
 * JSLab's own `.env` parser (spec §5.3; Bun's auto-load is disabled with --no-env-file). No variable expansion: a
 * value like `${HOME}` stays as written.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const match = LINE.exec(lines[index] ?? "");
    if (!match) continue;
    const key = match[1] as string;
    const raw = (match[2] ?? "").trim();
    if (raw.startsWith('"')) {
      let body = raw.slice(1);
      while (closingQuote(body, '"') < 0 && index + 1 < lines.length) {
        index++;
        body += `\n${lines[index]}`;
      }
      const end = closingQuote(body, '"');
      const inner = end < 0 ? body : body.slice(0, end);
      out[key] = inner.replace(/\\([nrt"\\])/g, (_, char: string) => ESCAPES[char] ?? char);
    } else if (raw.startsWith("'")) {
      const end = raw.indexOf("'", 1);
      out[key] = end < 0 ? raw.slice(1) : raw.slice(1, end);
    } else {
      out[key] = raw.replace(/\s+#.*$/, "");
    }
  }
  return out;
}
```

`packages/shared/src/env-vars.ts`:

```ts
import { z } from "zod";

/** Spec §12.1: keys match this pattern and are unique; values are strings. */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_ENV_VARS = 500;
export const MAX_ENV_KEY_CHARS = 256;
export const MAX_ENV_VALUE_CHARS = 32_768;

export type EnvVars = Record<string, string>;

export const envVarsSchema = z
  .record(z.string().max(MAX_ENV_KEY_CHARS).regex(ENV_KEY_PATTERN), z.string().max(MAX_ENV_VALUE_CHARS))
  .refine((variables) => Object.keys(variables).length <= MAX_ENV_VARS, {
    message: `At most ${MAX_ENV_VARS} environment variables`,
  });

/** `env.json` (spec §4.5, §12.1). */
export const envFileSchema = z.object({ version: z.literal(1), variables: envVarsSchema });

export type EnvRowError = { index: number; error: "invalidKey" | "duplicateKey" };

/** Validates the Environment Variables table before Save (spec §12.1). Keys are trimmed. */
export function validateEnvRows(
  rows: readonly { key: string; value: string }[],
): { ok: true; variables: EnvVars } | { ok: false; errors: EnvRowError[] } {
  const errors: EnvRowError[] = [];
  const seen = new Set<string>();
  const variables: EnvVars = {};
  rows.forEach((row, index) => {
    const key = row.key.trim();
    if (key.length > MAX_ENV_KEY_CHARS || !ENV_KEY_PATTERN.test(key)) {
      errors.push({ index, error: "invalidKey" });
      return;
    }
    if (seen.has(key)) {
      errors.push({ index, error: "duplicateKey" });
      return;
    }
    seen.add(key);
    variables[key] = row.value;
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, variables };
}
```

Replace `packages/shared/src/index.ts` with:

```ts
export * from "./commands";
export * from "./dotenv";
export * from "./env-vars";
export * from "./keybindings";
export * from "./migrations";
export * from "./packages";
export * from "./session";
export * from "./settings";
export * from "./tabs";
```

- [ ] **Step 4: Run the shared tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/shared && bun test`
Expected: PASS, 0 fail. `@jslab/shared` M2 final + 7.

- [ ] **Step 5: Write the failing desktop tests**

`apps/desktop/test/services/env-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_FILE_MODE, EnvStore } from "../../src/main/services/env-store";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-env-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe("EnvStore (spec §12.1)", () => {
  test("starts empty, saves with mode 0600, notifies, reloads and lists secrets", async () => {
    const path = join(dir, "env.json");
    const store = await EnvStore.open(path);
    expect(store.variables).toEqual({});
    const seen: string[][] = [];
    store.onChange((variables) => seen.push(Object.keys(variables)));
    await store.save({ API_URL: "https://x", TOKEN: "s3cr3t-value", N: "1" });
    expect(await modeOf(path)).toBe(ENV_FILE_MODE);
    expect(seen).toEqual([["API_URL", "TOKEN", "N"]]);
    expect(existsSync(`${path}.bak`)).toBe(false);
    const again = await EnvStore.open(path);
    expect(again.variables).toEqual({ API_URL: "https://x", TOKEN: "s3cr3t-value", N: "1" });
    expect(again.secrets()).toEqual(["https://x", "s3cr3t-value"]);
  });

  test("rejects invalid keys without writing", async () => {
    const path = join(dir, "env.json");
    const store = await EnvStore.open(path);
    await expect(store.save({ "1BAD": "x" })).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
    expect(store.variables).toEqual({});
  });

  test("a corrupt file starts empty with a 0600 copy, and a loose mode is tightened", async () => {
    const path = join(dir, "env.json");
    await writeFile(path, "{bad");
    const store = await EnvStore.open(path, { now: () => 42 });
    expect([store.variables, store.recovered]).toEqual([{}, "defaults"]);
    expect(await readdir(dir)).toEqual(["env.corrupt-42.json"]);
    expect(await modeOf(join(dir, "env.corrupt-42.json"))).toBe(ENV_FILE_MODE);

    await writeFile(path, JSON.stringify({ version: 1, variables: { A: "1" } }));
    await chmod(path, 0o644);
    expect((await EnvStore.open(path)).variables).toEqual({ A: "1" });
    expect(await modeOf(path)).toBe(ENV_FILE_MODE);
  });
});
```

`apps/desktop/test/services/packages-project.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NPMRC, defaultPackagesManifest } from "@jslab/shared";
import { resolveAppPaths } from "../../src/main/app-paths";
import { ensurePackagesProject } from "../../src/main/services/packages-project";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-packages-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pathsFor = (root: string) => resolveAppPaths({ resourcesFolder: "/R", userData: root, execPath: "/bun", env: {} });

describe("packages project (spec §11.1, §11.3)", () => {
  test("creates package.json, a 0600 .npmrc and an empty 0700 npm-home, and never overwrites them", async () => {
    const paths = pathsFor(dir);
    const log: string[] = [];
    await ensurePackagesProject(paths, (message) => log.push(message));
    expect(JSON.parse(await readFile(paths.packagesJson, "utf8"))).toEqual(defaultPackagesManifest());
    expect(await readFile(paths.packagesNpmrc, "utf8")).toBe(DEFAULT_NPMRC);
    expect((await stat(paths.packagesNpmrc)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.npmHome)).mode & 0o777).toBe(0o700);
    expect(await readdir(paths.npmHome)).toEqual([]);

    await writeFile(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");
    await ensurePackagesProject(paths, (message) => log.push(message));
    expect(await readFile(paths.packagesNpmrc, "utf8")).toBe("registry=http://127.0.0.1:4873/\n");
    expect(log).toEqual([]);
  });

  test("moves an .npmrc found in npm-home out of it and logs the move (M0-S8)", async () => {
    const paths = pathsFor(dir);
    await mkdir(paths.npmHome, { recursive: true });
    await writeFile(join(paths.npmHome, ".npmrc"), "@scope:registry=http://127.0.0.1:9/\n");
    const log: string[] = [];
    await ensurePackagesProject(paths, (message) => log.push(message), () => 7);
    expect(await readdir(paths.npmHome)).toEqual([]);
    expect(await readFile(join(dir, "npm-home.npmrc.ignored-7"), "utf8")).toContain("@scope:registry");
    expect(log).toHaveLength(1);
  });
});
```

In `apps/desktop/test/shell.test.ts`, add these five entries to the object in the first `resolveAppPaths` expectation (lines 13-23), after `packagesNodeModules`. They build on the file's own `input.userData` fixture (line 6):

```ts
      packagesDir: `${input.userData}/packages`,
      packagesJson: `${input.userData}/packages/package.json`,
      packagesNpmrc: `${input.userData}/packages/.npmrc`,
      npmHome: `${input.userData}/npm-home`,
      envFile: `${input.userData}/env.json`,
```

In `apps/desktop/test/main-services.test.ts`, add `import { existsSync } from "node:fs";` and, after `expect(services.safeMode).toEqual(…);`, add:

```ts
    expect(existsSync(paths.packagesJson)).toBe(true);
    expect(services.env.variables).toEqual({});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/services/env-store.test.ts test/services/packages-project.test.ts test/shell.test.ts test/main-services.test.ts`
Expected: FAIL, `Cannot find module "../../src/main/services/env-store"`, and the `resolveAppPaths` expectation is missing `packagesDir`.

- [ ] **Step 7: Implement the desktop side**

`apps/desktop/src/main/app-paths.ts`: add to `AppPaths` after `packagesNodeModules: string;`:

```ts
  packagesDir: string;
  packagesJson: string;
  packagesNpmrc: string;
  /** The empty HOME of npm operations (spec §11.3, M0-S8). */
  npmHome: string;
  envFile: string;
```

and in `resolveAppPaths`'s returned object, after `packagesNodeModules: …,`:

```ts
    packagesDir: join(dataDir, "packages"),
    packagesJson: join(dataDir, "packages", "package.json"),
    packagesNpmrc: join(dataDir, "packages", ".npmrc"),
    npmHome: join(dataDir, "npm-home"),
    envFile: join(dataDir, "env.json"),
```

`apps/desktop/src/main/strings.ts`, in `log`:

```ts
    npmHomeNpmrcMoved: (path: string) => `Moved an .npmrc found in npm-home to ${path}; npm operations never read one there`,
```

`apps/desktop/src/main/services/packages-project.ts`:

```ts
import { existsSync } from "node:fs";
import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_NPMRC, defaultPackagesManifest } from "@jslab/shared";
import type { AppPaths } from "../app-paths";
import { writeFileAtomic } from "../persistence/atomic-write";
import { strings } from "../strings";

export type PackagesProjectPaths = Pick<AppPaths, "dataDir" | "packagesDir" | "packagesJson" | "packagesNpmrc" | "npmHome">;

/**
 * Creates the shared npm project (spec §11.1) and the empty npm-home (§11.3, M0-S8) when missing. Existing files are
 * never overwritten. An .npmrc inside npm-home would defeat the isolation, so it is moved out and logged.
 */
export async function ensurePackagesProject(
  paths: PackagesProjectPaths,
  log: (message: string, detail?: unknown) => void,
  now: () => number = Date.now,
): Promise<void> {
  await mkdir(paths.packagesDir, { recursive: true });
  if (!existsSync(paths.packagesJson)) {
    await writeFileAtomic(paths.packagesJson, `${JSON.stringify(defaultPackagesManifest(), null, 2)}\n`);
  }
  if (!existsSync(paths.packagesNpmrc)) await writeFileAtomic(paths.packagesNpmrc, DEFAULT_NPMRC, { mode: 0o600 });
  await mkdir(paths.npmHome, { recursive: true, mode: 0o700 });
  await chmod(paths.npmHome, 0o700);
  const stray = join(paths.npmHome, ".npmrc");
  if (existsSync(stray)) {
    const moved = join(paths.dataDir, `npm-home.npmrc.ignored-${now()}`);
    await rename(stray, moved);
    log(strings.log.npmHomeNpmrcMoved(moved));
  }
}
```

`apps/desktop/src/main/services/env-store.ts`:

```ts
import { chmod, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type EnvVars, envFileSchema, envVarsSchema } from "@jslab/shared";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";

export const ENV_FILE_MODE = 0o600;
export type EnvWrite = (path: string, data: string, options: AtomicWriteOptions) => Promise<void>;

/** `env.json` (spec §4.5, §12.1): variables shared by every tab, mode 0600, written without a backup. */
export class EnvStore {
  #variables: EnvVars;
  readonly #listeners = new Set<(variables: EnvVars) => void>();

  private constructor(
    private readonly path: string,
    variables: EnvVars,
    readonly recovered: "none" | "defaults",
    private readonly write: EnvWrite,
  ) {
    this.#variables = variables;
  }

  static async open(path: string, options: { write?: EnvWrite; now?: () => number } = {}): Promise<EnvStore> {
    const write = options.write ?? writeFileAtomic;
    let text: string | null;
    try {
      text = await readFile(path, "utf8");
    } catch {
      text = null;
    }
    if (text === null) return new EnvStore(path, {}, "none", write);
    const parsed = (() => {
      try {
        return envFileSchema.safeParse(JSON.parse(text));
      } catch {
        return null;
      }
    })();
    if (!parsed?.success) {
      const copy = join(dirname(path), `${basename(path, ".json")}.corrupt-${(options.now ?? Date.now)()}.json`);
      await rename(path, copy);
      await chmod(copy, ENV_FILE_MODE);
      return new EnvStore(path, {}, "defaults", write);
    }
    if (((await stat(path)).mode & 0o777) !== ENV_FILE_MODE) await chmod(path, ENV_FILE_MODE);
    return new EnvStore(path, parsed.data.variables, "none", write);
  }

  get variables(): EnvVars {
    return this.#variables;
  }

  /** Values of four or more characters, masked in logs and the debug report (spec §18). */
  secrets(): string[] {
    return Object.values(this.#variables).filter((value) => value.length >= 4);
  }

  async save(variables: EnvVars): Promise<EnvVars> {
    const valid = envVarsSchema.parse(variables);
    await this.write(this.path, `${JSON.stringify({ version: 1, variables: valid }, null, 2)}\n`, {
      mode: ENV_FILE_MODE,
    });
    this.#variables = valid;
    for (const listener of this.#listeners) listener(valid);
    return valid;
  }

  onChange(listener: (variables: EnvVars) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
```

`apps/desktop/src/main/main-services.ts`:

1. Add imports: `import { EnvStore } from "./services/env-store";` and `import { ensurePackagesProject } from "./services/packages-project";`.
2. Add `env: EnvStore;` to `MainServices` after `session: SessionStore;`.
3. After the `SessionStore.open(…)` call, add:

```ts
  await ensurePackagesProject(paths, log);
  const env = await EnvStore.open(paths.envFile);
```

4. Add `env,` to the returned object after `session,`.

- [ ] **Step 8: Run the desktop tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/services test/shell.test.ts test/main-services.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 9: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/shared` M2 final + 7; `@jslab/desktop` M2 final + 11.

- [ ] **Step 10: Commit**

```bash
git add packages/shared apps/desktop/src/main apps/desktop/test
git commit -m "feat(desktop): packages project, npm-home, env.json store and a .env parser" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 5: RPC schemas for npm, env, working directory, types and `.npmrc`

**Files:**
- Modify: `packages/rpc-schema/src/ui-rpc.ts:1-3` (imports), after `:112` (`fileConfirmSaveAsSchema`)
- Test: `packages/rpc-schema/test/m3-contracts.test.ts` (new)

**Interfaces:**
- Consumes: `tabId` (`ui-rpc.ts:11-15`), `envVarsSchema` and `EnvVars` (Task 4).
- Produces (all exported from `@jslab/rpc-schema`):
  - Schemas: `npmNameSchema`, `npmSpecSchema`, `MAX_NPMRC_CHARS = 65_536`, `npmInstallParamsSchema` (`{ spec }`), `npmNameParamsSchema` (`{ name }`), `npmSearchParamsSchema` (`{ query }`), `npmListParamsSchema` (`{ refreshOutdated }`), `npmrcSaveParamsSchema` (`{ content }`), `envSaveParamsSchema` (`{ variables }`), `packageTypesParamsSchema` (`{ tabId, packages }`), `localTypesParamsSchema` (`{ tabId, specifiers }`)
  - Types: `NpmOpKind`, `NpmErrorKind`, `NpmOpError { kind; log }`, `NpmOperation { id; kind; target; status; error; notice }`, `InstalledPackage { name; version; latest }`, `NpmListResult { installed; outdatedCheckedAt; outdatedError }`, `NpmSearchResult { name; version; description; weeklyDownloads }`, `NpmSearchResponse { results; error }`, `TypeFile { path; content }`, `PackageTypesResult { name; files; dependencies; typesPackage; hasTypes; truncated }`, `LocalTypesResult { files; packages; truncated }`, `SaveResult`, and a re-export of `EnvVars`
  - The `MainRequests`/`MainMessages`/`ViewMessages`/`SettingsWindowRequests` entries are added in Task 18 (Main) and Task 19 (the flush messages), together with their handlers, so every commit typechecks.

**Rules (spec §18, §11.2, §11.3, §6.2):**
- A spec can never start with `-` or contain whitespace, so it can't become a `bun add` flag.
- Package names follow npm's rules: an optional `@scope/`, lowercase URL-safe characters, at most 214 characters.
- Local type requests carry only relative specifiers (`./x`, `../x`); Main resolves them inside the tab's WD (Task 13).
- `.npmrc` content is at most 64 KB.

- [ ] **Step 1: Write the failing test**

`packages/rpc-schema/test/m3-contracts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  envSaveParamsSchema,
  localTypesParamsSchema,
  MAX_NPMRC_CHARS,
  npmInstallParamsSchema,
  npmNameSchema,
  npmrcSaveParamsSchema,
  packageTypesParamsSchema,
} from "../src/ui-rpc";

const ok = (schema: { safeParse(input: unknown): { success: boolean } }, input: unknown) => schema.safeParse(input).success;

describe("M3 contracts", () => {
  test("npm names and install specs accept registry, git and tarball specs and refuse flags and whitespace", () => {
    for (const spec of ["zod", "zod@^4", "@scope/pkg@latest", "git+ssh://git@github.com/a/b.git", "https://x.test/y.tgz"]) {
      expect(ok(npmInstallParamsSchema, { spec })).toBe(true);
    }
    for (const spec of ["--registry=http://evil", "-g", "a b", "", "zod\n--x"]) {
      expect(ok(npmInstallParamsSchema, { spec })).toBe(false);
    }
    expect(["zod", "@types/node", "lodash.merge"].map((name) => ok(npmNameSchema, name))).toEqual([true, true, true]);
    expect(["Zod", "../x", "@/x", "a".repeat(215)].map((name) => ok(npmNameSchema, name))).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("env saves carry valid keys and string values only", () => {
    expect(ok(envSaveParamsSchema, { variables: { API_URL: "https://x" } })).toBe(true);
    expect(ok(envSaveParamsSchema, { variables: { "1A": "x" } })).toBe(false);
    expect(ok(envSaveParamsSchema, { variables: { A: 1 } })).toBe(false);
  });

  test("type requests name at most 50 packages, and local requests carry only relative specifiers", () => {
    expect(ok(packageTypesParamsSchema, { tabId: "t1", packages: ["zod"] })).toBe(true);
    expect(ok(packageTypesParamsSchema, { tabId: "t1", packages: Array.from({ length: 51 }, (_, i) => `p${i}`) })).toBe(false);
    expect(ok(localTypesParamsSchema, { tabId: "t1", specifiers: ["./util", "../lib/x.js"] })).toBe(true);
    expect(ok(localTypesParamsSchema, { tabId: "t1", specifiers: ["zod"] })).toBe(false);
    expect(ok(localTypesParamsSchema, { tabId: "t1", specifiers: ["/etc/passwd"] })).toBe(false);
    expect(ok(localTypesParamsSchema, { tabId: "../x", specifiers: ["./a"] })).toBe(false);
  });

  test(".npmrc content is capped", () => {
    expect(ok(npmrcSaveParamsSchema, { content: "registry=http://127.0.0.1:4873/\n" })).toBe(true);
    expect(ok(npmrcSaveParamsSchema, { content: "x".repeat(MAX_NPMRC_CHARS + 1) })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/rpc-schema && bun test test/m3-contracts.test.ts`
Expected: FAIL, `Export named 'envSaveParamsSchema' not found in module`.

- [ ] **Step 3: Implement the schemas and types**

In `packages/rpc-schema/src/ui-rpc.ts`:

1. Change the second import line to:

```ts
import {
  type EnvVars,
  envVarsSchema,
  LANGUAGES,
  RUNTIMES,
  SETTINGS_SECTIONS,
  type Session,
  type Settings,
} from "@jslab/shared";
```

2. After the `fileConfirmSaveAsSchema` line, add:

```ts
// ---------- M3: npm, environment variables, working directory, types and .npmrc (spec §6.2, §11, §12) ----------

/** npm package names: an optional @scope, lowercase URL-safe characters, at most 214 characters. */
export const npmNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/);

/** One `bun add` argument: name@range, a git URL or a tarball URL. Never whitespace, never a leading "-" (spec §18). */
export const npmSpecSchema = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\s-]\S*$/);

export const MAX_NPMRC_CHARS = 65_536;

export const npmInstallParamsSchema = z.object({ spec: npmSpecSchema });
export const npmNameParamsSchema = z.object({ name: npmNameSchema });
export const npmSearchParamsSchema = z.object({ query: z.string().trim().min(1).max(214) });
export const npmListParamsSchema = z.object({ refreshOutdated: z.boolean() });
export const npmrcSaveParamsSchema = z.object({ content: z.string().max(MAX_NPMRC_CHARS) });
export const envSaveParamsSchema = z.object({ variables: envVarsSchema });
export const packageTypesParamsSchema = z.object({ tabId, packages: z.array(npmNameSchema).min(1).max(50) });
export const localTypesParamsSchema = z.object({
  tabId,
  specifiers: z
    .array(
      z
        .string()
        .min(2)
        .max(1024)
        .regex(/^\.\.?\//),
    )
    .min(1)
    .max(200),
});

export type NpmOpKind = "install" | "remove" | "update" | "updateAll";
export type NpmErrorKind =
  | "network"
  | "notFound"
  | "noMatchingVersion"
  | "peerConflict"
  | "scriptBlocked"
  | "nativeBuild"
  | "disk"
  | "timeout"
  | "unknown";

/** A classified npm failure (spec §11.3): the UI maps `kind` to a one-line hint and shows `log` in the log drawer. */
export interface NpmOpError {
  kind: NpmErrorKind;
  log: string;
}

export interface NpmOperation {
  id: string;
  kind: NpmOpKind;
  /** The spec or package name the operation acts on; "" for updateAll. */
  target: string;
  status: "queued" | "running" | "succeeded" | "failed";
  error: NpmOpError | null;
  /** A non-fatal condition on success, such as "scriptBlocked". */
  notice: NpmErrorKind | null;
}

export interface InstalledPackage {
  name: string;
  /** The version in node_modules, or null when it isn't installed there. */
  version: string | null;
  /** The newest version from the last `bun outdated`, or null when current or unknown. */
  latest: string | null;
}

export interface NpmListResult {
  installed: InstalledPackage[];
  outdatedCheckedAt: number | null;
  outdatedError: NpmOpError | null;
}

export interface NpmSearchResult {
  name: string;
  version: string;
  description: string;
  weeklyDownloads: number | null;
}

export interface NpmSearchResponse {
  results: NpmSearchResult[];
  error: NpmOpError | null;
}

/** One declaration file registered with Monaco, at a `file:///` path. */
export interface TypeFile {
  path: string;
  content: string;
}

export interface PackageTypesResult {
  name: string;
  files: TypeFile[];
  /** Other packages the declarations import (requested separately). */
  dependencies: string[];
  /** `@types/<name>` when the package has no types and that package is installed or available. */
  typesPackage: string | null;
  hasTypes: boolean;
  truncated: boolean;
}

export interface LocalTypesResult {
  files: TypeFile[];
  /** Bare packages the local files import (requested separately). */
  packages: string[];
  truncated: boolean;
}

export type SaveResult = { ok: true } | { ok: false; error: string };

export type { EnvVars };
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/rpc-schema && bun test`
Expected: PASS, 0 fail. `@jslab/rpc-schema` M2 final + 4.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. Counts as in the table row for Task 5.

- [ ] **Step 6: Commit**

```bash
git add packages/rpc-schema
git commit -m "feat(rpc-schema): npm, environment, working-directory, types and npmrc contracts" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 6: Spike: native folder drop on Electrobun 2.0.1 (read-only) — planned stop

**Files:**
- Create: `docs/spikes/2026-09-m3-native-drop.md`
- No product or test code changes.

**Interfaces:**
- Consumes: the Electrobun 2.0.1 devkit sources under `apps/desktop/.hutch/devkit` (`api/sdks/main/{core,events,proc}`, `api/preload`, `zig-sdk`) and any Electrobun native sources Hutch keeps under `~/.hutch` (read only; MIT, not RunJS, so the clean-room rule doesn't forbid reading them). At `d481b19` there is no `node_modules/.bun/electrobun@*`: Electrobun comes from Hutch, not from npm.
- Produces: a GO or NO-GO decision recorded as controller ruling **R-M3-SPIKE-1**, which selects Branch A or Branch B of Task 24 Step 6.

**Rules (carry TF-11; spec §7.3, §12.2):**
- **Read-only.** Read sources, run `grep`/`find`, and run one scripted check that only reads files. Launch no app, send no OS input, change no repo file except the report.
- **GO** only if a Main-process API or event in Electrobun 2.0.1 delivers the file system path of an item dropped onto a `BrowserWindow`/webview, with a payload type that carries the path. A preload that only restores focus (`preload/externalDropFocus.ts`, Windows-only) does not count.
- **NO-GO** otherwise. The webview's `DataTransfer` gives names and contents but no paths, which is why M2 opens dropped files as scratch copies (TF-11).

- [ ] **Step 1: Search the devkit and the package for drop APIs**

Run each command from the repo root and keep the output for the report:

```bash
grep -rn -i -e "drop" -e "dragg" apps/desktop/.hutch/devkit/api/sdks/main apps/desktop/.hutch/devkit/api/preload | grep -v "\.test\.ts:"
grep -n -e "on(" -e "Event" apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserView.ts | head -80
grep -n -e "on(" -e "Event" apps/desktop/.hutch/devkit/api/sdks/main/core/BrowserWindow.ts | head -80
find apps/desktop/.hutch/devkit -type f \( -name "*.zig" -o -name "*.mm" -o -name "*.m" -o -name "*.swift" -o -name "*.h" \) | head -40
find "$HOME/.hutch" -type f -path "*lectrobun*" \( -name "*.zig" -o -name "*.mm" -o -name "*.m" -o -name "*.swift" -o -name "*.h" \) 2>/dev/null | head -40
```

Both `find` commands only read. `~/.hutch` is never written (Global Constraints, Hutch).

For every native source file the `find` lists, run:

```bash
grep -n -e "registerForDraggedTypes" -e "performDragOperation" -e "draggingEntered" -e "NSPasteboardTypeFileURL" -e "NSFilenamesPboardType" <file>
```

- [ ] **Step 2: Run the scripted event-name check**

Create a fresh folder with `spike_dir="$(mktemp -d "$TMPDIR/jslab-spike-XXXXXX")"` (Global Constraints (b): never a module directly in `$TMPDIR`), and write `"$spike_dir/spike-drop-events.ts"` (outside the repo):

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".", "apps/desktop/.hutch/devkit/api/sdks/main");
const files = ["core/BrowserView.ts", "core/BrowserWindow.ts", "proc/native.ts", "events/eventEmitter.ts"];
for (const file of files) {
  let text = "";
  try {
    text = readFileSync(resolve(root, file), "utf8");
  } catch {
    console.log(`${file}: not present`);
    continue;
  }
  const names = new Set<string>();
  for (const match of text.matchAll(/["'`]([a-z][a-z0-9]*(?:-[a-z0-9]+)+)["'`]/g)) names.add(match[1] as string);
  const dropLike = [...names].filter((name) => /drop|drag|file/.test(name));
  console.log(`${file}: ${names.size} dashed names; drop-like: ${JSON.stringify(dropLike)}`);
}
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun "$spike_dir/spike-drop-events.ts" "$PWD"; rm -rf "$spike_dir"`
Expected: one line per file. A GO needs at least one drop-like event name whose handler payload (read it in the source) carries paths.

- [ ] **Step 3: Write the report**

`docs/spikes/2026-09-m3-native-drop.md`:

````markdown
# M3 Spike: Native Folder Drop on Electrobun 2.0.1

**Question:** Can Electrobun 2.0.1 deliver the file system path of a folder (or file) dropped onto the JSLab window to Main, so a folder drop sets the tab's working directory (spec §12.2) and a file drop opens a file-backed tab (TF-11)?

**Method:** read-only source audit of the devkit (`apps/desktop/.hutch/devkit`) and Hutch's Electrobun 2.0.1 sources under `~/.hutch`, plus a scripted scan of event names. No app launch, no OS input.

## Evidence

<paste the commands from Steps 1–2 and their output here, with home paths written as ~>

## Decision

<GO or NO-GO>, because <one sentence naming the API and its payload, or stating that no Main-side API carries dropped paths>.

- GO → Task 24 Step 6 Branch A (native drop sets the WD; TF-11 gains file-backed drops).
- NO-GO → Task 24 Step 6 Branch B (WD by picker, chip and menu only; the folder-drop notice points at Actions → Set Working Directory…; TF-11 and spec §7.3/§12.2 record the deviation).

## Upstream

If NO-GO: file-drop paths for `BrowserWindow` are an Electrobun feature request. JSLab revisits this when the pinned Electrobun changes.
````

Replace the three angle-bracket lines with the real content. The report contains no absolute home path.

- [ ] **Step 4: STOP and report to the controller**

Stop here. Report: GO or NO-GO, the API name and payload (GO) or the evidence summary (NO-GO), and the report path. The controller records ruling **R-M3-SPIKE-1** in the ledger and tells the Task 24 implementer which branch to build. Don't start Task 7 in the same dispatch.

- [ ] **Step 5: Commit (after the controller's ruling)**

```bash
git add docs/spikes/2026-09-m3-native-drop.md
git commit -m "docs(spikes): native folder drop on electrobun 2.0.1" -m "$JSLAB_COMMIT_TRAILER"
```

Gates: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint` exits 0 (docs only; counts unchanged).

---

### Task 7: `@jslab/npm`: specifiers, `.npmrc` and the isolated npm environment

**Files:**
- Create: `packages/npm/package.json`, `packages/npm/tsconfig.json`, `packages/npm/src/index.ts`, `packages/npm/src/specifiers.ts`, `packages/npm/src/npmrc.ts`, `packages/npm/src/environment.ts`
- Test: `packages/npm/test/specifiers.test.ts`, `packages/npm/test/npmrc.test.ts`, `packages/npm/test/environment.test.ts`
- Modify: `bun.lock` (workspace link, via `bun install`)

**Interfaces:**
- Consumes: `DEFAULT_REGISTRY` (Task 4).
- Produces (`@jslab/npm`; `@jslab/npm/specifiers` is importable from the UI because it has no `node:` imports):
  - `NODE_BUILTINS: ReadonlySet<string>`
  - `packageNameFromSpecifier(specifier: string): string | null`
  - `type InstallSpec = { kind: "registry"; name: string; range: string | null; raw: string } | { kind: "git" | "tarball" | "path"; name: null; raw: string }`, `parseInstallSpec(input: string): InstallSpec | null`
  - `typesPackageName(name: string): string | null`
  - `type NpmrcConfig = ReadonlyMap<string, string>`, `parseNpmrc(text: string): Map<string, string>`, `expandNpmrcValue(value: string, env: EnvLike): string`, `registryFor(config: NpmrcConfig, packageName: string | null, env: EnvLike): string`, `authTokenFor(config: NpmrcConfig, registryUrl: string, env: EnvLike): string | null`
  - `type EnvLike = Record<string, string | undefined>`, `resolveBunCacheDir(env: EnvLike, realHome: string): string`, `npmEnvironment(input: { base: EnvLike; npmHome: string; bunCacheDir: string }): Record<string, string>`

**Rules (spec §11.3, §11.4; M0-S8 Decision):**
- `packageNameFromSpecifier`: `@a/b/c` → `@a/b`; `lodash/fp` → `lodash`; relative, absolute, `#imports`, URL-like (`node:`, `bun:`, `http:`, `file:`), `bun` and Node built-ins (including `fs/promises`) → `null`.
- The npm environment starts from the login-shell environment, then:
  - drops every `JSLAB_*` key, `HOME`, `BUN_INSTALL_CACHE_DIR`, `XDG_CONFIG_HOME` (it could point Bun at a global `bunfig.toml`), and every key starting with `BUN_CONFIG_` or `NPM_CONFIG_`, compared case-insensitively (which covers `npm_config_*`);
  - sets `HOME=<npmHome>`, `BUN_INSTALL_CACHE_DIR=<bunCacheDir>`, `NO_COLOR=1`;
  - keeps everything else, including `PATH`, `SSH_AUTH_SOCK` and `GIT_SSH_COMMAND` (git-over-SSH specs authenticate through the agent or an explicit command; the real `HOME` is never restored).
- `resolveBunCacheDir`: the login-shell `BUN_INSTALL_CACHE_DIR` if set; else `$XDG_CACHE_HOME/.bun/install/cache`; else `$BUN_INSTALL/install/cache`; else `<real home>/.bun/install/cache`. Task 9 verifies this order against `bun pm cache` on the bundled Bun and stops if it differs.
- `.npmrc`: `;` and `#` comments, `key = value`, surrounding quotes stripped, a later key wins, `${VAR}` expanded from the npm environment. `registryFor` prefers `@scope:registry`, then `registry`, then `DEFAULT_REGISTRY`, always with a trailing `/`. `authTokenFor` uses the longest `//host[:port]/path/:_authToken` key that prefixes the registry URL without its protocol.

- [ ] **Step 1: Create the package and link it**

`packages/npm/package.json`:

```json
{
  "name": "@jslab/npm",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./specifiers": "./src/specifiers.ts"
  },
  "dependencies": {
    "@jslab/rpc-schema": "workspace:*",
    "@jslab/shared": "workspace:*"
  },
  "scripts": {
    "test": "bun test ./test",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/npm/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

`packages/npm/src/index.ts`:

```ts
export * from "./environment";
export * from "./npmrc";
export * from "./specifiers";
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun install`
Expected: exit 0; `bun.lock` gains the `@jslab/npm` workspace entry and no new registry packages.

- [ ] **Step 2: Write the failing tests**

`packages/npm/test/specifiers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { packageNameFromSpecifier, parseInstallSpec, typesPackageName } from "../src/specifiers";

describe("specifiers (spec §11.4)", () => {
  test("derives the package name from bare import specifiers", () => {
    expect(
      ["zod", "zod/v4", "@a/b", "@a/b/c/d.js", "lodash.merge", "react-dom/client"].map(packageNameFromSpecifier),
    ).toEqual(["zod", "zod", "@a/b", "@a/b", "lodash.merge", "react-dom"]);
  });

  test("ignores relative, absolute, subpath-import, URL, bun and Node built-in specifiers", () => {
    expect(
      ["./x", "../x", "/abs", "#internal", "node:fs", "bun:test", "bun", "fs", "fs/promises", "https://x/y.js", "@", "@a", "Zod"].map(
        packageNameFromSpecifier,
      ),
    ).toEqual([null, null, null, null, null, null, null, null, null, null, null, null, null]);
  });

  test("parses install specs: registry names with ranges, git, tarball and path specs", () => {
    expect(parseInstallSpec("zod@^4")).toEqual({ kind: "registry", name: "zod", range: "^4", raw: "zod@^4" });
    expect(parseInstallSpec("@scope/name@latest")).toEqual({
      kind: "registry",
      name: "@scope/name",
      range: "latest",
      raw: "@scope/name@latest",
    });
    expect(parseInstallSpec(" zod ")).toEqual({ kind: "registry", name: "zod", range: null, raw: "zod" });
    expect(parseInstallSpec("git+ssh://git@github.com/a/b.git")?.kind).toBe("git");
    expect(parseInstallSpec("user/repo#main")?.kind).toBe("git");
    expect(parseInstallSpec("https://registry.test/x/-/x-1.0.0.tgz")?.kind).toBe("tarball");
    expect(parseInstallSpec("file:../local")?.kind).toBe("path");
    expect(["", "-g", "a b", "Zod@1"].map(parseInstallSpec)).toEqual([null, null, null, null]);
  });

  test("names the @types package for a package", () => {
    expect(["zod", "@scope/x", "@types/node"].map(typesPackageName)).toEqual(["@types/zod", "@types/scope__x", null]);
  });
});
```

`packages/npm/test/npmrc.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { authTokenFor, parseNpmrc, registryFor } from "../src/npmrc";

describe(".npmrc (spec §11.3, §11.5)", () => {
  test("parses keys and values, strips quotes and comments, and a later key wins", () => {
    const config = parseNpmrc(
      [
        "; comment",
        "# comment",
        'registry = "http://127.0.0.1:4873"',
        "@acme:registry=https://npm.acme.test/",
        "registry=http://127.0.0.1:4874/",
        "  malformed line",
      ].join("\n"),
    );
    // A later key wins and moves to the end (parseNpmrc deletes, then sets).
    expect([...config]).toEqual([
      ["@acme:registry", "https://npm.acme.test/"],
      ["registry", "http://127.0.0.1:4874/"],
    ]);
  });

  test("picks the scoped registry, then the default, with a trailing slash and ${VAR} expansion", () => {
    const config = parseNpmrc("registry=${REG}\n@acme:registry=https://npm.acme.test");
    const env = { REG: "http://127.0.0.1:4873" };
    expect(registryFor(config, "@acme/tool", env)).toBe("https://npm.acme.test/");
    expect(registryFor(config, "zod", env)).toBe("http://127.0.0.1:4873/");
    expect(registryFor(parseNpmrc(""), null, {})).toBe("https://registry.npmjs.org/");
  });

  test("uses the longest matching _authToken for the registry URL", () => {
    const config = parseNpmrc(
      [
        "//npm.acme.test/:_authToken=short",
        "//npm.acme.test/private/:_authToken=${TOKEN}",
        "//other.test/:_authToken=nope",
      ].join("\n"),
    );
    expect(authTokenFor(config, "https://npm.acme.test/private/", { TOKEN: "long" })).toBe("long");
    expect(authTokenFor(config, "https://npm.acme.test/", {})).toBe("short");
    expect(authTokenFor(config, "http://127.0.0.1:4873/", {})).toBeNull();
  });
});
```

`packages/npm/test/environment.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { npmEnvironment, resolveBunCacheDir } from "../src/environment";

/** A fake user home (built with `join`, so no literal home path appears in the source). */
const USER_HOME = join("/Users", "tester");

describe("npm environment (M0-S8, spec §11.3)", () => {
  test("strips user npm and Bun config variables, JSLab variables and XDG_CONFIG_HOME, and sets the isolated HOME and cache", () => {
    const env = npmEnvironment({
      base: {
        PATH: "/usr/bin:/bin",
        HOME: USER_HOME,
        BUN_CONFIG_REGISTRY: "http://evil.test/",
        bun_config_verbose: "1",
        NPM_CONFIG_USERCONFIG: `${USER_HOME}/.npmrc`,
        npm_config_registry: "http://evil.test/",
        Npm_Config_Cache: "/x",
        XDG_CONFIG_HOME: `${USER_HOME}/.config`,
        BUN_INSTALL_CACHE_DIR: "/somewhere/else",
        JSLAB_USER_DATA: "/data",
        LANG: "en_US.UTF-8",
        EMPTY: undefined,
      },
      npmHome: "/data/npm-home",
      bunCacheDir: `${USER_HOME}/.bun/install/cache`,
    });
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      HOME: "/data/npm-home",
      BUN_INSTALL_CACHE_DIR: `${USER_HOME}/.bun/install/cache`,
      NO_COLOR: "1",
    });
  });

  test("resolves the user's Bun cache before HOME is overridden", () => {
    expect(resolveBunCacheDir({ BUN_INSTALL_CACHE_DIR: "/c", XDG_CACHE_HOME: "/x", BUN_INSTALL: "/b" }, USER_HOME)).toBe(
      "/c",
    );
    expect(resolveBunCacheDir({ XDG_CACHE_HOME: "/x/", BUN_INSTALL: "/b" }, USER_HOME)).toBe("/x/.bun/install/cache");
    expect(resolveBunCacheDir({ BUN_INSTALL: "/b" }, USER_HOME)).toBe("/b/install/cache");
    expect(resolveBunCacheDir({}, USER_HOME)).toBe(`${USER_HOME}/.bun/install/cache`);
  });

  test("git-over-SSH specs keep the agent socket and an explicit ssh command, never the real HOME (M0-S8 follow-up)", () => {
    const env = npmEnvironment({
      base: { HOME: USER_HOME, SSH_AUTH_SOCK: "/tmp-ssh/agent.sock", GIT_SSH_COMMAND: "ssh -i ~/.ssh/k" },
      npmHome: "/data/npm-home",
      bunCacheDir: "/cache",
    });
    expect([env.SSH_AUTH_SOCK, env.GIT_SSH_COMMAND, env.HOME]).toEqual([
      "/tmp-ssh/agent.sock",
      "ssh -i ~/.ssh/k",
      "/data/npm-home",
    ]);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/npm && bun test ./test`
Expected: FAIL, `Cannot find module "../src/specifiers"` (and `npmrc`, `environment`).

- [ ] **Step 4: Implement**

`packages/npm/src/specifiers.ts`:

```ts
/** Node built-ins (spec §11.4: never offered for install). Bun resolves them before any package. */
export const NODE_BUILTINS: ReadonlySet<string> = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The package a bare import specifier names (spec §11.4): `@a/b/c` → `@a/b`, `lodash/fp` → `lodash`. Relative,
 * absolute, `#` subpath imports, URL-like (`node:`, `bun:`, `https:`), `bun` and Node built-ins give null.
 */
export function packageNameFromSpecifier(specifier: string): string | null {
  const spec = specifier.trim();
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#") || URL_LIKE.test(spec)) return null;
  if (spec === "bun") return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? (parts[1] ? `${parts[0]}/${parts[1]}` : null) : (parts[0] ?? null);
  if (!name || !PACKAGE_NAME.test(name)) return null;
  if (!name.startsWith("@") && NODE_BUILTINS.has(name)) return null;
  return name;
}

export type InstallSpec =
  | { kind: "registry"; name: string; range: string | null; raw: string }
  | { kind: "git" | "tarball" | "path"; name: null; raw: string };

/** What the NPM sheet's input installs (spec §11.2): name@version/range, a git URL, a tarball URL or a local path. */
export function parseInstallSpec(input: string): InstallSpec | null {
  const raw = input.trim();
  if (!raw || /\s/.test(raw) || raw.startsWith("-")) return null;
  if (/^(?:git\+|git:\/\/|github:|gitlab:|bitbucket:)/.test(raw) || /\.git(?:#.*)?$/.test(raw)) {
    return { kind: "git", name: null, raw };
  }
  if (/^https?:\/\//.test(raw)) return { kind: "tarball", name: null, raw };
  if (raw.startsWith("file:") || raw.startsWith(".") || raw.startsWith("/")) return { kind: "path", name: null, raw };
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(raw) && !raw.startsWith("@")) return { kind: "git", name: null, raw };
  const at = raw.startsWith("@") ? raw.indexOf("@", 1) : raw.indexOf("@");
  const name = at < 0 ? raw : raw.slice(0, at);
  const range = at < 0 ? null : raw.slice(at + 1) || null;
  if (!PACKAGE_NAME.test(name)) return null;
  return { kind: "registry", name, range, raw };
}

/** `zod` → `@types/zod`, `@scope/x` → `@types/scope__x`; an `@types` package has none. */
export function typesPackageName(name: string): string | null {
  if (name.startsWith("@types/")) return null;
  return name.startsWith("@") ? `@types/${name.slice(1).replace("/", "__")}` : `@types/${name}`;
}
```

`packages/npm/src/npmrc.ts`:

```ts
import { DEFAULT_REGISTRY } from "@jslab/shared";

export type NpmrcConfig = ReadonlyMap<string, string>;
export type EnvLike = Record<string, string | undefined>;

/** Parses `<packages>/.npmrc` (spec §11.5). A later key wins; comments start with `;` or `#`. */
export function parseNpmrc(text: string): Map<string, string> {
  const config = new Map<string, string>();
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    config.delete(key);
    config.set(key, value);
  }
  return config;
}

export function expandNpmrcValue(value: string, env: EnvLike): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

const withSlash = (url: string) => (url.endsWith("/") ? url : `${url}/`);

export function registryFor(config: NpmrcConfig, packageName: string | null, env: EnvLike): string {
  const scope = packageName?.startsWith("@") ? packageName.split("/")[0] : null;
  const scoped = scope ? config.get(`${scope}:registry`) : undefined;
  const chosen = scoped ?? config.get("registry");
  return withSlash(chosen ? expandNpmrcValue(chosen, env) : DEFAULT_REGISTRY);
}

/** The `_authToken` whose `//host/path/` key is the longest prefix of the registry URL (without its protocol). */
export function authTokenFor(config: NpmrcConfig, registryUrl: string, env: EnvLike): string | null {
  const target = withSlash(registryUrl.replace(/^https?:/, ""));
  let best: { length: number; token: string } | null = null;
  for (const [key, value] of config) {
    if (!key.endsWith(":_authToken") || !key.startsWith("//")) continue;
    const prefix = withSlash(key.slice(0, -":_authToken".length));
    if (!target.startsWith(prefix)) continue;
    if (!best || prefix.length > best.length) best = { length: prefix.length, token: expandNpmrcValue(value, env) };
  }
  return best?.token || null;
}
```

`packages/npm/src/environment.ts`:

```ts
import type { EnvLike } from "./npmrc";

const STRIPPED_KEYS = new Set(["HOME", "BUN_INSTALL_CACHE_DIR", "XDG_CONFIG_HOME"]);
const STRIPPED_PREFIXES = ["bun_config_", "npm_config_"];

const trimSlash = (path: string) => path.replace(/\/+$/, "");

/**
 * The user's Bun package cache, resolved from the login-shell environment before HOME is overridden (spec §11.3):
 * BUN_INSTALL_CACHE_DIR, then $XDG_CACHE_HOME/.bun/install/cache, then $BUN_INSTALL/install/cache, then the real home.
 * Task 9 checks this order against `bun pm cache` on the bundled Bun.
 */
export function resolveBunCacheDir(env: EnvLike, realHome: string): string {
  if (env.BUN_INSTALL_CACHE_DIR) return env.BUN_INSTALL_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return `${trimSlash(env.XDG_CACHE_HOME)}/.bun/install/cache`;
  if (env.BUN_INSTALL) return `${trimSlash(env.BUN_INSTALL)}/install/cache`;
  return `${trimSlash(realHome)}/.bun/install/cache`;
}

/**
 * The environment of every npm operation (M0-S8 Decision, spec §11.3). HOME points at the app-owned, empty npm-home,
 * so the user's ~/.npmrc never applies; npm and Bun config variables are stripped, so `<packages>/.npmrc` is the only
 * source of registry and auth settings. SSH_AUTH_SOCK and GIT_SSH_COMMAND pass through for git-over-SSH specs.
 */
export function npmEnvironment(input: { base: EnvLike; npmHome: string; bunCacheDir: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value === undefined || key.startsWith("JSLAB_") || STRIPPED_KEYS.has(key)) continue;
    const lower = key.toLowerCase();
    if (STRIPPED_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    env[key] = value;
  }
  env.HOME = input.npmHome;
  env.BUN_INSTALL_CACHE_DIR = input.bunCacheDir;
  env.NO_COLOR = "1";
  return env;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/npm && bun test ./test`
Expected: PASS, 10 pass, 0 fail.

- [ ] **Step 6: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/npm` 10; every other package as in the Task 7 row.

- [ ] **Step 7: Commit**

```bash
git add packages/npm bun.lock
git commit -m "feat(npm): specifiers, npmrc parsing and the isolated npm environment" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 8: `@jslab/test-registry`: Verdaccio lifecycle and fixtures (ruling R-M3-REG-1: Verdaccio)

**Files:**
- Create: `packages/test-registry/package.json`, `packages/test-registry/tsconfig.json`, `packages/test-registry/bunfig.toml`
- Create: `packages/test-registry/src/index.ts`, `src/free-port.ts`, `src/config.ts`, `src/registry.ts`, `src/fixtures.ts`
- Create: `packages/test-registry/test/config.test.ts`, `packages/test-registry/test/fixtures.test.ts`
- Create: `packages/test-registry/integration/registry.test.ts` (opt-in)
- Modify: `package.json` (root scripts), `bun.lock`

**Interfaces:**
- Consumes: `npmEnvironment` (Task 7), `defaultPackagesManifest` (Task 4).
- Produces (`@jslab/test-registry`):
  - `findFreePort(): number`
  - `verdaccioConfig(input: { storage: string; port: number }): string`
  - `interface TestRegistry { url: string; port: number; pid: number; root: string; stop(): Promise<void> }`
  - `startTestRegistry(options?: { root?: string; readyTimeoutMs?: number }): Promise<TestRegistry>`
  - `interface FixtureManifest { name: string; version: string; [key: string]: unknown }`
  - `writeFixturePackage(root: string, manifest: FixtureManifest, files: Record<string, string>): Promise<string>`
  - `packDirectory(dir: string, outDir: string): Promise<{ tarball: Uint8Array; manifest: FixtureManifest }>`
  - `buildPublishBody(registryUrl: string, manifest: FixtureManifest, tarball: Uint8Array, tag?: string): Record<string, unknown>`
  - `publishPackage(registryUrl: string, dir: string, workDir: string, tag?: string): Promise<void>`
  - `copyInstalledPackage(name: string, fromDir: string, toRoot: string): Promise<string>`
  - `publishStandardFixtures(registryUrl: string, workRoot: string, options?: { zod?: boolean }): Promise<void>`: publishes `fixture-outdated@1.0.0` and `@1.1.0`, `fixture-script@1.0.0` (a `postinstall` that runs `touch postinstall-ran.txt`), `@jslab-fixture/scoped@1.0.0`, `fixture-untyped@1.0.0`, `@types/fixture-untyped@1.0.0`, and, with `zod: true`, the installed `zod` 4.6.4
  - `isAlive(pid: number): boolean`
  - Root scripts: `"test:npm"` and, in Task 28, `"e2e:npm"`.

**Rules (ruling R-M3-REG-1, the user's choice; binding default R-M3-PLAN-1 (e); spec §22.2):**
- **Verdaccio is the test registry.** It is an exact-pinned, MIT-licensed `devDependency` of `@jslab/test-registry` only. It is never a dependency of `apps/desktop` or `apps/ui`, so it's never shipped in the app. There is no global install and no `npx`/`bunx` download at test time.
- The registry root, config, storage and a private `HOME` live under one fresh `mkdtemp` folder in `os.tmpdir()`. The config has **no uplinks**, so nothing reaches a public registry. It listens on `127.0.0.1:<free port>`.
- The PID of the spawned process is tracked. `stop()` sends SIGTERM to that PID, waits up to 5 s, sends SIGKILL if needed, waits for exit, then removes the root. Nothing is matched by name.
- `bun run test` runs only `packages/test-registry/test` (`bunfig.toml` `root = "./test"`), and never starts a registry. Only `bun run test:npm` runs the `integration/` folders and starts Verdaccio. CI never runs `test:npm`; CI's `bun install --frozen-lockfile` downloads Verdaccio's tree as a workspace devDependency but never starts it.
- Fixture packages are generated at test time; `zod` is packed from the zod 4.6.4 that the workspace already has installed. No tarball is checked in.
- **Fallback, stop only:** if Verdaccio can't run under the bundled Bun 1.4.0 (Step 3 or Step 7), stop and report with evidence. Don't write a replacement registry; the controller rules on an in-repo fake registry.

- [ ] **Step 1: Pin the Verdaccio version and confirm its license**

```bash
export PATH="$HOME/.hutch/bin:$PATH"
bun pm view verdaccio@6 version
```

The newest `6.x` version it prints (the last line) is the exact pin, written below as `<VERSION>`. Then run `bun pm view verdaccio@<VERSION> license`.
Expected: `MIT`. Anything else: stop and report it. Record the pinned version in the commit body.

- [ ] **Step 2: Create the package**

`packages/test-registry/package.json` (replace `<VERSION>` with the version pinned in Step 1 before saving):

```json
{
  "name": "@jslab/test-registry",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@jslab/npm": "workspace:*",
    "@jslab/shared": "workspace:*"
  },
  "devDependencies": {
    "verdaccio": "<VERSION>"
  },
  "scripts": {
    "test": "bun test ./test",
    "test:npm": "bun test ./integration --timeout 120000",
    "capture": "bun scripts/capture-bun-output.ts",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/test-registry/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "integration", "scripts"]
}
```

`packages/test-registry/bunfig.toml`:

```toml
# A bare `bun test` here runs only the unit tests. The opt-in suite under integration/ starts Verdaccio, so it runs
# only through `bun run test:npm`, which names ./integration explicitly (Global Constraints (c)).
[test]
root = "./test"
```

Root `package.json` `scripts`, add after `"e2e"` (Task 12 appends the desktop suite to it):

```json
    "test:npm": "bun run --cwd packages/test-registry test:npm"
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun install`
Expected: exit 0; `bun.lock` gains `verdaccio` at `<VERSION>` and its tree.

**License checks:**

```bash
builtin cd packages/test-registry && bun -e 'const pkg = require(Bun.resolveSync("verdaccio/package.json", process.cwd())); console.log(pkg.name, pkg.version, pkg.license)' && builtin cd ../..
find node_modules/.bun -maxdepth 4 -name package.json -path "*/node_modules/*" -print0 | xargs -0 grep -l -E '"license": *"(A|L)?GPL' | head
```

Expected: `verdaccio <VERSION> MIT` from the installed package metadata, then no output from the GPL scan. If the license isn't MIT, or any package prints, stop and report it.

- [ ] **Step 3: Check that Verdaccio runs under the bundled Bun 1.4.0**

```bash
(
  shim="$(mktemp -d "$TMPDIR/jslab-bun140-XXXXXX")" && ln -s "$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64/bun" "$shim/bun"
  export PATH="$shim:$HOME/.hutch/bin:$PATH"
  builtin cd packages/test-registry && bun --version
  bin="$(bun -e 'const dir = require("node:path").dirname(Bun.resolveSync("verdaccio/package.json", process.cwd())); const pkg = require(dir + "/package.json"); const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin.verdaccio; console.log(require("node:path").join(dir, bin));')"
  perl -e 'alarm 30; exec @ARGV' -- bun "$bin" --version
  status=$?
  rm -rf "$shim"
  exit $status
)
```

Expected: `1.4.0`, then a version line matching `<VERSION>`, exit 0.

**If it fails, STOP.** Report `<VERSION>`, `bun --version`, the exact command and its complete output (home paths written as `~`). Don't add a workaround or a replacement registry; the controller rules on an in-repo fake registry.

- [ ] **Step 4: Write the failing unit tests**

`packages/test-registry/test/config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { verdaccioConfig } from "../src/config";
import { findFreePort } from "../src/free-port";

describe("test registry config", () => {
  test("stores packages under the given folder, listens on loopback and has no uplinks", () => {
    const yaml = verdaccioConfig({ storage: "/tmp-x/storage dir", port: 4999 });
    expect(yaml).toContain('storage: "/tmp-x/storage dir"');
    expect(yaml).toContain("listen: 127.0.0.1:4999");
    expect(yaml).toContain("uplinks: {}");
    expect(yaml).not.toContain("proxy:");
    expect(yaml).toContain("enable: false");
  });

  test("finds a loopback port that can be bound", () => {
    const port = findFreePort();
    expect(port).toBeGreaterThan(1024);
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    expect(server.port).toBe(port);
    server.stop(true);
  });
});
```

`packages/test-registry/test/fixtures.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPublishBody, packDirectory, writeFixturePackage } from "../src/fixtures";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-fixture-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fixture packages", () => {
  test("packs a package folder as package/… and builds an npm publish body with integrity", async () => {
    const pkg = await writeFixturePackage(join(dir, "src"), { name: "@jslab-fixture/scoped", version: "1.0.0" }, {
      "index.js": "export const scoped = 'ok';\n",
    });
    const { tarball, manifest } = await packDirectory(pkg, join(dir, "out"));
    const listing = Bun.spawnSync(["tar", "-tzf", "-"], { stdin: tarball }).stdout.toString().split("\n").filter(Boolean);
    expect(listing.sort()).toEqual(["package/index.js", "package/package.json"]);
    const body = buildPublishBody("http://127.0.0.1:4873/", manifest, tarball) as {
      name: string;
      "dist-tags": Record<string, string>;
      versions: Record<string, { dist: { tarball: string; integrity: string } }>;
      _attachments: Record<string, { length: number }>;
    };
    expect(body.name).toBe("@jslab-fixture/scoped");
    expect(body["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(body.versions["1.0.0"]?.dist.tarball).toBe("http://127.0.0.1:4873/@jslab-fixture/scoped/-/scoped-1.0.0.tgz");
    expect(body.versions["1.0.0"]?.dist.integrity).toStartWith("sha512-");
    expect(body._attachments["scoped-1.0.0.tgz"]?.length).toBe(tarball.byteLength);
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/test-registry && bun test ./test`
Expected: FAIL, `Cannot find module "../src/config"`.

- [ ] **Step 5: Implement the package**

`packages/test-registry/src/free-port.ts`:

```ts
/** A loopback port that was free a moment ago (the registry binds it right after). */
export function findFreePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const { port } = server;
  server.stop(true);
  return port;
}
```

`packages/test-registry/src/config.ts`:

```ts
/**
 * Verdaccio config for tests: storage under a temp folder, loopback only, no uplinks (so no public registry is ever
 * contacted), the web UI off, and anonymous publish so fixtures can be published without accounts.
 */
export function verdaccioConfig(input: { storage: string; port: number }): string {
  return [
    `storage: ${JSON.stringify(input.storage)}`,
    `listen: 127.0.0.1:${input.port}`,
    "max_body_size: 100mb",
    "web:",
    "  enable: false",
    "uplinks: {}",
    "packages:",
    "  '@*/*':",
    "    access: $all",
    "    publish: $anonymous",
    "    unpublish: $anonymous",
    "  '**':",
    "    access: $all",
    "    publish: $anonymous",
    "    unpublish: $anonymous",
    "log:",
    "  type: stdout",
    "  format: pretty",
    "  level: warn",
    "",
  ].join("\n");
}
```

`packages/test-registry/src/registry.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { verdaccioConfig } from "./config";
import { findFreePort } from "./free-port";

export interface TestRegistry {
  url: string;
  port: number;
  pid: number;
  root: string;
  stop(): Promise<void>;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function registryCommand(root: string, port: number): string[] {
  const dir = dirname(Bun.resolveSync("verdaccio/package.json", import.meta.dir));
  const pkg = require(join(dir, "package.json")) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.verdaccio as string);
  return [process.execPath, join(dir, bin), "--config", join(root, "config.yaml"), "--listen", `127.0.0.1:${port}`];
}

async function waitForPing(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}-/ping`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(100);
  }
  throw new Error(`The test registry did not answer ${url}-/ping within ${timeoutMs} ms (${String(last)})`);
}

/** Starts a private registry under a temp folder with a tracked PID (R-M3-PLAN-1 (e)). */
export async function startTestRegistry(options: { root?: string; readyTimeoutMs?: number } = {}): Promise<TestRegistry> {
  const root = options.root ?? (await mkdtemp(join(tmpdir(), "jslab-registry-")));
  const storage = join(root, "storage");
  const home = join(root, "home");
  await mkdir(storage, { recursive: true });
  await mkdir(home, { recursive: true });
  const port = findFreePort();
  await writeFile(join(root, "config.yaml"), verdaccioConfig({ storage, port }));
  const proc = Bun.spawn(registryCommand(root, port), {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: tmpdir(), NO_COLOR: "1" },
    stdout: Bun.file(join(root, "registry.log")),
    stderr: Bun.file(join(root, "registry.err.log")),
  });
  const url = `http://127.0.0.1:${port}/`;
  const stop = async () => {
    if (isAlive(proc.pid)) {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {}
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(5000).then(() => false)]);
      if (!exited && isAlive(proc.pid)) {
        try {
          process.kill(proc.pid, "SIGKILL");
        } catch {}
      }
      await proc.exited;
    }
    if (process.env.JSLAB_REGISTRY_KEEP !== "1") await rm(root, { recursive: true, force: true });
  };
  try {
    await waitForPing(url, options.readyTimeoutMs ?? 30_000);
  } catch (error) {
    await stop();
    throw error;
  }
  return { url, port, pid: proc.pid, root, stop };
}
```

`packages/test-registry/src/fixtures.ts`:

```ts
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface FixtureManifest {
  name: string;
  version: string;
  [key: string]: unknown;
}

const folderName = (manifest: FixtureManifest) => `${manifest.name.replace("/", "__")}@${manifest.version}`;
const unscoped = (name: string) => name.split("/").pop() as string;

/** Writes `<root>/<name>@<version>/` with a package.json and the given files; returns that folder. */
export async function writeFixturePackage(
  root: string,
  manifest: FixtureManifest,
  files: Record<string, string>,
): Promise<string> {
  const dir = join(root, folderName(manifest));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return dir;
}

/** Packs a folder like `npm pack`: every file under `package/`, gzipped (system tar, no AppleDouble files). */
export async function packDirectory(dir: string, outDir: string): Promise<{ tarball: Uint8Array; manifest: FixtureManifest }> {
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as FixtureManifest;
  await mkdir(outDir, { recursive: true });
  // A sibling of outDir (`<outDir>-stage-XXXXXX`, whose parent exists), so staging never lands inside the tarball folder.
  const staging = await mkdtemp(`${outDir.replace(/\/$/, "")}-stage-`);
  await cp(dir, join(staging, "package"), {
    recursive: true,
    dereference: true,
    // Relative to the package folder: the folder itself may sit inside a node_modules store.
    filter: (source) => !source.slice(dir.length).includes("/node_modules"),
  });
  const file = join(outDir, `${unscoped(manifest.name)}-${manifest.version}.tgz`);
  const tar = Bun.spawnSync(["tar", "-czf", file, "-C", staging, "package"], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
  });
  await rm(staging, { recursive: true, force: true });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return { tarball: new Uint8Array(await Bun.file(file).arrayBuffer()), manifest };
}

/** The npm registry publish document (`PUT /<name>`). */
export function buildPublishBody(
  registryUrl: string,
  manifest: FixtureManifest,
  tarball: Uint8Array,
  tag = "latest",
): Record<string, unknown> {
  const file = `${unscoped(manifest.name)}-${manifest.version}.tgz`;
  const shasum = new Bun.CryptoHasher("sha1").update(tarball).digest("hex");
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(tarball).digest("base64")}`;
  return {
    _id: manifest.name,
    name: manifest.name,
    description: typeof manifest.description === "string" ? manifest.description : "",
    "dist-tags": { [tag]: manifest.version },
    versions: {
      [manifest.version]: {
        ...manifest,
        _id: `${manifest.name}@${manifest.version}`,
        dist: { shasum, integrity, tarball: `${registryUrl}${manifest.name}/-/${file}` },
      },
    },
    _attachments: {
      [file]: {
        content_type: "application/octet-stream",
        data: Buffer.from(tarball).toString("base64"),
        length: tarball.byteLength,
      },
    },
  };
}

export async function publishPackage(registryUrl: string, dir: string, workDir: string, tag = "latest"): Promise<void> {
  const { tarball, manifest } = await packDirectory(dir, join(workDir, "tarballs"));
  const response = await fetch(`${registryUrl}${manifest.name.replace("/", "%2f")}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildPublishBody(registryUrl, manifest, tarball, tag)),
  });
  if (!response.ok) throw new Error(`publish ${manifest.name}@${manifest.version} failed: ${response.status} ${await response.text()}`);
}

/** Copies an installed package (resolved from `fromDir`) into `<toRoot>/<name>@<version>/`. */
export async function copyInstalledPackage(name: string, fromDir: string, toRoot: string): Promise<string> {
  const source = dirname(Bun.resolveSync(`${name}/package.json`, fromDir));
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as FixtureManifest;
  const target = join(toRoot, folderName(manifest));
  await cp(source, target, {
    recursive: true,
    dereference: true,
    // Relative to the package folder: an installed package lives inside node_modules/.bun/…/node_modules itself.
    filter: (path) => !path.slice(source.length).includes("/node_modules"),
  });
  return target;
}

/** The fixtures every npm integration test and npm scenario uses. */
export async function publishStandardFixtures(
  registryUrl: string,
  workRoot: string,
  options: { zod?: boolean } = {},
): Promise<void> {
  const src = join(workRoot, "fixtures");
  const packages = [
    await writeFixturePackage(src, { name: "fixture-outdated", version: "1.0.0", main: "index.js" }, {
      "index.js": "module.exports = { version: '1.0.0' };\n",
    }),
    await writeFixturePackage(src, { name: "fixture-outdated", version: "1.1.0", main: "index.js" }, {
      "index.js": "module.exports = { version: '1.1.0' };\n",
    }),
    await writeFixturePackage(
      src,
      { name: "fixture-script", version: "1.0.0", main: "index.js", scripts: { postinstall: "touch postinstall-ran.txt" } },
      { "index.js": "module.exports = 'script';\n" },
    ),
    await writeFixturePackage(src, { name: "@jslab-fixture/scoped", version: "1.0.0", main: "index.js" }, {
      "index.js": "module.exports = { scoped: 'ok' };\n",
    }),
    await writeFixturePackage(src, { name: "fixture-untyped", version: "1.0.0", main: "index.js" }, {
      "index.js": "module.exports = { untyped: 'yes' };\n",
    }),
    await writeFixturePackage(src, { name: "@types/fixture-untyped", version: "1.0.0", types: "index.d.ts" }, {
      "index.d.ts": "export declare const untyped: string;\n",
    }),
  ];
  if (options.zod) packages.push(await copyInstalledPackage("zod", resolve(import.meta.dir, "../../shared"), src));
  for (const dir of packages) await publishPackage(registryUrl, dir, workRoot);
}
```

`packages/test-registry/src/index.ts`:

```ts
export * from "./config";
export * from "./fixtures";
export * from "./free-port";
export * from "./registry";
```

- [ ] **Step 6: Run the unit tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/test-registry && bun test ./test`
Expected: PASS, 3 pass, 0 fail.

- [ ] **Step 7: Write and run the opt-in registry integration test**

`packages/test-registry/integration/registry.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmEnvironment } from "@jslab/npm";
import { defaultPackagesManifest } from "@jslab/shared";
import { isAlive, publishStandardFixtures, startTestRegistry, type TestRegistry } from "../src";

let registry: TestRegistry;
let work = "";

beforeAll(async () => {
  registry = await startTestRegistry();
  work = await mkdtemp(join(tmpdir(), "jslab-registry-work-"));
  await publishStandardFixtures(registry.url, work);
});

afterAll(async () => {
  await registry.stop();
  await rm(work, { recursive: true, force: true });
});

describe("test registry (opt-in)", () => {
  test("serves published fixtures, including a second version as latest", async () => {
    const packument = (await (await fetch(`${registry.url}fixture-outdated`)).json()) as {
      "dist-tags": { latest: string };
      versions: Record<string, unknown>;
    };
    expect(packument["dist-tags"].latest).toBe("1.1.0");
    expect(Object.keys(packument.versions).sort()).toEqual(["1.0.0", "1.1.0"]);
  });

  test("the bundled Bun installs a scoped fixture from it with an isolated HOME and a temp cache", async () => {
    const project = join(work, "project");
    const home = join(work, "npm-home");
    await mkdir(project, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify(defaultPackagesManifest()));
    await writeFile(join(project, ".npmrc"), `registry=${registry.url}\n`);
    const proc = Bun.spawn([process.execPath, "add", "--exact", "@jslab-fixture/scoped@1.0.0"], {
      cwd: project,
      env: npmEnvironment({ base: { PATH: process.env.PATH, TMPDIR: tmpdir() }, npmHome: home, bunCacheDir: join(work, "cache") }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    const manifest = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@jslab-fixture/scoped": "1.0.0" });
  });

  test("stop() ends the tracked PID", async () => {
    const extra = await startTestRegistry();
    expect(isAlive(extra.pid)).toBe(true);
    await extra.stop();
    expect(isAlive(extra.pid)).toBe(false);
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/test-registry && bun test ./integration --timeout 120000` (shell `timeout` 600000), then the same command once more under the Bun 1.4.0 shim (Global Constraints (a)).
Expected: `3 pass`, `0 fail` both times (npm integration tests: 3). Afterwards no `jslab-registry-*` folder remains under `$TMPDIR` (`ls "$TMPDIR" | grep jslab-registry` prints nothing). If Verdaccio fails only under Bun 1.4.0, stop as in Step 3.

- [ ] **Step 8: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/test-registry` 3 (from `test/` only); no other package changes. `bun run test` starts no registry (confirm: no `jslab-registry-*` folder appears under `$TMPDIR` during the run). The same counts under the Bun 1.4.0 shim.

- [ ] **Step 9: Commit**

```bash
git add packages/test-registry package.json bun.lock
git commit -m "test(registry): local test registry with tracked pid and generated fixtures" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 9: Capture real `bun add`/`remove`/`outdated` output — planned stop if formats differ

**Files:**
- Create: `packages/test-registry/scripts/capture-bun-output.ts`
- Create: `packages/test-registry/src/normalize.ts`, `packages/npm/src/ansi.ts`
- Modify: `packages/test-registry/src/index.ts` (export `normalize`), `packages/npm/src/index.ts` (export `ansi`)
- Create (generated, committed): `packages/npm/test/fixtures/bun-output/*.json`
- Test: `packages/test-registry/test/normalize.test.ts`

**Interfaces:**
- Consumes: `startTestRegistry`, `publishStandardFixtures` (Task 8), `npmEnvironment` (Task 7).
- Produces:
  - `@jslab/npm`: `stripAnsi(text: string): string` (`src/ansi.ts`; Task 10's parsers reuse it, so the pattern exists once)
  - `normalizeOutput(text: string, replacements: readonly [string, string][]): string`
  - Fixture files `add-ok.json`, `add-script-blocked.json`, `outdated.json`, `add-not-found.json`, `add-no-matching-version.json`, `add-network.json`, `remove-ok.json`, `remove-missing.json`, `pm-cache.json`. Each command fixture is `{ "name": string; "argv": string[]; "exitCode": number; "stdout": string; "stderr": string; "bunVersion": string }`. `pm-cache.json` is `{ "bunVersion": string; "cases": { "env": Record<string, string>; "printed": string }[] }`.

**Rules (binding default R-M3-PLAN-1 (f)):**
- The capture runs the bundled Bun (`process.execPath` under the Bun 1.4.0 PATH shim from Global Constraints (a)) against the test registry with `npmEnvironment`, a temp HOME and a temp cache. Nothing touches the user's cache or `~/.npmrc`.
- Every fixture is normalized before it is written: the temp root → `<TMP>`, the registry URL → `<REGISTRY>/`, durations `[123.45ms]` → `[<ms>]`, commit hashes `(34cbb9a40)` → `(<rev>)`, ANSI escapes removed.
- The script checks the assumptions the Task 10 parsers encode. If any check fails, it exits 1 and the implementer **stops** and reports the failing check with the normalized output. The controller rules (R-M3-CAP-1) on the parser change before Task 10 starts.

- [ ] **Step 1: Write the failing normalizer test**

`packages/test-registry/test/normalize.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { normalizeOutput } from "../src/normalize";

describe("normalizeOutput", () => {
  test("replaces temp paths, the registry, durations, revisions and ANSI escapes", () => {
    const raw =
      "\u001b[1mbun add v1.4.0 (34cbb9a40)\u001b[0m\ninstalled fixture-outdated@1.0.0 from http://127.0.0.1:50123/\n1 package installed [412.00ms]\nin /var/folders/xy/T/jslab-capture-1/project";
    expect(
      normalizeOutput(raw, [
        ["/var/folders/xy/T/jslab-capture-1", "<TMP>"],
        ["http://127.0.0.1:50123/", "<REGISTRY>/"],
      ]),
    ).toBe(
      "bun add v1.4.0 (<rev>)\ninstalled fixture-outdated@1.0.0 from <REGISTRY>/\n1 package installed [<ms>]\nin <TMP>/project",
    );
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/test-registry && bun test ./test/normalize.test.ts`
Expected: FAIL, `Cannot find module "../src/normalize"`.

- [ ] **Step 2: Implement the normalizer**

`packages/npm/src/ansi.ts`:

```ts
// ESC is built with fromCharCode: Biome's noControlCharactersInRegex rejects a literal escape character in a regex.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

/** Removes ANSI color and style sequences from captured tool output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}
```

Add `export * from "./ansi";` to `packages/npm/src/index.ts`.

`packages/test-registry/src/normalize.ts`:

```ts
import { stripAnsi } from "@jslab/npm";

/** Makes captured tool output safe to commit and stable across runs (privacy rule; R-M3-PLAN-1 (f)). */
export function normalizeOutput(text: string, replacements: readonly [string, string][]): string {
  let out = stripAnsi(text);
  for (const [from, to] of replacements) if (from) out = out.split(from).join(to);
  return out.replace(/\[\d+(?:\.\d+)?m?s\]/g, "[<ms>]").replace(/\(([0-9a-f]{7,40})\)/g, "(<rev>)");
}
```

Add `export * from "./normalize";` to `packages/test-registry/src/index.ts`.

Run the test again. Expected: PASS.

- [ ] **Step 3: Write the capture script**

`packages/test-registry/scripts/capture-bun-output.ts`:

```ts
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { npmEnvironment } from "@jslab/npm";
import { defaultPackagesManifest } from "@jslab/shared";
import { normalizeOutput, publishStandardFixtures, startTestRegistry } from "../src";

const OUT = resolve(import.meta.dir, "../../npm/test/fixtures/bun-output");
const created = await mkdtemp(join(tmpdir(), "jslab-capture-"));
// Bun may print either spelling of the temp root (/var/… or /private/var/…); both are normalized.
const root = await realpath(created);
const registry = await startTestRegistry();
const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

try {
  await publishStandardFixtures(registry.url, join(root, "work"));
  const replacements: [string, string][] = [
    [root, "<TMP>"],
    [created, "<TMP>"],
    [registry.url, "<REGISTRY>/"],
    [registry.url.replace(/\/$/, ""), "<REGISTRY>"],
  ];

  const project = async (name: string, registryLine: string) => {
    const dir = join(root, name);
    await mkdir(join(dir, "npm-home"), { recursive: true });
    await mkdir(join(dir, "project"), { recursive: true });
    await writeFile(join(dir, "project", "package.json"), JSON.stringify(defaultPackagesManifest(), null, 2));
    await writeFile(join(dir, "project", ".npmrc"), `${registryLine}\n`);
    return {
      cwd: join(dir, "project"),
      env: npmEnvironment({
        base: { PATH: process.env.PATH, TMPDIR: tmpdir() },
        npmHome: join(dir, "npm-home"),
        bunCacheDir: join(dir, "cache"),
      }),
    };
  };

  const run = async (name: string, argv: string[], where: { cwd: string; env: Record<string, string> }) => {
    const proc = Bun.spawn([process.execPath, ...argv], { cwd: where.cwd, env: where.env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const fixture = {
      name,
      argv,
      exitCode,
      stdout: normalizeOutput(stdout, replacements),
      stderr: normalizeOutput(stderr, replacements),
      bunVersion: Bun.version,
    };
    await writeFile(join(OUT, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    return fixture;
  };

  await mkdir(OUT, { recursive: true });
  check(Bun.version === "1.4.0", `expected the bundled Bun 1.4.0, got ${Bun.version}`);

  const main = await project("main", `registry=${registry.url}`);
  const addOk = await run("add-ok", ["add", "--exact", "fixture-outdated@1.0.0"], main);
  check(addOk.exitCode === 0 && /installed fixture-outdated@1\.0\.0/.test(addOk.stdout), "add-ok: exit 0 with 'installed fixture-outdated@1.0.0'");

  const blocked = await run("add-script-blocked", ["add", "--exact", "fixture-script@1.0.0"], main);
  check(blocked.exitCode === 0 && /blocked \d+ postinstall/i.test(blocked.stdout + blocked.stderr), "add-script-blocked: exit 0 with 'Blocked N postinstall'");

  const outdated = await run("outdated", ["outdated"], main);
  const table = outdated.stdout + outdated.stderr;
  check(
    outdated.exitCode === 0 && /Package/.test(table) && /Current/.test(table) && /Latest/.test(table) && /fixture-outdated/.test(table) && /1\.1\.0/.test(table),
    "outdated: exit 0 with a Package/Current/Latest table listing fixture-outdated 1.1.0",
  );

  const notFound = await run("add-not-found", ["add", "--exact", "jslab-fixture-missing"], main);
  check(notFound.exitCode !== 0 && /404|not found/i.test(notFound.stdout + notFound.stderr), "add-not-found: non-zero with 404 or 'not found'");

  const noVersion = await run("add-no-matching-version", ["add", "--exact", "fixture-outdated@9.9.9"], main);
  check(
    noVersion.exitCode !== 0 && /no version matching|etarget/i.test(noVersion.stdout + noVersion.stderr),
    "add-no-matching-version: non-zero with 'No version matching' or ETARGET",
  );

  const removeOk = await run("remove-ok", ["remove", "fixture-outdated"], main);
  check(removeOk.exitCode === 0, "remove-ok: exit 0");
  await run("remove-missing", ["remove", "jslab-not-installed"], main);

  const dead = await project("dead", "registry=http://127.0.0.1:9/");
  const network = await run("add-network", ["add", "--exact", "fixture-outdated@1.0.0"], dead);
  check(
    network.exitCode !== 0 && /connectionrefused|econnrefused|unable to connect/i.test(network.stdout + network.stderr),
    "add-network: non-zero with ConnectionRefused",
  );

  // Which folder Bun uses as its package cache for each environment (checks resolveBunCacheDir's order). Read-only:
  // every folder is under the temp root.
  const fake = (name: string) => join(root, "cache-order", name);
  const cases: Record<string, string>[] = [
    { BUN_INSTALL_CACHE_DIR: fake("explicit") },
    { XDG_CACHE_HOME: fake("xdg") },
    { BUN_INSTALL: fake("bun-install") },
    { XDG_CACHE_HOME: fake("xdg"), BUN_INSTALL: fake("bun-install") },
    {},
  ];
  const expected = [
    fake("explicit"),
    `${fake("xdg")}/.bun/install/cache`,
    `${fake("bun-install")}/install/cache`,
    `${fake("xdg")}/.bun/install/cache`,
    `${fake("home")}/.bun/install/cache`,
  ];
  const printed: { env: Record<string, string>; printed: string }[] = [];
  for (const [index, extra] of cases.entries()) {
    const proc = Bun.spawnSync([process.execPath, "pm", "cache"], {
      cwd: main.cwd,
      env: { PATH: process.env.PATH ?? "", HOME: fake("home"), TMPDIR: tmpdir(), NO_COLOR: "1", ...extra },
    });
    const line = proc.stdout.toString().trim();
    printed.push({ env: Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, normalizeOutput(v, replacements)])), printed: normalizeOutput(line, replacements) });
    check(line === expected[index], `pm cache case ${index}: expected ${expected[index]}, Bun printed ${line}`);
  }
  await writeFile(join(OUT, "pm-cache.json"), `${JSON.stringify({ bunVersion: Bun.version, cases: printed }, null, 2)}\n`);
} finally {
  await registry.stop();
  await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`Capture assumptions failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`Captured bun ${Bun.version} output into ${OUT}`);
```

- [ ] **Step 4: Run the capture**

Run it under the Bun 1.4.0 shim (Global Constraints (a)), so `process.execPath` is Bun 1.4.0 (shell `timeout` 600000):

```bash
( shim="$(mktemp -d "$TMPDIR/jslab-bun140-XXXXXX")" && ln -s "$HOME/.hutch/toolchains/bun/1.4.0/macos-arm64/bun" "$shim/bun" && export PATH="$shim:$HOME/.hutch/bin:$PATH" && builtin cd packages/test-registry && bun run capture; status=$?; rm -rf "$shim"; exit $status )
```

Expected: exit 0, `Captured bun 1.4.0 output into …`, and nine files under `packages/npm/test/fixtures/bun-output/`.

**If it exits 1: STOP.** Report each failed check and paste the matching normalized fixture file(s). Don't edit the Task 10 parsers or `resolveBunCacheDir` yourself. The controller records ruling **R-M3-CAP-1** with the exact parser, classification or cache-order change, then Task 10 starts from that ruling.

- [ ] **Step 5: Verify the fixtures hold no private paths**

Run: `grep -rn -e "/Users/" -e "/var/folders" -e "127.0.0.1:[0-9]" packages/npm/test/fixtures/bun-output | grep -v "127.0.0.1:9/" | head`
Expected: no output. (The dead registry `127.0.0.1:9` is allowed.)

- [ ] **Step 6: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/test-registry` 4; `@jslab/npm` stays at 10 (the normalizer test covers `stripAnsi`).

- [ ] **Step 7: Commit**

```bash
git add packages/test-registry packages/npm/src/ansi.ts packages/npm/src/index.ts packages/npm/test/fixtures
git commit -m "test(npm): capture bun add, remove and outdated output from the bundled bun" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 10: `@jslab/npm`: output parsers, error classification and search parsing

**Files:**
- Create: `packages/npm/src/output.ts`
- Modify: `packages/npm/src/index.ts`
- Test: `packages/npm/test/output.test.ts`

**Interfaces:**
- Consumes: the Task 9 fixtures under `packages/npm/test/fixtures/bun-output/`; `NpmErrorKind`, `NpmOpError`, `NpmSearchResult` (Task 5). If ruling R-M3-CAP-1 changed a check, apply that ruling's pattern here instead of the matching line below.
- Produces:
  - (uses `stripAnsi` from Task 9's `src/ansi.ts`, already exported)
  - `interface OutdatedEntry { name: string; current: string; update: string; latest: string }`, `parseOutdated(text: string): OutdatedEntry[]`
  - `parseInstalled(text: string): { name: string; version: string }[]`
  - `MAX_NPM_LOG_CHARS = 64_000`
  - `classifyNpmFailure(result: { exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }): NpmOpError | null`
  - `detectNotice(result: { stdout: string; stderr: string }): NpmErrorKind | null`
  - `parseSearchResponse(json: unknown): NpmSearchResult[]`

**Rules (spec §11.2, §11.3):**
- `bun outdated` prints a table (box-drawing `│` or ASCII `|`). The header row names the columns; rows are matched by column, a ` (dev)`/` (peer)`/` (optional)` suffix is dropped from the name, and separator rows are skipped.
- A failure is classified, checking in this order: `timeout` (the queue timed out), `disk` (ENOSPC, EACCES, EPERM, EROFS, "No space left", "permission denied"), `network` (ConnectionRefused, ECONNREFUSED, ENOTFOUND, EAI_AGAIN, ETIMEDOUT, ECONNRESET, UnableToConnect, certificate errors), `noMatchingVersion` ("No version matching", ETARGET), `notFound` (404, "not found"), `peerConflict`, `nativeBuild` (node-gyp, gyp ERR, prebuild-install, `make: ***`, binding.gyp), `scriptBlocked`, then `unknown`. An exit code of 0 without a timeout is not a failure.
- `log` is `stdout`, a newline and `stderr`, trimmed to the last 64,000 characters.
- `scriptBlocked` on a successful install ("Blocked N postinstall") is a *notice*, not a failure.
- Search results come from `objects[].package.{name, version, description}` and the optional `objects[].downloads.weekly`.

- [ ] **Step 1: Write the failing tests**

`packages/npm/test/output.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyNpmFailure,
  detectNotice,
  MAX_NPM_LOG_CHARS,
  parseInstalled,
  parseOutdated,
  parseSearchResponse,
} from "../src/output";

interface CommandFixture {
  exitCode: number;
  stdout: string;
  stderr: string;
}
const fixture = (name: string): CommandFixture =>
  JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "bun-output", `${name}.json`), "utf8"));

describe("bun output parsing (captured from the bundled Bun, Task 9)", () => {
  test("parses the captured bun outdated table", () => {
    const outdated = fixture("outdated");
    expect(parseOutdated(`${outdated.stdout}\n${outdated.stderr}`)).toContainEqual({
      name: "fixture-outdated",
      current: "1.0.0",
      update: "1.0.0",
      latest: "1.1.0",
    });
  });

  test("parses box and ASCII tables, drops dependency-kind suffixes and ignores everything else", () => {
    const box = [
      "bun outdated v1.4.0 (<rev>)",
      "┌──────────────┬─────────┬────────┬────────┐",
      "│ Package      │ Current │ Update │ Latest │",
      "├──────────────┼─────────┼────────┼────────┤",
      "│ zod (dev)    │ 4.0.0   │ 4.0.0  │ 4.6.4  │",
      "│ @a/b         │ 1.0.0   │ 1.2.0  │ 2.0.0  │",
      "└──────────────┴─────────┴────────┴────────┘",
    ].join("\n");
    expect(parseOutdated(box)).toEqual([
      { name: "zod", current: "4.0.0", update: "4.0.0", latest: "4.6.4" },
      { name: "@a/b", current: "1.0.0", update: "1.2.0", latest: "2.0.0" },
    ]);
    expect(parseOutdated("| Package | Current | Update | Latest |\n|---|---|---|---|\n| x | 1 | 1 | 2 |")).toEqual([
      { name: "x", current: "1", update: "1", latest: "2" },
    ]);
    expect(parseOutdated("bun outdated v1.4.0\n")).toEqual([]);
  });

  test("reads installed packages from bun add output", () => {
    expect(parseInstalled(fixture("add-ok").stdout)).toEqual([{ name: "fixture-outdated", version: "1.0.0" }]);
    expect(parseInstalled("installed @a/b@2.0.0 with binaries:\ninstalled x@1.0.0-beta.1\n")).toEqual([
      { name: "@a/b", version: "2.0.0" },
      { name: "x", version: "1.0.0-beta.1" },
    ]);
  });

  test("classifies the captured network failure and keeps the raw log", () => {
    const network = fixture("add-network");
    const error = classifyNpmFailure(network);
    expect(error?.kind).toBe("network");
    expect(error?.log).toContain(network.stderr.trim().split("\n").at(-1) ?? "");
  });

  test("classifies the captured not-found and no-matching-version failures", () => {
    expect(classifyNpmFailure(fixture("add-not-found"))?.kind).toBe("notFound");
    expect(classifyNpmFailure(fixture("add-no-matching-version"))?.kind).toBe("noMatchingVersion");
  });

  test("classifies peer, native build, disk, timeout and unknown failures; success is not a failure", () => {
    const fail = (stderr: string, extra: { timedOut?: boolean } = {}) =>
      classifyNpmFailure({ exitCode: 1, stdout: "", stderr, ...extra })?.kind;
    expect(fail("error: incorrect peer dependency react@17")).toBe("peerConflict");
    expect(fail("gyp ERR! build error")).toBe("nativeBuild");
    expect(fail("error: ENOSPC: no space left on device")).toBe("disk");
    expect(fail("", { timedOut: true })).toBe("timeout");
    expect(fail("something odd")).toBe("unknown");
    expect(classifyNpmFailure({ exitCode: 0, stdout: "installed x@1.0.0", stderr: "" })).toBeNull();
    const long = classifyNpmFailure({ exitCode: 1, stdout: "a".repeat(MAX_NPM_LOG_CHARS), stderr: "tail" });
    expect(long?.log.length).toBe(MAX_NPM_LOG_CHARS);
    expect(long?.log.endsWith("tail")).toBe(true);
  });

  test("a blocked postinstall on a successful install is a notice", () => {
    expect(detectNotice(fixture("add-script-blocked"))).toBe("scriptBlocked");
    expect(detectNotice(fixture("add-ok"))).toBeNull();
  });

  test("parses registry search responses and tolerates missing fields", () => {
    expect(
      parseSearchResponse({
        objects: [
          { package: { name: "zod", version: "4.6.4", description: "TypeScript-first schema validation" }, downloads: { weekly: 1234 } },
          { package: { name: "x", version: "1.0.0" } },
          { package: { version: "no name" } },
        ],
      }),
    ).toEqual([
      { name: "zod", version: "4.6.4", description: "TypeScript-first schema validation", weeklyDownloads: 1234 },
      { name: "x", version: "1.0.0", description: "", weeklyDownloads: null },
    ]);
    expect(parseSearchResponse("nope")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/npm && bun test ./test/output.test.ts`
Expected: FAIL, `Cannot find module "../src/output"`.

- [ ] **Step 3: Implement**

`packages/npm/src/output.ts`:

```ts
import type { NpmErrorKind, NpmOpError, NpmSearchResult } from "@jslab/rpc-schema";
import { stripAnsi } from "./ansi";

export interface OutdatedEntry {
  name: string;
  current: string;
  update: string;
  latest: string;
}

const cellsOf = (line: string): string[] | null => {
  const separator = line.includes("│") ? "│" : line.includes("|") ? "|" : null;
  if (!separator) return null;
  const cells = line.split(separator).map((cell) => cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells;
};

/** Parses `bun outdated` (spec §11.3). The column order comes from the header row. */
export function parseOutdated(text: string): OutdatedEntry[] {
  const entries: OutdatedEntry[] = [];
  let columns: { name: number; current: number; update: number; latest: number } | null = null;
  for (const raw of stripAnsi(text).split("\n")) {
    const cells = cellsOf(raw);
    if (!cells || cells.every((cell) => /^[-─┼═:+\s]*$/.test(cell))) continue;
    if (!columns) {
      const index = (label: string) => cells.findIndex((cell) => cell.toLowerCase() === label);
      const found = { name: index("package"), current: index("current"), update: index("update"), latest: index("latest") };
      if (found.name >= 0 && found.current >= 0 && found.latest >= 0) columns = found;
      continue;
    }
    const name = (cells[columns.name] ?? "").replace(/\s+\((?:dev|peer|optional)\)$/, "");
    if (!name) continue;
    const current = cells[columns.current] ?? "";
    const latest = cells[columns.latest] ?? "";
    entries.push({ name, current, update: columns.update >= 0 ? (cells[columns.update] ?? current) : current, latest });
  }
  return entries;
}

/** The packages a `bun add` reports as installed ("installed name@version"). */
export function parseInstalled(text: string): { name: string; version: string }[] {
  const installed: { name: string; version: string }[] = [];
  for (const match of stripAnsi(text).matchAll(/^installed ((?:@[^@\s/]+\/)?[^@\s]+)@(\S+?)(?:\s|$)/gm)) {
    installed.push({ name: match[1] as string, version: match[2] as string });
  }
  return installed;
}

export const MAX_NPM_LOG_CHARS = 64_000;

const RULES: [NpmErrorKind, RegExp][] = [
  ["disk", /ENOSPC|no space left|EACCES|EPERM|EROFS|permission denied/i],
  ["network", /ConnectionRefused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|UnableToConnect|ConnectionClosed|NetworkUnreachable|getaddrinfo|certificate/i],
  ["noMatchingVersion", /no version matching|no matching version|ETARGET/i],
  ["notFound", /\b404\b|not found|E404/i],
  ["peerConflict", /peer dep|incorrect peer|ERESOLVE|conflicting peer/i],
  ["nativeBuild", /node-gyp|gyp ERR|prebuild-install|make: \*\*\*|binding\.gyp/i],
  ["scriptBlocked", /blocked \d+ (?:pre|post)?install/i],
];

/** Spec §11.3: a failed operation's kind (for the one-line hint) and its raw log. Null for a success. */
export function classifyNpmFailure(result: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}): NpmOpError | null {
  if (result.exitCode === 0 && !result.timedOut) return null;
  const log = stripAnsi(`${result.stdout}\n${result.stderr}`).trim().slice(-MAX_NPM_LOG_CHARS);
  if (result.timedOut) return { kind: "timeout", log };
  const kind = RULES.find(([, pattern]) => pattern.test(log))?.[0] ?? "unknown";
  return { kind, log };
}

/** A non-fatal condition on a successful operation (Bun blocks untrusted install scripts). */
export function detectNotice(result: { stdout: string; stderr: string }): NpmErrorKind | null {
  return /blocked \d+ (?:pre|post)?install/i.test(stripAnsi(`${result.stdout}\n${result.stderr}`)) ? "scriptBlocked" : null;
}

/** `GET <registry>/-/v1/search` (spec §11.3). */
export function parseSearchResponse(json: unknown): NpmSearchResult[] {
  const objects = (json as { objects?: unknown })?.objects;
  if (!Array.isArray(objects)) return [];
  return objects.flatMap((object): NpmSearchResult[] => {
    const pkg = (object as { package?: Record<string, unknown> }).package;
    if (typeof pkg?.name !== "string") return [];
    const weekly = (object as { downloads?: { weekly?: unknown } }).downloads?.weekly;
    return [
      {
        name: pkg.name,
        version: typeof pkg.version === "string" ? pkg.version : "",
        description: typeof pkg.description === "string" ? pkg.description : "",
        weeklyDownloads: typeof weekly === "number" ? weekly : null,
      },
    ];
  });
}
```

Add `export * from "./output";` to `packages/npm/src/index.ts`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/npm && bun test ./test`
Expected: PASS, `@jslab/npm` 18, 0 fail.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. Counts as in the Task 10 row.

- [ ] **Step 6: Commit**

```bash
git add packages/npm
git commit -m "feat(npm): parse bun outdated and add output, classify failures and parse registry search" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 11: Operation queue and `NpmService` install/remove/update, with the injected S8 regression

**Files:**
- Create: `packages/npm/src/queue.ts`
- Modify: `packages/npm/src/index.ts`
- Create: `apps/desktop/src/main/services/npm-spawn.ts`, `apps/desktop/src/main/services/npm-service.ts`
- Modify: `apps/desktop/package.json` (`dependencies`, `scripts.test`), `bun.lock`
- Test: `packages/npm/test/queue.test.ts`, `apps/desktop/test/services/npm-service.test.ts`

**Interfaces:**
- Consumes: `npmEnvironment`, `resolveBunCacheDir`, `parseInstallSpec`, `classifyNpmFailure`, `detectNotice` (Tasks 7, 10); `NpmOperation`, `NpmOpKind`, `NpmListResult`, `InstalledPackage` (Task 5); `defaultPackagesManifest`, `PackagesManifest` (Task 4); `AppPaths` (Task 4).
- Produces:
  - `@jslab/npm`: `NPM_OPERATION_TIMEOUT_MS = 300_000`; `class OperationTimeoutError extends Error { readonly timeoutMs: number }`; `interface QueueTimers { setTimeout(callback: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }`; `class OperationQueue { constructor(options?: { timeoutMs?: number; timers?: QueueTimers }); get pending(): number; run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> }`
  - `services/npm-spawn.ts`: `interface NpmSpawnResult { exitCode: number | null; stdout: string; stderr: string }`; `interface NpmSpawnOptions { cwd: string; env: Record<string, string>; signal: AbortSignal; onOutput(text: string): void }`; `type NpmSpawn = (argv: readonly string[], options: NpmSpawnOptions) => Promise<NpmSpawnResult>`; `createBunSpawn(bunPath: string): NpmSpawn`
  - `services/npm-service.ts`: `type NpmPaths = Pick<AppPaths, "packagesDir" | "packagesJson" | "packagesNpmrc" | "npmHome" | "packagesNodeModules">`; `interface NpmServiceDeps` (below); `class NpmService { install(spec: string): NpmOperation; remove(name: string): NpmOperation; update(name: string): NpmOperation; updateAll(): NpmOperation; list(options?: { refreshOutdated: boolean }): Promise<NpmListResult>; whenIdle(): Promise<void> }`. Task 12 adds `search` and the outdated and auto-types behavior.

```ts
export interface NpmServiceDeps {
  paths: NpmPaths;
  /** The login-shell environment (Task 14). npm operations derive their isolated environment from it (M0-S8). */
  baseEnv(): Record<string, string | undefined>;
  /** The user's real home folder, read before any override (used by resolveBunCacheDir). */
  realHome: string;
  /** Tests and E2E: a temp cache instead of the user's Bun cache. Production leaves it undefined. */
  cacheDirOverride?: string;
  settings(): { allowInstallScripts: boolean; autoInstallTypes: boolean };
  spawn: NpmSpawn;
  fetch?: typeof fetch;
  queue?: OperationQueue;
  now?(): number;
  newId?(): string;
  onOperation(operation: NpmOperation): void;
  onLog(opId: string, text: string): void;
  onChanged(list: NpmListResult): void;
  /** After a successful change (spec §11.3): recycle spares, invalidate types, invalidate web vendor caches (M4). */
  afterChange(): void;
  log(message: string, detail?: unknown): void;
}
```

**Rules (spec §11.3; M0-S8 Decision):**
- Every operation spawns the bundled Bun with `cwd=<packages>` and `npmEnvironment({ base: login shell, npmHome, bunCacheDir })`, where `bunCacheDir` is `cacheDirOverride` or `resolveBunCacheDir(login shell, realHome)`.
- Operations are serialized through one queue with a 5-minute timeout each. A timeout aborts the process group and fails the operation with kind `timeout`.
- **Install:** `bun add --exact <spec>`. With install scripts allowed, a registry package's name is added to `trustedDependencies` in `package.json` before the install. For a git, tarball or path spec, the newly added dependency names are trusted after the install with `bun pm trust <names>`.
- **Remove:** `bun remove <name>`, and the name leaves `trustedDependencies`.
- **Update:** `bun add --exact <name>@latest`. **Update all:** one `bun add --exact` with every dependency `@latest`; nothing to do succeeds at once.
- Each operation emits `queued`, then `running`, then `succeeded` (with `notice`) or `failed` (with a classified `error`), and streams output through `onLog`. After a success: `afterChange()` once, then `onChanged(await list())`.

- [ ] **Step 1: Write the failing queue test**

`packages/npm/test/queue.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { OperationQueue, OperationTimeoutError } from "../src/queue";

describe("OperationQueue (spec §11.3)", () => {
  test("runs tasks one at a time in order", async () => {
    const queue = new OperationQueue();
    const events: string[] = [];
    const task = (name: string, ms: number) => async () => {
      events.push(`start ${name}`);
      await Bun.sleep(ms);
      events.push(`end ${name}`);
      return name;
    };
    const results = await Promise.all([queue.run(task("a", 30)), queue.run(task("b", 1))]);
    expect(results).toEqual(["a", "b"]);
    expect(events).toEqual(["start a", "end a", "start b", "end b"]);
    expect(queue.pending).toBe(0);
  });

  test("a task that exceeds the timeout is aborted and rejected, and the next task runs", async () => {
    const queue = new OperationQueue({ timeoutMs: 20 });
    let aborted = false;
    const slow = queue.run(
      (signal) =>
        new Promise<string>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    const next = queue.run(async () => "next");
    await expect(slow).rejects.toBeInstanceOf(OperationTimeoutError);
    expect(aborted).toBe(true);
    expect(await next).toBe("next");
  });

  test("a failing task doesn't block later tasks", async () => {
    const queue = new OperationQueue();
    const failing = queue.run(async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect(await queue.run(async () => 42)).toBe(42);
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/npm && bun test ./test/queue.test.ts`
Expected: FAIL, `Cannot find module "../src/queue"`.

- [ ] **Step 2: Implement the queue**

`packages/npm/src/queue.ts`:

```ts
/** Spec §11.3: every npm operation gets at most five minutes. */
export const NPM_OPERATION_TIMEOUT_MS = 5 * 60_000;

export class OperationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`npm operation timed out after ${timeoutMs} ms`);
  }
}

export interface QueueTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: QueueTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Serializes npm operations (spec §11.3). A timed-out task's signal is aborted, so its process can be killed. */
export class OperationQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  constructor(private readonly options: { timeoutMs?: number; timers?: QueueTimers } = {}) {}

  get pending(): number {
    return this.#pending;
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#pending++;
    const result = this.#tail.then(() => this.#runOne(task));
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result.finally(() => {
      this.#pending--;
    });
  }

  async #runOne<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const timers = this.options.timers ?? defaultTimers;
    const timeoutMs = this.options.timeoutMs ?? NPM_OPERATION_TIMEOUT_MS;
    const controller = new AbortController();
    let handle: unknown;
    const timeout = new Promise<never>((_, reject) => {
      handle = timers.setTimeout(() => {
        controller.abort();
        reject(new OperationTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([task(controller.signal), timeout]);
    } finally {
      timers.clearTimeout(handle);
    }
  }
}
```

Add `export * from "./queue";` to `packages/npm/src/index.ts`. Run the queue test again. Expected: PASS (npm 21).

- [ ] **Step 3: Add the dependency and isolate desktop's unit test folder**

In `apps/desktop/package.json`:
- add `"@jslab/npm": "workspace:*"` to `dependencies`;
- change `"test": "bun test"` to `"test": "bun test ./test"` (the opt-in `integration-npm/` folder added in Task 12 must not run in `bun run test`).

Create `apps/desktop/bunfig.toml` (the FA-m17 pattern of `packages/e2e`, Global Constraints (c)):

```toml
# A bare `bun test` here runs only the unit tests. The opt-in npm integration suite (integration-npm/) runs only
# through `bun run test:npm`, which names ./integration-npm explicitly.
[test]
root = "./test"
```

Add `apps/desktop/bunfig.toml` to this task's `git add`.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun install && builtin cd apps/desktop && bun test ./test`
Expected: exit 0 with exactly the desktop count from Task 4 (M2 final + 11): the script change alone adds or removes no test. If the number differs, stop and report both numbers.

- [ ] **Step 4: Write the failing service tests**

`apps/desktop/test/services/npm-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationQueue } from "@jslab/npm";
import type { NpmListResult, NpmOperation } from "@jslab/rpc-schema";
import { resolveAppPaths } from "../../src/main/app-paths";
import type { NpmSpawn, NpmSpawnOptions, NpmSpawnResult } from "../../src/main/services/npm-spawn";
import { NpmService, type NpmServiceDeps } from "../../src/main/services/npm-service";
import { ensurePackagesProject } from "../../src/main/services/packages-project";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-npm-service-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}

async function setup(overrides: Partial<NpmServiceDeps> & { respond?: (argv: readonly string[], options: NpmSpawnOptions) => Promise<NpmSpawnResult> } = {}) {
  const paths = resolveAppPaths({ resourcesFolder: "/R", userData: join(dir, "data"), execPath: "/bun", env: {} });
  await ensurePackagesProject(paths, () => {});
  const calls: Call[] = [];
  const ops: NpmOperation[] = [];
  const logs: string[] = [];
  const changed: NpmListResult[] = [];
  let afterChange = 0;
  const respond =
    overrides.respond ??
    (async (argv: readonly string[]) => ({ exitCode: 0, stdout: `installed ${argv.at(-1)}\n`, stderr: "" }));
  const spawn: NpmSpawn = async (argv, options) => {
    calls.push({ argv, cwd: options.cwd, env: options.env, signal: options.signal });
    options.onOutput(`running ${argv.join(" ")}\n`);
    return respond(argv, options);
  };
  let id = 0;
  const service = new NpmService({
    paths,
    baseEnv: () => ({ PATH: "/usr/bin:/bin" }),
    realHome: join(dir, "real-home"),
    settings: () => ({ allowInstallScripts: false, autoInstallTypes: false }),
    spawn,
    newId: () => `op${++id}`,
    onOperation: (op) => ops.push(op),
    onLog: (_opId, text) => logs.push(text),
    onChanged: (list) => changed.push(list),
    afterChange: () => {
      afterChange++;
    },
    log: () => {},
    ...overrides,
  });
  return { service, paths, calls, ops, logs, changed, afterChange: () => afterChange };
}

describe("NpmService (spec §11.3)", () => {
  test("npm operations never see the user's ~/.npmrc: the M0-S8 discriminating pair with an injected spawn", async () => {
    // A user home whose only .npmrc line is a dead scoped registry (M0-S8 Run 3).
    const userHome = join(dir, "user-home");
    await mkdir(userHome, { recursive: true });
    await writeFile(join(userHome, ".npmrc"), "@jslab-fixture:registry=http://127.0.0.1:9/\n");
    // Behaves like Bun 1.4.0: reads $HOME/.npmrc and honours BUN_CONFIG_*/NPM_CONFIG_* variables.
    const bunLike = async (argv: readonly string[], options: { env: Record<string, string> }): Promise<NpmSpawnResult> => {
      const rc = join(options.env.HOME ?? "", ".npmrc");
      const userRc = existsSync(rc) ? readFileSync(rc, "utf8") : "";
      const spec = String(argv.at(-1));
      const scope = spec.startsWith("@") ? spec.split("/")[0] : null;
      if (scope && userRc.includes(`${scope}:registry=http://127.0.0.1:9/`)) {
        return { exitCode: 1, stdout: "", stderr: `error: ConnectionRefused downloading package manifest ${spec}\n` };
      }
      if (Object.keys(options.env).some((key) => /^(bun_config_|npm_config_)/i.test(key))) {
        return { exitCode: 1, stdout: "", stderr: "error: ConnectionRefused (leaked config)\n" };
      }
      return { exitCode: 0, stdout: `installed ${spec}\n`, stderr: "" };
    };
    // Control: the fake discriminates when HOME is the user home.
    expect((await bunLike(["add", "--exact", "@jslab-fixture/scoped@1.0.0"], { env: { HOME: userHome } })).exitCode).toBe(1);

    const { service, paths, calls, ops } = await setup({
      baseEnv: () => ({
        PATH: "/usr/bin:/bin",
        HOME: userHome,
        BUN_CONFIG_REGISTRY: "http://127.0.0.1:9/",
        npm_config_userconfig: join(userHome, ".npmrc"),
      }),
      realHome: userHome,
      respond: (argv, options) => bunLike(argv, options),
    });
    service.install("@jslab-fixture/scoped@1.0.0");
    await service.whenIdle();
    expect(ops.at(-1)).toMatchObject({ status: "succeeded", error: null });
    expect(calls[0]?.env.HOME).toBe(paths.npmHome);
    expect(calls[0]?.env.BUN_INSTALL_CACHE_DIR).toBe(join(userHome, ".bun", "install", "cache"));
    expect(calls[0]?.cwd).toBe(paths.packagesDir);
    expect(readdirSync(paths.npmHome)).toEqual([]);
    expect(readFileSync(join(userHome, ".npmrc"), "utf8")).toBe("@jslab-fixture:registry=http://127.0.0.1:9/\n");
  });

  test("an install emits queued, running and succeeded, streams output, then recycles once and reports the new list", async () => {
    const { service, paths, calls, ops, logs, changed, afterChange } = await setup({
      respond: async () => {
        await writeFile(
          join(dir, "data", "packages", "package.json"),
          JSON.stringify({ name: "jslab-packages", private: true, dependencies: { zod: "4.6.4" }, trustedDependencies: [] }),
        );
        await mkdir(join(dir, "data", "packages", "node_modules", "zod"), { recursive: true });
        await writeFile(join(dir, "data", "packages", "node_modules", "zod", "package.json"), JSON.stringify({ version: "4.6.4" }));
        return { exitCode: 0, stdout: "installed zod@4.6.4\n", stderr: "" };
      },
    });
    const op = service.install("zod@4.6.4");
    expect(op).toEqual({ id: "op1", kind: "install", target: "zod@4.6.4", status: "queued", error: null, notice: null });
    await service.whenIdle();
    expect(ops.map((o) => o.status)).toEqual(["queued", "running", "succeeded"]);
    expect(calls.map((call) => call.argv)).toEqual([["add", "--exact", "zod@4.6.4"]]);
    expect(logs).toEqual(["running add --exact zod@4.6.4\n"]);
    expect(afterChange()).toBe(1);
    expect(changed.at(-1)?.installed).toEqual([{ name: "zod", version: "4.6.4", latest: null }]);
    expect(existsSync(paths.packagesJson)).toBe(true);

    service.remove("zod");
    service.update("zod");
    service.updateAll();
    await service.whenIdle();
    expect(calls.slice(1).map((call) => call.argv)).toEqual([
      ["remove", "zod"],
      ["add", "--exact", "zod@latest"],
      ["add", "--exact", "zod@latest"],
    ]);
  });

  test("operations run one at a time, and a classified failure doesn't recycle or report a change", async () => {
    let running = 0;
    let maxRunning = 0;
    const { service, ops, changed, afterChange } = await setup({
      respond: async (argv) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await Bun.sleep(10);
        running--;
        return argv.at(-1) === "bad@1.0.0"
          ? { exitCode: 1, stdout: "", stderr: "error: ConnectionRefused downloading package manifest bad\n" }
          : { exitCode: 0, stdout: "installed ok@1.0.0\n", stderr: "" };
      },
    });
    service.install("bad@1.0.0");
    service.install("ok@1.0.0");
    await service.whenIdle();
    expect(maxRunning).toBe(1);
    const failed = ops.find((op) => op.target === "bad@1.0.0" && op.status === "failed");
    expect(failed?.error?.kind).toBe("network");
    expect(afterChange()).toBe(1);
    expect(changed).toHaveLength(1);
  });

  test("with install scripts allowed, a registry package is trusted before install and a git spec after it", async () => {
    const manifestPath = join(dir, "data", "packages", "package.json");
    const { service, calls } = await setup({
      settings: () => ({ allowInstallScripts: true, autoInstallTypes: false }),
      respond: async (argv) => {
        if (argv[0] === "add" && String(argv.at(-1)).startsWith("git+")) {
          const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
          manifest.dependencies["from-git"] = "git+https://example.test/from-git.git";
          await writeFile(manifestPath, JSON.stringify(manifest));
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    service.install("fixture-script@1.0.0");
    await service.whenIdle();
    expect(JSON.parse(await readFile(manifestPath, "utf8")).trustedDependencies).toEqual(["fixture-script"]);
    service.install("git+https://example.test/from-git.git");
    await service.whenIdle();
    expect(calls.map((call) => call.argv)).toEqual([
      ["add", "--exact", "fixture-script@1.0.0"],
      ["add", "--exact", "git+https://example.test/from-git.git"],
      ["pm", "trust", "from-git"],
    ]);
    service.remove("fixture-script");
    await service.whenIdle();
    expect(JSON.parse(await readFile(manifestPath, "utf8")).trustedDependencies).toEqual([]);
  });

  test("an operation that exceeds the queue timeout fails as a timeout and its spawn is aborted", async () => {
    const { service, ops, calls } = await setup({
      queue: new OperationQueue({ timeoutMs: 20 }),
      respond: (_argv, options) =>
        new Promise((resolve) =>
          options.signal.addEventListener("abort", () => resolve({ exitCode: null, stdout: "", stderr: "killed" })),
        ),
    });
    service.install("slow@1.0.0");
    await service.whenIdle();
    expect(ops.at(-1)).toMatchObject({ status: "failed", error: { kind: "timeout" } });
    expect(calls[0]?.signal.aborted).toBe(true);
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/services/npm-service.test.ts`
Expected: FAIL, `Cannot find module "../../src/main/services/npm-spawn"`.

- [ ] **Step 5: Implement the spawn adapter and the service**

`apps/desktop/src/main/services/npm-spawn.ts`:

```ts
export interface NpmSpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface NpmSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
  onOutput(text: string): void;
}

/** Runs one npm operation step: argv excludes the Bun binary. */
export type NpmSpawn = (argv: readonly string[], options: NpmSpawnOptions) => Promise<NpmSpawnResult>;

const MAX_CAPTURED_CHARS = 256 * 1024;

/**
 * Spawns the bundled Bun (spec §11.3) as its own process group, so an abort (the queue's 5-minute timeout) also stops
 * install scripts. Output streams to onOutput as it arrives; the returned text keeps the last 256 KB of each stream.
 */
export function createBunSpawn(bunPath: string): NpmSpawn {
  return async (argv, options) => {
    const proc = Bun.spawn([bunPath, ...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const onAbort = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let text = "";
      for await (const chunk of stream) {
        const part = decoder.decode(chunk, { stream: true });
        options.onOutput(part);
        text = (text + part).slice(-MAX_CAPTURED_CHARS);
      }
      return text;
    };
    try {
      const [stdout, stderr, exitCode] = await Promise.all([collect(proc.stdout), collect(proc.stderr), proc.exited]);
      return { exitCode, stdout, stderr };
    } finally {
      options.signal.removeEventListener("abort", onAbort);
    }
  };
}
```

`apps/desktop/src/main/services/npm-service.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  classifyNpmFailure,
  detectNotice,
  npmEnvironment,
  OperationQueue,
  OperationTimeoutError,
  parseInstallSpec,
  resolveBunCacheDir,
} from "@jslab/npm";
import type { InstalledPackage, NpmListResult, NpmOperation, NpmOpKind } from "@jslab/rpc-schema";
import { defaultPackagesManifest, type PackagesManifest } from "@jslab/shared";
import type { AppPaths } from "../app-paths";
import { writeFileAtomic } from "../persistence/atomic-write";
import type { NpmSpawn, NpmSpawnResult } from "./npm-spawn";

export type NpmPaths = Pick<AppPaths, "packagesDir" | "packagesJson" | "packagesNpmrc" | "npmHome" | "packagesNodeModules">;

export interface NpmServiceDeps {
  paths: NpmPaths;
  /** The login-shell environment (Task 14). npm operations derive their isolated environment from it (M0-S8). */
  baseEnv(): Record<string, string | undefined>;
  /** The user's real home folder, read before any override (used by resolveBunCacheDir). */
  realHome: string;
  /** Tests and E2E: a temp cache instead of the user's Bun cache. Production leaves it undefined. */
  cacheDirOverride?: string;
  settings(): { allowInstallScripts: boolean; autoInstallTypes: boolean };
  spawn: NpmSpawn;
  fetch?: typeof fetch;
  queue?: OperationQueue;
  now?(): number;
  newId?(): string;
  onOperation(operation: NpmOperation): void;
  onLog(opId: string, text: string): void;
  onChanged(list: NpmListResult): void;
  /** After a successful change (spec §11.3): recycle spares, invalidate types, invalidate web vendor caches (M4). */
  afterChange(): void;
  log(message: string, detail?: unknown): void;
}

type RunStep = (argv: readonly string[]) => Promise<NpmSpawnResult>;
const OK: NpmSpawnResult = { exitCode: 0, stdout: "", stderr: "" };

/** The npm service (spec §11): one queue, the isolated environment, and change notifications. */
export class NpmService {
  protected readonly queue: OperationQueue;
  #idle: Promise<void> = Promise.resolve();

  constructor(protected readonly deps: NpmServiceDeps) {
    this.queue = deps.queue ?? new OperationQueue();
  }

  install(spec: string): NpmOperation {
    const parsed = parseInstallSpec(spec);
    return this.operation("install", spec, async (run) => {
      const allowScripts = this.deps.settings().allowInstallScripts;
      const before = await this.readManifest();
      if (allowScripts && parsed?.kind === "registry") await this.#setTrusted(parsed.name, true);
      const result = await run(["add", "--exact", spec]);
      if (result.exitCode !== 0 || !allowScripts || parsed?.kind === "registry") return result;
      const after = await this.readManifest();
      const added = Object.keys(after.dependencies).filter((name) => !(name in before.dependencies));
      return added.length > 0 ? run(["pm", "trust", ...added]) : result;
    });
  }

  remove(name: string): NpmOperation {
    return this.operation("remove", name, async (run) => {
      const result = await run(["remove", name]);
      if (result.exitCode === 0) await this.#setTrusted(name, false);
      return result;
    });
  }

  update(name: string): NpmOperation {
    return this.operation("update", name, (run) => run(["add", "--exact", `${name}@latest`]));
  }

  updateAll(): NpmOperation {
    return this.operation("updateAll", "", async (run) => {
      const names = Object.keys((await this.readManifest()).dependencies);
      return names.length === 0 ? OK : run(["add", "--exact", ...names.map((name) => `${name}@latest`)]);
    });
  }

  async list(_options: { refreshOutdated: boolean } = { refreshOutdated: false }): Promise<NpmListResult> {
    return { installed: await this.installedPackages(new Map()), outdatedCheckedAt: null, outdatedError: null };
  }

  /** Resolves once every queued operation, including ones queued while waiting, has finished. */
  async whenIdle(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.#idle;
      await current;
    } while (current !== this.#idle);
  }

  protected operation(
    kind: NpmOpKind,
    target: string,
    body: (run: RunStep) => Promise<NpmSpawnResult>,
    afterSuccess?: () => Promise<void>,
  ): NpmOperation {
    const op: NpmOperation = {
      id: (this.deps.newId ?? (() => crypto.randomUUID()))(),
      kind,
      target,
      status: "queued",
      error: null,
      notice: null,
    };
    this.deps.onOperation(op);
    const done = this.queue
      .run(async (signal) => {
        this.deps.onOperation({ ...op, status: "running" });
        return body((argv) => this.spawnStep(argv, signal, (text) => this.deps.onLog(op.id, text)));
      })
      .then(
        (result) => this.#finish(op, result, false, afterSuccess),
        (error: unknown) =>
          this.#finish(op, { exitCode: null, stdout: "", stderr: String(error) }, error instanceof OperationTimeoutError),
      );
    this.#idle = this.#idle.then(() => done);
    return op;
  }

  protected spawnStep(argv: readonly string[], signal: AbortSignal, onOutput: (text: string) => void): Promise<NpmSpawnResult> {
    const base = this.deps.baseEnv();
    const env = npmEnvironment({
      base,
      npmHome: this.deps.paths.npmHome,
      bunCacheDir: this.deps.cacheDirOverride ?? resolveBunCacheDir(base, this.deps.realHome),
    });
    return this.deps.spawn(argv, { cwd: this.deps.paths.packagesDir, env, signal, onOutput });
  }

  /** Called after each successful change, before the new list is reported (Task 12 resets the outdated cache here). */
  protected onSucceeded(): void {}

  async #finish(op: NpmOperation, result: NpmSpawnResult, timedOut: boolean, afterSuccess?: () => Promise<void>): Promise<void> {
    const error = classifyNpmFailure({ ...result, timedOut });
    const notice = error ? null : detectNotice(result);
    this.deps.onOperation({ ...op, status: error ? "failed" : "succeeded", error, notice });
    if (error) return;
    try {
      this.onSucceeded();
      this.deps.afterChange();
      this.deps.onChanged(await this.list({ refreshOutdated: false }));
      await afterSuccess?.();
    } catch (failure) {
      this.deps.log("npm post-change step failed", String(failure));
    }
  }

  protected async readManifest(): Promise<PackagesManifest> {
    try {
      const raw = JSON.parse(await readFile(this.deps.paths.packagesJson, "utf8")) as Partial<PackagesManifest>;
      const fallback = defaultPackagesManifest();
      return {
        ...fallback,
        ...raw,
        dependencies: typeof raw.dependencies === "object" && raw.dependencies ? raw.dependencies : {},
        trustedDependencies: Array.isArray(raw.trustedDependencies) ? raw.trustedDependencies : [],
      };
    } catch {
      return defaultPackagesManifest();
    }
  }

  protected async installedPackages(latest: ReadonlyMap<string, string>): Promise<InstalledPackage[]> {
    const manifest = await this.readManifest();
    const installed: InstalledPackage[] = [];
    for (const name of Object.keys(manifest.dependencies).sort()) {
      const version = await this.installedVersion(name);
      const newest = latest.get(name) ?? null;
      installed.push({ name, version, latest: newest && newest !== version ? newest : null });
    }
    return installed;
  }

  protected async installedVersion(name: string): Promise<string | null> {
    try {
      const pkg = JSON.parse(await readFile(join(this.deps.paths.packagesNodeModules, name, "package.json"), "utf8"));
      return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      return null;
    }
  }

  async #setTrusted(name: string, trusted: boolean): Promise<void> {
    const manifest = await this.readManifest();
    const set = new Set(manifest.trustedDependencies);
    if (trusted === set.has(name)) return;
    if (trusted) set.add(name);
    else set.delete(name);
    await writeFileAtomic(
      this.deps.paths.packagesJson,
      `${JSON.stringify({ ...manifest, trustedDependencies: [...set].sort() }, null, 2)}\n`,
    );
  }
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/services/npm-service.test.ts && builtin cd ../../packages/npm && bun test ./test`
Expected: PASS, 0 fail.

- [ ] **Step 7: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/npm` 21; `@jslab/desktop` M2 final + 16.

- [ ] **Step 8: Commit**

```bash
git add packages/npm apps/desktop/package.json apps/desktop/bunfig.toml apps/desktop/src/main/services/npm-spawn.ts apps/desktop/src/main/services/npm-service.ts apps/desktop/test/services/npm-service.test.ts bun.lock
git commit -m "feat(desktop): serialized npm operations with the m0-s8 isolated environment" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 12: `NpmService` list, outdated, search and auto `@types`; the opt-in npm integration suite

**Files:**
- Modify: `apps/desktop/src/main/services/npm-service.ts` (add outdated cache, search, auto types)
- Modify: `apps/desktop/package.json` (`devDependencies`, `scripts`), `bun.lock`
- Test: `apps/desktop/test/services/npm-service.test.ts` (append), `apps/desktop/integration-npm/npm-service.test.ts` (new, opt-in)

**Interfaces:**
- Consumes: `NpmService` internals from Task 11 (`operation`, `spawnStep`, `onSucceeded`, `readManifest`, `installedPackages`); `parseOutdated`, `classifyNpmFailure`, `parseSearchResponse`, `parseNpmrc`, `registryFor`, `authTokenFor`, `typesPackageName` from `@jslab/npm`; `startTestRegistry`, `publishStandardFixtures` from `@jslab/test-registry`; `createBunSpawn`.
- Produces:
  - `OUTDATED_TTL_MS = 600_000`, `SEARCH_TIMEOUT_MS = 8_000`
  - `NpmService.list({ refreshOutdated })` now fills `latest`, `outdatedCheckedAt` and `outdatedError` from a cache. With `refreshOutdated: true` and a cache older than 10 minutes, it starts one background `bun outdated` through the queue and reports the refreshed list with `onChanged`.
  - `NpmService.search(query: string): Promise<NpmSearchResponse>`
  - Auto `@types`: after a successful install of a registry package with no types of its own, with `npm.autoInstallTypes` on and `@types/<name>` present in the registry, the service installs `@types/<name>`.
  - `apps/desktop` scripts: `"test:npm": "bun test ./integration-npm --timeout 300000"`.

**Rules (spec §11.2–§11.4, §22.2):**
- `bun outdated` runs when the panel asks, at most every 10 minutes. A failed check is cached with its error for the same period, so a dead registry isn't hammered.
- A successful change clears the cache, and the next panel refresh re-checks.
- Search: `GET <registry>/-/v1/search?text=<q>&size=25`. The registry and `_authToken` come from `<packages>/.npmrc` (a scoped query such as `@acme/x` uses that scope's registry). 8-second timeout. A failure returns `{ results: [], error }` with kind `network` or `notFound`; the log never contains the token.
- The integration suite uses the real bundled Bun and the test registry. Every `.npmrc` points at that registry, or at the dead `127.0.0.1:9`. Every cache is a temp folder.

- [ ] **Step 1: Write the failing unit tests**

Append inside `describe("NpmService (spec §11.3)", …)` in `apps/desktop/test/services/npm-service.test.ts` (and add `writeFileSync` to the `node:fs` import):

```ts
  test("list fills latest from a cached bun outdated that refreshes in the background at most every 10 minutes", async () => {
    let now = 1_000_000;
    const table = "│ Package │ Current │ Update │ Latest │\n│ zod │ 4.0.0 │ 4.0.0 │ 4.6.4 │\n";
    const { service, paths, calls, changed } = await setup({
      now: () => now,
      respond: async (argv) => (argv[0] === "outdated" ? { exitCode: 0, stdout: table, stderr: "" } : { exitCode: 0, stdout: "", stderr: "" }),
    });
    writeFileSync(paths.packagesJson, JSON.stringify({ name: "jslab-packages", private: true, dependencies: { zod: "4.0.0" }, trustedDependencies: [] }));
    await mkdir(join(paths.packagesNodeModules, "zod"), { recursive: true });
    writeFileSync(join(paths.packagesNodeModules, "zod", "package.json"), JSON.stringify({ version: "4.0.0" }));

    expect((await service.list({ refreshOutdated: true })).installed).toEqual([{ name: "zod", version: "4.0.0", latest: null }]);
    await service.whenIdle();
    expect(changed.at(-1)).toEqual({
      installed: [{ name: "zod", version: "4.0.0", latest: "4.6.4" }],
      outdatedCheckedAt: 1_000_000,
      outdatedError: null,
    });
    now += 60_000;
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(1);
    now += 10 * 60_000;
    await service.list({ refreshOutdated: true });
    await service.whenIdle();
    expect(calls.filter((call) => call.argv[0] === "outdated")).toHaveLength(2);
  });

  test("search uses the .npmrc registry and token, parses results, and reports a network failure without the token", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.startsWith("http://127.0.0.1:9/")) throw new Error("ConnectionRefused");
      return Response.json({ objects: [{ package: { name: "zod", version: "4.6.4", description: "schemas" } }] });
    }) as typeof fetch;
    const { service, paths } = await setup({ fetch: fakeFetch });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873\n//127.0.0.1:4873/:_authToken=s3cr3t-token\n");
    expect(await service.search("zod schema")).toEqual({
      results: [{ name: "zod", version: "4.6.4", description: "schemas", weeklyDownloads: null }],
      error: null,
    });
    expect(seen[0]).toEqual({
      url: "http://127.0.0.1:4873/-/v1/search?text=zod%20schema&size=25",
      authorization: "Bearer s3cr3t-token",
    });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:9/\n");
    const failed = await service.search("zod");
    expect(failed.results).toEqual([]);
    expect(failed.error?.kind).toBe("network");
    expect(failed.error?.log).not.toContain("s3cr3t-token");
  });

  test("with automatic types on, an untyped package gets @types/<name> when the registry has it", async () => {
    const { service, paths, calls } = await setup({
      settings: () => ({ allowInstallScripts: false, autoInstallTypes: true }),
      fetch: (async (input: string | URL | Request) =>
        String(input).endsWith("/@types%2ffixture-untyped")
          ? Response.json({ name: "@types/fixture-untyped" })
          : new Response("not found", { status: 404 })) as typeof fetch,
      respond: async (argv) => {
        const spec = String(argv.at(-1));
        const name = spec.includes("@", 1) ? spec.slice(0, spec.lastIndexOf("@")) : spec;
        const manifest = JSON.parse(readFileSync(paths.packagesJson, "utf8"));
        manifest.dependencies[name] = "1.0.0";
        writeFileSync(paths.packagesJson, JSON.stringify(manifest));
        await mkdir(join(paths.packagesNodeModules, name), { recursive: true });
        writeFileSync(
          join(paths.packagesNodeModules, name, "package.json"),
          JSON.stringify(name === "fixture-typed" ? { version: "1.0.0", types: "index.d.ts" } : { version: "1.0.0" }),
        );
        return { exitCode: 0, stdout: `installed ${spec}\n`, stderr: "" };
      },
    });
    writeFileSync(paths.packagesNpmrc, "registry=http://127.0.0.1:4873/\n");
    service.install("fixture-untyped@1.0.0");
    service.install("fixture-typed@1.0.0");
    await service.whenIdle();
    expect(calls.map((call) => call.argv.at(-1))).toEqual([
      "fixture-untyped@1.0.0",
      "fixture-typed@1.0.0",
      "@types/fixture-untyped",
    ]);
  });
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/services/npm-service.test.ts`
Expected: FAIL: `latest` stays null (no outdated support), `service.search is not a function`, and no `@types` install.

- [ ] **Step 2: Implement outdated, search and auto types**

In `apps/desktop/src/main/services/npm-service.ts`:

1. Extend the `@jslab/npm` import with `authTokenFor`, `parseNpmrc`, `parseOutdated`, `parseSearchResponse`, `registryFor`, `typesPackageName`, and the `@jslab/rpc-schema` type import with `NpmOpError`, `NpmSearchResponse`.
2. Add after the imports:

```ts
/** Spec §11.3: `bun outdated` runs at most every 10 minutes. */
export const OUTDATED_TTL_MS = 10 * 60_000;
export const SEARCH_TIMEOUT_MS = 8_000;
```

3. Add these fields to `NpmService`, after `#idle`:

```ts
  #outdated: { at: number; latest: Map<string, string>; error: NpmOpError | null } | null = null;
  #refreshing = false;
```

4. Replace `install` with a version that passes the auto-types step:

```ts
  install(spec: string): NpmOperation {
    const parsed = parseInstallSpec(spec);
    return this.operation(
      "install",
      spec,
      async (run) => {
        const allowScripts = this.deps.settings().allowInstallScripts;
        const before = await this.readManifest();
        if (allowScripts && parsed?.kind === "registry") await this.#setTrusted(parsed.name, true);
        const result = await run(["add", "--exact", spec]);
        if (result.exitCode !== 0 || !allowScripts || parsed?.kind === "registry") return result;
        const after = await this.readManifest();
        const added = Object.keys(after.dependencies).filter((name) => !(name in before.dependencies));
        return added.length > 0 ? run(["pm", "trust", ...added]) : result;
      },
      parsed?.kind === "registry" ? () => this.#maybeInstallTypes(parsed.name) : undefined,
    );
  }
```

5. Replace `list` with:

```ts
  async list(options: { refreshOutdated: boolean } = { refreshOutdated: false }): Promise<NpmListResult> {
    const now = (this.deps.now ?? Date.now)();
    if (options.refreshOutdated && (!this.#outdated || now - this.#outdated.at >= OUTDATED_TTL_MS)) {
      void this.#refreshOutdated();
    }
    const cache = this.#outdated;
    return {
      installed: await this.installedPackages(cache?.latest ?? new Map()),
      outdatedCheckedAt: cache?.at ?? null,
      outdatedError: cache?.error ?? null,
    };
  }

  async search(query: string): Promise<NpmSearchResponse> {
    const { registry, token } = await this.#registry(query.startsWith("@") ? query : null);
    try {
      const response = await (this.deps.fetch ?? fetch)(
        `${registry}-/v1/search?text=${encodeURIComponent(query)}&size=25`,
        { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) },
      );
      if (!response.ok) {
        return {
          results: [],
          error: { kind: response.status === 404 ? "notFound" : "unknown", log: `GET ${registry}-/v1/search: HTTP ${response.status}` },
        };
      }
      return { results: parseSearchResponse(await response.json()), error: null };
    } catch (error) {
      return { results: [], error: { kind: "network", log: `GET ${registry}-/v1/search: ${String(error)}` } };
    }
  }
```

6. Replace `protected onSucceeded(): void {}` with:

```ts
  protected onSucceeded(): void {
    this.#outdated = null;
  }
```

7. Add these private methods at the end of the class:

```ts
  async #refreshOutdated(): Promise<void> {
    if (this.#refreshing) return;
    this.#refreshing = true;
    const run = this.queue.run((signal) => this.spawnStep(["outdated"], signal, () => {}));
    const done = run
      .then(
        (result) => {
          const error = classifyNpmFailure(result);
          const latest = new Map(parseOutdated(`${result.stdout}\n${result.stderr}`).map((entry) => [entry.name, entry.latest]));
          this.#outdated = { at: (this.deps.now ?? Date.now)(), latest: error ? new Map() : latest, error };
        },
        (error: unknown) => {
          this.#outdated = {
            at: (this.deps.now ?? Date.now)(),
            latest: new Map(),
            error: { kind: "timeout", log: String(error) },
          };
        },
      )
      .then(async () => {
        this.#refreshing = false;
        this.deps.onChanged(await this.list({ refreshOutdated: false }));
      });
    this.#track(done);
  }

  async #registry(packageName: string | null): Promise<{ registry: string; token: string | null }> {
    const base = this.deps.baseEnv();
    const config = parseNpmrc(await readFile(this.deps.paths.packagesNpmrc, "utf8").catch(() => ""));
    const registry = registryFor(config, packageName, base);
    return { registry, token: authTokenFor(config, registry, base) };
  }

  async #maybeInstallTypes(name: string): Promise<void> {
    if (!this.deps.settings().autoInstallTypes) return;
    const typesName = typesPackageName(name);
    if (!typesName || (await this.#hasOwnTypes(name))) return;
    if (typesName in (await this.readManifest()).dependencies) return;
    const { registry, token } = await this.#registry(typesName);
    try {
      const response = await (this.deps.fetch ?? fetch)(`${registry}${typesName.replace("/", "%2f")}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });
      if (response.ok) this.install(typesName);
    } catch (error) {
      this.deps.log("Couldn't check the registry for types", String(error));
    }
  }

  async #hasOwnTypes(name: string): Promise<boolean> {
    try {
      const text = await readFile(join(this.deps.paths.packagesNodeModules, name, "package.json"), "utf8");
      const pkg = JSON.parse(text) as { types?: unknown; typings?: unknown };
      if (typeof pkg.types === "string" || typeof pkg.typings === "string" || text.includes('"types"')) return true;
    } catch {
      return false;
    }
    return Bun.file(join(this.deps.paths.packagesNodeModules, name, "index.d.ts")).exists();
  }
```

8. `#refreshOutdated` tracks its promise so `whenIdle` waits for it. Change the one line in `operation` that reads `this.#idle = this.#idle.then(() => done);` to `this.#track(done);`, and add:

```ts
  #track(done: Promise<void>): void {
    this.#idle = this.#idle.then(() => done);
  }
```

Run the unit tests again. Expected: PASS (desktop M2 final + 19).

- [ ] **Step 3: Add the opt-in integration suite**

In `apps/desktop/package.json`, add `"@jslab/test-registry": "workspace:*"` to a `devDependencies` block (create the block), and add the script `"test:npm": "bun test ./integration-npm --timeout 300000"`. In the root `package.json`, extend Task 8's script to `"test:npm": "bun run --cwd packages/test-registry test:npm && bun run --cwd apps/desktop test:npm"`.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun install`
Expected: exit 0; `bun.lock` gains only the workspace link.

`apps/desktop/integration-npm/npm-service.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npmEnvironment } from "@jslab/npm";
import type { NpmOperation } from "@jslab/rpc-schema";
import { publishStandardFixtures, startTestRegistry, type TestRegistry } from "@jslab/test-registry";
import { resolveAppPaths } from "../src/main/app-paths";
import { createBunSpawn } from "../src/main/services/npm-spawn";
import { NpmService } from "../src/main/services/npm-service";
import { ensurePackagesProject } from "../src/main/services/packages-project";

let registry: TestRegistry;
let root = "";

beforeAll(async () => {
  registry = await startTestRegistry();
  root = await mkdtemp(join(tmpdir(), "jslab-npm-it-"));
  await publishStandardFixtures(registry.url, join(root, "fixtures"));
});

afterAll(async () => {
  await registry.stop();
  await rm(root, { recursive: true, force: true });
});

async function service(name: string, options: { npmrc?: string; allowScripts?: boolean; baseHome?: string } = {}) {
  const paths = resolveAppPaths({ resourcesFolder: "/R", userData: join(root, name), execPath: process.execPath, env: {} });
  await ensurePackagesProject(paths, () => {});
  await writeFile(paths.packagesNpmrc, options.npmrc ?? `registry=${registry.url}\n`);
  const ops: NpmOperation[] = [];
  const npm = new NpmService({
    paths,
    baseEnv: () => ({ PATH: process.env.PATH, TMPDIR: tmpdir(), ...(options.baseHome ? { HOME: options.baseHome } : {}) }),
    realHome: join(root, name, "real-home"),
    cacheDirOverride: join(root, name, "cache"),
    settings: () => ({ allowInstallScripts: options.allowScripts ?? false, autoInstallTypes: false }),
    spawn: createBunSpawn(process.execPath),
    onOperation: (op) => ops.push(op),
    onLog: () => {},
    onChanged: () => {},
    afterChange: () => {},
    log: () => {},
  });
  return { npm, paths, ops, last: () => ops.at(-1) };
}

describe("npm service against the test registry (opt-in, spec §22.2)", () => {
  test("M0-S8 discriminating pair: a dead scoped registry in the user's ~/.npmrc breaks a plain install but not JSLab's", async () => {
    const userHome = join(root, "user-home");
    await mkdir(userHome, { recursive: true });
    await writeFile(join(userHome, ".npmrc"), "@jslab-fixture:registry=http://127.0.0.1:9/\n");

    // Control: the bundled Bun with HOME at that user home fails the scoped install.
    const control = join(root, "control");
    await mkdir(control, { recursive: true });
    await writeFile(join(control, "package.json"), JSON.stringify({ name: "control", private: true }));
    await writeFile(join(control, ".npmrc"), `registry=${registry.url}\n`);
    const proc = Bun.spawn([process.execPath, "add", "--exact", "@jslab-fixture/scoped@1.0.0"], {
      cwd: control,
      env: npmEnvironment({ base: { PATH: process.env.PATH, TMPDIR: tmpdir() }, npmHome: userHome, bunCacheDir: join(root, "control-cache") }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [controlErr, controlCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(controlCode).not.toBe(0);
    expect(controlErr).toMatch(/ConnectionRefused|ECONNREFUSED/i);

    // JSLab: the same login-shell HOME, but the service overrides HOME with its empty npm-home.
    const { npm, paths, last } = await service("isolated", { baseHome: userHome });
    npm.install("@jslab-fixture/scoped@1.0.0");
    await npm.whenIdle();
    expect(last()).toMatchObject({ status: "succeeded", error: null });
    expect(readdirSync(paths.npmHome)).toEqual([]);
    expect(readFileSync(join(userHome, ".npmrc"), "utf8")).toBe("@jslab-fixture:registry=http://127.0.0.1:9/\n");
  });

  test("install, list with outdated, update and remove", async () => {
    const { npm, last } = await service("lifecycle");
    npm.install("fixture-outdated@1.0.0");
    await npm.whenIdle();
    expect(last()?.status).toBe("succeeded");
    await npm.list({ refreshOutdated: true });
    await npm.whenIdle();
    expect((await npm.list({ refreshOutdated: false })).installed).toEqual([
      { name: "fixture-outdated", version: "1.0.0", latest: "1.1.0" },
    ]);
    npm.update("fixture-outdated");
    await npm.whenIdle();
    expect((await npm.list({ refreshOutdated: false })).installed[0]?.version).toBe("1.1.0");
    npm.remove("fixture-outdated");
    await npm.whenIdle();
    expect((await npm.list({ refreshOutdated: false })).installed).toEqual([]);
  });

  test("install scripts are blocked by default and run once allowed (trustedDependencies)", async () => {
    const off = await service("scripts-off");
    off.npm.install("fixture-script@1.0.0");
    await off.npm.whenIdle();
    expect(off.last()).toMatchObject({ status: "succeeded", notice: "scriptBlocked" });
    expect(existsSync(join(off.paths.packagesNodeModules, "fixture-script", "postinstall-ran.txt"))).toBe(false);

    const on = await service("scripts-on", { allowScripts: true });
    on.npm.install("fixture-script@1.0.0");
    await on.npm.whenIdle();
    expect(on.last()).toMatchObject({ status: "succeeded", notice: null });
    expect(JSON.parse(readFileSync(on.paths.packagesJson, "utf8")).trustedDependencies).toEqual(["fixture-script"]);
    expect(existsSync(join(on.paths.packagesNodeModules, "fixture-script", "postinstall-ran.txt"))).toBe(true);
  });

  test("not-found, no-matching-version and network failures are classified", async () => {
    const { npm, ops } = await service("errors");
    npm.install("jslab-fixture-missing");
    npm.install("fixture-outdated@9.9.9");
    await npm.whenIdle();
    const dead = await service("dead", { npmrc: "registry=http://127.0.0.1:9/\n" });
    dead.npm.install("fixture-outdated@1.0.0");
    await dead.npm.whenIdle();
    expect(ops.filter((op) => op.status === "failed").map((op) => op.error?.kind)).toEqual(["notFound", "noMatchingVersion"]);
    expect(dead.last()?.error?.kind).toBe("network");
  });

  test("search finds published fixtures", async () => {
    const { npm } = await service("search");
    const response = await npm.search("fixture-outdated");
    expect(response.error).toBeNull();
    expect(response.results.map((result) => result.name)).toContain("fixture-outdated");
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun run test:npm` (shell `timeout` 600000; log-and-poll if needed)
Expected: `5 pass`, `0 fail`. No `jslab-registry-*` or `jslab-npm-it-*` folder remains under `$TMPDIR`.

If the scripts test fails because the fixture's `touch` script doesn't run under Bun's lifecycle-script shell, stop and report the install log; the controller rules on the fixture script (R-M3-IT-1).

- [ ] **Step 4: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/desktop` M2 final + 19; `bun run test` doesn't run `integration-npm` (desktop count unchanged by the new folder).

Then run the whole opt-in suite once: `export PATH="$HOME/.hutch/bin:$PATH" && bun run test:npm` → npm integration tests 8 pass (3 registry + 5 service), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add package.json apps/desktop/package.json apps/desktop/src/main/services/npm-service.ts apps/desktop/test/services/npm-service.test.ts apps/desktop/integration-npm bun.lock
git commit -m "feat(desktop): outdated cache, registry search, automatic types and the npm integration suite" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 13: Type closure collector and `TypesService`

**Files:**
- Create: `packages/npm/src/type-closure.ts`
- Modify: `packages/npm/src/index.ts`
- Create: `apps/desktop/src/main/services/types-service.ts`
- Test: `packages/npm/test/type-closure.test.ts`, `apps/desktop/test/services/types-service.test.ts`

**Interfaces:**
- Consumes: `packageNameFromSpecifier`, `typesPackageName` (Task 7); `PackageTypesResult`, `LocalTypesResult`, `TypeFile` (Task 5).
- Produces:
  - `@jslab/npm`: `interface TypesFs { readText(path: string): Promise<string | null>; isFile(path: string): Promise<boolean> }`; `MAX_PACKAGE_TYPES_BYTES = 5_242_880`; `MAX_LOCAL_TYPE_FILES = 200`; `collectPackageTypes(fs: TypesFs, input: { name: string; nodeModulesDirs: readonly string[]; maxBytes?: number }): Promise<PackageTypesResult>`; `collectLocalTypes(fs: TypesFs, input: { workingDirectory: string; specifiers: readonly string[]; maxFiles?: number; maxBytes?: number }): Promise<LocalTypesResult>`
  - `services/types-service.ts`: `nodeTypesFs: TypesFs`; `interface TypesServiceDeps { nodeModulesDirsFor(tabId: string): string[]; workingDirectoryFor(tabId: string): string | null; fs?: TypesFs }`; `class TypesService { packages(tabId: string, names: readonly string[]): Promise<PackageTypesResult[]>; local(tabId: string, specifiers: readonly string[]): Promise<LocalTypesResult>; invalidate(): void }`

**Rules (spec §6.2):**
- **Package lookup order** is the runtime's `NODE_PATH` order: `<WD>/node_modules`, then `<packages>/node_modules`.
- **Entry points** come from `types`/`typings`, then every `types` condition in `exports` (nested condition objects included), then `main` with `.js`/`.mjs`/`.cjs` mapped to `.d.ts`/`.d.mts`/`.d.cts`, then `index.d.ts`. Only files that exist count.
- **No types of its own:** use `@types/<name>` if it is installed (`typesPackage` names it, `hasTypes: true`). Otherwise return no files, `hasTypes: false` and `typesPackage: "@types/<name>"`. A package that isn't installed returns no files, `hasTypes: false` and `typesPackage: null`.
- **The closure** follows `/// <reference path>`, and relative `import`/`export … from`, `import()` and `require()` specifiers, resolving `.js`→`.d.ts`, `.mjs`→`.d.mts`, `.cjs`→`.d.cts`, `X.d.ts`, `X/index.d.ts`. Bare specifiers and `/// <reference types>` become `dependencies` (the package itself excluded). The `package.json` is included. At most 5 MB per package; past the cap, `truncated: true`.
- **Paths** are `file:///node_modules/<package>/<path inside the package>`.
- **Local types:**
  - Relative specifiers resolve inside the WD with `.ts`, `.tsx`, `.d.ts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, `/index.ts` or `/index.js`.
  - The closure follows the files' own relative imports and never leaves the WD.
  - At most 200 files (`truncated: true` past that).
  - Paths are `file:///tab/<path relative to the WD>`.
  - Bare imports become `packages`.
- **Caching:** `TypesService` caches package results by (lookup folders, name) until `invalidate()`. Local results are never cached, because WD files change.

- [ ] **Step 1: Write the failing tests**

`packages/npm/test/type-closure.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { collectLocalTypes, collectPackageTypes, type TypesFs } from "../src/type-closure";

function memoryFs(files: Record<string, string>): TypesFs {
  return {
    readText: async (path) => files[path] ?? null,
    isFile: async (path) => path in files,
  };
}

describe("package type closure (spec §6.2)", () => {
  test("follows types, relative imports and reference paths, lists bare dependencies and includes package.json", async () => {
    const fs = memoryFs({
      "/wd/node_modules/lib/package.json": JSON.stringify({ name: "lib", types: "dist/index.d.ts" }),
      "/wd/node_modules/lib/dist/index.d.ts":
        '/// <reference path="./globals.d.ts" />\nexport * from "./parts/a.js";\nimport type { X } from "other-lib";\nexport type { X };\n',
      "/wd/node_modules/lib/dist/globals.d.ts": "declare const LIB_VERSION: string;\n",
      "/wd/node_modules/lib/dist/parts/a.d.ts": 'export declare function a(): import("./b").B;\n',
      "/wd/node_modules/lib/dist/parts/b.d.ts": "export interface B { ok: true }\n",
      "/app/node_modules/lib/package.json": JSON.stringify({ name: "lib", types: "shadowed.d.ts" }),
    });
    const result = await collectPackageTypes(fs, { name: "lib", nodeModulesDirs: ["/wd/node_modules", "/app/node_modules"] });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "file:///node_modules/lib/dist/globals.d.ts",
      "file:///node_modules/lib/dist/index.d.ts",
      "file:///node_modules/lib/dist/parts/a.d.ts",
      "file:///node_modules/lib/dist/parts/b.d.ts",
      "file:///node_modules/lib/package.json",
    ]);
    expect(result).toMatchObject({ name: "lib", dependencies: ["other-lib"], typesPackage: null, hasTypes: true, truncated: false });
  });

  test("reads types conditions in exports and maps .cjs to .d.cts", async () => {
    const fs = memoryFs({
      "/n/zodish/package.json": JSON.stringify({
        name: "zodish",
        exports: { ".": { types: "./index.d.cts", import: "./index.js" }, "./v4": { import: { types: "./v4/index.d.ts" } } },
      }),
      "/n/zodish/index.d.cts": 'export * from "./classic/external.cjs";\n',
      "/n/zodish/classic/external.d.cts": "export declare const z: { string(): unknown };\n",
      "/n/zodish/v4/index.d.ts": "export {};\n",
    });
    const result = await collectPackageTypes(fs, { name: "zodish", nodeModulesDirs: ["/n"] });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "file:///node_modules/zodish/classic/external.d.cts",
      "file:///node_modules/zodish/index.d.cts",
      "file:///node_modules/zodish/package.json",
      "file:///node_modules/zodish/v4/index.d.ts",
    ]);
  });

  test("falls back to an installed @types package, offers one that isn't installed, and returns nothing for a missing package", async () => {
    const withTypes = memoryFs({
      "/n/untyped/package.json": JSON.stringify({ name: "untyped", main: "index.js" }),
      "/n/@types/untyped/package.json": JSON.stringify({ name: "@types/untyped", types: "index.d.ts" }),
      "/n/@types/untyped/index.d.ts": "export declare const untyped: string;\n",
    });
    const typed = await collectPackageTypes(withTypes, { name: "untyped", nodeModulesDirs: ["/n"] });
    expect(typed).toMatchObject({ hasTypes: true, typesPackage: "@types/untyped" });
    expect(typed.files.map((file) => file.path)).toContain("file:///node_modules/@types/untyped/index.d.ts");

    const without = memoryFs({ "/n/untyped/package.json": JSON.stringify({ name: "untyped", main: "index.js" }) });
    expect(await collectPackageTypes(without, { name: "untyped", nodeModulesDirs: ["/n"] })).toEqual({
      name: "untyped",
      files: [],
      dependencies: [],
      typesPackage: "@types/untyped",
      hasTypes: false,
      truncated: false,
    });
    expect((await collectPackageTypes(without, { name: "missing", nodeModulesDirs: ["/n"] })).typesPackage).toBeNull();
  });

  test("stops at the byte cap and says so", async () => {
    const fs = memoryFs({
      "/n/big/package.json": JSON.stringify({ name: "big", types: "a.d.ts" }),
      "/n/big/a.d.ts": `export * from "./b";\n${"x".repeat(600)}`,
      "/n/big/b.d.ts": "y".repeat(600),
    });
    const result = await collectPackageTypes(fs, { name: "big", nodeModulesDirs: ["/n"], maxBytes: 1000 });
    expect(result.truncated).toBe(true);
    expect(result.files.map((file) => file.path)).not.toContain("file:///node_modules/big/b.d.ts");
  });
});

describe("working-directory local types (spec §6.2)", () => {
  test("resolves relative imports inside the WD, follows them, never leaves the WD and lists bare packages", async () => {
    const fs = memoryFs({
      "/wd/util.ts": 'import { z } from "zod";\nexport { helper } from "./lib/helper.js";\nexport const User = z.object({});\n',
      "/wd/lib/helper.ts": 'import "../../outside/secret";\nexport const helper = 1;\n',
      "/outside/secret.ts": "export const secret = 1;\n",
      "/wd/types.d.ts": "export interface Shape { id: number }\n",
    });
    const result = await collectLocalTypes(fs, { workingDirectory: "/wd", specifiers: ["./util", "./types", "../outside/secret"] });
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "file:///tab/lib/helper.ts",
      "file:///tab/types.d.ts",
      "file:///tab/util.ts",
    ]);
    expect(result.packages).toEqual(["zod"]);
    expect(result.truncated).toBe(false);
  });
});
```

`apps/desktop/test/services/types-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TypesService } from "../../src/main/services/types-service";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-types-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writePackage(root: string, content: string) {
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(join(root, "lib", "package.json"), JSON.stringify({ name: "lib", types: "index.d.ts" }));
  await writeFile(join(root, "lib", "index.d.ts"), content);
}

describe("TypesService", () => {
  test("serves package types from the tab's lookup folders and caches them until invalidated", async () => {
    const modules = join(dir, "packages", "node_modules");
    await writePackage(modules, "export declare const v: 1;\n");
    const service = new TypesService({ nodeModulesDirsFor: () => [modules], workingDirectoryFor: () => null });
    const first = await service.packages("t1", ["lib"]);
    expect(first[0]?.files.find((file) => file.path.endsWith("index.d.ts"))?.content).toContain("v: 1");
    await writePackage(modules, "export declare const v: 2;\n");
    expect((await service.packages("t1", ["lib"]))[0]?.files.find((file) => file.path.endsWith("index.d.ts"))?.content).toContain("v: 1");
    service.invalidate();
    expect((await service.packages("t1", ["lib"]))[0]?.files.find((file) => file.path.endsWith("index.d.ts"))?.content).toContain("v: 2");
  });

  test("local types need a working directory and are read fresh each time", async () => {
    const wd = join(dir, "wd");
    await mkdir(wd, { recursive: true });
    await writeFile(join(wd, "util.ts"), "export const a = 1;\n");
    let workingDirectory: string | null = null;
    const service = new TypesService({ nodeModulesDirsFor: () => [], workingDirectoryFor: () => workingDirectory });
    expect(await service.local("t1", ["./util"])).toEqual({ files: [], packages: [], truncated: false });
    workingDirectory = wd;
    expect((await service.local("t1", ["./util"])).files).toEqual([{ path: "file:///tab/util.ts", content: "export const a = 1;\n" }]);
    await writeFile(join(wd, "util.ts"), "export const a = 2;\n");
    expect((await service.local("t1", ["./util"])).files[0]?.content).toBe("export const a = 2;\n");
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/npm && bun test ./test/type-closure.test.ts`
Expected: FAIL, `Cannot find module "../src/type-closure"`.

- [ ] **Step 2: Implement the collector**

`packages/npm/src/type-closure.ts`:

```ts
import { dirname, join, normalize, relative } from "node:path/posix";
import type { LocalTypesResult, PackageTypesResult, TypeFile } from "@jslab/rpc-schema";
import { packageNameFromSpecifier, typesPackageName } from "./specifiers";

export interface TypesFs {
  readText(path: string): Promise<string | null>;
  isFile(path: string): Promise<boolean>;
}

export const MAX_PACKAGE_TYPES_BYTES = 5 * 1024 * 1024;
export const MAX_LOCAL_TYPE_FILES = 200;

const SPECIFIERS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /^\s*import\s*["']([^"']+)["']/gm,
  /\bexport\s*\*\s*from\s*["']([^"']+)["']/g,
];
const REFERENCE_PATH = /\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/g;
const REFERENCE_TYPES = /\/\/\/\s*<reference\s+types\s*=\s*["']([^"']+)["']/g;

function specifiersIn(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIERS) for (const match of text.matchAll(pattern)) found.add(match[1] as string);
  return [...found];
}

async function firstFile(fs: TypesFs, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) if (await fs.isFile(candidate)) return candidate;
  return null;
}

function declarationCandidates(base: string): string[] {
  if (/\.d\.[mc]?ts$/.test(base)) return [base];
  const js = /\.(m|c)?jsx?$/.exec(base);
  if (js) {
    const stem = base.slice(0, -js[0].length);
    const flavor = js[1] ?? "";
    return [`${stem}.d.${flavor}ts`, `${stem}.d.ts`];
  }
  return [`${base}.d.ts`, `${base}/index.d.ts`, `${base}.d.mts`, `${base}.d.cts`];
}

function typesConditions(value: unknown, out: string[]): void {
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "types" && typeof entry === "string") out.push(entry);
    else typesConditions(entry, out);
  }
}

async function readManifest(fs: TypesFs, dir: string): Promise<Record<string, unknown> | null> {
  const text = await fs.readText(join(dir, "package.json"));
  if (text === null) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function entryFiles(fs: TypesFs, dir: string, manifest: Record<string, unknown>): Promise<string[]> {
  const declared: string[] = [];
  for (const key of ["types", "typings"]) if (typeof manifest[key] === "string") declared.push(manifest[key] as string);
  typesConditions(manifest.exports, declared);
  if (declared.length === 0 && typeof manifest.main === "string") declared.push(manifest.main);
  if (declared.length === 0) declared.push("index.d.ts");
  const files: string[] = [];
  for (const entry of declared) {
    const found = await firstFile(fs, declarationCandidates(normalize(join(dir, entry))));
    if (found && !files.includes(found)) files.push(found);
  }
  return files;
}

async function closure(
  fs: TypesFs,
  input: {
    roots: string[];
    within: string;
    toPath: (file: string) => string;
    maxBytes: number;
    maxFiles: number;
    resolve: (from: string, specifier: string) => string[];
    ownName: string | null;
  },
): Promise<{ files: TypeFile[]; bare: string[]; truncated: boolean }> {
  const files: TypeFile[] = [];
  const bare = new Set<string>();
  const seen = new Set<string>();
  const queue = [...input.roots];
  let bytes = 0;
  let truncated = false;
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!file.startsWith(`${input.within}/`)) continue;
    const content = await fs.readText(file);
    if (content === null) continue;
    if (bytes + content.length > input.maxBytes || files.length >= input.maxFiles) {
      truncated = true;
      break;
    }
    bytes += content.length;
    files.push({ path: input.toPath(file), content });
    for (const match of content.matchAll(REFERENCE_PATH)) {
      const found = await firstFile(fs, declarationCandidates(normalize(join(dirname(file), match[1] as string))));
      if (found) queue.push(found);
    }
    for (const match of content.matchAll(REFERENCE_TYPES)) bare.add(match[1] as string);
    for (const specifier of specifiersIn(content)) {
      if (specifier.startsWith(".")) {
        const found = await firstFile(fs, input.resolve(file, specifier));
        if (found) queue.push(found);
        continue;
      }
      const name = packageNameFromSpecifier(specifier);
      if (name && name !== input.ownName) bare.add(name);
    }
  }
  return { files, bare: [...bare].sort(), truncated };
}

/** The `.d.ts` closure of one installed package (spec §6.2), registered at `file:///node_modules/<name>/…`. */
export async function collectPackageTypes(
  fs: TypesFs,
  input: { name: string; nodeModulesDirs: readonly string[]; maxBytes?: number },
): Promise<PackageTypesResult> {
  const maxBytes = input.maxBytes ?? MAX_PACKAGE_TYPES_BYTES;
  const empty = (typesPackage: string | null): PackageTypesResult => ({
    name: input.name,
    files: [],
    dependencies: [],
    typesPackage,
    hasTypes: false,
    truncated: false,
  });

  const locate = async (name: string) => {
    for (const modules of input.nodeModulesDirs) {
      const dir = join(modules, name);
      const manifest = await readManifest(fs, dir);
      if (manifest) return { dir, manifest, modules };
    }
    return null;
  };

  const collect = async (name: string, found: { dir: string; manifest: Record<string, unknown> }) => {
    const roots = await entryFiles(fs, found.dir, found.manifest);
    if (roots.length === 0) return null;
    const packageJson = join(found.dir, "package.json");
    const result = await closure(fs, {
      roots: [packageJson, ...roots],
      within: found.dir,
      toPath: (file) => `file:///node_modules/${name}/${relative(found.dir, file)}`,
      maxBytes,
      maxFiles: Number.POSITIVE_INFINITY,
      resolve: (from, specifier) => declarationCandidates(normalize(join(dirname(from), specifier))),
      ownName: name,
    });
    return result;
  };

  const own = await locate(input.name);
  if (!own) return empty(null);
  const ownTypes = await collect(input.name, own);
  if (ownTypes) {
    return { name: input.name, files: ownTypes.files, dependencies: ownTypes.bare, typesPackage: null, hasTypes: true, truncated: ownTypes.truncated };
  }
  const typesName = typesPackageName(input.name);
  if (!typesName) return empty(null);
  const typesPkg = await locate(typesName);
  const typed = typesPkg ? await collect(typesName, typesPkg) : null;
  if (!typed) return empty(typesName);
  return { name: input.name, files: typed.files, dependencies: typed.bare, typesPackage: typesName, hasTypes: true, truncated: typed.truncated };
}

const LOCAL_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.js"];

function localCandidates(base: string): string[] {
  if (/\.(?:[mc]?[jt]sx?|d\.ts)$/.test(base)) {
    const stem = base.replace(/\.[mc]?jsx?$/, "");
    return stem === base ? [base] : [`${stem}.ts`, `${stem}.tsx`, `${stem}.d.ts`, base];
  }
  return LOCAL_EXTENSIONS.map((extension) => `${base}${extension}`);
}

/** WD-local `.ts`/`.d.ts`/`.js` modules imported relatively (spec §6.2), registered at `file:///tab/<relative path>`. */
export async function collectLocalTypes(
  fs: TypesFs,
  input: { workingDirectory: string; specifiers: readonly string[]; maxFiles?: number; maxBytes?: number },
): Promise<LocalTypesResult> {
  const wd = normalize(input.workingDirectory).replace(/\/$/, "");
  const roots: string[] = [];
  for (const specifier of input.specifiers) {
    const found = await firstFile(fs, localCandidates(normalize(join(wd, specifier))));
    if (found) roots.push(found);
  }
  const result = await closure(fs, {
    roots,
    within: wd,
    toPath: (file) => `file:///tab/${relative(wd, file)}`,
    maxBytes: input.maxBytes ?? MAX_PACKAGE_TYPES_BYTES,
    maxFiles: input.maxFiles ?? MAX_LOCAL_TYPE_FILES,
    resolve: (from, specifier) => localCandidates(normalize(join(dirname(from), specifier))),
    ownName: null,
  });
  return { files: result.files, packages: result.bare, truncated: result.truncated };
}
```

Add `export * from "./type-closure";` to `packages/npm/src/index.ts`.

- [ ] **Step 3: Implement the service**

`apps/desktop/src/main/services/types-service.ts`:

```ts
import { readFile, stat } from "node:fs/promises";
import { collectLocalTypes, collectPackageTypes, type TypesFs } from "@jslab/npm";
import type { LocalTypesResult, PackageTypesResult } from "@jslab/rpc-schema";

/** Reads only regular files; a file over 5 MB is skipped (its package reports truncated). */
export const nodeTypesFs: TypesFs = {
  async readText(path) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 5 * 1024 * 1024) return null;
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  async isFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
};

export interface TypesServiceDeps {
  /** `[<WD>/node_modules, <packages>/node_modules]`, or just the packages folder without a WD (spec §5.3 order). */
  nodeModulesDirsFor(tabId: string): string[];
  workingDirectoryFor(tabId: string): string | null;
  fs?: TypesFs;
}

/** Main's `npm/types` service (spec §6.2). */
export class TypesService {
  readonly #cache = new Map<string, Promise<PackageTypesResult>>();

  constructor(private readonly deps: TypesServiceDeps) {}

  packages(tabId: string, names: readonly string[]): Promise<PackageTypesResult[]> {
    const dirs = this.deps.nodeModulesDirsFor(tabId);
    return Promise.all(
      names.map((name) => {
        const key = `${dirs.join("\n")}\n${name}`;
        let entry = this.#cache.get(key);
        if (!entry) {
          entry = collectPackageTypes(this.deps.fs ?? nodeTypesFs, { name, nodeModulesDirs: dirs });
          this.#cache.set(key, entry);
          entry.catch(() => this.#cache.delete(key));
        }
        return entry;
      }),
    );
  }

  async local(tabId: string, specifiers: readonly string[]): Promise<LocalTypesResult> {
    const workingDirectory = this.deps.workingDirectoryFor(tabId);
    if (!workingDirectory) return { files: [], packages: [], truncated: false };
    return collectLocalTypes(this.deps.fs ?? nodeTypesFs, { workingDirectory, specifiers });
  }

  /** After any package change or WD change (spec §6.2, §11.3). */
  invalidate(): void {
    this.#cache.clear();
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/npm && bun test ./test && builtin cd ../../apps/desktop && bun test test/services/types-service.test.ts`
Expected: PASS, 0 fail. `@jslab/npm` 26.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/npm` 26; `@jslab/desktop` M2 final + 21.

- [ ] **Step 6: Commit**

```bash
git add packages/npm apps/desktop/src/main/services/types-service.ts apps/desktop/test/services/types-service.test.ts
git commit -m "feat(npm): collect package and working-directory type closures for the editor" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 14: Runner environment: login shell, `env.json`, `.env`, `NODE_PATH`, tab-aware spares

**Files:**
- Create: `apps/desktop/src/main/platform/login-shell-env.ts`, `apps/desktop/src/main/runs/runner-config.ts`
- Modify: `apps/desktop/src/main/app-paths.ts:48-57` (`runnerEnvironment`)
- Modify: `apps/desktop/src/main/runs/spare-pool.ts:24-36` (`prepare`), `:88-93` (add `invalidateAll` after `invalidate`)
- Modify: `apps/desktop/src/main/main-services.ts:59-64` (the `SparePool` construction), after the coordinator (env listener)
- Modify: `apps/desktop/src/main/index.ts:150-161` (login-shell environment before `createMainServices`)
- Modify: `apps/desktop/src/main/strings.ts` (`log`)
- Test: `apps/desktop/test/platform/login-shell-env.test.ts`, `apps/desktop/test/runs/runner-config.test.ts`, `apps/desktop/test/runs/runner-environment.test.ts`, `apps/desktop/test/runs/spare-pool.test.ts` (append), `apps/desktop/test/shell.test.ts:50-62`

**Interfaces:**
- Consumes: `parseDotenv`, `MAX_DOTENV_BYTES`, `EnvVars` (Task 4); `EnvStore.variables`, `EnvStore.onChange` (Task 4); `RunnerSpawnConfig`, `SparePool`, `BunRunnerProcess`.
- Produces:
  - `platform/login-shell-env.ts`: `LOGIN_SHELL_TIMEOUT_MS = 2000`; `type LoginShellRun = (argv: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: Uint8Array }>`; `parseEnvNul(bytes: Uint8Array): Record<string, string>`; `readLoginShellEnv(deps: { shell: string | undefined; run?: LoginShellRun; timeoutMs?: number; log(message: string, detail?: unknown): void }): Promise<Record<string, string> | null>`; `runLoginShell: LoginShellRun`; `mergeLoginEnv(processEnv: Record<string, string | undefined>, login: Record<string, string> | null): Record<string, string | undefined>`
  - `app-paths.ts`: `interface RunnerEnvironmentInput { base: Record<string, string | undefined>; variables?: EnvVars; dotenv?: Record<string, string>; workingDirectory?: string | null }`; `runnerEnvironment(paths: Pick<AppPaths, "packagesNodeModules">, input: RunnerEnvironmentInput): Record<string, string>`
  - `runs/runner-config.ts`: `interface RunnerConfigDeps { paths: Pick<AppPaths, "bunBinary" | "runnerBootstrap" | "dataDir" | "packagesNodeModules">; baseEnv(): Record<string, string | undefined>; envVars(): EnvVars; workingDirectory(tabId: string): string | null; isDirectory?(path: string): boolean; readText?(path: string, maxBytes: number): string | null }`; `createRunnerConfig(deps: RunnerConfigDeps): (tabId: string) => RunnerSpawnConfig`; `isDirectorySync(path: string): boolean`
  - `SparePool.invalidateAll(): void`

**Rules (spec §4.6 `loginShellEnv`, §5.3, §12.1):**
- **Login shell.** At startup Main runs `$SHELL -ilc 'env -0'` once, with a 2 s timeout, and merges the result over `process.env`.
  - `JSLAB_*` variables always come from `process.env`.
  - A failure or timeout is logged, and `process.env` is used as is.
  - E2E launches (`JSLAB_E2E=1`) skip the login shell, so no scenario runs the user's shell profile.
- **Runner environment** at spawn, later entries overriding earlier ones: login shell → `env.json` → the WD's `.env` (JSLab-parsed) → `JSLAB=1`.
  - `JSLAB_*` keys from any layer are dropped.
  - `NODE_PATH` is always set by JSLab: `<WD>/node_modules:<packages>/node_modules`, or `<packages>/node_modules` without a usable WD.
  - Bun's own `.env` loading stays off (`--no-env-file`, unchanged).
- **Spawn `cwd`** is the tab's WD when it exists and is a directory; otherwise the data folder. The coordinator reports a missing WD (Task 16).
- **`.env` size.** A WD `.env` over 1 MB is ignored.
- **Spare keys** already include `cwd` and `env` (`spare-pool.ts:27`), so a changed WD, `env.json` or `.env` gives a new key and the stale spare is replaced at the next prepare or take.
- **Saving `env.json`** recycles every tab's spare (`invalidateAll`) and re-warms the active tab.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/platform/login-shell-env.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mergeLoginEnv, readLoginShellEnv, runLoginShell } from "../../src/main/platform/login-shell-env";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("loginShellEnv adapter (spec §4.6)", () => {
  test("runs the login shell once, parses env -0 output, and merges it without taking JSLAB_* variables", async () => {
    const calls: string[][] = [];
    const env = await readLoginShellEnv({
      shell: "zsh",
      run: async (argv) => {
        calls.push(argv);
        return { exitCode: 0, stdout: bytes("PATH=/opt/tools/bin:/usr/bin\0MULTI=a\nb\0JSLAB_USER_DATA=/evil\0EMPTY=\0") };
      },
      log: () => {},
    });
    expect(calls).toEqual([["/bin/zsh", "-ilc", "env -0"]]);
    expect(env).toEqual({ PATH: "/opt/tools/bin:/usr/bin", MULTI: "a\nb", JSLAB_USER_DATA: "/evil", EMPTY: "" });
    expect(mergeLoginEnv({ PATH: "/usr/bin", JSLAB_E2E: "1", ONLY_PROCESS: "x" }, env)).toEqual({
      PATH: "/opt/tools/bin:/usr/bin",
      MULTI: "a\nb",
      EMPTY: "",
      JSLAB_E2E: "1",
      ONLY_PROCESS: "x",
    });
    expect(mergeLoginEnv({ PATH: "/usr/bin" }, null)).toEqual({ PATH: "/usr/bin" });
  });

  test("a failing or slow login shell is logged and yields null; the real runner is killed at the timeout", async () => {
    const logged: string[] = [];
    const log = (message: string) => void logged.push(message);
    expect(await readLoginShellEnv({ shell: "/bin/zsh", run: async () => ({ exitCode: 1, stdout: bytes("") }), log })).toBeNull();
    expect(
      await readLoginShellEnv({
        shell: "/bin/zsh",
        run: async () => {
          throw new Error("spawn failed");
        },
        log,
      }),
    ).toBeNull();
    expect(logged).toHaveLength(2);
    const started = Date.now();
    expect((await runLoginShell(["/bin/sh", "-c", "sleep 5"], 50)).exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
```

`apps/desktop/test/runs/runner-config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../../src/main/app-paths";
import { createRunnerConfig } from "../../src/main/runs/runner-config";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-runner-config-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pathsIn = (root: string) => resolveAppPaths({ resourcesFolder: "/R", userData: join(root, "data"), execPath: "/bun", env: {} });

describe("runner spawn configuration (spec §5.3)", () => {
  test("layers login shell < env.json < .env < JSLAB=1, drops JSLAB_* and puts the WD's node_modules first", () => {
    const paths = pathsIn("/x");
    const read: string[] = [];
    const configFor = createRunnerConfig({
      paths,
      baseEnv: () => ({ PATH: "/usr/bin", SHARED: "login", ONLY_LOGIN: "1", JSLAB_USER_DATA: "/data", UNSET: undefined }),
      envVars: () => ({ SHARED: "env.json", ONLY_ENV: "1", JSLAB: "0", JSLAB_EVIL: "1" }),
      workingDirectory: () => "/work/api",
      isDirectory: (path) => path === "/work/api",
      readText: (path) => {
        read.push(path);
        return "SHARED=dotenv\nONLY_DOTENV=1\nNODE_PATH=/evil\n";
      },
    });
    const config = configFor("t1");
    expect(read).toEqual(["/work/api/.env"]);
    expect(config.cwd).toBe("/work/api");
    expect(config.env).toEqual({
      PATH: "/usr/bin",
      SHARED: "dotenv",
      ONLY_LOGIN: "1",
      ONLY_ENV: "1",
      ONLY_DOTENV: "1",
      JSLAB: "1",
      NODE_PATH: `/work/api/node_modules:${paths.packagesNodeModules}`,
    });
  });

  test("without a working directory the data folder is the cwd and no .env is read", () => {
    const paths = pathsIn("/x");
    const configFor = createRunnerConfig({
      paths,
      baseEnv: () => ({ PATH: "/usr/bin" }),
      envVars: () => ({ A: "1" }),
      workingDirectory: () => null,
      readText: () => {
        throw new Error("no .env without a WD");
      },
    });
    expect(configFor("t1")).toMatchObject({ cwd: paths.dataDir, env: { A: "1", JSLAB: "1", NODE_PATH: paths.packagesNodeModules } });
  });

  test("a missing WD falls back to the data folder, and a .env over 1 MB is ignored", async () => {
    const paths = pathsIn(dir);
    const wd = join(dir, "wd");
    await mkdir(wd, { recursive: true });
    await writeFile(join(wd, ".env"), `BIG=${"x".repeat(1024 * 1024)}\n`);
    let current: string | null = join(dir, "missing");
    const configFor = createRunnerConfig({ paths, baseEnv: () => ({}), envVars: () => ({}), workingDirectory: () => current });
    expect(configFor("t1").cwd).toBe(paths.dataDir);
    current = wd;
    const config = configFor("t1");
    expect(config.cwd).toBe(wd);
    expect(config.env.BIG).toBeUndefined();
  });
});
```

`apps/desktop/test/runs/runner-environment.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths } from "../../src/main/app-paths";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { createRunnerConfig } from "../../src/main/runs/runner-config";

const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);
let dir = "";
let runner: BunRunnerProcess | null = null;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-runner-env-")));
});
afterEach(async () => {
  runner?.kill();
  runner = null;
  await rm(dir, { recursive: true, force: true });
});

async function writeModule(folder: string, from: string) {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "package.json"), JSON.stringify({ name: folder.split("/").pop(), main: "index.js" }));
  await writeFile(join(folder, "index.js"), `module.exports = { from: ${JSON.stringify(from)} };\n`);
}

test("a real runner sees login < env.json < .env < JSLAB=1 and resolves the WD's node_modules before app packages (spec §5.3)", async () => {
  const paths = resolveAppPaths({ resourcesFolder: "/R", userData: join(dir, "data"), execPath: process.execPath, env: {} });
  const wd = join(dir, "wd");
  await writeModule(join(wd, "node_modules", "dep"), "wd");
  await writeModule(join(paths.packagesNodeModules, "dep"), "packages");
  await writeModule(join(paths.packagesNodeModules, "only-packages"), "packages");
  await writeFile(join(wd, ".env"), "SHARED=dotenv\nONLY_DOTENV=yes\n");
  const out = join(dir, "out.json");
  const configFor = createRunnerConfig({
    paths: { ...paths, runnerBootstrap: BOOTSTRAP },
    baseEnv: () => ({ PATH: process.env.PATH, SHARED: "login", OUT_FILE: out }),
    envVars: () => ({ SHARED: "env.json", ONLY_ENV: "yes" }),
    workingDirectory: () => wd,
  });
  runner = await BunRunnerProcess.start(configFor("t1"));
  const entry = join(dir, "data", "runs", "t1", "entry-env.mjs");
  await mkdir(join(dir, "data", "runs", "t1"), { recursive: true });
  await writeFile(
    entry,
    [
      'import { writeFileSync } from "node:fs";',
      'const dep = await import("dep");',
      'const only = await import("only-packages");',
      "writeFileSync(process.env.OUT_FILE, JSON.stringify({",
      "  shared: process.env.SHARED, onlyEnv: process.env.ONLY_ENV, onlyDotenv: process.env.ONLY_DOTENV,",
      "  jslab: process.env.JSLAB, cwd: process.cwd(), dep: dep.default.from, only: only.default.from,",
      "}));",
      "",
    ].join("\n"),
  );
  const current = runner;
  const settled = new Promise<void>((resolve) =>
    current.onMessage((message) => {
      if (message.type === "state" && (message.state === "idle" || message.state === "settled")) resolve();
    }),
  );
  current.send({ type: "run", runId: "run-env", entry, settings: { maxEntries: 100 } });
  await settled;
  expect(JSON.parse(await readFile(out, "utf8"))).toEqual({
    shared: "dotenv",
    onlyEnv: "yes",
    onlyDotenv: "yes",
    jslab: "1",
    cwd: wd,
    dep: "wd",
    only: "packages",
  });
});
```

Append to `apps/desktop/test/runs/spare-pool.test.ts` inside `describe("SparePool", …)`:

```ts
  test("invalidateAll recycles every tab's spare and re-warms only the active tab (spec §11.3, §12.1)", async () => {
    const { pool, started } = fakePool();
    pool.prepare("a");
    pool.setActiveTab("b");
    await Bun.sleep(0);
    pool.invalidateAll();
    await Bun.sleep(0);
    expect(started.map((runner) => runner.cwd)).toEqual(["/runs/a", "/runs/b", "/runs/b"]);
    expect(started[1]?.kill).toHaveBeenCalledTimes(1);
    expect(started[2]?.kill).not.toHaveBeenCalled();
    pool.dispose();
  });
```

In `apps/desktop/test/shell.test.ts`, replace the `runnerEnvironment` test (lines 50-62) with:

```ts
describe("runnerEnvironment", () => {
  test("sets JSLAB and NODE_PATH, drops undefined values and JSLab overrides", () => {
    const paths = resolveAppPaths(input);
    expect(
      runnerEnvironment(paths, { base: { PATH: "/usr/bin", EMPTY: undefined, JSLAB_BUN_PATH: "/x", NODE_PATH: "/old" } }),
    ).toEqual({
      PATH: "/usr/bin",
      JSLAB: "1",
      NODE_PATH: paths.packagesNodeModules,
    });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/platform/login-shell-env.test.ts test/runs/runner-config.test.ts test/runs/runner-environment.test.ts test/runs/spare-pool.test.ts test/shell.test.ts`
Expected: FAIL, `Cannot find module "../../src/main/platform/login-shell-env"`, `pool.invalidateAll is not a function`, and the `runnerEnvironment` expectation fails.

- [ ] **Step 3: Implement**

`apps/desktop/src/main/strings.ts`, in `log`:

```ts
    loginShellFailed: (reason: string) => `Couldn't read the login shell environment (${reason}); using the app's environment`,
```

`apps/desktop/src/main/platform/login-shell-env.ts`:

```ts
import { strings } from "../strings";

/** Spec §4.6 loginShellEnv: GUI apps lack the shell PATH, so Main reads the login shell's environment once. */
export const LOGIN_SHELL_TIMEOUT_MS = 2000;

export type LoginShellRun = (argv: string[], timeoutMs: number) => Promise<{ exitCode: number | null; stdout: Uint8Array }>;

export function parseEnvNul(bytes: Uint8Array): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of new TextDecoder().decode(bytes).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

/** Spawns the shell in its own process group and SIGKILLs the group at the timeout (the exit code is then null). */
export const runLoginShell: LoginShellRun = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
  const timer = setTimeout(() => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      proc.kill("SIGKILL");
    }
  }, timeoutMs);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    return { exitCode: proc.signalCode ? null : exitCode, stdout: new Uint8Array(stdout) };
  } finally {
    clearTimeout(timer);
  }
};

export async function readLoginShellEnv(deps: {
  shell: string | undefined;
  run?: LoginShellRun;
  timeoutMs?: number;
  log(message: string, detail?: unknown): void;
}): Promise<Record<string, string> | null> {
  const shell = deps.shell?.startsWith("/") ? deps.shell : "/bin/zsh";
  try {
    const result = await (deps.run ?? runLoginShell)([shell, "-ilc", "env -0"], deps.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      deps.log(strings.log.loginShellFailed(result.exitCode === null ? "timed out" : `exit ${result.exitCode}`));
      return null;
    }
    const env = parseEnvNul(result.stdout);
    return Object.keys(env).length > 0 ? env : null;
  } catch (error) {
    deps.log(strings.log.loginShellFailed(String(error)));
    return null;
  }
}

/** process.env with the login shell's variables merged over it; JSLAB_* variables always come from process.env. */
export function mergeLoginEnv(
  processEnv: Record<string, string | undefined>,
  login: Record<string, string> | null,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...processEnv };
  if (!login) return merged;
  for (const [key, value] of Object.entries(login)) if (!key.startsWith("JSLAB_")) merged[key] = value;
  return merged;
}
```

`apps/desktop/src/main/app-paths.ts`: add `import type { EnvVars } from "@jslab/shared";` and replace `runnerEnvironment` (lines 48-57) with:

```ts
export interface RunnerEnvironmentInput {
  /** The login-shell environment (spec §4.6). */
  base: Record<string, string | undefined>;
  /** env.json (spec §12.1). */
  variables?: EnvVars;
  /** The WD's .env, parsed by JSLab (spec §5.3). */
  dotenv?: Record<string, string>;
  workingDirectory?: string | null;
}

/**
 * Environment for runner processes (spec §5.3): login shell → env.json → the WD's .env → JSLAB=1, later layers winning.
 * JSLAB_* keys never reach a runner, and JSLab always sets NODE_PATH: the WD's node_modules first, then app packages.
 */
export function runnerEnvironment(paths: Pick<AppPaths, "packagesNodeModules">, input: RunnerEnvironmentInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.base)) {
    if (value !== undefined && !key.startsWith("JSLAB_")) env[key] = value;
  }
  for (const layer of [input.variables ?? {}, input.dotenv ?? {}]) {
    for (const [key, value] of Object.entries(layer)) if (!key.startsWith("JSLAB_")) env[key] = value;
  }
  env.JSLAB = "1";
  env.NODE_PATH = input.workingDirectory
    ? `${join(input.workingDirectory, "node_modules")}:${paths.packagesNodeModules}`
    : paths.packagesNodeModules;
  return env;
}
```

`apps/desktop/src/main/runs/runner-config.ts`:

```ts
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { type EnvVars, MAX_DOTENV_BYTES, parseDotenv } from "@jslab/shared";
import { type AppPaths, runnerEnvironment } from "../app-paths";
import type { RunnerSpawnConfig } from "./bun-runner-process";

export function isDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A regular file's text when it is at most `maxBytes`, else null (a missing or oversized .env is ignored). */
function readTextSync(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const buffer = Buffer.alloc(info.size);
    readSync(fd, buffer, 0, info.size, 0);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface RunnerConfigDeps {
  paths: Pick<AppPaths, "bunBinary" | "runnerBootstrap" | "dataDir" | "packagesNodeModules">;
  baseEnv(): Record<string, string | undefined>;
  envVars(): EnvVars;
  workingDirectory(tabId: string): string | null;
  isDirectory?(path: string): boolean;
  readText?(path: string, maxBytes: number): string | null;
}

/**
 * The SparePool's `configFor` (spec §5.3). SparePool.prepare is synchronous, so the WD check and the .env read are
 * synchronous too. The spare key hashes cwd and env, so any WD, env.json or .env change starts a fresh spare.
 */
export function createRunnerConfig(deps: RunnerConfigDeps): (tabId: string) => RunnerSpawnConfig {
  return (tabId) => {
    const requested = deps.workingDirectory(tabId);
    const workingDirectory = requested && (deps.isDirectory ?? isDirectorySync)(requested) ? requested : null;
    const text = workingDirectory ? (deps.readText ?? readTextSync)(join(workingDirectory, ".env"), MAX_DOTENV_BYTES) : null;
    return {
      bunPath: deps.paths.bunBinary,
      bootstrapPath: deps.paths.runnerBootstrap,
      cwd: workingDirectory ?? deps.paths.dataDir,
      env: runnerEnvironment(deps.paths, {
        base: deps.baseEnv(),
        variables: deps.envVars(),
        dotenv: text === null ? {} : parseDotenv(text),
        workingDirectory,
      }),
    };
  };
}
```

`apps/desktop/src/main/runs/spare-pool.ts`:

1. As the first line of `prepare` after the disposed check, add `if (!this.#generation.has(tabId)) this.#generation.set(tabId, 0);` so every prepared tab is known to `invalidateAll`.
2. Add after `invalidate`:

```ts
  /** env.json or package changes recycle every tab's spare; only the active tab is re-warmed (spec §11.3, §12.1). */
  invalidateAll(): void {
    if (this.#disposed) return;
    for (const tabId of new Set([...this.#spares.keys(), ...this.#generation.keys()])) this.invalidate(tabId);
    if (this.#activeTabId !== null) this.prepare(this.#activeTabId);
  }
```

`apps/desktop/src/main/main-services.ts`:

1. Replace `import { type AppPaths, runnerEnvironment } from "./app-paths";` with `import type { AppPaths } from "./app-paths";` and add `import { createRunnerConfig } from "./runs/runner-config";`.
2. Replace the `new SparePool(…)` expression (lines 59-64) with:

```ts
  const spares = new SparePool(
    options.startRunner ?? ((config) => BunRunnerProcess.start(config)),
    createRunnerConfig({
      paths,
      baseEnv: () => options.env,
      envVars: () => env.variables,
      workingDirectory: (tabId) => session.session.tabs[tabId]?.workingDirectory ?? null,
    }),
  );
```

3. After the `const coordinator = new RunCoordinator({ … });` statement, add:

```ts
  // Spec §12.1: saving env.json recycles every tab's spare, so the next run gets the new values.
  env.onChange(() => spares.invalidateAll());
```

`apps/desktop/src/main/index.ts`:

1. Add `import { mergeLoginEnv, readLoginShellEnv } from "./platform/login-shell-env";`.
2. After `const shiftHeld = isShiftHeld();` add:

```ts
  // Spec §4.6 loginShellEnv: a GUI app lacks the shell PATH. E2E launches skip it, so no scenario runs the user's
  // shell profile.
  const loginEnv = process.env.JSLAB_E2E === "1" ? null : await readLoginShellEnv({ shell: process.env.SHELL, log });
  const baseEnv = mergeLoginEnv(process.env, loginEnv);
```

3. In the `createMainServices({ … })` call, replace `env: process.env,` with `env: baseEnv,`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/platform/login-shell-env.test.ts test/runs test/shell.test.ts test/main-services.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/desktop` M2 final + 28.

- [ ] **Step 6: Run the core scenarios (startup order changed)**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/core.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: every test passes, 0 fail. Read-only `ps` check: no survivors.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main apps/desktop/test
git commit -m "feat(desktop): login-shell, env.json and .env layering with per-tab working-directory spares" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 15: Transform: Build settings (proposals and decorators)

**Files:**
- Create: `packages/transform/src/build.ts`
- Modify: `packages/transform/src/types.ts:1-9`, `packages/transform/src/transform.ts:1-48`, `packages/transform/src/index.ts`
- Modify: `apps/desktop/src/main/runs/run-coordinator.ts:4` (the `@jslab/transform` type import), `:15-21` (`RunnerSettings`), `:164-173` (transform options)
- Test: `packages/transform/test/build.test.ts`, `apps/desktop/test/runs/run-coordinator.test.ts` (append)

**Interfaces:**
- Consumes: `buildSettings` / `RunnerSettings.build` (Task 2); `runInstrumented`, `baseOptions` (`packages/transform/test/helpers.ts`).
- Produces (`@jslab/transform`):
  - `type DecoratorMode = "none" | "2023-11" | "legacy"`
  - `interface BuildOptions { decorators: DecoratorMode; pipelineOperator: boolean; doExpressions: boolean; throwExpressions: boolean; functionSent: boolean; regexpModifiers: boolean; optionalChainingAssign: boolean }`
  - `TransformOptions.build?: BuildOptions` (defaults to `DEFAULT_BUILD_OPTIONS`)
  - `DEFAULT_BUILD_OPTIONS`, `type Plugins` (Babel's `plugins` option type), `proposalPlugins(build: BuildOptions): Plugins`
  - Coordinator: `RunnerSettings.build?: BuildOptions`, passed as `TransformOptions.build`

**Rules (spec §5.4, §8 Build; parity LB-05, LB-07; decisions 3 and 4 above):**
- The plugins, in this order after JSLab's instrument plugin:
  - `2023-11` → `["proposal-decorators", { version: "2023-11" }]`; `legacy` → `["proposal-decorators", { version: "legacy" }]`; `none` → no decorator plugin, so decorators are a syntax error.
  - `pipelineOperator` → `["proposal-pipeline-operator", { proposal: "hack", topicToken: "%" }]`
  - `doExpressions` → `"proposal-do-expressions"`; `throwExpressions` → `"proposal-throw-expressions"`; `functionSent` → `"proposal-function-sent"`
  - `regexpModifiers` → `"transform-regexp-modifiers"`
  - `optionalChainingAssign` → `["proposal-optional-chaining-assign", { version: "2023-07" }]`
- The TypeScript preset gets `{ onlyRemoveTypeImports: false }`. `declare` fields are always supported in Babel 8, and passing `allowDeclareFields` throws.
- Partial application and async do expressions are out (LB-05 📝, Babel 8 removed them).

- [ ] **Step 1: Write the failing tests**

`packages/transform/test/build.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_BUILD_OPTIONS } from "../src/build";
import { transform } from "../src/transform";
import type { BuildOptions } from "../src/types";
import { baseOptions, runInstrumented } from "./helpers";

const build = (patch: Partial<BuildOptions> = {}): BuildOptions => ({ ...DEFAULT_BUILD_OPTIONS, ...patch });
const last = async (source: string, patch: Partial<BuildOptions> = {}) =>
  (await runInstrumented(source, { build: build(patch) })).calls.at(-1)?.value;
const compiles = (source: string, patch: Partial<BuildOptions> = {}) =>
  transform(source, { ...baseOptions, autoLog: false, loopProtection: false, build: build(patch) }).ok;

describe("Build settings (spec §8, LB-05, LB-07)", () => {
  test("2023-11 decorators are the default and run", async () => {
    const source = [
      "const tenfold = (value: any, _context: ClassMethodDecoratorContext) =>",
      "  function (this: unknown, ...args: any[]) { return value.apply(this, args) * 10; };",
      "class A { @tenfold m() { return 4; } }",
      "new A().m()",
    ].join("\n");
    expect(await last(source)).toBe(40);
  });

  test("legacy decorators run TypeScript-style (LB-07)", async () => {
    const source = [
      "function sealed(ctor: Function) { (ctor as any).sealedFlag = true; }",
      "function double(_target: any, _key: string, descriptor: PropertyDescriptor) {",
      "  const original = descriptor.value;",
      "  descriptor.value = function (...args: any[]) { return original.apply(this, args) * 2; };",
      "  return descriptor;",
      "}",
      "@sealed class B { @double n() { return 21; } }",
      "[(B as any).sealedFlag, new B().n()]",
    ].join("\n");
    expect(await last(source, { decorators: "legacy" })).toEqual([true, 42]);
  });

  test("decorators: none rejects decorator syntax, and declare fields always strip (LB-07)", () => {
    expect(compiles("@x class A {}", { decorators: "none" })).toBe(false);
    const result = transform("class X { declare y: string; z = 1 }", { ...baseOptions, build: build({ decorators: "none" }) });
    expect(result.ok && result.code).not.toContain("declare");
  });

  test("pipeline, do and throw expressions need their settings", async () => {
    expect(compiles("5 |> % * 2")).toBe(false);
    expect(await last("5 |> % * 2", { pipelineOperator: true })).toBe(10);
    expect(compiles('let x = do { "yes" }; x')).toBe(false);
    expect(await last('let x = do { if (true) { "yes" } else { "no" } };\nx', { doExpressions: true })).toBe("yes");
    expect(compiles('const f = (v?: number) => v ?? throw new Error("none");')).toBe(false);
    expect(await last('const f = (v?: number) => v ?? throw new Error("none");\nf(3)', { throwExpressions: true })).toBe(3);
  });

  test("function.sent needs its setting", async () => {
    const source = 'function* g() { const first = function.sent; yield first; }\nconst it = g();\nit.next("hello").value';
    expect(compiles(source)).toBe(false);
    expect(await last(source, { functionSent: true })).toBe("hello");
  });

  test("regexp modifiers and optional chaining assignment are on by default", async () => {
    expect(await last('const o: any = { a: { b: 1 } };\no?.a.b = 2;\n[/(?i:a)b/.test("Ab"), o.a.b]')).toEqual([true, 2]);
    expect(compiles("const o: any = {}; o?.a = 1;", { optionalChainingAssign: false })).toBe(false);
  });
});
```

Append to `apps/desktop/test/runs/run-coordinator.test.ts`, inside its top-level `describe` (add `DEFAULT_BUILD_OPTIONS` to the `@jslab/transform` import and `TransformOptions` is already imported as a type):

```ts
  test("build settings reach the transform (spec §8 Build)", async () => {
    const seen: TransformOptions[] = [];
    const harness = await createHarness(
      { build: { ...DEFAULT_BUILD_OPTIONS, pipelineOperator: true } },
      {
        transform: async (source, options) => {
          seen.push(options);
          return transform(source, options);
        },
      },
    );
    const { runId } = harness.coordinator.start({ tabId: "t1", code: "1 |> % + 1", language: "typescript", logpoints: [] });
    await harness.waitForState("idle", runId);
    expect(seen[0]?.build?.pipelineOperator).toBe(true);
    expect(harness.events.find((event) => event.kind === "result")).toMatchObject({ value: { t: "number", v: "2" } });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/transform && bun test test/build.test.ts`
Expected: FAIL, `Cannot find module "../src/build"`.

- [ ] **Step 3: Implement**

`packages/transform/src/types.ts`: replace lines 1-9 with:

```ts
export type Language = "typescript" | "javascript" | "tsx" | "jsx";

/** `build.decorators` (spec §8 Build). */
export type DecoratorMode = "none" | "2023-11" | "legacy";

/** The Build tab (spec §8): the syntax proposals the transform enables. */
export interface BuildOptions {
  decorators: DecoratorMode;
  pipelineOperator: boolean;
  doExpressions: boolean;
  throwExpressions: boolean;
  functionSent: boolean;
  regexpModifiers: boolean;
  optionalChainingAssign: boolean;
}

export interface TransformOptions {
  language: Language;
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  logpoints: readonly number[];
  /** Defaults to DEFAULT_BUILD_OPTIONS (the spec §8 defaults). */
  build?: BuildOptions;
}
```

`packages/transform/src/build.ts`:

```ts
import type * as Babel from "@babel/standalone";
import type { BuildOptions } from "./types";

export type Plugins = NonNullable<NonNullable<Parameters<typeof Babel.transform>[1]>["plugins"]>;

/** The spec §8 Build defaults. */
export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  decorators: "2023-11",
  pipelineOperator: false,
  doExpressions: false,
  throwExpressions: false,
  functionSent: false,
  regexpModifiers: true,
  optionalChainingAssign: true,
};

/** Babel 8 plugins for the enabled proposals (spec §5.4 "Enabled proposal plugins"). */
export function proposalPlugins(build: BuildOptions): Plugins {
  const plugins: Plugins = [];
  if (build.decorators !== "none") plugins.push(["proposal-decorators", { version: build.decorators }]);
  if (build.pipelineOperator) plugins.push(["proposal-pipeline-operator", { proposal: "hack", topicToken: "%" }]);
  if (build.doExpressions) plugins.push("proposal-do-expressions");
  if (build.throwExpressions) plugins.push("proposal-throw-expressions");
  if (build.functionSent) plugins.push("proposal-function-sent");
  if (build.regexpModifiers) plugins.push("transform-regexp-modifiers");
  if (build.optionalChainingAssign) plugins.push(["proposal-optional-chaining-assign", { version: "2023-07" }]);
  return plugins;
}
```

`packages/transform/src/transform.ts`:

1. Add `import { DEFAULT_BUILD_OPTIONS, proposalPlugins } from "./build";`.
2. In `presetsFor`, replace both `["typescript", {}]` entries with `["typescript", { onlyRemoveTypeImports: false }]`.
3. In `transform`, replace the `plugins:` line with:

```ts
      plugins: [createInstrumentPlugin(options, source, diagnostics), ...proposalPlugins(options.build ?? DEFAULT_BUILD_OPTIONS)],
```

`packages/transform/src/index.ts`: add `export { DEFAULT_BUILD_OPTIONS, proposalPlugins } from "./build";`.

`apps/desktop/src/main/runs/run-coordinator.ts`:

1. Change the `@jslab/transform` type import to `import type { BuildOptions, Diagnostic, Language, TransformOptions, TransformResult } from "@jslab/transform";`.
2. Add `build?: BuildOptions;` as the last member of `RunnerSettings`.
3. In `#execute`, add `...(settings.build ? { build: settings.build } : {}),` to the object passed to `this.deps.transform(request.code, { … })`, after `logpoints: request.logpoints,`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/transform && bun test && builtin cd ../../apps/desktop && bun test test/runs/run-coordinator.test.ts`
Expected: PASS, 0 fail. `@jslab/transform` M2 final + 6.

If a proposal test fails because Babel reports an unknown plugin or option, stop and report the exact Babel error and `@babel/standalone`'s version; the controller rules on the plugin option (R-M3-BABEL-1). Don't drop the setting.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/transform` M2 final + 6; `@jslab/desktop` M2 final + 29.

- [ ] **Step 6: Commit**

```bash
git add packages/transform apps/desktop/src/main/runs/run-coordinator.ts apps/desktop/test/runs/run-coordinator.test.ts
git commit -m "feat(transform): build settings for decorators and syntax proposals" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 16: Working directory in runs: WD transform plugin, coordinator, missing-WD error

**Files:**
- Create: `packages/transform/src/working-directory.ts`
- Modify: `packages/transform/src/types.ts` (`TransformOptions`), `packages/transform/src/transform.ts` (plugins)
- Modify: `packages/shared/src/tabs.ts` (add `scriptFileName`)
- Modify: `apps/desktop/src/main/runs/run-coordinator.ts:8-13` (`RunStartRequest`), `:23-36` (deps), `:164-175` (`#execute`)
- Modify: `apps/desktop/src/main/rpc-handlers.ts:1-13` (imports), `:56-65` (`run.start`)
- Modify: `apps/desktop/src/main/strings.ts` (add `runs`)
- Test: `packages/transform/test/working-directory.test.ts`, `packages/shared/test/tabs.test.ts` (append), `apps/desktop/test/runs/working-directory.test.ts`, `apps/desktop/test/rpc-handlers.test.ts:44-53` and append

**Interfaces:**
- Consumes: `createRunnerConfig` (Task 14); `deriveTitle`, `baseName`, `extensionFor` (`@jslab/shared` tabs.ts).
- Produces:
  - `@jslab/transform`: `interface WorkingDirectoryOptions { dir: string; filename: string }`; `TransformOptions.workingDirectory?: WorkingDirectoryOptions`; `createWorkingDirectoryPlugin(options: WorkingDirectoryOptions)`
  - `@jslab/shared`: `scriptFileName(tab: Pick<TabState, "title" | "titleIsCustom" | "filePath" | "language">, code: string): string`
  - Coordinator: `RunStartRequest.workingDirectory?: string | null`, `RunStartRequest.scriptName?: string`; `RunCoordinatorDeps.directoryExists?(path: string): Promise<boolean>`; `WORKING_DIRECTORY_ERROR = "WorkingDirectoryError"`
  - `strings.runs.workingDirectoryNotFound(path: string): string` → `Working directory not found: <path>` (spec §12.2; the UI adds the Change… action in Task 24)

**Rules (spec §5.3, §12.2; carry R-M1-17(d)):**
- With a WD, the transform:
  - rewrites relative specifiers (`./x`, `../x`) to absolute paths under the WD in static imports, `export … from`, `export * from`, dynamic `import("…")`, `require("…")` and `require.resolve("…")` with a string literal (bare and absolute specifiers are untouched; a computed specifier is untouched and resolves against the entry folder);
  - replaces free `__dirname` and `import.meta.dir`/`import.meta.dirname` with the WD;
  - replaces free `__filename`, `import.meta.path`/`import.meta.filename` and `module.filename` with `<WD>/<script name>`;
  - replaces `import.meta.url` with that file's `file://` URL, and `module.path` with the WD;
  - never touches a shadowed binding or an assignment target.
- `process.cwd()` is the WD through the spawn `cwd` (Task 14). Local `.ts`/`.tsx` files run natively through Bun and are not instrumented.
- The script name is the file's name for a saved file. Otherwise it is the tab title with `/`, `:` and `\` replaced by `-`, plus the language extension.
- A WD that doesn't exist when the run starts fails the run with one `error` event: `phase: "runner"`, `name: "WorkingDirectoryError"`, message `Working directory not found: <path>`. No transform or runner is used.
- R-M1-17(d): a file created in the WD after the spare started must import. If Bun 1.4.0 can't, stop (Step 5).

- [ ] **Step 1: Write the failing tests**

`packages/transform/test/working-directory.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "../src/transform";
import { baseOptions, runInstrumented } from "./helpers";

const wd = { dir: "/work/api", filename: "/work/api/fetch users.ts" };
const code = (source: string, withWd = true) => {
  const result = transform(source, { ...baseOptions, autoLog: false, loopProtection: false, ...(withWd ? { workingDirectory: wd } : {}) });
  if (!result.ok) throw new Error(result.diagnostics[0]?.message);
  return result.code;
};

let dir = "";
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-wd-transform-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("working directory transform (spec §5.3)", () => {
  test("rewrites relative specifiers against the WD and leaves bare, absolute and computed ones", () => {
    const out = code(
      [
        'import a from "./a";',
        'export { b } from "../lib/b.js";',
        'export * from "./c";',
        'const d = await import("./d");',
        'const e = require("./e");',
        'const p = require.resolve("./p");',
        'import z from "zod";',
        'import abs from "/abs/x";',
        'const name = "./computed"; await import(name);',
      ].join("\n"),
    );
    for (const path of ["/work/api/a", "/work/lib/b.js", "/work/api/c", "/work/api/d", "/work/api/e", "/work/api/p"]) {
      expect(out).toContain(`"${path}"`);
    }
    expect(out).toContain('"zod"');
    expect(out).toContain('"/abs/x"');
    expect(out).toContain('"./computed"');
  });

  test("replaces free __dirname and __filename, but not shadowed bindings or assignment targets", () => {
    const out = code(
      "const where = [__dirname, __filename];\nfunction f(__dirname: string) { return __dirname; }\nlet __filename2 = 1;\n",
    );
    expect(out).toContain('["/work/api", "/work/api/fetch users.ts"]');
    expect(out).toContain("return __dirname;");
  });

  test("replaces import.meta.dir, path, url and module.filename/path", () => {
    const out = code(
      "const m = [import.meta.dir, import.meta.dirname, import.meta.path, import.meta.filename, import.meta.url, module.filename, module.path];",
    );
    expect(out).toContain(
      '["/work/api", "/work/api", "/work/api/fetch users.ts", "/work/api/fetch users.ts", "file:///work/api/fetch%20users.ts", "/work/api/fetch users.ts", "/work/api"]',
    );
  });

  test("without a working directory nothing is rewritten", () => {
    const out = code('import a from "./a";\nconst x = __dirname;', false);
    expect(out).toContain('"./a"');
    expect(out).toContain("__dirname");
  });

  test("a relative import from the WD runs and __filename reports the tab's script path", async () => {
    await writeFile(join(dir, "util.mjs"), "export const value = 41;\n");
    const { calls } = await runInstrumented('import { value } from "./util.mjs";\n[value + 1, __filename]', {
      workingDirectory: { dir, filename: join(dir, "scratch.ts") },
    });
    expect(calls.at(-1)?.value).toEqual([42, join(dir, "scratch.ts")]);
  });
});
```

Append to `packages/shared/test/tabs.test.ts` (add `scriptFileName` and `createTab` to its imports if missing):

```ts
test("scriptFileName names __filename from the file, or from the title with the language extension (spec §5.3)", () => {
  expect(scriptFileName(createTab({ filePath: "/p/api/client.mts", language: "typescript" }), "")).toBe("client.mts");
  expect(scriptFileName(createTab({ title: "fetch users", titleIsCustom: true, language: "tsx" }), "")).toBe("fetch users.tsx");
  expect(scriptFileName(createTab({ language: "javascript" }), "// a/b:c\\d\n")).toBe("-- a-b-c-d.js");
  expect(scriptFileName(createTab({ language: "typescript" }), "")).toBe("Untitled.ts");
});
```

`apps/desktop/test/runs/working-directory.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunState } from "@jslab/rpc-schema";
import { transform } from "@jslab/transform";
import { resolveAppPaths } from "../../src/main/app-paths";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { RunCoordinator } from "../../src/main/runs/run-coordinator";
import { createRunnerConfig } from "../../src/main/runs/runner-config";
import { SparePool } from "../../src/main/runs/spare-pool";

const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);
let dir = "";
let coordinator: RunCoordinator | null = null;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "jslab-wd-run-")));
});
afterEach(async () => {
  coordinator?.dispose();
  coordinator = null;
  await rm(dir, { recursive: true, force: true });
});

function setup(workingDirectory: string) {
  const paths = resolveAppPaths({ resourcesFolder: "/R", userData: join(dir, "data"), execPath: process.execPath, env: {} });
  const events: RunEvent[] = [];
  const states: { runId: string; state: RunState }[] = [];
  // The latest spare start, so a test can wait for a pre-warmed runner instead of sleeping.
  let lastStart: Promise<unknown> = Promise.resolve();
  const spares = new SparePool(
    (config) => {
      const started = BunRunnerProcess.start(config);
      lastStart = started;
      return started;
    },
    createRunnerConfig({
      paths: { ...paths, runnerBootstrap: BOOTSTRAP },
      baseEnv: () => ({ PATH: process.env.PATH }),
      envVars: () => ({}),
      workingDirectory: () => workingDirectory,
    }),
  );
  coordinator = new RunCoordinator({
    transform: async (source, options) => transform(source, options),
    spares,
    runsDir: paths.runsDir,
    settings: () => ({ autoLog: true, loopProtection: true, loopProtectionMaxIterations: 2000, maxEntries: 1000, unresponsiveTimeoutMs: 5000 }),
    onEvents: (_tabId, _runId, batch) => events.push(...batch),
    onState: (_tabId, runId, state) => states.push({ runId, state }),
    onDiagnostics: () => {},
    runLock: { add: () => {}, remove: () => {} },
  });
  const waitFor = async (runId: string, wanted: RunState[], timeoutMs = 10_000) => {
    const started = Date.now();
    while (!states.some((s) => s.runId === runId && wanted.includes(s.state))) {
      if (Date.now() - started > timeoutMs) throw new Error(`run never reached ${wanted.join("/")}: ${JSON.stringify(states)}`);
      await Bun.sleep(20);
    }
  };
  const consoleText = () =>
    events.flatMap((event) => (event.kind === "console" ? event.args.map((arg) => String((arg as { v?: unknown }).v)) : []));
  return { spares, spareStarted: () => lastStart, events, states, waitFor, consoleText, current: coordinator };
}

describe("working directory runs (spec §5.3, §12.2)", () => {
  test("relative imports, __dirname, __filename, import.meta.dir and relative fs paths use the WD", async () => {
    const wd = join(dir, "api");
    await Bun.write(join(wd, "util.ts"), "export const greet = (name: string): string => `hi ${name}`;\n");
    await Bun.write(join(wd, "data.txt"), "from wd");
    const { waitFor, consoleText, current } = setup(wd);
    const { runId } = current.start({
      tabId: "t1",
      code: [
        'import { readFileSync } from "node:fs";',
        'import { greet } from "./util";',
        "console.log(JSON.stringify({",
        '  greet: greet("wd"), same: __dirname === process.cwd(), file: __filename,',
        '  data: readFileSync("./data.txt", "utf8"), metaDir: import.meta.dir,',
        "}));",
      ].join("\n"),
      language: "typescript",
      logpoints: [],
      workingDirectory: wd,
      scriptName: "scratch.ts",
    });
    await waitFor(runId, ["idle", "settled", "failed"]);
    expect(JSON.parse(consoleText()[0] ?? "{}")).toEqual({
      greet: "hi wd",
      same: true,
      file: join(wd, "scratch.ts"),
      data: "from wd",
      metaDir: wd,
    });
  });

  test("a file created in the WD after the spare started imports (R-M1-17(d), bundled Bun)", async () => {
    const wd = join(dir, "late");
    await Bun.write(join(wd, ".keep"), "");
    const { spares, spareStarted, waitFor, consoleText, current } = setup(wd);
    spares.setActiveTab("t1");
    await spareStarted();
    await writeFile(join(wd, "late.ts"), 'export const late = "created after the spare";\n');
    const { runId } = current.start({
      tabId: "t1",
      code: 'import { late } from "./late";\nconsole.log(late);',
      language: "typescript",
      logpoints: [],
      workingDirectory: wd,
      scriptName: "scratch.ts",
    });
    await waitFor(runId, ["idle", "settled", "failed"]);
    expect(consoleText()).toEqual(["created after the spare"]);
  });

  test("a missing working directory fails the run with WorkingDirectoryError and starts nothing", async () => {
    const missing = join(dir, "gone");
    const { events, waitFor, current } = setup(missing);
    const { runId } = current.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [], workingDirectory: missing, scriptName: "x.ts" });
    await waitFor(runId, ["failed"]);
    expect(events).toEqual([
      expect.objectContaining({ kind: "error", phase: "runner", name: "WorkingDirectoryError", message: `Working directory not found: ${missing}` }),
    ]);
  });
});
```

In `apps/desktop/test/rpc-handlers.test.ts`, change the expectation in `run.start validates and forwards only the run fields` to:

```ts
    expect(deps.coordinator.start).toHaveBeenCalledWith({
      tabId: "t1",
      code: "1 + 1",
      language: "typescript",
      logpoints: [],
      workingDirectory: null,
      scriptName: "1 + 1.ts",
    });
```

and append inside `describe("requests", …)`:

```ts
  test("run.start passes the tab's working directory and script name from the session (spec §5.3)", () => {
    const { handlers, deps } = setup();
    deps.session.session.tabs.t1 = { ...(deps.session.session.tabs.t1 as NonNullable<(typeof deps.session.session.tabs)["t1"]>), workingDirectory: "/work/api", title: "fetch users", titleIsCustom: true };
    handlers.requests["run.start"](validStart);
    expect(deps.coordinator.start).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: "/work/api", scriptName: "fetch users.ts" }),
    );
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/transform && bun test test/working-directory.test.ts`
Expected: FAIL: `"./a"` is not rewritten, and `workingDirectory` is ignored.

- [ ] **Step 3: Implement the transform plugin**

`packages/transform/src/types.ts`: add before `TransformOptions`:

```ts
/** A tab's working directory (spec §5.3): `dir` is the WD, `filename` is `<WD>/<script name>`. */
export interface WorkingDirectoryOptions {
  dir: string;
  filename: string;
}
```

and add `workingDirectory?: WorkingDirectoryOptions;` as the last member of `TransformOptions`.

`packages/transform/src/working-directory.ts`:

```ts
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkingDirectoryOptions } from "./types";

// biome-ignore lint/suspicious/noExplicitAny: Babel plugin API
type Any = any;

/** Spec §5.3: relative specifiers and the WD globals resolve against the tab's working directory. */
export function createWorkingDirectoryPlugin(wd: WorkingDirectoryOptions) {
  const rewrite = (value: string) => (value.startsWith("./") || value.startsWith("../") ? resolve(wd.dir, value) : value);
  const metaValues: Record<string, string> = {
    dir: wd.dir,
    dirname: wd.dir,
    path: wd.filename,
    filename: wd.filename,
    url: pathToFileURL(wd.filename).href,
  };
  return (api: Any) => {
    const t = api.types;
    const rewriteSource = (node: Any) => {
      if (node?.type === "StringLiteral") node.value = rewrite(node.value);
    };
    const isFree = (path: Any, name: string) => !path.scope.hasBinding(name, { noGlobals: true });
    const isAssignmentTarget = (path: Any) =>
      (path.parentPath?.isAssignmentExpression() && path.parent.left === path.node) || path.parentPath?.isUpdateExpression();
    return {
      name: "jslab-working-directory",
      visitor: {
        ImportDeclaration(path: Any) {
          rewriteSource(path.node.source);
        },
        ExportNamedDeclaration(path: Any) {
          rewriteSource(path.node.source);
        },
        ExportAllDeclaration(path: Any) {
          rewriteSource(path.node.source);
        },
        ImportExpression(path: Any) {
          rewriteSource(path.node.source);
        },
        CallExpression(path: Any) {
          const { callee } = path.node;
          const first = path.node.arguments[0];
          if (callee.type === "Import") return rewriteSource(first);
          if (callee.type === "Identifier" && callee.name === "require" && isFree(path, "require")) return rewriteSource(first);
          if (
            callee.type === "MemberExpression" &&
            !callee.computed &&
            callee.object.type === "Identifier" &&
            callee.object.name === "require" &&
            callee.property.type === "Identifier" &&
            callee.property.name === "resolve" &&
            isFree(path, "require")
          ) {
            rewriteSource(first);
          }
        },
        Identifier(path: Any) {
          const { name } = path.node;
          if (name !== "__dirname" && name !== "__filename") return;
          if (!path.isReferencedIdentifier() || isAssignmentTarget(path) || !isFree(path, name)) return;
          path.replaceWith(t.stringLiteral(name === "__dirname" ? wd.dir : wd.filename));
        },
        MemberExpression(path: Any) {
          const { object, property, computed } = path.node;
          if (computed || property.type !== "Identifier" || isAssignmentTarget(path)) return;
          if (object.type === "MetaProperty" && object.meta.name === "import" && object.property.name === "meta") {
            const value = metaValues[property.name];
            if (value !== undefined) path.replaceWith(t.stringLiteral(value));
            return;
          }
          if (object.type === "Identifier" && object.name === "module" && isFree(path, "module")) {
            if (property.name === "filename") path.replaceWith(t.stringLiteral(wd.filename));
            else if (property.name === "path") path.replaceWith(t.stringLiteral(wd.dir));
          }
        },
      },
    };
  };
}
```

`packages/transform/src/transform.ts`: add `import { createWorkingDirectoryPlugin } from "./working-directory";` and change the `plugins:` line to:

```ts
      plugins: [
        createInstrumentPlugin(options, source, diagnostics),
        ...proposalPlugins(options.build ?? DEFAULT_BUILD_OPTIONS),
        ...(options.workingDirectory ? [createWorkingDirectoryPlugin(options.workingDirectory)] : []),
      ],
```

Add `export { createWorkingDirectoryPlugin } from "./working-directory";` to `packages/transform/src/index.ts`.

- [ ] **Step 4: Implement `scriptFileName`, the coordinator and `run.start`**

`packages/shared/src/tabs.ts`, append:

```ts
/**
 * The base name `__filename` reports when a tab has a working directory (spec §5.3): a saved file's own name, else the
 * tab title (with `/`, `:` and `\` replaced) plus the language extension.
 */
export function scriptFileName(
  tab: Pick<TabState, "title" | "titleIsCustom" | "filePath" | "language">,
  code: string,
): string {
  if (tab.filePath) return baseName(tab.filePath);
  const title = deriveTitle(tab, code).replace(/[/:\\]/g, "-").replace(/…$/, "").trim() || "Untitled";
  return `${title.replace(/\.(?:[mc]?[jt]sx?)$/i, "")}.${extensionFor(tab.language)}`;
}
```

`apps/desktop/src/main/strings.ts`: add a top-level section:

```ts
  runs: {
    /** Spec §12.2. */
    workingDirectoryNotFound: (path: string) => `Working directory not found: ${path}`,
  },
```

`apps/desktop/src/main/runs/run-coordinator.ts`:

1. Add `import { stat } from "node:fs/promises";` (merge with the existing `node:fs/promises` import) and `import { strings } from "../strings";`.
2. Add to `RunStartRequest`:

```ts
  /** The tab's working directory, or null (spec §5.3). */
  workingDirectory?: string | null;
  /** `__filename`'s base name (scriptFileName). */
  scriptName?: string;
```

3. Add to `RunCoordinatorDeps`: `directoryExists?(path: string): Promise<boolean>;`
4. After `const UI_BATCH_EVENTS = 200;` add:

```ts
/** The error name of a run whose working directory is gone; the UI offers Change… for it (spec §12.2). */
export const WORKING_DIRECTORY_ERROR = "WorkingDirectoryError";

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
```

5. In `#execute`, as the first statements inside `try {`, insert:

```ts
      const workingDirectory = request.workingDirectory ?? null;
      if (workingDirectory && !(await (this.deps.directoryExists ?? directoryExists)(workingDirectory))) {
        if (!this.#isCurrent(run)) return;
        this.deps.onEvents(run.tabId, run.runId, [
          {
            kind: "error",
            phase: "runner",
            name: WORKING_DIRECTORY_ERROR,
            message: strings.runs.workingDirectoryNotFound(workingDirectory),
            stack: [],
            seq: 1,
            t: Date.now(),
          },
        ]);
        this.#setState(run, "failed");
        return;
      }
```

6. In the transform options object, after the `build` spread added in Task 15, add:

```ts
        ...(workingDirectory
          ? { workingDirectory: { dir: workingDirectory, filename: join(workingDirectory, request.scriptName ?? "Untitled.ts") } }
          : {}),
```

`apps/desktop/src/main/rpc-handlers.ts`:

1. Change `import type { KeybindingRule } from "@jslab/shared";` to `import { type KeybindingRule, scriptFileName } from "@jslab/shared";`.
2. Replace the last line of the `run.start` handler, `return deps.coordinator.start({ tabId, code, language, logpoints });`, with:

```ts
        const tab = deps.session.session.tabs[tabId];
        return deps.coordinator.start({
          tabId,
          code,
          language,
          logpoints,
          workingDirectory: tab?.workingDirectory ?? null,
          scriptName: tab ? scriptFileName(tab, code) : "Untitled.ts",
        });
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/transform && bun test && builtin cd ../shared && bun test && builtin cd ../../apps/desktop && bun test test/runs/working-directory.test.ts test/rpc-handlers.test.ts test/runs/run-coordinator.test.ts`
Expected: PASS, 0 fail.

**Planned stop (R-M1-17(d)):** if only `a file created in the WD after the spare started imports` fails, don't change the test. Stop and report `Bun.version`, the error event text, and whether the same run succeeds once the spare is recycled (`spares.invalidate("t1")` before `start`). The controller rules (R-M3-WD-1) between: the coordinator recycling the tab's spare when the WD has entries newer than the spare, or rewriting relative specifiers to `file://…?t=<runId>` URLs.

- [ ] **Step 6: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/shared` M2 final + 8; `@jslab/transform` M2 final + 11; `@jslab/desktop` M2 final + 33.

- [ ] **Step 7: Commit**

```bash
git add packages/transform packages/shared apps/desktop/src/main apps/desktop/test
git commit -m "feat(runs): resolve relative imports and wd globals against the tab's working directory" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 17: Runner exit semantics after a caught `process.exit` (FW1-exit-trycatch)

**Files:**
- Modify: `packages/rpc-schema/src/runner-ipc.ts:58-63` (`RunnerToMain`)
- Modify: `packages/runner-bun/src/bootstrap.ts:76-83` (tracker callback), `:187-202` (`process.exit`)
- Modify: `apps/desktop/src/main/runs/run-coordinator.ts:38-52` (`ActiveRun`), `:23-36` (deps), `:239-300` (messages, exit)
- Create: `apps/desktop/test/runs/fixtures/exit-requested-hang-runner.ts`
- Test: `packages/runner-bun/test/bootstrap.test.ts` (append), `apps/desktop/test/runs/exit-semantics.test.ts`

**Interfaces:**
- Consumes: `EXIT_SIGNAL`, `exiting`, `tracker`, `EventBuffer.close` (`bootstrap.ts`).
- Produces:
  - `RunnerToMain` gains `{ type: "exitRequested"; runId: string; code: number }`.
  - `RunCoordinatorDeps.exitGraceMs?: number`; `EXIT_KILL_GRACE_MS = 2500`.

**Rules (carry R-M2-FINAL-5; spec §5.8, §5.11):** decided runner semantics after user code calls `process.exit`, even inside a `try/catch`:
1. Output after the call is dropped (the run's buffer is already closed).
2. Handles (timers, servers, sockets) created after the call are disposed at once.
3. The runner sends `exitRequested` before draining IPC and exits once the drain callback fires, or at most 2 s later (unchanged).
4. If user code blocks the event loop so the runner can't exit, Main kills the runner's process group 2.5 s after `exitRequested`. It reports the requested exit code as if the process had exited with it: code 0 ends the run `idle`; a non-zero code reports `Runtime exited unexpectedly (code N)`. Main ignores `events` that arrive after `exitRequested`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/runner-bun/test/bootstrap.test.ts`:

```ts
test("a caught process.exit ends the run: no later output, later timers are disposed, and the runner exits (FW1)", async () => {
  const runner = startRunner();
  await runner.run('try { process.exit(0) } catch {}\nconsole.log("after exit");\nsetInterval(() => console.log("tick"), 5);\nexport {};\n');
  // The runner's own drain fallback is 2 s; 4 s leaves margin on a loaded machine.
  const exited = await Promise.race([runner.proc.exited.then(() => true), Bun.sleep(4000).then(() => false)]);
  expect(exited).toBe(true);
  expect(runner.messages.find((m) => m.type === "exitRequested")).toMatchObject({ runId: "run-1", code: 0 });
  const texts = runner.events().flatMap((event) => (event.kind === "console" ? event.args.map((arg) => String((arg as { v?: unknown }).v)) : []));
  expect(texts).not.toContain("after exit");
  expect(texts).not.toContain("tick");
}, 10_000);
```

`apps/desktop/test/runs/fixtures/exit-requested-hang-runner.ts`:

```ts
// A stand-in runner whose user code called process.exit but never lets the process exit (a caught exit followed by
// code that keeps the runner alive). Main must end it after the exit grace period and report the requested code.
import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";

const send = (message: RunnerToMain) => process.send?.(message);

process.on("message", (message: MainToRunner) => {
  if (message.type !== "run") return;
  send({ type: "state", runId: message.runId, state: "evaluating", activeHandles: 0 });
  send({ type: "exitRequested", runId: message.runId, code: 0 });
  send({
    type: "events",
    runId: message.runId,
    events: [{ kind: "stdout", text: "ignored after exit", seq: 1, t: Date.now() }],
  });
});
send({ type: "ready", bunVersion: Bun.version });
setInterval(() => send({ type: "heartbeat" }), 50);
```

`apps/desktop/test/runs/exit-semantics.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunState } from "@jslab/rpc-schema";
import { transform } from "@jslab/transform";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { RunCoordinator } from "../../src/main/runs/run-coordinator";
import { SparePool } from "../../src/main/runs/spare-pool";

const FIXTURE = join(import.meta.dir, "fixtures", "exit-requested-hang-runner.ts");
let dir = "";
let coordinator: RunCoordinator | null = null;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-exit-"));
});
afterEach(async () => {
  coordinator?.dispose();
  coordinator = null;
  await rm(dir, { recursive: true, force: true });
});

test("a runner that requested exit but hangs is killed after the grace period and ends as its requested code (FW1)", async () => {
  const events: RunEvent[] = [];
  const states: RunState[] = [];
  // Every runner the pool starts: the first runs the code, and the pool pre-warms another one after the take.
  const runners: BunRunnerProcess[] = [];
  coordinator = new RunCoordinator({
    transform: async (source, options) => transform(source, options),
    spares: new SparePool(
      async (config) => {
        const runner = await BunRunnerProcess.start(config);
        runners.push(runner);
        return runner;
      },
      () => ({ bunPath: process.execPath, bootstrapPath: FIXTURE, cwd: dir, env: { PATH: process.env.PATH ?? "" } }),
    ),
    runsDir: join(dir, "runs"),
    settings: () => ({ autoLog: true, loopProtection: true, loopProtectionMaxIterations: 2000, maxEntries: 100, unresponsiveTimeoutMs: 5000 }),
    onEvents: (_tabId, _runId, batch) => events.push(...batch),
    onState: (_tabId, _runId, state) => states.push(state),
    onDiagnostics: () => {},
    runLock: { add: () => {}, remove: () => {} },
    exitGraceMs: 150,
  });
  coordinator.start({ tabId: "t1", code: "1", language: "typescript", logpoints: [] });
  const started = Date.now();
  while (!states.includes("idle") && Date.now() - started < 5000) await Bun.sleep(20);
  expect(states).toContain("idle");
  expect(events.filter((event) => event.kind === "error" || event.kind === "stdout")).toEqual([]);
  expect(runners[0]?.signalCode).toBe("SIGKILL");
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/runner-bun && bun test test/bootstrap.test.ts && builtin cd ../../apps/desktop && bun test test/runs/exit-semantics.test.ts`
Expected: FAIL. No `exitRequested` message exists; the coordinator never reaches `idle`.

- [ ] **Step 2: Implement**

`packages/rpc-schema/src/runner-ipc.ts`: add to the `RunnerToMain` union:

```ts
  /** User code called process.exit (FW1): later output is ignored, and Main ends the runner if it doesn't exit. */
  | { type: "exitRequested"; runId: string; code: number }
```

`packages/runner-bun/src/bootstrap.ts`:

1. Replace the tracker callback body (lines 77-82) with:

```ts
  if (!run) return;
  // Untracked continuations (an awaited Bun.sleep, an un-awaited promise) can resume after Stop and create new
  // handles: dispose them at once so stopped user code can't keep timers, servers or sockets alive. The same applies
  // after a caught process.exit (FW1).
  if ((run.state === "stopped" || exiting) && count > 0) tracker.disposeAll();
  else if (run.state === "settled" && count === 0) setState("idle");
  else if (run.state === "idle" && count > 0) setState("settled");
```

2. In the user-facing `process.exit`, directly after `tracker.disposeAll();` insert:

```ts
  const numericCode = Number(exitCode ?? 0);
  send({ type: "exitRequested", runId: run?.runId ?? "", code: Number.isInteger(numericCode) ? numericCode : 1 });
```

`apps/desktop/src/main/runs/run-coordinator.ts`:

1. Add to `ActiveRun`: `exitTimer?: ReturnType<typeof setTimeout>;` and `exitRequestedCode?: number;`.
2. Add to `RunCoordinatorDeps`: `exitGraceMs?: number;`.
3. After `WORKING_DIRECTORY_ERROR`, add:

```ts
/** How long Main waits after exitRequested before ending a runner that didn't exit (the runner's own drain is 2 s). */
export const EXIT_KILL_GRACE_MS = 2500;
```

4. In `#onRunnerMessage`, add this case to the `switch`, before `case "heartbeat":`:

```ts
      case "exitRequested":
        run.exitRequestedCode = message.code;
        clearTimeout(run.exitTimer);
        run.exitTimer = setTimeout(() => run.runner?.kill(), this.deps.exitGraceMs ?? EXIT_KILL_GRACE_MS);
        return;
```

5. In `case "events":`, change the guard to `if (run.state === "stopped" || run.state === "killed" || run.exitRequestedCode !== undefined) return;`.
6. Replace the start of `#onRunnerExit(run, code, signal = null)` with:

```ts
  #onRunnerExit(run: ActiveRun, exitCode: number | null, exitSignal: string | null = null): void {
    clearTimeout(run.stopTimer);
    clearTimeout(run.idleTimer);
    clearTimeout(run.exitTimer);
    // FW1: a runner Main ended after exitRequested reports the code user code asked for.
    const endedAfterExit = run.exitRequestedCode !== undefined && exitSignal === "SIGKILL";
    const code = endedAfterExit ? (run.exitRequestedCode as number) : exitCode;
    const signal = endedAfterExit ? null : exitSignal;
```

and keep the rest of the method unchanged (it uses `code` and `signal`).

7. In `#supersede`, add `clearTimeout(previous.exitTimer);` after `clearTimeout(previous.idleTimer);`.

- [ ] **Step 3: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/runner-bun && bun test && builtin cd ../../apps/desktop && bun test test/runs`
Expected: PASS, 0 fail.

- [ ] **Step 4: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/runner-bun` M2 final + 1; `@jslab/desktop` M2 final + 34.

- [ ] **Step 5: Commit**

```bash
git add packages/rpc-schema/src/runner-ipc.ts packages/runner-bun apps/desktop/src/main/runs/run-coordinator.ts apps/desktop/test/runs
git commit -m "fix(runs): end a run cleanly after a caught process.exit" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 18: Main RPC handlers and composition for npm, env, WD, types and `.npmrc`

**Files:**
- Create: `apps/desktop/src/main/rpc/npm-handlers.ts`, `rpc/env-handlers.ts`, `rpc/wd-handlers.ts`, `rpc/types-handlers.ts`, `rpc/npmrc-handlers.ts`
- Modify: `packages/rpc-schema/src/ui-rpc.ts:122-126` (`SettingsWindowRequests`), `:232-279` (`MainRequests`, `MainMessages`, `ViewMessages`)
- Modify: `apps/ui/src/view-messages.ts:4-17` (`VIEW_MESSAGES`)
- Modify: `apps/desktop/src/main/services/session-store.ts` (add `setWorkingDirectory`), `apps/desktop/src/main/services/npm-service.ts` (add `resetOutdated`)
- Modify: `apps/desktop/src/main/main-services.ts` (build `NpmService`, `TypesService`), `apps/desktop/src/main/index.ts` (`createRedactor`, `createMainServices`, both `mergeHandlers` calls)
- Test: `apps/desktop/test/rpc/npm-handlers.test.ts`, `rpc/env-handlers.test.ts`, `rpc/wd-handlers.test.ts`, `rpc/types-handlers.test.ts`, `rpc/npmrc-handlers.test.ts`, `apps/desktop/test/main-services.test.ts` (append)

**Interfaces:**
- Consumes: Tasks 4, 5, 11–14; `createValidators`, `mergeHandlers`, `tabParamsSchema`, `emptyParamsSchema`; `readE2EOpenDialog`; `Utils.openFileDialog` (as used at `index.ts:263-269`).
- Produces:
  - RPC contracts: `MainRequests` gains `"npm.list"`, `"npm.search"`, `"types.package"` (`{ packages: PackageTypesResult[] }`), `"types.local"`, `"env.get"` (`{ variables: EnvVars }`), `"env.save"` (`SaveResult`). `MainMessages` gains `"npm.install"`, `"npm.remove"`, `"npm.update"`, `"npm.updateAll"`, `"wd.pick"`, `"wd.clear"`. `ViewMessages` gains `"npm.op": NpmOperation`, `"npm.log": { opId: string; text: string }`, `"npm.changed": NpmListResult`, `"wd.changed": { tabId: string; tab: TabState }`. `SettingsWindowRequests` gains `"npmrc.get"` (`{ content }`), `"npmrc.save"` (`SaveResult`), `"npmrc.reset"` (`{ content }`).
  - Handler factories: `createNpmHandlers({ npm, log })`, `createEnvHandlers({ env, log })`, `createWorkingDirectoryHandlers({ session, pickFolder, isDirectory, documentsDir, spares, types, send, log })`, `createTypesHandlers({ types, log })`, `createNpmrcHandlers({ path, write?, onSaved, log })`
  - `SessionStore.setWorkingDirectory(tabId: string, workingDirectory: string | null): TabState | null`
  - `NpmService.resetOutdated(): void`
  - `MainServicesOptions` gains `realHome: string`, `bunCacheDirOverride?: string`, `npmSpawn?: NpmSpawn`, `npmFetch?: typeof fetch`, `onNpmOperation(op: NpmOperation): void`, `onNpmLog(opId: string, text: string): void`, `onNpmChanged(list: NpmListResult): void`. `MainServices` gains `npm: NpmService`, `types: TypesService`.

**Rules (spec §4.3, §6.2, §11, §12, §18):**
- Every payload is validated with its Task 5 schema. An invalid request throws `InvalidPayloadError`; an invalid message is logged and dropped. Logs never include `.npmrc` content or env values.
- `wd.pick` opens a folder picker through the message + result-message pattern. The picker starts in the tab's WD if it still exists, else the last directory, else Documents. A picked folder that isn't a directory is ignored. `wd.clear` clears.
  - On any change: the tab's spare is invalidated, the active tab is re-warmed, the types cache is invalidated, and `wd.changed` is sent.
  - Under E2E the picker reads `e2e-open-dialog.json` (first path).
- After a successful npm change: `spares.invalidateAll()`, `types.invalidate()` (web vendor caches arrive in M4), then `npm.changed`.
- `npmrc.save` writes with mode 0600 and a trailing newline; `npmrc.reset` writes `DEFAULT_NPMRC`. Both reset the outdated cache.
- The log redactor masks `env.json` values (four or more characters) from now on.
- E2E: `JSLAB_E2E_BUN_CACHE_DIR` (read only when `JSLAB_E2E=1`) replaces the user's Bun cache for npm operations.

- [ ] **Step 1: Write the failing handler tests**

`apps/desktop/test/rpc/npm-handlers.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createNpmHandlers } from "../../src/main/rpc/npm-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

function setup() {
  const op = { id: "op1", kind: "install", target: "", status: "queued", error: null, notice: null } as const;
  const npm = {
    install: mock((_spec: string) => op),
    remove: mock((_name: string) => op),
    update: mock((_name: string) => op),
    updateAll: mock(() => op),
    list: mock(async (_options: { refreshOutdated: boolean }) => ({ installed: [], outdatedCheckedAt: null, outdatedError: null })),
    search: mock(async (_query: string) => ({ results: [], error: null })),
  };
  const log = mock((_message: string, _detail?: unknown) => {});
  return { npm, log, handlers: createNpmHandlers({ npm, log }) };
}

describe("npm handlers (spec §11)", () => {
  test("requests validate and delegate", async () => {
    const { handlers, npm } = setup();
    expect(await handlers.requests["npm.list"]({ refreshOutdated: true })).toEqual({ installed: [], outdatedCheckedAt: null, outdatedError: null });
    expect(npm.list).toHaveBeenCalledWith({ refreshOutdated: true });
    await handlers.requests["npm.search"]({ query: " zod " });
    expect(npm.search).toHaveBeenCalledWith("zod");
    expect(() => handlers.requests["npm.search"]({ query: "" })).toThrow(InvalidPayloadError);
  });

  test("messages validate specs and names, and a flag-like spec never reaches bun", () => {
    const { handlers, npm, log } = setup();
    handlers.messages["npm.install"]({ spec: "zod@4.6.4" });
    handlers.messages["npm.install"]({ spec: "--registry=http://evil" });
    handlers.messages["npm.remove"]({ name: "zod" });
    handlers.messages["npm.update"]({ name: "Zod" });
    handlers.messages["npm.updateAll"]({});
    expect(npm.install.mock.calls).toEqual([["zod@4.6.4"]]);
    expect(npm.remove.mock.calls).toEqual([["zod"]]);
    expect(npm.update).not.toHaveBeenCalled();
    expect(npm.updateAll).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.map((call) => call[0])).toEqual(["Rejected invalid npm.install payload", "Rejected invalid npm.update payload"]);
  });
});
```

`apps/desktop/test/rpc/env-handlers.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createEnvHandlers } from "../../src/main/rpc/env-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

describe("env handlers (spec §12.1)", () => {
  test("env.get returns the variables and env.save saves valid ones", async () => {
    let variables: Record<string, string> = { A: "1" };
    const env = {
      get variables() {
        return variables;
      },
      save: mock(async (next: Record<string, string>) => {
        variables = next;
        return next;
      }),
    };
    const handlers = createEnvHandlers({ env, log: () => {} });
    expect(handlers.requests["env.get"]({})).toEqual({ variables: { A: "1" } });
    expect(await handlers.requests["env.save"]({ variables: { TOKEN: "s3cr3t" } })).toEqual({ ok: true });
    expect(variables).toEqual({ TOKEN: "s3cr3t" });
  });

  test("invalid keys are rejected before the store, a failed write is reported, and values never reach the log", async () => {
    const logged: string[] = [];
    const env = {
      variables: {},
      save: mock(async () => {
        throw new Error("EACCES: permission denied");
      }),
    };
    const handlers = createEnvHandlers({ env, log: (message, detail) => void logged.push(`${message} ${String(detail)}`) });
    expect(() => handlers.requests["env.save"]({ variables: { "1BAD": "hunter2-secret" } })).toThrow(InvalidPayloadError);
    expect(env.save).not.toHaveBeenCalled();
    expect(await handlers.requests["env.save"]({ variables: { A: "hunter2-secret" } })).toEqual({ ok: false, error: "EACCES: permission denied" });
    expect(logged.join("\n")).not.toContain("hunter2-secret");
  });
});
```

`apps/desktop/test/rpc/wd-handlers.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, type TabState } from "@jslab/shared";
import { createWorkingDirectoryHandlers } from "../../src/main/rpc/wd-handlers";

function setup(options: { picked?: string | null; directories?: string[] } = {}) {
  const session = defaultSession(() => createTab({ id: "t1" }));
  const changed: { tabId: string; tab: TabState }[] = [];
  const calls: string[] = [];
  const deps = {
    session: {
      session,
      setWorkingDirectory: mock((tabId: string, path: string | null) => {
        const tab = session.tabs[tabId];
        if (!tab) return null;
        const next = { ...tab, workingDirectory: path };
        session.tabs[tabId] = next;
        return next;
      }),
    },
    pickFolder: mock(async (_options: { startingFolder: string }) => options.picked ?? null),
    isDirectory: async (path: string) => (options.directories ?? []).includes(path),
    documentsDir: "/docs",
    spares: {
      invalidate: mock((tabId: string) => void calls.push(`invalidate:${tabId}`)),
      setActiveTab: mock((tabId: string) => void calls.push(`warm:${tabId}`)),
    },
    types: { invalidate: mock(() => void calls.push("types")) },
    send: { changed: (payload: { tabId: string; tab: TabState }) => void changed.push(payload) },
    log: mock(() => {}),
  };
  return { deps, changed, calls, session, handlers: createWorkingDirectoryHandlers(deps) };
}

const settle = () => Bun.sleep(5);

describe("working directory handlers (spec §12.2)", () => {
  test("wd.pick sets a picked folder, recycles the tab's spare, invalidates types and reports the tab", async () => {
    const { handlers, deps, changed, calls } = setup({ picked: "/work/api", directories: ["/work/api"] });
    handlers.messages["wd.pick"]({ tabId: "t1" });
    await settle();
    expect(deps.pickFolder).toHaveBeenCalledWith({ startingFolder: "/docs" });
    expect(changed.map((entry) => [entry.tabId, entry.tab.workingDirectory])).toEqual([["t1", "/work/api"]]);
    expect(calls).toEqual(["invalidate:t1", "warm:t1", "types"]);
  });

  test("the picker starts in the tab's existing WD; a cancelled or non-directory pick changes nothing", async () => {
    const { handlers, deps, changed, session } = setup({ picked: "/not-a-dir", directories: ["/work/api"] });
    (session.tabs.t1 as TabState).workingDirectory = "/work/api";
    handlers.messages["wd.pick"]({ tabId: "t1" });
    await settle();
    expect(deps.pickFolder).toHaveBeenCalledWith({ startingFolder: "/work/api" });
    expect(deps.session.setWorkingDirectory).not.toHaveBeenCalled();
    expect(changed).toEqual([]);
    handlers.messages["wd.pick"]({ tabId: "../x" });
    await settle();
    expect(deps.pickFolder).toHaveBeenCalledTimes(1);
  });

  test("wd.clear clears the WD and reports it", async () => {
    const { handlers, changed, session } = setup();
    (session.tabs.t1 as TabState).workingDirectory = "/work/api";
    handlers.messages["wd.clear"]({ tabId: "t1" });
    await settle();
    expect(changed.map((entry) => entry.tab.workingDirectory)).toEqual([null]);
  });
});
```

`apps/desktop/test/rpc/types-handlers.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createTypesHandlers } from "../../src/main/rpc/types-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

describe("types handlers (spec §6.2)", () => {
  test("validates package and local type requests and delegates", async () => {
    const types = {
      packages: mock(async (_tabId: string, names: readonly string[]) =>
        names.map((name) => ({ name, files: [], dependencies: [], typesPackage: null, hasTypes: false, truncated: false })),
      ),
      local: mock(async () => ({ files: [], packages: [], truncated: false })),
    };
    const handlers = createTypesHandlers({ types, log: () => {} });
    expect((await handlers.requests["types.package"]({ tabId: "t1", packages: ["zod"] })).packages.map((p) => p.name)).toEqual(["zod"]);
    expect(await handlers.requests["types.local"]({ tabId: "t1", specifiers: ["./util"] })).toEqual({ files: [], packages: [], truncated: false });
    expect(() => handlers.requests["types.local"]({ tabId: "t1", specifiers: ["/etc/passwd"] })).toThrow(InvalidPayloadError);
    expect(types.local).toHaveBeenCalledTimes(1);
  });
});
```

`apps/desktop/test/rpc/npmrc-handlers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_NPMRC } from "@jslab/shared";
import { createNpmrcHandlers } from "../../src/main/rpc/npmrc-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-npmrc-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe(".npmrc handlers (spec §11.5)", () => {
  test("get reads the file or the default, save writes 0600 with a trailing newline, reset restores the default", async () => {
    const path = join(dir, ".npmrc");
    const onSaved = mock(() => {});
    const handlers = createNpmrcHandlers({ path, onSaved, log: () => {} });
    expect(await handlers.requests["npmrc.get"]({})).toEqual({ content: DEFAULT_NPMRC });
    expect(await handlers.requests["npmrc.save"]({ content: "registry=http://127.0.0.1:4873/" })).toEqual({ ok: true });
    expect(await readFile(path, "utf8")).toBe("registry=http://127.0.0.1:4873/\n");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await handlers.requests["npmrc.get"]({})).toEqual({ content: "registry=http://127.0.0.1:4873/\n" });
    expect(await handlers.requests["npmrc.reset"]({})).toEqual({ content: DEFAULT_NPMRC });
    expect(await readFile(path, "utf8")).toBe(DEFAULT_NPMRC);
    expect(onSaved).toHaveBeenCalledTimes(2);
  });

  test("oversized content is rejected, and a failed write is reported without the content", async () => {
    const logged: string[] = [];
    const handlers = createNpmrcHandlers({
      path: join(dir, ".npmrc"),
      write: async () => {
        throw new Error("EROFS: read-only file system");
      },
      onSaved: () => {},
      log: (message, detail) => void logged.push(`${message} ${String(detail)}`),
    });
    expect(() => handlers.requests["npmrc.save"]({ content: "x".repeat(70_000) })).toThrow(InvalidPayloadError);
    expect(await handlers.requests["npmrc.save"]({ content: "//r/:_authToken=npm_secret_token" })).toEqual({
      ok: false,
      error: "EROFS: read-only file system",
    });
    expect(logged.join("\n")).not.toContain("npm_secret_token");
  });
});
```

Append to `apps/desktop/test/main-services.test.ts` (inside its `describe`; this needs the Task 18 options, so update the existing `createMainServices` call too — see Step 3):

```ts
  test("npm and types services are composed; saving env.json recycles spares", async () => {
    const paths = resolveAppPaths({ resourcesFolder: join(dir, "Resources"), userData: dir, execPath: process.execPath, env: {} });
    const started: string[] = [];
    services = await createMainServices({
      paths,
      env: {},
      shiftHeld: Promise.resolve(false),
      realHome: join(dir, "home"),
      onEvents: () => {},
      onState: () => {},
      onDiagnostics: () => {},
      onNpmOperation: () => {},
      onNpmLog: () => {},
      onNpmChanged: () => {},
      startRunner: (config) => {
        started.push(config.cwd);
        return Promise.reject(new Error("no runners in this test"));
      },
      transformHost: { transform: () => Promise.reject(new Error("no transforms")), dispose: () => {} },
    });
    expect((await services.npm.list({ refreshOutdated: false })).installed).toEqual([]);
    expect(await services.types.local(services.session.session.activeTabId, ["./x"])).toEqual({ files: [], packages: [], truncated: false });
    services.spares.setActiveTab(services.session.session.activeTabId);
    await Bun.sleep(0);
    const before = started.length;
    await services.env.save({ A: "1" });
    await Bun.sleep(0);
    expect(started.length).toBe(before + 1);
  });
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/rpc test/main-services.test.ts`
Expected: FAIL, `Cannot find module "../../src/main/rpc/npm-handlers"` (and the other new modules).

- [ ] **Step 2: Add the RPC contracts and view messages**

In `packages/rpc-schema/src/ui-rpc.ts`:

1. Add to `SettingsWindowRequests`:

```ts
  "npmrc.get": { params: Record<string, never>; response: { content: string } };
  "npmrc.save": { params: { content: string }; response: SaveResult };
  "npmrc.reset": { params: Record<string, never>; response: { content: string } };
```

2. Add to `MainRequests`:

```ts
  "npm.list": { params: { refreshOutdated: boolean }; response: NpmListResult };
  "npm.search": { params: { query: string }; response: NpmSearchResponse };
  "types.package": { params: { tabId: string; packages: string[] }; response: { packages: PackageTypesResult[] } };
  "types.local": { params: { tabId: string; specifiers: string[] }; response: LocalTypesResult };
  "env.get": { params: Record<string, never>; response: { variables: EnvVars } };
  "env.save": { params: { variables: EnvVars }; response: SaveResult };
```

3. Add to `MainMessages`:

```ts
  "npm.install": { spec: string };
  "npm.remove": { name: string };
  "npm.update": { name: string };
  "npm.updateAll": Record<string, never>;
  "wd.pick": TabParams;
  "wd.clear": TabParams;
```

4. Add to `ViewMessages`:

```ts
  "npm.op": NpmOperation;
  "npm.log": { opId: string; text: string };
  "npm.changed": NpmListResult;
  "wd.changed": { tabId: string; tab: TabState };
```

In `apps/ui/src/view-messages.ts`, add `"npm.op"`, `"npm.log"`, `"npm.changed"` and `"wd.changed"` to `VIEW_MESSAGES` after `"app.notice"`.

- [ ] **Step 3: Implement the handlers, store and service changes, and the composition**

`apps/desktop/src/main/rpc/npm-handlers.ts`:

```ts
import {
  emptyParamsSchema,
  type NpmListResult,
  type NpmSearchResponse,
  npmInstallParamsSchema,
  npmListParamsSchema,
  npmNameParamsSchema,
  npmSearchParamsSchema,
} from "@jslab/rpc-schema";
import type { NpmService } from "../services/npm-service";
import { createValidators, type Log } from "./validate";

export interface NpmHandlerDeps {
  npm: Pick<NpmService, "install" | "remove" | "update" | "updateAll" | "list" | "search">;
  log: Log;
}

/** The NPM sheet (spec §11.2): long operations are messages; results arrive as npm.op, npm.log and npm.changed. */
export function createNpmHandlers(deps: NpmHandlerDeps) {
  const { parse, message } = createValidators(deps.log);
  return {
    requests: {
      "npm.list": (input: unknown): Promise<NpmListResult> =>
        deps.npm.list({ refreshOutdated: parse(npmListParamsSchema, "npm.list", input).refreshOutdated }),
      "npm.search": (input: unknown): Promise<NpmSearchResponse> =>
        deps.npm.search(parse(npmSearchParamsSchema, "npm.search", input).query),
    },
    messages: {
      "npm.install": message(npmInstallParamsSchema, "npm.install", ({ spec }) => void deps.npm.install(spec)),
      "npm.remove": message(npmNameParamsSchema, "npm.remove", ({ name }) => void deps.npm.remove(name)),
      "npm.update": message(npmNameParamsSchema, "npm.update", ({ name }) => void deps.npm.update(name)),
      "npm.updateAll": message(emptyParamsSchema, "npm.updateAll", () => void deps.npm.updateAll()),
    },
  };
}
```

`apps/desktop/src/main/rpc/env-handlers.ts`:

```ts
import { type EnvVars, emptyParamsSchema, envSaveParamsSchema, type SaveResult } from "@jslab/rpc-schema";
import type { EnvStore } from "../services/env-store";
import { createValidators, type Log } from "./validate";

export interface EnvHandlerDeps {
  env: Pick<EnvStore, "variables" | "save">;
  log: Log;
}

/** Tools → Environment Variables… (spec §12.1). Values are never logged. */
export function createEnvHandlers(deps: EnvHandlerDeps) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      "env.get": (input: unknown): { variables: EnvVars } => {
        parse(emptyParamsSchema, "env.get", input);
        return { variables: deps.env.variables };
      },
      "env.save": (input: unknown): Promise<SaveResult> => {
        const { variables } = parse(envSaveParamsSchema, "env.save", input);
        return deps.env.save(variables).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        );
      },
    },
    messages: {},
  };
}
```

`apps/desktop/src/main/rpc/wd-handlers.ts`:

```ts
import { tabParamsSchema } from "@jslab/rpc-schema";
import type { TabState } from "@jslab/shared";
import type { SparePool } from "../runs/spare-pool";
import type { SessionStore } from "../services/session-store";
import type { TypesService } from "../services/types-service";
import { createValidators, type Log } from "./validate";

export interface WorkingDirectoryHandlerDeps {
  session: Pick<SessionStore, "session" | "setWorkingDirectory">;
  /** The native folder picker (or the E2E stub); resolves the chosen folder or null. */
  pickFolder(options: { startingFolder: string }): Promise<string | null>;
  isDirectory(path: string): Promise<boolean>;
  documentsDir: string;
  spares: Pick<SparePool, "invalidate" | "setActiveTab">;
  types: Pick<TypesService, "invalidate">;
  send: { changed(payload: { tabId: string; tab: TabState }): void };
  log: Log;
}

/** Actions → Set/Clear Working Directory and the WD chip (spec §12.2). */
export function createWorkingDirectoryHandlers(deps: WorkingDirectoryHandlerDeps) {
  const { message } = createValidators(deps.log);

  const apply = (tabId: string, workingDirectory: string | null) => {
    const tab = deps.session.setWorkingDirectory(tabId, workingDirectory);
    if (!tab) return;
    deps.spares.invalidate(tabId);
    deps.spares.setActiveTab(deps.session.session.activeTabId);
    deps.types.invalidate();
    deps.send.changed({ tabId, tab });
  };

  return {
    requests: {},
    messages: {
      "wd.pick": message(tabParamsSchema, "wd.pick", async ({ tabId }) => {
        const tab = deps.session.session.tabs[tabId];
        if (!tab) return;
        const current = tab.workingDirectory && (await deps.isDirectory(tab.workingDirectory)) ? tab.workingDirectory : null;
        const picked = await deps.pickFolder({
          startingFolder: current ?? deps.session.session.lastDirectory ?? deps.documentsDir,
        });
        if (!picked || !(await deps.isDirectory(picked))) return;
        apply(tabId, picked);
      }),
      "wd.clear": message(tabParamsSchema, "wd.clear", ({ tabId }) => apply(tabId, null)),
    },
  };
}
```

`apps/desktop/src/main/rpc/types-handlers.ts`:

```ts
import {
  type LocalTypesResult,
  localTypesParamsSchema,
  type PackageTypesResult,
  packageTypesParamsSchema,
} from "@jslab/rpc-schema";
import type { TypesService } from "../services/types-service";
import { createValidators, type Log } from "./validate";

export interface TypesHandlerDeps {
  types: Pick<TypesService, "packages" | "local">;
  log: Log;
}

/** The editor's type feeder (spec §6.2). */
export function createTypesHandlers(deps: TypesHandlerDeps) {
  const { parse } = createValidators(deps.log);
  return {
    requests: {
      "types.package": (input: unknown): Promise<{ packages: PackageTypesResult[] }> => {
        const { tabId, packages } = parse(packageTypesParamsSchema, "types.package", input);
        return deps.types.packages(tabId, packages).then((results) => ({ packages: results }));
      },
      "types.local": (input: unknown): Promise<LocalTypesResult> => {
        const { tabId, specifiers } = parse(localTypesParamsSchema, "types.local", input);
        return deps.types.local(tabId, specifiers);
      },
    },
    messages: {},
  };
}
```

`apps/desktop/src/main/rpc/npmrc-handlers.ts`:

```ts
import { readFile } from "node:fs/promises";
import { emptyParamsSchema, npmrcSaveParamsSchema, type SaveResult } from "@jslab/rpc-schema";
import { DEFAULT_NPMRC } from "@jslab/shared";
import { type AtomicWriteOptions, writeFileAtomic } from "../persistence/atomic-write";
import { createValidators, type Log } from "./validate";

export interface NpmrcHandlerDeps {
  path: string;
  write?(path: string, data: string, options: AtomicWriteOptions): Promise<void>;
  /** After a save or reset (the registry may have changed). */
  onSaved(): void;
  log: Log;
}

/** Settings → NPM (spec §11.5): read, save and reset `<packages>/.npmrc`. Content is never logged. */
export function createNpmrcHandlers(deps: NpmrcHandlerDeps) {
  const { parse } = createValidators(deps.log);
  const write = (content: string) => (deps.write ?? writeFileAtomic)(deps.path, content, { mode: 0o600 });
  return {
    requests: {
      "npmrc.get": (input: unknown): Promise<{ content: string }> => {
        parse(emptyParamsSchema, "npmrc.get", input);
        return readFile(deps.path, "utf8").then(
          (content) => ({ content }),
          () => ({ content: DEFAULT_NPMRC }),
        );
      },
      "npmrc.save": (input: unknown): Promise<SaveResult> => {
        const { content } = parse(npmrcSaveParamsSchema, "npmrc.save", input);
        const text = content === "" || content.endsWith("\n") ? content : `${content}\n`;
        return write(text).then(
          () => {
            deps.onSaved();
            return { ok: true as const };
          },
          (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        );
      },
      "npmrc.reset": (input: unknown): Promise<{ content: string }> => {
        parse(emptyParamsSchema, "npmrc.reset", input);
        return write(DEFAULT_NPMRC).then(() => {
          deps.onSaved();
          return { content: DEFAULT_NPMRC };
        });
      },
    },
    messages: {},
  };
}
```

`apps/desktop/src/main/services/session-store.ts`: add after `setViewState`:

```ts
  /** Spec §12.2: the tab's working directory, or null to clear it. Returns the updated tab. */
  setWorkingDirectory(tabId: string, workingDirectory: string | null): TabState | null {
    const tab = this.#session.tabs[tabId];
    if (!tab) return null;
    const next: TabState = { ...tab, workingDirectory };
    this.#commit({ ...this.#session, tabs: { ...this.#session.tabs, [tabId]: next } });
    return next;
  }
```

`apps/desktop/src/main/services/npm-service.ts`: add as a public method of `NpmService`:

```ts
  /** Settings → NPM changed `.npmrc`: the cached outdated result may name another registry's versions. */
  resetOutdated(): void {
    this.onSucceeded();
  }
```

`apps/desktop/src/main/main-services.ts`:

1. Add imports:

```ts
import { join } from "node:path";
import type { NpmListResult, NpmOperation } from "@jslab/rpc-schema";
import { createBunSpawn, type NpmSpawn } from "./services/npm-spawn";
import { NpmService } from "./services/npm-service";
import { TypesService } from "./services/types-service";
```

2. Add to `MainServicesOptions`:

```ts
  /** The user's real home folder (for the Bun cache location, spec §11.3). */
  realHome: string;
  /** E2E only: a temp Bun cache for npm operations instead of the user's. */
  bunCacheDirOverride?: string;
  npmSpawn?: NpmSpawn;
  npmFetch?: typeof fetch;
  onNpmOperation(operation: NpmOperation): void;
  onNpmLog(opId: string, text: string): void;
  onNpmChanged(list: NpmListResult): void;
```

3. Add `npm: NpmService;` and `types: TypesService;` to `MainServices`.
4. After `env.onChange(() => spares.invalidateAll());`, add:

```ts
  const workingDirectoryFor = (tabId: string) => session.session.tabs[tabId]?.workingDirectory ?? null;
  const types = new TypesService({
    workingDirectoryFor,
    nodeModulesDirsFor: (tabId) => {
      const workingDirectory = workingDirectoryFor(tabId);
      return workingDirectory ? [join(workingDirectory, "node_modules"), paths.packagesNodeModules] : [paths.packagesNodeModules];
    },
  });
  const npm = new NpmService({
    paths,
    baseEnv: () => options.env,
    realHome: options.realHome,
    ...(options.bunCacheDirOverride ? { cacheDirOverride: options.bunCacheDirOverride } : {}),
    settings: () => settings.current.npm,
    spawn: options.npmSpawn ?? createBunSpawn(paths.bunBinary),
    ...(options.npmFetch ? { fetch: options.npmFetch } : {}),
    onOperation: options.onNpmOperation,
    onLog: options.onNpmLog,
    onChanged: options.onNpmChanged,
    // Spec §11.3: after any change, spares are recycled and the type cache is invalidated (web vendor caches: M4).
    afterChange: () => {
      spares.invalidateAll();
      types.invalidate();
    },
    log,
  });
```

5. Add `npm,` and `types,` to the returned object.

Update the existing `createMainServices` call in `apps/desktop/test/main-services.test.ts` (the first test) by adding:

```ts
      realHome: join(dir, "home"),
      onNpmOperation: () => {},
      onNpmLog: () => {},
      onNpmChanged: () => {},
```

`apps/desktop/src/main/index.ts`:

1. Add imports:

```ts
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createEnvHandlers } from "./rpc/env-handlers";
import { createNpmHandlers } from "./rpc/npm-handlers";
import { createNpmrcHandlers } from "./rpc/npmrc-handlers";
import { createTypesHandlers } from "./rpc/types-handlers";
import { createWorkingDirectoryHandlers } from "./rpc/wd-handlers";
```

(merge `homedir` into the existing `node:os` import, which already imports `arch`).

2. Replace `const redact = createRedactor();` with:

```ts
  // Spec §18: env.json values are masked in logs and the debug report once the env store is open.
  let envSecrets: () => readonly string[] = () => [];
  const redact = createRedactor(() => envSecrets());
```

3. In the `createMainServices({ … })` call, add:

```ts
    realHome: homedir(),
    ...(process.env.JSLAB_E2E === "1" && process.env.JSLAB_E2E_BUN_CACHE_DIR
      ? { bunCacheDirOverride: process.env.JSLAB_E2E_BUN_CACHE_DIR }
      : {}),
    onNpmOperation: (operation) => rpc.send["npm.op"](operation),
    onNpmLog: (opId, text) => rpc.send["npm.log"]({ opId, text }),
    onNpmChanged: (list) => rpc.send["npm.changed"](list),
```

4. Change the destructuring to `const { settings, session, env, npm, types, runLock, safeMode, transform, spares, coordinator } = services;` and add directly after it: `envSecrets = () => env.secrets();`.

5. In the main window's `mergeHandlers(…)` call, after `createSettingsHandlers({ settings, e2e: e2eEnabled, log }),` add:

```ts
      createNpmHandlers({ npm, log }),
      createEnvHandlers({ env, log }),
      createTypesHandlers({ types, log }),
      createWorkingDirectoryHandlers({
        session,
        documentsDir: Utils.paths.documents,
        pickFolder: async ({ startingFolder }) =>
          e2eEnabled
            ? ((await readE2EOpenDialog(paths.dataDir))[0] ?? null)
            : ((
                await Utils.openFileDialog({
                  startingFolder,
                  allowedFileTypes: "*",
                  canChooseFiles: false,
                  canChooseDirectory: true,
                  allowsMultipleSelection: false,
                })
              )[0] ?? null),
        isDirectory: (path) => stat(path).then((info) => info.isDirectory(), () => false),
        spares,
        types,
        send: { changed: (payload) => rpc.send["wd.changed"](payload) },
        log,
      }),
```

6. In the Settings window's `mergeHandlers(…)` call, add `createNpmrcHandlers({ path: paths.packagesNpmrc, onSaved: () => npm.resetOutdated(), log }),` after `createFontHandlers(…)`.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/rpc test/main-services.test.ts test/services`
Expected: PASS, 0 fail.

- [ ] **Step 5: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/desktop` M2 final + 45.

- [ ] **Step 6: Run the startup scenarios (Main composition changed)**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/core.test.ts ./scenarios/help.test.ts ./scenarios/settings-window.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: all pass, 0 fail. The debug report scenario still contains no home path. Read-only `ps` check: no survivors.

- [ ] **Step 7: Commit**

```bash
git add packages/rpc-schema apps/ui/src/view-messages.ts apps/desktop/src/main apps/desktop/test
git commit -m "feat(desktop): npm, environment, working-directory, types and npmrc handlers wired into main" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 19: UI carries: buffer sync (X5), view-state flush on quit (X1), isolated App tests (T19A-mock)

**Files:**
- Create: `apps/ui/src/state/buffer-sync.ts`, `apps/desktop/src/main/ui-flush.ts`
- Move: `apps/ui/test/app.test.tsx` → `apps/ui/isolated/app.test.tsx`
- Modify: `apps/ui/package.json` (`scripts.test`), `apps/ui/tsconfig.json` (`include`)
- Modify: `packages/rpc-schema/src/ui-rpc.ts` (`MainMessages`, `ViewMessages`), `apps/ui/src/view-messages.ts`
- Modify: `apps/ui/src/api.ts`, `apps/ui/src/rpc.ts`, `apps/ui/test/fake-api.ts`
- Modify: `apps/ui/src/editor/editor-handle.ts`, `apps/ui/src/editor/Editor.tsx:167-247` (`setEditorHandle`)
- Modify: `apps/ui/src/shell/App.tsx:100-137` (`run`), `:152-168` (flows, close guard), `:245-275` (view messages), `:308-347` (store subscription)
- Modify: `apps/desktop/src/main/index.ts:231-286` (main RPC), `:483-501` (`before-quit`)
- Test: `apps/ui/test/buffer-sync.test.ts`, `apps/desktop/test/ui-flush.test.ts`, `apps/ui/isolated/app.test.tsx` (moved, one test updated, one added), `packages/e2e/scenarios/quit-flush.test.ts`

**Interfaces:**
- Consumes: `createDebouncedWriter`-style timers (`TimerApi` from `state/auto-run.ts`); `flushBeforeQuit` (`quit.ts`); `getEditorHandle`.
- Produces:
  - `state/buffer-sync.ts`: `BUFFER_SYNC_DELAY_MS = 150`; `interface BufferSync { changed(tabId: string, content: string): void; flush(tabId?: string): void; dispose(): void }`; `createBufferSync(send: (tabId: string, content: string) => void, options?: { delayMs?: number; timers?: TimerApi }): BufferSync`
  - `ui-flush.ts`: `UI_FLUSH_TIMEOUT_MS = 500`; `interface UiFlushWaiter { request(): Promise<"flushed" | "timedOut" | "closed">; received(): void }`; `createUiFlushWaiter(deps: { send(): void; isOpen(): boolean; timeoutMs?: number }): UiFlushWaiter`; `createUiFlushHandlers(waiter: Pick<UiFlushWaiter, "received">, log: Log)`
  - RPC: `MainMessages["ui.stateFlushed"]: Record<string, never>`; `ViewMessages["app.flushState"]: Record<string, never>`
  - `MainApi.stateFlushed(): void`; `EditorHandle.flushViewState(): void`

**Rules (carries X1, X5, T19A-mock; spec §10.1 "pending writes are flushed"):**
- **X5.** Buffer edits reach Main at most once per 150 ms per tab (the last content wins) instead of a full-buffer send on every keystroke. A tab's pending content is sent at once before a run starts, before its tab closes, when the page unloads, and when Main asks for a flush.
- **X1.** Before the quit flush, Main sends `app.flushState`. The UI flushes pending view-state saves and buffer edits, then sends `ui.stateFlushed`. Main waits at most 500 ms for it, within the existing 2 s quit bound, and doesn't wait at all while the main window is closed.
- **T19A-mock.** The module-mocked App tests run in their own `bun test` process (`apps/ui/isolated/`), so their `mock.module` calls can never reach another test file. `apps/ui` `test` runs both folders. Every other ui test file stays in `apps/ui/test/`.

- [ ] **Step 1: Isolate the module-mocked App tests (no behavior change)**

```bash
mkdir -p apps/ui/isolated
git mv apps/ui/test/app.test.tsx apps/ui/isolated/app.test.tsx
```

In `apps/ui/isolated/app.test.tsx`, change `import { createFakeApi } from "./fake-api";` to `import { createFakeApi } from "../test/fake-api";`. Replace lines 32-44 with the block below. Those lines run from the `// Monaco and the virtualized list need a real browser layout…` comment, through the existing `const RealOutputPanel = OutputPanelModule.OutputPanel;` line, the `// T19A-mock (parked to M3)` comment, the two `mock.module` lines and the `afterAll(…)` block. Replacing the whole range keeps `RealOutputPanel` declared once.

```ts
// T19A-mock: this file runs in its own `bun test` process (package.json "test"), so these module mocks can't leak into
// any other test file. Monaco and the virtualized list need a real browser layout; the shell behavior under test
// does not.
const RealOutputPanel = OutputPanelModule.OutputPanel;
mock.module("../src/editor/Editor", () => ({ Editor: () => <div data-testid="editor" /> }));
mock.module("../src/output/OutputPanel", () => ({ OutputPanel: () => <div data-testid="output" /> }));
afterAll(() => {
  mock.module("../src/output/OutputPanel", () => ({ OutputPanel: RealOutputPanel }));
});
```

In `apps/ui/package.json`, change `"test": "bun test"` to `"test": "bun test ./test && bun test ./isolated"`. In `apps/ui/tsconfig.json`, change `"include": ["src", "test"]` to `"include": ["src", "test", "isolated"]`.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun run test`
Expected: two runner summaries whose pass counts add up to exactly the Task 5 ui count (M2 final + 1), 0 fail. If the sum differs, stop and report both summaries.

- [ ] **Step 2: Write the failing tests**

`apps/ui/test/buffer-sync.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { TimerApi } from "../src/state/auto-run";
import { createBufferSync } from "../src/state/buffer-sync";

function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const timers: TimerApi = {
    setTimeout: (callback) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
  };
  return { timers, fire: () => [...pending.entries()].forEach(([id, callback]) => (pending.delete(id), callback())) };
}

describe("buffer sync (X5)", () => {
  test("coalesces edits per tab and sends each tab's last content once after the delay", () => {
    const send = mock((_tabId: string, _content: string) => {});
    const { timers, fire } = manualTimers();
    const sync = createBufferSync(send, { timers });
    sync.changed("a", "1");
    sync.changed("a", "12");
    sync.changed("b", "x");
    sync.changed("a", "123");
    expect(send).not.toHaveBeenCalled();
    fire();
    expect(send.mock.calls).toEqual([
      ["b", "x"],
      ["a", "123"],
    ]);
  });

  test("flush sends one tab, or every tab, at once and cancels their timers", () => {
    const send = mock((_tabId: string, _content: string) => {});
    const { timers, fire } = manualTimers();
    const sync = createBufferSync(send, { timers });
    sync.changed("a", "1");
    sync.changed("b", "2");
    sync.flush("a");
    expect(send.mock.calls).toEqual([["a", "1"]]);
    sync.flush();
    fire();
    expect(send.mock.calls).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  test("dispose drops pending edits", () => {
    const send = mock(() => {});
    const { timers, fire } = manualTimers();
    const sync = createBufferSync(send, { timers });
    sync.changed("a", "1");
    sync.dispose();
    fire();
    sync.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
```

`apps/desktop/test/ui-flush.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createUiFlushHandlers, createUiFlushWaiter } from "../src/main/ui-flush";

describe("UI state flush before quit (X1)", () => {
  test("resolves flushed when the UI acknowledges, timedOut when it doesn't, and closed without a window", async () => {
    let open = true;
    const send = mock(() => {});
    const waiter = createUiFlushWaiter({ send, isOpen: () => open, timeoutMs: 30 });
    const flushed = waiter.request();
    expect(send).toHaveBeenCalledTimes(1);
    waiter.received();
    expect(await flushed).toBe("flushed");
    expect(await waiter.request()).toBe("timedOut");
    open = false;
    expect(await waiter.request()).toBe("closed");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("the ui.stateFlushed handler validates its payload", () => {
    const received = mock(() => {});
    const log = mock(() => {});
    const handlers = createUiFlushHandlers({ received }, log);
    handlers.messages["ui.stateFlushed"]({});
    handlers.messages["ui.stateFlushed"]("junk");
    expect(received).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
  });
});
```

In `apps/ui/isolated/app.test.tsx`:

1. Add `import { BUFFER_SYNC_DELAY_MS } from "../src/state/buffer-sync";`, and add `waitFor` to the `@testing-library/react` import.
2. Replace the test `edits and language changes are sent to Main for persistence` with:

```ts
  test("edits are sent to Main once per coalescing delay, and language changes at once (X5)", async () => {
    const { store, api } = renderApp();
    act(() => store.getState().editCode("2"));
    act(() => store.getState().editCode("2 + 2"));
    expect(api.bufferChanged).not.toHaveBeenCalled();
    // Waits for the coalescing timer without a fixed sleep; one call proves the two edits were coalesced.
    await waitFor(() => expect(api.bufferChanged).toHaveBeenCalledTimes(1), { timeout: BUFFER_SYNC_DELAY_MS + 2000 });
    expect(api.bufferChanged.mock.calls).toEqual([["t1", "2 + 2"]]);
    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "javascript" } });
    expect(api.patchTab).toHaveBeenCalledWith("t1", expect.objectContaining({ language: "javascript" }));
  });

  test("app.flushState flushes pending edits and view state, then acknowledges (X1)", async () => {
    const { store, api, emit } = renderApp();
    const order: string[] = [];
    const flushViewState = mock(() => void order.push("viewState"));
    setEditorHandle({ flushViewState } as unknown as EditorHandle);
    api.bufferChanged.mockImplementation(() => void order.push("buffer"));
    api.stateFlushed.mockImplementation(() => void order.push("ack"));
    act(() => store.getState().editCode("3 + 3"));
    await emit("app.flushState", {});
    expect(order).toEqual(["viewState", "buffer", "ack"]);
    setEditorHandle(null);
  });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun test ./test/buffer-sync.test.ts && builtin cd ../desktop && bun test test/ui-flush.test.ts`
Expected: FAIL, `Cannot find module "../src/state/buffer-sync"` and `Cannot find module "../src/main/ui-flush"`.

- [ ] **Step 4: Implement**

`apps/ui/src/state/buffer-sync.ts`:

```ts
import type { TimerApi } from "./auto-run";

/** X5: at most one full-buffer `buffer.changed` per tab per this many ms while typing. */
export const BUFFER_SYNC_DELAY_MS = 150;

export interface BufferSync {
  changed(tabId: string, content: string): void;
  /** Sends one tab's pending content (or every tab's) now. */
  flush(tabId?: string): void;
  dispose(): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Coalesces buffer edits per tab before they reach Main (X5); Main debounces its disk writes separately. */
export function createBufferSync(
  send: (tabId: string, content: string) => void,
  options: { delayMs?: number; timers?: TimerApi } = {},
): BufferSync {
  const timers = options.timers ?? defaultTimers;
  const pending = new Map<string, { content: string; handle: unknown }>();
  const flushOne = (tabId: string) => {
    const entry = pending.get(tabId);
    if (!entry) return;
    timers.clearTimeout(entry.handle);
    pending.delete(tabId);
    send(tabId, entry.content);
  };
  return {
    changed(tabId, content) {
      const existing = pending.get(tabId);
      if (existing) timers.clearTimeout(existing.handle);
      pending.set(tabId, {
        content,
        handle: timers.setTimeout(() => flushOne(tabId), options.delayMs ?? BUFFER_SYNC_DELAY_MS),
      });
    },
    flush(tabId) {
      if (tabId !== undefined) flushOne(tabId);
      else for (const id of [...pending.keys()]) flushOne(id);
    },
    dispose() {
      for (const entry of pending.values()) timers.clearTimeout(entry.handle);
      pending.clear();
    },
  };
}
```

`apps/desktop/src/main/ui-flush.ts`:

```ts
import { emptyParamsSchema } from "@jslab/rpc-schema";
import { createValidators, type Log } from "./rpc/validate";

/** X1: how long quit waits for the UI to flush view state and buffer edits (inside the 2 s quit bound). */
export const UI_FLUSH_TIMEOUT_MS = 500;

export interface UiFlushWaiter {
  request(): Promise<"flushed" | "timedOut" | "closed">;
  received(): void;
}

export function createUiFlushWaiter(deps: { send(): void; isOpen(): boolean; timeoutMs?: number }): UiFlushWaiter {
  let waiting: (() => void)[] = [];
  return {
    request() {
      if (!deps.isOpen()) return Promise.resolve("closed");
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve("flushed");
        };
        const timer = setTimeout(() => {
          waiting = waiting.filter((entry) => entry !== done);
          resolve("timedOut");
        }, deps.timeoutMs ?? UI_FLUSH_TIMEOUT_MS);
        waiting.push(done);
        deps.send();
      });
    },
    received() {
      const current = waiting;
      waiting = [];
      for (const done of current) done();
    },
  };
}

export function createUiFlushHandlers(waiter: Pick<UiFlushWaiter, "received">, log: Log) {
  const { message } = createValidators(log);
  return {
    requests: {},
    messages: { "ui.stateFlushed": message(emptyParamsSchema, "ui.stateFlushed", () => waiter.received()) },
  };
}
```

`packages/rpc-schema/src/ui-rpc.ts`: add `"ui.stateFlushed": Record<string, never>;` to `MainMessages` and `"app.flushState": Record<string, never>;` to `ViewMessages`. `apps/ui/src/view-messages.ts`: add `"app.flushState"` to `VIEW_MESSAGES`.

`apps/ui/src/api.ts`: add `stateFlushed(): void;` after `heartbeat(): void;`. `apps/ui/src/rpc.ts`: add `stateFlushed: () => rpc.send["ui.stateFlushed"]({}),` after `heartbeat`. `apps/ui/test/fake-api.ts`: add `stateFlushed: mock(() => {}),` after `heartbeat`.

`apps/ui/src/editor/editor-handle.ts`: add to `EditorHandle`:

```ts
  /** Sends every pending view-state save now (X1, before quit). */
  flushViewState(): void;
```

`apps/ui/src/editor/Editor.tsx`: in the object passed to `setEditorHandle({ … })`, add after `getOptions`:

```ts
      flushViewState: () => {
        view.saveActive();
        view.flush();
      },
```

`apps/ui/src/shell/App.tsx`:

1. Add `import { createBufferSync } from "../state/buffer-sync";`.
2. After the `const flows = useMemo(…);` block, add:

```ts
  // X5: edits reach Main at most once per BUFFER_SYNC_DELAY_MS per tab; pending content is flushed on demand.
  const bufferSync = useMemo(() => createBufferSync((tabId, content) => api.bufferChanged(tabId, content)), [api]);
  useEffect(() => {
    const flushAll = () => bufferSync.flush();
    window.addEventListener("beforeunload", flushAll);
    return () => {
      window.removeEventListener("beforeunload", flushAll);
      bufferSync.flush();
      bufferSync.dispose();
    };
  }, [bufferSync]);
```

3. Replace the close-guard effect body `tabs.setBeforeClose((tabId) => flows.beforeClose(tabId));` with:

```ts
    tabs.setBeforeClose(async (tabId) => {
      const allowed = await flows.beforeClose(tabId);
      // Main moves the buffer file into buffers/closed/ on close, so it must have the latest content first.
      if (allowed) bufferSync.flush(tabId);
      return allowed;
    });
```

and add `bufferSync` to that effect's dependency array.

4. In `run`'s `start()` closure, directly before `void api.startRun({ … });`, add `bufferSync.flush(tabId);`, and add `bufferSync` to `run`'s `useCallback` dependencies.
5. In the view-message effect's `unsubscribers` array, add:

```ts
      // X1: Main is quitting. Flush view state and edits, then acknowledge so Main can write the session.
      api.on("app.flushState", () => {
        getEditorHandle()?.flushViewState();
        bufferSync.flush();
        api.stateFlushed();
      }),
```

and add `bufferSync` to that effect's dependencies.

6. In the store-subscription effect, replace `else api.bufferChanged(id, content);` with `else bufferSync.changed(id, content);` and add `bufferSync` to its dependencies.

`apps/desktop/src/main/index.ts`:

1. Add `import { createUiFlushHandlers, createUiFlushWaiter } from "./ui-flush";`.
2. Directly before `const rpc = BrowserView.defineRPC<JSLabRPC>({`, add:

```ts
  // X1: before the quit flush, the UI flushes its pending view-state saves and buffer edits.
  const uiFlush = createUiFlushWaiter({ send: () => rpc.send["app.flushState"]({}), isOpen: () => mainWindow.isOpen() });
```

3. Add `createUiFlushHandlers(uiFlush, log),` to the main window's `mergeHandlers(…)` list.
4. In `before-quit`, replace the `flushBeforeQuit(() => Promise.all([session.flush(), settings.flush()]).then(() => {}), log)` call with:

```ts
    void flushBeforeQuit(
      () =>
        uiFlush
          .request()
          .then(() => Promise.all([session.flush(), settings.flush()]))
          .then(() => {}),
      log,
    ).finally(() => Utils.quit(errorPolicy.exitCode));
```

Move the existing `coordinator.dispose()`, `transform.dispose()` and `runLock.releaseAll()` lines unchanged (they stay before this call).

- [ ] **Step 5: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun run test && builtin cd ../desktop && bun test test/ui-flush.test.ts test/startup.test.ts`
Expected: PASS, 0 fail.

- [ ] **Step 6: Add the scenario and run every gate**

`packages/e2e/scenarios/quit-flush.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let apps: LaunchedApp[] = [];
afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

test("an edit typed right before quitting is saved (X1, X5)", async () => {
  const userData = await createUserData();
  const app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
  apps.push(app);
  await app.type("const quick = 42");
  await waitFor(async () => activeTab(await app.state()).code === "const quick = 42" || null);
  await app.quit();
  const again = await launchApp({ userData });
  apps.push(again);
  expect(activeTab(await again.state()).code).toBe("const quick = 42");
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/ui` M2 final + 5 (two summaries); `@jslab/desktop` M2 final + 47.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/quit-flush.test.ts ./scenarios/view-state.test.ts ./scenarios/tabs.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: all pass, 0 fail. Scenarios: M2 final + 2. Read-only `ps` check: no survivors.

- [ ] **Step 7: Commit**

```bash
git add apps/ui apps/desktop/src/main apps/desktop/test/ui-flush.test.ts packages/rpc-schema packages/e2e/scenarios/quit-flush.test.ts
git commit -m "fix(ui): coalesce buffer sends, flush view state before quit and isolate the mocked app tests" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 20: Per-runtime TypeScript environment and bundled type libraries

**Files:**
- Create: `apps/ui/src/editor/ts-environment.ts`, `apps/ui/src/editor/type-libs.ts`, `apps/ui/vite-plugins/type-libs-plugin.ts` (not `build/`: `biome.json` ignores `**/build`, so a plugin there would never be linted or formatted)
- Delete: `apps/ui/src/editor/ts-lib.ts`. At the M3 base it holds PR #1's fixed constant `EDITOR_TS_LIB = ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]`; `libFor` replaces it.
- Move: `apps/ui/test/ts-lib.test.ts` → `apps/ui/test/monaco-lib-names.test.ts` (PR #1's `TypeScriptWorker` regression test, repointed at `libFor`; assertions and count unchanged)
- Modify: `apps/ui/src/editor/monaco-setup.ts:1-47` (anchors as of `d481b19`; PR #1 changes only `ts-lib.ts` and its test — if it touched `monaco-setup.ts` too, follow the code), `apps/ui/vite.config.ts:1-42`, `apps/ui/src/vite-env.d.ts`, `apps/ui/package.json` (`devDependencies`), `apps/ui/tsconfig.json` (`include`), `bun.lock`
- Test: `apps/ui/test/ts-environment.test.ts`, `apps/ui/test/type-libs-plugin.test.ts`, `apps/ui/test/monaco-internals.d.ts`, `apps/ui/test/ts-worker.ts` (the shared in-process `TypeScriptWorker` harness)

**Interfaces:**
- Consumes: `Runtime`, `DecoratorMode`, `DEFAULT_RUNTIME` (`@jslab/shared`); `TypeFile` (Task 5).
- Produces:
  - `editor/ts-environment.ts`:
    - `type RuntimePack = "node" | "bun"`, `IGNORED_DIAGNOSTIC_CODES`
    - `libFor(runtime: Runtime): string[]`, `packsFor(runtime: Runtime): RuntimePack[]`
    - `compilerOptionsFor(runtime: Runtime, decorators: DecoratorMode): Record<string, unknown>`, `diagnosticsOptionsFor(linting: boolean): { noSemanticValidation: boolean; noSyntaxValidation: boolean; diagnosticCodesToIgnore: number[] }`
    - `interface TsDefaultsLike { setCompilerOptions(options: Record<string, unknown>): void; setDiagnosticsOptions(options: Record<string, unknown>): void; setExtraLibs(libs: { content: string; filePath?: string }[]): void }`
    - `interface TsEnvironmentState { tabId: string | null; runtime: Runtime; decorators: DecoratorMode; linting: boolean }`
    - `interface TsEnvironment { apply(state: TsEnvironmentState): Promise<void>; setPackageFiles(name: string, files: readonly TypeFile[]): void; hasPackage(name: string): boolean; clearPackages(): void; setLocalFiles(tabId: string, files: readonly TypeFile[]): void; clearLocal(tabId?: string): void; libPaths(): string[] }`
    - `createTsEnvironment(deps: { defaults: readonly TsDefaultsLike[]; loadPack(pack: RuntimePack): Promise<readonly TypeFile[]> }): TsEnvironment`
  - `editor/type-libs.ts`: `loadRuntimePack(pack: RuntimePack): Promise<readonly TypeFile[]>` (lazy Vite chunks)
  - `vite-plugins/type-libs-plugin.ts`: `TYPE_LIB_PACKS: Record<RuntimePack, readonly string[]>`, `MAX_TYPE_LIB_BYTES = 8_000_000`, `resolvePackageDir(name: string, fromDir: string): string`, `collectTypeLibPack(packages: readonly { name: string; dir: string }[]): TypeFile[]`, `jslabTypeLibs(root?: string): Plugin`

**Rules (spec §6.1, §6.2, §5.2 table; carry R-M2-BUG-1):**
- **Compiler options** exactly as spec §6.1:
  - `target: ESNext (99)`, `module: ESNext (99)`, `moduleResolution: Bundler (100)`, `jsx: ReactJSX (4)`
  - `strict: true`, `allowJs: true`, `checkJs: false`, `allowNonTsExtensions: true`, `esModuleInterop: true`, `allowSyntheticDefaultImports: true`, `skipLibCheck: true`
  - `experimentalDecorators: build.decorators === "legacy"`, `moduleDetection: Force (3)`
  - `lib: ["lib.esnext.d.ts"]` for `bun`, `["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]` otherwise. These are full lib file names: Monaco's TypeScript language service uses each `lib` entry as a file name, and short names (`"esnext"`, `"dom"`) leave the DOM lib unloaded (PR #1, Global Constraints).
- **Extra libs:** `bun` gets `bun-types` and `@types/node` (with `undici-types`, which `@types/node` imports); `browser-node` gets `@types/node`; `browser` gets none.
- **Diagnostics:** `editor.linting` off sets `noSemanticValidation` and `noSyntaxValidation` to true. Codes 1375 and 1378 are always ignored; 2307 is shown.
- **Monaco's defaults are global.** The environment re-applies compiler options, diagnostics options and the extra-lib set when the shown tab, its runtime, `build.decorators` or `editor.linting` changes. It calls a setter only when that value actually changed (each change restarts Monaco's TypeScript worker). A slow pack load never applies a runtime the user has already left.
- **Bundling:** `bun-types` 1.4.2, `@types/node` 22.20.2 and `undici-types` 6.21.0 are exact devDependencies of `@jslab/ui` (all already in `bun.lock`). A Vite plugin turns each pack into a lazily loaded chunk (`virtual:jslab-type-libs/node`, `…/bun`): every `.d.ts` plus `package.json`, at `file:///node_modules/<package>/<path>`. The chunk loads through `script-src 'self' views:`, so the CSP doesn't change. Both packs together stay under 8 MB of source.
- **Test (R-M2-BUG-1):** a unit test runs Monaco's real `TypeScriptWorker` in-process (the same harness-free approach as PR #1's regression test, shared through `test/ts-worker.ts`) with each runtime's options and packs. It checks that `console`, `setTimeout` and `URL` have no diagnostic in any runtime, and that each runtime's own globals are scoped (`Bun` only in `bun`, `process` in `bun` and `browser-node`, `document` in the browser runtimes). Another assertion checks that every `lib` entry is a full `lib.*.d.ts` file name.

- [ ] **Step 1: Pin the type packages**

In `apps/ui/package.json` `devDependencies`, add `"@types/node": "22.20.2"`, `"bun-types": "1.4.2"`, `"undici-types": "6.21.0"`. In `apps/ui/tsconfig.json`, set `"include": ["src", "test", "isolated", "vite-plugins"]`.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun install`
Expected: exit 0. `git diff --stat bun.lock` shows only the `@jslab/ui` workspace entry changing (the three versions are already resolved there).

- [ ] **Step 2: Write the failing tests**

`apps/ui/test/monaco-internals.d.ts`:

```ts
// Monaco ships its TypeScript worker and services without typings; tests run them in-process to check the editor's
// compiler options. If the M3 base (PR #1) already declares these modules, keep one declaration of each.
declare module "monaco-editor/languages/features/typescript/lib/typescriptServices" {
  // biome-ignore lint/suspicious/noExplicitAny: untyped bundled TypeScript
  export const typescript: any;
}
declare module "monaco-editor/languages/features/typescript/tsWorker" {
  export interface MirrorModelLike {
    uri: { path: string; toString(skipEncoding?: boolean): string };
    version: number;
    getValue(): string;
  }
  export interface WorkerDiagnosticLike {
    code: number;
    messageText: unknown;
  }
  export class TypeScriptWorker {
    constructor(
      ctx: { getMirrorModels(): MirrorModelLike[] },
      createData: {
        compilerOptions: Record<string, unknown>;
        extraLibs: Record<string, { content: string; version: number }>;
      },
    );
    getSyntacticDiagnostics(fileName: string): Promise<WorkerDiagnosticLike[]>;
    getSemanticDiagnostics(fileName: string): Promise<WorkerDiagnosticLike[]>;
  }
}
```

`apps/ui/test/ts-worker.ts`:

```ts
import type { TypeFile } from "@jslab/rpc-schema";
import { typescript } from "monaco-editor/languages/features/typescript/lib/typescriptServices";
import { TypeScriptWorker } from "monaco-editor/languages/features/typescript/tsWorker";

export interface WorkerDiagnostic {
  code: number;
  message: string;
}

/**
 * Monaco's real TypeScriptWorker, constructed in-process under `bun test` (no web worker): one model plus extra libs,
 * with the editor's compiler options. It resolves `lib` entries against Monaco's bundled lib files exactly as the
 * running editor does.
 */
export async function workerDiagnostics(input: {
  code: string;
  compilerOptions: Record<string, unknown>;
  extraLibs?: readonly TypeFile[];
  fileName?: string;
}): Promise<WorkerDiagnostic[]> {
  const fileName = input.fileName ?? "file:///tab/t1.ts";
  const model = { uri: { path: new URL(fileName).pathname, toString: () => fileName }, version: 1, getValue: () => input.code };
  const extraLibs = Object.fromEntries((input.extraLibs ?? []).map((file) => [file.path, { content: file.content, version: 1 }]));
  const worker = new TypeScriptWorker({ getMirrorModels: () => [model] }, { compilerOptions: input.compilerOptions, extraLibs });
  const diagnostics = [...(await worker.getSyntacticDiagnostics(fileName)), ...(await worker.getSemanticDiagnostics(fileName))];
  return diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    message: typescript.flattenDiagnosticMessageText(diagnostic.messageText, "\n") as string,
  }));
}
```

`apps/ui/test/type-libs-plugin.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  collectTypeLibPack,
  jslabTypeLibs,
  MAX_TYPE_LIB_BYTES,
  resolvePackageDir,
  TYPE_LIB_PACKS,
} from "../vite-plugins/type-libs-plugin";

const uiRoot = join(import.meta.dir, "..");
const pack = (name: "node" | "bun") =>
  collectTypeLibPack(TYPE_LIB_PACKS[name].map((pkg) => ({ name: pkg, dir: resolvePackageDir(pkg, uiRoot) })));

describe("bundled type libraries (spec §6.2)", () => {
  test("the node and bun packs hold every declaration file and package.json of the pinned packages, within budget", () => {
    const node = pack("node");
    const bun = pack("bun");
    const paths = [...node, ...bun].map((file) => file.path);
    expect(paths).toContain("file:///node_modules/@types/node/package.json");
    expect(paths).toContain("file:///node_modules/@types/node/globals.d.ts");
    expect(paths).toContain("file:///node_modules/undici-types/package.json");
    expect(paths).toContain("file:///node_modules/bun-types/package.json");
    expect(paths.some((path) => path.startsWith("file:///node_modules/bun-types/") && path.endsWith(".d.ts"))).toBe(true);
    expect(paths.every((path) => path.endsWith(".d.ts") || path.endsWith("/package.json"))).toBe(true);
    const bytes = [...node, ...bun].reduce((sum, file) => sum + file.content.length, 0);
    expect(bytes).toBeLessThan(MAX_TYPE_LIB_BYTES);
    expect(JSON.parse(node.find((file) => file.path.endsWith("@types/node/package.json"))?.content ?? "{}").version).toBe("22.20.2");
  });

  test("the Vite plugin serves each pack as a virtual module and ignores other ids", async () => {
    const plugin = jslabTypeLibs(uiRoot);
    const resolveId = plugin.resolveId as (id: string) => string | null;
    const load = plugin.load as (id: string) => string | null;
    expect(resolveId("virtual:jslab-type-libs/bun")).toBe("\0virtual:jslab-type-libs/bun");
    expect(resolveId("./other")).toBeNull();
    const code = load("\0virtual:jslab-type-libs/bun") ?? "";
    expect(code.startsWith("export default [")).toBe(true);
    expect(load("\0something-else")).toBeNull();
  });
});
```

`apps/ui/test/ts-environment.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { TypeFile } from "@jslab/rpc-schema";
import type { Runtime } from "@jslab/shared";
import {
  compilerOptionsFor,
  createTsEnvironment,
  diagnosticsOptionsFor,
  libFor,
  packsFor,
  type RuntimePack,
  type TsDefaultsLike,
} from "../src/editor/ts-environment";
import { collectTypeLibPack, resolvePackageDir, TYPE_LIB_PACKS } from "../vite-plugins/type-libs-plugin";
import { workerDiagnostics } from "./ts-worker";

function fakeDefaults() {
  const calls: string[] = [];
  const state: { options?: Record<string, unknown>; diagnostics?: Record<string, unknown>; libs: string[] } = { libs: [] };
  const defaults: TsDefaultsLike = {
    setCompilerOptions: (options) => {
      calls.push("options");
      state.options = options;
    },
    setDiagnosticsOptions: (options) => {
      calls.push("diagnostics");
      state.diagnostics = options;
    },
    setExtraLibs: (libs) => {
      calls.push("libs");
      state.libs = libs.map((lib) => lib.filePath ?? "");
    },
  };
  return { defaults, calls, state };
}

const packFile = (pack: RuntimePack): TypeFile => ({ path: `file:///node_modules/${pack}-pack/index.d.ts`, content: "" });

describe("per-runtime TypeScript environment (spec §6.1)", () => {
  test("compiler options follow the runtime and the decorator mode", () => {
    expect(compilerOptionsFor("bun", "2023-11")).toMatchObject({ lib: ["lib.esnext.d.ts"], experimentalDecorators: false, moduleDetection: 3, moduleResolution: 100, jsx: 4 });
    expect(compilerOptionsFor("browser-node", "legacy")).toMatchObject({ lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"], experimentalDecorators: true });
    expect(compilerOptionsFor("browser", "none").lib).toEqual(["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]);
    // Never tsconfig short names: Monaco's worker reads each entry as a lib file name (PR #1).
    expect((["bun", "browser-node", "browser"] as const).flatMap(libFor).every((name) => /^lib\.[a-z0-9.]+\.d\.ts$/.test(name))).toBe(true);
    expect([packsFor("bun"), packsFor("browser-node"), packsFor("browser")]).toEqual([["bun", "node"], ["node"], []]);
  });

  test("editor.linting turns validation off, and 1375/1378 are always ignored", () => {
    expect(diagnosticsOptionsFor(true)).toEqual({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [1375, 1378] });
    expect(diagnosticsOptionsFor(false)).toEqual({ noSemanticValidation: true, noSyntaxValidation: true, diagnosticCodesToIgnore: [1375, 1378] });
  });

  test("applies options and packs to both defaults, re-applies on a runtime switch, and does nothing when nothing changed", async () => {
    const ts1 = fakeDefaults();
    const js1 = fakeDefaults();
    const loaded: RuntimePack[] = [];
    const env = createTsEnvironment({
      defaults: [ts1.defaults, js1.defaults],
      loadPack: async (pack) => {
        loaded.push(pack);
        return [packFile(pack)];
      },
    });
    await env.apply({ tabId: "a", runtime: "bun", decorators: "2023-11", linting: true });
    expect(ts1.state.libs).toEqual(["file:///node_modules/bun-pack/index.d.ts", "file:///node_modules/node-pack/index.d.ts"]);
    expect(js1.state.options?.lib).toEqual(["lib.esnext.d.ts"]);
    await env.apply({ tabId: "a", runtime: "browser", decorators: "2023-11", linting: true });
    expect(ts1.state.libs).toEqual([]);
    expect(ts1.state.options?.lib).toEqual(["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]);
    const before = ts1.calls.length;
    await env.apply({ tabId: "a", runtime: "browser", decorators: "2023-11", linting: true });
    expect(ts1.calls.length).toBe(before);
    await env.apply({ tabId: "a", runtime: "bun", decorators: "2023-11", linting: false });
    expect(ts1.state.diagnostics?.noSemanticValidation).toBe(true);
    expect(loaded).toEqual(["bun", "node"]);
  });

  test("package files persist across tabs, local files follow the shown tab", async () => {
    const { defaults, state } = fakeDefaults();
    const env = createTsEnvironment({ defaults: [defaults], loadPack: async () => [] });
    await env.apply({ tabId: "a", runtime: "browser", decorators: "2023-11", linting: true });
    env.setPackageFiles("zod", [{ path: "file:///node_modules/zod/index.d.cts", content: "x" }]);
    env.setLocalFiles("a", [{ path: "file:///tab/util.ts", content: "a" }]);
    env.setLocalFiles("b", [{ path: "file:///tab/other.ts", content: "b" }]);
    expect(state.libs).toEqual(["file:///node_modules/zod/index.d.cts", "file:///tab/util.ts"]);
    expect(env.hasPackage("zod")).toBe(true);
    await env.apply({ tabId: "b", runtime: "browser", decorators: "2023-11", linting: true });
    expect(state.libs).toEqual(["file:///node_modules/zod/index.d.cts", "file:///tab/other.ts"]);
    env.clearPackages();
    expect([state.libs, env.hasPackage("zod")]).toEqual([["file:///tab/other.ts"], false]);
  });

  test("a slow pack load never applies a runtime the user already left", async () => {
    const { defaults, state } = fakeDefaults();
    let releaseBun: () => void = () => {};
    const env = createTsEnvironment({
      defaults: [defaults],
      loadPack: (pack) =>
        pack === "bun"
          ? new Promise((resolve) => {
              releaseBun = () => resolve([packFile("bun")]);
            })
          : Promise.resolve([packFile(pack)]),
    });
    const slow = env.apply({ tabId: "a", runtime: "bun", decorators: "2023-11", linting: true });
    await env.apply({ tabId: "a", runtime: "browser-node", decorators: "2023-11", linting: true });
    releaseBun();
    await slow;
    expect(state.libs).toEqual(["file:///node_modules/node-pack/index.d.ts"]);
    expect(state.options?.lib).toEqual(["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"]);
  });

  test(
    "Monaco's TypeScriptWorker: console, setTimeout and URL resolve in every runtime, and runtime globals are scoped (R-M2-BUG-1)",
    async () => {
      const uiRoot = join(import.meta.dir, "..");
      const packs: Record<RuntimePack, TypeFile[]> = {
        node: collectTypeLibPack(TYPE_LIB_PACKS.node.map((name) => ({ name, dir: resolvePackageDir(name, uiRoot) }))),
        bun: collectTypeLibPack(TYPE_LIB_PACKS.bun.map((name) => ({ name, dir: resolvePackageDir(name, uiRoot) }))),
      };
      const code = [
        'console.log(typeof setTimeout, new URL("https://example.test/").host);',
        "const platform: string = process.platform;",
        "Bun.version;",
        "document.title;",
        "export {};",
      ].join("\n");
      const flagged = async (runtime: Runtime) => {
        const diagnostics = await workerDiagnostics({
          code,
          compilerOptions: compilerOptionsFor(runtime, "2023-11"),
          extraLibs: packsFor(runtime).flatMap((pack) => packs[pack]),
        });
        // "Cannot find name 'x'" and its variants (TS2304, TS2584, TS2580, TS2867, TS2868) all quote the name.
        return ["console", "setTimeout", "URL", "process", "Bun", "document"].filter((name) =>
          diagnostics.some((diagnostic) => diagnostic.message.includes(`'${name}'`)),
        );
      };
      expect(await flagged("bun")).toEqual(["document"]);
      expect(await flagged("browser-node")).toEqual(["Bun"]);
      expect(await flagged("browser")).toEqual(["process", "Bun"]);
    },
    120_000,
  );
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun test ./test/ts-environment.test.ts ./test/type-libs-plugin.test.ts`
Expected: FAIL, `Cannot find module "../vite-plugins/type-libs-plugin"` and `Cannot find module "../src/editor/ts-environment"`.

- [ ] **Step 3: Implement the environment, the plugin and the loader**

`apps/ui/src/editor/ts-environment.ts`:

```ts
import type { TypeFile } from "@jslab/rpc-schema";
import type { DecoratorMode, Runtime } from "@jslab/shared";

export type RuntimePack = "node" | "bun";

/** Spec §6.1: top-level await diagnostics are never shown. */
export const IGNORED_DIAGNOSTIC_CODES: readonly number[] = [1375, 1378];

// TypeScript enum values (Monaco's typings predate Bundler and ModuleDetectionKind).
const SCRIPT_TARGET_ESNEXT = 99;
const MODULE_ESNEXT = 99;
const MODULE_RESOLUTION_BUNDLER = 100;
const JSX_REACT_JSX = 4;
const MODULE_DETECTION_FORCE = 3;

/**
 * Spec §5.2/§6.1: `bun` has no DOM; the browser runtimes do. Monaco's TypeScript worker uses every `lib` entry as a lib
 * FILE name, so these are full names, never tsconfig short names such as "dom" (PR #1: short names cause TS2584).
 */
export function libFor(runtime: Runtime): string[] {
  return runtime === "bun" ? ["lib.esnext.d.ts"] : ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"];
}

/** Spec §5.2 "Types fed to Monaco": bun → bun-types + @types/node; browser-node → @types/node; browser → none. */
export function packsFor(runtime: Runtime): RuntimePack[] {
  if (runtime === "bun") return ["bun", "node"];
  return runtime === "browser-node" ? ["node"] : [];
}

export function compilerOptionsFor(runtime: Runtime, decorators: DecoratorMode): Record<string, unknown> {
  return {
    target: SCRIPT_TARGET_ESNEXT,
    module: MODULE_ESNEXT,
    moduleResolution: MODULE_RESOLUTION_BUNDLER,
    jsx: JSX_REACT_JSX,
    strict: true,
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    experimentalDecorators: decorators === "legacy",
    moduleDetection: MODULE_DETECTION_FORCE,
    skipLibCheck: true,
    lib: libFor(runtime),
  };
}

export function diagnosticsOptionsFor(linting: boolean) {
  return {
    noSemanticValidation: !linting,
    noSyntaxValidation: !linting,
    diagnosticCodesToIgnore: [...IGNORED_DIAGNOSTIC_CODES],
  };
}

/** The slice of `monaco.typescript.typescriptDefaults` this module drives; tests pass a fake. */
export interface TsDefaultsLike {
  setCompilerOptions(options: Record<string, unknown>): void;
  setDiagnosticsOptions(options: Record<string, unknown>): void;
  setExtraLibs(libs: { content: string; filePath?: string }[]): void;
}

export interface TsEnvironmentState {
  tabId: string | null;
  runtime: Runtime;
  decorators: DecoratorMode;
  linting: boolean;
}

export interface TsEnvironment {
  /** Makes Monaco's global TypeScript defaults match the shown tab (spec §6.1). */
  apply(state: TsEnvironmentState): Promise<void>;
  setPackageFiles(name: string, files: readonly TypeFile[]): void;
  hasPackage(name: string): boolean;
  clearPackages(): void;
  setLocalFiles(tabId: string, files: readonly TypeFile[]): void;
  clearLocal(tabId?: string): void;
  /** The extra-lib paths last applied (E2E and tests). */
  libPaths(): string[];
}

export function createTsEnvironment(deps: {
  defaults: readonly TsDefaultsLike[];
  loadPack(pack: RuntimePack): Promise<readonly TypeFile[]>;
}): TsEnvironment {
  const packs = new Map<RuntimePack, Promise<readonly TypeFile[]>>();
  const loadedPacks = new Map<RuntimePack, readonly TypeFile[]>();
  const packages = new Map<string, readonly TypeFile[]>();
  const local = new Map<string, readonly TypeFile[]>();
  let state: TsEnvironmentState | null = null;
  let applied = { options: "", diagnostics: "", libs: "" };
  let appliedPaths: string[] = [];
  let version = 0;

  const loadPack = (pack: RuntimePack) => {
    let entry = packs.get(pack);
    if (!entry) {
      entry = deps.loadPack(pack).then((files) => {
        loadedPacks.set(pack, files);
        return files;
      });
      packs.set(pack, entry);
      entry.catch(() => packs.delete(pack));
    }
    return entry;
  };

  const sync = () => {
    if (!state) return;
    const runtimePacks = packsFor(state.runtime);
    if (!runtimePacks.every((pack) => loadedPacks.has(pack))) return;
    const options = compilerOptionsFor(state.runtime, state.decorators);
    const diagnostics = diagnosticsOptionsFor(state.linting);
    const libs = [
      ...runtimePacks.flatMap((pack) => loadedPacks.get(pack) ?? []),
      ...[...packages.values()].flat(),
      ...(state.tabId ? (local.get(state.tabId) ?? []) : []),
    ];
    const next = {
      options: JSON.stringify(options),
      diagnostics: JSON.stringify(diagnostics),
      libs: `${version}\n${libs.map((file) => file.path).join("\n")}`,
    };
    for (const defaults of deps.defaults) {
      if (next.options !== applied.options) defaults.setCompilerOptions(options);
      if (next.diagnostics !== applied.diagnostics) defaults.setDiagnosticsOptions(diagnostics);
      if (next.libs !== applied.libs) defaults.setExtraLibs(libs.map((file) => ({ content: file.content, filePath: file.path })));
    }
    applied = next;
    appliedPaths = libs.map((file) => file.path);
  };

  return {
    async apply(next) {
      state = next;
      await Promise.all(packsFor(next.runtime).map(loadPack));
      if (state !== next) return;
      sync();
    },
    setPackageFiles(name, files) {
      packages.set(name, files);
      version++;
      sync();
    },
    hasPackage(name) {
      return packages.has(name);
    },
    clearPackages() {
      packages.clear();
      version++;
      sync();
    },
    setLocalFiles(tabId, files) {
      local.set(tabId, files);
      version++;
      sync();
    },
    clearLocal(tabId) {
      if (tabId === undefined) local.clear();
      else local.delete(tabId);
      version++;
      sync();
    },
    libPaths() {
      return appliedPaths;
    },
  };
}
```

`apps/ui/vite-plugins/type-libs-plugin.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import type { Plugin } from "vite";

type TypeFile = { path: string; content: string };
type Pack = "node" | "bun";

/** The pinned packages behind each runtime pack (spec §5.2, §6.2). `@types/node` imports `undici-types`. */
export const TYPE_LIB_PACKS: Record<Pack, readonly string[]> = {
  node: ["@types/node", "undici-types"],
  bun: ["bun-types"],
};

/** Both packs together stay below this many characters of declaration source. */
export const MAX_TYPE_LIB_BYTES = 8_000_000;

export function resolvePackageDir(name: string, fromDir: string): string {
  return dirname(createRequire(join(fromDir, "package.json")).resolve(`${name}/package.json`));
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".d.ts") || path === join(dir, "package.json")) out.push(path);
  }
}

/** Every `.d.ts` and the package.json of each package, at `file:///node_modules/<name>/<path>`. */
export function collectTypeLibPack(packages: readonly { name: string; dir: string }[]): TypeFile[] {
  const files: TypeFile[] = [];
  for (const pkg of packages) {
    const paths: string[] = [join(pkg.dir, "package.json")];
    walk(pkg.dir, paths);
    for (const path of [...new Set(paths)].sort()) {
      if (path !== join(pkg.dir, "package.json") && !path.endsWith(".d.ts")) continue;
      files.push({ path: `file:///node_modules/${pkg.name}/${relative(pkg.dir, path)}`, content: readFileSync(path, "utf8") });
    }
  }
  return files;
}

const PREFIX = "virtual:jslab-type-libs/";

/** Serves `virtual:jslab-type-libs/<pack>` as `export default [...]`; a dynamic import becomes its own chunk. */
export function jslabTypeLibs(root: string = join(import.meta.dirname, "..")): Plugin {
  return {
    name: "jslab-type-libs",
    resolveId(id: string) {
      return id.startsWith(PREFIX) ? `\0${id}` : null;
    },
    load(id: string) {
      if (!id.startsWith(`\0${PREFIX}`)) return null;
      const pack = id.slice(PREFIX.length + 1) as Pack;
      const names = TYPE_LIB_PACKS[pack];
      if (!names) return null;
      return `export default ${JSON.stringify(collectTypeLibPack(names.map((name) => ({ name, dir: resolvePackageDir(name, root) }))))};`;
    },
  };
}
```

`apps/ui/src/editor/type-libs.ts`:

```ts
import type { TypeFile } from "@jslab/rpc-schema";
import type { RuntimePack } from "./ts-environment";

/** Loads a bundled runtime type pack (a lazily loaded Vite chunk, spec §6.2). Only Editor.tsx imports this module. */
export async function loadRuntimePack(pack: RuntimePack): Promise<readonly TypeFile[]> {
  const module = pack === "bun" ? await import("virtual:jslab-type-libs/bun") : await import("virtual:jslab-type-libs/node");
  return module.default;
}
```

Append to `apps/ui/src/vite-env.d.ts`:

```ts

/** Bundled runtime type packs (apps/ui/vite-plugins/type-libs-plugin.ts, spec §6.2). */
declare module "virtual:jslab-type-libs/*" {
  const files: { path: string; content: string }[];
  export default files;
}
```

`apps/ui/vite.config.ts`: add `import { jslabTypeLibs } from "./vite-plugins/type-libs-plugin";` and change `plugins: [react()],` to `plugins: [react(), jslabTypeLibs()],`.

`apps/ui/src/editor/monaco-setup.ts`: replace `import { EDITOR_TS_LIB } from "./ts-lib";` with `import { DEFAULT_RUNTIME } from "@jslab/shared";` and `import { compilerOptionsFor, diagnosticsOptionsFor } from "./ts-environment";`. Replace everything from `const ts = monaco.typescript;` through the closing brace of the `for` loop with:

```ts
  // The starting point before any tab is shown; Editor.tsx's TsEnvironment applies each shown tab's options (Task 21).
  const ts = monaco.typescript;
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptionsFor(DEFAULT_RUNTIME, "2023-11") as monaco.typescript.CompilerOptions);
    defaults.setDiagnosticsOptions(diagnosticsOptionsFor(true));
  }
```

Merge the new `@jslab/shared` import with the existing `import type { Language } from "@jslab/shared";` as `import { DEFAULT_RUNTIME, type Language } from "@jslab/shared";`.

Replace the R-M2-BUG-1 constant with `libFor`, and keep PR #1's worker regression test:

```bash
git rm apps/ui/src/editor/ts-lib.ts
git mv apps/ui/test/ts-lib.test.ts apps/ui/test/monaco-lib-names.test.ts
```

In `apps/ui/test/monaco-lib-names.test.ts` (PR #1's regression test at the M3 base), make only these changes:
- Replace its `EDITOR_TS_LIB` import from `../src/editor/ts-lib` with `import { DEFAULT_RUNTIME } from "@jslab/shared";` and `import { libFor } from "../src/editor/ts-environment";`. Replace each use of `EDITOR_TS_LIB` with `libFor(DEFAULT_RUNTIME)`, which gives the same three full file names.
- If it constructs Monaco's `TypeScriptWorker` inline, call `workerDiagnostics` from `./ts-worker` instead (the same worker, options and file). Drop any module declarations that `test/monaco-internals.d.ts` now provides.

Its assertions and its test count stay unchanged. If the file doesn't match this description, stop and report its outline; the controller rules on the merge (R-M3-TS-2).

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun test ./test/ts-environment.test.ts ./test/type-libs-plugin.test.ts ./test/monaco-lib-names.test.ts`
Expected: PASS, 0 fail: 8 tests from the two new files, plus exactly the number `ts-lib.test.ts` had at the M3 base.

If the `TypeScriptWorker` test lists a different set (for example `console` flagged in `bun`), stop. Report the three arrays and, for the failing runtime, the first five diagnostics' codes and messages. Don't change the expectations or fall back to short lib names; the controller rules (R-M3-TS-1).

- [ ] **Step 5: Run every gate and check the build output**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/ui` M2 final + 13 (no test was deleted: PR #1's regression test moved).

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:ui && ls -la dist/mainview/assets | grep -i -e "jslab-type-libs" -e "\.js$" | head -20`
Expected: the build exits 0 and lists two extra JS chunks, one per pack (names containing `jslab-type-libs`). The main entry chunk's size is within 1% of its size before this task (the packs aren't in it).

- [ ] **Step 6: Commit**

```bash
git add apps/ui bun.lock
git commit -m "feat(ui): per-runtime typescript options with bundled node and bun types" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 21: Editor wiring: re-apply on show, linting, model swap order, E2E type hooks

**Files:**
- Create: `apps/ui/src/editor/ts-state.ts`
- Modify: `apps/ui/src/editor/models.ts:24-32` (`ensure`), `apps/ui/src/editor/tab-view.ts:79-92` (`render`)
- Modify: `apps/ui/src/editor/Editor.tsx:1-15` (imports), `:42-58` (setup), `:148-157` (`onShown`), `:167-247` (handle), `:265-292` (subscription)
- Modify: `apps/ui/src/editor/editor-handle.ts`, `apps/ui/src/e2e/agent.ts:9-23` (deps), `:65-83` (`command`, `state`), `apps/ui/src/shell/App.tsx:279-298` (agent deps)
- Test: `apps/ui/test/ts-state.test.ts`, `apps/ui/test/tab-view.test.ts` (append), `apps/ui/test/editor-models.test.ts:50-60`, `apps/ui/test/e2e-agent.test.ts` (append), `packages/e2e/scenarios/typescript.test.ts`

**Interfaces:**
- Consumes: `createTsEnvironment`, `TsEnvironmentState` (Task 20); `loadRuntimePack` (Task 20); `AppState` (`state/store.ts`).
- Produces:
  - `tsStateFor(state: Pick<AppState, "activeTabId" | "tabs" | "settings">): TsEnvironmentState | null`
  - `ModelCache.ensure` returns `{ model: M; recreated: boolean; previous: M | null }` and no longer disposes; `createTabView` disposes `previous` after the swap (T12-m3)
  - `interface TsDiagnostic { code: number; message: string; line: number }`; `EditorHandle.typeDiagnostics(): Promise<TsDiagnostic[]>`; `EditorHandle.completionsAt(offset: number): Promise<string[]>`
  - `E2EAgentDeps.tsDiagnostics?(): Promise<TsDiagnostic[]>`, `E2EAgentDeps.completions?(offset: number): Promise<string[]>`; `e2e.state` gains `tsDiagnostics`; `E2E_COMPLETIONS = "e2e.completions"` returns `{ executed, completions }`
  - Task 23 gets the Editor's `TsEnvironment` instance through the same effect scope.

**Rules (spec §6.1, §6.3, §6.5; carries T12-m1, T12-m3, `editor.linting` wiring; parity ED-08..12, ED-14):**
- The shown tab's `TsEnvironmentState` is applied:
  - when a tab is shown;
  - when the active tab's runtime changes;
  - when `build.decorators` changes;
  - when `editor.linting` changes.
- On a language change, the tab's new model is attached before the old one is disposed, so Monaco never holds a disposed model (T12-m3).
- A closed tab's pending view-state save is flushed by the switch or cancelled by the prune, never persisted after the close (T12-m1 pinning tests).
- The E2E hooks read Monaco's own TypeScript markers (owner `typescript` or `javascript`) and completions from the TypeScript worker. They are exposed only through the E2E agent.

- [ ] **Step 1: Write the failing tests**

`apps/ui/test/ts-state.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createTab, defaultSettings, mergeSettings } from "@jslab/shared";
import { tsStateFor } from "../src/editor/ts-state";

describe("tsStateFor", () => {
  test("describes the shown tab's runtime, decorators and linting, or null without a tab or settings", () => {
    const settings = mergeSettings(defaultSettings(), { build: { decorators: "legacy" }, editor: { linting: false } });
    const tabs = { a: createTab({ id: "a", runtime: "bun" }) };
    expect(tsStateFor({ activeTabId: "a", tabs, settings })).toEqual({ tabId: "a", runtime: "bun", decorators: "legacy", linting: false });
    expect(tsStateFor({ activeTabId: null, tabs, settings })).toBeNull();
    expect(tsStateFor({ activeTabId: "a", tabs, settings: null })).toBeNull();
  });
});
```

In `apps/ui/test/editor-models.test.ts`, replace the language-change expectation (line 59) with:

```ts
    expect([tsx.model.value, tsx.model.language, tsx.previous, first.model.disposed]).toEqual(["edited", "tsx", first.model, false]);
```

Append to `apps/ui/test/tab-view.test.ts`, inside `describe("tab view", …)`:

```ts
  function twoTabs(active: "a" | "b" = "a") {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: normalizeSession(
        sessionSchema.parse({
          tabOrder: ["a", "b"],
          activeTabId: active,
          tabs: { a: createTab({ id: "a" }), b: createTab({ id: "b" }) },
        }),
      ),
      buffers: { a: "const a = 1", b: "const b = 2" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    return store;
  }

  function manualTimers() {
    const pending: (() => void)[] = [];
    return {
      timers: { setTimeout: (callback: () => void) => pending.push(callback), clearTimeout: () => {} },
      fire: () => pending.splice(0).forEach((callback) => callback()),
    };
  }

  test("closing the active tab flushes its view state once on the switch and never after the prune (T12-m1)", async () => {
    const store = twoTabs("a");
    const editor = new FakeEditor();
    const models = new ModelCache((_id, language: Language, value: string) => new FakeModel(value, language));
    const persist = mock((_tabId: string, _viewState: FakeViewState | null) => {});
    const { timers, fire } = manualTimers();
    const view = createTabView({ store, editor, models, persist, onShown: () => {}, timers });
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.activeTabId !== previous.activeTabId || state.tabs !== previous.tabs || state.buffers !== previous.buffers) view.show(state);
      if (state.tabOrder !== previous.tabOrder) for (const closed of models.prune(new Set(state.tabOrder))) view.cancel(closed);
    });
    view.show(store.getState());
    view.saveActive();
    store.getState().removeTab("a", "b");
    fire();
    await Promise.resolve();
    expect(persist.mock.calls.map((call) => call[0])).toEqual(["a"]);
    expect(editor.model?.getValue()).toBe("const b = 2");
    unsubscribe();
  });

  test("closing the last tab cancels its pending view-state save (T12-m1)", async () => {
    const store = twoTabs("a");
    store.getState().removeTab("b", "a");
    const editor = new FakeEditor();
    const models = new ModelCache((_id, language: Language, value: string) => new FakeModel(value, language));
    const persist = mock(() => {});
    const { timers, fire } = manualTimers();
    const view = createTabView({ store, editor, models, persist, onShown: () => {}, timers });
    view.show(store.getState());
    view.saveActive();
    store.getState().removeTab("a", null);
    view.show(store.getState());
    for (const closed of models.prune(new Set(store.getState().tabOrder))) view.cancel(closed);
    fire();
    await Promise.resolve();
    expect(persist).not.toHaveBeenCalled();
    expect(editor.model).toBeNull();
  });

  test("a language change attaches the new model before the old one is disposed (T12-m3)", () => {
    const store = twoTabs("a");
    let swappedFromDisposed = false;
    class WatchingEditor extends FakeEditor {
      override setModel(model: FakeModel | null) {
        if ((this.model as (FakeModel & { disposed?: boolean }) | null)?.disposed) swappedFromDisposed = true;
        super.setModel(model);
      }
    }
    class DisposableModel extends FakeModel {
      disposed = false;
      override dispose() {
        this.disposed = true;
      }
    }
    const editor = new WatchingEditor();
    const models = new ModelCache((_id, language: Language, value: string) => new DisposableModel(value, language));
    const view = createTabView({ store, editor, models, persist: () => {}, onShown: () => {}, timers: manualTimers().timers });
    view.show(store.getState());
    const first = editor.model as DisposableModel;
    store.getState().setLanguage("tsx");
    view.show(store.getState());
    expect(swappedFromDisposed).toBe(false);
    expect(first.disposed).toBe(true);
    expect(editor.model).not.toBe(first);
  });
```

Append to `apps/ui/test/e2e-agent.test.ts`, inside `describe("E2E agent", …)`:

```ts
  test("state carries TypeScript diagnostics, and e2e.completions asks the editor for completions", async () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "[1].m" },
      safeMode: { active: false, reason: null },
      versions: { app: "0.0.1", bun: "1.4.0" },
    });
    const agent = createE2EAgent({
      store,
      executeCommand: () => "unknown",
      editor: () => null,
      target: () => new EventTarget(),
      tsDiagnostics: async () => [{ code: 2322, message: "Type 'string' is not assignable to type 'number'.", line: 1 }],
      completions: async (offset) => (offset === 5 ? ["map"] : []),
    });
    expect(await agent("state", {})).toMatchObject({ tsDiagnostics: [{ code: 2322, line: 1 }] });
    expect(await agent("command", { id: "e2e.completions", args: { offset: 5 } })).toEqual({ executed: "e2e.completions", completions: ["map"] });
  });
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun test ./test/ts-state.test.ts ./test/tab-view.test.ts ./test/editor-models.test.ts ./test/e2e-agent.test.ts`
Expected: FAIL: `Cannot find module "../src/editor/ts-state"`; `tsx.previous` is undefined and `first.model.disposed` is true; the T12-m3 test sees a swap from a disposed model; the agent has no `tsDiagnostics`. The two T12-m1 tests pass already: they pin the current ordering.

- [ ] **Step 2: Implement the model order, the state helper and the handle**

`apps/ui/src/editor/models.ts`: replace `ensure` with:

```ts
  /**
   * Returns the tab's model; a language change creates a new one from the current content. The previous model is
   * returned undisposed: the caller attaches the new model first, then disposes it (T12-m3).
   */
  ensure(tabId: string, language: Language, value: string): { model: M; recreated: boolean; previous: M | null } {
    const entry = this.#entries.get(tabId);
    if (entry && entry.language === language) return { model: entry.model, recreated: false, previous: null };
    const model = this.create(tabId, language, entry ? entry.model.getValue() : value);
    this.#entries.set(tabId, { model, language });
    return { model, recreated: entry !== undefined, previous: entry?.model ?? null };
  }
```

`apps/ui/src/editor/tab-view.ts`: in `render`, change `const { model } = deps.models.ensure(id, tab.language, state.buffers[id] ?? "");` to `const { model, previous } = deps.models.ensure(id, tab.language, state.buffers[id] ?? "");`, and directly after the closing brace of `if (deps.editor.getModel() !== model) { … }` add:

```ts
    // T12-m3: the new model is attached (above) before the old one goes away.
    previous?.dispose();
```

`apps/ui/src/editor/ts-state.ts`:

```ts
import type { AppState } from "../state/store";
import type { TsEnvironmentState } from "./ts-environment";

/** What the editor's TypeScript environment must match: the shown tab and two settings (spec §6.1). */
export function tsStateFor(state: Pick<AppState, "activeTabId" | "tabs" | "settings">): TsEnvironmentState | null {
  const tab = state.activeTabId ? state.tabs[state.activeTabId] : undefined;
  if (!tab || !state.settings) return null;
  return {
    tabId: tab.id,
    runtime: tab.runtime,
    decorators: state.settings.build.decorators,
    linting: state.settings.editor.linting,
  };
}
```

`apps/ui/src/editor/editor-handle.ts`: add before `EditorHandle`:

```ts
export interface TsDiagnostic {
  code: number;
  message: string;
  line: number;
}
```

and add to `EditorHandle`:

```ts
  /** Monaco's current TypeScript markers for the shown model (E2E verification). */
  typeDiagnostics(): Promise<TsDiagnostic[]>;
  /** TypeScript completion names at an offset in the shown model (E2E verification). */
  completionsAt(offset: number): Promise<string[]>;
```

`apps/ui/src/editor/Editor.tsx`:

1. Add imports: `import { createTsEnvironment } from "./ts-environment";`, `import { tsStateFor } from "./ts-state";`, `import { loadRuntimePack } from "./type-libs";`.
2. After `const editor = monaco.editor.create(…);`, add:

```ts
    // Spec §6.1: Monaco's TypeScript defaults are global, so they follow the shown tab.
    const tsEnvironment = createTsEnvironment({
      defaults: [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults],
      loadPack: loadRuntimePack,
    });
    const applyTypeScript = (state: AppState) => {
      const next = tsStateFor(state);
      if (next) void tsEnvironment.apply(next);
    };
```

3. In `onShown`, after `applyHover(store.getState().hoveredLine);`, add `applyTypeScript(store.getState());`.
4. In the `setEditorHandle({ … })` object, after `flushViewState`, add:

```ts
      typeDiagnostics: async () => {
        const model = editor.getModel();
        if (!model) return [];
        return monaco.editor
          .getModelMarkers({ resource: model.uri })
          .filter((marker) => marker.owner === "typescript" || marker.owner === "javascript")
          .map((marker) => ({
            code: Number(typeof marker.code === "object" ? marker.code?.value : marker.code),
            message: marker.message,
            line: marker.startLineNumber,
          }));
      },
      completionsAt: async (offset) => {
        const model = editor.getModel();
        if (!model) return [];
        const getWorker =
          model.getLanguageId() === "javascript" ? monaco.typescript.getJavaScriptWorker : monaco.typescript.getTypeScriptWorker;
        const worker = await (await getWorker())(model.uri);
        const info = (await worker.getCompletionsAtPosition(model.uri.toString(), offset)) as
          | { entries?: { name: string }[] }
          | undefined;
        return (info?.entries ?? []).map((entry) => entry.name);
      },
```

5. In the store subscription, after the `if ((state.settings !== previous.settings || …) && state.settings) { … }` block, add:

```ts
      if (
        state.activeTabId !== previous.activeTabId ||
        state.tab?.runtime !== previous.tab?.runtime ||
        state.settings?.build.decorators !== previous.settings?.build.decorators ||
        state.settings?.editor.linting !== previous.settings?.editor.linting
      ) {
        applyTypeScript(state);
      }
```

`apps/ui/src/e2e/agent.ts`:

1. Add `import type { TsDiagnostic } from "../editor/editor-handle";`.
2. Add to `E2EAgentDeps`:

```ts
  /** Monaco's TypeScript markers for the shown tab (Task 21). */
  tsDiagnostics?(): Promise<TsDiagnostic[]>;
  completions?(offset: number): Promise<string[]>;
```

3. After `export const E2E_OPEN_LINK = "e2e.openLink";` add `export const E2E_COMPLETIONS = "e2e.completions";`.
4. In `case "command":`, after the `E2E_OPEN_LINK` line, add:

```ts
        if (id === E2E_COMPLETIONS) {
          const offset = Number((args as { offset?: unknown } | undefined)?.offset ?? 0);
          return { executed: E2E_COMPLETIONS, completions: (await deps.completions?.(offset)) ?? [] };
        }
```

5. In `case "state":`, add `tsDiagnostics: (await deps.tsDiagnostics?.()) ?? [],` after `registeredCommands`.

`apps/ui/src/shell/App.tsx`: in the `createE2EAgent({ … })` call, add:

```ts
      tsDiagnostics: () => getEditorHandle()?.typeDiagnostics() ?? Promise.resolve([]),
      completions: (offset) => getEditorHandle()?.completionsAt(offset) ?? Promise.resolve([]),
```

- [ ] **Step 3: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun run test`
Expected: PASS, 0 fail.

- [ ] **Step 4: Add the scenarios**

`packages/e2e/scenarios/typescript.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface TsDiagnostic {
  code: number;
  message: string;
  line: number;
}

const CODE = [
  "console.log(typeof setTimeout);",
  "const platform: string = process.platform;",
  "Bun.version;",
  "document.title;",
  'const wrong: number = "x";',
  "export {};",
].join("\n");

async function seedTabs(userData: string, tabs: { id: string; runtime: string; code: string }[]) {
  await mkdir(join(userData, "buffers"), { recursive: true });
  const session = {
    version: 2,
    tabOrder: tabs.map((tab) => tab.id),
    activeTabId: tabs[0]?.id,
    tabs: Object.fromEntries(
      tabs.map((tab) => [tab.id, { id: tab.id, title: tab.id, titleIsCustom: true, language: "typescript", runtime: tab.runtime }]),
    ),
  };
  await writeFile(join(userData, "session.json"), JSON.stringify(session));
  for (const tab of tabs) await writeFile(join(userData, "buffers", `${tab.id}.ts`), tab.code);
}

const flaggedNames = (diagnostics: TsDiagnostic[]) =>
  ["console", "setTimeout", "process", "Bun", "document"].filter((name) => diagnostics.some((d) => d.message.includes(`'${name}'`)));

async function diagnosticsFor(tabId: string): Promise<TsDiagnostic[]> {
  const current = app as LaunchedApp;
  return waitFor(
    async () => {
      const ui = (await current.state()).ui;
      const diagnostics = (ui.tsDiagnostics ?? []) as TsDiagnostic[];
      return ui.activeTabId === tabId && diagnostics.some((d) => d.code === 2322) ? diagnostics : null;
    },
    { timeoutMs: 30_000, message: `TypeScript diagnostics never arrived for ${tabId}` },
  );
}

describe("TypeScript in the editor (spec §6.1, ED-09, ED-14)", () => {
  test("each runtime gets its own libraries: console is never flagged, and Bun, process and document only where they exist", async () => {
    const userData = await createUserData();
    await seedTabs(userData, [
      { id: "bun-tab", runtime: "bun", code: CODE },
      { id: "node-tab", runtime: "browser-node", code: CODE },
      { id: "web-tab", runtime: "browser", code: CODE },
    ]);
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    expect(flaggedNames(await diagnosticsFor("bun-tab"))).toEqual(["document"]);
    await app.command("tab.next");
    expect(flaggedNames(await diagnosticsFor("node-tab"))).toEqual(["Bun"]);
    await app.command("tab.next");
    expect(flaggedNames(await diagnosticsFor("web-tab"))).toEqual(["process", "Bun"]);
  });

  test("autocomplete comes from the TypeScript worker, and Linting off clears diagnostics (ED-08, ED-09)", async () => {
    const userData = await createUserData();
    const code = 'const list = [1, 2];\nconst wrong: number = "x";\nlist.';
    await seedTabs(userData, [{ id: "bun-tab", runtime: "bun", code }]);
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    const current = app;
    await diagnosticsFor("bun-tab");
    const reply = await current.client.call<{ result: { completions: string[] } }>("e2e.command", {
      id: "e2e.completions",
      args: { offset: code.length },
    });
    expect(reply.result.completions).toEqual(expect.arrayContaining(["map", "filter"]));
    await current.key("cmd+,");
    await waitFor(async () => (await current.settingsState())?.ready || null, { timeoutMs: 45_000 });
    await current.settingsCommand("settings.set", { key: "editor.linting", value: false });
    await waitFor(async () => (((await current.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[]).length === 0 || null, {
      timeoutMs: 30_000,
      message: "diagnostics stayed after Linting was turned off",
    });
  });
});
```

- [ ] **Step 5: Run every gate, the new scenarios and the full suite**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/ui` M2 final + 18.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../.. && bun run e2e > "$TMPDIR/jslab-e2e.log" 2>&1` in the background, then poll with the Global Constraints one-liner.
Expected: every scenario passes, 0 fail. Scenarios: M2 final + 4 (quit-flush 1, settings-window 1, typescript 2). Read-only `ps` check: no survivors.

- [ ] **Step 6: Commit**

```bash
git add apps/ui packages/e2e/scenarios/typescript.test.ts
git commit -m "feat(ui): apply each tab's typescript environment and linting, swap models before disposing" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 22: MainApi additions, commands, keybindings and menus for Tools and working directory

**Files:**
- Modify: `packages/shared/src/commands.ts:1-39` (category), `:117-152` (commands)
- Modify: `packages/shared/src/keybindings.ts:176-241` (`DEFAULT_KEYBINDINGS`)
- Modify: `apps/desktop/src/main/menu.ts:164-191` (Actions), after it (Tools)
- Modify: `apps/ui/src/api.ts`, `apps/ui/src/rpc.ts`, `apps/ui/test/fake-api.ts`
- Modify: `apps/ui/src/state/store.ts:27-30` (`Modal`)
- Modify: `apps/ui/src/commands/app-commands.ts:124-131` (end of the returned list)
- Modify: `apps/ui/src/strings.ts:125-139` (`palette.categories`)
- Test: `packages/shared/test/commands.test.ts` (append), `apps/desktop/test/menu.test.ts` (append), `apps/ui/test/commands.test.ts` (append), `packages/e2e/scenarios/tools.test.ts`

**Interfaces:**
- Consumes: the Task 18 RPC contracts.
- Produces:
  - `CommandCategory` gains `"tools"`; `COMMAND_CATEGORY_ORDER` puts it after `"view"`.
  - Commands: `tools.npmPackages` ("NPM Packages…"), `tools.environmentVariables` ("Environment Variables…"), `wd.set` ("Set Working Directory…", category `run`), `wd.clear` ("Clear Working Directory", category `run`), `npm.install` ("Install Package", category `tools`, `palette: false`)
  - `DEFAULT_KEYBINDINGS` gains `{ key: "cmd+i", command: "tools.npmPackages" }`
  - `Modal` gains `{ kind: "npm" }` and `{ kind: "env" }`
  - `MainApi` gains `npmList(refreshOutdated: boolean): Promise<NpmListResult>`, `npmSearch(query: string): Promise<NpmSearchResponse>`, `npmInstall(spec: string): void`, `npmRemove(name: string): void`, `npmUpdate(name: string): void`, `npmUpdateAll(): void`, `packageTypes(tabId: string, packages: string[]): Promise<PackageTypesResult[]>`, `localTypes(tabId: string, specifiers: string[]): Promise<LocalTypesResult>`, `getEnv(): Promise<EnvVars>`, `saveEnv(variables: EnvVars): Promise<SaveResult>`, `pickWorkingDirectory(tabId: string): void`, `clearWorkingDirectory(tabId: string): void`
  - The menu gains, in Actions, **Set Working Directory…** (enabled with an active tab) and **Clear Working Directory** (enabled when the tab has a WD), and a **Tools** menu between Actions and View with **NPM Packages…** and **Environment Variables…**.

**Rules (spec §6.5 `Cmd+I`, §7.4 Actions and Tools, §11.2, §12.1, §12.2):** menus, keys, the palette and E2E all dispatch these ids through the one registry. The NPM Packages and Environment Variables UIs are modal sheets (decision 2), rendered in Tasks 25–26. `npm.install` takes `{ spec }` from install-assist actions and the NPM sheet.

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/commands.test.ts` inside `describe("command catalogue", …)` (add `DEFAULT_KEYBINDINGS` from `../src/keybindings`):

```ts
  test("M3 adds the Tools category, the working-directory commands and ⌘I for NPM Packages", () => {
    expect(COMMAND_CATEGORY_ORDER.indexOf("tools")).toBe(COMMAND_CATEGORY_ORDER.indexOf("view") + 1);
    expect(commandMeta("tools.npmPackages")).toMatchObject({ title: "NPM Packages…", category: "tools" });
    expect(commandMeta("tools.environmentVariables")).toMatchObject({ category: "tools" });
    expect(commandMeta("wd.set")).toMatchObject({ title: "Set Working Directory…", category: "run" });
    expect(commandMeta("wd.clear")).toMatchObject({ title: "Clear Working Directory", category: "run" });
    expect(commandMeta("npm.install")).toMatchObject({ palette: false });
    expect(DEFAULT_KEYBINDINGS.filter((rule) => rule.key === "cmd+i")).toEqual([{ key: "cmd+i", command: "tools.npmPackages" }]);
  });
```

Append to `apps/desktop/test/menu.test.ts` inside `describe("application menu", …)`:

```ts
  test("Actions has Set and Clear Working Directory, and Tools lists NPM Packages and Environment Variables (spec §7.4)", () => {
    const top = buildMenu(model()).map((item) => item.label);
    expect(top.indexOf("Tools")).toBe(top.indexOf("Actions") + 1);
    const withoutWd = buildMenu(model());
    expect(byLabel(withoutWd, "Set Working Directory…")?.enabled).toBe(true);
    expect(byLabel(withoutWd, "Clear Working Directory")?.enabled).toBe(false);
    const withWd = buildMenu(model({ activeTab: createTab({ id: "t1", workingDirectory: "/work/api" }) }));
    expect(byLabel(withWd, "Clear Working Directory")?.enabled).toBe(true);
    expect(byLabel(withWd, "NPM Packages…")?.label).toBe("NPM Packages…    ⌘I");
    expect(byLabel(withWd, "Environment Variables…")?.action).toBe(menuAction("tools.environmentVariables"));
  });
```

Append to `apps/ui/test/commands.test.ts` a new describe (add `createAppCommands` from `../src/commands/app-commands` to the imports):

```ts
describe("M3 app commands", () => {
  function setup(workingDirectory: string | null = null) {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", workingDirectory })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const { api } = createFakeApi();
    const registry = new CommandRegistry();
    registry.register(
      ...createAppCommands({ store, api, tabs: createTabActions(store, api), run: () => {}, editor: () => null }),
    );
    return { store, api, registry };
  }

  test("Tools commands open their sheets", () => {
    const { store, registry } = setup();
    registry.execute("tools.npmPackages");
    expect(store.getState().modal).toEqual({ kind: "npm" });
    registry.execute("tools.environmentVariables");
    expect(store.getState().modal).toEqual({ kind: "env" });
  });

  test("Set and Clear Working Directory reach Main for the active tab; Clear needs a WD", () => {
    const withoutWd = setup();
    withoutWd.registry.execute("wd.set");
    expect(withoutWd.api.pickWorkingDirectory).toHaveBeenCalledWith("t1");
    expect(withoutWd.registry.execute("wd.clear")).toBe("disabled");
    const withWd = setup("/work/api");
    expect(withWd.registry.execute("wd.clear")).toBe("executed");
    expect(withWd.api.clearWorkingDirectory).toHaveBeenCalledWith("t1");
  });

  test("npm.install sends a trimmed spec and ignores anything else", () => {
    const { api, registry } = setup();
    registry.execute("npm.install", { spec: " zod@4.6.4 " });
    registry.execute("npm.install", { spec: "" });
    registry.execute("npm.install", {});
    expect(api.npmInstall.mock.calls).toEqual([["zod@4.6.4"]]);
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/shared && bun test test/commands.test.ts`
Expected: FAIL, `commandMeta("tools.npmPackages")` is undefined.

- [ ] **Step 2: Implement the catalogue, bindings and menu**

`packages/shared/src/commands.ts`:

1. Add `| "tools"` to `CommandCategory` after `| "view"`, and `"tools",` to `COMMAND_CATEGORY_ORDER` after `"view",`.
2. Before `{ id: "runtime.bun", … }`, add:

```ts
  { id: "wd.set", title: "Set Working Directory…", category: "run" },
  { id: "wd.clear", title: "Clear Working Directory", category: "run" },

  { id: "tools.npmPackages", title: "NPM Packages…", category: "tools" },
  { id: "tools.environmentVariables", title: "Environment Variables…", category: "tools" },
  { id: "npm.install", title: "Install Package", category: "tools", palette: false },

```

`packages/shared/src/keybindings.ts`: in `DEFAULT_KEYBINDINGS`, after `{ key: "cmd+k", command: "output.clear" },` add `{ key: "cmd+i", command: "tools.npmPackages" },`.

`apps/desktop/src/main/menu.ts`: in the Actions `submenu`, after `item("format.document"),` and its following `separator,` add:

```ts
        item("wd.set", { enabled: activeTab !== null }),
        item("wd.clear", { enabled: Boolean(activeTab?.workingDirectory) }),
        separator,
```

and directly after the Actions menu object (before `{ label: "View", … }`), add:

```ts
    {
      label: "Tools",
      submenu: [item("tools.npmPackages"), item("tools.environmentVariables")],
    },
```

`apps/ui/src/strings.ts`: in `palette.categories`, add `tools: "Tools",` after `view: "View",`.

- [ ] **Step 3: Implement the MainApi additions, modal kinds and UI commands**

`apps/ui/src/api.ts`: extend the `@jslab/rpc-schema` import with `EnvVars`, `LocalTypesResult`, `NpmListResult`, `NpmSearchResponse`, `PackageTypesResult`, `SaveResult`, and add to `MainApi` before `appCommand`:

```ts
  npmList(refreshOutdated: boolean): Promise<NpmListResult>;
  npmSearch(query: string): Promise<NpmSearchResponse>;
  npmInstall(spec: string): void;
  npmRemove(name: string): void;
  npmUpdate(name: string): void;
  npmUpdateAll(): void;

  packageTypes(tabId: string, packages: string[]): Promise<PackageTypesResult[]>;
  localTypes(tabId: string, specifiers: string[]): Promise<LocalTypesResult>;

  getEnv(): Promise<EnvVars>;
  saveEnv(variables: EnvVars): Promise<SaveResult>;

  pickWorkingDirectory(tabId: string): void;
  clearWorkingDirectory(tabId: string): void;
```

`apps/ui/src/rpc.ts`: add before `appCommand`:

```ts
    npmList: (refreshOutdated) => rpc.request["npm.list"]({ refreshOutdated }),
    npmSearch: (query) => rpc.request["npm.search"]({ query }),
    npmInstall: (spec) => rpc.send["npm.install"]({ spec }),
    npmRemove: (name) => rpc.send["npm.remove"]({ name }),
    npmUpdate: (name) => rpc.send["npm.update"]({ name }),
    npmUpdateAll: () => rpc.send["npm.updateAll"]({}),
    packageTypes: (tabId, packages) => rpc.request["types.package"]({ tabId, packages }).then((reply) => reply.packages),
    localTypes: (tabId, specifiers) => rpc.request["types.local"]({ tabId, specifiers }),
    getEnv: () => rpc.request["env.get"]({}).then((reply) => reply.variables),
    saveEnv: (variables) => rpc.request["env.save"]({ variables }),
    pickWorkingDirectory: (tabId) => rpc.send["wd.pick"]({ tabId }),
    clearWorkingDirectory: (tabId) => rpc.send["wd.clear"]({ tabId }),
```

`apps/ui/test/fake-api.ts`: extend the `@jslab/rpc-schema` type import with `EnvVars`, `LocalTypesResult`, `NpmListResult`, `NpmSearchResponse`, `PackageTypesResult`, `SaveResult`, and add before `appCommand`:

```ts
    npmList: mock(async (_refreshOutdated: boolean): Promise<NpmListResult> => ({ installed: [], outdatedCheckedAt: null, outdatedError: null })),
    npmSearch: mock(async (_query: string): Promise<NpmSearchResponse> => ({ results: [], error: null })),
    npmInstall: mock((_spec: string) => {}),
    npmRemove: mock((_name: string) => {}),
    npmUpdate: mock((_name: string) => {}),
    npmUpdateAll: mock(() => {}),
    packageTypes: mock(async (_tabId: string, _packages: string[]): Promise<PackageTypesResult[]> => []),
    localTypes: mock(async (_tabId: string, _specifiers: string[]): Promise<LocalTypesResult> => ({ files: [], packages: [], truncated: false })),
    getEnv: mock(async (): Promise<EnvVars> => ({})),
    saveEnv: mock(async (_variables: EnvVars): Promise<SaveResult> => ({ ok: true })),
    pickWorkingDirectory: mock((_tabId: string) => {}),
    clearWorkingDirectory: mock((_tabId: string) => {}),
```

`apps/ui/src/state/store.ts`: change `Modal` to:

```ts
export type Modal =
  | { kind: "palette"; context: "editor" | "output" }
  | { kind: "confirm"; id: string; title: string; message: string; buttons: ConfirmButton[] }
  | { kind: "rename"; tabId: string }
  | { kind: "npm" }
  | { kind: "env" };
```

`apps/ui/src/commands/app-commands.ts`: at the end of the returned array, after `{ id: "view.toggleFullScreen", … },`, add:

```ts

    // M3: Tools sheets (spec §11.2, §12.1) and the working directory (spec §12.2).
    { id: "tools.npmPackages", run: () => s().openModal({ kind: "npm" }) },
    { id: "tools.environmentVariables", run: () => s().openModal({ kind: "env" }) },
    { id: "wd.set", isEnabled: () => s().activeTabId !== null, run: withActiveTab((id) => deps.api.pickWorkingDirectory(id)) },
    {
      id: "wd.clear",
      isEnabled: () => Boolean(s().tab?.workingDirectory),
      run: withActiveTab((id) => deps.api.clearWorkingDirectory(id)),
    },
    {
      id: "npm.install",
      run: (args) => {
        const spec = (args as { spec?: unknown } | undefined)?.spec;
        if (typeof spec === "string" && spec.trim()) deps.api.npmInstall(spec.trim());
      },
    },
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/shared && bun test && builtin cd ../../apps/desktop && bun test test/menu.test.ts && builtin cd ../ui && bun run test`
Expected: PASS, 0 fail.

- [ ] **Step 5: Add the scenario**

`packages/e2e/scenarios/tools.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface Item {
  label?: string;
  enabled?: boolean;
  submenu?: Item[];
}
const flatten = (items: Item[]): Item[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);

test("⌘I opens NPM Packages, Tools opens Environment Variables, and the menus list the M3 items (TL-01, spec §7.4)", async () => {
  app = await launchApp();
  const current = app;
  await current.key("cmd+i");
  await waitFor(async () => (await current.state()).ui.modal === "npm" || null);
  await current.command("tools.environmentVariables");
  await waitFor(async () => (await current.state()).ui.modal === "env" || null);
  const menu = flatten((await current.state()).main.menu as Item[]);
  expect(menu.find((item) => item.label?.startsWith("NPM Packages…"))?.label).toBe("NPM Packages…    ⌘I");
  expect(menu.find((item) => item.label === "Set Working Directory…")?.enabled).toBe(true);
  expect(menu.find((item) => item.label === "Clear Working Directory")?.enabled).toBe(false);
});
```

- [ ] **Step 6: Run every gate and the scenarios**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/shared` M2 final + 9; `@jslab/desktop` M2 final + 48; `@jslab/ui` M2 final + 21.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/tools.test.ts ./scenarios/menu.test.ts ./scenarios/palette.test.ts ./scenarios/keybindings.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: all pass, 0 fail. Scenarios: M2 final + 5. Read-only `ps` check: no survivors.

- [ ] **Step 7: Commit**

```bash
git add packages/shared apps/desktop/src/main/menu.ts apps/desktop/test/menu.test.ts apps/ui packages/e2e/scenarios/tools.test.ts
git commit -m "feat(ui): tools and working-directory commands, cmd+i and the tools menu" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 23: Type feeder and install assist

**Files:**
- Create: `apps/ui/src/editor/type-feeder.ts`, `apps/ui/src/editor/install-assist.ts`
- Modify: `apps/ui/package.json` (`dependencies`), `bun.lock`
- Modify: `apps/ui/src/state/store.ts` (`packagesRevision`, `bumpPackagesRevision`)
- Modify: `apps/ui/src/editor/Editor.tsx` (props, feeder, install assist, handle), `apps/ui/src/editor/editor-handle.ts`
- Modify: `apps/ui/src/output/EntryRow.tsx:8-15` (props), `:94-120` (`ErrorBody`), `apps/ui/src/output/OutputPanel.tsx:120-127`
- Modify: `apps/ui/src/e2e/agent.ts`, `apps/ui/src/shell/App.tsx` (agent deps, `npm.changed`)
- Modify: `apps/ui/src/strings.ts` (`install`, `output.installPackage`)
- Test: `apps/ui/test/type-feeder.test.ts`, `apps/ui/test/install-assist.test.ts`, `apps/ui/test/entry-row.test.tsx` (append), `apps/ui/test/e2e-agent.test.ts` (append), `packages/e2e/scenarios/types-local.test.ts`

**Interfaces:**
- Consumes:
  - `packageNameFromSpecifier`, `typesPackageName` from `@jslab/npm/specifiers` (Task 7)
  - `TsEnvironment` (Task 20)
  - `MainApi.packageTypes`, `localTypes`, `npmInstall` (Task 22)
  - the TypeScript marker owners (Task 21)
- Produces:
  - `type-feeder.ts`:
    - `TYPE_FEED_DELAY_MS = 500`
    - `importSpecifiers(code: string): { packages: string[]; relative: string[] }`
    - `interface TypeFeederDeps { requestPackages(tabId: string, names: string[]): Promise<PackageTypesResult[]>; requestLocal(tabId: string, specifiers: string[]): Promise<LocalTypesResult>; environment: Pick<TsEnvironment, "setPackageFiles" | "clearPackages" | "setLocalFiles" | "clearLocal">; timers?: TimerApi; delayMs?: number; log?(message: string, detail?: unknown): void }`
    - `interface TypeFeeder { schedule(tabId: string, code: string, hasWorkingDirectory: boolean): void; untyped(): ReadonlyMap<string, string | null>; invalidatePackages(): void; invalidateLocal(tabId: string): void; dispose(): void }`
    - `createTypeFeeder(deps: TypeFeederDeps): TypeFeeder`
  - `install-assist.ts`:
    - `MISSING_MODULE_CODE = 2307`
    - `interface InstallAction { title: string; spec: string }`
    - `missingModuleFromMessage(message: string): string | null`
    - `runtimeMissingPackage(message: string): string | null`
    - `installActionsFor(markers: readonly { code: number | string; message: string }[], untyped: ReadonlyMap<string, string | null>): InstallAction[]`
    - `registerInstallAssist(monaco: typeof Monaco, deps: { untyped(): ReadonlyMap<string, string | null>; install(spec: string): void }): { dispose(): void }`
  - Store: `packagesRevision: number`; `bumpPackagesRevision(): void`
  - `EditorHandle.installActions(): Promise<InstallAction[]>`
  - `EntryRow` prop `onInstall?(name: string): void`
  - E2E: agent command `e2e.installActions` → `{ executed, actions }`

**Rules (spec §6.2, §6.3, §11.4; parity ED-13, ED-26, XT-12):**
- **Import scan.** The UI scans the shown model's imports, debounced 500 ms. Bare specifiers become package names (`@a/b/c` → `@a/b`; built-ins, `node:` and `bun` are ignored).
  - Each package is requested once, until packages change. Its files are registered with `addExtraLib` through the `TsEnvironment`, and its declared dependencies are requested too.
  - With a WD, relative specifiers are sent to `types.local`: the files returned are registered for that tab, and the bare packages they import are requested.
  - Without a WD, the tab's local files are cleared.
- **Invalidation.** A package change (`npm.changed`) invalidates every package type. A WD change invalidates that tab's local types and the package cache (WD `node_modules` may differ).
- **Install assist.** A TS 2307 "Cannot find module 'x'" marker offers **Install package x**. When `x` is installed but has no types, it offers **Install @types/x** instead.
  - A runtime error "Cannot find package 'x'" or "Cannot find module 'x'" shows an **Install x** button on the output row.
  - Every action dispatches `npm.install` with the spec.
  - `npm.autoInstallTypes` is applied in Main (Task 12).

- [ ] **Step 1: Add the dependency**

In `apps/ui/package.json` `dependencies`, add `"@jslab/npm": "workspace:*"`.
Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun install`
Expected: exit 0; `bun.lock` gains only the workspace link.

- [ ] **Step 2: Write the failing tests**

`apps/ui/test/type-feeder.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { LocalTypesResult, PackageTypesResult, TypeFile } from "@jslab/rpc-schema";
import type { TimerApi } from "../src/state/auto-run";
import { createTypeFeeder, importSpecifiers } from "../src/editor/type-feeder";

function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: TimerApi = {
    setTimeout: (callback) => {
      const id = next++;
      pending.set(id, callback);
      return id;
    },
    clearTimeout: (id) => void pending.delete(id as number),
  };
  return { timers, fire: async () => { for (const [id, callback] of [...pending]) { pending.delete(id); callback(); } await Bun.sleep(5); } };
}

const result = (name: string, patch: Partial<PackageTypesResult> = {}): PackageTypesResult => ({
  name,
  files: [{ path: `file:///node_modules/${name}/index.d.ts`, content: "" }],
  dependencies: [],
  typesPackage: null,
  hasTypes: true,
  truncated: false,
  ...patch,
});

function fakeEnvironment() {
  const packages = new Map<string, readonly TypeFile[]>();
  const local = new Map<string, readonly TypeFile[]>();
  return {
    packages,
    local,
    environment: {
      setPackageFiles: (name: string, files: readonly TypeFile[]) => void packages.set(name, files),
      clearPackages: () => packages.clear(),
      setLocalFiles: (tabId: string, files: readonly TypeFile[]) => void local.set(tabId, files),
      clearLocal: (tabId?: string) => (tabId === undefined ? local.clear() : void local.delete(tabId)),
    },
  };
}

describe("type feeder (spec §6.2)", () => {
  test("finds bare packages and relative specifiers in static, dynamic, require and side-effect imports", () => {
    expect(
      importSpecifiers(
        [
          'import { z } from "zod";',
          'import "@acme/tool/register";',
          'const lodash = require("lodash/fp");',
          'const util = await import("./util");',
          'export * from "../shared/types.js";',
          'import fs from "node:fs";',
          'import path from "path";',
        ].join("\n"),
      ),
    ).toEqual({ packages: ["@acme/tool", "lodash", "zod"], relative: ["../shared/types.js", "./util"] });
  });

  test("requests each package once after the delay, registers its files and follows its dependencies", async () => {
    const { timers, fire } = manualTimers();
    const { packages, environment } = fakeEnvironment();
    const requestPackages = mock(async (_tabId: string, names: string[]) =>
      names.map((name) => (name === "zod" ? result("zod", { dependencies: ["zod-core"] }) : result(name))),
    );
    const feeder = createTypeFeeder({ requestPackages, requestLocal: async () => ({ files: [], packages: [], truncated: false }), environment, timers });
    feeder.schedule("t1", 'import { z } from "zod";', false);
    feeder.schedule("t1", 'import { z } from "zod";\nimport x from "zod";', false);
    expect(requestPackages).not.toHaveBeenCalled();
    await fire();
    expect(requestPackages.mock.calls).toEqual([["t1", ["zod"]], ["t1", ["zod-core"]]]);
    expect([...packages.keys()]).toEqual(["zod", "zod-core"]);
    feeder.schedule("t1", 'import { z } from "zod";', false);
    await fire();
    expect(requestPackages).toHaveBeenCalledTimes(2);
    feeder.invalidatePackages();
    expect(packages.size).toBe(0);
    feeder.schedule("t1", 'import { z } from "zod";', false);
    await fire();
    expect(requestPackages).toHaveBeenCalledTimes(4);
  });

  test("with a working directory, relative imports are fed as local files and their packages requested", async () => {
    const { timers, fire } = manualTimers();
    const { packages, local, environment } = fakeEnvironment();
    const requestLocal = mock(
      async (_tabId: string, _specifiers: string[]): Promise<LocalTypesResult> => ({
        files: [{ path: "file:///tab/util.ts", content: "export const a = 1;" }],
        packages: ["zod"],
        truncated: false,
      }),
    );
    const feeder = createTypeFeeder({ requestPackages: async (_t, names) => names.map((name) => result(name)), requestLocal, environment, timers });
    feeder.schedule("t1", 'import { a } from "./util";', true);
    await fire();
    expect(requestLocal.mock.calls).toEqual([["t1", ["./util"]]]);
    expect(local.get("t1")?.map((file) => file.path)).toEqual(["file:///tab/util.ts"]);
    expect([...packages.keys()]).toEqual(["zod"]);
    feeder.schedule("t1", 'import { a } from "./util";', false);
    await fire();
    expect(local.has("t1")).toBe(false);
  });

  test("remembers installed packages without types and the @types package to offer", async () => {
    const { timers, fire } = manualTimers();
    const { environment } = fakeEnvironment();
    const feeder = createTypeFeeder({
      requestPackages: async () => [result("untyped", { files: [], hasTypes: false, typesPackage: "@types/untyped" })],
      requestLocal: async () => ({ files: [], packages: [], truncated: false }),
      environment,
      timers,
    });
    feeder.schedule("t1", 'import u from "untyped";', false);
    await fire();
    expect([...feeder.untyped()]).toEqual([["untyped", "@types/untyped"]]);
  });
});
```

`apps/ui/test/install-assist.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { installActionsFor, runtimeMissingPackage } from "../src/editor/install-assist";
import { strings } from "../src/strings";

describe("install assist (spec §6.3, §11.4)", () => {
  test("2307 markers offer the package, or its @types package when it is installed without types", () => {
    const markers = [
      { code: "2307", message: "Cannot find module 'zod' or its corresponding type declarations." },
      { code: 2307, message: "Cannot find module '@acme/tool/register' or its corresponding type declarations." },
      { code: "2307", message: "Cannot find module 'untyped' or its corresponding type declarations." },
      { code: "2307", message: "Cannot find module './local' or its corresponding type declarations." },
      { code: "2307", message: "Cannot find module 'node:fs' or its corresponding type declarations." },
      { code: "2322", message: "Type 'string' is not assignable to type 'number'." },
    ];
    expect(installActionsFor(markers, new Map([["untyped", "@types/untyped"]]))).toEqual([
      { title: strings.install.package("zod"), spec: "zod" },
      { title: strings.install.package("@acme/tool"), spec: "@acme/tool" },
      { title: strings.install.types("@types/untyped"), spec: "@types/untyped" },
    ]);
  });

  test("reads the package from Bun's runtime module-not-found errors", () => {
    expect(runtimeMissingPackage("Cannot find package 'zod' from '/data/runs/t1/entry-1.mjs'")).toBe("zod");
    expect(runtimeMissingPackage("Cannot find module '@acme/tool/x' from '/p'")).toBe("@acme/tool");
    expect(runtimeMissingPackage("Cannot find module './local' from '/p'")).toBeNull();
    expect(runtimeMissingPackage("x is not defined")).toBeNull();
  });
});
```

Append to `apps/ui/test/entry-row.test.tsx` inside `describe("EntryRow", …)`:

```ts
  test("a module-not-found runtime error offers to install the package (spec §6.3)", () => {
    const onInstall = mock((_name: string) => {});
    render(
      <EntryRow
        entry={{
          key: "e",
          event: {
            kind: "error",
            phase: "runtime",
            name: "ResolveMessage",
            message: "Cannot find package 'zod' from '/data/runs/t1/entry-1.mjs'",
            stack: [],
            seq: 1,
            t: 0,
          } as DisplayEvent,
        }}
        stale={false}
        expand={noExpand}
        onReveal={() => {}}
        onHover={() => {}}
        onInstall={onInstall}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.output.installPackage("zod") }));
    expect(onInstall).toHaveBeenCalledWith("zod");
  });
```

Append to `apps/ui/test/e2e-agent.test.ts` inside `describe("E2E agent", …)`:

```ts
  test("e2e.installActions returns the editor's install-assist actions", async () => {
    const { store } = setup();
    const agent = createE2EAgent({
      store,
      executeCommand: () => "unknown",
      editor: () => null,
      target: () => new EventTarget(),
      installActions: async () => [{ title: "Install package zod", spec: "zod" }],
    });
    expect(await agent("command", { id: "e2e.installActions" })).toEqual({
      executed: "e2e.installActions",
      actions: [{ title: "Install package zod", spec: "zod" }],
    });
  });
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun test ./test/type-feeder.test.ts ./test/install-assist.test.ts ./test/entry-row.test.tsx ./test/e2e-agent.test.ts`
Expected: FAIL, `Cannot find module "../src/editor/type-feeder"` and `"../src/editor/install-assist"`.

- [ ] **Step 3: Implement the feeder and install assist**

`apps/ui/src/strings.ts`: add a top-level section

```ts
  install: {
    /** Spec §6.3. */
    package: (name: string) => `Install package ${name}`,
    types: (name: string) => `Install ${name}`,
  },
```

and in `output`, add `installPackage: (name: string) => \`Install ${name}\`,`.

`apps/ui/src/editor/type-feeder.ts`:

```ts
import { packageNameFromSpecifier } from "@jslab/npm/specifiers";
import type { LocalTypesResult, PackageTypesResult } from "@jslab/rpc-schema";
import type { TimerApi } from "../state/auto-run";
import type { TsEnvironment } from "./ts-environment";

/** Spec §6.2: the UI requests types for the imports in a model, debounced 500 ms. */
export const TYPE_FEED_DELAY_MS = 500;

const PATTERNS = [
  /\bfrom\s*["']([^"'\n]+)["']/g,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /^\s*import\s*["']([^"'\n]+)["']/gm,
];

export function importSpecifiers(code: string): { packages: string[]; relative: string[] } {
  const packages = new Set<string>();
  const relative = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1] as string;
      if (specifier.startsWith("./") || specifier.startsWith("../")) relative.add(specifier);
      else {
        const name = packageNameFromSpecifier(specifier);
        if (name) packages.add(name);
      }
    }
  }
  return { packages: [...packages].sort(), relative: [...relative].sort() };
}

export interface TypeFeederDeps {
  requestPackages(tabId: string, names: string[]): Promise<PackageTypesResult[]>;
  requestLocal(tabId: string, specifiers: string[]): Promise<LocalTypesResult>;
  environment: Pick<TsEnvironment, "setPackageFiles" | "clearPackages" | "setLocalFiles" | "clearLocal">;
  timers?: TimerApi;
  delayMs?: number;
  log?(message: string, detail?: unknown): void;
}

export interface TypeFeeder {
  schedule(tabId: string, code: string, hasWorkingDirectory: boolean): void;
  /** Installed packages without types, with the @types package to offer (or null). */
  untyped(): ReadonlyMap<string, string | null>;
  invalidatePackages(): void;
  invalidateLocal(tabId: string): void;
  dispose(): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createTypeFeeder(deps: TypeFeederDeps): TypeFeeder {
  const timers = deps.timers ?? defaultTimers;
  const requested = new Set<string>();
  const untyped = new Map<string, string | null>();
  const scheduled = new Map<string, unknown>();
  let generation = 0;

  const requestPackages = async (tabId: string, names: readonly string[]): Promise<void> => {
    const fresh = [...new Set(names)].filter((name) => !requested.has(name)).slice(0, 50);
    if (fresh.length === 0) return;
    for (const name of fresh) requested.add(name);
    const started = generation;
    try {
      const results = await deps.requestPackages(tabId, fresh);
      if (started !== generation) return;
      const dependencies: string[] = [];
      for (const entry of results) {
        if (entry.files.length > 0) deps.environment.setPackageFiles(entry.name, entry.files);
        // Only an installed package without types names an @types package (Task 13). A package that isn't installed
        // (typesPackage null) keeps "Install package x" from its 2307 marker instead of offering @types/x.
        if (!entry.hasTypes && entry.typesPackage !== null) untyped.set(entry.name, entry.typesPackage);
        else untyped.delete(entry.name);
        dependencies.push(...entry.dependencies);
      }
      await requestPackages(tabId, dependencies);
    } catch (error) {
      for (const name of fresh) requested.delete(name);
      deps.log?.("Couldn't load package types", String(error));
    }
  };

  const feed = async (tabId: string, code: string, hasWorkingDirectory: boolean) => {
    const { packages, relative } = importSpecifiers(code);
    if (!hasWorkingDirectory) {
      deps.environment.clearLocal(tabId);
      await requestPackages(tabId, packages);
      return;
    }
    let localPackages: string[] = [];
    if (relative.length > 0) {
      try {
        const local = await deps.requestLocal(tabId, relative.slice(0, 200));
        deps.environment.setLocalFiles(tabId, local.files);
        localPackages = local.packages;
      } catch (error) {
        deps.log?.("Couldn't load working-directory types", String(error));
      }
    }
    await requestPackages(tabId, [...packages, ...localPackages]);
  };

  return {
    schedule(tabId, code, hasWorkingDirectory) {
      const existing = scheduled.get(tabId);
      if (existing !== undefined) timers.clearTimeout(existing);
      scheduled.set(
        tabId,
        timers.setTimeout(() => {
          scheduled.delete(tabId);
          void feed(tabId, code, hasWorkingDirectory);
        }, deps.delayMs ?? TYPE_FEED_DELAY_MS),
      );
    },
    untyped: () => untyped,
    invalidatePackages() {
      generation++;
      requested.clear();
      untyped.clear();
      deps.environment.clearPackages();
    },
    invalidateLocal(tabId) {
      deps.environment.clearLocal(tabId);
    },
    dispose() {
      for (const handle of scheduled.values()) timers.clearTimeout(handle);
      scheduled.clear();
    },
  };
}
```

`apps/ui/src/editor/install-assist.ts`:

```ts
import { packageNameFromSpecifier, typesPackageName } from "@jslab/npm/specifiers";
import type * as Monaco from "monaco-editor";
import { strings } from "../strings";

/** TypeScript's "Cannot find module" diagnostic (spec §6.1: shown with the install code action). */
export const MISSING_MODULE_CODE = 2307;

export interface InstallAction {
  title: string;
  spec: string;
}

export function missingModuleFromMessage(message: string): string | null {
  return /Cannot find module ['"]([^'"]+)['"]/.exec(message)?.[1] ?? null;
}

/** The package a Bun module-not-found runtime error names (spec §6.3), or null. */
export function runtimeMissingPackage(message: string): string | null {
  const specifier = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(message)?.[1];
  return specifier ? packageNameFromSpecifier(specifier) : null;
}

export function installActionsFor(
  markers: readonly { code: number | string; message: string }[],
  untyped: ReadonlyMap<string, string | null>,
): InstallAction[] {
  const actions = new Map<string, InstallAction>();
  for (const marker of markers) {
    if (Number(marker.code) !== MISSING_MODULE_CODE) continue;
    const specifier = missingModuleFromMessage(marker.message);
    const name = specifier ? packageNameFromSpecifier(specifier) : null;
    if (!name) continue;
    if (untyped.has(name)) {
      const types = untyped.get(name) ?? typesPackageName(name);
      if (types) actions.set(types, { title: strings.install.types(types), spec: types });
    } else {
      actions.set(name, { title: strings.install.package(name), spec: name });
    }
  }
  return [...actions.values()];
}

const INSTALL_COMMAND = "jslab.installPackage";

/** Quick fixes on TS 2307 markers that dispatch npm.install (spec §6.3, §11.4). */
export function registerInstallAssist(
  monaco: typeof Monaco,
  deps: { untyped(): ReadonlyMap<string, string | null>; install(spec: string): void },
): { dispose(): void } {
  const command = monaco.editor.registerCommand(INSTALL_COMMAND, (_accessor, spec: unknown) => {
    if (typeof spec === "string") deps.install(spec);
  });
  const provider = monaco.languages.registerCodeActionProvider(["typescript", "javascript"], {
    provideCodeActions: (_model, _range, context) => ({
      actions: installActionsFor(
        context.markers.map((marker) => ({
          code: typeof marker.code === "object" ? marker.code.value : (marker.code ?? ""),
          message: marker.message,
        })),
        deps.untyped(),
      ).map((action) => ({
        title: action.title,
        kind: "quickfix",
        isPreferred: true,
        diagnostics: [...context.markers],
        command: { id: INSTALL_COMMAND, title: action.title, arguments: [action.spec] },
      })),
      dispose: () => {},
    }),
  });
  return {
    dispose: () => {
      command.dispose();
      provider.dispose();
    },
  };
}
```

`apps/ui/src/state/store.ts`: add `packagesRevision: number;` and `bumpPackagesRevision(): void;` to `AppState` (after `sideBarPanel`), `packagesRevision: 0,` to the initial state, and the action:

```ts
      bumpPackagesRevision() {
        set({ packagesRevision: get().packagesRevision + 1 });
      },
```

`apps/ui/src/editor/editor-handle.ts`: add `import type { InstallAction } from "./install-assist";` and to `EditorHandle`:

```ts
  /** The install-assist actions for the shown model's current markers (E2E verification). */
  installActions(): Promise<InstallAction[]>;
```

`apps/ui/src/editor/Editor.tsx`:

1. Change the props type to `api: Pick<MainApi, "saveViewState" | "packageTypes" | "localTypes" | "npmInstall">;`.
2. Add imports: `import { installActionsFor, registerInstallAssist } from "./install-assist";` and `import { createTypeFeeder } from "./type-feeder";`.
3. After the `applyTypeScript` helper (Task 21), add:

```ts
    // Spec §6.2: package and working-directory types for the imports in the shown model.
    const feeder = createTypeFeeder({
      requestPackages: (tabId, names) => api.packageTypes(tabId, names),
      requestLocal: (tabId, specifiers) => api.localTypes(tabId, specifiers),
      environment: tsEnvironment,
      log: (message, detail) => console.warn(`[jslab] ${message}`, detail),
    });
    const feed = (tabId: string, model: Monaco.editor.ITextModel) =>
      feeder.schedule(tabId, model.getValue(), Boolean(store.getState().tabs[tabId]?.workingDirectory));
    const installAssist = registerInstallAssist(monaco, {
      untyped: () => feeder.untyped(),
      install: (spec) => api.npmInstall(spec),
    });
```

4. In `onShown`, change the content subscription to

```ts
        contentSubscription = model.onDidChangeContent(() => {
          view.pushContent(tabId, model);
          feed(tabId, model);
        });
```

and add `feed(tabId, model);` after `applyTypeScript(store.getState());`.

5. In `setEditorHandle({ … })`, after `completionsAt`, add:

```ts
      installActions: async () => {
        const model = editor.getModel();
        if (!model) return [];
        const markers = monaco.editor
          .getModelMarkers({ resource: model.uri })
          .filter((marker) => marker.owner === "typescript" || marker.owner === "javascript")
          .map((marker) => ({ code: typeof marker.code === "object" ? marker.code.value : (marker.code ?? ""), message: marker.message }));
        return installActionsFor(markers, feeder.untyped());
      },
```

6. In the store subscription, add:

```ts
      if (state.packagesRevision !== previous.packagesRevision || state.tab?.workingDirectory !== previous.tab?.workingDirectory) {
        if (state.tab && state.tab.workingDirectory !== previous.tab?.workingDirectory) feeder.invalidateLocal(state.tab.id);
        feeder.invalidatePackages();
        const model = editor.getModel();
        if (state.activeTabId && model) feed(state.activeTabId, model);
      }
```

7. In the cleanup, before `editor.dispose();`, add `feeder.dispose();` and `installAssist.dispose();`.

`apps/ui/src/output/EntryRow.tsx`:

1. Add `import { runtimeMissingPackage } from "../editor/install-assist";`.
2. Add to `EntryRowProps`: `onInstall?(name: string): void;`, destructure it in `EntryRow`, and pass it: `{event.kind === "error" && <ErrorBody event={event} onReveal={onReveal} onInstall={onInstall} />}`.
3. Change `ErrorBody`'s signature to `function ErrorBody({ event, onReveal, onInstall }: { event: ErrorEvent; onReveal(line: number): void; onInstall?(name: string): void })` and, directly before the closing `</div>`, add:

```tsx
      {(() => {
        const missing = onInstall ? runtimeMissingPackage(event.message) : null;
        return missing ? (
          <button type="button" className="entry-action" onClick={() => onInstall?.(missing)}>
            {strings.output.installPackage(missing)}
          </button>
        ) : null;
      })()}
```

`apps/ui/src/output/OutputPanel.tsx`: add `onInstall={(name) => api.npmInstall(name)}` to the `<EntryRow … />` props.

`apps/ui/src/e2e/agent.ts`: add `import type { InstallAction } from "../editor/install-assist";`, add to `E2EAgentDeps` `installActions?(): Promise<InstallAction[]>;`, add `export const E2E_INSTALL_ACTIONS = "e2e.installActions";`, and in `case "command":` after the completions branch:

```ts
        if (id === E2E_INSTALL_ACTIONS) return { executed: E2E_INSTALL_ACTIONS, actions: (await deps.installActions?.()) ?? [] };
```

`apps/ui/src/shell/App.tsx`:
- Add to the `createE2EAgent({ … })` deps: `installActions: () => getEditorHandle()?.installActions() ?? Promise.resolve([]),`.
- Add to the view-message subscriptions: `api.on("npm.changed", () => store.getState().bumpPackagesRevision()),`.

In `apps/ui/src/styles.css`, after the `.entry-frame` rule, add:

```css
.entry-action {
  margin-top: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--fg-accent);
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun run test`
Expected: PASS, 0 fail.

- [ ] **Step 5: Add the scenario**

`packages/e2e/scenarios/types-local.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface TsDiagnostic {
  code: number;
  message: string;
}

test("working-directory files feed editor types, and a missing package offers Install (ED-13, ED-26)", async () => {
  const userData = await createUserData();
  const wd = join(userData, "api");
  await mkdir(wd, { recursive: true });
  await writeFile(join(wd, "util.ts"), "export function shout(text: string): string {\n  return text.toUpperCase();\n}\n");
  const code = 'import { shout } from "./util";\nimport missing from "jslab-not-installed";\nconst n: number = shout("x");\nshout("x").';
  await mkdir(join(userData, "buffers"), { recursive: true });
  await writeFile(join(userData, "buffers", "t1.ts"), code);
  await writeFile(
    join(userData, "session.json"),
    JSON.stringify({
      version: 2,
      tabOrder: ["t1"],
      activeTabId: "t1",
      tabs: { t1: { id: "t1", title: "t1", titleIsCustom: true, language: "typescript", runtime: "bun", workingDirectory: wd } },
    }),
  );
  app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
  const current = app;
  const diagnostics = await waitFor(
    async () => {
      const found = ((await current.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[];
      return found.some((d) => d.code === 2322) ? found : null;
    },
    { timeoutMs: 30_000, message: "the local import never produced typed diagnostics" },
  );
  expect(diagnostics.filter((d) => d.code === 2307).map((d) => d.message)).toEqual([
    expect.stringContaining("'jslab-not-installed'"),
  ]);
  const completions = await current.client.call<{ result: { completions: string[] } }>("e2e.command", {
    id: "e2e.completions",
    args: { offset: code.length },
  });
  expect(completions.result.completions).toContain("toUpperCase");
  const actions = await current.client.call<{ result: { actions: { title: string; spec: string }[] } }>("e2e.command", {
    id: "e2e.installActions",
  });
  expect(actions.result.actions).toEqual([{ title: "Install package jslab-not-installed", spec: "jslab-not-installed" }]);
});
```

- [ ] **Step 6: Run every gate and the scenario**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/ui` M2 final + 29.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/types-local.test.ts ./scenarios/typescript.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: all pass, 0 fail. Scenarios: M2 final + 6. Read-only `ps` check: no survivors.

- [ ] **Step 7: Commit**

```bash
git add apps/ui packages/e2e/scenarios/types-local.test.ts bun.lock
git commit -m "feat(ui): feed package and working-directory types to monaco and offer install actions" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 24: Working directory UI: chip, label suffix, picker, missing-WD action, folder drop

**Files:**
- Modify: `packages/shared/src/tabs.ts` (add `tabLabel`)
- Modify: `apps/ui/src/shell/StatusBar.tsx:7-79`, `apps/ui/src/tabs/TabBar.tsx:66-110`, `apps/ui/src/shell/App.tsx` (toolbar title, `wd.changed`, StatusBar props), `apps/ui/src/e2e/snapshot.ts:8-24`, `:56-81`
- Modify: `apps/ui/src/output/EntryRow.tsx` (`onChangeWorkingDirectory`), `apps/ui/src/output/OutputPanel.tsx`
- Modify: `apps/ui/src/files/file-flows.ts:179-204` and `apps/ui/src/strings.ts:64` (Branch B), or the Branch A files listed in Step 6
- Modify: `apps/ui/src/strings.ts` (`shell.workingDirectory`, `output.changeWorkingDirectory`), `apps/ui/src/styles.css`
- Test: `packages/shared/test/tabs.test.ts` (append), `packages/shared/test/session.test.ts` (append), `apps/ui/test/layout.test.tsx` (append), `apps/ui/test/tab-bar.test.tsx` (append), `apps/ui/test/entry-row.test.tsx` (append), `apps/ui/test/e2e-agent.test.ts` (append), `packages/e2e/scenarios/working-directory.test.ts`

**Interfaces:**
- Consumes: `wd.pick`/`wd.clear`/`wd.changed` (Task 18); `MainApi.pickWorkingDirectory`/`clearWorkingDirectory`, commands `wd.set`/`wd.clear` (Task 22); `WORKING_DIRECTORY_ERROR` (Task 16); ruling R-M3-SPIKE-1 (Task 6).
- Produces:
  - `tabLabel(title: string, workingDirectory: string | null): string` (`"fetch users · api"`)
  - `StatusBar` props `onPickWorkingDirectory?(): void`, `onClearWorkingDirectory?(): void`
  - `TabSnapshot` gains `label: string` and `workingDirectory: string | null`
  - `EntryRow` prop `onChangeWorkingDirectory?(): void`

**Rules (spec §7.1 status bar, §7.3, §12.2; parity EX-30, EX-33, TF-19, TF-11):**
- **WD chip.** It sits in the status bar's right cluster after the split toggle.
  - With a WD it shows the folder name, its tooltip is the full path, a click opens the folder picker, and a small × clears it.
  - Without a WD it shows "Set Working Directory", and a click opens the picker.
- **Tab label.** It shows `<title> · <folder name>` in the tab bar, in the single-tab toolbar title and in the E2E snapshot.
- **`wd.changed`** updates the tab in the UI store. The type feeder invalidates on the WD change (Task 23).
- **Missing WD.** A `WorkingDirectoryError` output row shows a **Change…** button that opens the picker.
- **Folder drop:** Branch A or B from ruling R-M3-SPIKE-1 (Step 6).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/test/tabs.test.ts` (add `tabLabel` to the `../src/tabs` import):

```ts
test("tabLabel adds the working directory's folder name as a suffix (spec §12.2)", () => {
  expect(tabLabel("fetch users", "/work/api")).toBe("fetch users · api");
  expect(tabLabel("fetch users", "/work/api/")).toBe("fetch users · api");
  expect(tabLabel("scratch", null)).toBe("scratch");
});
```

Append to `packages/shared/test/session.test.ts` inside its main `describe`:

```ts
  test("a tab's working directory survives a v2 round trip with no migration (M3 decision 1)", () => {
    const tab = createTab({ id: "t1", workingDirectory: "/work/api" });
    const written = JSON.parse(JSON.stringify({ ...defaultSession(() => tab), version: SESSION_VERSION }));
    expect(parseSession(written).session.tabs.t1?.workingDirectory).toBe("/work/api");
    expect(parseSession({ version: 2, tabOrder: ["t2"], activeTabId: "t2", tabs: { t2: { id: "t2" } } }).session.tabs.t2?.workingDirectory).toBeNull();
    expect(SESSION_VERSION).toBe(2);
  });
```

Append to `apps/ui/test/layout.test.tsx` (inside its `describe("layout", …)`). Make sure these imports exist, adding any that are missing: `mock` from `bun:test`; `createTab`, `defaultSession`, `defaultSettings` from `@jslab/shared`; `fireEvent`, `render`, `screen` from `@testing-library/react`; `createAppStore` from `../src/state/store`; `strings` from `../src/strings`.

```ts
  test("the WD chip shows the folder with its path as a tooltip, opens the picker and clears (TF-19, spec §12.2)", () => {
    const store = createAppStore();
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1", workingDirectory: "/work/api" })),
      buffers: { t1: "" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "1.4.0" },
    });
    const onPick = mock(() => {});
    const onClear = mock(() => {});
    render(<StatusBar store={store} onToggleLayout={() => {}} runKeys="⌘R" onPickWorkingDirectory={onPick} onClearWorkingDirectory={onClear} />);
    const chip = screen.getByRole("button", { name: strings.shell.workingDirectory.change("/work/api") });
    expect([chip.textContent, chip.getAttribute("title")]).toEqual(["api", "/work/api"]);
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: strings.shell.workingDirectory.clear }));
    expect([onPick.mock.calls.length, onClear.mock.calls.length]).toEqual([1, 1]);
  });
```

Append to `apps/ui/test/tab-bar.test.tsx` a new describe:

```ts
describe("working directory label (EX-33)", () => {
  test("a tab with a working directory shows the folder name after its title", () => {
    const { store } = setup();
    act(() => store.getState().applyTabUpdate({ ...(store.getState().tabs.c as TabState), workingDirectory: "/work/api" }));
    expect(screen.getByText("Mine · api")).toBeTruthy();
  });
});
```

Append to `apps/ui/test/entry-row.test.tsx` inside `describe("EntryRow", …)`:

```ts
  test("a missing working directory offers Change… (spec §12.2)", () => {
    const onChange = mock(() => {});
    render(
      <EntryRow
        entry={{
          key: "wd",
          event: { kind: "error", phase: "runner", name: "WorkingDirectoryError", message: "Working directory not found: /gone", stack: [], seq: 1, t: 0 } as DisplayEvent,
        }}
        stale={false}
        expand={noExpand}
        onReveal={() => {}}
        onHover={() => {}}
        onChangeWorkingDirectory={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: strings.output.changeWorkingDirectory }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
```

Append to `apps/ui/test/e2e-agent.test.ts` inside `describe("E2E agent", …)`:

```ts
  test("tab snapshots carry the working directory and the suffixed label", async () => {
    const { store, agent } = setup();
    store.getState().applyTabUpdate({ ...(store.getState().tabs.t1 as NonNullable<ReturnType<typeof store.getState>["tabs"]["t1"]>), workingDirectory: "/work/api" });
    expect(await agent("state", {})).toMatchObject({ tabs: [{ id: "t1", workingDirectory: "/work/api", label: "scratch · api" }] });
  });
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/shared && bun test && builtin cd ../../apps/ui && bun run test`
Expected: FAIL: `tabLabel` isn't exported; no chip button; "Mine · api" isn't rendered; no Change… button; the snapshot has no `label`. The session round-trip test passes (decision 1 pins it).

- [ ] **Step 2: Implement the label, chip, snapshot and Change… action**

`packages/shared/src/tabs.ts`, append:

```ts
/** Spec §12.2: the tab label shows the working directory's folder name as a suffix, e.g. "fetch users · api". */
export function tabLabel(title: string, workingDirectory: string | null): string {
  return workingDirectory ? `${title} · ${baseName(workingDirectory)}` : title;
}
```

`apps/ui/src/strings.ts`:
- In `shell`, add:

```ts
    workingDirectory: {
      set: "Set Working Directory",
      change: (path: string) => `Working directory: ${path}. Change…`,
      clear: "Clear Working Directory",
    },
```

- In `output`, add `changeWorkingDirectory: "Change…",`.

`apps/ui/src/shell/StatusBar.tsx`:

1. Change the first import to `import { baseName, isRuntimeAvailable, LANGUAGES, type Language, RUNTIMES, type Runtime } from "@jslab/shared";`.
2. Add to the props type: `onPickWorkingDirectory?(): void; onClearWorkingDirectory?(): void;` and destructure them.
3. Add a primitive selector: `const workingDirectory = useStore(store, (s) => s.tab?.workingDirectory ?? null);`.
4. After the split-toggle `<button …>` add:

```tsx
        {workingDirectory ? (
          <span className="status-wd">
            <button
              type="button"
              className="status-item"
              title={workingDirectory}
              aria-label={strings.shell.workingDirectory.change(workingDirectory)}
              onClick={onPickWorkingDirectory}
            >
              {baseName(workingDirectory)}
            </button>
            <button
              type="button"
              className="status-item status-wd-clear"
              aria-label={strings.shell.workingDirectory.clear}
              onClick={onClearWorkingDirectory}
            >
              ×
            </button>
          </span>
        ) : (
          <button type="button" className="status-item status-wd-empty" onClick={onPickWorkingDirectory}>
            {strings.shell.workingDirectory.set}
          </button>
        )}
```

`apps/ui/src/tabs/TabBar.tsx`: add `tabLabel` to a new import `import { tabLabel } from "@jslab/shared";`. In the tab render, after `const title = summaries.title(tab, code);`, add `const label = tabLabel(title, tab.workingDirectory);`, change `title={tab.filePath ?? title}` to `title={tab.filePath ?? tab.workingDirectory ?? title}`, and change `<span className="tab-title">{title}</span>` to `<span className="tab-title">{label}</span>`.

`apps/ui/src/shell/App.tsx`:
1. Add `tabLabel` to the `@jslab/shared` import.
2. Change the toolbar title selector to `const toolbarTitle = useStore(store, (s) => (s.tab ? tabLabel(titles.title(s.tab, s.code), s.tab.workingDirectory) : ""));`.
3. Add to the view-message subscriptions: `api.on("wd.changed", ({ tab }) => store.getState().applyTabUpdate(tab)),`.
4. Pass to `<StatusBar …>`: `onPickWorkingDirectory={() => registry.execute("wd.set")}` and `onClearWorkingDirectory={() => registry.execute("wd.clear")}`.

`apps/ui/src/e2e/snapshot.ts`: add `label: string;` and `workingDirectory: string | null;` to `TabSnapshot`, `tabLabel` to the `@jslab/shared` import, and in `snapshotState`'s tab object add, after `title`:

```ts
        label: tabLabel(deriveTitle(tab, code), tab.workingDirectory),
        workingDirectory: tab.workingDirectory,
```

`apps/ui/src/output/EntryRow.tsx`: add `onChangeWorkingDirectory?(): void;` to `EntryRowProps`, pass it to `ErrorBody`, add it to `ErrorBody`'s props, and add before the install button block:

```tsx
      {event.name === "WorkingDirectoryError" && onChangeWorkingDirectory && (
        <button type="button" className="entry-action" onClick={onChangeWorkingDirectory}>
          {strings.output.changeWorkingDirectory}
        </button>
      )}
```

`apps/ui/src/output/OutputPanel.tsx`: add `onChangeWorkingDirectory={() => (tabId ? api.pickWorkingDirectory(tabId) : undefined)}` to `<EntryRow …/>`.

`apps/ui/src/styles.css`, after `.status-item`:

```css
.status-wd {
  display: inline-flex;
  align-items: center;
}

.status-wd-clear {
  color: var(--fg-muted);
}

.status-wd-empty {
  color: var(--fg-muted);
}
```

- [ ] **Step 3: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd packages/shared && bun test && builtin cd ../../apps/ui && bun run test`
Expected: PASS, 0 fail.

- [ ] **Step 4: Add the scenarios**

`packages/e2e/scenarios/working-directory.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

async function pickFolder(target: LaunchedApp, folder: string) {
  await writeFile(join(target.userData, "e2e-open-dialog.json"), JSON.stringify([folder]));
  await target.command("wd.set");
  await waitFor(async () => activeTab(await target.state()).workingDirectory === folder || null, {
    message: "the working directory was never set",
  });
}

describe("working directory (spec §5.3, §12.2)", () => {
  test("picking a folder sets the chip and label, and runs resolve imports, globals, .env, env.json and node_modules there (EX-30..33)", async () => {
    const userData = await createUserData();
    const wd = join(userData, "api");
    await mkdir(join(wd, "node_modules", "wd-dep"), { recursive: true });
    await writeFile(join(wd, "util.ts"), "export const shout = (text: string): string => text.toUpperCase();\n");
    await writeFile(join(wd, ".env"), "GREETING=from-dotenv\n");
    await writeFile(join(wd, "node_modules", "wd-dep", "package.json"), JSON.stringify({ name: "wd-dep", main: "index.js" }));
    await writeFile(join(wd, "node_modules", "wd-dep", "index.js"), 'module.exports = { from: "wd" };\n');
    await writeFile(join(userData, "env.json"), JSON.stringify({ version: 1, variables: { FROM_ENV_JSON: "yes" } }));
    await chmod(join(userData, "env.json"), 0o600);
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    const current = app;
    await pickFolder(current, wd);
    expect(activeTab(await current.state()).label).toEndWith(" · api");
    const code = [
      'import { shout } from "./util";',
      'import dep from "wd-dep";',
      "console.log(JSON.stringify({ shout: shout(\"hi\"), dir: __dirname, dotenv: process.env.GREETING, envJson: process.env.FROM_ENV_JSON, dep: dep.from }));",
    ].join("\n");
    await current.type(code);
    await waitFor(async () => activeTab(await current.state()).code === code || null);
    await current.command("run.start");
    const entries = await current.waitForOutput((list) => list.some((entry) => entry.kind === "console"), 30_000);
    expect(JSON.parse(entries.find((entry) => entry.kind === "console")?.text ?? "{}")).toEqual({
      shout: "HI",
      dir: wd,
      dotenv: "from-dotenv",
      envJson: "yes",
      dep: "wd",
    });
  });

  test("a working directory that disappears fails the run with Working directory not found, and clearing it runs again", async () => {
    const userData = await createUserData();
    const wd = join(userData, "gone");
    await mkdir(wd, { recursive: true });
    app = await launchApp({ userData, settings: { version: 3, run: { autoRun: false } } });
    const current = app;
    await pickFolder(current, wd);
    await rm(wd, { recursive: true, force: true });
    await current.type("40 + 2");
    await waitFor(async () => activeTab(await current.state()).code === "40 + 2" || null);
    await current.command("run.start");
    await current.waitForOutput((list) => list.some((entry) => entry.kind === "error" && entry.text.includes(`Working directory not found: ${wd}`)));
    await current.command("wd.clear");
    await waitFor(async () => activeTab(await current.state()).workingDirectory === null || null);
    await current.command("run.start");
    await current.waitForOutput((list) => list.some((entry) => entry.kind === "result" && entry.text === "42"));
  });
});
```

- [ ] **Step 5: Run every gate and the scenarios**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/shared` M2 final + 11; `@jslab/ui` M2 final + 33.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/working-directory.test.ts ./scenarios/files.test.ts ./scenarios/tab-bar.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: all pass, 0 fail. Scenarios: M2 final + 8. Read-only `ps` check: no survivors.

- [ ] **Step 6: Folder drop — build the branch ruled in R-M3-SPIKE-1**

**Branch B (NO-GO; the expected outcome).** A dropped folder can't carry its path into the webview, so a folder drop points at the picker.

1. `apps/ui/src/strings.ts:64`: replace the `folderDrop` string with `folderDrop: "A dropped folder can't become the working directory here. Use Actions → Set Working Directory… or the status bar.",`.
2. No other code changes. Record in the commit body: `TF-11/§12.2: folder drop sets no WD on Electrobun 2.0.1 (R-M3-SPIKE-1); picker, chip and menu only.`
3. Add a UI test to `apps/ui/test/file-flows.test.ts`. Add `import { strings } from "../src/strings";` to its imports, and append this `describe` at the end of the file (it uses the file's `setup()` helper, which returns `store` and `flows`):

```ts
describe("folder drops (R-M3-SPIKE-1 Branch B)", () => {
  test("a dropped folder points at Set Working Directory", async () => {
    const { store, flows } = setup();
    await flows.dropFiles([new File([""], "api")], new Set(["api"]));
    expect(store.getState().statusMessage).toBe(strings.files.folderDrop);
  });
});
```

`@jslab/ui` then ends this task at M2 final + 34, and Task 30 records the deviation.

**Branch A (GO).** The spike report names the Electrobun API that delivers dropped paths to Main.

1. Add the contract `wdSetParamsSchema = z.object({ tabId, path: z.string().min(1).max(4096).regex(/^\//) })` and `MainMessages["wd.set"]: { tabId: string; path: string }` in `ui-rpc.ts`.
2. Add to `createWorkingDirectoryHandlers` (Task 18):

```ts
      "wd.set": message(wdSetParamsSchema, "wd.set", async ({ tabId, path }) => {
        if (!deps.session.session.tabs[tabId] || !(await deps.isDirectory(path))) return;
        apply(tabId, path);
      }),
```

with a test mirroring `wd.pick`'s first test (a directory is applied, a file or relative path is ignored).
3. In `index.ts` `createWindow`, subscribe with the API and payload exactly as written in the spike report's Decision section. For each dropped path that is a directory, call the same `apply` path as `wd.set` for `session.session.activeTabId`. For each file, call `FileService.prepareOpen([path])` and `openReady` (Task 10's file-backed open), so TF-11 gains file-backed drops.
4. In `file-flows.ts` `dropFiles`, stop showing `folderDrop` when Main handled the drop: Main sends the existing `file.opened` for files and `wd.changed` for folders.
5. Add a scenario that writes nothing to the OS: call the Main handler through a test-only socket method `e2e.nativeDrop { paths }` (added next to `e2e.reopen`, E2E-only), which invokes the same callback as the native subscription.

Branch A counts: `@jslab/desktop` +1 (the `wd.set` handler test in `apps/desktop/test/rpc/wd-handlers.test.ts`), `@jslab/ui` +0 (no folder-drop notice test), and scenarios +1 (the `e2e.nativeDrop` scenario, appended to `working-directory.test.ts`). From here on, every later "M2 final + N" for desktop is one higher, the ui figures use the values without parentheses, and the scenario totals are one higher (Test counts note).

- [ ] **Step 7: Commit**

```bash
git add packages/shared apps/ui packages/e2e/scenarios/working-directory.test.ts
git commit -m "feat(ui): working directory chip, tab label suffix and missing-directory change action" -m "$JSLAB_COMMIT_TRAILER"
```

(Branch A also stages `packages/rpc-schema`, `apps/desktop/src/main` and `apps/desktop/test`.)

---

### Task 25: Environment Variables sheet

**Files:**
- Create: `apps/ui/src/env/env-table.ts`, `apps/ui/src/env/EnvVarsSheet.tsx`
- Modify: `apps/ui/src/shell/App.tsx` (render), `apps/ui/src/strings.ts` (`env`), `apps/ui/src/styles.css` (`.sheet`)
- Test: `apps/ui/test/env-table.test.ts`, `apps/ui/test/env-sheet.test.tsx`, `packages/e2e/scenarios/environment.test.ts`

**Interfaces:**
- Consumes: `validateEnvRows`, `EnvVars`, `EnvRowError` (Task 4); `MainApi.getEnv`, `saveEnv` (Task 22); `Modal { kind: "env" }` (Task 22).
- Produces:
  - `env-table.ts`: `interface EnvRow { id: number; key: string; value: string; revealed: boolean }`; `rowsFromVariables(variables: EnvVars): EnvRow[]`; `addEnvRow(rows: readonly EnvRow[], key: string, value: string): EnvRow[]`; `updateEnvRow(rows: readonly EnvRow[], id: number, patch: Partial<Pick<EnvRow, "key" | "value" | "revealed">>): EnvRow[]`; `removeEnvRow(rows: readonly EnvRow[], id: number): EnvRow[]`
  - `EnvVarsSheet({ store, api }: { store: AppStore; api: Pick<MainApi, "getEnv" | "saveEnv"> })`

**Rules (spec §12.1, §7.5; parity TL-11):**
- **Layout.** A modal sheet: a table of KEY · VALUE (masked, with a reveal toggle) · Remove, rows editable inline, then an input row KEY + VALUE + **Add**, then **Cancel** and **Save**.
- **Keyboard.** The new-key field has focus when the sheet opens. Enter in it moves to the value; Enter in the value adds the row. ⌘↵ saves; Escape cancels.
- **Save** validates keys (`^[A-Za-z_][A-Za-z0-9_]*$`, unique; a pending input row counts). An invalid row shows its error and nothing is saved. A successful save closes the sheet; Main writes `env.json` (0600) and recycles every spare (Task 14). A failed save shows the error.
- **Cancel** discards every change.

- [ ] **Step 1: Write the failing tests**

`apps/ui/test/env-table.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { addEnvRow, removeEnvRow, rowsFromVariables, updateEnvRow } from "../src/env/env-table";

describe("environment table rows", () => {
  test("rows come from variables in order, and add, update and remove keep ids stable", () => {
    const rows = rowsFromVariables({ A: "1", B: "2" });
    expect(rows).toEqual([
      { id: 1, key: "A", value: "1", revealed: false },
      { id: 2, key: "B", value: "2", revealed: false },
    ]);
    const added = addEnvRow(rows, " C ", "3");
    expect(added.at(-1)).toEqual({ id: 3, key: "C", value: "3", revealed: false });
    expect(updateEnvRow(added, 2, { value: "two", revealed: true })[1]).toEqual({ id: 2, key: "B", value: "two", revealed: true });
    expect(removeEnvRow(added, 1).map((row) => row.key)).toEqual(["B", "C"]);
  });
});
```

`apps/ui/test/env-sheet.test.tsx`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EnvVarsSheet } from "../src/env/EnvVarsSheet";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";

function setup(variables: Record<string, string> = { TOKEN: "s3cr3t" }, saveResult: { ok: true } | { ok: false; error: string } = { ok: true }) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const api = { getEnv: mock(async () => variables), saveEnv: mock(async (_variables: Record<string, string>) => saveResult) };
  render(<EnvVarsSheet store={store} api={api} />);
  act(() => store.getState().openModal({ kind: "env" }));
  return { store, api };
}

describe("Environment Variables sheet (spec §12.1)", () => {
  test("values are masked until revealed, and Add then Save persists and closes", async () => {
    const { store, api } = setup();
    const value = (await screen.findByLabelText(strings.env.valueOf("TOKEN"))) as HTMLInputElement;
    expect(value.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: strings.env.reveal("TOKEN") }));
    expect((screen.getByLabelText(strings.env.valueOf("TOKEN")) as HTMLInputElement).type).toBe("text");
    fireEvent.change(screen.getByLabelText(strings.env.newKey), { target: { value: "API_URL" } });
    fireEvent.change(screen.getByLabelText(strings.env.newValue), { target: { value: "https://x" } });
    fireEvent.click(screen.getByRole("button", { name: strings.env.add }));
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    await waitFor(() => expect(store.getState().modal).toBeNull());
    expect(api.saveEnv).toHaveBeenCalledWith({ TOKEN: "s3cr3t", API_URL: "https://x" });
  });

  test("invalid and duplicate keys show errors and nothing is saved", async () => {
    const { store, api } = setup({ A: "1" });
    await screen.findByLabelText(strings.env.valueOf("A"));
    fireEvent.change(screen.getByLabelText(strings.env.newKey), { target: { value: "A" } });
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    expect(await screen.findByText(strings.env.errors.duplicateKey)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(strings.env.keyOf(2)), { target: { value: "1BAD" } });
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    expect(await screen.findByText(strings.env.errors.invalidKey)).toBeTruthy();
    expect(api.saveEnv).not.toHaveBeenCalled();
    expect(store.getState().modal).toEqual({ kind: "env" });
  });

  test("Cancel discards changes, and a failed save stays open with the error", async () => {
    const failing = setup({ A: "1" }, { ok: false, error: "EACCES: permission denied" });
    await screen.findByLabelText(strings.env.valueOf("A"));
    fireEvent.click(screen.getByRole("button", { name: strings.env.save }));
    expect(await screen.findByText(strings.env.saveFailed("EACCES: permission denied"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.env.cancel }));
    expect(failing.store.getState().modal).toBeNull();
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun test ./test/env-table.test.ts ./test/env-sheet.test.tsx`
Expected: FAIL, `Cannot find module "../src/env/env-table"`.

- [ ] **Step 2: Implement**

`apps/ui/src/strings.ts`: add a top-level section:

```ts
  env: {
    title: "Environment Variables",
    help: "Shared by every tab and saved in env.json. The next run gets the new values.",
    key: "Key",
    value: "Value",
    keyOf: (row: number) => `Key, row ${row}`,
    valueOf: (key: string) => `Value of ${key}`,
    reveal: (key: string) => `Show value of ${key}`,
    hide: (key: string) => `Hide value of ${key}`,
    remove: (key: string) => `Remove ${key}`,
    newKey: "New key",
    newValue: "New value",
    add: "Add",
    save: "Save",
    cancel: "Cancel",
    loadFailed: "Couldn't load environment variables.",
    saveFailed: (error: string) => `Couldn't save: ${error}`,
    errors: {
      invalidKey: "Keys start with a letter or _, then letters, digits or _.",
      duplicateKey: "This key is already in the table.",
    },
  },
```

`apps/ui/src/env/env-table.ts`:

```ts
import type { EnvVars } from "@jslab/shared";

export interface EnvRow {
  id: number;
  key: string;
  value: string;
  revealed: boolean;
}

const nextId = (rows: readonly EnvRow[]) => rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;

export function rowsFromVariables(variables: EnvVars): EnvRow[] {
  return Object.entries(variables).map(([key, value], index) => ({ id: index + 1, key, value, revealed: false }));
}

export function addEnvRow(rows: readonly EnvRow[], key: string, value: string): EnvRow[] {
  return [...rows, { id: nextId(rows), key: key.trim(), value, revealed: false }];
}

export function updateEnvRow(
  rows: readonly EnvRow[],
  id: number,
  patch: Partial<Pick<EnvRow, "key" | "value" | "revealed">>,
): EnvRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

export function removeEnvRow(rows: readonly EnvRow[], id: number): EnvRow[] {
  return rows.filter((row) => row.id !== id);
}
```

`apps/ui/src/env/EnvVarsSheet.tsx`:

```tsx
import { type EnvRowError, validateEnvRows } from "@jslab/shared";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import { addEnvRow, type EnvRow, removeEnvRow, rowsFromVariables, updateEnvRow } from "./env-table";

/** Tools → Environment Variables… (spec §12.1), a modal sheet (spec §7.5). */
export function EnvVarsSheet({ store, api }: { store: AppStore; api: Pick<MainApi, "getEnv" | "saveEnv"> }) {
  const open = useStore(store, (s) => s.modal?.kind === "env");
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [draft, setDraft] = useState({ key: "", value: "" });
  const [errors, setErrors] = useState<EnvRowError[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const newKey = useRef<HTMLInputElement>(null);
  const newValue = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDraft({ key: "", value: "" });
    setErrors([]);
    setStatus(null);
    setRows([]);
    api.getEnv().then(
      (variables) => {
        if (!cancelled) setRows(rowsFromVariables(variables));
      },
      () => {
        if (!cancelled) setStatus(strings.env.loadFailed);
      },
    );
    newKey.current?.focus();
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  if (!open) return null;

  const close = () => store.getState().closeModal();
  const add = () => {
    if (!draft.key.trim()) return;
    setRows((current) => addEnvRow(current, draft.key, draft.value));
    setDraft({ key: "", value: "" });
    newKey.current?.focus();
  };
  const save = async () => {
    const all = draft.key.trim() ? addEnvRow(rows, draft.key, draft.value) : rows;
    const result = validateEnvRows(all);
    if (!result.ok) {
      setRows(all);
      setDraft({ key: "", value: "" });
      setErrors(result.errors);
      return;
    }
    setErrors([]);
    const saved = await api.saveEnv(result.variables);
    if (saved.ok) close();
    else setStatus(strings.env.saveFailed(saved.error));
  };
  const errorFor = (index: number) => errors.find((entry) => entry.index === index)?.error;

  return (
    <div className="dialog-backdrop">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcuts for the whole sheet (Escape, ⌘↵) */}
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={strings.env.title}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          } else if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            void save();
          }
        }}
      >
        <h2>{strings.env.title}</h2>
        <p className="sheet-help">{strings.env.help}</p>
        <table className="env-table">
          <thead>
            <tr>
              <th>{strings.env.key}</th>
              <th>{strings.env.value}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id} className={errorFor(index) ? "invalid" : undefined}>
                <td>
                  <input
                    aria-label={strings.env.keyOf(index + 1)}
                    value={row.key}
                    onChange={(event) => setRows((current) => updateEnvRow(current, row.id, { key: event.target.value }))}
                  />
                  {errorFor(index) && <span className="env-error">{strings.env.errors[errorFor(index) as EnvRowError["error"]]}</span>}
                </td>
                <td className="env-value">
                  <input
                    aria-label={strings.env.valueOf(row.key)}
                    type={row.revealed ? "text" : "password"}
                    value={row.value}
                    onChange={(event) => setRows((current) => updateEnvRow(current, row.id, { value: event.target.value }))}
                  />
                  <button
                    type="button"
                    aria-label={row.revealed ? strings.env.hide(row.key) : strings.env.reveal(row.key)}
                    aria-pressed={row.revealed}
                    onClick={() => setRows((current) => updateEnvRow(current, row.id, { revealed: !row.revealed }))}
                  >
                    ◉
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    aria-label={strings.env.remove(row.key)}
                    onClick={() => setRows((current) => removeEnvRow(current, row.id))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
            <tr className="env-new">
              <td>
                <input
                  ref={newKey}
                  aria-label={strings.env.newKey}
                  placeholder={strings.env.key}
                  value={draft.key}
                  onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.metaKey) {
                      event.preventDefault();
                      newValue.current?.focus();
                    }
                  }}
                />
              </td>
              <td>
                <input
                  ref={newValue}
                  aria-label={strings.env.newValue}
                  placeholder={strings.env.value}
                  value={draft.value}
                  onChange={(event) => setDraft({ ...draft, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.metaKey) {
                      event.preventDefault();
                      add();
                    }
                  }}
                />
              </td>
              <td>
                <button type="button" onClick={add}>
                  {strings.env.add}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        {status && <p className="sheet-status">{status}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            {strings.env.cancel}
          </button>
          <button type="button" className="primary" onClick={() => void save()}>
            {strings.env.save}
          </button>
        </div>
      </div>
    </div>
  );
}
```

`apps/ui/src/shell/App.tsx`: add `import { EnvVarsSheet } from "../env/EnvVarsSheet";` and render `<EnvVarsSheet store={store} api={api} />` after `<ConfirmDialog …/>`.

`apps/ui/src/styles.css`, after `.dialog-actions .danger { … }`:

```css
/* ---------- sheets (NPM Packages, Environment Variables; spec §7.5) ---------- */
.sheet {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(720px, calc(100vw - 48px));
  max-height: calc(100vh - 96px);
  padding: 16px 20px;
  overflow: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  box-shadow: 0 28px 70px -20px color-mix(in srgb, var(--bg-scrim) 85%, transparent);
}

.sheet h2 {
  margin: 0;
  font-size: 14px;
}

.sheet-help,
.sheet-status {
  margin: 0;
  color: var(--fg-muted);
}

.env-table {
  width: 100%;
  border-collapse: collapse;
}

.env-table input {
  width: 100%;
}

.env-value {
  display: flex;
  gap: 4px;
}

.env-table tr.invalid input {
  border-color: var(--fg-error);
}

.env-error {
  color: var(--fg-error);
  font-size: 11px;
}
```

- [ ] **Step 3: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun run test`
Expected: PASS, 0 fail.

- [ ] **Step 4: Add the scenario**

`packages/e2e/scenarios/environment.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { activeTab, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

test("Environment Variables: add, save to a 0600 env.json, read in the next run, and kept out of the debug report (TL-11)", async () => {
  app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
  const current = app;
  await current.command("tools.environmentVariables");
  await waitFor(async () => (await current.state()).ui.modal === "env" || null);
  await current.type("E2E_GREETING");
  await current.key("enter");
  await current.type("hello-from-env");
  await current.key("enter");
  await current.key("cmd+enter");
  await waitFor(async () => (await current.state()).ui.modal === null || null, { message: "the sheet never closed" });
  const envFile = join(current.userData, "env.json");
  expect(JSON.parse(readFileSync(envFile, "utf8"))).toEqual({ version: 1, variables: { E2E_GREETING: "hello-from-env" } });
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);
  await current.type("console.log(process.env.E2E_GREETING)");
  await waitFor(async () => activeTab(await current.state()).code === "console.log(process.env.E2E_GREETING)" || null);
  await current.command("run.start");
  await current.waitForOutput((entries) => entries.some((entry) => entry.kind === "console" && entry.text === "hello-from-env"), 30_000);
  await current.command("help.copyDebugLog");
  const clip = join(current.userData, "e2e-clipboard.txt");
  const report = await waitFor(() => (existsSync(clip) ? readFileSync(clip, "utf8") : null));
  expect(report).not.toContain("hello-from-env");
});
```

- [ ] **Step 5: Run every gate and the scenario**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/ui` M2 final + 37 (M2 final + 38 with Branch B's file-flows test).

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/environment.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: pass, 0 fail. Scenarios: M2 final + 9. Read-only `ps` check: no survivors.

- [ ] **Step 6: Commit**

```bash
git add apps/ui packages/e2e/scenarios/environment.test.ts
git commit -m "feat(ui): environment variables sheet with masked values and validation" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 26: NPM Packages sheet

**Files:**
- Create: `apps/ui/src/npm/npm-panel.ts`, `apps/ui/src/npm/NpmSheet.tsx`
- Modify: `apps/ui/src/state/store.ts` (npm slice), `apps/ui/src/shell/ActivityBar.tsx:29-77`, `apps/ui/src/shell/App.tsx` (activity bar, sheet, messages), `apps/ui/src/e2e/snapshot.ts` (`npm`), `apps/ui/src/strings.ts` (`npm`), `apps/ui/src/styles.css`
- Test: `apps/ui/test/npm-panel.test.ts`, `apps/ui/test/npm-sheet.test.tsx`, `apps/ui/test/store.test.ts` (append), `apps/ui/isolated/app.test.tsx` (the activity-bar assertion), `packages/e2e/scenarios/npm-panel.test.ts`

**Interfaces:**
- Consumes: `parseInstallSpec` (`@jslab/npm/specifiers`); `InstalledPackage`, `NpmListResult`, `NpmOperation`, `NpmOpError`, `NpmSearchResult`, `NpmErrorKind` (Task 5); `MainApi.npm*` (Task 22); `writeSetting` (`commands/settings-writer.ts`); `bumpPackagesRevision` (Task 23).
- Produces:
  - Store:
    - `interface NpmUiState { loaded: boolean; installed: InstalledPackage[]; outdatedCheckedAt: number | null; outdatedError: NpmOpError | null; operations: NpmOperation[]; log: string; lastAdded: { name: string; at: number } | null }`
    - `npm: NpmUiState`
    - `receiveNpmList(list: NpmListResult, now?: number): void` (bumps `packagesRevision` when names or versions change)
    - `receiveNpmOperation(operation: NpmOperation): void`
    - `appendNpmLog(text: string): void`
  - `npm-panel.ts`:
    - `SEARCH_DEBOUNCE_MS = 300`, `HIGHLIGHT_MS = 2000`, `MAX_NPM_UI_LOG_CHARS = 64_000`, `MAX_NPM_OPERATIONS = 50`
    - `visibleInstalled(installed: readonly InstalledPackage[], showTypes: boolean): InstalledPackage[]`
    - `installTargetFor(query: string, results: readonly NpmSearchResult[]): string | null`
    - `shouldSearch(query: string): boolean`
    - `createSearchScheduler(search: (query: string) => void, timers?: TimerApi, delayMs?: number): { input(query: string): void; cancel(): void }`
    - `isHighlighted(lastAdded: NpmUiState["lastAdded"], name: string, now: number): boolean`
  - `ActivityBar` props `npmOpen?: boolean`, `npmKeys?: string | null`, `onNpm?(): void` (the button is enabled)
  - Snapshot: `npm: { installed: { name: string; version: string | null; latest: string | null }[]; operations: { kind: string; target: string; status: string; errorKind: string | null; notice: string | null }[]; outdatedError: string | null }`

**Rules (spec §11.2, §11.3, §7.5; parity TL-01..TL-07, TL-09):**
- **Opening.** The sheet opens from the activity bar (now enabled, `aria-pressed` while open), `Cmd+I`, Tools → NPM Packages… and the palette. Opening it asks for the list with `refreshOutdated: true`.
- **Search field.** Placeholder "Search npm, or type name@version".
  - Registry search starts 300 ms after typing stops. It runs only for a plain name (no `@version`, git, URL or path).
  - Results show name, version, description, weekly downloads when known, and **Add**.
  - Enter installs the typed spec when it has a version or range, or is git/tarball/path, or exactly matches a result's name.
- **Installed table.** Columns Name · Installed · Latest (with **Update** when newer) · Remove, with a sticky header. A newly added row is highlighted for 2 s.
  - The toolbar has **Update all** and a **Show @types** toggle (off by default: `@types/*` rows are hidden).
- **Allow install scripts** is bound to `npm.allowInstallScripts`.
- **Log drawer.** It streams `npm.log` output (the last 64,000 characters).
- **Failures.** A failed operation shows its kind's one-line hint and a disclosure with its raw log. A failed outdated check shows its hint above the table.
- **Escape** closes the sheet.

- [ ] **Step 1: Write the failing tests**

`apps/ui/test/npm-panel.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { TimerApi } from "../src/state/auto-run";
import { createSearchScheduler, installTargetFor, isHighlighted, shouldSearch, visibleInstalled } from "../src/npm/npm-panel";

describe("NPM panel logic (spec §11.2)", () => {
  test("Enter installs versioned, git, tarball and path specs, or an exact result name; plain names search", () => {
    const results = [{ name: "zod", version: "4.6.4", description: "", weeklyDownloads: null }];
    expect(installTargetFor("zod@4.6.4", [])).toBe("zod@4.6.4");
    expect(installTargetFor("@scope/name@latest", [])).toBe("@scope/name@latest");
    expect(installTargetFor("git+https://example.test/a.git", [])).toBe("git+https://example.test/a.git");
    expect(installTargetFor("zod", results)).toBe("zod");
    expect(installTargetFor("zo", results)).toBeNull();
    expect(installTargetFor("not a spec", results)).toBeNull();
    expect(["zod", "zod@4", "https://x.test/a.tgz", "z"].map(shouldSearch)).toEqual([true, false, false, false]);
  });

  test("@types rows are hidden unless Show @types is on, and a new row is highlighted for 2 s", () => {
    const installed = [
      { name: "@types/node", version: "22.20.2", latest: null },
      { name: "zod", version: "4.6.4", latest: null },
    ];
    expect(visibleInstalled(installed, false).map((p) => p.name)).toEqual(["zod"]);
    expect(visibleInstalled(installed, true)).toHaveLength(2);
    expect(isHighlighted({ name: "zod", at: 1000 }, "zod", 2999)).toBe(true);
    expect(isHighlighted({ name: "zod", at: 1000 }, "zod", 3001)).toBe(false);
    expect(isHighlighted(null, "zod", 0)).toBe(false);
  });

  test("search runs 300 ms after the last keystroke", () => {
    const pending: (() => void)[] = [];
    const timers: TimerApi = { setTimeout: (callback) => pending.push(callback), clearTimeout: () => pending.splice(0) };
    const search = mock((_query: string) => {});
    const scheduler = createSearchScheduler(search, timers);
    scheduler.input("z");
    scheduler.input("zo");
    scheduler.input("zod");
    for (const callback of pending.splice(0)) callback();
    expect(search.mock.calls).toEqual([["zod"]]);
  });
});
```

Append to `apps/ui/test/store.test.ts` (inside its main `describe`; add `createTab`, `defaultSession`, `defaultSettings` imports if missing):

```ts
  test("the npm slice keeps the list, upserts operations, bounds the log and marks a newly added package (spec §11.2)", () => {
    const store = createAppStore();
    const before = store.getState().packagesRevision;
    store.getState().receiveNpmList({ installed: [{ name: "zod", version: "4.6.4", latest: null }], outdatedCheckedAt: null, outdatedError: null }, 500);
    expect([store.getState().npm.loaded, store.getState().npm.lastAdded]).toEqual([true, null]);
    expect(store.getState().packagesRevision).toBe(before + 1);
    store.getState().receiveNpmList({ installed: [{ name: "zod", version: "4.6.4", latest: "4.7.0" }], outdatedCheckedAt: 1, outdatedError: null }, 900);
    expect(store.getState().packagesRevision).toBe(before + 1);
    store.getState().receiveNpmList(
      { installed: [{ name: "fixture-a", version: "1.0.0", latest: null }, { name: "zod", version: "4.6.4", latest: "4.7.0" }], outdatedCheckedAt: 1, outdatedError: null },
      1000,
    );
    expect(store.getState().npm.lastAdded).toEqual({ name: "fixture-a", at: 1000 });
    expect(store.getState().packagesRevision).toBe(before + 2);
    const op = { id: "op1", kind: "install", target: "zod", status: "running", error: null, notice: null } as const;
    store.getState().receiveNpmOperation(op);
    store.getState().receiveNpmOperation({ ...op, status: "succeeded" });
    expect(store.getState().npm.operations.map((o) => o.status)).toEqual(["succeeded"]);
    store.getState().appendNpmLog("x".repeat(70_000));
    store.getState().appendNpmLog("tail");
    expect(store.getState().npm.log.length).toBe(64_000);
    expect(store.getState().npm.log.endsWith("tail")).toBe(true);
  });
```

`apps/ui/test/npm-sheet.test.tsx`:

```ts
import { describe, expect, mock, test } from "bun:test";
import type { NpmListResult } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NpmSheet } from "../src/npm/NpmSheet";
import { createAppStore } from "../src/state/store";
import { strings } from "../src/strings";

const LIST: NpmListResult = {
  installed: [
    { name: "@types/fixture-a", version: "1.0.0", latest: null },
    { name: "fixture-a", version: "1.0.0", latest: "1.1.0" },
  ],
  outdatedCheckedAt: 1,
  outdatedError: null,
};

function setup() {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "" },
    safeMode: { active: false, reason: null },
    versions: { app: "0", bun: "1.4.0" },
  });
  const api = {
    npmList: mock(async (_refresh: boolean) => LIST),
    npmSearch: mock(async (_query: string) => ({ results: [{ name: "zod", version: "4.6.4", description: "schemas", weeklyDownloads: 1234 }], error: null })),
    npmInstall: mock((_spec: string) => {}),
    npmRemove: mock((_name: string) => {}),
    npmUpdate: mock((_name: string) => {}),
    npmUpdateAll: mock(() => {}),
    updateSettings: mock(async (patch: Parameters<typeof mergeSettings>[1]) => mergeSettings(defaultSettings(), patch)),
  };
  render(<NpmSheet store={store} api={api} />);
  act(() => store.getState().openModal({ kind: "npm" }));
  return { store, api };
}

describe("NPM Packages sheet (spec §11.2)", () => {
  test("lists installed packages without @types by default, with Update, Remove and Update all", async () => {
    const { api } = setup();
    expect(await screen.findByText("fixture-a")).toBeTruthy();
    expect(api.npmList).toHaveBeenCalledWith(true);
    expect(screen.queryByText("@types/fixture-a")).toBeNull();
    fireEvent.click(screen.getByLabelText(strings.npm.showTypes));
    expect(screen.getByText("@types/fixture-a")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.npm.update("fixture-a") }));
    fireEvent.click(screen.getByRole("button", { name: strings.npm.remove("fixture-a") }));
    fireEvent.click(screen.getByRole("button", { name: strings.npm.updateAll }));
    expect([api.npmUpdate.mock.calls, api.npmRemove.mock.calls, api.npmUpdateAll.mock.calls.length]).toEqual([[["fixture-a"]], [["fixture-a"]], 1]);
  });

  test("typing searches the registry, Add installs a result, and Enter installs a versioned spec", async () => {
    const { api } = setup();
    const search = screen.getByRole("searchbox", { name: strings.npm.searchLabel });
    fireEvent.change(search, { target: { value: "zod" } });
    await waitFor(() => expect(api.npmSearch).toHaveBeenCalledWith("zod"), { timeout: 1000 });
    expect(await screen.findByText(strings.npm.weekly(1234))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: strings.npm.add("zod") }));
    fireEvent.change(search, { target: { value: "zod@4.6.4" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(api.npmInstall.mock.calls).toEqual([["zod"], ["zod@4.6.4"]]);
  });

  test("a failed operation shows its hint and raw log, and the scripts checkbox writes the setting", async () => {
    const { store, api } = setup();
    await screen.findByText("fixture-a");
    act(() =>
      store.getState().receiveNpmOperation({
        id: "op9",
        kind: "install",
        target: "missing-pkg",
        status: "failed",
        error: { kind: "notFound", log: "error: package not found (404)" },
        notice: null,
      }),
    );
    expect(screen.getByText(strings.npm.hints.notFound)).toBeTruthy();
    expect(screen.getByText("error: package not found (404)")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(strings.npm.allowScripts));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ npm: { allowInstallScripts: true } }));
  });
});
```

In `apps/ui/isolated/app.test.tsx`, replace

```ts
    expect([npm.disabled, npm.title]).toEqual([true, strings.shell.laterMilestone]);
```

with

```ts
    expect([npm.disabled, npm.getAttribute("aria-pressed")]).toEqual([false, "false"]);
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun test ./test/npm-panel.test.ts ./test/npm-sheet.test.tsx ./test/store.test.ts`
Expected: FAIL, `Cannot find module "../src/npm/npm-panel"` and `receiveNpmList is not a function`.

- [ ] **Step 2: Implement the store slice and the panel logic**

`apps/ui/src/strings.ts`: add a top-level section:

```ts
  npm: {
    title: "NPM Packages",
    searchLabel: "Search packages",
    searchPlaceholder: "Search npm, or type name@version",
    weekly: (count: number) => `${count.toLocaleString("en-US")} weekly downloads`,
    add: (name: string) => `Add ${name}`,
    addButton: "Add",
    installed: "Installed",
    name: "Name",
    version: "Installed",
    latest: "Latest",
    update: (name: string) => `Update ${name}`,
    updateButton: "Update",
    remove: (name: string) => `Remove ${name}`,
    updateAll: "Update all",
    showTypes: "Show @types",
    allowScripts: "Allow install scripts",
    none: "No packages installed yet.",
    log: "Log",
    running: (kind: string, target: string) => `${kind === "remove" ? "Removing" : kind === "update" || kind === "updateAll" ? "Updating" : "Installing"} ${target}…`,
    failed: (target: string) => `Couldn't finish ${target}.`,
    outdatedFailed: (hint: string) => `Couldn't check for updates. ${hint}`,
    scriptBlocked: "Install scripts were blocked. Turn on Allow install scripts and install again to run them.",
    hints: {
      network: "Check your connection and the registry in Settings → NPM.",
      notFound: "No package with that name exists in the registry.",
      noMatchingVersion: "That version or range doesn't exist. Try name@latest.",
      peerConflict: "A peer dependency conflicts with an installed package.",
      scriptBlocked: "Install scripts were blocked. Turn on Allow install scripts.",
      nativeBuild: "A native module failed to build. See the log for the compiler error.",
      disk: "JSLab couldn't write the packages folder. Check disk space and permissions.",
      timeout: "The operation took longer than 5 minutes and was stopped.",
      unknown: "See the log for details.",
    },
  },
```

`apps/ui/src/npm/npm-panel.ts`:

```ts
import { parseInstallSpec } from "@jslab/npm/specifiers";
import type { InstalledPackage, NpmSearchResult } from "@jslab/rpc-schema";
import type { TimerApi } from "../state/auto-run";

export const SEARCH_DEBOUNCE_MS = 300;
export const HIGHLIGHT_MS = 2000;
export const MAX_NPM_UI_LOG_CHARS = 64_000;
export const MAX_NPM_OPERATIONS = 50;

export function visibleInstalled(installed: readonly InstalledPackage[], showTypes: boolean): InstalledPackage[] {
  return showTypes ? [...installed] : installed.filter((pkg) => !pkg.name.startsWith("@types/"));
}

/** A plain package name searches the registry; a version, range, git, URL or path spec installs on Enter. */
export function shouldSearch(query: string): boolean {
  const spec = parseInstallSpec(query);
  return spec?.kind === "registry" && spec.range === null && query.trim().length >= 2;
}

export function installTargetFor(query: string, results: readonly NpmSearchResult[]): string | null {
  const spec = parseInstallSpec(query);
  if (!spec) return null;
  if (spec.kind !== "registry" || spec.range !== null) return spec.raw;
  return results.some((result) => result.name === spec.name) ? spec.name : null;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createSearchScheduler(
  search: (query: string) => void,
  timers: TimerApi = defaultTimers,
  delayMs = SEARCH_DEBOUNCE_MS,
) {
  let handle: unknown = null;
  return {
    input(query: string) {
      if (handle !== null) timers.clearTimeout(handle);
      handle = timers.setTimeout(() => {
        handle = null;
        search(query);
      }, delayMs);
    },
    cancel() {
      if (handle !== null) timers.clearTimeout(handle);
      handle = null;
    },
  };
}

export function isHighlighted(lastAdded: { name: string; at: number } | null, name: string, now: number): boolean {
  return lastAdded?.name === name && now - lastAdded.at < HIGHLIGHT_MS;
}
```

`apps/ui/src/state/store.ts`:

1. Add to the `@jslab/rpc-schema` type import `InstalledPackage`, `NpmListResult`, `NpmOperation`, `NpmOpError`, and add `import { MAX_NPM_OPERATIONS, MAX_NPM_UI_LOG_CHARS } from "../npm/npm-panel";`.
2. Before `export interface AppState`, add:

```ts
export interface NpmUiState {
  /** False until the first list arrives, so the initial load highlights nothing. */
  loaded: boolean;
  installed: InstalledPackage[];
  outdatedCheckedAt: number | null;
  outdatedError: NpmOpError | null;
  operations: NpmOperation[];
  log: string;
  lastAdded: { name: string; at: number } | null;
}

export const initialNpm = (): NpmUiState => ({
  loaded: false,
  installed: [],
  outdatedCheckedAt: null,
  outdatedError: null,
  operations: [],
  log: "",
  lastAdded: null,
});
```

3. Add to `AppState`:

```ts
  /** The NPM Packages sheet (spec §11.2). */
  npm: NpmUiState;
  receiveNpmList(list: NpmListResult, now?: number): void;
  receiveNpmOperation(operation: NpmOperation): void;
  appendNpmLog(text: string): void;
```

4. Add `npm: initialNpm(),` to the initial state and these actions:

```ts
      receiveNpmList(list, now = Date.now()) {
        const previous = get().npm;
        const key = (installed: InstalledPackage[]) => installed.map((pkg) => `${pkg.name}@${pkg.version}`).join("\n");
        const known = new Set(previous.installed.map((pkg) => pkg.name));
        // Spec §11.2: only a package that appears after the list was already loaded is "newly added".
        const added = previous.loaded ? list.installed.find((pkg) => !known.has(pkg.name)) : undefined;
        set({
          npm: {
            ...previous,
            loaded: true,
            installed: list.installed,
            outdatedCheckedAt: list.outdatedCheckedAt,
            outdatedError: list.outdatedError,
            lastAdded: added ? { name: added.name, at: now } : previous.lastAdded,
          },
          ...(key(previous.installed) !== key(list.installed) ? { packagesRevision: get().packagesRevision + 1 } : {}),
        });
      },

      receiveNpmOperation(operation) {
        const operations = get().npm.operations.filter((existing) => existing.id !== operation.id);
        set({ npm: { ...get().npm, operations: [...operations, operation].slice(-MAX_NPM_OPERATIONS) } });
      },

      appendNpmLog(text) {
        set({ npm: { ...get().npm, log: (get().npm.log + text).slice(-MAX_NPM_UI_LOG_CHARS) } });
      },
```

- [ ] **Step 3: Implement the sheet, activity bar and wiring**

`apps/ui/src/npm/NpmSheet.tsx`:

```tsx
import type { NpmOpError, NpmSearchResult } from "@jslab/rpc-schema";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { writeSetting } from "../commands/settings-writer";
import type { AppStore } from "../state/store";
import { strings } from "../strings";
import {
  createSearchScheduler,
  HIGHLIGHT_MS,
  installTargetFor,
  isHighlighted,
  shouldSearch,
  visibleInstalled,
} from "./npm-panel";

type NpmApi = Pick<MainApi, "npmList" | "npmSearch" | "npmInstall" | "npmRemove" | "npmUpdate" | "npmUpdateAll" | "updateSettings">;

/** NPM Packages (spec §11.2), a modal sheet (spec §7.5). */
export function NpmSheet({ store, api }: { store: AppStore; api: NpmApi }) {
  const open = useStore(store, (s) => s.modal?.kind === "npm");
  const npm = useStore(store, (s) => s.npm);
  const allowScripts = useStore(store, (s) => s.settings?.npm.allowInstallScripts ?? false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NpmSearchResult[]>([]);
  const [searchError, setSearchError] = useState<NpmOpError | null>(null);
  const [showTypes, setShowTypes] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const search = useRef<HTMLInputElement>(null);
  const scheduler = useMemo(
    () =>
      createSearchScheduler((text) => {
        void api.npmSearch(text).then((response) => {
          setResults(response.results);
          setSearchError(response.error);
        });
      }),
    [api],
  );

  useEffect(() => {
    if (!open) return;
    void api.npmList(true).then((list) => store.getState().receiveNpmList(list));
    search.current?.focus();
    return () => scheduler.cancel();
  }, [open, api, store, scheduler]);

  useEffect(() => {
    if (!npm.lastAdded) return;
    setNow(Date.now());
    const timer = setTimeout(() => setNow(Date.now()), HIGHLIGHT_MS + 50);
    return () => clearTimeout(timer);
  }, [npm.lastAdded]);

  if (!open) return null;

  const running = npm.operations.find((op) => op.status === "running");
  const lastDone = [...npm.operations].reverse().find((op) => op.status === "failed" || op.status === "succeeded");
  const install = (spec: string) => {
    api.npmInstall(spec);
    setQuery("");
    setResults([]);
  };

  return (
    <div className="dialog-backdrop">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the whole sheet */}
      <div
        className="sheet npm-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={strings.npm.title}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            store.getState().closeModal();
          }
        }}
      >
        <h2>{strings.npm.title}</h2>
        <input
          ref={search}
          type="search"
          className="npm-search"
          aria-label={strings.npm.searchLabel}
          placeholder={strings.npm.searchPlaceholder}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (shouldSearch(event.target.value)) scheduler.input(event.target.value.trim());
            else scheduler.cancel();
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const target = installTargetFor(query, results);
            if (target) {
              event.preventDefault();
              install(target);
            }
          }}
        />
        {searchError && <p className="sheet-status">{strings.npm.hints[searchError.kind]}</p>}
        {results.length > 0 && (
          <ul className="npm-results">
            {results.map((result) => (
              <li key={result.name}>
                <div>
                  <strong>{result.name}</strong> <span className="npm-version">{result.version}</span>
                  <p>{result.description}</p>
                  {result.weeklyDownloads !== null && <span className="npm-downloads">{strings.npm.weekly(result.weeklyDownloads)}</span>}
                </div>
                <button type="button" aria-label={strings.npm.add(result.name)} onClick={() => install(result.name)}>
                  {strings.npm.addButton}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="npm-toolbar">
          <label>
            <input
              type="checkbox"
              checked={allowScripts}
              onChange={(event) => void writeSetting(store, api, "npm.allowInstallScripts", () => event.target.checked)}
            />
            {strings.npm.allowScripts}
          </label>
          <label>
            <input type="checkbox" checked={showTypes} onChange={(event) => setShowTypes(event.target.checked)} />
            {strings.npm.showTypes}
          </label>
          <button type="button" disabled={npm.installed.length === 0} onClick={() => api.npmUpdateAll()}>
            {strings.npm.updateAll}
          </button>
        </div>
        {npm.outdatedError && <p className="sheet-status">{strings.npm.outdatedFailed(strings.npm.hints[npm.outdatedError.kind])}</p>}
        {running && <p className="sheet-status">{strings.npm.running(running.kind, running.target)}</p>}
        {lastDone?.status === "failed" && lastDone.error && (
          <div className="npm-failure" role="alert">
            <p>
              {strings.npm.failed(lastDone.target)} <span>{strings.npm.hints[lastDone.error.kind]}</span>
            </p>
            <details>
              <summary>{strings.npm.log}</summary>
              <pre>{lastDone.error.log}</pre>
            </details>
          </div>
        )}
        {lastDone?.status === "succeeded" && lastDone.notice === "scriptBlocked" && <p className="sheet-status">{strings.npm.scriptBlocked}</p>}
        <div className="npm-installed">
          <table>
            <thead>
              <tr>
                <th>{strings.npm.name}</th>
                <th>{strings.npm.version}</th>
                <th>{strings.npm.latest}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {visibleInstalled(npm.installed, showTypes).map((pkg) => (
                <tr key={pkg.name} className={isHighlighted(npm.lastAdded, pkg.name, now) ? "npm-new" : undefined}>
                  <td>{pkg.name}</td>
                  <td>{pkg.version ?? "—"}</td>
                  <td>
                    {pkg.latest ?? ""}
                    {pkg.latest && (
                      <button type="button" aria-label={strings.npm.update(pkg.name)} onClick={() => api.npmUpdate(pkg.name)}>
                        {strings.npm.updateButton}
                      </button>
                    )}
                  </td>
                  <td>
                    <button type="button" aria-label={strings.npm.remove(pkg.name)} onClick={() => api.npmRemove(pkg.name)}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {npm.installed.length === 0 && <p className="sheet-status">{strings.npm.none}</p>}
        </div>
        <details className="npm-log">
          <summary>{strings.npm.log}</summary>
          <pre>{npm.log}</pre>
        </details>
      </div>
    </div>
  );
}
```

`apps/ui/src/shell/ActivityBar.tsx`: add to the props type

```ts
  /** True while the NPM Packages sheet is open. */
  npmOpen?: boolean;
  npmKeys?: string | null;
  onNpm?(): void;
```

and replace the disabled NPM button (lines 75-77) with:

```tsx
      <button
        type="button"
        title={strings.shell.withKeys(strings.shell.npm, props.npmKeys ?? null)}
        aria-label={strings.shell.npm}
        aria-pressed={props.npmOpen ?? false}
        onClick={props.onNpm}
      >
        <Icon path={ICONS.npm} />
      </button>
```

`apps/ui/src/shell/App.tsx`:
1. Add `import { NpmSheet } from "../npm/NpmSheet";`.
2. Add `const npmOpen = useStore(store, (s) => s.modal?.kind === "npm");` with the other selectors.
3. In `keycaps`, add `npm: keysFor("tools.npmPackages"),`.
4. Pass to `<ActivityBar …>`: `npmOpen={npmOpen}`, `npmKeys={keycaps.npm}`, `onNpm={() => registry.execute("tools.npmPackages")}`.
5. Render `<NpmSheet store={store} api={api} />` after `<EnvVarsSheet … />`.
6. In the view-message subscriptions, replace `api.on("npm.changed", () => store.getState().bumpPackagesRevision()),` with:

```ts
      api.on("npm.changed", (list) => store.getState().receiveNpmList(list)),
      api.on("npm.op", (operation) => store.getState().receiveNpmOperation(operation)),
      api.on("npm.log", ({ text }) => store.getState().appendNpmLog(text)),
```

`apps/ui/src/e2e/snapshot.ts`: add to `UiSnapshot`

```ts
  npm: {
    installed: { name: string; version: string | null; latest: string | null }[];
    operations: { kind: string; target: string; status: string; errorKind: string | null; notice: string | null }[];
    outdatedError: string | null;
  };
```

and to the object `snapshotState` returns:

```ts
    npm: {
      installed: state.npm.installed.map(({ name, version, latest }) => ({ name, version, latest })),
      operations: state.npm.operations.map((op) => ({
        kind: op.kind,
        target: op.target,
        status: op.status,
        errorKind: op.error?.kind ?? null,
        notice: op.notice,
      })),
      outdatedError: state.npm.outdatedError?.kind ?? null,
    },
```

`apps/ui/src/styles.css`, after the `.env-error` rule:

```css
.npm-search {
  width: 100%;
}

.npm-results {
  margin: 0;
  padding: 0;
  list-style: none;
}

.npm-results li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-muted);
}

.npm-results p {
  margin: 2px 0;
  color: var(--fg-muted);
}

.npm-version,
.npm-downloads {
  color: var(--fg-muted);
}

.npm-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}

.npm-installed {
  max-height: 260px;
  overflow: auto;
}

.npm-installed table {
  width: 100%;
  border-collapse: collapse;
}

.npm-installed thead th {
  position: sticky;
  top: 0;
  background: var(--bg-elevated);
  text-align: left;
}

.npm-installed tr.npm-new {
  background: var(--bg-accentMuted);
  transition: background 0.4s;
}

.npm-failure {
  color: var(--fg-error);
}

.npm-log pre,
.npm-failure pre {
  max-height: 160px;
  overflow: auto;
  font-family: var(--mono);
  white-space: pre-wrap;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun run test`
Expected: PASS, 0 fail.

- [ ] **Step 5: Add the scenario (no registry needed)**

`packages/e2e/scenarios/npm-panel.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let app: LaunchedApp | null = null;
afterEach(async () => {
  await app?.dispose();
  app = null;
});

interface NpmSnapshot {
  installed: { name: string; version: string | null; latest: string | null }[];
  outdatedError: string | null;
}

async function writePackage(userData: string, name: string, version: string) {
  const dir = join(userData, "packages", "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name, version }));
}

test("⌘I opens the installed table from the packages project; a dead registry reports a network hint (TL-01, TL-06, TL-09)", async () => {
  const userData = await createUserData();
  await mkdir(join(userData, "packages"), { recursive: true });
  await writeFile(
    join(userData, "packages", "package.json"),
    JSON.stringify({ name: "jslab-packages", private: true, dependencies: { "fixture-a": "1.0.0", "@types/fixture-a": "1.0.0" }, trustedDependencies: [] }),
  );
  await writePackage(userData, "fixture-a", "1.0.0");
  await writePackage(userData, "@types/fixture-a", "1.0.0");
  await writeFile(join(userData, "packages", ".npmrc"), "registry=http://127.0.0.1:9/\n");
  app = await launchApp({ userData, env: { JSLAB_E2E_BUN_CACHE_DIR: join(userData, "bun-cache") } });
  const current = app;
  await current.key("cmd+i");
  const npm = await waitFor(
    async () => {
      const ui = (await current.state()).ui;
      const snapshot = ui.npm as NpmSnapshot;
      return ui.modal === "npm" && snapshot.outdatedError ? snapshot : null;
    },
    { timeoutMs: 90_000, message: "the outdated check never reported" },
  );
  expect(npm.installed).toEqual([
    { name: "@types/fixture-a", version: "1.0.0", latest: null },
    { name: "fixture-a", version: "1.0.0", latest: null },
  ]);
  expect(npm.outdatedError).toBe("network");
  await current.key("escape");
  await waitFor(async () => (await current.state()).ui.modal === null || null);
});
```

- [ ] **Step 6: Run every gate and the scenarios**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/ui` M2 final + 44 (+ 1 with Branch B).

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../../packages/e2e && bun test ./scenarios/npm-panel.test.ts ./scenarios/tools.test.ts ./scenarios/layout.test.ts --timeout 180000` (shell `timeout` 600000)
Expected: all pass, 0 fail. Scenarios: M2 final + 10. Read-only `ps` check: no survivors.

- [ ] **Step 7: Commit**

```bash
git add apps/ui packages/e2e/scenarios/npm-panel.test.ts
git commit -m "feat(ui): npm packages sheet with search, installed table, update, remove and log" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 27: Settings window: NPM (`.npmrc` editor) and Build tabs

**Files:**
- Create: `apps/ui/src/settings/NpmrcEditor.tsx`, `apps/ui/src/settings/npmrc-monaco.ts`
- Modify: `apps/ui/src/settings/settings-rpc.ts`, `apps/ui/src/settings/SettingsApp.tsx:14-23` (state), `:74-110` (agent), `:145-157` (render), `apps/ui/src/settings/settings-agent.ts:6-13` (snapshot), `apps/ui/src/strings.ts` (`settings.npmrc`), `apps/ui/src/styles.css`
- Test: `apps/ui/test/npmrc-editor.test.tsx`, `apps/ui/test/settings-app.test.tsx` (fake api, one test appended), `packages/e2e/scenarios/settings-window.test.ts` (append)

**Interfaces:**
- Consumes: `npmrc.get`/`npmrc.save`/`npmrc.reset` (Task 18); the npm and build fields (Task 2); `DEFAULT_NPMRC` (Task 4).
- Produces:
  - `SettingsApi` gains `getNpmrc(): Promise<string>`, `saveNpmrc(content: string): Promise<SaveResult>`, `resetNpmrc(): Promise<string>`
  - `interface TextEditorLike { getValue(): string; setValue(value: string): void; onChange(listener: () => void): () => void; dispose(): void }`; `type CreateTextEditor = (host: HTMLElement, value: string) => Promise<TextEditorLike>`
  - `interface NpmrcEditorHandle { content(): string; dirty(): boolean; status(): string | null; set(content: string): void; save(): Promise<void>; reset(): Promise<void> }`
  - `NpmrcEditor({ api, createEditor?, onReady? })`
  - `SettingsSnapshot.npmrc: { content: string; dirty: boolean; status: string | null } | null`; settings E2E commands `npmrc.set` (`{ content }`), `npmrc.save`, `npmrc.reset`

**Rules (spec §11.5, §8 NPM and Build; parity TL-10, LB-05, ST-01):**
- The NPM tab shows a Monaco editor (ini mode) for `<packages>/.npmrc` above the two NPM fields, with **Reset** (restores `registry=https://registry.npmjs.org/` in the file) and **Save** (disabled until the text changes).
- A save or reset shows its status. A failed save shows the error, and the text stays in the editor.
- The Monaco editor loads lazily (a dynamic import) with only the editor worker and the ini language, so unit tests never load Monaco.
- Tokens in `.npmrc` never reach logs: Main never logs the content, and the redactor masks `_authToken` lines (spec §18).
- The Build tab (Task 2) applies live: after turning on `build.pipelineOperator`, the next run in the main window accepts `|>`.

- [ ] **Step 1: Write the failing tests**

`apps/ui/test/npmrc-editor.test.tsx`:

```ts
import { describe, expect, mock, test } from "bun:test";
import { DEFAULT_NPMRC } from "@jslab/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type CreateTextEditor, NpmrcEditor, type NpmrcEditorHandle } from "../src/settings/NpmrcEditor";
import { strings } from "../src/strings";

function fakeEditorFactory() {
  let value = "";
  const listeners = new Set<() => void>();
  const create: CreateTextEditor = async (_host, initial) => {
    value = initial;
    return {
      getValue: () => value,
      setValue: (next) => {
        value = next;
        for (const listener of listeners) listener();
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose: () => listeners.clear(),
    };
  };
  return { create, type: (next: string) => { value = next; for (const listener of listeners) listener(); } };
}

describe(".npmrc editor (spec §11.5)", () => {
  test("loads the file, enables Save after a change, saves and resets to the default registry", async () => {
    const editor = fakeEditorFactory();
    let handle: NpmrcEditorHandle | null = null;
    const api = {
      getNpmrc: mock(async () => "registry=http://127.0.0.1:4873/\n"),
      saveNpmrc: mock(async (_content: string) => ({ ok: true as const })),
      resetNpmrc: mock(async () => DEFAULT_NPMRC),
    };
    render(<NpmrcEditor api={api} createEditor={editor.create} onReady={(ready) => { handle = ready; }} />);
    await waitFor(() => expect(handle?.content()).toBe("registry=http://127.0.0.1:4873/\n"));
    const save = screen.getByRole("button", { name: strings.settings.npmrc.save }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    act(() => editor.type("registry=http://127.0.0.1:4874/\n"));
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
    });
    expect(api.saveNpmrc).toHaveBeenCalledWith("registry=http://127.0.0.1:4874/\n");
    expect(await screen.findByText(strings.settings.npmrc.saved)).toBeTruthy();
    await act(async () => {
      screen.getByRole("button", { name: strings.settings.npmrc.reset }).click();
    });
    expect((handle as NpmrcEditorHandle | null)?.content()).toBe(DEFAULT_NPMRC);
    expect((handle as NpmrcEditorHandle | null)?.dirty()).toBe(false);
  });

  test("a failed save keeps the text and shows the error", async () => {
    const editor = fakeEditorFactory();
    let handle: NpmrcEditorHandle | null = null;
    const api = {
      getNpmrc: mock(async () => ""),
      saveNpmrc: mock(async () => ({ ok: false as const, error: "EROFS: read-only file system" })),
      resetNpmrc: mock(async () => DEFAULT_NPMRC),
    };
    render(<NpmrcEditor api={api} createEditor={editor.create} onReady={(ready) => { handle = ready; }} />);
    await waitFor(() => expect(handle).not.toBeNull());
    act(() => (handle as NpmrcEditorHandle | null)?.set("//r/:_authToken=secret\n"));
    await act(async () => {
      await (handle as NpmrcEditorHandle | null)?.save();
    });
    expect(await screen.findByText(strings.settings.npmrc.saveFailed("EROFS: read-only file system"))).toBeTruthy();
    expect((handle as NpmrcEditorHandle | null)?.dirty()).toBe(true);
  });
});
```

In `apps/ui/test/settings-app.test.tsx`, add to the fake api object in `fakeSettingsApi`:

```ts
    getNpmrc: mock(async () => "registry=https://registry.npmjs.org/\n"),
    saveNpmrc: mock(async (_content: string) => ({ ok: true as const })),
    resetNpmrc: mock(async () => "registry=https://registry.npmjs.org/\n"),
```

and append inside `describe("SettingsApp", …)`:

```ts
  test("the NPM tab shows the .npmrc editor above its fields, and the Build tab its seven fields (ST-01)", async () => {
    const { api } = fakeSettingsApi();
    render(<SettingsApp api={api} initial={defaultSettings()} npmrcEditorFactory={async () => ({ getValue: () => "", setValue: () => {}, onChange: () => () => {}, dispose: () => {} })} />);
    fireEvent.click(screen.getByRole("tab", { name: "NPM" }));
    expect(await screen.findByRole("button", { name: strings.settings.npmrc.reset })).toBeTruthy();
    expect(screen.getByLabelText("Allow Install Scripts")).toBeTruthy();
    expect(api.getNpmrc).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("tab", { name: "Build" }));
    expect(screen.getByLabelText("Pipeline Operator")).toBeTruthy();
    expect(screen.queryByRole("button", { name: strings.settings.npmrc.reset })).toBeNull();
  });
```

(add `import { strings } from "../src/strings";` if the file doesn't import it yet).

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun test ./test/npmrc-editor.test.tsx ./test/settings-app.test.tsx`
Expected: FAIL, `Cannot find module "../src/settings/NpmrcEditor"`.

- [ ] **Step 2: Implement**

`apps/ui/src/strings.ts`: in `settings`, add:

```ts
    npmrc: {
      title: ".npmrc",
      help: "Registry and authentication for package installs. Your ~/.npmrc is never used.",
      editorLabel: ".npmrc contents",
      save: "Save",
      reset: "Reset",
      saved: "Saved .npmrc",
      resetDone: "Restored the default registry",
      loadFailed: "Couldn't read .npmrc",
      saveFailed: (error: string) => `Couldn't save .npmrc: ${error}`,
    },
```

`apps/ui/src/settings/settings-rpc.ts`: add `SaveResult` to the `@jslab/rpc-schema` type import, add to `SettingsApi`:

```ts
  getNpmrc(): Promise<string>;
  saveNpmrc(content: string): Promise<SaveResult>;
  resetNpmrc(): Promise<string>;
```

and to the returned object:

```ts
    getNpmrc: () => rpc.request["npmrc.get"]({}).then((reply) => reply.content),
    saveNpmrc: (content) => rpc.request["npmrc.save"]({ content }),
    resetNpmrc: () => rpc.request["npmrc.reset"]({}).then((reply) => reply.content),
```

`apps/ui/src/settings/npmrc-monaco.ts`:

```ts
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import type { TextEditorLike } from "./NpmrcEditor";

/** The Settings → NPM editor (spec §11.5): plain Monaco in ini mode, with only the editor worker. */
export function createNpmrcMonaco(host: HTMLElement, value: string): TextEditorLike {
  self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
  const editor = monaco.editor.create(host, {
    value,
    language: "ini",
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineNumbers: "on",
    theme: document.documentElement.dataset.themeType === "light" ? "vs" : "vs-dark",
  });
  return {
    getValue: () => editor.getValue(),
    setValue: (next) => editor.setValue(next),
    onChange: (listener) => {
      const subscription = editor.onDidChangeModelContent(listener);
      return () => subscription.dispose();
    },
    dispose: () => {
      editor.getModel()?.dispose();
      editor.dispose();
    },
  };
}
```

`apps/ui/src/settings/NpmrcEditor.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { strings } from "../strings";
import type { SettingsApi } from "./settings-rpc";

export interface TextEditorLike {
  getValue(): string;
  setValue(value: string): void;
  onChange(listener: () => void): () => void;
  dispose(): void;
}

export type CreateTextEditor = (host: HTMLElement, value: string) => Promise<TextEditorLike>;

export interface NpmrcEditorHandle {
  content(): string;
  dirty(): boolean;
  status(): string | null;
  set(content: string): void;
  save(): Promise<void>;
  reset(): Promise<void>;
}

const createMonacoEditor: CreateTextEditor = async (host, value) => (await import("./npmrc-monaco")).createNpmrcMonaco(host, value);

/** Settings → NPM (spec §11.5): the `<packages>/.npmrc` editor with Save and Reset. */
export function NpmrcEditor({
  api,
  createEditor = createMonacoEditor,
  onReady,
}: {
  api: Pick<SettingsApi, "getNpmrc" | "saveNpmrc" | "resetNpmrc">;
  createEditor?: CreateTextEditor;
  onReady?(handle: NpmrcEditorHandle | null): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<TextEditorLike | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const latest = useRef({ saved, text, status });
  latest.current = { saved, text, status };

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | null = null;
    void api.getNpmrc().then(
      async (content) => {
        if (disposed || !host.current) return;
        const created = await createEditor(host.current, content);
        if (disposed) {
          created.dispose();
          return;
        }
        editor.current = created;
        setSaved(content);
        setText(content);
        stop = created.onChange(() => setText(created.getValue()));
      },
      () => setStatus(strings.settings.npmrc.loadFailed),
    );
    return () => {
      disposed = true;
      stop?.();
      editor.current?.dispose();
      editor.current = null;
    };
  }, [api, createEditor]);

  const save = async () => {
    const content = editor.current?.getValue() ?? latest.current.text;
    const result = await api.saveNpmrc(content);
    if (result.ok) {
      setSaved(content);
      setStatus(strings.settings.npmrc.saved);
    } else {
      setStatus(strings.settings.npmrc.saveFailed(result.error));
    }
  };
  const reset = async () => {
    const content = await api.resetNpmrc();
    editor.current?.setValue(content);
    setSaved(content);
    setText(content);
    setStatus(strings.settings.npmrc.resetDone);
  };

  useEffect(() => {
    if (saved === null) return;
    onReady?.({
      content: () => editor.current?.getValue() ?? latest.current.text,
      dirty: () => (editor.current?.getValue() ?? latest.current.text) !== latest.current.saved,
      status: () => latest.current.status,
      set: (content) => editor.current?.setValue(content),
      save,
      reset,
    });
    return () => onReady?.(null);
  });

  return (
    <section className="npmrc">
      <h2>{strings.settings.npmrc.title}</h2>
      <p className="field-help">{strings.settings.npmrc.help}</p>
      <div ref={host} className="npmrc-editor" role="group" aria-label={strings.settings.npmrc.editorLabel} />
      <div className="settings-actions">
        <button type="button" onClick={() => void reset()}>
          {strings.settings.npmrc.reset}
        </button>
        <button type="button" disabled={saved === null || text === saved} onClick={() => void save()}>
          {strings.settings.npmrc.save}
        </button>
        {status && <span className="field-note">{status}</span>}
      </div>
    </section>
  );
}
```

`apps/ui/src/settings/settings-agent.ts`: add to `SettingsSnapshot`:

```ts
  npmrc: { content: string; dirty: boolean; status: string | null } | null;
```

`apps/ui/src/settings/SettingsApp.tsx`:

1. Add `import { type CreateTextEditor, NpmrcEditor, type NpmrcEditorHandle } from "./NpmrcEditor";`.
2. Change the component signature to

```tsx
export function SettingsApp({
  api,
  initial,
  e2e = false,
  npmrcEditorFactory,
}: {
  api: SettingsApi;
  initial: Settings;
  e2e?: boolean;
  /** Tests pass a fake editor; the app uses Monaco (loaded lazily). */
  npmrcEditorFactory?: CreateTextEditor;
}) {
```

3. Add `const npmrc = useRef<NpmrcEditorHandle | null>(null);` after the other state.
4. In the E2E agent `state`, add `npmrc: npmrc.current ? { content: npmrc.current.content(), dirty: npmrc.current.dirty(), status: npmrc.current.status() } : null,`. In `execute`, before `return false;` add:

```ts
        if (id === "npmrc.set" && npmrc.current) {
          npmrc.current.set(String((args as { content?: unknown }).content ?? ""));
          return true;
        }
        if (id === "npmrc.save" && npmrc.current) {
          void npmrc.current.save();
          return true;
        }
        if (id === "npmrc.reset" && npmrc.current) {
          void npmrc.current.reset();
          return true;
        }
```

5. Directly before `<div className="settings-fields">`, add:

```tsx
        {!query && tab === "npm" && (
          <NpmrcEditor
            api={api}
            {...(npmrcEditorFactory ? { createEditor: npmrcEditorFactory } : {})}
            onReady={(handle) => {
              npmrc.current = handle;
            }}
          />
        )}
```

`apps/ui/src/styles.css`, after `.settings-actions` (or at the end of the settings section):

```css
.npmrc {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 16px;
}

.npmrc h2 {
  margin: 0;
  font-size: 13px;
}

.npmrc-editor {
  height: 180px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  overflow: hidden;
}
```

- [ ] **Step 3: Run the tests and watch them pass**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/ui && bun run test`
Expected: PASS, 0 fail.

- [ ] **Step 4: Add the scenarios**

Append to `packages/e2e/scenarios/settings-window.test.ts` inside `describe("Settings window", …)` (add `stat` to the `node:fs/promises` import):

```ts
  test("Settings → NPM edits, saves and resets <packages>/.npmrc with mode 0600 (TL-10)", async () => {
    app = await launchApp();
    await openSettings();
    await current().settingsCommand("settings.tab", { tab: "npm" });
    await waitFor(async () => (await current().settingsState())?.npmrc?.content?.startsWith("registry=") || null, { timeoutMs: 30_000 });
    const npmrc = join(current().userData, "packages", ".npmrc");
    await current().settingsCommand("npmrc.set", { content: "registry=http://127.0.0.1:4873/\n" });
    await current().settingsCommand("npmrc.save");
    await waitFor(async () => (await readFile(npmrc, "utf8")) === "registry=http://127.0.0.1:4873/\n" || null);
    expect((await stat(npmrc)).mode & 0o777).toBe(0o600);
    await current().settingsCommand("npmrc.reset");
    await waitFor(async () => (await readFile(npmrc, "utf8")) === "registry=https://registry.npmjs.org/\n" || null);
  });

  test("turning on Pipeline Operator in Settings → Build lets the next run use |> (LB-05)", async () => {
    app = await launchApp({ settings: { version: 3, run: { autoRun: false } } });
    await openSettings();
    await current().settingsCommand("settings.set", { key: "build.pipelineOperator", value: true });
    await waitFor(async () => (await current().state()).ui.settings?.build?.pipelineOperator === true || null);
    await current().type("5 |> % * 2");
    await current().command("run.start");
    await current().waitForOutput((entries) => entries.some((entry) => entry.kind === "result" && entry.text === "10"), 30_000);
  });
```

- [ ] **Step 5: Run every gate, the scenarios and the full suite**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0. `@jslab/ui` M2 final + 47 (+ 1 with Branch B).

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../.. && bun run e2e > "$TMPDIR/jslab-e2e.log" 2>&1` in the background, then poll with the Global Constraints one-liner.
Expected: every scenario passes, 0 fail. Scenarios: M2 final + 12. `bun run e2e` starts no registry (no `jslab-registry-*` folder appears under `$TMPDIR`). Read-only `ps` check: no survivors.

- [ ] **Step 6: Commit**

```bash
git add apps/ui packages/e2e/scenarios/settings-window.test.ts
git commit -m "feat(ui): settings npm tab with the npmrc editor, and the build tab end to end" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 28: Opt-in npm E2E suite and the zod exit scenario

**Files:**
- Create: `packages/e2e/npm-scenarios/packages.test.ts` (not `scenarios-npm/`: `bun test ./scenarios` must never be able to reach it, Global Constraints (c))
- Modify: `packages/e2e/package.json` (`devDependencies`, `scripts`), `packages/e2e/tsconfig.json` (`include`), `package.json` (root `scripts`), `bun.lock`

**Interfaces:**
- Consumes:
  - `startTestRegistry`, `publishStandardFixtures` with `{ zod: true }` (Task 8)
  - `JSLAB_E2E_BUN_CACHE_DIR` (Task 18)
  - the `npm` snapshot (Task 26), `tsDiagnostics` and `e2e.completions` (Task 21), `e2e.installActions` (Task 23)
  - commands `npm.install`, `tools.npmPackages`, `wd.set` (Task 22)
  - the open-dialog stub (`e2e-open-dialog.json`)
- Produces: `bun run e2e:npm` (root) → `bun test ./npm-scenarios --timeout 600000` in `packages/e2e`; npm scenarios: 4.

**Rules (spec §24 M3 exit, §22.2, §22.3; binding default R-M3-PLAN-1 (e), (g)):**
- **Exit scenario (§-exact).** Install `zod` from the local registry. Import it from a working-directory file, with types (a deliberate type error is reported against zod's inferred type, and no 2307) and autocomplete (`parse`, `safeParse`). Use it in a run.
- **Isolation.** The suite starts one registry for the file (tracked PID, temp root, stopped in `afterAll`). Every launch's `<userData>/packages/.npmrc` points at it, and every launch sets `JSLAB_E2E_BUN_CACHE_DIR` to a temp cache. `bun run e2e` never runs these scenarios and never starts a registry.
- **In-app S8 check.** The app launched with `HOME` at a fake home whose `.npmrc` names a dead scoped registry still installs the scoped fixture, and `npm-home` stays empty.

- [ ] **Step 1: Wire the suite**

`packages/e2e/package.json`: add `"devDependencies": { "@jslab/test-registry": "workspace:*" }` and the script `"e2e:npm": "bun test ./npm-scenarios --timeout 600000"`. `packages/e2e/tsconfig.json`: `"include": ["src", "test", "scenarios", "npm-scenarios"]`. Root `package.json` `scripts`: add `"e2e:npm": "bun run --cwd packages/e2e e2e:npm"`.

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun install`
Expected: exit 0; `bun.lock` gains only the workspace link.

- [ ] **Step 2: Write the scenarios**

`packages/e2e/npm-scenarios/packages.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishStandardFixtures, startTestRegistry, type TestRegistry } from "@jslab/test-registry";
import { activeTab, createUserData, type LaunchedApp, launchApp, waitFor } from "../src";

let registry: TestRegistry;
let work = "";
let apps: LaunchedApp[] = [];

beforeAll(async () => {
  registry = await startTestRegistry();
  work = await mkdtemp(join(tmpdir(), "jl-npm-"));
  await publishStandardFixtures(registry.url, work, { zod: true });
}, 300_000);

afterEach(async () => {
  for (const app of apps.reverse()) await app.dispose();
  apps = [];
});

afterAll(async () => {
  await registry?.stop();
  await rm(work, { recursive: true, force: true });
});

interface NpmSnapshot {
  installed: { name: string; version: string | null }[];
  operations: { target: string; status: string; errorKind: string | null }[];
}
interface TsDiagnostic {
  code: number;
  message: string;
}

async function launchWithRegistry(options: { settings?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const userData = await createUserData();
  await mkdir(join(userData, "packages"), { recursive: true });
  await writeFile(join(userData, "packages", ".npmrc"), `registry=${registry.url}\n`);
  const app = await launchApp({
    userData,
    settings: { version: 3, run: { autoRun: false }, ...options.settings },
    env: { JSLAB_E2E_BUN_CACHE_DIR: join(work, "bun-cache"), ...options.env },
  });
  apps.push(app);
  return app;
}

const npmOf = async (app: LaunchedApp) => (await app.state()).ui.npm as NpmSnapshot;

async function waitForInstalled(app: LaunchedApp, name: string, version?: string) {
  await waitFor(
    async () => {
      const npm = await npmOf(app);
      const failed = npm.operations.find((op) => op.target.startsWith(name) && op.status === "failed");
      if (failed) throw new Error(`install of ${name} failed: ${failed.errorKind}`);
      return npm.installed.some((pkg) => pkg.name === name && (!version || pkg.version === version)) || null;
    },
    { timeoutMs: 180_000, message: `${name} was never installed` },
  );
}

async function typeCode(app: LaunchedApp, code: string) {
  await app.type(code);
  await waitFor(async () => activeTab(await app.state()).code === code || null);
}

async function installActions(app: LaunchedApp, predicate: (actions: { spec: string }[]) => boolean) {
  return waitFor(
    async () => {
      const reply = await app.client.call<{ result: { actions: { title: string; spec: string }[] } }>("e2e.command", {
        id: "e2e.installActions",
      });
      return predicate(reply.result.actions) ? reply.result.actions : null;
    },
    { timeoutMs: 60_000, message: "the expected install action never appeared" },
  );
}

describe("npm packages against the local test registry (opt-in)", () => {
  test("M3 exit: install zod, import it through a working-directory file with types and autocomplete, and run it", async () => {
    const app = await launchWithRegistry();
    const wd = join(app.userData, "api");
    await mkdir(wd, { recursive: true });
    await writeFile(join(wd, "user.ts"), 'import { z } from "zod";\nexport const User = z.object({ name: z.string() });\n');

    await app.key("cmd+i");
    await waitFor(async () => (await app.state()).ui.modal === "npm" || null);
    await app.command("npm.install", { spec: "zod@4.6.4" });
    await waitForInstalled(app, "zod", "4.6.4");
    await app.key("escape");
    await waitFor(async () => (await app.state()).ui.modal === null || null);

    await writeFile(join(app.userData, "e2e-open-dialog.json"), JSON.stringify([wd]));
    await app.command("wd.set");
    await waitFor(async () => activeTab(await app.state()).workingDirectory === wd || null);

    const code = [
      'import { User } from "./user";',
      'const parsed = User.parse({ name: "Ada" });',
      "const wrong: number = parsed.name;",
      "console.log(parsed.name);",
      "User.parse",
    ].join("\n");
    await typeCode(app, code);
    await app.command("run.start");
    await app.waitForOutput((entries) => entries.some((entry) => entry.kind === "console" && entry.text === "Ada"), 60_000);

    const diagnostics = await waitFor(
      async () => {
        const found = ((await app.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[];
        return found.some((d) => d.code === 2322) ? found : null;
      },
      { timeoutMs: 60_000, message: "zod's types never reached the editor" },
    );
    expect(diagnostics.filter((d) => d.code === 2307)).toEqual([]);
    const reply = await app.client.call<{ result: { completions: string[] } }>("e2e.command", {
      id: "e2e.completions",
      args: { offset: code.lastIndexOf("parse") },
    });
    expect(reply.result.completions).toEqual(expect.arrayContaining(["parse", "safeParse"]));
  });

  test("install assist offers the package, then its @types package, and types arrive after installing it (ED-26, TL-04)", async () => {
    const app = await launchWithRegistry();
    await typeCode(app, 'import fixture from "fixture-untyped";\nconsole.log(fixture.untyped);');
    await installActions(app, (actions) => actions.some((action) => action.spec === "fixture-untyped"));
    await app.command("npm.install", { spec: "fixture-untyped" });
    await waitForInstalled(app, "fixture-untyped");
    await app.command("run.start");
    await app.waitForOutput((entries) => entries.some((entry) => entry.kind === "console" && entry.text === "yes"), 60_000);
    await installActions(app, (actions) => actions.some((action) => action.spec === "@types/fixture-untyped"));
    await app.command("npm.install", { spec: "@types/fixture-untyped" });
    await waitForInstalled(app, "@types/fixture-untyped");
    await waitFor(
      async () => (((await app.state()).ui.tsDiagnostics ?? []) as TsDiagnostic[]).every((d) => d.code !== 2307) || null,
      { timeoutMs: 60_000, message: "the @types package never cleared the missing-module diagnostic" },
    );
  });

  test("allowed install scripts run with trustedDependencies, and automatic types install @types (TL-07, XT-12)", async () => {
    const app = await launchWithRegistry({ settings: { npm: { allowInstallScripts: true, autoInstallTypes: true } } });
    await app.command("npm.install", { spec: "fixture-script@1.0.0" });
    await waitForInstalled(app, "fixture-script", "1.0.0");
    expect(existsSync(join(app.userData, "packages", "node_modules", "fixture-script", "postinstall-ran.txt"))).toBe(true);
    expect(JSON.parse(readFileSync(join(app.userData, "packages", "package.json"), "utf8")).trustedDependencies).toEqual([
      "fixture-script",
    ]);
    await app.command("npm.install", { spec: "fixture-untyped@1.0.0" });
    await waitForInstalled(app, "@types/fixture-untyped");
  });

  test("in the app, a dead scoped registry in HOME's .npmrc never reaches npm operations (M0-S8, TL-10)", async () => {
    const fakeHome = join(work, "fake-home");
    await mkdir(fakeHome, { recursive: true });
    await writeFile(join(fakeHome, ".npmrc"), "@jslab-fixture:registry=http://127.0.0.1:9/\n");
    const app = await launchWithRegistry({ env: { HOME: fakeHome } });
    await app.command("npm.install", { spec: "@jslab-fixture/scoped@1.0.0" });
    await waitForInstalled(app, "@jslab-fixture/scoped", "1.0.0");
    expect(readdirSync(join(app.userData, "npm-home"))).toEqual([]);
    expect(readFileSync(join(fakeHome, ".npmrc"), "utf8")).toBe("@jslab-fixture:registry=http://127.0.0.1:9/\n");
  });
});
```

- [ ] **Step 3: Run the npm suite against the dev build**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && hutch run build:dev && builtin cd ../.. && bun run e2e:npm > "$TMPDIR/jslab-e2e-npm.log" 2>&1` in the background, then poll `"$TMPDIR/jslab-e2e-npm.log"` with the Global Constraints one-liner (substitute the log path).
Expected: `4 pass`, `0 fail`. Afterwards no `jslab-registry-*` or `jl-npm-*` folder remains under `$TMPDIR`, and a read-only `ps -o pid,command -p <registry PID printed in the log, if any>` shows nothing.

If the exit scenario fails only on the completion or diagnostics assertions, stop and report `tsDiagnostics`, the completion list, and the extra-lib paths the Editor applied (add a temporary `console.warn(tsEnvironment.libPaths())` in a scratch build, not committed). The controller rules (R-M3-EXIT-1). Never weaken the exit assertions.

- [ ] **Step 4: Run every gate and confirm the normal suite is unaffected**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run lint && bun run typecheck && bun run test`
Expected: exit 0; counts as in the Task 27 row (this task adds no unit tests).

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run e2e > "$TMPDIR/jslab-e2e.log" 2>&1` in the background, then poll.
Expected: the same scenario count as Task 27 (M2 final + 12), 0 fail; nothing from `npm-scenarios` runs, and no `jslab-registry-*` folder appears under `$TMPDIR`. If the count is higher, stop and report both numbers (Global Constraints (c)).

- [ ] **Step 5: Commit**

```bash
git add packages/e2e package.json bun.lock
git commit -m "test(e2e): opt-in npm suite with the zod exit scenario against the local registry" -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 29: App icon: Graphite source image and a generated `icon.iconset`

**Files:**
- Create: `apps/desktop/scripts/app-icon.ts` (renderer, PNG encoder, iconset table), `apps/desktop/scripts/build-app-icon.ts` (writes the source image, runs `sips` and `iconutil`)
- Create (generated, committed): `apps/desktop/assets/app-icon-1024.png`, and `apps/desktop/icon.iconset/` with `icon_16x16.png`, `icon_16x16@2x.png`, `icon_32x32.png`, `icon_32x32@2x.png`, `icon_128x128.png`, `icon_128x128@2x.png`, `icon_256x256.png`, `icon_256x256@2x.png`, `icon_512x512.png`, `icon_512x512@2x.png`
- Test: `apps/desktop/test/app-icon.test.ts`

**Interfaces:**
- Consumes: nothing from earlier M3 tasks. The Graphite tokens `bg.canvas #1B1E23`, `bg.chrome #16191D` and `fg.accent #6F9BFF` (the chosen UI direction; `apps/ui/src/styles.css` already uses `--fg-accent: #6f9bff`).
- Produces (`apps/desktop/scripts/app-icon.ts`):
  - `type Rgb = readonly [number, number, number]`; `ICON_COLORS: { canvas: Rgb; chrome: Rgb; accent: Rgb }`
  - `ICONSET_ENTRIES: readonly { file: string; pixels: number }[]` (the ten files above; pixel sizes 16, 32, 64, 128, 256, 512 and 1024)
  - `renderAppIcon(size: number): Uint8Array` (RGBA, straight alpha); `encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array`; `pngSize(bytes: Uint8Array): { width: number; height: number }`

**Rules (branding carry; the GitHub Actions build log shows `hutch electrobun: macOS icon source not found: apps/desktop/icon.iconset`, so the app ships without an icon):**
- **Graphite direction.** A macOS-style rounded square (80% of the canvas, corner radius 22.5% of its width), with a `bg.chrome` rim and a `bg.canvas` face, and a `{ }` monogram stroked in `fg.accent`. The corners outside the square are transparent.

  > **Superseded during M4 — this paragraph describes what Task 29 actually built and is kept as the record of it, not corrected.** The `{ }` monogram was replaced by the "split rail" design (code lines left, a full-bleed accent output rail right, notched on the middle row) because the monogram's stroke was **0.055 × size — 0.9 px at 16 px**, below what a display resolves, so the icon smudged to grey in the Dock and Spotlight. The rounded square, the 80% inset and the 22.5% corner radius **all survive unchanged**: macOS applies no mask of its own to an `.icns`, so that geometry is what puts the icon on the same grid as its neighbours. See `apps/desktop/scripts/app-icon.ts` for the current artwork.
- **One committed source image,** `apps/desktop/assets/app-icon-1024.png` (1024×1024), rendered in-repo by `scripts/app-icon.ts`. No external assets, fonts or downloads.
- **The iconset** is made from the source with macOS `sips -z` and validated with `iconutil`, both run by the committed `scripts/build-app-icon.ts`. The source and the iconset are both committed, so `hutch run build` (local and CI) needs no generation step.
- **The unit test** checks that every iconset file exists with its exact pixel size, and that the renderer draws the accent monogram on the canvas face with transparent corners. It reads committed files only, so it runs on CI's `macos-14` without `sips`. *(Superseded with the artwork — see the note above. The test now asserts the split rail's anatomy instead of the monogram, and adds a 16 px legibility check that fails on exactly the defect which retired the old design. The iconset and transparent-corner assertions are unchanged.)*
- **No scenario.** The icon shows in Finder and the Dock, not in the app window, so it's verified from the build output (Step 5).

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/app-icon.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng, ICON_COLORS, ICONSET_ENTRIES, pngSize, renderAppIcon } from "../scripts/app-icon";

const ICONSET = join(import.meta.dir, "..", "icon.iconset");

const pixel = (rgba: Uint8Array, size: number, x: number, y: number) => {
  const offset = (Math.floor(y) * size + Math.floor(x)) * 4;
  return [...rgba.subarray(offset, offset + 4)];
};

describe("app icon (branding carry)", () => {
  test("icon.iconset holds the ten macOS icon files at their exact pixel sizes", () => {
    expect(readdirSync(ICONSET).filter((name) => name.endsWith(".png")).sort()).toEqual(
      ICONSET_ENTRIES.map((entry) => entry.file).sort(),
    );
    for (const entry of ICONSET_ENTRIES) {
      const path = join(ICONSET, entry.file);
      expect(existsSync(path)).toBe(true);
      expect(pngSize(readFileSync(path))).toEqual({ width: entry.pixels, height: entry.pixels });
    }
    expect([...new Set(ICONSET_ENTRIES.map((entry) => entry.pixels))].sort((a, b) => a - b)).toEqual([
      16, 32, 64, 128, 256, 512, 1024,
    ]);
    expect(pngSize(readFileSync(join(import.meta.dir, "..", "assets", "app-icon-1024.png")))).toEqual({
      width: 1024,
      height: 1024,
    });
  });

  test("the renderer draws the accent { } monogram on the Graphite face, with transparent corners", () => {
    const size = 256;
    const rgba = renderAppIcon(size);
    expect(rgba.length).toBe(size * size * 4);
    expect(pixel(rgba, size, 2, 2)[3]).toBe(0);
    // The face between the braces' tops and the rim.
    expect(pixel(rgba, size, size / 2, size * 0.2)).toEqual([...ICON_COLORS.canvas, 255]);
    // The stems of "{" and "}" (x = centre ∓ 17%, between the top hook and the tip).
    expect(pixel(rgba, size, size * 0.33, size * 0.4)).toEqual([...ICON_COLORS.accent, 255]);
    expect(pixel(rgba, size, size * 0.67, size * 0.4)).toEqual([...ICON_COLORS.accent, 255]);
    expect(pngSize(encodePng(4, 4, renderAppIcon(4)))).toEqual({ width: 4, height: 4 });
  });
});
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/app-icon.test.ts`
Expected: FAIL, `Cannot find module "../scripts/app-icon"`.

- [ ] **Step 2: Implement the renderer and the PNG encoder**

`apps/desktop/scripts/app-icon.ts`:

```ts
import { deflateSync } from "node:zlib";

export type Rgb = readonly [number, number, number];
type Point = readonly [number, number];

/** Graphite tokens: bg.canvas, bg.chrome and fg.accent. */
export const ICON_COLORS: { canvas: Rgb; chrome: Rgb; accent: Rgb } = {
  canvas: [0x1b, 0x1e, 0x23],
  chrome: [0x16, 0x19, 0x1d],
  accent: [0x6f, 0x9b, 0xff],
};

/** The macOS iconset files (iconutil's names) and their pixel sizes. */
export const ICONSET_ENTRIES: readonly { file: string; pixels: number }[] = [16, 32, 128, 256, 512].flatMap((points) => [
  { file: `icon_${points}x${points}.png`, pixels: points },
  { file: `icon_${points}x${points}@2x.png`, pixels: points * 2 },
]);

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [
  from[0] + (to[0] - from[0]) * amount,
  from[1] + (to[1] - from[1]) * amount,
  from[2] + (to[2] - from[2]) * amount,
];

/** Signed distance from (x, y) to a rounded square centred at (c, c) with half-size `half` and corner radius `radius`. */
function roundedSquareDistance(x: number, y: number, c: number, half: number, radius: number): number {
  const qx = Math.abs(x - c) - (half - radius);
  const qy = Math.abs(y - c) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function distanceToSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp01(((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared);
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** Points on a circular arc from `from` to `to` degrees (y grows downward). */
function arc(cx: number, cy: number, radius: number, from: number, to: number, steps = 12): Point[] {
  return Array.from({ length: steps + 1 }, (_, index): Point => {
    const angle = ((from + ((to - from) * index) / steps) * Math.PI) / 180;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });
}

/** "{" as a polyline: the top hook, the stem, the tip at mid-height, the stem, the bottom hook. */
function leftBrace(size: number): Point[] {
  const c = size / 2;
  const x = c - 0.17 * size;
  const top = c - 0.2 * size;
  const bottom = c + 0.2 * size;
  const r = 0.06 * size;
  return [
    ...arc(x + r, top + r, r, 270, 180),
    ...arc(x - r, c - r, r, 0, 90),
    ...arc(x - r, c + r, r, 270, 360),
    ...arc(x + r, bottom - r, r, 180, 90),
  ];
}

/** The JSLab app icon at `size`×`size` pixels, as straight-alpha RGBA. */
export function renderAppIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const c = size / 2;
  const half = 0.4 * size;
  const radius = 0.225 * (2 * half);
  const rim = 0.035 * size;
  const strokeHalf = 0.0275 * size;
  const left = leftBrace(size);
  const right = left.map(([x, y]): Point => [size - x, y]);
  const segments: [Point, Point][] = [];
  for (const brace of [left, right]) {
    for (let index = 1; index < brace.length; index++) segments.push([brace[index - 1] as Point, brace[index] as Point]);
  }
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = px + 0.5;
      const y = py + 0.5;
      const body = clamp01(0.5 - roundedSquareDistance(x, y, c, half, radius));
      if (body === 0) continue;
      const face = clamp01(0.5 - roundedSquareDistance(x, y, c, half - rim, Math.max(radius - rim, 0)));
      let ink = 0;
      // Only pixels near the braces (|x - c| within 17% ± 6% plus the stroke) measure segment distances.
      if (Math.abs(Math.abs(x - c) - 0.17 * size) <= 0.06 * size + strokeHalf + 1 && Math.abs(y - c) <= 0.2 * size + strokeHalf + 1) {
        let nearest = Number.POSITIVE_INFINITY;
        for (const [a, b] of segments) nearest = Math.min(nearest, distanceToSegment(x, y, a, b));
        ink = clamp01(strokeHalf + 0.5 - nearest);
      }
      const color = mix(mix(ICON_COLORS.chrome, ICON_COLORS.canvas, face), ICON_COLORS.accent, ink);
      const offset = (py * size + px) * 4;
      rgba[offset] = Math.round(color[0]);
      rgba[offset + 1] = Math.round(color[1]);
      rgba[offset + 2] = Math.round(color[2]);
      rgba[offset + 3] = Math.round(255 * body);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A minimal 8-bit RGBA PNG: no interlace, filter type 0 on every row. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const rows = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row++) rows.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(rows))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 24 || view.getUint32(12) !== 0x49484452) throw new Error("not a PNG with an IHDR chunk");
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun test test/app-icon.test.ts`
Expected: the renderer test passes; the iconset test still fails (`ENOENT … icon.iconset`), because Step 3 generates the files.

- [ ] **Step 3: Generate the source image and the iconset with sips and iconutil**

`apps/desktop/scripts/build-app-icon.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng, ICONSET_ENTRIES, renderAppIcon } from "./app-icon";

// Branding carry: renders assets/app-icon-1024.png, then builds icon.iconset from it with macOS sips and validates it
// with iconutil. Run from apps/desktop with `bun scripts/build-app-icon.ts`. Needs macOS; downloads nothing.
const SOURCE_PIXELS = 1024;
const desktop = join(import.meta.dir, "..");
const source = join(desktop, "assets", "app-icon-1024.png");
const iconset = join(desktop, "icon.iconset");

function run(argv: string[]): void {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed (exit ${result.exitCode}): ${result.stderr.toString()}`);
}

await mkdir(join(desktop, "assets"), { recursive: true });
await writeFile(source, encodePng(SOURCE_PIXELS, SOURCE_PIXELS, renderAppIcon(SOURCE_PIXELS)));
await rm(iconset, { recursive: true, force: true });
await mkdir(iconset, { recursive: true });
for (const entry of ICONSET_ENTRIES) {
  run(["sips", "-z", String(entry.pixels), String(entry.pixels), source, "--out", join(iconset, entry.file)]);
}
// iconutil rejects a malformed iconset. Its .icns goes to a fresh temp folder and is not committed.
const check = await mkdtemp(join(tmpdir(), "jslab-icns-"));
try {
  run(["iconutil", "--convert", "icns", "--output", join(check, "icon.icns"), iconset]);
} finally {
  await rm(check, { recursive: true, force: true });
}
console.log(`Wrote assets/app-icon-1024.png and ${ICONSET_ENTRIES.length} files in icon.iconset`);
```

Run: `export PATH="$HOME/.hutch/bin:$PATH" && builtin cd apps/desktop && bun scripts/build-app-icon.ts && bun test test/app-icon.test.ts`
Expected: `Wrote assets/app-icon-1024.png and 10 files in icon.iconset`, then `2 pass`, `0 fail`. Open `apps/desktop/assets/app-icon-1024.png` with an image viewer (for example the Read tool) and confirm a dark rounded square with a blue `{ }`. If it looks wrong, fix the renderer and regenerate; don't hand-edit PNGs.

- [ ] **Step 4: Run every gate**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && bun run format && bun run lint && bun run typecheck && bun run test`, then `bun run test` again under the Bun 1.4.0 shim (Global Constraints (a)).
Expected: exit 0. `@jslab/desktop` M2 final + 50; every other package as in the Task 28 row.

- [ ] **Step 5: Verify the built apps carry the icon**

Run (shell `timeout` 600000 for each build):

```bash
export PATH="$HOME/.hutch/bin:$PATH"
builtin cd apps/desktop && hutch run build:dev > "$TMPDIR/jslab-icon-build-dev.log" 2>&1; builtin cd ../..
grep -c "icon source not found" "$TMPDIR/jslab-icon-build-dev.log"
APP="$(ls -d apps/desktop/build/dev-macos-arm64/*.app)"
plutil -extract CFBundleIconFile raw "$APP/Contents/Info.plist"
find "$APP/Contents/Resources" -maxdepth 1 -name "*.icns"
builtin cd apps/desktop && hutch run build > "$TMPDIR/jslab-icon-build-canary.log" 2>&1; builtin cd ../..
grep -c "icon source not found" "$TMPDIR/jslab-icon-build-canary.log"
CANARY="$(ls -d apps/desktop/build/canary-macos-arm64/*.app)"
plutil -extract CFBundleIconFile raw "$CANARY/Contents/Info.plist"
```

Expected:
- Both builds exit 0, and both `grep -c` commands print `0` (the `macOS icon source not found` notice is gone).
- The dev bundle's `Info.plist` names a `CFBundleIconFile`, and `Contents/Resources` holds one `.icns` whose name matches it.
- The canary bundle's `Info.plist` names a `CFBundleIconFile`. The canary ships as a launcher plus `.tar.zst` until its first launch, so its `.icns` may appear only after self-extraction; don't launch it for this check.

**If the notice still appears, or a bundle has no `CFBundleIconFile`, STOP.** Report the matching log lines and the `plutil` output. Don't change `electrobun.config.ts` or `hutch.config.ts` without a controller ruling.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/scripts/app-icon.ts apps/desktop/scripts/build-app-icon.ts apps/desktop/assets/app-icon-1024.png apps/desktop/icon.iconset apps/desktop/test/app-icon.test.ts
git commit -m "feat(desktop): graphite app icon with a generated macos iconset" -m "Branding carry: the CI build log showed 'hutch electrobun: macOS icon source not found: apps/desktop/icon.iconset'. The next GitHub Actions release build log should no longer show it." -m "$JSLAB_COMMIT_TRAILER"
```

---

### Task 30: `docs/user/bun-vs-node.md`, M3 QA checklist, spec amendments, parity, roadmap, full runs

**Files:**
- Create: `docs/user/bun-vs-node.md`, `docs/qa/m3-checklist.md`
- Modify: `docs/superpowers/specs/2026-09-12-jslab-design.md`, `docs/parity.md` (M3 rows and TF-11, TF-18, TF-19, ST-01), `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`

**Interfaces:**
- Consumes: the complete M3 app, `bun run test`, `bun run test:npm`, `bun run e2e`, `bun run e2e:npm`, and rulings R-M3-SPIKE-1, R-M3-REG-1, R-M3-CAP-1 (if any), R-M1-3 (GUI-only items stay "pending user"), R-M1-13 (scoped canary teardown), R-M1-14 (internal-disk launch cwd), R-M2-T25-1 (move the canary data folder, never delete it).
- Produces: a signed-off M3, parity statuses the M4 plan starts from, and spec amendments for M3's decisions.

The controller copies this plan into `docs/superpowers/plans/2026-09-14-jslab-m3-language-packages.md` before Task 1. This task only links it from the roadmap.

- [ ] **Step 1: Write `docs/user/bun-vs-node.md`**

If web access is available to this dispatch, read Bun's Node.js compatibility page (`https://bun.sh/docs/runtime/nodejs-apis`, read-only) and adjust the module lines below to what it says for Bun 1.4. Record the date checked in the file's last line. Without web access, keep the text as written and write `Not yet checked against Bun's compatibility page for Bun 1.4.0.` as the last line; checklist item Q18 then stays pending.

`docs/user/bun-vs-node.md`:

````markdown
# Bun vs Node: what's different in JSLab's Bun runtime

JSLab's **Bun** runtime runs your code with the Bun that ships inside JSLab (1.4.0). Bun aims to be Node-compatible, and most code written for Node runs unchanged. These are the differences you are most likely to notice.

## The engine

- Bun runs on JavaScriptCore (the engine in Safari), not V8. Anything tied to V8 behaves differently:
  - The `v8` module is only partly available, and heap snapshots don't use V8's format.
  - Node's `--inspect` flags don't apply.
  - Stack trace text is formatted differently. JSLab maps positions back to your code and renders stacks itself, so the output panel looks the same either way.

## Built-in modules

- `node:inspector`, `node:trace_events` and `node:repl` are partial or missing.
- `node:vm` works, with edge-case differences in how contexts behave.
- `worker_threads` supports most APIs; some options are missing.
- Native addons built on N-API generally work. Addons that use V8's C++ API directly don't.

## Module resolution

- Resolution is looser than Node's, closer to a bundler's: extensionless imports such as `import "./util"` work, and `require` is allowed inside ES modules.
- Packages you install from **NPM Packages** are available in every tab without restarting, through `NODE_PATH`.
- With a **working directory** set, `<working directory>/node_modules` is searched before JSLab's packages.

## Environment and files

- JSLab turns off Bun's automatic `.env` loading. With a working directory, JSLab reads that folder's `.env` itself, after **Environment Variables** and before `JSLAB=1`, so the result is the same in every run.
- With a working directory, `process.cwd()`, `__dirname` and `import.meta.dir` are that folder, and `__filename` and `import.meta.path` are `<working directory>/<tab title>.<extension>`. Relative imports written as string literals resolve there too. An import whose path is computed at run time (`import(name)`) resolves against the run's own folder instead.

## Ending a run

- `process.exit()` ends the run after its output is delivered. Code that catches the exit (for example in `try/catch`) doesn't keep running: later output is dropped, and timers or servers it starts are stopped.

## Packages that install differently

- Install scripts (`postinstall` and friends) are blocked unless **Allow install scripts** is on in the NPM sheet or Settings → NPM.
- npm operations use JSLab's own `.npmrc` (Settings → NPM), never your `~/.npmrc`. A git dependency over SSH authenticates through your SSH agent (`SSH_AUTH_SOCK`) or `GIT_SSH_COMMAND`, because npm operations don't see your home folder's `~/.ssh`.

Not yet checked against Bun's compatibility page for Bun 1.4.0.
````

- [ ] **Step 2: Write the QA checklist**

`docs/qa/m3-checklist.md`:

````markdown
# M3 Manual QA Checklist

Run against the packaged canary build on macOS arm64, from a fresh canary data folder (an existing one is moved into `$JSLAB_QA_DIR`, never deleted), using the M2 launch procedure:
- Copy the `.app` to internal disk first.
- Launch it with `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`, from a shell whose working directory is on internal disk (R-M1-14).
- Quit from the app menu. When a script must stop it, use only the scoped, zsh-safe teardown below (R-M1-13).

These items use the real npm registry (`registry.npmjs.org`) on purpose: automated suites never do.

```bash
export PATH="$HOME/.hutch/bin:$PATH"
REPO="$(git rev-parse --show-toplevel)"
builtin cd "$REPO/apps/desktop" && hutch run build && builtin cd "$REPO"
: "${JSLAB_QA_DIR:?set JSLAB_QA_DIR to a folder under the session scratchpad (internal disk)}"
APP="$(ls -d apps/desktop/build/canary-macos-arm64/*.app)"
# Move an existing canary data folder into the QA folder instead of deleting it (R-M2-T25-1).
[ -d "$HOME/Library/Application Support/dev.jslab.app/canary" ] && mv "$HOME/Library/Application Support/dev.jslab.app/canary" "$JSLAB_QA_DIR/canary-data-backup-$(date +%Y%m%d-%H%M%S)"
cp -R "$APP" "$JSLAB_QA_DIR/"
builtin cd "$JSLAB_QA_DIR"
ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "$JSLAB_QA_DIR/$(basename "$APP")/Contents/MacOS/launcher" &
JSLAB_QA_PID=$!
builtin cd "$REPO"
```

Scripted teardown (R-M1-13):

```bash
pids=( $(pgrep -f "$JSLAB_QA_DIR/") $(pgrep -f "Library/Application Support/dev.jslab.app/canary") )
for p in "${pids[@]}"; do kill -TERM "$p"; done
sleep 5
survivors=( $(pgrep -f "$JSLAB_QA_DIR/") $(pgrep -f "Library/Application Support/dev.jslab.app/canary") )
for p in "${survivors[@]}"; do kill -KILL "$p"; done
```

Each item passes only if the result matches exactly. Items marked **(E)** are also covered by an automated scenario.

## Packages
- [ ] **Q1 NPM sheet (TL-01, TL-06).** ⌘I, Tools → NPM Packages… and the activity bar open the sheet. The installed table's header stays visible while scrolling. A package you add is highlighted for about 2 s. Show @types toggles `@types/*` rows. (E: tools, npm-panel)
- [ ] **Q2 Real install (TL-02, TL-03).** Typing `zod` shows registry results with descriptions and weekly downloads. **Add** installs it; `zod@3` installs that range's newest version exactly.
- [ ] **Q3 Git and tarball specs (TL-03).** `github:colinhacks/zod#main` or an `https://…tgz` URL installs. With install scripts off, the notice about blocked scripts appears when the package has one.
- [ ] **Q4 Update and remove (TL-06).** A package pinned to an old version shows **Update** with the newest version; Update, Remove and Update all do what they say, and the log drawer streams output.
- [ ] **Q5 Native module (TL-08).** With Allow install scripts on, `better-sqlite3` installs and `new (require("better-sqlite3"))(":memory:")` runs in a Bun tab.
- [ ] **Q6 Errors (TL-09).** A misspelled package shows "No package with that name…"; with Wi-Fi off, an install shows the network hint; the log disclosure holds the raw output.
- [ ] **Q7 Private registry (TL-10).** In Settings → NPM, add a scoped registry with a token and Save. Installing from that scope works; Help → Copy Debug Log contains no token. Your `~/.npmrc` (if any) is unchanged and unused.
- [ ] **Q8 git over SSH (M0-S8 follow-up).** With your SSH agent running, `git+ssh://git@github.com/<a public repo>.git` installs. Without the agent it fails with an SSH authentication error in the log (documented limitation).

## Editor
- [ ] **Q9 Types and autocomplete (ED-08, ED-13, ED-14).** After installing zod, `import { z } from "zod"; z.` suggests `object`, `string`, …; hovering `z.object` shows its type. In a Bun tab `Bun.` and `process.` complete. (E: typescript, npm suite)
- [ ] **Q10 Diagnostics, hover and hints (ED-09..ED-12).** A type error is underlined; ⌘F1 shows it; F1 shows hover info; typing `JSON.stringify(` shows parameter hints. Settings → Editor → Linting off removes the underline.
- [ ] **Q11 Install assist (ED-26).** `import dayjs from "dayjs"` offers **Install package dayjs** in the lightbulb (⌘.). Running code that imports a missing package shows **Install dayjs** on the error row.
- [ ] **Q12 Automatic types (XT-12).** With Install Types Automatically on, installing `lodash` also installs `@types/lodash`. (E: npm suite)

## Working directory and environment
- [ ] **Q13 Working directory (EX-30..EX-33, TF-19).** Actions → Set Working Directory… shows the folder picker; the status bar chip shows the folder name with the full path as its tooltip, and × clears it; the tab reads "title · folder". Relative imports, `__dirname`, `fs.readFileSync("./x")`, the folder's `.env` and its `node_modules` all work. (E: working-directory)
- [ ] **Q14 Missing folder.** Rename the working directory in Finder and run: the error "Working directory not found: …" shows **Change…**, which opens the picker.
- [ ] **Q15 Folder drop (TF-11).** Dropping a folder onto the window shows the notice pointing at Set Working Directory (Branch B), or sets the working directory (Branch A, per R-M3-SPIKE-1).
- [ ] **Q16 Environment Variables (TL-11).** Values are masked until the eye toggle; Save persists and the next run sees them; Cancel discards; `env.json` is readable only by you (`ls -l` shows `-rw-------`). (E: environment)
- [ ] **Q17 Login shell PATH.** Launched from the Dock (not a terminal), a package whose install script needs a tool from your shell `PATH` (for example `git`) installs, and `process.env.PATH` in a run includes your shell's additions.

## Settings, docs and diagnostics
- [ ] **Q18 Bun vs Node doc.** `docs/user/bun-vs-node.md` matches Bun's compatibility page for Bun 1.4.0 (its last line records the check).
- [ ] **Q19 Build tab (LB-05, LB-07).** Settings → Build → Decorators Legacy makes a TypeScript `@decorator` on a class method compile with no editor error; Pipeline Operator on makes `5 |> % * 2` run. (E: settings-window)
- [ ] **Q20 .npmrc editor (TL-10).** Settings → NPM shows `.npmrc` with ini highlighting; Save is disabled until you edit; Reset restores `registry=https://registry.npmjs.org/`. (E: settings-window)
- [ ] **Q21 Debug report (FA-m12).** Help → Copy Debug Log contains `~` where your home folder would appear, no environment variable values and no `.npmrc` content.
- [ ] **Q22 Quit keeps edits (X1, X5).** Type a line and quit with ⌘Q within a second; relaunch; the line is there. (E: quit-flush)

## Known limitations (record, don't fix in M3)
- **Editor types above the working directory.** A relative import that leaves the working directory (`../../x` above it) runs, but gets no editor types.
- **Computed imports.** `import(name)` with a computed path resolves against the run's folder, not the working directory.
- **git over SSH** needs an SSH agent or `GIT_SSH_COMMAND`, because npm operations don't see `~/.ssh` (M0-S8).
- **Update all** updates every installed package to its latest version, including ones that are already current.
- **Browser runtimes** get their editor types now, but run in M4.

## Automated suites
- [ ] **Q23 Totals.** Record: `bun run test` per package; `bun run test:npm`; `bun run e2e` on the dev build and the canary copy; `bun run e2e:npm` on the dev build and the canary copy.
````

- [ ] **Step 3: Amend the spec for M3's decisions**

In `docs/superpowers/specs/2026-09-12-jslab-design.md`, make these edits. Each quotes the current text exactly; replace only that text.

1. **§5.3** — replace

   `- Code runs as a real **ES module** through `await import(entryUrl + '?r=' + runId)` in the runner. Supported natively:`

   with

   `- Code runs as a real **ES module** through `await import(pathToFileURL(entry))` in the runner; every run writes a new `entry-<runId>.mjs`, so no cache-busting query is needed. Supported natively:`

2. **§5.3** — replace

   `- **WD globals.** When a WD is set, `process.cwd()` is the WD. `__dirname` and `import.meta.dir` report the WD, and `__filename` and `import.meta.path` report `<WD>/<tab title>.<ext>`. This is done by defining those identifiers in the transform and passing `cwd` at spawn.`

   with

   `- **WD globals.** When a WD is set, `process.cwd()` is the WD. `__dirname`, `import.meta.dir`, `import.meta.dirname` and `module.path` report the WD, and `__filename`, `import.meta.path`, `import.meta.filename` and `module.filename` report `<WD>/<tab title>.<ext>` (a saved file's own name when it has one); `import.meta.url` is that file's `file://` URL. The transform replaces those free identifiers and rewrites string-literal relative specifiers (static and dynamic imports, `export … from`, `require`, `require.resolve`) to absolute paths under the WD; a computed specifier resolves against the entry folder. `cwd` is passed at spawn. A WD that no longer exists fails the run before transform with `WorkingDirectoryError` (§12.2).`

3. **§5.4** — replace

   `   - `@babel/preset-typescript` with `allowDeclareFields: true` (fixes RunJS #526) and `onlyRemoveTypeImports: false`.`

   with

   `   - `@babel/preset-typescript` with `onlyRemoveTypeImports: false`. Babel 8 always supports `declare` fields (fixes RunJS #526) and rejects the old `allowDeclareFields` option.`

   and replace `   - Enabled proposal plugins.` with

   `   - Enabled proposal plugins (§8 Build): `proposal-decorators` (`version: "2023-11"` or `"legacy"`), `proposal-pipeline-operator` (`proposal: "hack"`, `topicToken: "%"`), `proposal-do-expressions`, `proposal-throw-expressions`, `proposal-function-sent`, `transform-regexp-modifiers`, `proposal-optional-chaining-assign` (`version: "2023-07"`).`

4. **§6.1** — replace

   `- **Diagnostics on/off** is controlled by `editor.linting`, through `setDiagnosticsOptions`.`

   with

   `- **Diagnostics on/off** is controlled by `editor.linting`, through `setDiagnosticsOptions`.
- **Per-tab application.** Monaco's TypeScript defaults are global, so JSLab re-applies the compiler options, diagnostics options and extra libraries whenever the shown tab, its runtime, `build.decorators` or `editor.linting` changes, and only when a value actually changes (each change restarts the TypeScript worker).
- **`lib` file names.** `compilerOptions.lib` lists full lib file names (`lib.esnext.d.ts`, plus `lib.dom.d.ts` and `lib.dom.iterable.d.ts` for the browser runtimes). Monaco's worker reads each entry as a file name; tsconfig short names leave the DOM lib unloaded.`

5. **§6.2** — replace

   `- **Built-in libraries:** `@types/node` and `bun-types` ship in the app and are added as extra libs for the runtimes that need them.`

   with

   `- **Built-in libraries:** `@types/node` 22.20.2 (with `undici-types` 6.21.0) and `bun-types` 1.4.2 ship in the app as two lazily loaded UI chunks and are added as extra libs for the runtimes that need them (§5.2).`

   and replace

   `- **WD-local modules:** `.ts`, `.d.ts`, and `.js` files imported relatively from the WD are fed the same way, limited to 200 files.`

   with

   `- **WD-local modules:** `.ts`, `.d.ts`, and `.js` files imported relatively from the WD are fed the same way at `file:///tab/<path relative to the WD>`, limited to 200 files. A relative import that leaves the WD gets no editor types.`

6. **§11.3** — replace

   `A login-shell `XDG_CONFIG_HOME` might also point Bun at a global `bunfig.toml` (not tested in M0); M3 checks this and strips or overrides it if so.`

   with

   `A login-shell `XDG_CONFIG_HOME` could point Bun at a global `bunfig.toml`, so the npm environment strips it too, and sets `NO_COLOR=1` so output parses reliably. `BUN_INSTALL_CACHE_DIR` is resolved in this order, verified against `bun pm cache` on the bundled Bun (M3 Task 9): the login-shell `BUN_INSTALL_CACHE_DIR`, `$XDG_CACHE_HOME/.bun/install/cache`, `$BUN_INSTALL/install/cache`, `<real home>/.bun/install/cache`.`

   and replace

   `Because `HOME` is overridden, git-URL specs and install scripts also see `npm-home`, with no `~/.gitconfig` or `~/.ssh`. M3 must test git-over-SSH specs. If they need something from the real home, pass that specific variable (for example `GIT_SSH_COMMAND`) instead of restoring `HOME`.`

   with

   `Because `HOME` is overridden, git-URL specs and install scripts also see `npm-home`, with no `~/.gitconfig` or `~/.ssh`. `SSH_AUTH_SOCK` and `GIT_SSH_COMMAND` pass through unchanged, so git over SSH authenticates through the user's agent or an explicit command; `HOME` is never restored (a documented limitation, M3 QA Q8).`

7. **§11.3** — in the operations table, replace `| Outdated | `bun outdated` (parsed); refreshed when the panel opens, at most every 10 min |` with

   `| Outdated | `bun outdated` (parsed); refreshed when the panel opens, at most every 10 min; a failed check is cached for the same period |`

   and after the table's `| Search | … |` row add `| Update all | `bun add --exact` with every dependency `@latest` |`.

8. **§12.2** — replace

   `- **Setting it:** Actions → Set Working Directory… (a folder picker), clicking the WD chip, or dropping a folder onto a tab.`

   with (Branch B; for Branch A keep the drop and add "delivered by Electrobun's native drop event (M3 R-M3-SPIKE-1)")

   `- **Setting it:** Actions → Set Working Directory… (a folder picker) or clicking the WD chip. Electrobun 2.0.1 gives the webview no dropped-folder path, so dropping a folder shows a notice pointing at these (M3 R-M3-SPIKE-1).`

   and, in §7.3, replace ` A dropped folder sets the current tab's WD.` with ` A dropped folder shows a notice pointing at Actions → Set Working Directory… (§12.2).` (Branch B only).

9. **§4.6** — replace

   `| `loginShellEnv` | GUI apps lack the shell `PATH` | Run `$SHELL -ilc 'env -0'` once at startup (2 s timeout) and merge the result |`

   with

   `| `loginShellEnv` | GUI apps lack the shell `PATH` | Run `$SHELL -ilc 'env -0'` once at startup (2 s timeout) and merge the result over the app's environment (`JSLAB_*` always comes from the app). `JSLAB_E2E=1` launches skip it. |`

10. **§22.2** — replace

   `- npm service against a local registry (Verdaccio in CI): install, remove, outdated, scripts off/on, `.npmrc` isolation: with an empty project `.npmrc` and a bad *scoped* registry key (for example `@scope:registry=http://127.0.0.1:9/`) in the test `HOME`'s `.npmrc`, a scoped install must succeed only with the isolation override. (A bad default `registry=` in `~/.npmrc` doesn't discriminate once the project `.npmrc` sets `registry=`: M0-S8 `projectRegistry`, C5/C8 and Deviation 1.)`

   with

   `- npm service against a local registry (`@jslab/test-registry`, running a pinned Verdaccio per ruling R-M3-REG-1, started under a temp folder with a tracked PID; opt-in with `bun run test:npm`; never run by `bun run test` or CI): install, remove, outdated, search, scripts off/on, `.npmrc` isolation: with the project `.npmrc` pointing at the local registry and a bad *scoped* registry key (for example `@scope:registry=http://127.0.0.1:9/`) in the test `HOME`'s `.npmrc`, the scoped install fails with that `HOME` and succeeds with the isolation override. (A project default `registry=` doesn't stop scoped keys leaking: M0-S8 C5/C8.) The npm E2E scenarios, including the M3 exit scenario, run with `bun run e2e:npm`.`

11. **§20** — replace `Help → Copy Debug Log copies `{ version, bunVersion, electrobunVersion, macOS, arch, settings (redacted), last 500 log lines }`.` with

   `Help → Copy Debug Log copies `{ version, bunVersion, electrobunVersion, macOS, arch, settings (redacted), last 500 log lines }`. Redacted means: only schema-defined settings fields, every string masked for secrets, the home folder and any `/Users/<name>` prefix written as `~`, and `env.json` values masked everywhere; `.npmrc` content never appears.`

12. **§5.11** — append this bullet at the end of the section's list:

   `- **A caught `process.exit`** (for example inside `try/catch`) still ends the run: later output is dropped and handles created afterwards are disposed. If user code keeps the runner from exiting, Main ends it 2.5 s after the request and reports the requested exit code.`

13. **§10.1** — append to the session section:

   `The session JSON is built when a write starts, not on every change (M3 FA-m9). Settings writes are bounded at 10 s each: a hung write fails, is logged, and never overwrites a newer file. Before the quit flush, the UI flushes pending view-state saves and buffer edits (at most 500 ms), and while typing it sends each tab's buffer at most every 150 ms.`

- [ ] **Step 4: Run the full automated suites from a clean install**

Run: `export PATH="$HOME/.hutch/bin:$PATH" && rm -rf node_modules && bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test`

Expected: lint and typecheck exit 0, and (Branch B):

| Package | Tests |
|---|---|
| `@jslab/shared` | M2 final + 11 = 53 |
| `@jslab/rpc-schema` | M2 final + 4 = 18 |
| `@jslab/serializer` | M2 final = 31 |
| `@jslab/transform` | M2 final + 11 = 65 |
| `@jslab/runner-bun` | M2 final + 1 = 36 |
| `@jslab/desktop` | M2 final + 50 = 257 |
| `@jslab/ui` | M2 final + 48 = 274 + PR #1's tests (two runner summaries) |
| `@jslab/themes` | M2 final = 8 |
| `@jslab/e2e` | M2 final = 11 |
| `@jslab/npm` | 26 |
| `@jslab/test-registry` | 4 |

M3 adds 155 unit tests to the M3 base (628 plus PR #1's ui tests), for **783 + PR #1's tests** (Branch B; Branch A: desktop 258, ui 273 + PR #1's tests, the same total). Repeat `bun run test` under the Bun 1.4.0 shim (Global Constraints (a)); the counts must match. Then run `export PATH="$HOME/.hutch/bin:$PATH" && bun run test:npm` (shell `timeout` 600000; log-and-poll) → 8 pass, 0 fail, and once more under the shim.

- [ ] **Step 5: Run every scenario against the dev build and the packaged canary**

Dev build:

```bash
export PATH="$HOME/.hutch/bin:$PATH"
builtin cd apps/desktop && hutch run build:dev && builtin cd ../..
bun run e2e > "$TMPDIR/jslab-e2e.log" 2>&1
bun run e2e:npm > "$TMPDIR/jslab-e2e-npm.log" 2>&1
```

Run each command in the background and poll its log. Expected: `bun run e2e` → M2 final + 12 pass, 0 fail; `bun run e2e:npm` → 4 pass, 0 fail.

Packaged canary: build it, copy it, and **warm the copy once** before any suite (the harness refuses an unextracted copy):

```bash
export PATH="$HOME/.hutch/bin:$PATH"
builtin cd apps/desktop && hutch run build && builtin cd ../..
: "${JSLAB_QA_DIR:?set JSLAB_QA_DIR to a folder under the session scratchpad (internal disk)}"
APP="$(ls -d apps/desktop/build/canary-macos-arm64/*.app)"
cp -R "$APP" "$JSLAB_QA_DIR/"
export JSLAB_E2E_APP="$JSLAB_QA_DIR/$(basename "$APP")"
repo="$PWD"
builtin cd "$JSLAB_QA_DIR"
ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 JSLAB_USER_DATA="$JSLAB_QA_DIR/warm" "$JSLAB_E2E_APP/Contents/MacOS/launcher" &
warm_pid=$!
builtin cd "$repo"
for _ in $(seq 1 90); do [ -d "$JSLAB_QA_DIR/warm" ] && break; sleep 0.5; done
sleep 3
descendants() { local child; for child in $(pgrep -P "$1"); do descendants "$child"; done; echo "$1"; }
warm_pids=( $(descendants "$warm_pid") )
for p in "${warm_pids[@]}"; do kill -KILL "$p"; done
for p in "${warm_pids[@]}"; do ps -o pid=,command= -p "$p" && echo "still running: $p"; done
```

If the launcher already exited while JSLab kept running (reparented by the self-extractor), stop it with the scoped R-M1-13 teardown from the checklist, which matches only `"$JSLAB_QA_DIR/"` and the canary data path.

Then, in the same shell: `bun run e2e > "$TMPDIR/jslab-e2e-canary.log" 2>&1` and `bun run e2e:npm > "$TMPDIR/jslab-e2e-npm-canary.log" 2>&1`, each in the background and polled. Expected: the same totals as the dev build, 0 fail. Every scenario uses its own temporary `JSLAB_USER_DATA`, so these runs touch no app data under `~/Library`. Record all four totals under Q23.

- [ ] **Step 6: Work through the checklist**

Work through Q1–Q22 on the canary copy. Per ruling R-M1-3, an implementer without GUI access:
- ticks only the items, or parts of items, that passing scenarios fully cover: Q1's ⌘I/Tools opening, Q9's completions, Q12, Q13's picker-driven WD behavior, Q16's save and `env.json` mode, Q19, Q20's save/reset, Q22;
- marks every other item or part **pending user**, with one line naming what remains:
  - the real-registry items Q2–Q8 and Q11's lightbulb;
  - Q10's hover, ⌘F1 and parameter hints;
  - Q14's Finder rename;
  - Q15's drop;
  - Q17's Dock launch;
  - Q18 unless Step 1 checked the page;
  - Q21's visual read.

Any failing item blocks M3. Fix it, with a test first where it's testable, then re-run Steps 4–5.

- [ ] **Step 7: Update parity statuses**

In `docs/parity.md`, set **Status**:

- **✅** (implemented and verified by the passing suites): EX-30, EX-31, EX-32, EX-33, LB-07, ED-08, ED-09, ED-13, ED-14, ED-26, TL-01, TL-02, TL-04, TL-05, TL-06, TL-07, TL-09, TL-10, TL-11, XT-12.
- **LB-05:** keep the 📝 deviation and add "implemented (M3)": `📝 partial application and async do expressions removed in Babel 8; the other proposals implemented (M3)`.
- **🚧 with a note:**

  | Row | Note |
  |---|---|
  | TL-03 | "versions and ranges verified (I); git and tarball specs pending user manual QA (docs/qa/m3-checklist.md Q3)" |
  | TF-18 | "Run/Stop/Settings in M2, NPM in M3; Snippets/AI panels M5; side bar resizing M5" |
  | TF-19 | "runtime/language/split in M2, WD chip in M3; Web View toggle M4" |
  | ST-01 | "General/Editor/Formatting/Appearance/Advanced in M2, NPM/Build in M3; Keybindings/AI M5" |

- **🚧 "pending user manual QA (docs/qa/m3-checklist.md)"**, until the user ticks the item; then ✅:

  | Rows | Checklist item |
  |---|---|
  | ED-10, ED-12 | Q10 |
  | ED-11 | Q10 |
  | TL-08 | Q5 |

- **TF-11** (Branch B): replace its status with `📝 deviation: dropped files open as scratch copies and a dropped folder shows the Set Working Directory notice; Electrobun 2.0.1 delivers no dropped paths (R-M3-SPIKE-1); drops pending user manual QA (docs/qa/m2-checklist.md Q14, docs/qa/m3-checklist.md Q15)`. Replace the TF-11 note under the table with `- **TF-11:** the webview doesn't get a dropped item's path on Electrobun 2.0.1 (R-M3-SPIKE-1). A dropped file opens as an unsaved scratch copy titled with the file's name; a dropped folder shows a notice pointing at Actions → Set Working Directory…. Revisit when Electrobun adds native drop paths.` (Branch A: set TF-11 ✅ "file-backed drops and folder drops set the WD (M3)" and drop the note.)

Leave every other row unchanged.

- [ ] **Step 8: Update the roadmap**

In `docs/superpowers/plans/2026-09-12-jslab-roadmap.md`:

1. Replace the Status row `| M3 Language & packages | to be written at M2 completion | Not started |` with

   `| M3 Language & packages | `2026-09-14-jslab-m3-language-packages.md` | Complete (manual QA items pending user) |`

2. In the M3 section, after **Exit**, add:

   `- **Delivered beyond the original list:** the opt-in npm integration and E2E suites (`bun run test:npm`, `bun run e2e:npm`) with `@jslab/test-registry`; the login-shell environment adapter (§4.6); runner exit semantics after a caught `process.exit`; the M2 persistence and UI carries (FA-m9, FA-m12, RR1-m2, X1, X5, T12-m1, T12-m3, T19A-mock); the app icon (branding carry).`

- [ ] **Step 9: Commit**

```bash
git add docs/user/bun-vs-node.md docs/qa/m3-checklist.md docs/parity.md docs/superpowers/plans/2026-09-12-jslab-roadmap.md docs/superpowers/specs/2026-09-12-jslab-design.md
git commit -m "docs(qa): m3 checklist, bun vs node guide, parity status, roadmap and spec amendments" -m "$JSLAB_COMMIT_TRAILER"
```

Don't push: no remote is configured.

---

## Spec coverage (M3)

| Spec section | Requirement | Task |
|---|---|---|
| §4.5 | `packages/`, `npm-home/` (empty, never an `.npmrc`), `env.json` (0600) | 4 |
| §4.6 | `loginShellEnv` adapter, 2 s timeout, merged environment | 14 |
| §5.2 | Types fed to Monaco per runtime (`dom`, `@types/node`, `bun-types`) | 20, 21 |
| §5.3 | `NODE_PATH` WD-first order; env order login → `env.json` → `.env` → `JSLAB=1`; `--no-env-file` kept; spares keyed by cwd/env | 14 |
| §5.3 | Relative specifiers against the WD; `__dirname`/`__filename`/`import.meta.*`/`module.*`; `cwd` at spawn | 16 |
| §5.4 | Enabled proposal plugins; TypeScript preset options | 15 |
| §5.8, §5.11 | A caught `process.exit` ends the run (FW1) | 17 |
| §6.1 | Compiler options per runtime, `experimentalDecorators` from `build.decorators`, `editor.linting` → `setDiagnosticsOptions`, 1375/1378 ignored, 2307 shown | 20, 21 |
| §6.2 | Built-in libraries; `npm/types` service (types/typings/exports, `@types` fallback, closure ≤ 5 MB); debounced loading, never twice, invalidated on change; WD-local modules ≤ 200 | 13, 20, 23 |
| §6.3 | "Install package x" on 2307 and runtime module-not-found; "Install @types/x" | 23 |
| §6.5 | `Cmd+I` NPM Packages… | 22 |
| §7.1 | Activity bar NPM Packages; status bar WD chip (click → change/clear, tooltip) | 24, 26 |
| §7.3 | Dropped folder behavior | 6, 24 |
| §7.4 | Actions: Set/Clear Working Directory; Tools: NPM Packages…, Environment Variables… | 22 |
| §7.5 | NPM Packages and Environment Variables as modal sheets | 25, 26 |
| §8 | NPM rows (`.npmrc` editor, `npm.allowInstallScripts`, `npm.autoInstallTypes`); Build rows (decorators and six proposals); settings v3 | 2, 27 |
| §10.1 | Pending writes flushed at quit (X1); session serialized at write time (FA-m9); settings writes bounded (RR1-m2); buffer sends coalesced (X5) | 3, 19 |
| §11.1 | Shared project `package.json`/`.npmrc`/`node_modules` | 4 |
| §11.2 | Search (300 ms), results with Add, spec input, installed table with sticky header and 2 s highlight, Update all, Show @types, Allow install scripts, log drawer | 26 |
| §11.3 | Bundled Bun, `cwd=<packages>`, `HOME=npm-home`, explicit `BUN_INSTALL_CACHE_DIR`, stripped config variables; add/remove/outdated/update/search; queue with 5 min timeout; classified errors with hints; after-change recycling and invalidation | 7, 9, 10, 11, 12, 18, 26 |
| §11.3 (M0-S8) | Discriminating isolation pair: injected, real-spawn and in-app | 11, 12, 28 |
| §11.4 | Install assist; `npm.autoInstallTypes` | 12, 23, 28 |
| §11.5 | `.npmrc` Monaco editor with Save/Reset; tokens masked in logs | 18, 27 |
| §12.1 | Table with masked values, validation, Save/Cancel, `env.json` 0600, spares recycled | 4, 14, 18, 25 |
| §12.2 | Picker, chip, clear, label suffix, missing-WD error with Change… | 16, 18, 22, 24 |
| §18 | `env.json` values, `.npmrc` tokens and home paths redacted; zod at every new boundary | 1, 5, 18 |
| §20 | Copy Debug Log with redacted settings | 1 |
| §22.1 | `packages/npm`: spec parsing, name derivation, `bun outdated` parsing | 7, 10, 13 |
| §22.2 | `.env` precedence, WD relative imports, resolution order, spare recycling on env/WD change; npm service against a local registry | 8, 12, 14, 16 |
| §22.3 | Scenarios: npm install + import, TS diagnostics visible | 21, 23, 28 |
| §24 (M3 exit) | zod installed, imported with types and autocomplete, used from a WD file; npm integration suite green | 12, 28, 30 |
| §26 | `docs/user/bun-vs-node.md` | 30 |
| Branding carry | App icon: a Graphite `{ }` source image and a generated `apps/desktop/icon.iconset` (CI log: `macOS icon source not found`), verified in the dev and canary bundles | 29 |
| R-CI-1 | Unit gates also under Bun 1.4.0; temp modules in fresh `mkdtemp` folders; CI parity, opt-in suites unreachable from `bun run test`/`bun run e2e` | Global Constraints (a)–(c); 8, 9, 11, 28 |
| M2 carries | FA-m12 (1), FA-m9 and RR1-m2 (3), X1, X5 and T19A-mock (19), T12-m1 and T12-m3 (21), FW1-exit-trycatch (17), `editor.linting` (20, 21), NPM/Build tabs (2, 27), TF-19 WD chip (24), TF-11 native drop (6, 24), R-M2-BUG-1 (20), R-M1-17(d) WD file after spare start (16) | as listed |

Deferred by design:
- **M4:** executing `browser-node` and `browser` tabs (their editor types ship now); invalidating web vendor caches after package changes (no cache exists yet); the `process.env` snapshot for `browser-node` (§12.1); CSS imports from the WD (§12.2 → §5.12).
- **M5:** the `cli` and `logpoint` values of `run.start`'s `reason` (spec Appendix A; their triggers arrive with the CLI and the logpoint UI); side bar resizing (§7.1).
- **M6:** Help → Bun vs Node Differences as a menu item (the document is written in M3; the menu item opens the docs site, which arrives in M6).
- **Upstream (if Branch B):** native folder and file drops with paths (TF-11), until Electrobun delivers dropped paths to Main.

## Self-review

- **Placeholders:** every code step contains the code it needs. The only content filled at execution time is: the Verdaccio exact version (Task 8 Step 1 pins the newest 6.x after an MIT check; ruling R-M3-REG-1 already chose Verdaccio); the spike report's evidence (Task 6); the Branch A event binding copied from the spike report (Task 24 Step 6, only if GO; its counts are fixed in the Test counts note); and the controller's `JSLAB_COMMIT_TRAILER`.
- **Pre-flight (2026-09-14):** anchors re-verified at `d481b19`; rulings R-M3-REG-1 (Verdaccio) and R-CI-1 applied; the app icon added as Task 29 (the docs task is now Task 30). The scan table lives next to the draft as `preflight-scan.md`.
- **Type consistency across tasks:**
  - `NpmOperation`, `NpmOpError`, `NpmListResult`, `PackageTypesResult`, `LocalTypesResult`, `TypeFile`, `SaveResult`, `EnvVars` are defined once (Task 5) and used by Tasks 10–13, 18, 22–28.
  - `BuildSettings` (shared, Task 2) and `BuildOptions` (transform, Task 15) have identical fields and literal unions, so `runnerSettings(settings).build` passes straight to the transform.
  - `TsEnvironment` (Task 20) is consumed by Tasks 21 and 23 through `setPackageFiles`, `clearPackages`, `setLocalFiles` and `clearLocal` only.
  - `RunnerSpawnConfig` is unchanged; `createRunnerConfig` (Task 14) is used by Tasks 16 and 18.
  - `MainApi` additions are all in Task 22 except `stateFlushed` (Task 19). `fake-api.ts` and `rpc.ts` gain the same names in those tasks.
  - The `ViewMessages` additions (Tasks 18, 19) are added to `VIEW_MESSAGES` in the same tasks.
- **Carry check:** every M2→M3 carry lands in a task (coverage table, last row). None is deferred.

