# JSLab M1: Core Scratchpad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-tab JSLab window where typing TypeScript shows correct results, console output and errors next to their source lines, and where infinite loops, hangs and crash loops are always recoverable.

**Architecture:**
- **Main process:** a Bun main process (Electrobun 2.x, `mainProcess: "bun"`). It transpiles and instruments code with Babel in a Worker, and writes each run to `<userData>/runs/<tabId>/entry-<runId>.mjs`. It hands the run to a pre-started child Bun process (a "spare").
- **Runner:** the child imports the entry as a real ES module, hooks `console`, serializes values, and streams batched events over Bun IPC.
- **Mapping and UI:** Main maps generated positions to source lines and forwards events over Electrobun RPC. The React + Monaco UI in WKWebView renders them.

**Tech Stack:**
- Bun: develop locally with Bun ≥1.3.13; CI and the packaged app use Bun 1.4.0 (the Bun Electrobun 2.0.1 bundles). Runner IPC uses `serialization: "json"`, so parent/child version skew is safe.
- Electrobun 2.0.1 + Hutch
- TypeScript 7.0.2, Biome 2.5.13
- `@babel/standalone` 8.0.5, `source-map-js` 1.2.1, zod 4.6.4
- React 19.3.0, Vite 8.3.0, `monaco-editor` 0.56.0, zustand 5.0.15, `@tanstack/react-virtual` 3.14.12
- happy-dom 20.14.5 and `@testing-library/react` 16.3.3 for UI tests

**Spec:** `docs/superpowers/specs/2026-09-12-jslab-design.md`. Read §4.1–4.5, §5.1–5.11, §5.14, §6.1, §7.1–7.2, §10.1, §18 and §20 before starting.

**Prerequisite:** M0 is complete and `docs/spikes/2026-09-m0-report.md` exists. Tasks 13–15 use Electrobun APIs confirmed there. If the report records a different API, path formula or worker import, follow the report and note the deviation in the task's commit message.

## Global Constraints

- Clean room: never read RunJS binaries, `app.asar` or bundled JS (spec §0).
- MIT license. No GPL-family dependencies.
- Develop locally with Bun ≥1.3.13; CI and the packaged app use Bun 1.4.0. Runner IPC uses `serialization: "json"`, so parent/child version skew is safe.
- Pin every dependency to the exact version listed under Tech Stack. Never use `^` or `~`.
- User code never runs in the Main process (spec §4.1).
- Every UI → Main payload is validated with the zod schemas in `@jslab/rpc-schema` before use (spec §18).
- The runner entry file is always `.mjs` and has no `sourceMappingURL` comment. Main does all source mapping (spec §5.3).
- The runner is spawned with `--no-env-file`, and `NODE_PATH` controls package lookup (spec §5.3).
- Loop protection message: `Potential infinite loop: exceeded <N> iterations (line <L>). Disable Loop Protection or raise the limit in Settings → Advanced.`
- Defaults (spec §8):

  | Setting | Default |
  |---|---|
  | `run.autoRun` | `true` |
  | `run.autoLog` | `true` |
  | `run.showUndefined` | `false` |
  | `run.loopProtection` | `true` |
  | `run.loopProtectionMaxIterations` | `2000` |
  | `run.autoRunDelayMs` | `300` |
  | `run.unresponsiveTimeoutMs` | `3000` |
  | `output.maxEntries` | `10000` |

- Output limits (spec §5.9):

  | Limit | Value |
  |---|---|
  | Eager depth | 3 |
  | Properties per object | 100 |
  | Collection entries | 1000 |
  | String preview | 10,000 characters |
  | Function source on expand | 2,000 characters |

- Stop escalates to kill after 500 ms. A finished runner stays alive for 5 minutes to answer expand requests.
- Restored tabs never auto-run at launch. A leftover `run.lock` or holding Shift at launch starts Safe Mode (spec §5.14).
- Every package has `test` (`bun test`) and `typecheck` (`tsc --noEmit -p .`) scripts. `bun run lint`, `bun run typecheck` and `bun run test` must pass at the end of every task.
- Conventional Commits.

## File map

```
package.json, tsconfig.base.json, biome.json, .gitignore, LICENSE, README.md, .github/workflows/ci.yml
packages/shared/        settings.ts (zod settings + defaults + merge), session.ts (session/tab schemas + normalize)
packages/rpc-schema/    values.ts (EncodedValue), runner-ipc.ts (Main⇄runner), events.ts (RunEvent, RunState), ui-rpc.ts (UI⇄Main + validators)
packages/serializer/    encode.ts (Encoder, HandleRegistry, parseStack)
packages/transform/     types.ts, transform.ts (Babel pipeline + diagnostics), instrument.ts (auto log, magic comments, logpoints, loop protection)
packages/runner-bun/    event-buffer.ts, handles.ts, console-hook.ts, bootstrap.ts (child process entry)
apps/desktop/src/main/
  runs/                 bun-runner-process.ts, spare-pool.ts, event-mapper.ts, run-coordinator.ts
  transform/            transform-host.ts, transform-worker.ts
  persistence/          atomic-write.ts, json-store.ts, run-lock.ts
  services/             settings-store.ts, session-store.ts, safe-mode.ts
  app-paths.ts          bundle and userData locations
  rpc.ts                UI RPC handlers
  menu.ts               application menu
  index.ts              bootstrap
apps/ui/src/
  state/                output.ts (pure reducers), store.ts (zustand)
  output/               format.ts, ValueView.tsx, EntryRow.tsx, OutputPanel.tsx
  editor/               monaco-setup.ts, Editor.tsx
  shell/                App.tsx, ActivityBar.tsx, StatusBar.tsx, SplitPane.tsx, UnresponsiveDialog.tsx, SafeModeBanner.tsx
  rpc.ts, main.tsx, index.html, styles.css
docs/qa/m1-checklist.md
```

---

### Task 1: Monorepo scaffold and CI

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `biome.json`, `.gitignore`, `LICENSE`, `README.md`, `.github/workflows/ci.yml`

**Interfaces:**
- Produces: the root scripts `test`, `typecheck` (`bun run --filter '*' <script>`), `lint` (`biome check .`) and `format`, and `tsconfig.base.json`, which every package extends.

- [ ] **Step 1: Write the root files**

`package.json`:
```json
{
  "name": "jslab",
  "private": true,
  "type": "module",
  "license": "MIT",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "test": "bun run --filter '*' test",
    "typecheck": "bun run --filter '*' typecheck",
    "lint": "biome check .",
    "format": "biome check --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.13",
    "@types/bun": "1.4.2",
    "typescript": "7.0.2"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "lib": ["ESNext"],
    "types": ["bun"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

`biome.json`:
```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.13/schema.json",
  "files": {
    "includes": ["**", "!**/node_modules", "!**/dist", "!**/build", "!**/artifacts", "!**/.hutch", "!spikes"]
  },
  "formatter": {
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 120
  },
  "javascript": {
    "formatter": { "quoteStyle": "double" }
  },
  "linter": {
    "rules": {
      "preset": "recommended"
    }
  }
}
```

`.gitignore`:
```text
node_modules/
dist/
build/
artifacts/
.hutch/
*.tsbuildinfo
.DS_Store
```

`LICENSE`:
```text
MIT License

Copyright (c) 2026 JSLab contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`README.md`:
````markdown
# JSLab

An open-source JavaScript and TypeScript playground for the desktop. Write code and see results next to each line as you type.

JSLab is MIT licensed and under active development. See `docs/superpowers/specs/2026-09-12-jslab-design.md` for the design and `docs/superpowers/plans/` for the roadmap.

## Development

Requirements: macOS (arm64), [Bun](https://bun.sh) 1.3.13 or newer. CI and the packaged app use Bun 1.4.0.

```bash
bun install
bun run test        # unit and integration tests for every package
bun run typecheck
bun run lint
```

## Layout

- `apps/desktop`: Electrobun main process
- `apps/ui`: React + Monaco webview UI
- `packages/*`: shared libraries (transform, serializer, runner, schemas)
````

`.github/workflows/ci.yml`:
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test
```

- [ ] **Step 2: Install and verify the tooling**

Run: `bun install && bunx tsc --version && bunx biome --version`
Expected: `Version 7.0.2` and `Version: 2.5.13`.

- [ ] **Step 3: Verify lint runs on the empty workspace**

Run: `bun run lint`
Expected: exit code 0.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock tsconfig.base.json biome.json .gitignore LICENSE README.md .github
git commit -m "chore: scaffold bun workspaces monorepo with biome, typescript and CI"
```

---

### Task 2: `@jslab/shared` settings and session schemas

**Files:**
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`
- Create: `packages/shared/src/settings.ts`, `packages/shared/src/session.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/settings.test.ts`, `packages/shared/test/session.test.ts`

**Interfaces:**
- Produces:
  - `LANGUAGES`, `RUNTIMES`, `type Language`, `type Runtime`
  - `settingsSchema`, `type Settings`, `defaultSettings(): Settings`, `type DeepPartial<T>`, `mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings`
  - `type RunnerSettings { autoLog; loopProtection; loopProtectionMaxIterations; maxEntries; unresponsiveTimeoutMs }`, `runnerSettings(settings): RunnerSettings`
  - `tabStateSchema`, `windowStateSchema`, `sessionSchema`, `type TabState`, `type WindowState`, `type Session`
  - `bufferFileName(tab): string`, `createTab(overrides?): TabState`, `normalizeSession(session, newTab?): Session`, `defaultSession(newTab?): Session`

- [ ] **Step 1: Create the package**

`packages/shared/package.json`:
```json
{
  "name": "@jslab/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "zod": "4.6.4"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `bun install`

- [ ] **Step 2: Write the failing tests**

`packages/shared/test/settings.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { defaultSettings, mergeSettings, runnerSettings, settingsSchema } from "../src/settings";

describe("settings", () => {
  test("defaults match the spec", () => {
    const s = defaultSettings();
    expect(s.run).toMatchObject({
      autoRun: true,
      autoLog: true,
      showUndefined: false,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      autoRunDelayMs: 300,
      unresponsiveTimeoutMs: 3000,
      defaultLanguage: "typescript",
      defaultRuntime: "browser-node",
    });
    expect(s.output.maxEntries).toBe(10_000);
    expect(s.appearance).toEqual({ theme: "dracula", font: "JetBrains Mono", fontSize: 14 });
  });

  test("repairs invalid fields individually and keeps valid ones", () => {
    const s = settingsSchema.parse({ run: { autoRun: "yes", autoLog: false, autoRunDelayMs: 99_999 } });
    expect(s.run.autoRun).toBe(true);
    expect(s.run.autoLog).toBe(false);
    expect(s.run.autoRunDelayMs).toBe(300);
  });

  test("replaces a whole invalid section with its defaults", () => {
    expect(settingsSchema.parse({ output: "nope" }).output).toEqual({ maxEntries: 10_000, showLineNumbers: true });
  });

  test("preserves unknown keys for forward compatibility", () => {
    const s = settingsSchema.parse({ future: { flag: 1 }, run: { futureRunKey: "x" } }) as Record<string, unknown>;
    expect(s.future).toEqual({ flag: 1 });
    expect((s.run as Record<string, unknown>).futureRunKey).toBe("x");
  });

  test("mergeSettings applies a deep partial and re-validates", () => {
    const merged = mergeSettings(defaultSettings(), { run: { autoRun: false, loopProtectionMaxIterations: -5 } });
    expect(merged.run.autoRun).toBe(false);
    expect(merged.run.loopProtectionMaxIterations).toBe(2000);
    expect(merged.run.autoLog).toBe(true);
  });

  test("runnerSettings extracts what runners need", () => {
    expect(runnerSettings(defaultSettings())).toEqual({
      autoLog: true,
      loopProtection: true,
      loopProtectionMaxIterations: 2000,
      maxEntries: 10_000,
      unresponsiveTimeoutMs: 3000,
    });
  });
});
```

`packages/shared/test/session.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { bufferFileName, createTab, defaultSession, normalizeSession, sessionSchema } from "../src/session";

const tab = (id: string) => createTab({ id });

describe("session", () => {
  test("default session has exactly one active tab", () => {
    const s = defaultSession(() => tab("t1"));
    expect(s.tabOrder).toEqual(["t1"]);
    expect(s.activeTabId).toBe("t1");
    expect(s.tabs.t1).toMatchObject({ title: "Untitled", language: "typescript", runtime: "bun" });
    expect(s.window).toBeNull();
  });

  test("normalize drops unknown and duplicate ids, appends unordered tabs and fixes the active tab", () => {
    const s = normalizeSession(
      sessionSchema.parse({
        tabOrder: ["missing", "a", "a"],
        activeTabId: "missing",
        tabs: { a: tab("a"), b: tab("b") },
      }),
    );
    expect(s.tabOrder).toEqual(["a", "b"]);
    expect(s.activeTabId).toBe("a");
  });

  test("normalize creates a tab when none exist", () => {
    const s = normalizeSession(sessionSchema.parse({ tabs: {} }), () => tab("fresh"));
    expect(s.tabOrder).toEqual(["fresh"]);
  });

  test("invalid tab fields fall back to defaults", () => {
    const s = sessionSchema.parse({ tabs: { a: { id: "a", language: "cobol", layout: { editorSize: 500 } } } });
    expect(s.tabs.a).toMatchObject({ language: "typescript", layout: { orientation: "horizontal", editorSize: 55 } });
  });

  test("an invalid window frame becomes null", () => {
    expect(sessionSchema.parse({ window: { x: 0, y: 0, width: 10, height: 10 } }).window).toBeNull();
  });

  test("buffer file names use the language extension", () => {
    expect(bufferFileName({ id: "a", language: "tsx" })).toBe("a.tsx");
    expect(bufferFileName({ id: "b", language: "javascript" })).toBe("b.js");
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd packages/shared && bun test`
Expected: FAIL, `Cannot find module "../src/settings"`.

- [ ] **Step 4: Implement**

`packages/shared/src/settings.ts`:
```ts
import { z } from "zod";

export const LANGUAGES = ["typescript", "javascript", "tsx", "jsx"] as const;
export const RUNTIMES = ["browser-node", "bun", "browser"] as const;
export type Language = (typeof LANGUAGES)[number];
export type Runtime = (typeof RUNTIMES)[number];

// Every field repairs itself: a missing or invalid value falls back to its default (spec §8).
const bool = (fallback: boolean) => z.boolean().catch(fallback);
const int = (fallback: number, min: number, max: number) => z.number().int().min(min).max(max).catch(fallback);
const text = (fallback: string) => z.string().min(1).catch(fallback);

function section<T extends z.ZodRawShape>(shape: T) {
  const schema = z.looseObject(shape);
  return schema.catch(() => schema.parse({}));
}

export const settingsSchema = z.looseObject({
  version: z.literal(1).catch(1),
  run: section({
    autoRun: bool(true),
    autoLog: bool(true),
    showUndefined: bool(false),
    loopProtection: bool(true),
    loopProtectionMaxIterations: int(2000, 100, 10_000_000),
    autoRunDelayMs: int(300, 0, 5000),
    unresponsiveTimeoutMs: int(3000, 1000, 60_000),
    defaultLanguage: z.enum(LANGUAGES).catch("typescript"),
    defaultRuntime: z.enum(RUNTIMES).catch("browser-node"),
  }),
  output: section({
    maxEntries: int(10_000, 100, 100_000),
    showLineNumbers: bool(true),
  }),
  editor: section({
    lineNumbers: bool(true),
    lineWrap: bool(true),
  }),
  appearance: section({
    theme: text("dracula"),
    font: text("JetBrains Mono"),
    fontSize: int(14, 8, 72),
  }),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

export type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) out[key] = deepMerge(base[key], value);
  return out;
}

/** Applies a partial update and re-validates, so invalid patch values fall back to defaults. */
export function mergeSettings(current: Settings, patch: DeepPartial<Settings>): Settings {
  return settingsSchema.parse(deepMerge(current, patch));
}

export interface RunnerSettings {
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  maxEntries: number;
  unresponsiveTimeoutMs: number;
}

export function runnerSettings(settings: Settings): RunnerSettings {
  return {
    autoLog: settings.run.autoLog,
    loopProtection: settings.run.loopProtection,
    loopProtectionMaxIterations: settings.run.loopProtectionMaxIterations,
    maxEntries: settings.output.maxEntries,
    unresponsiveTimeoutMs: settings.run.unresponsiveTimeoutMs,
  };
}
```

`packages/shared/src/session.ts`:
```ts
import { z } from "zod";
import { LANGUAGES, type Language, RUNTIMES } from "./settings";

export const tabStateSchema = z.object({
  id: z.string().min(1),
  title: z.string().catch("Untitled"),
  titleIsCustom: z.boolean().catch(false),
  language: z.enum(LANGUAGES).catch("typescript"),
  runtime: z.enum(RUNTIMES).catch("bun"),
  layout: z
    .object({
      orientation: z.enum(["horizontal", "vertical"]).catch("horizontal"),
      editorSize: z.number().min(10).max(90).catch(55),
    })
    .catch(() => ({ orientation: "horizontal" as const, editorSize: 55 })),
});

export const windowStateSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().min(400),
    height: z.number().min(300),
  })
  .nullable()
  .catch(null);

export const sessionSchema = z.object({
  version: z.literal(1).catch(1),
  window: windowStateSchema,
  tabOrder: z.array(z.string()).catch([]),
  activeTabId: z.string().catch(""),
  tabs: z.record(z.string(), tabStateSchema).catch({}),
});

export type TabState = z.infer<typeof tabStateSchema>;
export type WindowState = z.infer<typeof windowStateSchema>;
export type Session = z.infer<typeof sessionSchema>;

const EXTENSIONS: Record<Language, string> = { typescript: "ts", tsx: "tsx", javascript: "js", jsx: "jsx" };

export function bufferFileName(tab: Pick<TabState, "id" | "language">): string {
  return `${tab.id}.${EXTENSIONS[tab.language]}`;
}

export function createTab(overrides: Partial<TabState> = {}): TabState {
  return tabStateSchema.parse({ id: crypto.randomUUID(), title: "Untitled", ...overrides });
}

/** Repairs cross-field invariants: every ordered id exists, every tab is ordered, and there is an active tab. */
export function normalizeSession(session: Session, newTab: () => TabState = () => createTab()): Session {
  const tabs = { ...session.tabs };
  const tabOrder = session.tabOrder.filter((id, index, all) => id in tabs && all.indexOf(id) === index);
  for (const id of Object.keys(tabs)) if (!tabOrder.includes(id)) tabOrder.push(id);
  if (tabOrder.length === 0) {
    const tab = newTab();
    tabs[tab.id] = tab;
    tabOrder.push(tab.id);
  }
  const activeTabId = tabOrder.includes(session.activeTabId) ? session.activeTabId : (tabOrder[0] as string);
  return { ...session, tabs, tabOrder, activeTabId };
}

export function defaultSession(newTab: () => TabState = () => createTab()): Session {
  return normalizeSession(sessionSchema.parse({}), newTab);
}
```

`packages/shared/src/index.ts`:
```ts
export * from "./session";
export * from "./settings";
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd packages/shared && bun test && bun run typecheck`
Expected: `12 pass`, `0 fail`, then typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared bun.lock
git commit -m "feat(shared): settings and session schemas with self-repairing defaults"
```

---

### Task 3: `@jslab/rpc-schema` contracts and validators

**Files:**
- Create: `packages/rpc-schema/package.json`, `packages/rpc-schema/tsconfig.json`
- Create: `packages/rpc-schema/src/values.ts`, `packages/rpc-schema/src/runner-ipc.ts`, `packages/rpc-schema/src/events.ts`, `packages/rpc-schema/src/ui-rpc.ts`, `packages/rpc-schema/src/index.ts`
- Test: `packages/rpc-schema/test/ui-rpc.test.ts`

**Interfaces:**
- Consumes: `type Settings`, `type Session` from `@jslab/shared` (Task 2).
- Produces:
  - **Values:** `type EncodedValue`, `type PropKey`, `type StackFrame` (spec Appendix B).
  - **Runner IPC:** `type ConsoleLevel`, `type GeneratedPosition`, `type RawRunEventBody`, `type RawRunEvent`, `type RunnerState`, `type MainToRunner`, `type RunnerToMain`.
  - **Run events:** `type RunEventBody`, `type RunEvent`, `type RunState`.
  - **Validators:** `runStartParamsSchema`, `tabParamsSchema`, `runExpandParamsSchema`, `bufferChangedSchema`, `tabPatchSchema`, plus their inferred types `RunStartParams`, `TabParams`, `RunExpandParams`, `BufferChanged`, `TabPatch`.
  - **UI RPC types:** `type CommandId`, `type DiagnosticPayload`, `type BootstrapPayload`, `type MainRequests`, `type MainMessages`, `type ViewMessages`.

- [ ] **Step 1: Create the package**

`packages/rpc-schema/package.json`:
```json
{
  "name": "@jslab/rpc-schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@jslab/shared": "workspace:*",
    "zod": "4.6.4"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/rpc-schema/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `bun install`

- [ ] **Step 2: Write the type-only contracts**

These files contain only types and have no behavior to test. The Task 4, 7 and 9 tests exercise them.

`packages/rpc-schema/src/values.ts`:
```ts
export type PropKey = { k: string } | { sym: string };

export interface StackFrame {
  fn?: string;
  file?: string;
  line?: number;
  column?: number;
  user: boolean;
}

export type EncodedValue =
  | { t: "undefined" }
  | { t: "null" }
  | { t: "boolean"; v: boolean }
  | { t: "number"; v: string }
  | { t: "bigint"; v: string }
  | { t: "symbol"; desc: string }
  | { t: "string"; v: string; truncated?: { total: number; handle: string } }
  | {
      t: "function";
      name: string;
      kind: "function" | "arrow" | "async" | "generator" | "asyncGenerator" | "class" | "bound" | "native";
      handle: string;
    }
  | {
      t: "object";
      id: number;
      ctor: string | null;
      props: [PropKey, EncodedValue][];
      more?: number;
      proto?: EncodedValue;
      handle?: string;
      frozen?: boolean;
      proxy?: boolean;
    }
  | {
      t: "array";
      id: number;
      ctor: string;
      length: number;
      items: ([number, EncodedValue] | { hole: number })[];
      more?: number;
      handle?: string;
    }
  | { t: "map"; id: number; size: number; entries: [EncodedValue, EncodedValue][]; more?: number; handle?: string }
  | { t: "set"; id: number; size: number; items: EncodedValue[]; more?: number; handle?: string }
  | { t: "weak"; kind: "WeakMap" | "WeakSet" | "WeakRef" }
  | { t: "promise"; id: number; state: "pending" | "fulfilled" | "rejected"; value?: EncodedValue }
  | { t: "error"; name: string; message: string; stack: StackFrame[]; cause?: EncodedValue }
  | { t: "date"; iso: string | null }
  | { t: "regexp"; source: string; flags: string }
  | { t: "typedArray"; ctor: string; length: number; items: (number | string)[]; more?: number; handle?: string }
  | { t: "arrayBuffer"; byteLength: number; preview: number[] }
  | { t: "url"; href: string }
  | { t: "headers"; entries: [string, string][] }
  | { t: "response"; status: number; statusText: string; url: string; headers: [string, string][] }
  | { t: "getter"; handle: string }
  | { t: "circular"; ref: number }
  | { t: "handle"; handle: string; preview: string };
```

`packages/rpc-schema/src/runner-ipc.ts`:
```ts
import type { EncodedValue, StackFrame } from "./values";

export type ConsoleLevel =
  | "log"
  | "info"
  | "warn"
  | "error"
  | "debug"
  | "dir"
  | "table"
  | "trace"
  | "assert"
  | "count"
  | "time"
  | "group"
  | "groupCollapsed"
  | "groupEnd"
  | "clear";

export interface GeneratedPosition {
  line: number;
  column: number;
}

export type RawRunEventBody =
  | { kind: "result"; line: number; column?: number; source: "autolog" | "magic"; value: EncodedValue }
  | {
      kind: "console";
      level: ConsoleLevel;
      at?: GeneratedPosition;
      groupDepth: number;
      args: EncodedValue[];
      label?: string;
      stack?: StackFrame[];
    }
  | { kind: "stdout" | "stderr"; text: string }
  | {
      kind: "error";
      phase: "runtime" | "unhandledRejection";
      name: string;
      message: string;
      stack: StackFrame[];
      value: EncodedValue;
    }
  | { kind: "promiseSettled"; ref: number; value: EncodedValue }
  | { kind: "truncated"; dropped: number };

export type RawRunEvent = RawRunEventBody & { seq: number; t: number };

export type RunnerState = "evaluating" | "settled" | "idle" | "stopped";

export type MainToRunner =
  | { type: "run"; runId: string; entry: string; settings: { maxEntries: number } }
  | { type: "stop" }
  | { type: "expand"; reqId: number; handleId: string }
  | { type: "dispose" };

export type RunnerToMain =
  | { type: "ready"; bunVersion: string }
  | { type: "heartbeat" }
  | { type: "events"; runId: string; events: RawRunEvent[] }
  | { type: "state"; runId: string; state: RunnerState; activeHandles: number }
  | { type: "expanded"; reqId: number; value: EncodedValue | null };
```

`packages/rpc-schema/src/events.ts`:
```ts
import type { ConsoleLevel } from "./runner-ipc";
import type { EncodedValue, StackFrame } from "./values";

export type RunEventBody =
  | { kind: "result"; line: number; column?: number; source: "autolog" | "magic" | "logpoint"; value: EncodedValue }
  | {
      kind: "console";
      level: ConsoleLevel;
      line?: number;
      groupDepth: number;
      args: EncodedValue[];
      label?: string;
      stack?: StackFrame[];
    }
  | { kind: "stdout" | "stderr"; text: string }
  | {
      kind: "error";
      phase: "transpile" | "runtime" | "unhandledRejection" | "runner";
      name: string;
      message: string;
      line?: number;
      column?: number;
      stack: StackFrame[];
      codeFrame?: string;
      value?: EncodedValue;
    }
  | { kind: "promiseSettled"; ref: number; value: EncodedValue }
  | { kind: "truncated"; dropped: number };

export type RunEvent = RunEventBody & { seq: number; t: number };

export type RunState =
  | "transpiling"
  | "evaluating"
  | "settled"
  | "idle"
  | "unresponsive"
  | "stopping"
  | "stopped"
  | "killed"
  | "failed";
```

- [ ] **Step 3: Write the failing validator tests**

`packages/rpc-schema/test/ui-rpc.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { bufferChangedSchema, runExpandParamsSchema, runStartParamsSchema, tabPatchSchema } from "../src/ui-rpc";

const validStart = {
  tabId: "t1",
  code: "1 + 1",
  language: "typescript" as const,
  logpoints: [2],
  reason: "auto" as const,
};

describe("inbound validators", () => {
  test("accept a valid run.start and strip unknown keys", () => {
    expect(runStartParamsSchema.parse({ ...validStart, extra: true })).toEqual(validStart);
  });

  test("reject bad run.start payloads", () => {
    expect(runStartParamsSchema.safeParse({ ...validStart, tabId: "" }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, language: "python" }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, logpoints: [0] }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, code: "x".repeat(5_000_001) }).success).toBe(false);
  });

  test("run.expand requires a uuid run id and a handle id", () => {
    const runId = crypto.randomUUID();
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId, handleId: "h12" }).success).toBe(true);
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId: "nope", handleId: "h12" }).success).toBe(false);
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId, handleId: "../etc" }).success).toBe(false);
  });

  test("buffer.changed caps content size", () => {
    expect(bufferChangedSchema.safeParse({ tabId: "t1", content: "ok" }).success).toBe(true);
    expect(bufferChangedSchema.safeParse({ tabId: "t1", content: "x".repeat(5_000_001) }).success).toBe(false);
  });

  test("tab.patch accepts partial patches and rejects invalid layouts", () => {
    expect(tabPatchSchema.parse({ tabId: "t1", patch: { title: "x" } })).toEqual({
      tabId: "t1",
      patch: { title: "x" },
    });
    expect(
      tabPatchSchema.safeParse({ tabId: "t1", patch: { layout: { orientation: "diagonal", editorSize: 50 } } }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `cd packages/rpc-schema && bun test`
Expected: FAIL, `Cannot find module "../src/ui-rpc"`.

- [ ] **Step 5: Implement the UI contract and validators**

`packages/rpc-schema/src/ui-rpc.ts`:
```ts
import type { Session, Settings } from "@jslab/shared";
import { z } from "zod";
import type { RunEvent, RunState } from "./events";
import type { EncodedValue } from "./values";

// Inbound payloads (UI → Main) are validated with these schemas before use (spec §18).

const tabId = z.string().min(1).max(100);

export const runStartParamsSchema = z.object({
  tabId,
  code: z.string().max(5_000_000),
  language: z.enum(["typescript", "javascript", "tsx", "jsx"]),
  logpoints: z.array(z.number().int().positive()).max(10_000),
  reason: z.enum(["auto", "manual"]),
});

export const tabParamsSchema = z.object({ tabId });

export const runExpandParamsSchema = z.object({
  tabId,
  runId: z.uuid(),
  handleId: z.string().regex(/^h\d+$/),
});

export const bufferChangedSchema = z.object({ tabId, content: z.string().max(5_000_000) });

export const tabPatchSchema = z.object({
  tabId,
  patch: z
    .object({
      title: z.string().max(200),
      language: z.enum(["typescript", "javascript", "tsx", "jsx"]),
      layout: z.object({ orientation: z.enum(["horizontal", "vertical"]), editorSize: z.number().min(10).max(90) }),
    })
    .partial(),
});

export type RunStartParams = z.infer<typeof runStartParamsSchema>;
export type TabParams = z.infer<typeof tabParamsSchema>;
export type RunExpandParams = z.infer<typeof runExpandParamsSchema>;
export type BufferChanged = z.infer<typeof bufferChangedSchema>;
export type TabPatch = z.infer<typeof tabPatchSchema>;

export type CommandId = "run.start" | "run.stop" | "run.kill" | "output.clear" | "editor.clear";

export interface DiagnosticPayload {
  severity: "error" | "warning";
  code: string;
  message: string;
  line: number;
  column: number;
}

export interface BootstrapPayload {
  settings: Settings;
  session: Session;
  buffers: Record<string, string>;
  safeMode: { active: boolean; reason: "crashLoop" | "shift" | null };
  versions: { app: string; bun: string };
}

/** Requests handled by Main, called by the UI. */
export type MainRequests = {
  "app.bootstrap": { params: Record<string, never>; response: BootstrapPayload };
  "run.start": { params: RunStartParams; response: { runId: string } };
  "run.expand": { params: RunExpandParams; response: EncodedValue | null };
};

/** Messages received by Main, sent by the UI. */
export type MainMessages = {
  "run.stop": TabParams;
  "run.kill": TabParams;
  "run.wait": TabParams;
  "buffer.changed": BufferChanged;
  "tab.patch": TabPatch;
  "ui.heartbeat": Record<string, never>;
};

/** Messages received by the UI, sent by Main. */
export type ViewMessages = {
  "run.events": { tabId: string; runId: string; events: RunEvent[] };
  "run.state": { tabId: string; runId: string; state: RunState; activeHandles?: number };
  "run.diagnostics": { tabId: string; runId: string; diagnostics: DiagnosticPayload[] };
  "menu.command": { command: CommandId };
};
```

`packages/rpc-schema/src/index.ts`:
```ts
export * from "./events";
export * from "./runner-ipc";
export * from "./ui-rpc";
export * from "./values";
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd packages/rpc-schema && bun test && bun run typecheck`
Expected: `5 pass`, `0 fail`, then typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/rpc-schema bun.lock
git commit -m "feat(rpc-schema): value, runner IPC, run event and UI RPC contracts with validators"
```

---

### Task 4: `@jslab/serializer` value encoding

**Files:**
- Create: `packages/serializer/package.json`, `packages/serializer/tsconfig.json`
- Create: `packages/serializer/src/encode.ts`, `packages/serializer/src/index.ts`
- Test: `packages/serializer/test/encode.test.ts`

**Interfaces:**
- Consumes: `EncodedValue`, `PropKey`, `StackFrame` from `@jslab/rpc-schema` (Task 3).
- Produces:
  - `type EncodeLimits`, `DEFAULT_LIMITS`, `EXPANDED_LIMITS`
  - `type EncodeHooks { peekPromise?; isProxy? }`
  - `type HandleTarget`, `class HandleRegistry { register(target): string; get(id); size; clear() }`
  - `class Encoder(registry, limits?, hooks?) { encode(value): EncodedValue; expand(handle): EncodedValue | null }`
  - `parseStack(stack: string): StackFrame[]`

**Behavior summary:**
- **Cycles:** only true cycles become `circular`; a value shared by two properties is encoded twice.
- **Lazy values:** getters, including class-prototype accessors, are evaluated only on expand, against the instance. Values beyond depth, long strings and oversized collections become handles.
- **Proxies** are flagged without invoking their traps.
- **Promises:** state comes from the `peekPromise` hook, which the runner implements with `Bun.peek`.

- [ ] **Step 1: Create the package**

`packages/serializer/package.json`:
```json
{
  "name": "@jslab/serializer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@jslab/rpc-schema": "workspace:*",
    "fast-check": "4.10.0"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/serializer/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `bun install`

- [ ] **Step 2: Write the failing tests**

`packages/serializer/test/encode.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { types } from "node:util";
import fc from "fast-check";
import { DEFAULT_LIMITS, Encoder, HandleRegistry, parseStack } from "../src/encode";

const make = (limits = DEFAULT_LIMITS) => {
  const registry = new HandleRegistry();
  return new Encoder(registry, limits, {
    peekPromise: (p) => {
      const state = Bun.peek.status(p);
      return state === "pending" ? { state } : { state, value: Bun.peek(p) };
    },
    isProxy: (v) => types.isProxy(v),
  });
};

describe("primitives", () => {
  test("encodes numbers losslessly", () => {
    const e = make();
    expect(e.encode(-0)).toEqual({ t: "number", v: "-0" });
    expect(e.encode(Number.NaN)).toEqual({ t: "number", v: "NaN" });
    expect(e.encode(Number.POSITIVE_INFINITY)).toEqual({ t: "number", v: "Infinity" });
    expect(e.encode(1.5)).toEqual({ t: "number", v: "1.5" });
  });

  test("encodes other primitives", () => {
    const e = make();
    expect(e.encode(undefined)).toEqual({ t: "undefined" });
    expect(e.encode(null)).toEqual({ t: "null" });
    expect(e.encode(true)).toEqual({ t: "boolean", v: true });
    expect(e.encode(10n ** 30n)).toEqual({ t: "bigint", v: "1000000000000000000000000000000" });
    expect(e.encode(Symbol("s"))).toEqual({ t: "symbol", desc: "s" });
  });

  test("truncates long strings behind a handle that expands to the full text", () => {
    const e = make({ ...DEFAULT_LIMITS, maxString: 4 });
    const encoded = e.encode("abcdefgh");
    expect(encoded).toMatchObject({ t: "string", v: "abcd", truncated: { total: 8 } });
    const handle = (encoded as { truncated: { handle: string } }).truncated.handle;
    expect(e.expand(handle)).toEqual({ t: "string", v: "abcdefgh" });
  });
});

describe("objects", () => {
  test("encodes plain objects with constructor names", () => {
    class Point {
      constructor(
        public x = 1,
        public y = 2,
      ) {}
    }
    const encoded = make().encode(new Point());
    expect(encoded).toMatchObject({
      t: "object",
      ctor: "Point",
      props: [
        [{ k: "x" }, { t: "number", v: "1" }],
        [{ k: "y" }, { t: "number", v: "2" }],
      ],
    });
    expect(make().encode(Object.create(null))).toMatchObject({ t: "object", ctor: null, props: [] });
  });

  test("turns values beyond max depth into expandable handles", () => {
    const e = make({ ...DEFAULT_LIMITS, maxDepth: 1 });
    const encoded = e.encode({ inner: { deep: 1 } });
    const inner = (encoded as { props: [unknown, { t: string; handle: string; preview: string }][] }).props[0]?.[1];
    expect(inner).toMatchObject({ t: "handle", preview: "Object {…}" });
    expect(e.expand(inner?.handle ?? "")).toMatchObject({
      t: "object",
      props: [[{ k: "deep" }, { t: "number", v: "1" }]],
    });
  });

  test("marks true cycles as circular but not shared references", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(JSON.stringify(make().encode(a))).toContain('"t":"circular"');
    const shared = { n: 1 };
    expect(JSON.stringify(make().encode({ one: shared, two: shared }))).not.toContain("circular");
  });

  test("evaluates getters only on expand, against the instance", () => {
    let calls = 0;
    class Temp {
      c = 20;
      get f() {
        calls++;
        return this.c * 2;
      }
    }
    const e = make();
    const encoded = e.encode(new Temp()) as { props: [{ k: string }, { t: string; handle: string }][] };
    const getter = encoded.props.find(([k]) => k.k === "f")?.[1];
    expect(getter?.t).toBe("getter");
    expect(calls).toBe(0);
    expect(e.expand(getter?.handle ?? "")).toEqual({ t: "number", v: "40" });
  });

  test("limits properties and reports how many more exist", () => {
    const e = make({ ...DEFAULT_LIMITS, maxProps: 2 });
    expect(e.encode({ a: 1, b: 2, c: 3 })).toMatchObject({
      props: [[{ k: "a" }], [{ k: "b" }]].map(([k]) => [k, expect.anything()]),
      more: 1,
    });
  });

  test("flags proxies without invoking traps", () => {
    let trapped = false;
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          trapped = true;
          return [];
        },
      },
    );
    expect(make().encode(proxy)).toMatchObject({ t: "object", ctor: "Proxy", proxy: true });
    expect(trapped).toBe(false);
  });
});

describe("collections", () => {
  test("encodes arrays with holes", () => {
    // biome-ignore lint/suspicious/noSparseArray: testing holes
    expect(make().encode([1, , , 4])).toMatchObject({
      t: "array",
      length: 4,
      items: [[0, { v: "1" }], { hole: 2 }, [3, { v: "4" }]],
    });
  });

  test("encodes maps and sets", () => {
    expect(make().encode(new Map([["a", 1]]))).toMatchObject({
      t: "map",
      size: 1,
      entries: [[{ v: "a" }, { v: "1" }]],
    });
    expect(make().encode(new Set([true]))).toMatchObject({ t: "set", size: 1, items: [{ v: true }] });
  });

  test("caps entries and exposes the rest through a handle", () => {
    const e = make({ ...DEFAULT_LIMITS, maxEntries: 2 });
    const encoded = e.encode([1, 2, 3]) as { items: unknown[]; more: number; handle: string };
    expect(encoded.items).toHaveLength(2);
    expect(encoded.more).toBe(1);
    expect((e.expand(encoded.handle) as { items: unknown[] }).items).toHaveLength(3);
  });

  test("encodes typed arrays and buffers", () => {
    expect(make().encode(new BigInt64Array([1n]))).toMatchObject({
      t: "typedArray",
      ctor: "BigInt64Array",
      items: ["1"],
    });
    expect(make().encode(new Uint8Array([1, 2]).buffer)).toEqual({ t: "arrayBuffer", byteLength: 2, preview: [1, 2] });
  });

  test("keeps special numbers in typed arrays exact through JSON", () => {
    const encoded = make().encode(
      new Float64Array([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 1.5]),
    );
    expect(encoded).toEqual({
      t: "typedArray",
      ctor: "Float64Array",
      length: 5,
      items: ["NaN", "Infinity", "-Infinity", "-0", 1.5],
    });
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
  });
});

describe("special objects", () => {
  test("encodes dates, regexps and urls", () => {
    expect(make().encode(new Date(0))).toEqual({ t: "date", iso: "1970-01-01T00:00:00.000Z" });
    expect(make().encode(new Date(Number.NaN))).toEqual({ t: "date", iso: null });
    expect(make().encode(/a+/gi)).toEqual({ t: "regexp", source: "a+", flags: "gi" });
    expect(make().encode(new URL("https://x.dev/a"))).toEqual({ t: "url", href: "https://x.dev/a" });
  });

  test("encodes errors with causes and parsed stacks", () => {
    const err = new TypeError("bad", { cause: "root" });
    const encoded = make().encode(err) as { stack: unknown[] };
    expect(encoded).toMatchObject({ t: "error", name: "TypeError", message: "bad", cause: { t: "string", v: "root" } });
    expect(encoded.stack.length).toBeGreaterThan(0);
  });

  test("reports promise state via the peek hook", async () => {
    const resolved = Promise.resolve(1);
    await resolved;
    expect(make().encode(resolved)).toMatchObject({ t: "promise", state: "fulfilled", value: { t: "number", v: "1" } });
    expect(make().encode(new Promise(() => {}))).toMatchObject({ t: "promise", state: "pending" });
  });

  test("classifies functions", () => {
    const e = make();
    const kind = (v: unknown) => (e.encode(v) as { kind: string }).kind;
    expect(kind(() => 1)).toBe("arrow");
    expect(kind(function named() {})).toBe("function");
    expect(kind(async () => {})).toBe("async");
    expect(kind(function* () {})).toBe("generator");
    expect(kind(async function* () {})).toBe("asyncGenerator");
    expect(kind(class A {})).toBe("class");
    expect(kind(Math.max)).toBe("native");
    expect(kind(function f() {}.bind(null))).toBe("bound");
  });
});

describe("parseStack", () => {
  test("parses named and anonymous frames", () => {
    const frames = parseStack(
      "Error: x\n    at run (/tmp/entry.mjs:3:9)\n    at /tmp/entry.mjs:10:1\n    at map (native)",
    );
    expect(frames).toEqual([
      { fn: "run", file: "/tmp/entry.mjs", line: 3, column: 9, user: false },
      { file: "/tmp/entry.mjs", line: 10, column: 1, user: false },
    ]);
  });
});

describe("robustness", () => {
  test("any value encodes to JSON-serializable output without throwing", () => {
    fc.assert(
      fc.property(
        fc.anything({
          withBigInt: true,
          withMap: true,
          withSet: true,
          withTypedArray: true,
          withDate: true,
          withNullPrototype: true,
          withSparseArray: true,
          withBoxedValues: true,
        }),
        (value) => {
          JSON.stringify(make().encode(value));
        },
      ),
      { numRuns: 300 },
    );
  });
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd packages/serializer && bun test`
Expected: FAIL, `Cannot find module "../src/encode"`.

- [ ] **Step 4: Implement**

`packages/serializer/src/encode.ts`:
```ts
import type { EncodedValue, PropKey, StackFrame } from "@jslab/rpc-schema";

export interface EncodeLimits {
  maxDepth: number;
  maxProps: number;
  maxEntries: number;
  maxString: number;
  maxFullString: number;
  maxFunctionSource: number;
}

export const DEFAULT_LIMITS: EncodeLimits = {
  maxDepth: 3,
  maxProps: 100,
  maxEntries: 1000,
  maxString: 10_000,
  maxFullString: 1_000_000,
  maxFunctionSource: 2_000,
};

/** Limits used when the user expands a handle: one level at a time, larger collections. */
export const EXPANDED_LIMITS: EncodeLimits = { ...DEFAULT_LIMITS, maxDepth: 1, maxProps: 1000, maxEntries: 10_000 };

export interface EncodeHooks {
  peekPromise?(promise: Promise<unknown>): { state: "pending" | "fulfilled" | "rejected"; value?: unknown };
  isProxy?(value: object): boolean;
}

export type HandleTarget =
  | { kind: "value"; value: unknown }
  | { kind: "string"; value: string }
  | { kind: "getter"; owner: object; receiver: object; key: PropertyKey };

export class HandleRegistry {
  #next = 1;
  readonly #targets = new Map<string, HandleTarget>();

  register(target: HandleTarget): string {
    const id = `h${this.#next++}`;
    this.#targets.set(id, target);
    return id;
  }

  get(id: string): HandleTarget | undefined {
    return this.#targets.get(id);
  }

  get size(): number {
    return this.#targets.size;
  }

  clear(): void {
    this.#targets.clear();
  }
}

const FRAME = /^\s*at (?:(.*?) \()?(.*?):(\d+):(\d+)\)?\s*$/;

export function parseStack(stack: string): StackFrame[] {
  return stack.split("\n").flatMap((line) => {
    const m = FRAME.exec(line);
    if (!m) return [];
    const [, fn, file, l, c] = m;
    return [{ ...(fn ? { fn } : {}), file, line: Number(l), column: Number(c), user: false }];
  });
}

function ctorName(obj: object): string | null {
  try {
    const proto = Object.getPrototypeOf(obj);
    if (proto === null) return null;
    const ctor = proto.constructor;
    return typeof ctor === "function" && ctor.name ? ctor.name : "Object";
  } catch {
    return "Object";
  }
}

function preview(obj: object): string {
  if (Array.isArray(obj)) return `Array(${obj.length})`;
  if (obj instanceof Map) return `Map(${obj.size})`;
  if (obj instanceof Set) return `Set(${obj.size})`;
  return `${ctorName(obj) ?? "Object"} {…}`;
}

export class Encoder {
  #nextId = 1;
  readonly #ids = new WeakMap<object, number>();

  constructor(
    readonly registry: HandleRegistry,
    readonly limits: EncodeLimits = DEFAULT_LIMITS,
    readonly hooks: EncodeHooks = {},
  ) {}

  encode(value: unknown): EncodedValue {
    return this.#encode(value, 0, new Set());
  }

  /** Returns null when the handle is unknown (for example after the registry was cleared). */
  expand(handle: string): EncodedValue | null {
    const target = this.registry.get(handle);
    if (!target) return null;
    const child = new Encoder(this.registry, EXPANDED_LIMITS, this.hooks);
    switch (target.kind) {
      case "string": {
        const { maxFullString } = this.limits;
        const v = target.value;
        return v.length > maxFullString
          ? { t: "string", v: v.slice(0, maxFullString), truncated: { total: v.length, handle } }
          : { t: "string", v };
      }
      case "getter":
        try {
          return child.encode(Reflect.get(target.owner, target.key, target.receiver));
        } catch (error) {
          return child.encode(error);
        }
      case "value":
        if (typeof target.value === "function") {
          let source = "";
          try {
            source = Function.prototype.toString.call(target.value);
          } catch {}
          return { t: "string", v: source.slice(0, this.limits.maxFunctionSource) };
        }
        return child.encode(target.value);
    }
  }

  #id(obj: object): number {
    let id = this.#ids.get(obj);
    if (id === undefined) {
      id = this.#nextId++;
      this.#ids.set(obj, id);
    }
    return id;
  }

  #encode(value: unknown, depth: number, ancestors: Set<object>): EncodedValue {
    switch (typeof value) {
      case "undefined":
        return { t: "undefined" };
      case "boolean":
        return { t: "boolean", v: value };
      case "number":
        return { t: "number", v: Object.is(value, -0) ? "-0" : String(value) };
      case "bigint":
        return { t: "bigint", v: value.toString() };
      case "symbol":
        return { t: "symbol", desc: value.description ?? "" };
      case "string":
        return this.#string(value);
      case "function":
        return this.#function(value as (...args: unknown[]) => unknown);
    }
    if (value === null) return { t: "null" };
    const obj = value as object;
    if (ancestors.has(obj)) return { t: "circular", ref: this.#id(obj) };
    try {
      ancestors.add(obj);
      return this.#object(obj, depth, ancestors);
    } catch (error) {
      return { t: "string", v: `[Uninspectable: ${String(error)}]` };
    } finally {
      ancestors.delete(obj);
    }
  }

  #string(v: string): EncodedValue {
    const { maxString } = this.limits;
    if (v.length <= maxString) return { t: "string", v };
    return {
      t: "string",
      v: v.slice(0, maxString),
      truncated: { total: v.length, handle: this.registry.register({ kind: "string", value: v }) },
    };
  }

  #function(fn: (...args: unknown[]) => unknown): EncodedValue {
    let source = "";
    try {
      source = Function.prototype.toString.call(fn);
    } catch {}
    const ctor = (fn as { constructor?: { name?: string } }).constructor?.name;
    const kind = /^class[\s{]/.test(source)
      ? "class"
      : ctor === "AsyncGeneratorFunction"
        ? "asyncGenerator"
        : ctor === "GeneratorFunction"
          ? "generator"
          : ctor === "AsyncFunction"
            ? "async"
            : fn.name.startsWith("bound ")
              ? "bound"
              : /\{\s*\[native code\]\s*\}\s*$/.test(source)
                ? "native"
                : Object.hasOwn(fn, "prototype")
                  ? "function"
                  : "arrow";
    return { t: "function", name: fn.name, kind, handle: this.registry.register({ kind: "value", value: fn }) };
  }

  #object(obj: object, depth: number, ancestors: Set<object>): EncodedValue {
    if (obj instanceof Date) return { t: "date", iso: Number.isNaN(obj.getTime()) ? null : obj.toISOString() };
    if (obj instanceof RegExp) return { t: "regexp", source: obj.source, flags: obj.flags };
    if (typeof URL !== "undefined" && obj instanceof URL) return { t: "url", href: obj.href };
    if (obj instanceof WeakMap) return { t: "weak", kind: "WeakMap" };
    if (obj instanceof WeakSet) return { t: "weak", kind: "WeakSet" };
    if (typeof WeakRef !== "undefined" && obj instanceof WeakRef) return { t: "weak", kind: "WeakRef" };
    if (this.hooks.isProxy?.(obj)) return { t: "object", id: this.#id(obj), ctor: "Proxy", props: [], proxy: true };
    if (obj instanceof Error) {
      const cause = "cause" in obj ? { cause: this.#encode(obj.cause, depth + 1, ancestors) } : {};
      return { t: "error", name: obj.name, message: obj.message, stack: parseStack(obj.stack ?? ""), ...cause };
    }
    if (obj instanceof Promise) {
      const peek = this.hooks.peekPromise?.(obj) ?? { state: "pending" as const };
      return {
        t: "promise",
        id: this.#id(obj),
        state: peek.state,
        ...(peek.state === "pending" ? {} : { value: this.#encode(peek.value, depth + 1, ancestors) }),
      };
    }
    if (depth >= this.limits.maxDepth) {
      return { t: "handle", handle: this.registry.register({ kind: "value", value: obj }), preview: preview(obj) };
    }
    if (Array.isArray(obj)) return this.#array(obj, depth, ancestors);
    if (ArrayBuffer.isView(obj) && !(obj instanceof DataView))
      return this.#typedArray(obj as unknown as ArrayLike<number | bigint> & object);
    if (obj instanceof ArrayBuffer) {
      return {
        t: "arrayBuffer",
        byteLength: obj.byteLength,
        preview: Array.from(new Uint8Array(obj, 0, Math.min(32, obj.byteLength))),
      };
    }
    if (obj instanceof Map) return this.#map(obj, depth, ancestors);
    if (obj instanceof Set) return this.#set(obj, depth, ancestors);
    if (typeof Headers !== "undefined" && obj instanceof Headers) return { t: "headers", entries: [...obj.entries()] };
    if (typeof Response !== "undefined" && obj instanceof Response) {
      return {
        t: "response",
        status: obj.status,
        statusText: obj.statusText,
        url: obj.url,
        headers: [...obj.headers.entries()],
      };
    }
    return this.#plain(obj, depth, ancestors);
  }

  #array(arr: unknown[], depth: number, ancestors: Set<object>): EncodedValue {
    const limit = Math.min(arr.length, this.limits.maxEntries);
    const items: ([number, EncodedValue] | { hole: number })[] = [];
    let holes = 0;
    for (let i = 0; i < limit; i++) {
      if (!Object.hasOwn(arr, i)) {
        holes++;
        continue;
      }
      if (holes > 0) {
        items.push({ hole: holes });
        holes = 0;
      }
      items.push([i, this.#encode(arr[i], depth + 1, ancestors)]);
    }
    if (holes > 0) items.push({ hole: holes });
    return {
      t: "array",
      id: this.#id(arr),
      ctor: ctorName(arr) ?? "Array",
      length: arr.length,
      items,
      ...(arr.length > limit
        ? { more: arr.length - limit, handle: this.registry.register({ kind: "value", value: arr }) }
        : {}),
    };
  }

  #typedArray(view: ArrayLike<number | bigint> & object): EncodedValue {
    const limit = Math.min(view.length, this.limits.maxEntries);
    const items: (number | string)[] = [];
    for (let i = 0; i < limit; i++) {
      const x = view[i] as number | bigint;
      // JSON has no NaN, ±Infinity or -0, so those items are strings, like scalar numbers. The UI reads the
      // item type from `ctor` (Big* arrays hold bigints), never from typeof.
      if (typeof x === "bigint") items.push(x.toString());
      else if (Number.isFinite(x) && !Object.is(x, -0)) items.push(x);
      else items.push(Object.is(x, -0) ? "-0" : String(x));
    }
    return {
      t: "typedArray",
      ctor: ctorName(view) ?? "TypedArray",
      length: view.length,
      items,
      ...(view.length > limit
        ? { more: view.length - limit, handle: this.registry.register({ kind: "value", value: view }) }
        : {}),
    };
  }

  #map(map: Map<unknown, unknown>, depth: number, ancestors: Set<object>): EncodedValue {
    const entries: [EncodedValue, EncodedValue][] = [];
    for (const [k, v] of map) {
      if (entries.length >= this.limits.maxEntries) break;
      entries.push([this.#encode(k, depth + 1, ancestors), this.#encode(v, depth + 1, ancestors)]);
    }
    return {
      t: "map",
      id: this.#id(map),
      size: map.size,
      entries,
      ...(map.size > entries.length
        ? { more: map.size - entries.length, handle: this.registry.register({ kind: "value", value: map }) }
        : {}),
    };
  }

  #set(set: Set<unknown>, depth: number, ancestors: Set<object>): EncodedValue {
    const items: EncodedValue[] = [];
    for (const v of set) {
      if (items.length >= this.limits.maxEntries) break;
      items.push(this.#encode(v, depth + 1, ancestors));
    }
    return {
      t: "set",
      id: this.#id(set),
      size: set.size,
      items,
      ...(set.size > items.length
        ? { more: set.size - items.length, handle: this.registry.register({ kind: "value", value: set }) }
        : {}),
    };
  }

  #plain(obj: object, depth: number, ancestors: Set<object>): EncodedValue {
    const keys = Reflect.ownKeys(obj);
    const props: [PropKey, EncodedValue][] = [];
    const toKey = (key: PropertyKey): PropKey =>
      typeof key === "symbol" ? { sym: key.description ?? "" } : { k: String(key) };
    let total = keys.length;

    for (const key of keys) {
      if (props.length >= this.limits.maxProps) break;
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc) continue;
      if (desc.get || desc.set) {
        props.push([
          toKey(key),
          desc.get
            ? { t: "getter", handle: this.registry.register({ kind: "getter", owner: obj, receiver: obj, key }) }
            : { t: "undefined" },
        ]);
        continue;
      }
      props.push([toKey(key), this.#encode(desc.value, depth + 1, ancestors)]);
    }

    // Accessors inherited from class prototypes (not Object.prototype), evaluated against the instance.
    const own = new Set<PropertyKey>(keys);
    for (
      let proto = Object.getPrototypeOf(obj);
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto)
    ) {
      for (const key of Reflect.ownKeys(proto)) {
        if (own.has(key) || key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        if (!desc?.get) continue;
        own.add(key);
        total++;
        if (props.length >= this.limits.maxProps) continue;
        props.push([
          toKey(key),
          { t: "getter", handle: this.registry.register({ kind: "getter", owner: proto, receiver: obj, key }) },
        ]);
      }
    }

    const ctor = ctorName(obj);
    const proto = Object.getPrototypeOf(obj);
    return {
      t: "object",
      id: this.#id(obj),
      ctor,
      props,
      ...(total > props.length
        ? { more: total - props.length, handle: this.registry.register({ kind: "value", value: obj }) }
        : {}),
      ...(proto && proto !== Object.prototype
        ? {
            proto: {
              t: "handle",
              handle: this.registry.register({ kind: "value", value: proto }),
              preview: `${ctor ?? "Object"}.prototype`,
            },
          }
        : {}),
      ...(keys.length > 0 && Object.isFrozen(obj) ? { frozen: true } : {}),
    };
  }
}
```

`packages/serializer/src/index.ts`:
```ts
export * from "./encode";
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `cd packages/serializer && bun test && bun run typecheck`
Expected: `20 pass`, `0 fail` (the property test runs 300 random values), then typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/serializer bun.lock
git commit -m "feat(serializer): encode runtime values with lazy handles, cycles, getters and limits"
```

---

### Task 5: `@jslab/transform` pipeline and instrumentation

**Files:**
- Create: `packages/transform/package.json`, `packages/transform/tsconfig.json`
- Create: `packages/transform/src/types.ts`, `packages/transform/src/instrument.ts`, `packages/transform/src/transform.ts`, `packages/transform/src/index.ts`
- Test: `packages/transform/test/helpers.ts`, `packages/transform/test/transform.test.ts`

**Interfaces:**
- Produces:
  - `transform(source: string, options: TransformOptions): TransformResult`
  - `toDiagnostic(error: unknown): Diagnostic`
  - Types: `Language`, `TransformOptions { language; autoLog; loopProtection; loopProtectionMaxIterations; logpoints }`, `DiagnosticCode`, `Diagnostic { severity; code; message; line; column; codeFrame? }`, `RawSourceMap`, `TransformResult` (`{ ok: true; code; map; diagnostics } | { ok: false; diagnostics }`)
- Runtime contract for generated code, implemented by the runner in Task 8:
  - `__jl.log(line, value)` returns `value`.
  - `__jl.mc(line, column, value, format?)` returns `value`, and `format` receives `$`.

**How the plugin works (spec §5.5)**

All instrumentation runs in `Program.enter`, before the TypeScript and React presets touch the AST, so line numbers are the user's original lines.

1. **Reserved name:** reject any user binding named `__jl`.
2. **Markers:** parse magic-comment markers from `file.ast.comments`. Logpoints become virtual `//?` markers.
3. **Resolve targets:**
   - Line markers go to a statement.
   - Block markers go to a loop/if head, or to the largest expression ending just before the comment.
4. **Apply markers** innermost-first, so Babel paths never go stale.
5. **Auto Log:** wrap top-level expression statements. Skip assignments, updates, `console.*`, statements already handled by a marker, and the directives `use strict`/`use asm`/`use client`/`use server`.
6. **Loop protection:** in a fresh traversal, add a per-entry counter to every loop.

- [ ] **Step 1: Create the package**

`packages/transform/package.json`:
```json
{
  "name": "@jslab/transform",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@babel/standalone": "8.0.5"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/transform/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `bun install`

- [ ] **Step 2: Write the test helper**

It transforms the source, installs a recording `__jl`, writes the code to a temp `.mjs` file and imports it.

`packages/transform/test/helpers.ts`:
```ts
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "../src/transform";
import type { TransformOptions } from "../src/types";

export const baseOptions: TransformOptions = {
  language: "typescript",
  autoLog: true,
  loopProtection: true,
  loopProtectionMaxIterations: 2000,
  logpoints: [],
};

export interface Call {
  kind: "log" | "mc";
  line: number;
  value: unknown;
}

export async function runInstrumented(source: string, options: Partial<TransformOptions> = {}) {
  const result = transform(source, { ...baseOptions, ...options });
  if (!result.ok) throw new Error(`transform failed: ${result.diagnostics[0]?.message}`);
  const calls: Call[] = [];
  (globalThis as Record<string, unknown>).__jl = {
    log(line: number, value: unknown) {
      calls.push({ kind: "log", line, value });
      return value;
    },
    mc(line: number, _column: number, value: unknown, format?: (v: unknown) => unknown) {
      calls.push({ kind: "mc", line, value: format ? format(value) : value });
      return value;
    },
  };
  const file = join(tmpdir(), `jslab-transform-${crypto.randomUUID()}.mjs`);
  await Bun.write(file, result.code);
  try {
    await import(file);
  } finally {
    await unlink(file);
  }
  return { calls, result };
}
```

- [ ] **Step 3: Write the failing tests**

`packages/transform/test/transform.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { transform } from "../src/transform";
import { baseOptions, runInstrumented } from "./helpers";

const plain = { ...baseOptions, autoLog: false, loopProtection: false };

describe("pipeline", () => {
  test("strips TypeScript types and declare fields", () => {
    const r = transform("const a: number = 1;\nclass X { declare y: string; z = 1 }", plain);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.code).not.toContain(": number");
    expect(r.code).not.toContain("declare");
  });

  test("compiles TSX with the automatic JSX runtime", () => {
    const r = transform("const el = <div>{1}</div>;", { ...plain, language: "tsx" });
    expect(r.ok && r.code).toContain("react/jsx-runtime");
  });

  test("reports syntax errors with position and code frame", () => {
    const r = transform("const x = ;", plain);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({
      severity: "error",
      code: "syntax",
      message: "Unexpected token",
      line: 1,
      column: 11,
    });
    expect(r.diagnostics[0]?.codeFrame).toContain("const x = ;");
  });

  test("produces a source map", () => {
    const r = transform("const a = 1;\na", baseOptions);
    expect(r.ok && r.map.mappings.length).toBeGreaterThan(0);
  });

  test("rejects user bindings named __jl", () => {
    const r = transform("const __jl = 1;", baseOptions);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.diagnostics[0]).toMatchObject({ code: "reserved-identifier", line: 1 });
  });
});

describe("auto log", () => {
  test("logs top-level expressions with their original line", async () => {
    const { calls } = await runInstrumented("const a = 1;\n\na + 1;\n'x'.repeat(2)");
    expect(calls).toEqual([
      { kind: "log", line: 3, value: 2 },
      { kind: "log", line: 4, value: "xx" },
    ]);
  });

  test("skips assignments, updates and console calls", async () => {
    const { calls } = await runInstrumented("let a = 1;\na = 2;\na++;\nconsole.debug(a);");
    expect(calls).toEqual([]);
  });

  test("logs a leading string literal but not 'use strict'", async () => {
    expect((await runInstrumented("'hello'")).calls).toEqual([{ kind: "log", line: 1, value: "hello" }]);
    expect((await runInstrumented("'use strict'")).calls).toEqual([]);
  });

  test("logs awaited values", async () => {
    const { calls } = await runInstrumented("await Promise.resolve(5)");
    expect(calls).toEqual([{ kind: "log", line: 1, value: 5 }]);
  });

  test("only instruments top-level statements", async () => {
    const { calls } = await runInstrumented("function f() { 1 + 1 }\nf()");
    expect(calls).toEqual([{ kind: "log", line: 2, value: undefined }]);
  });

  test("can be disabled", async () => {
    expect((await runInstrumented("1 + 1", { autoLog: false })).calls).toEqual([]);
  });
});

describe("magic comments", () => {
  test("//? on an expression statement logs once", async () => {
    const { calls } = await runInstrumented("1 + 1 //?");
    expect(calls).toEqual([{ kind: "mc", line: 1, value: 2 }]);
  });

  test("//? on a declaration logs the declared value", async () => {
    expect((await runInstrumented("const x = 2 * 3 //?")).calls).toEqual([{ kind: "mc", line: 1, value: 6 }]);
    expect((await runInstrumented("const a = 1, b = 2 //?")).calls).toEqual([
      { kind: "mc", line: 1, value: { a: 1, b: 2 } },
    ]);
  });

  test("$ expression formats the value", async () => {
    const { calls } = await runInstrumented("[1, 2, 3] //? $.length");
    expect(calls).toEqual([{ kind: "mc", line: 1, value: 3 }]);
  });

  test("//? on a return statement logs the returned value", async () => {
    const { calls } = await runInstrumented("function f() {\n  return 4 //?\n}\nf()", { autoLog: false });
    expect(calls).toEqual([{ kind: "mc", line: 2, value: 4 }]);
  });

  test("/*?*/ logs an inline sub-expression", async () => {
    const { calls } = await runInstrumented("'abc'.toUpperCase() /*?*/ .length", { autoLog: false });
    expect(calls).toEqual([{ kind: "mc", line: 1, value: "ABC" }]);
  });

  test("/*?*/ before a for...of body logs each binding", async () => {
    const { calls } = await runInstrumented("for (const n of [1, 2]) /*?*/ { }", { autoLog: false });
    expect(calls.map((c) => c.value)).toEqual([1, 2]);
  });

  test("/*?*/ before a while body logs each test", async () => {
    const { calls } = await runInstrumented("let i = 0;\nwhile (i < 2) /*?*/ { i++ }", { autoLog: false });
    expect(calls.map((c) => c.value)).toEqual([true, true, false]);
  });

  test("markers inside strings are ignored", async () => {
    expect((await runInstrumented("const s = '//?'", { autoLog: false })).calls).toEqual([]);
  });

  test("a marker with no loggable value produces a warning", () => {
    const r = transform("if (true) {\n} //?", baseOptions);
    expect(r.ok && r.diagnostics).toEqual([expect.objectContaining({ code: "magic-comment-no-value", line: 2 })]);
  });

  test("an invalid $ expression warns and still logs the raw value", async () => {
    const { calls, result } = await runInstrumented("1 //? $.(");
    expect(calls).toEqual([{ kind: "mc", line: 1, value: 1 }]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: "magic-comment-invalid-expression" })]);
  });

  test("never evaluates an expression twice", async () => {
    const { calls } = await runInstrumented("let i = 0;\ni++ //?\ni");
    expect(calls).toEqual([
      { kind: "mc", line: 2, value: 0 },
      { kind: "log", line: 3, value: 1 },
    ]);
  });
});

describe("logpoints", () => {
  test("log a declaration's value", async () => {
    const { calls } = await runInstrumented("const a = 5;\nconst b = a * 2;", { logpoints: [2] });
    expect(calls).toEqual([{ kind: "mc", line: 2, value: 10 }]);
  });

  test("log a statement inside a loop on every iteration", async () => {
    const { calls } = await runInstrumented("for (let i = 0; i < 2; i++) {\n  i;\n}", {
      autoLog: false,
      logpoints: [2],
    });
    expect(calls.map((c) => c.value)).toEqual([0, 1]);
  });

  test("on a for...of head log the binding", async () => {
    const { calls } = await runInstrumented("for (const x of [7, 8]) {\n}", { autoLog: false, logpoints: [1] });
    expect(calls.map((c) => c.value)).toEqual([7, 8]);
  });

  test("on an empty line warn", () => {
    const r = transform("const a = 1;\n\n", { ...baseOptions, logpoints: [2] });
    expect(r.ok && r.diagnostics).toEqual([expect.objectContaining({ code: "logpoint-no-value", line: 2 })]);
  });

  test("defer to a magic comment on the same line", async () => {
    const { calls } = await runInstrumented("1 + 1 //?", { logpoints: [1] });
    expect(calls).toHaveLength(1);
  });
});

describe("loop protection", () => {
  const limited = { autoLog: false, loopProtectionMaxIterations: 5 };
  const infinite: Record<string, string> = {
    for: "for (;;) {}",
    while: "while (true) {}",
    "do-while": "do {} while (true)",
    "for-in": "const o = {};\nfor (let i = 0; i < 10; i++) o['k' + i] = i;\nfor (const k in o) {}",
    "for-of": "function* g() { let n = 0; for (;;) yield n++; }\nfor (const x of g()) {}",
    "for-await": "async function* g() { let n = 0; for (;;) yield n++; }\nfor await (const x of g()) {}",
    "non-block body": "while (true) ;",
  };

  for (const [name, source] of Object.entries(infinite)) {
    test(`stops ${name} loops`, async () => {
      await expect(runInstrumented(source, limited)).rejects.toThrow("exceeded 5 iterations");
    });
  }

  test("allows exactly the limit", async () => {
    const { calls } = await runInstrumented("let n = 0;\nfor (let i = 0; i < 5; i++) n++;\nn //?", limited);
    expect(calls).toEqual([{ kind: "mc", line: 3, value: 5 }]);
  });

  test("keeps labeled continue working and resets per loop entry", async () => {
    const source =
      "let n = 0;\nouter: for (let i = 0; i < 4; i++) {\n  for (let j = 0; j < 4; j++) {\n    if (j === 3) continue outer;\n    n++;\n  }\n}\nn //?";
    const { calls } = await runInstrumented(source, limited);
    expect(calls).toEqual([{ kind: "mc", line: 8, value: 12 }]);
  });

  test("adds no guards when disabled", () => {
    const r = transform("while (true) {}", { ...baseOptions, loopProtection: false });
    expect(r.ok && r.code).not.toContain("RangeError");
  });
});
```

- [ ] **Step 4: Run the tests and watch them fail**

Run: `cd packages/transform && bun test test/transform.test.ts`
Expected: FAIL, `Cannot find module "../src/transform"`.

- [ ] **Step 5: Write the types**

`packages/transform/src/types.ts`:
```ts
export type Language = "typescript" | "javascript" | "tsx" | "jsx";

export interface TransformOptions {
  language: Language;
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  logpoints: readonly number[];
}

export type DiagnosticCode =
  | "syntax"
  | "reserved-identifier"
  | "magic-comment-no-value"
  | "magic-comment-invalid-expression"
  | "logpoint-no-value";

export interface Diagnostic {
  severity: "error" | "warning";
  code: DiagnosticCode;
  message: string;
  line: number;
  column: number;
  codeFrame?: string;
}

export interface RawSourceMap {
  version: number;
  sources: string[];
  names: string[];
  mappings: string;
  sourcesContent?: string[];
  file?: string;
}

export type TransformResult =
  | { ok: true; code: string; map: RawSourceMap; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };
```

- [ ] **Step 6: Write the instrumentation plugin**

`packages/transform/src/instrument.ts`:
```ts
import type { Diagnostic, TransformOptions } from "./types";

// Babel's plugin API is untyped in @babel/standalone; keep `any` confined to this file.
// biome-ignore lint/suspicious/noExplicitAny: Babel plugin API
type Any = any;

interface Marker {
  kind: "line" | "block";
  source: "magic" | "logpoint";
  line: number;
  column: number;
  start: number;
  end: number;
  expression: string | null;
}

interface Target {
  marker: Marker;
  path: Any;
  mode: "statement" | "head" | "expression";
}

const LOGGABLE = new Set(["ExpressionStatement", "VariableDeclaration", "ReturnStatement", "ThrowStatement"]);
const BLOCK_HEADS = new Set(["IfStatement", "WhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"]);
const LINE_HEADS = new Set([...BLOCK_HEADS, "DoWhileStatement"]);
const DIRECTIVES_NOT_LOGGED = new Set(["use strict", "use asm", "use client", "use server"]);

export function parseMarkers(
  comments: ReadonlyArray<{ type: string; value: string; start: number; end: number; loc: Any }>,
  logpoints: readonly number[],
): Marker[] {
  const markers: Marker[] = [];
  for (const c of comments) {
    const match = c.type === "CommentLine" ? /^\s?\?(.*)$/.exec(c.value) : /^\s*\?(.*?)\s*$/s.exec(c.value);
    if (!match) continue;
    markers.push({
      kind: c.type === "CommentLine" ? "line" : "block",
      source: "magic",
      line: c.loc.start.line,
      column: c.loc.start.column + 1,
      start: c.start,
      end: c.end,
      expression: match[1]?.trim() || null,
    });
  }
  const magicLines = new Set(markers.filter((m) => m.kind === "line").map((m) => m.line));
  for (const line of new Set(logpoints)) {
    if (magicLines.has(line)) continue;
    markers.push({ kind: "line", source: "logpoint", line, column: 1, start: -1, end: -1, expression: null });
  }
  return markers;
}

export function createInstrumentPlugin(options: TransformOptions, source: string, diagnostics: Diagnostic[]) {
  return (api: Any) => {
    const t = api.types;
    const template = api.template;

    const jl = (method: "log" | "mc") => t.memberExpression(t.identifier("__jl"), t.identifier(method));
    const span = (node: Any) => node.end - node.start;

    const warn = (code: Diagnostic["code"], message: string, marker: Marker) => {
      diagnostics.push({ severity: "warning", code, message, line: marker.line, column: marker.column });
    };

    const formatterFor = (marker: Marker) => {
      if (!marker.expression) return null;
      try {
        return t.arrowFunctionExpression([t.identifier("$")], template.expression.ast(marker.expression));
      } catch {
        warn("magic-comment-invalid-expression", `Invalid magic comment expression: ${marker.expression}`, marker);
        return null;
      }
    };

    const mc = (marker: Marker, expression: Any) => {
      const formatter = formatterFor(marker);
      const args = [t.numericLiteral(marker.line), t.numericLiteral(marker.column), expression];
      if (formatter) args.push(formatter);
      return t.callExpression(jl("mc"), args);
    };

    const bindingsValue = (node: Any) => {
      if (t.isMemberExpression(node)) return t.cloneNode(node);
      const names = Object.keys(t.getBindingIdentifiers(node));
      if (names.length === 1) return t.identifier(names[0]);
      return t.objectExpression(names.map((n) => t.objectProperty(t.identifier(n), t.identifier(n), false, true)));
    };

    const noValue = (marker: Marker) =>
      marker.source === "logpoint"
        ? warn("logpoint-no-value", "Logpoint has no value to log on this line", marker)
        : warn("magic-comment-no-value", "Magic comment has no value to log", marker);

    return {
      name: "jslab-instrument",
      visitor: {
        Program: {
          enter(program: Any, state: Any) {
            if (program.scope.hasBinding("__jl")) {
              const error = new Error("`__jl` is reserved by JSLab") as Error & Any;
              const binding = program.scope.getBinding("__jl");
              error.loc = binding?.identifier?.loc?.start ?? { line: 1, column: 0 };
              error.jslabCode = "reserved-identifier";
              throw error;
            }

            const markers = parseMarkers(state.file.ast.comments ?? [], options.logpoints);
            const handled = new WeakSet<object>();

            if (markers.length > 0) {
              const statements: Any[] = [];
              const expressions: Any[] = [];
              program.traverse({
                Statement(p: Any) {
                  const type = p.node.type;
                  if (!LOGGABLE.has(type) && !LINE_HEADS.has(type)) return;
                  if (type === "VariableDeclaration" && (p.key === "init" || p.key === "left" || p.node.declare))
                    return;
                  statements.push(p);
                },
                Expression(p: Any) {
                  if (p.parentPath.isVariableDeclarator() && p.key === "id") return;
                  if (p.key === "left" && (p.parentPath.isAssignmentExpression() || p.parentPath.isForXStatement()))
                    return;
                  if (p.parentPath.isUpdateExpression()) return;
                  if (p.parentPath.isMemberExpression() && p.key === "property" && !p.parent.computed) return;
                  if (p.parentPath.isObjectProperty() && p.key === "key") return;
                  expressions.push(p);
                },
              });

              const targets: Target[] = [];
              for (const marker of markers) {
                const target =
                  marker.kind === "line"
                    ? resolveLineMarker(marker, statements)
                    : resolveBlockMarker(marker, statements, expressions, source);
                if (target) targets.push(target);
                else noValue(marker);
              }

              // Innermost/last targets first so earlier paths never go stale.
              targets.sort((a, b) => b.path.node.start - a.path.node.start || span(a.path.node) - span(b.path.node));

              for (const { marker, path, mode } of targets) {
                if (mode === "expression") {
                  path.replaceWith(mc(marker, path.node));
                  continue;
                }
                if (mode === "head") {
                  applyHead(marker, path);
                  continue;
                }
                const node = path.node;
                switch (node.type) {
                  case "ExpressionStatement":
                    node.expression = mc(marker, node.expression);
                    handled.add(node);
                    break;
                  case "ReturnStatement":
                  case "ThrowStatement":
                    if (node.argument) node.argument = mc(marker, node.argument);
                    else noValue(marker);
                    break;
                  case "VariableDeclaration": {
                    const anchor = path.parentPath.isExportNamedDeclaration() ? path.parentPath : path;
                    anchor.insertAfter(t.expressionStatement(mc(marker, bindingsValue(node))));
                    break;
                  }
                  default:
                    applyHead(marker, path);
                }
              }
            }

            if (options.autoLog) {
              const directiveLogs = program.node.directives
                .filter((d: Any) => !DIRECTIVES_NOT_LOGGED.has(d.value.value))
                .map((d: Any) =>
                  t.expressionStatement(
                    t.callExpression(jl("log"), [t.numericLiteral(d.loc.start.line), t.stringLiteral(d.value.value)]),
                  ),
                );
              for (const stmt of program.get("body")) {
                if (!stmt.isExpressionStatement() || handled.has(stmt.node)) continue;
                const expression = stmt.node.expression;
                if (t.isAssignmentExpression(expression) || t.isUpdateExpression(expression)) continue;
                if (isCallOn(t, expression, "console") || isCallOn(t, expression, "__jl")) continue;
                stmt.node.expression = t.callExpression(jl("log"), [
                  t.numericLiteral(stmt.node.loc.start.line),
                  expression,
                ]);
              }
              if (directiveLogs.length > 0) program.unshiftContainer("body", directiveLogs);
            }

            if (options.loopProtection) {
              const max = options.loopProtectionMaxIterations;
              const seen = new WeakSet<object>();
              program.traverse({
                Loop(loop: Any) {
                  if (seen.has(loop.node)) return;
                  seen.add(loop.node);
                  const line = loop.node.loc?.start.line ?? 0;
                  const counter = loop.scope.generateUidIdentifier("jlLoop");
                  const guard = t.ifStatement(
                    t.binaryExpression(
                      ">",
                      t.updateExpression("++", t.cloneNode(counter), true),
                      t.numericLiteral(max),
                    ),
                    t.throwStatement(
                      t.newExpression(t.identifier("RangeError"), [
                        t.stringLiteral(
                          `Potential infinite loop: exceeded ${max} iterations (line ${line}). Disable Loop Protection or raise the limit in Settings → Advanced.`,
                        ),
                      ]),
                    ),
                  );
                  const body = loop.get("body");
                  if (body.isBlockStatement()) body.unshiftContainer("body", guard);
                  else body.replaceWith(t.blockStatement([guard, body.node]));
                  let anchor = loop;
                  while (anchor.parentPath?.isLabeledStatement()) anchor = anchor.parentPath;
                  anchor.insertBefore(
                    t.variableDeclaration("let", [t.variableDeclarator(counter, t.numericLiteral(0))]),
                  );
                },
              });
            }

            function applyHead(marker: Marker, path: Any) {
              const node = path.node;
              switch (node.type) {
                case "IfStatement":
                case "WhileStatement":
                case "DoWhileStatement":
                  node.test = mc(marker, node.test);
                  return;
                case "ForStatement":
                  if (node.test) node.test = mc(marker, node.test);
                  else noValue(marker);
                  return;
                case "ForInStatement":
                case "ForOfStatement": {
                  const log = t.expressionStatement(mc(marker, bindingsValue(node.left)));
                  const body = path.get("body");
                  if (body.isBlockStatement()) body.unshiftContainer("body", log);
                  else body.replaceWith(t.blockStatement([log, body.node]));
                  return;
                }
                default:
                  noValue(marker);
              }
            }
          },
        },
      },
    };
  };
}

function isCallOn(t: Any, expression: Any, objectName: string): boolean {
  return (
    t.isCallExpression(expression) &&
    t.isMemberExpression(expression.callee) &&
    t.isIdentifier(expression.callee.object, { name: objectName })
  );
}

function resolveLineMarker(marker: Marker, statements: Any[]): Target | null {
  const bySpanDesc = (a: Any, b: Any) => b.node.end - b.node.start - (a.node.end - a.node.start);
  if (marker.source === "magic") {
    const loggable = statements
      .filter((p) => LOGGABLE.has(p.node.type) && p.node.loc.end.line === marker.line && p.node.end <= marker.start)
      .sort(bySpanDesc);
    return loggable[0] ? { marker, path: loggable[0], mode: "statement" } : null;
  }
  const starting = statements.filter((p) => p.node.loc.start.line === marker.line);
  const loggable = starting.filter((p) => LOGGABLE.has(p.node.type)).sort(bySpanDesc);
  if (loggable[0]) return { marker, path: loggable[0], mode: "statement" };
  const heads = starting.filter((p) => LINE_HEADS.has(p.node.type)).sort(bySpanDesc);
  return heads[0] ? { marker, path: heads[0], mode: "head" } : null;
}

function resolveBlockMarker(marker: Marker, statements: Any[], expressions: Any[], source: string): Target | null {
  for (const p of statements) {
    const node = p.node;
    if (!BLOCK_HEADS.has(node.type)) continue;
    const body = node.type === "IfStatement" ? node.consequent : node.body;
    const headEnd =
      node.type === "ForStatement"
        ? ((node.update ?? node.test ?? node.init)?.end ?? node.start)
        : node.type === "ForInStatement" || node.type === "ForOfStatement"
          ? node.right.end
          : node.test.end;
    if (marker.start >= headEnd && marker.end <= body.start) return { marker, path: p, mode: "head" };
  }
  let before = marker.start - 1;
  while (before >= 0 && /\s/.test(source[before] ?? "")) before--;
  const end = before + 1;
  const candidates = expressions
    .filter((p) => p.node.end === end && p.node.start < marker.start)
    .sort((a, b) => a.node.start - b.node.start);
  return candidates[0] ? { marker, path: candidates[0], mode: "expression" } : null;
}
```

- [ ] **Step 7: Write the pipeline**

`packages/transform/src/transform.ts`:
```ts
import * as Babel from "@babel/standalone";
import { createInstrumentPlugin } from "./instrument";
import type { Diagnostic, Language, RawSourceMap, TransformOptions, TransformResult } from "./types";

const FILENAMES: Record<Language, string> = {
  typescript: "entry.ts",
  tsx: "entry.tsx",
  javascript: "entry.js",
  jsx: "entry.jsx",
};

type Presets = NonNullable<NonNullable<Parameters<typeof Babel.transform>[1]>["presets"]>;

function presetsFor(language: Language): Presets {
  switch (language) {
    case "typescript":
      return [["typescript", {}]];
    case "tsx":
      return [
        ["typescript", {}],
        ["react", { runtime: "automatic" }],
      ];
    case "jsx":
      return [["react", { runtime: "automatic" }]];
    case "javascript":
      return [];
  }
}

export function transform(source: string, options: TransformOptions): TransformResult {
  const diagnostics: Diagnostic[] = [];
  const filename = FILENAMES[options.language];
  try {
    const out = Babel.transform(source, {
      filename,
      sourceType: "module",
      sourceMaps: true,
      presets: presetsFor(options.language),
      plugins: [createInstrumentPlugin(options, source, diagnostics)],
      parserOpts: { allowAwaitOutsideFunction: true },
    });
    if (!out) throw new Error("Babel returned no output");
    return { ok: true, code: out.code ?? "", map: out.map as RawSourceMap, diagnostics };
  } catch (error) {
    diagnostics.push(toDiagnostic(error));
    return { ok: false, diagnostics };
  }
}

interface BabelLikeError {
  message?: string;
  loc?: { line: number; column: number };
  jslabCode?: Diagnostic["code"];
}

export function toDiagnostic(error: unknown): Diagnostic {
  const e = error as BabelLikeError;
  const raw = String(e?.message ?? error);
  const [first = raw, ...rest] = raw.split("\n");
  const message = first.replace(/^.*?entry\.(?:tsx?|jsx?): /, "").replace(/ \(\d+:\d+\)$/, "");
  const codeFrame = rest.join("\n").trim();
  return {
    severity: "error",
    code: e?.jslabCode ?? "syntax",
    message,
    line: e?.loc?.line ?? 1,
    column: (e?.loc?.column ?? 0) + 1,
    ...(codeFrame ? { codeFrame } : {}),
  };
}
```

`packages/transform/src/index.ts`:
```ts
export { toDiagnostic, transform } from "./transform";
export type * from "./types";
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `cd packages/transform && bun test test/transform.test.ts && bun run typecheck`
Expected: `37 pass`, `0 fail`, then typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add packages/transform bun.lock
git commit -m "feat(transform): babel pipeline with auto log, magic comments, logpoints and loop protection"
```

---

### Task 6: Semantic equivalence suite for instrumentation

**Files:**
- Test: `packages/transform/test/semantics.test.ts`

**Interfaces:**
- Consumes: `transform` from Task 5.
- Produces: a regression suite. Every future change to `instrument.ts` must keep it green (spec goal G2).

Each fixture prints what it observes. The plain build (no instrumentation) and the fully instrumented build (Auto Log, loop protection, and a logpoint on every line) run in separate Bun processes and must print exactly the same output.

- [ ] **Step 1: Write the suite**

`packages/transform/test/semantics.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "../src/transform";
import type { Language, TransformOptions } from "../src/types";

// Instrumentation must never change observable behavior. Each fixture prints what it observes;
// the plain and instrumented builds run in separate Bun processes and must print the same thing.

const STUB = 'Object.defineProperty(globalThis, "__jl", { value: { log: (_l, v) => v, mc: (_l, _c, v) => v } });\n';

const fixtures: Record<string, { language?: Language; source: string }> = {
  hoisting: {
    source:
      "console.log(typeof hoisted, typeof v);\nfunction hoisted() { return 1 }\nvar v = 2;\nconsole.log(hoisted(), v);",
  },
  tdz: {
    source: "try { console.log(x) } catch (e) { console.log(e.constructor.name) }\nlet x = 1;\nx",
  },
  "strict mode and this": {
    source:
      "console.log(this === undefined);\ntry { undeclared = 1 } catch (e) { console.log(e.constructor.name) }\n(function () { console.log(this === undefined) })();",
  },
  "top-level await ordering": {
    source:
      "console.log('a');\nawait null;\nconsole.log('b');\nconst v = await new Promise((r) => setTimeout(() => r('c'), 5));\nconsole.log(v);\nv",
  },
  "console ordering with results": {
    source:
      "let n = 0;\nconst inc = () => { console.log('inc', ++n); return n; };\ninc();\ninc() + inc();\nconsole.log('n', n);",
  },
  "labeled loops": {
    source:
      "const out = [];\nouter: for (let i = 0; i < 3; i++) {\n  for (let j = 0; j < 3; j++) {\n    if (j === 1) continue outer;\n    if (i === 2) break outer;\n    out.push(String(i) + j);\n  }\n}\nconsole.log(out.join(','));",
  },
  generators: {
    source:
      "function* g() { let i = 0; while (i < 3) yield i++; }\nconsole.log([...g()].join(','));\nasync function* ag() { for (const x of [1, 2]) yield x; }\nconst got = [];\nfor await (const x of ag()) got.push(x);\nconsole.log(got.join(','));",
  },
  "side effects evaluate once": {
    source: "let i = 0;\ni++;\nconst j = i++;\nconsole.log(i, j);\n[i++, i++];\nconsole.log(i);",
  },
  "classes and getters": {
    source: "class A { #p = 1; get p() { return this.#p } static s = 2; }\nnew A().p\nconsole.log(new A().p, A.s);",
  },
  destructuring: {
    source:
      "const { a, b: [c, d = 4] } = { a: 1, b: [3] };\nconsole.log(a, c, d);\nlet [e, ...rest] = [5, 6, 7];\nconsole.log(e, rest.length);",
  },
  "switch and return": {
    source:
      "function f(x) {\n  switch (x) {\n    case 1: return 'one';\n    default: return 'other';\n  }\n}\nconsole.log(f(1), f(2));",
  },
  exports: {
    source: "export const value = 1;\nexport function fn() { return 2 }\nconsole.log(value, fn());",
  },
  "typescript enums and namespaces": {
    language: "typescript",
    source:
      "enum Color { Red, Green }\nconst c: Color = Color.Green;\nconsole.log(c, Color[c]);\nnamespace NS { export const k = 3 }\nconsole.log(NS.k);",
  },
  "caught errors": {
    source: "try {\n  JSON.parse('{');\n} catch (e) {\n  console.log(e.constructor.name);\n}",
  },
};

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-semantics-"));
  await Bun.write(join(dir, "stub.mjs"), STUB);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function build(source: string, options: TransformOptions): Promise<string> {
  const result = transform(source, options);
  if (!result.ok) throw new Error(`transform failed: ${JSON.stringify(result.diagnostics)}`);
  return result.code;
}

async function execute(code: string, name: string): Promise<string> {
  const file = join(dir, `${name}-${crypto.randomUUID()}.mjs`);
  await Bun.write(file, code);
  const proc = Bun.spawn([process.execPath, "--no-env-file", "--preload", join(dir, "stub.mjs"), file], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code_ = await proc.exited;
  if (code_ !== 0) throw new Error(`${name} exited ${code_}: ${stderr}`);
  return stdout;
}

describe("instrumentation preserves semantics", () => {
  for (const [name, fixture] of Object.entries(fixtures)) {
    test(name, async () => {
      const language = fixture.language ?? "javascript";
      const lines = fixture.source.split("\n").length;
      const plain = await build(fixture.source, {
        language,
        autoLog: false,
        loopProtection: false,
        loopProtectionMaxIterations: 2000,
        logpoints: [],
      });
      const instrumented = await build(fixture.source, {
        language,
        autoLog: true,
        loopProtection: true,
        loopProtectionMaxIterations: 1_000_000,
        logpoints: Array.from({ length: lines }, (_, i) => i + 1),
      });
      const expected = await execute(plain, "plain");
      expect(expected.length).toBeGreaterThan(0);
      expect(await execute(instrumented, "instrumented")).toBe(expected);
    }, 20_000);
  }
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/transform && bun test test/semantics.test.ts`
Expected: `14 pass`, `0 fail`.

If a fixture fails, the bug is in `instrument.ts`, not in the fixture:
1. Compare the two outputs in the failure message.
2. Fix the plugin.
3. Re-run both `transform.test.ts` and this suite.

- [ ] **Step 3: Commit**

```bash
git add packages/transform/test/semantics.test.ts
git commit -m "test(transform): prove instrumentation preserves program semantics"
```

---

### Task 7: `@jslab/runner-bun` event buffer and handle tracking

**Files:**
- Create: `packages/runner-bun/package.json`, `packages/runner-bun/tsconfig.json`
- Create: `packages/runner-bun/src/event-buffer.ts`, `packages/runner-bun/src/handles.ts`
- Test: `packages/runner-bun/test/event-buffer.test.ts`, `packages/runner-bun/test/handles.test.ts`

**Interfaces:**
- Consumes: `RawRunEvent`, `RawRunEventBody` from `@jslab/rpc-schema`.
- Produces:
  - `type TimerFns { setTimeout; clearTimeout }`
  - `class EventBuffer(send, maxEntries, timers, intervalMs = 16) { push(body): number | null; flush(): void }`
  - `class HandleTracker(onChange) { count; add(key, dispose); remove(key); disposeAll() }`
  - `installHandleTracking(tracker, g = globalThis)`, which wraps timers, intervals, immediates, `fetch`, `node:http`/`https`/`net` `createServer`, `node:child_process` spawn/exec/execFile/fork and `Bun.serve`

**Buffering rules (spec §5.10):**
- Events are batched every 16 ms.
- Past `maxEntries`, events are dropped and a single `truncated` event reports the running total.
- `promiseSettled` never counts toward the cap, because it updates an existing entry.

- [ ] **Step 1: Create the package**

`packages/runner-bun/package.json` (the `./bootstrap` export is used from Task 9 on):
```json
{
  "name": "@jslab/runner-bun",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./bootstrap": "./src/bootstrap.ts"
  },
  "dependencies": {
    "@jslab/rpc-schema": "workspace:*",
    "@jslab/serializer": "workspace:*"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`packages/runner-bun/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `bun install`

- [ ] **Step 2: Write the failing tests**

`packages/runner-bun/test/event-buffer.test.ts`:
```ts
import { expect, test } from "bun:test";
import type { RawRunEvent } from "@jslab/rpc-schema";
import { EventBuffer, type TimerFns } from "../src/event-buffer";

function manualTimers() {
  let pending: (() => void) | null = null;
  const timers: TimerFns = {
    setTimeout: ((fn: () => void) => {
      pending = fn;
      return 1;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {
      pending = null;
    }) as unknown as typeof clearTimeout,
  };
  return {
    timers,
    fire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
    isScheduled: () => pending !== null,
  };
}

function setup(maxEntries: number) {
  const sent: RawRunEvent[][] = [];
  const clock = manualTimers();
  const buffer = new EventBuffer((events) => sent.push(events), maxEntries, clock.timers);
  return { sent, clock, buffer };
}

test("batches events until the timer fires", () => {
  const { sent, clock, buffer } = setup(10);
  buffer.push({ kind: "stdout", text: "a" });
  buffer.push({ kind: "stdout", text: "b" });
  expect(sent).toEqual([]);
  expect(clock.isScheduled()).toBe(true);
  clock.fire();
  expect(sent).toHaveLength(1);
  expect(sent[0]?.map((e) => e.seq)).toEqual([1, 2]);
});

test("drops events beyond the cap and reports one running total", () => {
  const { sent, clock, buffer } = setup(2);
  const seqs = [1, 2, 3, 4, 5].map((n) => buffer.push({ kind: "stdout", text: String(n) }));
  expect(seqs).toEqual([1, 2, null, null, null]);
  clock.fire();
  expect(sent[0]?.map((e) => e.kind)).toEqual(["stdout", "stdout", "truncated"]);
  expect(sent[0]?.at(-1)).toMatchObject({ kind: "truncated", dropped: 3 });
  buffer.push({ kind: "stdout", text: "6" });
  buffer.flush();
  expect(sent[1]).toEqual([expect.objectContaining({ kind: "truncated", dropped: 4 })]);
});

test("promise settlements bypass the cap", () => {
  const { sent, buffer } = setup(1);
  buffer.push({ kind: "stdout", text: "a" });
  expect(buffer.push({ kind: "promiseSettled", ref: 1, value: { t: "null" } })).toBe(2);
  buffer.flush();
  expect(sent[0]?.map((e) => e.kind)).toEqual(["stdout", "promiseSettled"]);
});

test("flush sends immediately and cancels the pending timer", () => {
  const { sent, clock, buffer } = setup(10);
  buffer.push({ kind: "stdout", text: "a" });
  buffer.flush();
  expect(sent).toHaveLength(1);
  expect(clock.isScheduled()).toBe(false);
});

test("never sends empty batches", () => {
  const { sent, buffer } = setup(10);
  buffer.flush();
  expect(sent).toEqual([]);
});
```

`packages/runner-bun/test/handles.test.ts`:
```ts
import { expect, test } from "bun:test";
import { HandleTracker, installHandleTracking } from "../src/handles";

// biome-ignore lint/suspicious/noExplicitAny: sandboxed global object
function sandbox(): { tracker: HandleTracker; g: any } {
  const tracker = new HandleTracker(() => {});
  const g = {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    fetch,
    Bun: { serve: Bun.serve },
  };
  installHandleTracking(tracker, g);
  return { tracker, g };
}

test("a timeout is tracked until it fires", async () => {
  const { tracker, g } = sandbox();
  g.setTimeout(() => {}, 5);
  expect(tracker.count).toBe(1);
  await Bun.sleep(30);
  expect(tracker.count).toBe(0);
});

test("clearTimeout stops tracking", () => {
  const { tracker, g } = sandbox();
  const id = g.setTimeout(() => {}, 1000);
  g.clearTimeout(id);
  expect(tracker.count).toBe(0);
});

test("an interval is tracked until cleared", () => {
  const { tracker, g } = sandbox();
  const id = g.setInterval(() => {}, 1000);
  expect(tracker.count).toBe(1);
  g.clearInterval(id);
  expect(tracker.count).toBe(0);
});

test("disposeAll stops tracked intervals", async () => {
  const { tracker, g } = sandbox();
  let ticks = 0;
  g.setInterval(() => ticks++, 5);
  await Bun.sleep(30);
  tracker.disposeAll();
  const after = ticks;
  await Bun.sleep(30);
  expect(ticks).toBe(after);
  expect(tracker.count).toBe(0);
});

test("fetch is tracked until it settles", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      await Bun.sleep(20);
      return new Response("ok");
    },
  });
  try {
    const { tracker, g } = sandbox();
    const pending = g.fetch(`http://localhost:${server.port}/`);
    expect(tracker.count).toBe(1);
    expect(await (await pending).text()).toBe("ok");
    expect(tracker.count).toBe(0);
  } finally {
    server.stop(true);
  }
});

test("Bun.serve servers are tracked until stopped", () => {
  const { tracker, g } = sandbox();
  const server = g.Bun.serve({ port: 0, fetch: () => new Response("ok") });
  expect(tracker.count).toBe(1);
  server.stop(true);
  expect(tracker.count).toBe(0);
});

test("adding the same key twice counts once and notifies on change", () => {
  const counts: number[] = [];
  const tracker = new HandleTracker((count) => counts.push(count));
  const key = {};
  tracker.add(key, () => {});
  tracker.add(key, () => {});
  tracker.remove(key);
  expect(counts).toEqual([1, 0]);
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `cd packages/runner-bun && bun test test/event-buffer.test.ts test/handles.test.ts`
Expected: FAIL, `Cannot find module "../src/event-buffer"`.

- [ ] **Step 4: Implement**

`packages/runner-bun/src/event-buffer.ts`:
```ts
import type { RawRunEvent, RawRunEventBody } from "@jslab/rpc-schema";

export interface TimerFns {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

/** Batches run events and enforces the per-run output cap before anything crosses IPC. */
export class EventBuffer {
  #queue: RawRunEvent[] = [];
  #seq = 0;
  #counted = 0;
  #dropped = 0;
  #reportedDropped = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: (events: RawRunEvent[]) => void,
    private readonly maxEntries: number,
    private readonly timers: TimerFns,
    private readonly intervalMs = 16,
  ) {}

  /** Returns the event's sequence number, or null when the event was dropped by the cap. */
  push(body: RawRunEventBody): number | null {
    if (body.kind !== "promiseSettled") {
      if (this.#counted >= this.maxEntries) {
        this.#dropped++;
        this.#schedule();
        return null;
      }
      this.#counted++;
    }
    const seq = ++this.#seq;
    this.#queue.push({ ...body, seq, t: Date.now() } as RawRunEvent);
    this.#schedule();
    return seq;
  }

  flush(): void {
    if (this.#timer !== null) {
      this.timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#dropped !== this.#reportedDropped) {
      this.#reportedDropped = this.#dropped;
      this.#queue.push({ kind: "truncated", dropped: this.#dropped, seq: ++this.#seq, t: Date.now() });
    }
    if (this.#queue.length === 0) return;
    const events = this.#queue;
    this.#queue = [];
    this.send(events);
  }

  #schedule(): void {
    if (this.#timer !== null) return;
    this.#timer = this.timers.setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.intervalMs);
  }
}
```

`packages/runner-bun/src/handles.ts`:
```ts
// biome-ignore-all lint/suspicious/noExplicitAny: wrapping untyped host APIs
type AnyFn = (...args: any[]) => any;

/** Tracks handles that keep a run "active" (timers, servers, sockets, requests, child processes). */
export class HandleTracker {
  readonly #active = new Map<unknown, () => void>();

  constructor(private readonly onChange: (count: number) => void) {}

  get count(): number {
    return this.#active.size;
  }

  add(key: unknown, dispose: () => void): void {
    if (this.#active.has(key)) return;
    this.#active.set(key, dispose);
    this.onChange(this.#active.size);
  }

  remove(key: unknown): void {
    if (this.#active.delete(key)) this.onChange(this.#active.size);
  }

  disposeAll(): void {
    const disposers = [...this.#active.values()];
    this.#active.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {}
    }
    this.onChange(0);
  }
}

export function installHandleTracking(tracker: HandleTracker, g: any = globalThis): void {
  const {
    setTimeout: st,
    clearTimeout: ct,
    setInterval: si,
    clearInterval: ci,
    setImmediate: sim,
    clearImmediate: cim,
    fetch: f,
  } = g;

  g.setTimeout = Object.assign((fn: AnyFn, ms?: number, ...args: unknown[]) => {
    const id = st(
      (...a: unknown[]) => {
        tracker.remove(id);
        fn(...a);
      },
      ms,
      ...args,
    );
    tracker.add(id, () => ct(id));
    return id;
  }, st);
  g.clearTimeout = (id?: unknown) => {
    tracker.remove(id);
    ct(id);
  };

  g.setInterval = Object.assign((fn: AnyFn, ms?: number, ...args: unknown[]) => {
    const id = si(fn, ms, ...args);
    tracker.add(id, () => ci(id));
    return id;
  }, si);
  g.clearInterval = (id?: unknown) => {
    tracker.remove(id);
    ci(id);
  };

  g.setImmediate = Object.assign((fn: AnyFn, ...args: unknown[]) => {
    const id = sim(
      (...a: unknown[]) => {
        tracker.remove(id);
        fn(...a);
      },
      ...args,
    );
    tracker.add(id, () => cim(id));
    return id;
  }, sim);
  g.clearImmediate = (id?: unknown) => {
    tracker.remove(id);
    cim(id);
  };

  g.fetch = Object.assign((input: unknown, init?: RequestInit) => {
    const controller = new AbortController();
    const signal = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    const key = {};
    tracker.add(key, () => controller.abort());
    return f(input, { ...init, signal }).finally(() => tracker.remove(key));
  }, f);

  for (const name of ["node:http", "node:https", "node:net"]) {
    try {
      const mod = require(name);
      const original: AnyFn = mod.createServer;
      mod.createServer = (...args: unknown[]) => {
        const server = original(...args);
        server.on("listening", () => tracker.add(server, () => server.close()));
        server.on("close", () => tracker.remove(server));
        return server;
      };
    } catch {}
  }

  try {
    const cp = require("node:child_process");
    for (const method of ["spawn", "exec", "execFile", "fork"]) {
      const original: AnyFn = cp[method];
      cp[method] = (...args: unknown[]) => {
        const child = original(...args);
        tracker.add(child, () => child.kill());
        child.once("exit", () => tracker.remove(child));
        return child;
      };
    }
  } catch {}

  try {
    const serve: AnyFn = g.Bun.serve;
    Object.defineProperty(g.Bun, "serve", {
      configurable: true,
      writable: true,
      value: (options: unknown) => {
        const server = serve(options);
        const stop = server.stop.bind(server);
        tracker.add(server, () => stop(true));
        try {
          server.stop = (force?: boolean) => {
            tracker.remove(server);
            return stop(force);
          };
        } catch {}
        return server;
      },
    });
  } catch {}
}
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/runner-bun && bun test test/event-buffer.test.ts test/handles.test.ts`
Expected: `12 pass`, `0 fail`.

- [ ] **Step 6: Commit**

```bash
git add packages/runner-bun bun.lock
git commit -m "feat(runner-bun): batched event buffer with output cap and active handle tracking"
```

---

### Task 8: `@jslab/runner-bun` console hooks and child bootstrap

**Files:**
- Create: `packages/runner-bun/src/console-hook.ts`, `packages/runner-bun/src/bootstrap.ts`, `packages/runner-bun/src/index.ts`
- Test: `packages/runner-bun/test/bootstrap.test.ts`

**Interfaces:**
- Consumes:
  - `Encoder`, `HandleRegistry`, `DEFAULT_LIMITS`, `parseStack` from `@jslab/serializer`
  - `EventBuffer`, `HandleTracker`, `installHandleTracking` (Task 7)
  - `MainToRunner`, `RunnerToMain`, `RunnerState` from `@jslab/rpc-schema`
- Produces:
  - `bootstrap.ts`, the child-process entry script. Main spawns it as `bun --no-env-file <bootstrap>` with `ipc`.
  - `callSite(stack, entryBase)`, `installConsole(sink, target?)`, `installStdio(push)`.
- **Protocol:**
  - The runner sends `ready`, then `heartbeat` every `JSLAB_HEARTBEAT_MS` (default 500).
  - On `run`, it imports the entry and emits the states `evaluating` → `settled` (active handles) → `idle`.
  - `stop` disposes handles and emits `stopped`.
  - `expand` answers with `expanded`.
  - `dispose` exits the process.

**Design notes:**
- JSLab's own timers (event flushing, heartbeats, promise polling) are captured before handle tracking is installed, so they never count as user work.
- Pending promises are polled with `Bun.peek.status` instead of `then`. Attaching a handler would silently mark rejections as handled and hide `unhandledRejection` errors.

- [ ] **Step 1: Write the failing smoke tests**

These spawn the real bootstrap and drive it over IPC.

`packages/runner-bun/test/bootstrap.test.ts`:
```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawRunEvent, RunnerToMain } from "@jslab/rpc-schema";
import type { Subprocess } from "bun";

const BOOTSTRAP = join(import.meta.dir, "../src/bootstrap.ts");

let dir = "";
const procs: Subprocess[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-bootstrap-"));
});
afterEach(async () => {
  for (const proc of procs.splice(0)) proc.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true });
});

function startRunner() {
  const messages: RunnerToMain[] = [];
  const proc = Bun.spawn([process.execPath, "--no-env-file", BOOTSTRAP], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", JSLAB_HEARTBEAT_MS: "50" },
    stdout: "ignore",
    stderr: "inherit",
    ipc: (message) => messages.push(message as RunnerToMain),
    // Same wire format as production (Task 9), so values that don't survive JSON fail here.
    serialization: "json",
  });
  procs.push(proc);
  const until = async (predicate: (message: RunnerToMain) => boolean, timeoutMs = 5000) => {
    const started = Date.now();
    while (!messages.some(predicate)) {
      if (Date.now() - started > timeoutMs) throw new Error(`timed out; received ${JSON.stringify(messages)}`);
      await Bun.sleep(10);
    }
  };
  const events = (): RawRunEvent[] => messages.flatMap((m) => (m.type === "events" ? m.events : []));
  const run = async (source: string) => {
    const entry = join(dir, `entry-${crypto.randomUUID()}.mjs`);
    await Bun.write(entry, source);
    await until((m) => m.type === "ready");
    proc.send({ type: "run", runId: "run-1", entry, settings: { maxEntries: 100 } });
  };
  return { proc, messages, until, events, run };
}

test("reports ready with its Bun version and sends heartbeats", async () => {
  const runner = startRunner();
  await runner.until((m) => m.type === "heartbeat");
  expect(runner.messages.find((m) => m.type === "ready")).toMatchObject({ bunVersion: Bun.version });
});

test("runs an entry module and streams console output, results and state", async () => {
  const runner = startRunner();
  await runner.run('console.log("hi", 1);\n__jl.log(2, 40 + 2);\nexport {};\n');
  await runner.until((m) => m.type === "state" && m.state === "idle");
  const events = runner.events();
  expect(events.find((e) => e.kind === "console")).toMatchObject({
    level: "log",
    at: { line: 1 },
    args: [
      { t: "string", v: "hi" },
      { t: "number", v: "1" },
    ],
  });
  expect(events.find((e) => e.kind === "result")).toMatchObject({ line: 2, value: { t: "number", v: "42" } });
});

test("stop disposes active handles", async () => {
  const runner = startRunner();
  await runner.run("setInterval(() => {}, 10);\n");
  await runner.until((m) => m.type === "state" && m.state === "settled");
  runner.proc.send({ type: "stop" });
  await runner.until((m) => m.type === "state" && m.state === "stopped");
  expect(runner.messages.findLast((m) => m.type === "state")).toMatchObject({ state: "stopped", activeHandles: 0 });
});

test("answers expand requests for deep values", async () => {
  const runner = startRunner();
  await runner.run("__jl.log(1, { a: { b: { c: { d: 1 } } } });\n");
  await runner.until((m) => m.type === "state" && m.state === "idle");
  const handle = /"t":"handle","handle":"(h\d+)"/.exec(JSON.stringify(runner.events()))?.[1];
  expect(handle).toBeDefined();
  runner.proc.send({ type: "expand", reqId: 7, handleId: handle ?? "" });
  await runner.until((m) => m.type === "expanded");
  expect(runner.messages.find((m) => m.type === "expanded")).toMatchObject({
    reqId: 7,
    value: { t: "object", props: [[{ k: "d" }, { t: "number", v: "1" }]] },
  });
});

test("reports errors thrown while evaluating the module", async () => {
  const runner = startRunner();
  await runner.run('throw new TypeError("boom");\n');
  await runner.until((m) => m.type === "state" && m.state === "idle");
  expect(runner.events().find((e) => e.kind === "error")).toMatchObject({
    phase: "runtime",
    name: "TypeError",
    message: "boom",
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/runner-bun && bun test test/bootstrap.test.ts`
Expected: FAIL, with the spawned process erroring `Module not found` for `src/bootstrap.ts`, and the tests timing out waiting for `ready`.

- [ ] **Step 3: Implement the console and stdio hooks**

`packages/runner-bun/src/console-hook.ts`:
```ts
import type { ConsoleLevel, EncodedValue, GeneratedPosition, RawRunEventBody } from "@jslab/rpc-schema";
import { parseStack } from "@jslab/serializer";

export interface ConsoleSink {
  push(body: RawRunEventBody): number | null;
  encode(value: unknown): EncodedValue;
  entryBase(): string | null;
}

export function callSite(stack: string | undefined, entryBase: string | null): GeneratedPosition | undefined {
  if (!entryBase) return undefined;
  const frame = parseStack(stack ?? "").find((f) => f.file?.endsWith(entryBase));
  return frame?.line ? { line: frame.line, column: frame.column ?? 1 } : undefined;
}

export function installConsole(sink: ConsoleSink, target: Console = console): void {
  let depth = 0;
  const counts = new Map<string, number>();
  const timers = new Map<string, number>();

  const emit = (level: ConsoleLevel, args: unknown[], extra: { label?: string; withStack?: boolean } = {}) => {
    const stack = new Error().stack;
    sink.push({
      kind: "console",
      level,
      at: callSite(stack, sink.entryBase()),
      groupDepth: depth,
      args: args.map((a) => sink.encode(a)),
      ...(extra.label !== undefined ? { label: extra.label } : {}),
      ...(extra.withStack
        ? { stack: parseStack(stack ?? "").filter((f) => f.file?.endsWith(sink.entryBase() ?? "\0")) }
        : {}),
    });
  };

  const elapsed = (label: string, extra: unknown[], end: boolean) => {
    const start = timers.get(label);
    if (start === undefined) {
      emit("warn", [`Timer '${label}' does not exist`]);
      return;
    }
    if (end) timers.delete(label);
    emit("time", [`${label}: ${(performance.now() - start).toFixed(3)}ms`, ...extra], { label });
  };

  Object.assign(target, {
    log: (...a: unknown[]) => emit("log", a),
    info: (...a: unknown[]) => emit("info", a),
    warn: (...a: unknown[]) => emit("warn", a),
    error: (...a: unknown[]) => emit("error", a),
    debug: (...a: unknown[]) => emit("debug", a),
    dir: (value: unknown) => emit("dir", [value]),
    dirxml: (...a: unknown[]) => emit("log", a),
    table: (data: unknown) => emit("table", [data]),
    trace: (...a: unknown[]) => emit("trace", a.length > 0 ? a : ["Trace"], { withStack: true }),
    assert: (condition?: unknown, ...a: unknown[]) => {
      if (!condition) emit("assert", a.length > 0 ? a : ["Assertion failed"]);
    },
    count: (label = "default") => {
      const n = (counts.get(label) ?? 0) + 1;
      counts.set(label, n);
      emit("count", [`${label}: ${n}`], { label });
    },
    countReset: (label = "default") => {
      counts.delete(label);
    },
    time: (label = "default") => {
      timers.set(label, performance.now());
    },
    timeLog: (label = "default", ...a: unknown[]) => elapsed(label, a, false),
    timeEnd: (label = "default") => elapsed(label, [], true),
    group: (...a: unknown[]) => {
      emit("group", a);
      depth++;
    },
    groupCollapsed: (...a: unknown[]) => {
      emit("groupCollapsed", a);
      depth++;
    },
    groupEnd: () => {
      depth = Math.max(0, depth - 1);
    },
    clear: () => {
      sink.push({ kind: "console", level: "clear", groupDepth: 0, args: [] });
    },
  });
}

export function installStdio(push: (kind: "stdout" | "stderr", text: string) => void): void {
  for (const kind of ["stdout", "stderr"] as const) {
    const stream = process[kind];
    stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      push(kind, typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      const cb = typeof encoding === "function" ? encoding : callback;
      if (typeof cb === "function") cb();
      return true;
    }) as typeof stream.write;
  }
}
```

- [ ] **Step 4: Implement the bootstrap**

`packages/runner-bun/src/bootstrap.ts`:
```ts
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { types } from "node:util";
import type { MainToRunner, RunnerState, RunnerToMain } from "@jslab/rpc-schema";
import { DEFAULT_LIMITS, Encoder, HandleRegistry, parseStack } from "@jslab/serializer";
import { installConsole, installStdio } from "./console-hook";
import { EventBuffer } from "./event-buffer";
import { HandleTracker, installHandleTracking } from "./handles";

// Capture host timers before user-facing wrappers are installed; JSLab's own timers are never tracked.
const timers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
};
const heartbeatMs = Number(process.env.JSLAB_HEARTBEAT_MS ?? 500);
const send = (message: RunnerToMain) => process.send?.(message);
const hooks = {
  peekPromise: (promise: Promise<unknown>) => {
    const state = Bun.peek.status(promise);
    return state === "pending" ? { state } : { state, value: Bun.peek(promise) };
  },
  isProxy: (value: object) => types.isProxy(value),
};

interface Run {
  runId: string;
  entryBase: string;
  buffer: EventBuffer;
  encoder: Encoder;
  state: RunnerState;
}

let run: Run | null = null;
const registry = new HandleRegistry();

const tracker = new HandleTracker((count) => {
  if (!run) return;
  if (run.state === "settled" && count === 0) setState("idle");
  else if (run.state === "idle" && count > 0) setState("settled");
});
installHandleTracking(tracker);

function setState(state: RunnerState): void {
  if (!run) return;
  run.state = state;
  run.buffer.flush();
  send({ type: "state", runId: run.runId, state, activeHandles: tracker.count });
}

function pushError(phase: "runtime" | "unhandledRejection", error: unknown): void {
  if (!run) return;
  const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  run.buffer.push({
    kind: "error",
    phase,
    name: typeof e?.name === "string" ? e.name : "Error",
    message: typeof e?.message === "string" ? e.message : String(error),
    stack: parseStack(typeof e?.stack === "string" ? e.stack : ""),
    value: run.encoder.encode(error),
  });
}

/** Polls (never attaches handlers, so unhandled rejections still surface) and reports settlement. */
function watchPromise(value: unknown, ref: number | null): void {
  if (ref === null || !(value instanceof Promise) || Bun.peek.status(value) !== "pending") return;
  const current = run;
  let delay = 16;
  const poll = () => {
    if (!current || run !== current) return;
    if (Bun.peek.status(value) === "pending") {
      delay = Math.min(delay * 2, 500);
      timers.setTimeout(poll, delay);
      return;
    }
    current.buffer.push({ kind: "promiseSettled", ref, value: current.encoder.encode(value) });
  };
  timers.setTimeout(poll, delay);
}

Object.defineProperty(globalThis, "__jl", {
  enumerable: false,
  configurable: false,
  writable: false,
  value: {
    log(line: number, value: unknown) {
      if (run)
        watchPromise(
          value,
          run.buffer.push({ kind: "result", line, source: "autolog", value: run.encoder.encode(value) }),
        );
      return value;
    },
    mc(line: number, column: number, value: unknown, format?: ($: unknown) => unknown) {
      if (run) {
        let shown = value;
        if (format) {
          try {
            shown = format(value);
          } catch (error) {
            shown = error;
          }
        }
        watchPromise(
          shown,
          run.buffer.push({ kind: "result", line, column, source: "magic", value: run.encoder.encode(shown) }),
        );
      }
      return value;
    },
  },
});

installConsole({
  push: (body) => run?.buffer.push(body) ?? null,
  encode: (value) => (run ? run.encoder.encode(value) : { t: "undefined" }),
  entryBase: () => run?.entryBase ?? null,
});
installStdio((kind, text) => {
  run?.buffer.push({ kind, text });
});

process.on("uncaughtException", (error) => pushError("runtime", error));
process.on("unhandledRejection", (reason) => pushError("unhandledRejection", reason));

async function startRun(message: Extract<MainToRunner, { type: "run" }>): Promise<void> {
  if (run) return;
  const current: Run = {
    runId: message.runId,
    entryBase: basename(message.entry),
    buffer: new EventBuffer(
      (events) => send({ type: "events", runId: message.runId, events }),
      message.settings.maxEntries,
      timers,
    ),
    encoder: new Encoder(registry, DEFAULT_LIMITS, hooks),
    state: "evaluating",
  };
  run = current;
  setState("evaluating");
  try {
    await import(pathToFileURL(message.entry).href);
  } catch (error) {
    pushError("runtime", error);
  }
  if (current.state !== "evaluating") return;
  setState(tracker.count > 0 ? "settled" : "idle");
}

process.on("message", (message: MainToRunner) => {
  switch (message.type) {
    case "run":
      void startRun(message);
      return;
    case "stop":
      if (run) run.state = "stopped";
      tracker.disposeAll();
      setState("stopped");
      return;
    case "expand":
      send({ type: "expanded", reqId: message.reqId, value: run?.encoder.expand(message.handleId) ?? null });
      return;
    case "dispose":
      process.exit(0);
  }
});

timers.setInterval(() => send({ type: "heartbeat" }), heartbeatMs);
send({ type: "ready", bunVersion: Bun.version });
```

`packages/runner-bun/src/index.ts`:
```ts
export * from "./console-hook";
export * from "./event-buffer";
export * from "./handles";
```

- [ ] **Step 5: Run all runner tests and typecheck**

Run: `cd packages/runner-bun && bun test && bun run typecheck`
Expected: `17 pass`, `0 fail`, then typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/runner-bun
git commit -m "feat(runner-bun): child bootstrap with console hooks, results, stop and expand"
```

---

### Task 9: Run coordinator (spares, supersede, stop/kill, unresponsive, source mapping)

**Files:**
- Create: `apps/desktop/package.json`, `apps/desktop/tsconfig.json`
- Create: `apps/desktop/src/main/runs/bun-runner-process.ts`, `apps/desktop/src/main/runs/spare-pool.ts`, `apps/desktop/src/main/runs/event-mapper.ts`, `apps/desktop/src/main/runs/run-coordinator.ts`
- Test: `apps/desktop/test/runs/run-coordinator.test.ts`

**Interfaces:**
- Consumes:
  - `transform`, `TransformOptions`, `TransformResult`, `Diagnostic`, `Language`, `RawSourceMap` from `@jslab/transform`
  - `RawRunEvent`, `RunEvent`, `RunState`, `RunnerToMain`, `MainToRunner`, `EncodedValue`, `StackFrame` from `@jslab/rpc-schema`
  - `@jslab/runner-bun/bootstrap`, resolved with `Bun.resolveSync`
- Produces:
  - `type RunnerSpawnConfig { bunPath; bootstrapPath; cwd; env }`
  - `class BunRunnerProcess { static start(config, timeoutMs = 5000); pid; stderrTail; lastHeartbeat; bunVersion; exited; onMessage(listener): () => void; send(message); kill() }`
  - `class SparePool(startRunner, configFor) { prepare(tabId); take(tabId): Promise<BunRunnerProcess>; invalidate(tabId); dispose() }`
  - `createEventMapper(map, entryBase, logpointLines): (event: RawRunEvent) => RunEvent`
  - `type RunStartRequest { tabId; code; language; logpoints }`, `type RunnerSettings`
  - `type RunCoordinatorDeps { transform; spares; runsDir; settings(); onEvents; onState; onDiagnostics; runLock; watchdogIntervalMs?; stopGraceMs?; idleRunnerTtlMs?; expandTimeoutMs? }`
  - `class RunCoordinator(deps) { start(request): { runId }; stop(tabId); kill(tabId); wait(tabId); expand(tabId, runId, handleId): Promise<EncodedValue | null>; disposeTab(tabId); dispose() }`

**State flow (spec §5.7):**
- A run goes `transpiling` → `evaluating` → `settled` → `idle`.
- It ends in `failed` on a syntax error or runner crash, `stopping` → `stopped` on Stop, or `killed`.
- `unresponsive` is entered when heartbeats stop.
- Starting a new run supersedes the old one: its runner is killed, and its late events are ignored.

- [ ] **Step 1: Create the app package**

`apps/desktop/package.json` (Electrobun and Hutch config come in Task 13):
```json
{
  "name": "@jslab/desktop",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@jslab/rpc-schema": "workspace:*",
    "@jslab/runner-bun": "workspace:*",
    "@jslab/shared": "workspace:*",
    "@jslab/transform": "workspace:*",
    "source-map-js": "1.2.1"
  },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit -p ."
  }
}
```

`apps/desktop/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test"]
}
```

Run: `bun install`

- [ ] **Step 2: Write the failing integration tests**

These spawn real Bun runners, so each test has a 15 s timeout.

`apps/desktop/test/runs/run-coordinator.test.ts`:
```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, RunState } from "@jslab/rpc-schema";
import { transform } from "@jslab/transform";
import { BunRunnerProcess } from "../../src/main/runs/bun-runner-process";
import { RunCoordinator, type RunnerSettings } from "../../src/main/runs/run-coordinator";
import { SparePool } from "../../src/main/runs/spare-pool";

const BOOTSTRAP = Bun.resolveSync("@jslab/runner-bun/bootstrap", import.meta.dir);

interface Harness {
  coordinator: RunCoordinator;
  events: RunEvent[];
  states: { runId: string; state: RunState; activeHandles?: number }[];
  locks: Set<string>;
  settings: RunnerSettings;
  waitForState(state: RunState, runId?: string, timeoutMs?: number): Promise<void>;
  dir: string;
}

const harnesses: Harness[] = [];

async function createHarness(overrides: Partial<RunnerSettings> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "jslab-coord-"));
  const settings: RunnerSettings = {
    autoLog: true,
    loopProtection: true,
    loopProtectionMaxIterations: 2000,
    maxEntries: 10_000,
    unresponsiveTimeoutMs: 400,
    ...overrides,
  };
  const events: RunEvent[] = [];
  const states: Harness["states"] = [];
  const locks = new Set<string>();
  const spares = new SparePool(
    (config) => BunRunnerProcess.start(config),
    () => ({
      bunPath: process.execPath,
      bootstrapPath: BOOTSTRAP,
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", JSLAB_HEARTBEAT_MS: "50" },
    }),
  );
  const coordinator = new RunCoordinator({
    transform: async (source, options) => transform(source, options),
    spares,
    runsDir: join(dir, "runs"),
    settings: () => settings,
    onEvents: (_tab, _run, batch) => events.push(...batch),
    onState: (_tab, runId, state, activeHandles) => states.push({ runId, state, activeHandles }),
    onDiagnostics: () => {},
    runLock: { add: (id) => locks.add(id), remove: (id) => locks.delete(id) },
    watchdogIntervalMs: 50,
    stopGraceMs: 300,
  });
  const waitForState = async (state: RunState, runId?: string, timeoutMs = 8000) => {
    const started = Date.now();
    while (!states.some((s) => s.state === state && (!runId || s.runId === runId))) {
      if (Date.now() - started > timeoutMs)
        throw new Error(`timed out waiting for ${state}; saw ${JSON.stringify(states)}`);
      await Bun.sleep(10);
    }
  };
  const harness = { coordinator, events, states, locks, settings, waitForState, dir };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.coordinator.dispose();
    await rm(h.dir, { recursive: true, force: true });
  }
});

const flush = () => Bun.sleep(60);

describe("RunCoordinator", () => {
  test("runs TypeScript and reports results and console output on original lines", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "const a: number = 2;\nconsole.log('hi', a)\na * 21",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    const console_ = h.events.find((e) => e.kind === "console");
    expect(console_).toMatchObject({
      level: "log",
      line: 2,
      args: [
        { t: "string", v: "hi" },
        { t: "number", v: "2" },
      ],
    });
    expect(h.events.find((e) => e.kind === "result")).toMatchObject({
      line: 3,
      source: "autolog",
      value: { t: "number", v: "42" },
    });
  }, 15_000);

  test("reports syntax errors without starting a runner", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({ tabId: "t1", code: "const x = ;", language: "typescript", logpoints: [] });
    await h.waitForState("failed", runId);
    expect(h.events[0]).toMatchObject({ kind: "error", phase: "transpile", line: 1, column: 11 });
  }, 15_000);

  test("maps runtime errors to the original line", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "type T = { a: number };\n\nthrow new Error('boom')",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events.find((e) => e.kind === "error")).toMatchObject({ phase: "runtime", message: "boom", line: 3 });
  }, 15_000);

  test("supersedes a running run and kills its runner", async () => {
    const h = await createHarness();
    const first = h.coordinator.start({
      tabId: "t1",
      code: "await new Promise((r) => setTimeout(r, 10_000))",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("evaluating", first.runId);
    const second = h.coordinator.start({ tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [] });
    await h.waitForState("idle", second.runId);
    expect(h.states.filter((s) => s.runId === first.runId).map((s) => s.state)).toEqual(["transpiling", "evaluating"]);
    expect(h.locks.size).toBe(0);
  }, 15_000);

  test("stops async work gracefully", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "setInterval(() => {}, 10)",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("settled", runId);
    expect(h.states.find((s) => s.state === "settled")?.activeHandles).toBe(1);
    h.coordinator.stop("t1");
    await h.waitForState("stopped", runId);
    expect(h.states.some((s) => s.state === "killed")).toBe(false);
  }, 15_000);

  test("detects an unresponsive run and escalates stop to kill", async () => {
    const h = await createHarness({ loopProtection: false });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "while (true) {}",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("unresponsive", runId);
    h.coordinator.stop("t1");
    await h.waitForState("killed", runId);
  }, 15_000);

  test("enforces the output cap in the runner", async () => {
    const h = await createHarness({ maxEntries: 10 });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "for (let i = 0; i < 50; i++) console.log(i)",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events.filter((e) => e.kind === "console")).toHaveLength(10);
    expect(h.events.filter((e) => e.kind === "truncated").at(-1)).toMatchObject({ dropped: 40 });
  }, 15_000);

  test("expands deep values while the runner is alive", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "({ a: { b: { c: { d: 1 } } } })",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    const json = JSON.stringify(h.events.find((e) => e.kind === "result"));
    const handle = /"t":"handle","handle":"(h\d+)"/.exec(json)?.[1];
    expect(handle).toBeDefined();
    expect(await h.coordinator.expand("t1", runId, handle ?? "")).toMatchObject({
      t: "object",
      props: [[{ k: "d" }, { t: "number", v: "1" }]],
    });
  }, 15_000);

  test("reports a runner that exits unexpectedly", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "process.exit(3)",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("failed", runId);
    expect(h.events.at(-1)).toMatchObject({ kind: "error", phase: "runner" });
    expect((h.events.at(-1) as { message: string }).message).toContain("code 3");
  }, 15_000);

  test("updates promise results when they settle", async () => {
    const h = await createHarness();
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "new Promise((r) => setTimeout(() => r(7), 30))",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await Bun.sleep(150);
    expect(h.events.find((e) => e.kind === "result")).toMatchObject({ value: { t: "promise", state: "pending" } });
    expect(h.events.find((e) => e.kind === "promiseSettled")).toMatchObject({
      value: { t: "promise", state: "fulfilled", value: { t: "number", v: "7" } },
    });
  }, 15_000);

  test("surfaces unhandled rejections", async () => {
    const h = await createHarness({ autoLog: false });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "Promise.reject(new Error('nope'))",
      language: "typescript",
      logpoints: [],
    });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events.find((e) => e.kind === "error")).toMatchObject({ phase: "unhandledRejection", message: "nope" });
  }, 15_000);

  test("labels logpoint results and captures stdout writes", async () => {
    const h = await createHarness({ autoLog: false });
    const { runId } = h.coordinator.start({
      tabId: "t1",
      code: "const a = 5;\nprocess.stdout.write('raw\\n');",
      language: "typescript",
      logpoints: [1],
    });
    await h.waitForState("idle", runId);
    await flush();
    expect(h.events.find((e) => e.kind === "result")).toMatchObject({ source: "logpoint", line: 1, value: { v: "5" } });
    expect(h.events.find((e) => e.kind === "stdout")).toMatchObject({ text: "raw\n" });
  }, 15_000);
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd apps/desktop && bun test test/runs`
Expected: FAIL, `Cannot find module "../../src/main/runs/bun-runner-process"`.

- [ ] **Step 4: Implement the runner process wrapper**

`apps/desktop/src/main/runs/bun-runner-process.ts`:
```ts
import type { MainToRunner, RunnerToMain } from "@jslab/rpc-schema";
import type { Subprocess } from "bun";

export interface RunnerSpawnConfig {
  bunPath: string;
  bootstrapPath: string;
  cwd: string;
  env: Record<string, string>;
}

const STDERR_TAIL_BYTES = 4096;

export class BunRunnerProcess {
  readonly #listeners = new Set<(message: RunnerToMain) => void>();
  readonly #proc: Subprocess;
  #stderrTail = "";
  lastHeartbeat = Date.now();
  bunVersion = "";
  readonly exited: Promise<number | null>;

  private constructor(proc: Subprocess) {
    this.#proc = proc;
    this.exited = proc.exited.then(() => proc.exitCode);
    void this.#collectStderr(proc.stderr as ReadableStream<Uint8Array>);
  }

  static start(config: RunnerSpawnConfig, timeoutMs = 5000): Promise<BunRunnerProcess> {
    return new Promise((resolve, reject) => {
      let runner: BunRunnerProcess | null = null;
      const proc = Bun.spawn([config.bunPath, "--no-env-file", config.bootstrapPath], {
        cwd: config.cwd,
        env: config.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        ipc: (message) => {
          if (runner) runner.#dispatch(message as RunnerToMain);
        },
        // M0-S3: the default "advanced" IPC serializer breaks across Bun versions. Values survive JSON because the
        // serializer sends NaN, ±Infinity, -0 and bigints as strings, typed-array items included (Task 4).
        serialization: "json",
      });
      runner = new BunRunnerProcess(proc);
      const started = runner;
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        reject(new Error(`Runner did not start within ${timeoutMs}ms`));
      }, timeoutMs);
      const off = started.onMessage((message) => {
        if (message.type !== "ready") return;
        clearTimeout(timer);
        off();
        started.bunVersion = message.bunVersion;
        resolve(started);
      });
      void started.exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`Runner exited during startup (code ${code}). ${started.stderrTail}`.trim()));
      });
    });
  }

  get pid(): number {
    return this.#proc.pid;
  }

  get stderrTail(): string {
    return this.#stderrTail;
  }

  onMessage(listener: (message: RunnerToMain) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(message: MainToRunner): void {
    try {
      this.#proc.send(message);
    } catch {
      // The process already exited; exit handling reports it.
    }
  }

  kill(): void {
    this.#proc.kill("SIGKILL");
  }

  #dispatch(message: RunnerToMain): void {
    if (message.type === "heartbeat") this.lastHeartbeat = Date.now();
    for (const listener of this.#listeners) listener(message);
  }

  async #collectStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_BYTES);
    }
  }
}
```

- [ ] **Step 5: Implement the spare pool**

`apps/desktop/src/main/runs/spare-pool.ts`:
```ts
import type { BunRunnerProcess, RunnerSpawnConfig } from "./bun-runner-process";

interface Spare {
  key: string;
  promise: Promise<BunRunnerProcess>;
}

const START_ATTEMPTS = 3;

/** Keeps one pre-started runner per tab, keyed by the spawn configuration it was started with. */
export class SparePool {
  readonly #spares = new Map<string, Spare>();

  constructor(
    private readonly startRunner: (config: RunnerSpawnConfig) => Promise<BunRunnerProcess>,
    private readonly configFor: (tabId: string) => RunnerSpawnConfig,
  ) {}

  prepare(tabId: string): void {
    const config = this.configFor(tabId);
    const key = String(Bun.hash(JSON.stringify([config.bunPath, config.bootstrapPath, config.cwd, config.env])));
    const existing = this.#spares.get(tabId);
    if (existing?.key === key) return;
    if (existing) this.#discard(existing);
    const promise = this.startRunner(config);
    promise.catch(() => {
      if (this.#spares.get(tabId)?.promise === promise) this.#spares.delete(tabId);
    });
    this.#spares.set(tabId, { key, promise });
  }

  async take(tabId: string): Promise<BunRunnerProcess> {
    let lastError: unknown;
    for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
      this.prepare(tabId);
      const spare = this.#spares.get(tabId);
      this.#spares.delete(tabId);
      if (!spare) continue;
      try {
        const runner = await spare.promise;
        this.prepare(tabId);
        return runner;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Runtime unavailable");
  }

  invalidate(tabId: string): void {
    const existing = this.#spares.get(tabId);
    if (existing) this.#discard(existing);
    this.#spares.delete(tabId);
  }

  dispose(): void {
    for (const tabId of [...this.#spares.keys()]) this.invalidate(tabId);
  }

  #discard(spare: Spare): void {
    spare.promise.then(
      (runner) => runner.kill(),
      () => {},
    );
  }
}
```

- [ ] **Step 6: Implement the event mapper**

`apps/desktop/src/main/runs/event-mapper.ts`:
```ts
import type { RawRunEvent, RunEvent, StackFrame } from "@jslab/rpc-schema";
import type { RawSourceMap } from "@jslab/transform";
import { SourceMapConsumer } from "source-map-js";

/** Maps runner events (generated positions) back to the user's original source lines. */
export function createEventMapper(map: RawSourceMap, entryBase: string, logpointLines: ReadonlySet<number>) {
  const consumer = new SourceMapConsumer(map as never);

  const original = (line: number, column: number) => {
    const pos = consumer.originalPositionFor({ line, column: Math.max(0, column - 1) });
    return pos.line == null ? null : { line: pos.line, column: (pos.column ?? 0) + 1 };
  };

  const mapFrames = (frames: StackFrame[]): StackFrame[] =>
    frames.map((frame) => {
      if (!frame.file?.endsWith(entryBase) || frame.line == null) return frame;
      const pos = original(frame.line, frame.column ?? 1);
      const { file: _file, ...rest } = frame;
      return pos ? { ...rest, line: pos.line, column: pos.column, user: true } : { ...rest, user: true };
    });

  return (event: RawRunEvent): RunEvent => {
    switch (event.kind) {
      case "result":
        return event.source === "magic" && logpointLines.has(event.line) ? { ...event, source: "logpoint" } : event;
      case "console": {
        const { at, stack, ...rest } = event;
        const pos = at ? original(at.line, at.column) : null;
        return { ...rest, ...(pos ? { line: pos.line } : {}), ...(stack ? { stack: mapFrames(stack) } : {}) };
      }
      case "error": {
        const stack = mapFrames(event.stack);
        const top = stack.find((frame) => frame.user && frame.line != null);
        return { ...event, stack, ...(top ? { line: top.line, column: top.column } : {}) };
      }
      default:
        return event;
    }
  };
}
```

- [ ] **Step 7: Implement the coordinator**

`apps/desktop/src/main/runs/run-coordinator.ts`:
```ts
import { mkdir, readdir, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { EncodedValue, RunEvent, RunnerToMain, RunState } from "@jslab/rpc-schema";
import type { Diagnostic, Language, TransformOptions, TransformResult } from "@jslab/transform";
import type { BunRunnerProcess } from "./bun-runner-process";
import { createEventMapper } from "./event-mapper";

export interface RunStartRequest {
  tabId: string;
  code: string;
  language: Language;
  logpoints: number[];
}

export interface RunnerSettings {
  autoLog: boolean;
  loopProtection: boolean;
  loopProtectionMaxIterations: number;
  maxEntries: number;
  unresponsiveTimeoutMs: number;
}

export interface RunCoordinatorDeps {
  transform(source: string, options: TransformOptions): Promise<TransformResult>;
  spares: { take(tabId: string): Promise<BunRunnerProcess>; invalidate(tabId: string): void; dispose(): void };
  runsDir: string;
  settings(): RunnerSettings;
  onEvents(tabId: string, runId: string, events: RunEvent[]): void;
  onState(tabId: string, runId: string, state: RunState, activeHandles?: number): void;
  onDiagnostics(tabId: string, runId: string, diagnostics: Diagnostic[]): void;
  runLock: { add(runId: string): void; remove(runId: string): void };
  watchdogIntervalMs?: number;
  stopGraceMs?: number;
  idleRunnerTtlMs?: number;
  expandTimeoutMs?: number;
}

interface ActiveRun {
  runId: string;
  tabId: string;
  state: RunState;
  runner: BunRunnerProcess | null;
  cancelled: boolean;
  expectedExit: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  unsubscribe?: () => void;
}

const LIVE_STATES: ReadonlySet<RunState> = new Set(["evaluating", "settled", "unresponsive"]);

export class RunCoordinator {
  readonly #runs = new Map<string, ActiveRun>();
  readonly #pendingExpands = new Map<number, (value: EncodedValue | null) => void>();
  readonly #watchdog: ReturnType<typeof setInterval>;
  #nextReqId = 1;

  constructor(private readonly deps: RunCoordinatorDeps) {
    this.#watchdog = setInterval(() => this.#checkHeartbeats(), deps.watchdogIntervalMs ?? 500);
  }

  start(request: RunStartRequest): { runId: string } {
    this.#supersede(request.tabId);
    const run: ActiveRun = {
      runId: crypto.randomUUID(),
      tabId: request.tabId,
      state: "transpiling",
      runner: null,
      cancelled: false,
      expectedExit: false,
    };
    this.#runs.set(request.tabId, run);
    this.#setState(run, "transpiling");
    void this.#execute(run, request);
    return { runId: run.runId };
  }

  stop(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run) return;
    if (run.state === "transpiling") {
      run.cancelled = true;
      this.#setState(run, "stopped");
      return;
    }
    if (!run.runner || !LIVE_STATES.has(run.state)) return;
    this.#setState(run, "stopping");
    run.runner.send({ type: "stop" });
    run.stopTimer = setTimeout(() => this.kill(tabId), this.deps.stopGraceMs ?? 500);
  }

  kill(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run?.runner) return;
    clearTimeout(run.stopTimer);
    run.expectedExit = true;
    run.runner.kill();
    this.deps.runLock.remove(run.runId);
    this.#setState(run, "killed");
  }

  /** The user chose "Wait" in the unresponsive dialog. */
  wait(tabId: string): void {
    const run = this.#runs.get(tabId);
    if (!run?.runner || run.state !== "unresponsive") return;
    run.runner.lastHeartbeat = Date.now();
    this.#setState(run, "evaluating");
  }

  expand(tabId: string, runId: string, handleId: string): Promise<EncodedValue | null> {
    const run = this.#runs.get(tabId);
    if (!run?.runner || run.runId !== runId || run.state === "killed") return Promise.resolve(null);
    const reqId = this.#nextReqId++;
    const runner = run.runner;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingExpands.delete(reqId);
        resolve(null);
      }, this.deps.expandTimeoutMs ?? 5000);
      this.#pendingExpands.set(reqId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      runner.send({ type: "expand", reqId, handleId });
    });
  }

  disposeTab(tabId: string): void {
    this.#supersede(tabId);
    this.#runs.delete(tabId);
    this.deps.spares.invalidate(tabId);
  }

  dispose(): void {
    clearInterval(this.#watchdog);
    for (const tabId of [...this.#runs.keys()]) this.disposeTab(tabId);
    this.deps.spares.dispose();
  }

  async #execute(run: ActiveRun, request: RunStartRequest): Promise<void> {
    const settings = this.deps.settings();
    const result = await this.deps.transform(request.code, {
      language: request.language,
      autoLog: settings.autoLog,
      loopProtection: settings.loopProtection,
      loopProtectionMaxIterations: settings.loopProtectionMaxIterations,
      logpoints: request.logpoints,
    });
    if (!this.#isCurrent(run)) return;
    this.deps.onDiagnostics(run.tabId, run.runId, result.diagnostics);

    if (!result.ok) {
      const d = result.diagnostics[0];
      this.deps.onEvents(run.tabId, run.runId, [
        {
          kind: "error",
          phase: "transpile",
          name: "SyntaxError",
          message: d?.message ?? "Unable to compile",
          line: d?.line,
          column: d?.column,
          ...(d?.codeFrame ? { codeFrame: d.codeFrame } : {}),
          stack: [],
          seq: 1,
          t: Date.now(),
        },
      ]);
      this.#setState(run, "failed");
      return;
    }

    const dir = join(this.deps.runsDir, run.tabId);
    await mkdir(dir, { recursive: true });
    const entryPath = join(dir, `entry-${run.runId}.mjs`);
    await Bun.write(entryPath, result.code);
    void this.#cleanupEntries(dir, basename(entryPath));

    let runner: BunRunnerProcess;
    try {
      runner = await this.deps.spares.take(run.tabId);
    } catch (error) {
      if (!this.#isCurrent(run)) return;
      this.#runnerError(run, `Runtime unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!this.#isCurrent(run)) {
      runner.kill();
      return;
    }

    run.runner = runner;
    const mapper = createEventMapper(result.map, basename(entryPath), new Set(request.logpoints));
    run.unsubscribe = runner.onMessage((message) => this.#onRunnerMessage(run, message, mapper));
    void runner.exited.then((code) => this.#onRunnerExit(run, code));
    this.deps.runLock.add(run.runId);
    runner.lastHeartbeat = Date.now();
    runner.send({ type: "run", runId: run.runId, entry: entryPath, settings: { maxEntries: settings.maxEntries } });
  }

  #onRunnerMessage(run: ActiveRun, message: RunnerToMain, mapper: ReturnType<typeof createEventMapper>): void {
    if (message.type === "expanded") {
      this.#pendingExpands.get(message.reqId)?.(message.value);
      this.#pendingExpands.delete(message.reqId);
      return;
    }
    if (!this.#isCurrent(run)) return;
    switch (message.type) {
      case "heartbeat":
        if (run.state === "unresponsive") this.#setState(run, "evaluating");
        return;
      case "events":
        this.deps.onEvents(run.tabId, run.runId, message.events.map(mapper));
        return;
      case "state":
        if (message.state === "stopped") clearTimeout(run.stopTimer);
        if (message.state !== "evaluating") this.deps.runLock.remove(run.runId);
        if (run.state === "stopping" && message.state !== "stopped") return;
        this.#setState(run, message.state, message.activeHandles);
        if (message.state === "idle" || message.state === "stopped") this.#scheduleIdleExpiry(run);
        else clearTimeout(run.idleTimer);
        return;
    }
  }

  #onRunnerExit(run: ActiveRun, code: number | null): void {
    clearTimeout(run.stopTimer);
    clearTimeout(run.idleTimer);
    run.unsubscribe?.();
    this.deps.runLock.remove(run.runId);
    if (run.expectedExit || !this.#isCurrent(run)) return;
    this.#runnerError(
      run,
      `Runtime exited unexpectedly (code ${code ?? "unknown"}). ${run.runner?.stderrTail ?? ""}`.trim(),
    );
  }

  #runnerError(run: ActiveRun, message: string): void {
    this.deps.onEvents(run.tabId, run.runId, [
      {
        kind: "error",
        phase: "runner",
        name: "RuntimeError",
        message,
        stack: [],
        seq: Number.MAX_SAFE_INTEGER,
        t: Date.now(),
      },
    ]);
    this.#setState(run, "failed");
  }

  #scheduleIdleExpiry(run: ActiveRun): void {
    clearTimeout(run.idleTimer);
    run.idleTimer = setTimeout(
      () => {
        if (!run.runner) return;
        run.expectedExit = true;
        run.runner.kill();
      },
      this.deps.idleRunnerTtlMs ?? 5 * 60_000,
    );
  }

  #checkHeartbeats(): void {
    const timeout = this.deps.settings().unresponsiveTimeoutMs;
    const now = Date.now();
    for (const run of this.#runs.values()) {
      if (!run.runner || (run.state !== "evaluating" && run.state !== "settled")) continue;
      if (now - run.runner.lastHeartbeat > timeout) this.#setState(run, "unresponsive");
    }
  }

  #supersede(tabId: string): void {
    const previous = this.#runs.get(tabId);
    if (!previous) return;
    previous.cancelled = true;
    previous.expectedExit = true;
    clearTimeout(previous.stopTimer);
    clearTimeout(previous.idleTimer);
    previous.unsubscribe?.();
    previous.runner?.kill();
    this.deps.runLock.remove(previous.runId);
  }

  #isCurrent(run: ActiveRun): boolean {
    return !run.cancelled && this.#runs.get(run.tabId) === run;
  }

  #setState(run: ActiveRun, state: RunState, activeHandles?: number): void {
    run.state = state;
    this.deps.onState(run.tabId, run.runId, state, activeHandles);
  }

  async #cleanupEntries(dir: string, keep: string): Promise<void> {
    try {
      for (const name of await readdir(dir)) {
        if (name !== keep && name.startsWith("entry-")) await unlink(join(dir, name)).catch(() => {});
      }
    } catch {}
  }
}
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `cd apps/desktop && bun test test/runs && bun run typecheck`
Expected: `12 pass`, `0 fail`, then typecheck exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop bun.lock
git commit -m "feat(desktop): run coordinator with warm spares, supersede, stop/kill and source-mapped events"
```

---

### Task 10: Transform host (Worker, in-process fallback, LRU cache)

**Files:**
- Create: `apps/desktop/src/main/transform/transform-host.ts`, `apps/desktop/src/main/transform/transform-worker.ts`
- Test: `apps/desktop/test/transform/transform-host.test.ts`

**Interfaces:**
- Consumes: `transform`, `TransformOptions`, `TransformResult` from `@jslab/transform`.
- Produces:
  - `interface TransformHost { transform(source, options): Promise<TransformResult>; dispose(): void }`
  - `class WorkerTransformHost(workerUrl?)`: Babel runs off Main's JS thread, and the worker is recreated if it crashes.
  - `class InProcessTransformHost`: the same interface without a worker. Use it only if M0-S1 recorded that Bun Workers don't work in the packaged app.
  - `class CachingTransformHost(inner, maxEntries = 50)`: an LRU cache keyed by the source and options (spec §5.4).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/transform/transform-host.test.ts`:
```ts
import { afterEach, expect, test } from "bun:test";
import { type TransformOptions, type TransformResult, transform } from "@jslab/transform";
import { CachingTransformHost, type TransformHost, WorkerTransformHost } from "../../src/main/transform/transform-host";

const options: TransformOptions = {
  language: "typescript",
  autoLog: true,
  loopProtection: true,
  loopProtectionMaxIterations: 2000,
  logpoints: [],
};

const hosts: TransformHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

test("the worker host produces the same result as a direct transform", async () => {
  const host = new WorkerTransformHost();
  hosts.push(host);
  const source = "const a: number = 1;\na + 1";
  expect(await host.transform(source, options)).toEqual(transform(source, options));
});

test("concurrent worker requests resolve to their own results", async () => {
  const host = new WorkerTransformHost();
  hosts.push(host);
  const results = await Promise.all(["1", "2", "3"].map((n) => host.transform(`${n} + 0`, options)));
  expect(results.map((r) => (r.ok ? r.code.match(/__jl\.log\(1, (\d)/)?.[1] : null))).toEqual(["1", "2", "3"]);
});

test("dispose rejects pending requests", async () => {
  const host = new WorkerTransformHost();
  const pending = host.transform("1", options);
  host.dispose();
  await expect(pending).rejects.toThrow("disposed");
});

function countingHost() {
  let calls = 0;
  const inner: TransformHost = {
    transform: async (source, opts): Promise<TransformResult> => {
      calls++;
      return transform(source, opts);
    },
    dispose: () => {},
  };
  return { inner, calls: () => calls };
}

test("the caching host reuses results for identical input", async () => {
  const { inner, calls } = countingHost();
  const host = new CachingTransformHost(inner);
  await host.transform("1", options);
  await host.transform("1", options);
  await host.transform("1", { ...options, autoLog: false });
  expect(calls()).toBe(2);
});

test("the caching host evicts the least recently used entry", async () => {
  const { inner, calls } = countingHost();
  const host = new CachingTransformHost(inner, 2);
  await host.transform("1", options);
  await host.transform("2", options);
  await host.transform("1", options);
  await host.transform("3", options);
  await host.transform("1", options);
  expect(calls()).toBe(3);
  await host.transform("2", options);
  expect(calls()).toBe(4);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test test/transform`
Expected: FAIL, `Cannot find module "../../src/main/transform/transform-host"`.

- [ ] **Step 3: Implement the worker script**

`apps/desktop/src/main/transform/transform-worker.ts`:
```ts
import { type TransformOptions, transform } from "@jslab/transform";

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ id: number; source: string; options: TransformOptions }>) => {
  const { id, source, options } = event.data;
  try {
    self.postMessage({ id, result: transform(source, options) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
```

- [ ] **Step 4: Implement the hosts**

`apps/desktop/src/main/transform/transform-host.ts`:
```ts
import { type TransformOptions, type TransformResult, transform } from "@jslab/transform";

export interface TransformHost {
  transform(source: string, options: TransformOptions): Promise<TransformResult>;
  dispose(): void;
}

type WorkerReply = { id: number; result: TransformResult } | { id: number; error: string };

/** Runs Babel off the main thread (spec §4.1). Recreates the worker if it crashes. */
export class WorkerTransformHost implements TransformHost {
  #worker: Worker;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve(result: TransformResult): void; reject(error: Error): void }>();

  constructor(private readonly workerUrl: string = new URL("./transform-worker.ts", import.meta.url).href) {
    this.#worker = this.#spawn();
  }

  transform(source: string, options: TransformOptions): Promise<TransformResult> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, source, options });
    });
  }

  dispose(): void {
    this.#worker.terminate();
    this.#rejectAll(new Error("Transform host disposed"));
  }

  #spawn(): Worker {
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const pending = this.#pending.get(event.data.id);
      if (!pending) return;
      this.#pending.delete(event.data.id);
      if ("error" in event.data) pending.reject(new Error(event.data.error));
      else pending.resolve(event.data.result);
    };
    worker.onerror = (event) => {
      this.#rejectAll(new Error(`Transform worker crashed: ${event.message}`));
      worker.terminate();
      this.#worker = this.#spawn();
    };
    return worker;
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/** Same interface without a worker; used where Workers are unavailable (see M0-S1). */
export class InProcessTransformHost implements TransformHost {
  async transform(source: string, options: TransformOptions): Promise<TransformResult> {
    return transform(source, options);
  }

  dispose(): void {}
}

/** LRU cache in front of another host (spec §5.4: 50 entries). */
export class CachingTransformHost implements TransformHost {
  readonly #cache = new Map<string, Promise<TransformResult>>();

  constructor(
    private readonly inner: TransformHost,
    private readonly maxEntries = 50,
  ) {}

  transform(source: string, options: TransformOptions): Promise<TransformResult> {
    const key = String(Bun.hash(JSON.stringify([source, options])));
    const cached = this.#cache.get(key);
    if (cached) {
      this.#cache.delete(key);
      this.#cache.set(key, cached);
      return cached;
    }
    const result = this.inner.transform(source, options);
    result.catch(() => this.#cache.delete(key));
    this.#cache.set(key, result);
    if (this.#cache.size > this.maxEntries) this.#cache.delete(this.#cache.keys().next().value as string);
    return result;
  }

  dispose(): void {
    this.#cache.clear();
    this.inner.dispose();
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/desktop && bun test test/transform`
Expected: `5 pass`, `0 fail`.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/main/transform apps/desktop/test/transform
git commit -m "feat(desktop): worker transform host with LRU cache"
```

---

### Task 11: Persistence primitives (atomic writes, JSON recovery, debounced writer, run lock)

**Files:**
- Create: `apps/desktop/src/main/persistence/atomic-write.ts`, `apps/desktop/src/main/persistence/json-store.ts`, `apps/desktop/src/main/persistence/run-lock.ts`
- Test: `apps/desktop/test/persistence/persistence.test.ts`

**Interfaces:**
- Produces:
  - `writeFileAtomic(path, data, { backup?, mode? }): Promise<void>`: writes a temp file, fsyncs and renames it. With `backup`, it first copies the old file to `<path>.bak`.
  - `type Recovery = "none" | "backup" | "defaults"`, `interface Parser<T> { parse(input): T }`, which any zod schema satisfies.
  - `loadJson(path, parser, fallback): Promise<{ value; recovered }>`: tries the primary file, then `.bak`, then defaults. It keeps a corrupt primary as `<name>.corrupt-<ts>.json`.
  - `interface DebouncedWriter { schedule(data); flush(): Promise<void> }`, `createDebouncedWriter(write, delayMs = 500)`.
  - `class RunLock(path) { uncleanPreviousExit; add(runId); remove(runId); releaseAll() }` (spec §5.14).

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/persistence/persistence.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../src/main/persistence/atomic-write";
import { createDebouncedWriter, loadJson } from "../../src/main/persistence/json-store";
import { RunLock } from "../../src/main/persistence/run-lock";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-persist-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const numberDoc = {
  parse(input: unknown) {
    if (typeof (input as { n?: unknown })?.n !== "number") throw new Error("invalid");
    return input as { n: number };
  },
};

describe("writeFileAtomic", () => {
  test("creates parent folders, writes content and leaves no temp files", async () => {
    const path = join(dir, "nested", "a.json");
    await writeFileAtomic(path, '{"n":1}');
    expect(await readFile(path, "utf8")).toBe('{"n":1}');
    expect(await readdir(join(dir, "nested"))).toEqual(["a.json"]);
  });

  test("keeps the previous version as .bak when asked", async () => {
    const path = join(dir, "a.json");
    await writeFileAtomic(path, "one");
    await writeFileAtomic(path, "two", { backup: true });
    expect(await readFile(`${path}.bak`, "utf8")).toBe("one");
    expect(await readFile(path, "utf8")).toBe("two");
  });

  test("applies the requested file mode", async () => {
    const path = join(dir, "env.json");
    await writeFileAtomic(path, "{}", { mode: 0o600 });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("loadJson", () => {
  test("returns defaults without recovery when nothing exists yet", async () => {
    expect(await loadJson(join(dir, "s.json"), numberDoc, () => ({ n: 0 }))).toEqual({
      value: { n: 0 },
      recovered: "none",
    });
  });

  test("loads a valid file", async () => {
    await writeFile(join(dir, "s.json"), '{"n":5}');
    expect(await loadJson(join(dir, "s.json"), numberDoc, () => ({ n: 0 }))).toEqual({
      value: { n: 5 },
      recovered: "none",
    });
  });

  test("falls back to the backup and preserves the corrupt file", async () => {
    await writeFile(join(dir, "s.json"), "{not json");
    await writeFile(join(dir, "s.json.bak"), '{"n":3}');
    expect(await loadJson(join(dir, "s.json"), numberDoc, () => ({ n: 0 }))).toEqual({
      value: { n: 3 },
      recovered: "backup",
    });
    expect((await readdir(dir)).some((name) => name.startsWith("s.corrupt-"))).toBe(true);
  });

  test("uses defaults when both files are invalid", async () => {
    await writeFile(join(dir, "s.json"), '{"n":"x"}');
    expect(await loadJson(join(dir, "s.json"), numberDoc, () => ({ n: 0 }))).toEqual({
      value: { n: 0 },
      recovered: "defaults",
    });
  });
});

describe("createDebouncedWriter", () => {
  test("coalesces scheduled writes into the last value", async () => {
    const writes: string[] = [];
    const writer = createDebouncedWriter(async (data) => void writes.push(data), 20);
    writer.schedule("a");
    writer.schedule("b");
    await Bun.sleep(50);
    expect(writes).toEqual(["b"]);
  });

  test("flush writes immediately and is safe with nothing pending", async () => {
    const writes: string[] = [];
    const writer = createDebouncedWriter(async (data) => void writes.push(data), 10_000);
    writer.schedule("a");
    await writer.flush();
    await writer.flush();
    expect(writes).toEqual(["a"]);
  });
});

describe("RunLock", () => {
  test("creates the lock for the first run and removes it after the last", () => {
    const path = join(dir, "run.lock");
    const lock = new RunLock(path);
    expect(lock.uncleanPreviousExit).toBe(false);
    lock.add("r1");
    lock.add("r2");
    expect(existsSync(path)).toBe(true);
    lock.remove("r1");
    expect(existsSync(path)).toBe(true);
    lock.remove("r2");
    expect(existsSync(path)).toBe(false);
  });

  test("detects and clears a lock left by a previous session", async () => {
    const path = join(dir, "run.lock");
    await writeFile(path, "123");
    const lock = new RunLock(path);
    expect(lock.uncleanPreviousExit).toBe(true);
    expect(existsSync(path)).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test test/persistence`
Expected: FAIL, `Cannot find module "../../src/main/persistence/atomic-write"`.

- [ ] **Step 3: Implement**

`apps/desktop/src/main/persistence/atomic-write.ts`:
```ts
import { copyFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicWriteOptions {
  /** Copy the current file to `<path>.bak` before replacing it. */
  backup?: boolean;
  /** File mode for newly written files (default 0o644). */
  mode?: number;
}

/** Writes via temp file + fsync + rename so readers never observe a partially written file. */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = await open(tmp, "w", options.mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (options.backup) {
    await copyFile(path, `${path}.bak`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
}
```

`apps/desktop/src/main/persistence/json-store.ts`:
```ts
import { copyFile, readFile } from "node:fs/promises";

export type Recovery = "none" | "backup" | "defaults";

/** Anything with a zod-compatible `parse` that throws on invalid input. */
export interface Parser<T> {
  parse(input: unknown): T;
}

type ReadResult<T> = { ok: true; value: T } | { ok: false; reason: "missing" | "corrupt" };

async function tryRead<T>(path: string, parser: Parser<T>): Promise<ReadResult<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt" };
  }
  try {
    return { ok: true, value: parser.parse(JSON.parse(text)) };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/**
 * Loads a JSON file, falling back to `<path>.bak` and then to defaults.
 * A corrupt primary file is preserved as `<name>.corrupt-<timestamp>.json` for diagnosis.
 */
export async function loadJson<T>(
  path: string,
  parser: Parser<T>,
  fallback: () => T,
): Promise<{ value: T; recovered: Recovery }> {
  const primary = await tryRead(path, parser);
  if (primary.ok) return { value: primary.value, recovered: "none" };
  if (primary.reason === "corrupt") {
    await copyFile(path, `${path.replace(/\.json$/, "")}.corrupt-${Date.now()}.json`).catch(() => {});
  }
  const backup = await tryRead(`${path}.bak`, parser);
  if (backup.ok) return { value: backup.value, recovered: "backup" };
  return { value: fallback(), recovered: primary.reason === "missing" ? "none" : "defaults" };
}

export interface DebouncedWriter {
  schedule(data: string): void;
  flush(): Promise<void>;
}

/** Coalesces rapid writes; writes run sequentially and `flush` resolves after the last one lands. */
export function createDebouncedWriter(write: (data: string) => Promise<void>, delayMs = 500): DebouncedWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: string | null = null;
  let inflight: Promise<void> = Promise.resolve();

  const run = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const data = pending;
    pending = null;
    if (data !== null) inflight = inflight.then(() => write(data));
    return inflight;
  };

  return {
    schedule(data) {
      pending = data;
      clearTimeout(timer);
      timer = setTimeout(() => void run(), delayMs);
    },
    flush: run,
  };
}
```

`apps/desktop/src/main/persistence/run-lock.ts`:
```ts
import { existsSync, rmSync, writeFileSync } from "node:fs";

/**
 * `run.lock` exists while any run is evaluating. If it still exists at startup, the previous
 * session hung or crashed mid-run and JSLab starts in Safe Mode (spec §5.14).
 */
export class RunLock {
  readonly #active = new Set<string>();
  readonly uncleanPreviousExit: boolean;

  constructor(private readonly path: string) {
    this.uncleanPreviousExit = existsSync(path);
    rmSync(path, { force: true });
  }

  add(runId: string): void {
    this.#active.add(runId);
    if (this.#active.size === 1) writeFileSync(this.path, String(process.pid));
  }

  remove(runId: string): void {
    if (!this.#active.delete(runId)) return;
    if (this.#active.size === 0) rmSync(this.path, { force: true });
  }

  releaseAll(): void {
    this.#active.clear();
    rmSync(this.path, { force: true });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop && bun test test/persistence`
Expected: `11 pass`, `0 fail`.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/persistence apps/desktop/test/persistence
git commit -m "feat(desktop): atomic persistence, backup recovery and crash-loop run lock"
```

---

### Task 12: Main services and RPC handlers

**Files:**
- Create: `apps/desktop/src/main/services/settings-store.ts`, `apps/desktop/src/main/services/session-store.ts`, `apps/desktop/src/main/services/safe-mode.ts`
- Create: `apps/desktop/src/main/rpc-handlers.ts`
- Test: `apps/desktop/test/services/services.test.ts`, `apps/desktop/test/rpc-handlers.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 3, 9 and 11.
- Produces:
  - `class SettingsStore { static open(dataDir); current; recovered; update(patch): Promise<Settings>; onChange(listener): () => void }`
  - `type TabPatch`, `class SessionStore { static open(dataDir, { newTab?, delayMs? }); session; recovered; readBuffers(); setBuffer(tabId, content); patchTab(tabId, patch); setWindow(frame); flush() }`
    - Buffers live in `buffers/<tabId>.<ext>`. Changing the language renames the file.
  - `type SafeModeReason`, `type SafeModeState`, `SHIFT_MASK`, `isShiftHeld(read?, timeoutMs?)`, `detectSafeMode({ uncleanPreviousExit, shiftHeld })`
  - `class InvalidPayloadError`, `type RpcHandlerDeps`
  - `createRpcHandlers(deps): { requests: { "app.bootstrap"; "run.start"; "run.expand" }; messages: { "run.stop"; "run.kill"; "run.wait"; "buffer.changed"; "tab.patch"; "ui.heartbeat" } }`
    - An invalid request throws `InvalidPayloadError`.
    - An invalid message is logged and dropped.

- [ ] **Step 1: Write the failing service tests**

`apps/desktop/test/services/services.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTab } from "@jslab/shared";
import { detectSafeMode, isShiftHeld, SHIFT_MASK } from "../../src/main/services/safe-mode";
import { SessionStore } from "../../src/main/services/session-store";
import { SettingsStore } from "../../src/main/services/settings-store";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "jslab-services-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  test("starts from defaults and persists updates", async () => {
    const store = await SettingsStore.open(dir);
    expect(store.current.run.autoRun).toBe(true);
    const seen: boolean[] = [];
    store.onChange((s) => seen.push(s.run.autoRun));
    await store.update({ run: { autoRun: false } });
    expect(seen).toEqual([false]);
    const reopened = await SettingsStore.open(dir);
    expect(reopened.current.run.autoRun).toBe(false);
  });

  test("repairs a corrupt file from defaults and rewrites it", async () => {
    await writeFile(join(dir, "settings.json"), "{oops");
    const store = await SettingsStore.open(dir);
    expect(store.recovered).toBe("defaults");
    expect(JSON.parse(await readFile(join(dir, "settings.json"), "utf8")).run.autoRun).toBe(true);
  });
});

describe("SessionStore", () => {
  test("creates a default session with one tab", async () => {
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }) });
    expect(store.session.tabOrder).toEqual(["t1"]);
    expect(await store.readBuffers()).toEqual({ t1: "" });
  });

  test("debounces buffer writes and restores them", async () => {
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }), delayMs: 20 });
    store.setBuffer("t1", "const a = 1");
    store.setBuffer("t1", "const a = 2");
    await store.flush();
    expect(await readFile(join(dir, "buffers", "t1.ts"), "utf8")).toBe("const a = 2");
    const reopened = await SessionStore.open(dir);
    expect(await reopened.readBuffers()).toEqual({ t1: "const a = 2" });
  });

  test("renames the buffer file when the language changes", async () => {
    const store = await SessionStore.open(dir, { newTab: () => createTab({ id: "t1" }), delayMs: 20 });
    store.setBuffer("t1", "<div />");
    await store.patchTab("t1", { language: "tsx" });
    await store.flush();
    expect(existsSync(join(dir, "buffers", "t1.ts"))).toBe(false);
    expect(await readFile(join(dir, "buffers", "t1.tsx"), "utf8")).toBe("<div />");
    expect((await SessionStore.open(dir)).session.tabs.t1?.language).toBe("tsx");
  });

  test("persists the window frame and ignores invalid frames", async () => {
    const store = await SessionStore.open(dir, { delayMs: 20 });
    store.setWindow({ x: 10, y: 20, width: 1200, height: 800 });
    await store.flush();
    expect((await SessionStore.open(dir)).session.window).toEqual({ x: 10, y: 20, width: 1200, height: 800 });
    store.setWindow({ x: 0, y: 0, width: 5, height: 5 });
    expect(store.session.window).toBeNull();
  });
});

describe("safe mode", () => {
  test("an unclean previous exit wins over the shift check", async () => {
    let asked = false;
    const state = await detectSafeMode({
      uncleanPreviousExit: true,
      shiftHeld: async () => {
        asked = true;
        return true;
      },
    });
    expect(state).toEqual({ active: true, reason: "crashLoop" });
    expect(asked).toBe(false);
  });

  test("holding shift enables safe mode", async () => {
    expect(await detectSafeMode({ uncleanPreviousExit: false, shiftHeld: async () => true })).toEqual({
      active: true,
      reason: "shift",
    });
    expect(await detectSafeMode({ uncleanPreviousExit: false, shiftHeld: async () => false })).toEqual({
      active: false,
      reason: null,
    });
  });

  test("isShiftHeld parses modifier flags and never throws", async () => {
    expect(await isShiftHeld(async () => `${SHIFT_MASK | 256}\n`)).toBe(true);
    expect(await isShiftHeld(async () => "256\n")).toBe(false);
    expect(await isShiftHeld(async () => "garbage")).toBe(false);
    expect(await isShiftHeld(() => new Promise(() => {}), 20)).toBe(false);
    expect(await isShiftHeld(async () => Promise.reject(new Error("no osascript")))).toBe(false);
  });

  test.skipIf(process.platform !== "darwin")("reads real modifier flags on macOS", async () => {
    expect(typeof (await isShiftHeld())).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test test/services`
Expected: FAIL, `Cannot find module "../../src/main/services/safe-mode"`.

- [ ] **Step 3: Implement the services**

`apps/desktop/src/main/services/settings-store.ts`:
```ts
import { join } from "node:path";
import { type DeepPartial, defaultSettings, mergeSettings, type Settings, settingsSchema } from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";
import { loadJson, type Recovery } from "../persistence/json-store";

export class SettingsStore {
  #settings: Settings;
  readonly #listeners = new Set<(settings: Settings) => void>();

  private constructor(
    private readonly path: string,
    settings: Settings,
    readonly recovered: Recovery,
  ) {
    this.#settings = settings;
  }

  static async open(dataDir: string): Promise<SettingsStore> {
    const path = join(dataDir, "settings.json");
    const { value, recovered } = await loadJson(path, settingsSchema, defaultSettings);
    const store = new SettingsStore(path, value, recovered);
    if (recovered !== "none") await store.#save();
    return store;
  }

  get current(): Settings {
    return this.#settings;
  }

  async update(patch: DeepPartial<Settings>): Promise<Settings> {
    this.#settings = mergeSettings(this.#settings, patch);
    await this.#save();
    for (const listener of this.#listeners) listener(this.#settings);
    return this.#settings;
  }

  onChange(listener: (settings: Settings) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #save(): Promise<void> {
    return writeFileAtomic(this.path, `${JSON.stringify(this.#settings, null, 2)}\n`, { backup: true });
  }
}
```

`apps/desktop/src/main/services/session-store.ts`:
```ts
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  bufferFileName,
  defaultSession,
  normalizeSession,
  type Session,
  sessionSchema,
  type TabState,
  tabStateSchema,
  type WindowState,
  windowStateSchema,
} from "@jslab/shared";
import { writeFileAtomic } from "../persistence/atomic-write";
import { createDebouncedWriter, type DebouncedWriter, loadJson, type Recovery } from "../persistence/json-store";

export type TabPatch = Partial<Pick<TabState, "title" | "language">> & { layout?: Partial<TabState["layout"]> };

/** Owns session.json and the per-tab buffer files (spec §10.1). */
export class SessionStore {
  #session: Session;
  readonly #sessionWriter: DebouncedWriter;
  readonly #bufferWriters = new Map<string, DebouncedWriter>();

  private constructor(
    private readonly dataDir: string,
    session: Session,
    readonly recovered: Recovery,
    delayMs: number,
  ) {
    this.#session = session;
    this.#sessionWriter = createDebouncedWriter(
      (data) => writeFileAtomic(join(dataDir, "session.json"), data, { backup: true }),
      delayMs,
    );
    this.delayMs = delayMs;
  }

  private readonly delayMs: number;

  static async open(
    dataDir: string,
    options: { newTab?: () => TabState; delayMs?: number } = {},
  ): Promise<SessionStore> {
    const newTab = options.newTab ?? (() => tabStateSchema.parse({ id: crypto.randomUUID() }));
    const { value, recovered } = await loadJson(join(dataDir, "session.json"), sessionSchema, () =>
      defaultSession(newTab),
    );
    return new SessionStore(dataDir, normalizeSession(value, newTab), recovered, options.delayMs ?? 500);
  }

  get session(): Session {
    return this.#session;
  }

  async readBuffers(): Promise<Record<string, string>> {
    const buffers: Record<string, string> = {};
    for (const id of this.#session.tabOrder) {
      const tab = this.#session.tabs[id];
      if (!tab) continue;
      buffers[id] = await readFile(this.#bufferPath(tab), "utf8").catch(() => "");
    }
    return buffers;
  }

  setBuffer(tabId: string, content: string): void {
    if (!this.#session.tabs[tabId]) return;
    let writer = this.#bufferWriters.get(tabId);
    if (!writer) {
      writer = createDebouncedWriter(async (data) => {
        const tab = this.#session.tabs[tabId];
        if (tab) await writeFileAtomic(this.#bufferPath(tab), data);
      }, this.delayMs);
      this.#bufferWriters.set(tabId, writer);
    }
    writer.schedule(content);
  }

  async patchTab(tabId: string, patch: TabPatch): Promise<void> {
    const tab = this.#session.tabs[tabId];
    if (!tab) return;
    const next = tabStateSchema.parse({ ...tab, ...patch, layout: { ...tab.layout, ...patch.layout } });
    if (next.language !== tab.language) {
      await this.#bufferWriters.get(tabId)?.flush();
      await rename(this.#bufferPath(tab), this.#bufferPath(next)).catch(() => {});
    }
    this.#session = { ...this.#session, tabs: { ...this.#session.tabs, [tabId]: next } };
    this.#scheduleSave();
  }

  setWindow(frame: WindowState): void {
    this.#session = { ...this.#session, window: windowStateSchema.parse(frame) };
    this.#scheduleSave();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#bufferWriters.values()].map((writer) => writer.flush()));
    this.#scheduleSave();
    await this.#sessionWriter.flush();
  }

  #bufferPath(tab: Pick<TabState, "id" | "language">): string {
    return join(this.dataDir, "buffers", bufferFileName(tab));
  }

  #scheduleSave(): void {
    this.#sessionWriter.schedule(`${JSON.stringify(this.#session, null, 2)}\n`);
  }
}
```

`apps/desktop/src/main/services/safe-mode.ts`:
```ts
export type SafeModeReason = "crashLoop" | "shift" | null;

export interface SafeModeState {
  active: boolean;
  reason: SafeModeReason;
}

/** NSEventModifierFlagShift */
export const SHIFT_MASK = 1 << 17;

async function readModifierFlags(): Promise<string> {
  const proc = Bun.spawn(["osascript", "-l", "JavaScript", "-e", 'ObjC.import("AppKit"); $.NSEvent.modifierFlags'], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(proc.stdout).text();
  await proc.exited;
  return output;
}

/** True when Shift is held right now. Never throws; gives up after `timeoutMs`. */
export async function isShiftHeld(read: () => Promise<string> = readModifierFlags, timeoutMs = 1000): Promise<boolean> {
  try {
    const output = await Promise.race([
      read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    const flags = Number.parseInt(output.trim(), 10);
    return Number.isFinite(flags) && (flags & SHIFT_MASK) !== 0;
  } catch {
    return false;
  }
}

export async function detectSafeMode(input: {
  uncleanPreviousExit: boolean;
  shiftHeld: () => Promise<boolean>;
}): Promise<SafeModeState> {
  if (input.uncleanPreviousExit) return { active: true, reason: "crashLoop" };
  if (await input.shiftHeld()) return { active: true, reason: "shift" };
  return { active: false, reason: null };
}
```

- [ ] **Step 4: Run the service tests**

Run: `cd apps/desktop && bun test test/services`
Expected: `10 pass`, `0 fail`. On macOS the real modifier-flag check runs; elsewhere it is skipped.

- [ ] **Step 5: Write the failing RPC handler tests**

`apps/desktop/test/rpc-handlers.test.ts`:
```ts
import { describe, expect, mock, test } from "bun:test";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { createRpcHandlers, InvalidPayloadError, type RpcHandlerDeps } from "../src/main/rpc-handlers";

function setup() {
  const session = defaultSession(() => createTab({ id: "t1" }));
  const deps = {
    coordinator: {
      start: mock(() => ({ runId: "run-1" })),
      stop: mock(() => {}),
      kill: mock(() => {}),
      wait: mock(() => {}),
      expand: mock(async () => ({ t: "number", v: "1" }) as const),
    },
    settings: { current: defaultSettings() },
    session: {
      session,
      readBuffers: mock(async () => ({ t1: "1 + 1" })),
      setBuffer: mock(() => {}),
      patchTab: mock(async () => {}),
    },
    safeMode: { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.3.13" },
    log: mock(() => {}),
    onUiHeartbeat: mock(() => {}),
  } satisfies RpcHandlerDeps;
  return { deps, handlers: createRpcHandlers(deps) };
}

const validStart = { tabId: "t1", code: "1 + 1", language: "typescript", logpoints: [], reason: "auto" };

describe("requests", () => {
  test("app.bootstrap returns settings, session, buffers, safe mode and versions", async () => {
    const { handlers, deps } = setup();
    expect(await handlers.requests["app.bootstrap"]()).toEqual({
      settings: deps.settings.current,
      session: deps.session.session,
      buffers: { t1: "1 + 1" },
      safeMode: { active: false, reason: null },
      versions: { app: "0.0.1", bun: "1.3.13" },
    });
  });

  test("run.start validates and forwards only the run fields", () => {
    const { handlers, deps } = setup();
    expect(handlers.requests["run.start"]({ ...validStart, extra: "ignored" })).toEqual({ runId: "run-1" });
    expect(deps.coordinator.start).toHaveBeenCalledWith({
      tabId: "t1",
      code: "1 + 1",
      language: "typescript",
      logpoints: [],
    });
  });

  test("run.start rejects invalid payloads without starting a run", () => {
    const { handlers, deps } = setup();
    expect(() => handlers.requests["run.start"]({ ...validStart, language: "python" })).toThrow(InvalidPayloadError);
    expect(deps.coordinator.start).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });

  test("run.expand forwards validated handles", async () => {
    const { handlers, deps } = setup();
    const runId = crypto.randomUUID();
    expect(await handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "h3" })).toEqual({
      t: "number",
      v: "1",
    });
    expect(deps.coordinator.expand).toHaveBeenCalledWith("t1", runId, "h3");
    expect(() => handlers.requests["run.expand"]({ tabId: "t1", runId, handleId: "nope" })).toThrow(
      InvalidPayloadError,
    );
  });
});

describe("messages", () => {
  test("stop, kill and wait forward the tab id", () => {
    const { handlers, deps } = setup();
    handlers.messages["run.stop"]({ tabId: "t1" });
    handlers.messages["run.kill"]({ tabId: "t1" });
    handlers.messages["run.wait"]({ tabId: "t1" });
    expect(deps.coordinator.stop).toHaveBeenCalledWith("t1");
    expect(deps.coordinator.kill).toHaveBeenCalledWith("t1");
    expect(deps.coordinator.wait).toHaveBeenCalledWith("t1");
  });

  test("invalid messages are logged and dropped instead of throwing", () => {
    const { handlers, deps } = setup();
    expect(() => handlers.messages["run.stop"]({ tabId: 42 })).not.toThrow();
    expect(deps.coordinator.stop).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledTimes(1);
  });

  test("buffer.changed and tab.patch update the session store", () => {
    const { handlers, deps } = setup();
    handlers.messages["buffer.changed"]({ tabId: "t1", content: "const a = 1" });
    handlers.messages["tab.patch"]({ tabId: "t1", patch: { language: "tsx" } });
    expect(deps.session.setBuffer).toHaveBeenCalledWith("t1", "const a = 1");
    expect(deps.session.patchTab).toHaveBeenCalledWith("t1", { language: "tsx" });
  });

  test("ui.heartbeat notifies the watchdog", () => {
    const { handlers, deps } = setup();
    handlers.messages["ui.heartbeat"]();
    expect(deps.onUiHeartbeat).toHaveBeenCalled();
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `cd apps/desktop && bun test test/rpc-handlers.test.ts`
Expected: FAIL, `Cannot find module "../src/main/rpc-handlers"`.

- [ ] **Step 7: Implement the handlers**

`apps/desktop/src/main/rpc-handlers.ts`:
```ts
import {
  type BootstrapPayload,
  bufferChangedSchema,
  type EncodedValue,
  runExpandParamsSchema,
  runStartParamsSchema,
  tabParamsSchema,
  tabPatchSchema,
} from "@jslab/rpc-schema";
import type { RunCoordinator } from "./runs/run-coordinator";
import type { SafeModeState } from "./services/safe-mode";
import type { SessionStore } from "./services/session-store";
import type { SettingsStore } from "./services/settings-store";

export interface RpcHandlerDeps {
  coordinator: Pick<RunCoordinator, "start" | "stop" | "kill" | "wait" | "expand">;
  settings: Pick<SettingsStore, "current">;
  session: Pick<SessionStore, "session" | "readBuffers" | "setBuffer" | "patchTab">;
  safeMode: SafeModeState;
  versions: { app: string; bun: string };
  log(message: string, detail?: unknown): void;
  onUiHeartbeat(): void;
}

export class InvalidPayloadError extends Error {}

interface SafeParser<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { message: string } };
}

/** Handlers for the UI RPC. Every inbound payload is validated before use (spec §18). */
export function createRpcHandlers(deps: RpcHandlerDeps) {
  const parse = <T>(schema: SafeParser<T>, method: string, input: unknown): T => {
    const result = schema.safeParse(input);
    if (!result.success) {
      deps.log(`Rejected invalid ${method} payload`, result.error.message);
      throw new InvalidPayloadError(`Invalid payload for ${method}`);
    }
    return result.data;
  };

  // Messages are fire-and-forget: an invalid one is logged and dropped, never thrown into the RPC layer.
  const message =
    <T>(schema: SafeParser<T>, method: string, handle: (payload: T) => void) =>
    (input: unknown) => {
      try {
        handle(parse(schema, method, input));
      } catch (error) {
        if (!(error instanceof InvalidPayloadError)) deps.log(`Handler for ${method} failed`, String(error));
      }
    };

  return {
    requests: {
      "app.bootstrap": async (): Promise<BootstrapPayload> => ({
        settings: deps.settings.current,
        session: deps.session.session,
        buffers: await deps.session.readBuffers(),
        safeMode: deps.safeMode,
        versions: deps.versions,
      }),
      "run.start": (input: unknown): { runId: string } => {
        const { tabId, code, language, logpoints } = parse(runStartParamsSchema, "run.start", input);
        return deps.coordinator.start({ tabId, code, language, logpoints });
      },
      "run.expand": (input: unknown): Promise<EncodedValue | null> => {
        const { tabId, runId, handleId } = parse(runExpandParamsSchema, "run.expand", input);
        return deps.coordinator.expand(tabId, runId, handleId);
      },
    },
    messages: {
      "run.stop": message(tabParamsSchema, "run.stop", ({ tabId }) => deps.coordinator.stop(tabId)),
      "run.kill": message(tabParamsSchema, "run.kill", ({ tabId }) => deps.coordinator.kill(tabId)),
      "run.wait": message(tabParamsSchema, "run.wait", ({ tabId }) => deps.coordinator.wait(tabId)),
      "buffer.changed": message(bufferChangedSchema, "buffer.changed", ({ tabId, content }) =>
        deps.session.setBuffer(tabId, content),
      ),
      "tab.patch": message(tabPatchSchema, "tab.patch", ({ tabId, patch }) => {
        void deps.session.patchTab(tabId, patch);
      }),
      "ui.heartbeat": () => deps.onUiHeartbeat(),
    },
  };
}
```

- [ ] **Step 8: Run the whole desktop suite, typecheck and lint**

Run: `cd apps/desktop && bun test && bun run typecheck && cd ../.. && bun run lint`
Expected: `46 pass`, `0 fail` (12 runs + 5 transform + 11 persistence + 10 services + 8 handlers), then typecheck and lint exit 0.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/main/services apps/desktop/src/main/rpc-handlers.ts apps/desktop/test/services apps/desktop/test/rpc-handlers.test.ts
git commit -m "feat(desktop): settings/session stores, safe mode detection and validated RPC handlers"
```

---

### Task 13: Electrobun project, app paths and menu model

**Files:**
- Create: `apps/desktop/electrobun.config.ts`, `apps/desktop/hutch.config.ts`
- Create: `apps/desktop/src/main/app-paths.ts`, `apps/desktop/src/main/menu.ts`
- Modify: `apps/desktop/tsconfig.json`, `apps/desktop/package.json`, `.github/workflows/ci.yml`
- Test: `apps/desktop/test/shell.test.ts`

**Interfaces:**
- Produces:
  - `type AppPathsInput { resourcesFolder; userData; execPath; env }`
  - `type AppPaths { dataDir; runsDir; runLock; packagesNodeModules; runnerBootstrap; transformWorker; bunBinary }`
  - `resolveAppPaths(input): AppPaths`
  - `runnerEnvironment(paths, base): Record<string, string>`: sets `JSLAB=1`, sets `NODE_PATH` to the packages `node_modules`, and drops `JSLAB_*` overrides.
  - `type MenuItem`, `buildMenu(): MenuItem[]`, `commandForMenuAction(action): CommandId | null`
- **Build outputs** that `electrobun.config.ts` copies into the bundle:
  - `dist/mainview`: the Vite UI build (Task 17)
  - `dist/runner/bootstrap.js`: the runner
  - `dist/workers/transform-worker.js`: the transform worker

**Before starting:** M0 results (`docs/spikes/2026-09-m0-report.md`) are already applied to this task:
- **Toolchain (S1).** Hutch must be exactly 0.24.3, because `electrobun@2.0.1` rejects any other Hutch. Install it with `curl -fsSL https://hutch.blackboard.sh/hutch/install.sh -o install.sh && sh install.sh --version 0.24.3`.
  - The installer adds `~/.hutch/bin` to `PATH` in `~/.zshrc`.
  - `~/.hutch` must be absent or already a Hutch home.
  - Never run `hutch upgrade`.
  - `hutch.config.ts` pins `electrobun: { version: "2.0.1" }`.
  - With `packageManager: "bun"`, `hutch pm exec -- <bin>` fails (`bun: command not found`). Use `hutch pm x --no-install <bin>` or a `bun run` script, as the scripts below do.
- **Bundling (S1).** Hutch bundles only `build.bun.entrypoint` (`src/main/index.ts`), so the runner bootstrap and the transform worker ship as separate `bun build` outputs through `build.copy`. Every `build.copy` source must exist before `hutch electrobun dev`/`build`, or it fails with `CopySourceMissing`.
- **Copy destination (S1, S3).** Confirmed as `join(PATHS.RESOURCES_FOLDER, "app", <dir>)` (flat files, no ASAR). This matches `resolveAppPaths` and its test as written.

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/shell.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { resolveAppPaths, runnerEnvironment } from "../src/main/app-paths";
import { buildMenu, commandForMenuAction, type MenuItem } from "../src/main/menu";

const input = {
  resourcesFolder: "/Applications/JSLab.app/Contents/Resources",
  userData: "/Users/me/Library/Application Support/dev.jslab.app/stable",
  execPath: "/Applications/JSLab.app/Contents/MacOS/bun",
  env: {},
};

describe("resolveAppPaths", () => {
  test("derives data and bundle locations", () => {
    expect(resolveAppPaths(input)).toEqual({
      dataDir: "/Users/me/Library/Application Support/dev.jslab.app/stable",
      runsDir: "/Users/me/Library/Application Support/dev.jslab.app/stable/runs",
      runLock: "/Users/me/Library/Application Support/dev.jslab.app/stable/run.lock",
      packagesNodeModules: "/Users/me/Library/Application Support/dev.jslab.app/stable/packages/node_modules",
      runnerBootstrap: "/Applications/JSLab.app/Contents/Resources/app/runner/bootstrap.js",
      transformWorker: "/Applications/JSLab.app/Contents/Resources/app/workers/transform-worker.js",
      bunBinary: "/Applications/JSLab.app/Contents/MacOS/bun",
    });
  });

  test("honors development overrides", () => {
    const paths = resolveAppPaths({
      ...input,
      env: {
        JSLAB_RUNNER_BOOTSTRAP: "/src/bootstrap.ts",
        JSLAB_TRANSFORM_WORKER: "/src/worker.ts",
        JSLAB_BUN_PATH: "/bin/bun",
      },
    });
    expect(paths.runnerBootstrap).toBe("/src/bootstrap.ts");
    expect(paths.transformWorker).toBe("/src/worker.ts");
    expect(paths.bunBinary).toBe("/bin/bun");
  });
});

describe("runnerEnvironment", () => {
  test("sets JSLAB and NODE_PATH, drops undefined values and JSLab overrides", () => {
    const paths = resolveAppPaths(input);
    expect(
      runnerEnvironment(paths, { PATH: "/usr/bin", EMPTY: undefined, JSLAB_BUN_PATH: "/x", NODE_PATH: "/old" }),
    ).toEqual({
      PATH: "/usr/bin",
      JSLAB: "1",
      NODE_PATH: paths.packagesNodeModules,
    });
  });
});

describe("menu", () => {
  const flatten = (items: MenuItem[]): MenuItem[] => items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);

  test("every action maps to a command", () => {
    const actions = flatten(buildMenu()).flatMap((item) => (item.action ? [item.action] : []));
    expect(actions.map(commandForMenuAction)).toEqual([
      "output.clear",
      "editor.clear",
      "run.start",
      "run.stop",
      "run.kill",
    ]);
  });

  test("keeps native clipboard roles and registers no accelerators", () => {
    const items = flatten(buildMenu());
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll", "quit"]) {
      expect(items.some((item) => item.role === role)).toBe(true);
    }
    expect(items.some((item) => item.accelerator)).toBe(false);
  });

  test("unknown actions are ignored", () => {
    expect(commandForMenuAction("jslab:unknown")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/desktop && bun test test/shell.test.ts`
Expected: FAIL, `Cannot find module "../src/main/app-paths"`.

- [ ] **Step 3: Implement the path formula and the menu model**

`apps/desktop/src/main/app-paths.ts`:
```ts
import { join } from "node:path";

export interface AppPathsInput {
  /** Electrobun `PATHS.RESOURCES_FOLDER` (the bundle's Resources folder). */
  resourcesFolder: string;
  /** Electrobun `Utils.paths.userData`, laid out as `<appData>/dev.jslab.app/<channel>` (spec §4.5). */
  userData: string;
  /** `process.execPath` of the main process: the Bun binary bundled by Electrobun. */
  execPath: string;
  env: Record<string, string | undefined>;
}

export interface AppPaths {
  dataDir: string;
  runsDir: string;
  runLock: string;
  packagesNodeModules: string;
  runnerBootstrap: string;
  transformWorker: string;
  bunBinary: string;
}

/**
 * Every filesystem location Main uses. Bundled scripts are copied by `electrobun.config.ts` into
 * `Resources/app/{runner,workers}`; env overrides let tests and `hutch electrobun dev` point at sources.
 * If the M0-S1/S3 report records a different copy destination, change only this function.
 */
export function resolveAppPaths(input: AppPathsInput): AppPaths {
  const appDir = join(input.resourcesFolder, "app");
  return {
    dataDir: input.userData,
    runsDir: join(input.userData, "runs"),
    runLock: join(input.userData, "run.lock"),
    packagesNodeModules: join(input.userData, "packages", "node_modules"),
    runnerBootstrap: input.env.JSLAB_RUNNER_BOOTSTRAP ?? join(appDir, "runner", "bootstrap.js"),
    transformWorker: input.env.JSLAB_TRANSFORM_WORKER ?? join(appDir, "workers", "transform-worker.js"),
    bunBinary: input.env.JSLAB_BUN_PATH ?? input.execPath,
  };
}

/** Environment for runner processes (spec §5.3). The login-shell environment and `.env` loading arrive in M3. */
export function runnerEnvironment(paths: AppPaths, base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("JSLAB_")) env[key] = value;
  }
  env.JSLAB = "1";
  env.NODE_PATH = paths.packagesNodeModules;
  return env;
}
```

`apps/desktop/src/main/menu.ts`:
```ts
import type { CommandId } from "@jslab/rpc-schema";

/** Shape accepted by Electrobun's `ApplicationMenu.setApplicationMenu`. */
export interface MenuItem {
  label?: string;
  role?: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "close" | "quit";
  action?: string;
  accelerator?: string;
  type?: "separator";
  submenu?: MenuItem[];
}

const ACTIONS = {
  "jslab:run": "run.start",
  "jslab:stop": "run.stop",
  "jslab:kill": "run.kill",
  "jslab:clear-output": "output.clear",
  "jslab:clear-editor": "editor.clear",
} as const satisfies Record<string, CommandId>;

/**
 * M1 application menu. Shortcuts are handled by the UI keybinding code (Electrobun accelerators only support a
 * single key with Cmd, spec §4.6), so items show the shortcut in their label instead of registering an accelerator.
 * The Edit roles keep native clipboard shortcuts working inside WKWebView. The full menu (spec §7.4) lands in M2.
 */
export function buildMenu(): MenuItem[] {
  return [
    { label: "JSLab", submenu: [{ role: "quit" }] },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Clear Output    ⌘K", action: "jslab:clear-output" },
        { label: "Clear Editor", action: "jslab:clear-editor" },
      ],
    },
    {
      label: "Actions",
      submenu: [
        { label: "Run    ⌘R", action: "jslab:run" },
        { label: "Stop    ⇧⌘R", action: "jslab:stop" },
        { label: "Kill    ⌥⌘R", action: "jslab:kill" },
      ],
    },
    { label: "Window", submenu: [{ role: "close" }] },
  ];
}

export function commandForMenuAction(action: string): CommandId | null {
  return (ACTIONS as Record<string, CommandId>)[action] ?? null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd apps/desktop && bun test test/shell.test.ts`
Expected: `6 pass`, `0 fail`.

- [ ] **Step 5: Add the Electrobun project files**

`apps/desktop/electrobun.config.ts`:
```ts
import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "JSLab",
    identifier: "dev.jslab.app",
    version: "0.0.1",
  },
  build: {
    mainProcess: "bun",
    bun: { entrypoint: "src/main/index.ts" },
    copy: {
      "dist/mainview": "views/mainview",
      "dist/runner": "runner",
      "dist/workers": "workers",
    },
    watchIgnore: ["dist/**"],
    mac: { bundleCEF: false },
  },
  runtime: {
    exitOnLastWindowClosed: false,
  },
} satisfies ElectrobunConfig;
```

`apps/desktop/hutch.config.ts`:
```ts
const bundles = [
  "bun build ../../packages/runner-bun/src/bootstrap.ts --target bun --outfile dist/runner/bootstrap.js",
  "bun build src/main/transform/transform-worker.ts --target bun --outfile dist/workers/transform-worker.js",
].join(" && ");

export default {
  packageManager: "bun",
  // M0-S1: pin Electrobun exactly; without this, `hutch electrobun sync` floats on the stable channel.
  electrobun: { version: "2.0.1" },
  scripts: {
    "build:ui": "bun run --cwd ../ui build",
    "build:bundles": bundles,
    dev: "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun dev",
    build:
      "hutch electrobun prepare && hutch run build:ui && hutch run build:bundles && hutch electrobun build --env=canary",
  },
};
```

- [ ] **Step 6: Generate the Electrobun devkit types**

Run: `cd apps/desktop && hutch electrobun sync`
Expected: `apps/desktop/.hutch/devkit/tsconfig.json` exists. `.hutch/` is already ignored by `.gitignore` from Task 1.

- [ ] **Step 7: Point the desktop typecheck at the devkit**

Replace `apps/desktop/tsconfig.json` with:

```json
{
  "extends": ["./.hutch/devkit/tsconfig.json", "../../tsconfig.base.json"],
  "include": ["src", "test"]
}
```

The order matters. Later entries override earlier ones, so JSLab's base options (for example `types: ["bun"]`) win, while the devkit's `compilerOptions.paths` for `electrobun/*` still apply. If `electrobun/main` still doesn't resolve, open `.hutch/devkit/tsconfig.json` and confirm it defines those `paths`.

Add a `postinstall` script to the `scripts` in `apps/desktop/package.json`, so CI and fresh clones generate the devkit before `typecheck`. It must fail loudly when Hutch is missing and never skip silently:

```json
"postinstall": "command -v hutch >/dev/null 2>&1 || { echo 'postinstall: hutch not found. Install Hutch 0.24.3: curl -fsSL https://hutch.blackboard.sh/hutch/install.sh -o install.sh && sh install.sh --version 0.24.3' >&2; exit 1; }; hutch electrobun sync"
```

Run: `cd apps/desktop && bun run typecheck`
Expected: exit 0.

- [ ] **Step 7b: Install Hutch in CI**

CI runners have no Hutch, so `bun install` would fail at the `postinstall` above. In `.github/workflows/ci.yml` (from Task 1), insert these two steps between `oven-sh/setup-bun@v2` and `bun install --frozen-lockfile`.
- The install command is the one recorded under S1 in the M0 report.
- The installer only writes its `PATH` line to `~/.zshrc`, so the step adds `~/.hutch/bin` to `$GITHUB_PATH` itself.

```yaml
      - name: Install Hutch 0.24.3
        run: |
          curl -fsSL https://hutch.blackboard.sh/hutch/install.sh -o "$RUNNER_TEMP/hutch-install.sh"
          sh "$RUNNER_TEMP/hutch-install.sh" --version 0.24.3
          echo "$HOME/.hutch/bin" >> "$GITHUB_PATH"
      - run: hutch --version
```

The `check` job's steps are now, in order: checkout, setup-bun, Install Hutch 0.24.3, `hutch --version`, `bun install --frozen-lockfile`, lint, typecheck, test.

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/electrobun.config.ts apps/desktop/hutch.config.ts apps/desktop/tsconfig.json apps/desktop/package.json apps/desktop/src/main/app-paths.ts apps/desktop/src/main/menu.ts apps/desktop/test/shell.test.ts .github/workflows/ci.yml
git commit -m "feat(desktop): electrobun project config, app paths and menu model"
```

---

### Task 14: Main process bootstrap

**Files:**
- Create: `apps/desktop/src/main/index.ts`

**Interfaces:**
- Consumes: every Main module from Tasks 9–13, plus `BrowserView`, `BrowserWindow`, `ApplicationMenu`, `PATHS`, `Updater`, `Utils` and `Electrobun.events` from `electrobun/main`.
- Produces: the running app. Main sends the UI `run.events`, `run.state`, `run.diagnostics` and `menu.command` (the `ViewMessages` in Task 3), and serves the `MainRequests` and `MainMessages` handlers from Task 12.

**Startup order (the reason is noted after each step):**
1. Read the Shift key state. The user may let go of Shift while the stores load.
2. Create `RunLock`. Its constructor records whether the previous session exited uncleanly, then clears the stale lock.
3. Open the settings and session stores, then detect Safe Mode.
4. Create the transform host, spare pool and coordinator, then the RPC.
5. Create the window, restoring the saved frame and saving it again on move/resize.
6. Set the menu and pre-start the first spare.
7. Start the UI heartbeat watchdog, which reloads the view if the UI stops sending heartbeats for 6 s (spec §4.6).
8. On `before-quit`:
   1. Cancel the first quit.
   2. Dispose runners and the transform host.
   3. Release the run lock.
   4. Flush the session.
   5. Call `Utils.quit()`.

   The cancel is needed because `before-quit` does not await promises.

- [ ] **Step 1: Write the bootstrap**

`apps/desktop/src/main/index.ts`:
```ts
import type { MainMessages, MainRequests, ViewMessages } from "@jslab/rpc-schema";
import { runnerSettings } from "@jslab/shared";
import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  PATHS,
  type RPCSchema,
  Updater,
  Utils,
} from "electrobun/main";
import { resolveAppPaths, runnerEnvironment } from "./app-paths";
import { buildMenu, commandForMenuAction } from "./menu";
import { RunLock } from "./persistence/run-lock";
import { createRpcHandlers } from "./rpc-handlers";
import { BunRunnerProcess } from "./runs/bun-runner-process";
import { RunCoordinator } from "./runs/run-coordinator";
import { SparePool } from "./runs/spare-pool";
import { detectSafeMode, isShiftHeld } from "./services/safe-mode";
import { SessionStore } from "./services/session-store";
import { SettingsStore } from "./services/settings-store";
import { CachingTransformHost, WorkerTransformHost } from "./transform/transform-host";

type JSLabRPC = {
  bun: RPCSchema<{ requests: MainRequests; messages: MainMessages }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: ViewMessages }>;
};

const APP_VERSION = "0.0.1";
const DEV_SERVER_URL = "http://localhost:5173";
const UI_HEARTBEAT_TIMEOUT_MS = 6000;

const log = (message: string, detail?: unknown) => console.error(`[jslab] ${message}`, detail ?? "");

const paths = resolveAppPaths({
  resourcesFolder: PATHS.RESOURCES_FOLDER,
  userData: Utils.paths.userData,
  execPath: process.execPath,
  env: process.env,
});

// Read the modifier keys as early as possible: the user may release Shift while stores load.
const shiftHeld = isShiftHeld();
const runLock = new RunLock(paths.runLock);
const [settings, session] = await Promise.all([SettingsStore.open(paths.dataDir), SessionStore.open(paths.dataDir)]);
const safeMode = await detectSafeMode({ uncleanPreviousExit: runLock.uncleanPreviousExit, shiftHeld: () => shiftHeld });
if (settings.recovered !== "none") log(`settings.json recovered from ${settings.recovered}`);
if (session.recovered !== "none") log(`session.json recovered from ${session.recovered}`);
if (safeMode.active) log(`starting in Safe Mode (${safeMode.reason})`);

let lastUiHeartbeat = Date.now();
const transform = new CachingTransformHost(new WorkerTransformHost(paths.transformWorker));
const spares = new SparePool(
  (config) => BunRunnerProcess.start(config),
  () => ({
    bunPath: paths.bunBinary,
    bootstrapPath: paths.runnerBootstrap,
    cwd: paths.dataDir,
    env: runnerEnvironment(paths, process.env),
  }),
);

const coordinator: RunCoordinator = new RunCoordinator({
  transform: (source, options) => transform.transform(source, options),
  spares,
  runsDir: paths.runsDir,
  settings: () => runnerSettings(settings.current),
  onEvents: (tabId, runId, events) => rpc.send["run.events"]({ tabId, runId, events }),
  onState: (tabId, runId, state, activeHandles) =>
    rpc.send["run.state"]({ tabId, runId, state, ...(activeHandles === undefined ? {} : { activeHandles }) }),
  onDiagnostics: (tabId, runId, diagnostics) => rpc.send["run.diagnostics"]({ tabId, runId, diagnostics }),
  runLock,
});

const rpc = BrowserView.defineRPC<JSLabRPC>({
  maxRequestTime: 10_000,
  handlers: createRpcHandlers({
    coordinator,
    settings,
    session,
    safeMode,
    versions: { app: APP_VERSION, bun: Bun.version },
    log,
    onUiHeartbeat: () => {
      lastUiHeartbeat = Date.now();
    },
  }),
});

async function mainViewUrl(): Promise<string> {
  if ((await Updater.localInfo.channel()) === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      return DEV_SERVER_URL;
    } catch {
      // No Vite dev server; use the built view.
    }
  }
  return "views://mainview/index.html";
}

const url = await mainViewUrl();
const window = new BrowserWindow({
  title: "JSLab",
  url,
  frame: session.session.window ?? { x: 120, y: 80, width: 1280, height: 820 },
  rpc,
});

const saveFrame = () => session.setWindow(window.getFrame());
window.on("resize", saveFrame);
window.on("move", saveFrame);

ApplicationMenu.setApplicationMenu(buildMenu());
ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
  const action = (event as { data?: { action?: string } }).data?.action;
  const command = action ? commandForMenuAction(action) : null;
  if (command) rpc.send["menu.command"]({ command });
});

// Warm the first runner so the first run is fast (spec §5.3).
spares.prepare(session.session.activeTabId);

// WKWebView can freeze after sleep (Electrobun #550): reload the view if UI heartbeats stop (spec §4.6).
setInterval(() => {
  if (Date.now() - lastUiHeartbeat <= UI_HEARTBEAT_TIMEOUT_MS) return;
  log("UI heartbeat missed; reloading the view");
  lastUiHeartbeat = Date.now();
  window.webview.loadURL(url);
}, 2000);

let quitting = false;
Electrobun.events.on("before-quit", (event: { response?: unknown }) => {
  if (quitting) return;
  // before-quit does not await promises: cancel, flush state, then quit for real.
  event.response = { allow: false };
  quitting = true;
  coordinator.dispose();
  transform.dispose();
  runLock.releaseAll();
  void session.flush().finally(() => Utils.quit());
});
```

- [ ] **Step 2: Typecheck against the Electrobun devkit**

Run: `cd apps/desktop && bun run typecheck`
Expected: exit 0.

If an Electrobun API signature differs from what is used here, follow `.hutch/devkit` and the M0 report:
- `BrowserWindow#getFrame`
- `window.on("resize" | "move")`
- the `event.data.action` shape
- `Utils.quit`

Keep the behavior described above.

- [ ] **Step 3: Verify that Main starts**

The UI does not exist yet, so the window will be blank or show a load error. That is expected.

`dist/mainview` must still exist: Electrobun fails with `CopySourceMissing` when a `build.copy` source is absent (M0-S1), so the command creates an empty one. This step runs a dev build from the repository, so the packaged-canary launch procedure (Task 19) does not apply here.

Run: `cd apps/desktop && mkdir -p dist/mainview && hutch run build:bundles && JSLAB_RUNNER_BOOTSTRAP="$PWD/dist/runner/bootstrap.js" JSLAB_TRANSFORM_WORKER="$PWD/dist/workers/transform-worker.js" hutch electrobun dev`

Expected in the terminal:
- no uncaught exceptions
- a JSLab window opens
- `~/Library/Application Support/dev.jslab.app/dev/settings.json` is not created yet (settings are written only after an update or a recovery)
- `ps aux | grep bootstrap.js` shows one warm runner process

Quit with ⌘Q, then confirm `run.lock` does not exist in that folder.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/main/index.ts
git commit -m "feat(desktop): main process bootstrap wiring stores, runner pool, RPC, menu and watchdog"
```

---

### Task 15: UI state (output reducer, app store, auto-run, shortcuts, markers, text)

**Files:**
- Create: `apps/ui/package.json`, `apps/ui/tsconfig.json`, `apps/ui/bunfig.toml`
- Create: `apps/ui/src/api.ts`, `apps/ui/src/state/output.ts`, `apps/ui/src/state/store.ts`, `apps/ui/src/state/auto-run.ts`, `apps/ui/src/shell/keys.ts`, `apps/ui/src/editor/markers.ts`, `apps/ui/src/output/format.ts`, `apps/ui/src/output/text.ts`
- Test: `apps/ui/test/setup-dom.ts`, `apps/ui/test/output.test.ts`, `apps/ui/test/store.test.ts`, `apps/ui/test/logic.test.ts`

**Interfaces:**
- Consumes: `RunEvent`, `RunState`, `EncodedValue`, `BootstrapPayload`, `DiagnosticPayload`, `CommandId`, `RunStartParams`, `RunExpandParams`, `TabPatch`, `ViewMessages` (Task 3); `Settings`, `TabState`, `Language` (Task 2).
- Produces:
  - `interface MainApi { bootstrap; startRun; expand; stop; kill; wait; bufferChanged; patchTab; heartbeat; on }`
  - `type DisplayEvent`, `type OutputEntry { key; event }`, `type OutputState { runId; runState; activeHandles; entries; stale; truncated }`, `initialOutput`
  - `applyRunState(state, runId, runState, activeHandles?)`, `applyRunEvents(state, runId, events)`, `visibleEntries(state, { showUndefined })`
  - `type AppState` (fields below), `shouldAutoRun(state)`, `createAppStore()`, `type AppStore`
    - Fields: `ready`, `settings`, `safeMode`, `versions`, `tab`, `code`, `autoRunArmed`, `output`, `diagnostics`, `hoveredLine`, `revealRequest`.
    - Actions: `hydrate`, `editCode`, `armAutoRun`, `setLanguage`, `setEditorSize`, `toggleOrientation`, `receiveEvents`, `receiveState`, `receiveDiagnostics`, `clearOutput`, `setHoveredLine`, `reveal`.
  - `type TimerApi`, `startAutoRun(store, run, timers?): () => void`
  - `type KeyLike`, `commandForKey(event): CommandId | null`
  - `type EditorMarker`, `markersFor(diagnostics, output): EditorMarker[]`
  - From `format.ts`: `formatPrimitive`, `summarize`, `keyLabel`, `type Child`, `childrenOf`, `formatFrame`, `tableModel`
  - From `text.ts`: `valueToText`, `entryToText`

**Rules encoded here:**
- **Stale output:** a new run marks the previous output stale. The first event of the new run replaces it, except syntax errors, which keep the previous output dimmed (spec §5.11).
- **Promise results** update in place.
- **`console.clear()`** empties the panel.
- **Auto-run** needs all three: Auto Run enabled, not in Safe Mode, and armed by an edit (spec §5.14).

- [ ] **Step 1: Create the package**

The manifest already lists the React, Monaco and Vite dependencies used by Tasks 16–18, so the lockfile changes only once.

`apps/ui/package.json`:
```json
{
  "name": "@jslab/ui",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@jslab/rpc-schema": "workspace:*",
    "@jslab/shared": "workspace:*",
    "@tanstack/react-virtual": "3.14.12",
    "monaco-editor": "0.56.0",
    "react": "19.3.0",
    "react-dom": "19.3.0",
    "zustand": "5.0.15"
  },
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "test": "bun test",
    "typecheck": "tsc --noEmit -p ."
  },
  "devDependencies": {
    "@happy-dom/global-registrator": "20.14.5",
    "@testing-library/react": "16.3.3",
    "@types/react": "19.3.0",
    "@types/react-dom": "19.3.0",
    "@vitejs/plugin-react": "6.1.1",
    "happy-dom": "20.14.5",
    "vite": "8.3.0"
  }
}
```

`apps/ui/tsconfig.json` (Task 17 adds the Electrobun devkit):
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ESNext", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "test"]
}
```

`apps/ui/bunfig.toml`:
```toml
[test]
preload = ["./test/setup-dom.ts"]
```

`apps/ui/test/setup-dom.ts`:
```ts
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

const { cleanup } = await import("@testing-library/react");
afterEach(() => {
  cleanup();
});
```

Run: `bun install`

- [ ] **Step 2: Write the failing tests**

`apps/ui/test/output.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { applyRunEvents, applyRunState, initialOutput, type OutputState, visibleEntries } from "../src/state/output";

let seq = 0;
const result = (line: number, v: string): RunEvent => ({
  kind: "result",
  line,
  source: "autolog",
  value: { t: "number", v },
  seq: ++seq,
  t: 0,
});
const log = (text: string): RunEvent => ({
  kind: "console",
  level: "log",
  groupDepth: 0,
  args: [{ t: "string", v: text }],
  seq: ++seq,
  t: 0,
});
const transpileError = (): RunEvent => ({
  kind: "error",
  phase: "transpile",
  name: "SyntaxError",
  message: "Unexpected token",
  line: 1,
  stack: [],
  seq: ++seq,
  t: 0,
});

function withRun(runId: string, events: RunEvent[], state: OutputState = initialOutput): OutputState {
  return applyRunEvents(applyRunState(state, runId, "transpiling"), runId, events);
}

describe("output state", () => {
  test("appends events for the current run", () => {
    const s = withRun("r1", [log("hi"), result(2, "42")]);
    expect(s.entries.map((e) => e.event.kind)).toEqual(["console", "result"]);
    expect(s.stale).toBe(false);
  });

  test("ignores events and states from other runs", () => {
    const s = withRun("r1", [log("hi")]);
    expect(applyRunEvents(s, "old", [log("late")])).toBe(s);
    expect(applyRunState(s, "old", "idle")).toBe(s);
  });

  test("marks previous output stale until the new run produces events", () => {
    const first = withRun("r1", [log("one")]);
    const starting = applyRunState(first, "r2", "transpiling");
    expect(starting.stale).toBe(true);
    expect(starting.entries).toHaveLength(1);
    const next = applyRunEvents(starting, "r2", [log("two")]);
    expect(next.stale).toBe(false);
    expect(next.entries.map((e) => (e.event as { args: { v: string }[] }).args[0]?.v)).toEqual(["two"]);
  });

  test("keeps the previous output dimmed when the new run fails to compile", () => {
    const first = withRun("r1", [log("one")]);
    const failed = withRun("r2", [transpileError()], first);
    expect(failed.stale).toBe(true);
    expect(failed.entries.map((e) => e.event.kind)).toEqual(["console", "error"]);
    const failedAgain = withRun("r3", [transpileError()], failed);
    expect(failedAgain.entries.map((e) => e.event.kind)).toEqual(["console", "error"]);
  });

  test("clears stale output when a run evaluates without output", () => {
    const first = withRun("r1", [log("one")]);
    const s = applyRunState(applyRunState(first, "r2", "transpiling"), "r2", "evaluating");
    expect(s.entries).toEqual([]);
    expect(s.stale).toBe(false);
  });

  test("updates a pending promise result in place", () => {
    const pending: RunEvent = {
      kind: "result",
      line: 1,
      source: "autolog",
      value: { t: "promise", id: 1, state: "pending" },
      seq: 100,
      t: 0,
    };
    const settled: RunEvent = {
      kind: "promiseSettled",
      ref: 100,
      value: { t: "promise", id: 1, state: "fulfilled", value: { t: "number", v: "7" } },
      seq: 101,
      t: 0,
    };
    const s = withRun("r1", [pending, settled]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]?.event).toMatchObject({ value: { state: "fulfilled" } });
  });

  test("console.clear empties the panel and truncation is tracked", () => {
    const clear: RunEvent = { kind: "console", level: "clear", groupDepth: 0, args: [], seq: ++seq, t: 0 };
    const s = withRun("r1", [log("a"), clear, log("b"), { kind: "truncated", dropped: 40, seq: ++seq, t: 0 }]);
    expect(s.entries).toHaveLength(1);
    expect(s.truncated).toBe(40);
  });

  test("hides undefined results unless Show Undefined is on", () => {
    const undef: RunEvent = { kind: "result", line: 1, source: "autolog", value: { t: "undefined" }, seq: ++seq, t: 0 };
    const s = withRun("r1", [undef, result(2, "1")]);
    expect(visibleEntries(s, { showUndefined: false })).toHaveLength(1);
    expect(visibleEntries(s, { showUndefined: true })).toHaveLength(2);
  });
});
```

`apps/ui/test/store.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import type { BootstrapPayload, RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings, mergeSettings } from "@jslab/shared";
import { createAppStore, shouldAutoRun } from "../src/state/store";

function payload(overrides: Partial<BootstrapPayload> = {}): BootstrapPayload {
  return {
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1", title: "scratch" })),
    buffers: { t1: "1 + 1" },
    safeMode: { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.3.13" },
    ...overrides,
  };
}

const log = (seq: number): RunEvent => ({ kind: "console", level: "log", groupDepth: 0, args: [], seq, t: 0 });

describe("app store", () => {
  test("hydrate loads the active tab and its buffer without arming auto-run", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    const s = store.getState();
    expect(s.ready).toBe(true);
    expect(s.tab?.id).toBe("t1");
    expect(s.code).toBe("1 + 1");
    expect(s.autoRunArmed).toBe(false);
    expect(shouldAutoRun(s)).toBe(false);
  });

  test("the first edit arms auto-run", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().editCode("2 + 2");
    expect(store.getState().code).toBe("2 + 2");
    expect(shouldAutoRun(store.getState())).toBe(true);
  });

  test("auto-run stays off in safe mode and when disabled in settings", () => {
    const safe = createAppStore();
    safe.getState().hydrate(payload({ safeMode: { active: true, reason: "crashLoop" } }));
    safe.getState().editCode("x");
    expect(shouldAutoRun(safe.getState())).toBe(false);

    const disabled = createAppStore();
    disabled.getState().hydrate(payload({ settings: mergeSettings(defaultSettings(), { run: { autoRun: false } }) }));
    disabled.getState().editCode("x");
    expect(shouldAutoRun(disabled.getState())).toBe(false);
  });

  test("run events and states flow through the output reducer", () => {
    const store = createAppStore();
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveEvents("r1", [log(1), log(2)]);
    store.getState().receiveState("r1", "idle");
    expect(store.getState().output.entries).toHaveLength(2);
    expect(store.getState().output.runState).toBe("idle");
    store.getState().clearOutput();
    expect(store.getState().output.entries).toEqual([]);
  });

  test("diagnostics are kept only for the current run and reset when a new run starts", () => {
    const store = createAppStore();
    const warning = { severity: "warning" as const, code: "magic-comment-no-value", message: "m", line: 1, column: 1 };
    store.getState().receiveState("r1", "transpiling");
    store.getState().receiveDiagnostics("r1", [warning]);
    store.getState().receiveDiagnostics("old", []);
    expect(store.getState().diagnostics).toEqual([warning]);
    store.getState().receiveState("r2", "transpiling");
    expect(store.getState().diagnostics).toEqual([]);
  });

  test("reveal requests carry an increasing nonce so repeated clicks re-trigger", () => {
    const store = createAppStore();
    store.getState().reveal(4);
    store.getState().reveal(4);
    expect(store.getState().revealRequest).toEqual({ line: 4, nonce: 2 });
  });

  test("layout changes are clamped and toggle orientation", () => {
    const store = createAppStore();
    store.getState().hydrate(payload());
    store.getState().setEditorSize(99);
    store.getState().toggleOrientation();
    expect(store.getState().tab?.layout).toEqual({ orientation: "vertical", editorSize: 90 });
  });
});
```

`apps/ui/test/logic.test.ts`:
```ts
import { describe, expect, mock, test } from "bun:test";
import type { BootstrapPayload, EncodedValue, RunEvent } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { markersFor } from "../src/editor/markers";
import { entryToText, valueToText } from "../src/output/text";
import { commandForKey } from "../src/shell/keys";
import { startAutoRun, type TimerApi } from "../src/state/auto-run";
import { applyRunEvents, applyRunState, initialOutput } from "../src/state/output";
import { createAppStore } from "../src/state/store";

function manualTimers() {
  let next = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const timers: TimerApi = {
    setTimeout: (callback, ms) => {
      const id = next++;
      pending.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
  };
  const fireAll = () => {
    for (const [id, { callback }] of [...pending]) {
      pending.delete(id);
      callback();
    }
  };
  return { timers, pending, fireAll };
}

function hydratedStore(safe = false) {
  const store = createAppStore();
  const payload: BootstrapPayload = {
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "1" },
    safeMode: safe ? { active: true, reason: "shift" } : { active: false, reason: null },
    versions: { app: "0.0.1", bun: "1.3.13" },
  };
  store.getState().hydrate(payload);
  return store;
}

describe("startAutoRun", () => {
  test("debounces edits into one run after the configured delay", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    store.getState().editCode("1 +");
    store.getState().editCode("1 + 2");
    expect(clock.pending.size).toBe(1);
    expect([...clock.pending.values()][0]?.ms).toBe(300);
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("does not run restored code or anything in safe mode", () => {
    const run = mock(() => {});
    const clock = manualTimers();
    const store = createAppStore();
    startAutoRun(store, run, clock.timers);
    store.getState().hydrate({
      settings: defaultSettings(),
      session: defaultSession(() => createTab({ id: "t1" })),
      buffers: { t1: "while (true) {}" },
      safeMode: { active: false, reason: null },
      versions: { app: "0", bun: "0" },
    });
    expect(clock.pending.size).toBe(0);

    const safe = hydratedStore(true);
    startAutoRun(safe, run, clock.timers);
    safe.getState().editCode("2");
    expect(clock.pending.size).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  test("changing the language of an armed tab schedules a run", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    startAutoRun(store, run, clock.timers);
    store.getState().armAutoRun();
    store.getState().setLanguage("javascript");
    clock.fireAll();
    expect(run).toHaveBeenCalledTimes(1);
  });

  test("unsubscribing cancels a pending run", () => {
    const store = hydratedStore();
    const run = mock(() => {});
    const clock = manualTimers();
    const stop = startAutoRun(store, run, clock.timers);
    store.getState().editCode("3");
    stop();
    clock.fireAll();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("commandForKey", () => {
  const key = (
    code: string,
    mods: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {},
  ) => ({
    code,
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });

  test("maps the M1 shortcuts", () => {
    expect(commandForKey(key("KeyR"))).toBe("run.start");
    expect(commandForKey(key("KeyR", { shiftKey: true }))).toBe("run.stop");
    expect(commandForKey(key("KeyR", { altKey: true }))).toBe("run.kill");
    expect(commandForKey(key("KeyK"))).toBe("output.clear");
  });

  test("ignores keys without Cmd or with Ctrl", () => {
    expect(commandForKey(key("KeyR", { metaKey: false }))).toBeNull();
    expect(commandForKey(key("KeyR", { ctrlKey: true }))).toBeNull();
    expect(commandForKey(key("KeyX"))).toBeNull();
  });
});

describe("markersFor", () => {
  const runtimeError: RunEvent = {
    kind: "error",
    phase: "runtime",
    name: "Error",
    message: "boom",
    line: 3,
    column: 7,
    stack: [],
    seq: 1,
    t: 0,
  };
  const syntaxError: RunEvent = {
    kind: "error",
    phase: "transpile",
    name: "SyntaxError",
    message: "Unexpected token",
    line: 1,
    column: 11,
    stack: [],
    seq: 1,
    t: 0,
  };

  test("marks transform warnings and runtime errors", () => {
    const output = applyRunEvents(applyRunState(initialOutput, "r1", "transpiling"), "r1", [runtimeError]);
    const markers = markersFor(
      [
        {
          severity: "warning",
          code: "magic-comment-no-value",
          message: "Magic comment has no value to log",
          line: 2,
          column: 5,
        },
      ],
      output,
    );
    expect(markers.map((m) => [m.severity, m.startLineNumber, m.source])).toEqual([
      ["warning", 2, "jslab"],
      ["error", 3, "runtime"],
    ]);
  });

  test("keeps syntax errors but drops stale runtime errors", () => {
    const first = applyRunEvents(applyRunState(initialOutput, "r1", "transpiling"), "r1", [runtimeError]);
    const failed = applyRunEvents(applyRunState(first, "r2", "transpiling"), "r2", [{ ...syntaxError, seq: 2 }]);
    expect(markersFor([], failed).map((m) => m.source)).toEqual(["syntax"]);
  });
});

describe("text rendering", () => {
  const num = (v: string): EncodedValue => ({ t: "number", v });

  test("renders nested values on one line", () => {
    const value: EncodedValue = {
      t: "object",
      id: 1,
      ctor: "Object",
      props: [
        [{ k: "a" }, num("1")],
        [
          { k: "list" },
          {
            t: "array",
            id: 2,
            ctor: "Array",
            length: 2,
            items: [
              [0, { t: "string", v: "x" }],
              [1, num("2")],
            ],
          },
        ],
      ],
    };
    expect(valueToText(value)).toBe('{ a: 1, list: ["x", 2] }');
    expect(valueToText({ t: "string", v: "top" })).toBe("top");
  });

  test("renders console arguments, streams and errors", () => {
    expect(
      entryToText({
        kind: "console",
        level: "log",
        groupDepth: 0,
        args: [{ t: "string", v: "n" }, num("3")],
        seq: 1,
        t: 0,
      }),
    ).toBe("n 3");
    expect(entryToText({ kind: "stdout", text: "raw\n", seq: 1, t: 0 })).toBe("raw");
    expect(
      entryToText({
        kind: "error",
        phase: "runtime",
        name: "Error",
        message: "boom",
        stack: [{ fn: "f", line: 3, column: 2, user: true }],
        seq: 1,
        t: 0,
      }),
    ).toBe("Error: boom\n    at f (L3:2)");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd apps/ui && bun test test/output.test.ts test/store.test.ts test/logic.test.ts`
Expected: FAIL, `Cannot find module "../src/state/output"`.

- [ ] **Step 4: Implement the Main API interface and output reducer**

`apps/ui/src/api.ts`:
```ts
import type {
  BootstrapPayload,
  EncodedValue,
  RunExpandParams,
  RunStartParams,
  TabPatch,
  ViewMessages,
} from "@jslab/rpc-schema";

/**
 * Everything the UI needs from Main. Components depend on this interface only; `rpc.ts` implements it
 * with Electrobun, and tests pass a fake.
 */
export interface MainApi {
  bootstrap(): Promise<BootstrapPayload>;
  startRun(params: RunStartParams): Promise<{ runId: string }>;
  expand(params: RunExpandParams): Promise<EncodedValue | null>;
  stop(tabId: string): void;
  kill(tabId: string): void;
  wait(tabId: string): void;
  bufferChanged(tabId: string, content: string): void;
  patchTab(tabId: string, patch: TabPatch["patch"]): void;
  heartbeat(): void;
  on<K extends keyof ViewMessages>(name: K, listener: (payload: ViewMessages[K]) => void): () => void;
}
```

`apps/ui/src/state/output.ts`:
```ts
import type { RunEvent, RunState } from "@jslab/rpc-schema";

export type DisplayEvent = Exclude<RunEvent, { kind: "promiseSettled" } | { kind: "truncated" }>;

export interface OutputEntry {
  key: string;
  event: DisplayEvent;
}

export interface OutputState {
  runId: string | null;
  runState: RunState | null;
  activeHandles: number;
  entries: OutputEntry[];
  /** True while entries belong to a previous run (shown dimmed). */
  stale: boolean;
  truncated: number;
}

export const initialOutput: OutputState = {
  runId: null,
  runState: null,
  activeHandles: 0,
  entries: [],
  stale: false,
  truncated: 0,
};

export function applyRunState(
  state: OutputState,
  runId: string,
  runState: RunState,
  activeHandles?: number,
): OutputState {
  if (runId !== state.runId) {
    // Every run announces "transpiling" first; later states for unknown runs are stale messages.
    if (runState !== "transpiling") return state;
    return { ...state, runId, runState, activeHandles: 0, truncated: 0, stale: state.entries.length > 0 };
  }
  const next = { ...state, runState, activeHandles: activeHandles ?? state.activeHandles };
  // A run that evaluates without producing output must still clear the previous run's entries.
  if (runState === "evaluating" && state.stale) return { ...next, entries: [], stale: false };
  return next;
}

const isTranspileError = (event: RunEvent) => event.kind === "error" && event.phase === "transpile";

export function applyRunEvents(state: OutputState, runId: string, events: RunEvent[]): OutputState {
  if (runId !== state.runId || events.length === 0) return state;

  let entries = state.entries;
  let stale = state.stale;
  if (stale) {
    if (events.every(isTranspileError)) {
      // Keep the last successful output visible (dimmed) above the new syntax error.
      entries = entries.filter((entry) => !isTranspileError(entry.event));
    } else {
      entries = [];
      stale = false;
    }
  }

  let truncated = state.truncated;
  const next = [...entries];
  for (const event of events) {
    switch (event.kind) {
      case "truncated":
        truncated = event.dropped;
        break;
      case "promiseSettled": {
        const index = next.findIndex((entry) => entry.event.seq === event.ref && entry.event.kind === "result");
        const target = next[index];
        if (target && target.event.kind === "result")
          next[index] = { ...target, event: { ...target.event, value: event.value } };
        break;
      }
      case "console":
        if (event.level === "clear") {
          next.length = 0;
          break;
        }
        next.push({ key: `${runId}:${event.seq}`, event });
        break;
      default:
        next.push({ key: `${runId}:${event.seq}`, event });
    }
  }
  return { ...state, entries: next, stale, truncated };
}

export function visibleEntries(state: OutputState, options: { showUndefined: boolean }): OutputEntry[] {
  if (options.showUndefined) return state.entries;
  return state.entries.filter((entry) => !(entry.event.kind === "result" && entry.event.value.t === "undefined"));
}
```

- [ ] **Step 5: Implement the store and auto-run**

`apps/ui/src/state/store.ts`:
```ts
import type { BootstrapPayload, DiagnosticPayload, RunEvent, RunState } from "@jslab/rpc-schema";
import type { Language, Settings, TabState } from "@jslab/shared";
import { createStore } from "zustand/vanilla";
import { applyRunEvents, applyRunState, initialOutput, type OutputState } from "./output";

export interface AppState {
  ready: boolean;
  settings: Settings | null;
  safeMode: BootstrapPayload["safeMode"];
  versions: BootstrapPayload["versions"] | null;
  tab: TabState | null;
  code: string;
  /** Restored code never auto-runs until the user edits or presses Run (spec §5.14). */
  autoRunArmed: boolean;
  output: OutputState;
  diagnostics: DiagnosticPayload[];
  hoveredLine: number | null;
  revealRequest: { line: number; nonce: number } | null;

  hydrate(payload: BootstrapPayload): void;
  editCode(code: string): void;
  armAutoRun(): void;
  setLanguage(language: Language): void;
  setEditorSize(size: number): void;
  toggleOrientation(): void;
  receiveEvents(runId: string, events: RunEvent[]): void;
  receiveState(runId: string, state: RunState, activeHandles?: number): void;
  receiveDiagnostics(runId: string, diagnostics: DiagnosticPayload[]): void;
  clearOutput(): void;
  setHoveredLine(line: number | null): void;
  reveal(line: number): void;
}

export function shouldAutoRun(state: Pick<AppState, "settings" | "safeMode" | "autoRunArmed">): boolean {
  return Boolean(state.settings?.run.autoRun) && !state.safeMode.active && state.autoRunArmed;
}

export function createAppStore() {
  return createStore<AppState>()((set, get) => ({
    ready: false,
    settings: null,
    safeMode: { active: false, reason: null },
    versions: null,
    tab: null,
    code: "",
    autoRunArmed: false,
    output: initialOutput,
    diagnostics: [],
    hoveredLine: null,
    revealRequest: null,

    hydrate(payload) {
      const tab = payload.session.tabs[payload.session.activeTabId] ?? null;
      set({
        ready: true,
        settings: payload.settings,
        safeMode: payload.safeMode,
        versions: payload.versions,
        tab,
        code: tab ? (payload.buffers[tab.id] ?? "") : "",
        autoRunArmed: false,
      });
    },

    editCode(code) {
      set({ code, autoRunArmed: true });
    },

    armAutoRun() {
      set({ autoRunArmed: true });
    },

    setLanguage(language) {
      const tab = get().tab;
      if (tab) set({ tab: { ...tab, language } });
    },

    setEditorSize(size) {
      const tab = get().tab;
      if (tab) set({ tab: { ...tab, layout: { ...tab.layout, editorSize: Math.min(90, Math.max(10, size)) } } });
    },

    toggleOrientation() {
      const tab = get().tab;
      if (!tab) return;
      const orientation = tab.layout.orientation === "horizontal" ? "vertical" : "horizontal";
      set({ tab: { ...tab, layout: { ...tab.layout, orientation } } });
    },

    receiveEvents(runId, events) {
      set({ output: applyRunEvents(get().output, runId, events) });
    },

    receiveState(runId, runState, activeHandles) {
      const previousRunId = get().output.runId;
      const output = applyRunState(get().output, runId, runState, activeHandles);
      set(output.runId !== previousRunId ? { output, diagnostics: [] } : { output });
    },

    receiveDiagnostics(runId, diagnostics) {
      if (runId === get().output.runId) set({ diagnostics });
    },

    clearOutput() {
      set({ output: { ...get().output, entries: [], stale: false, truncated: 0 } });
    },

    setHoveredLine(line) {
      set({ hoveredLine: line });
    },

    reveal(line) {
      set({ revealRequest: { line, nonce: (get().revealRequest?.nonce ?? 0) + 1 } });
    },
  }));
}

export type AppStore = ReturnType<typeof createAppStore>;
```

`apps/ui/src/state/auto-run.ts`:
```ts
import { type AppStore, shouldAutoRun } from "./store";

export interface TimerApi {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Debounces runs after code or language changes (spec §4.2). Nothing runs until auto-run is armed by an edit,
 * and nothing runs in Safe Mode (spec §5.14). Returns an unsubscribe function.
 */
export function startAutoRun(store: AppStore, run: () => void, timers: TimerApi = defaultTimers): () => void {
  let pending: unknown = null;
  const unsubscribe = store.subscribe((state, previous) => {
    const changed = state.code !== previous.code || state.tab?.language !== previous.tab?.language;
    if (!changed || !shouldAutoRun(state)) return;
    if (pending !== null) timers.clearTimeout(pending);
    pending = timers.setTimeout(() => {
      pending = null;
      run();
    }, state.settings?.run.autoRunDelayMs ?? 300);
  });
  return () => {
    if (pending !== null) timers.clearTimeout(pending);
    unsubscribe();
  };
}
```

- [ ] **Step 6: Implement shortcuts, markers and value formatting**

`apps/ui/src/shell/keys.ts`:
```ts
import type { CommandId } from "@jslab/rpc-schema";

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * M1 shortcuts (spec §6.5). Uses `code` rather than `key` because Option changes the produced character on macOS.
 * The full command registry and user keybindings arrive in M2.
 */
export function commandForKey(event: KeyLike): CommandId | null {
  const primary = event.metaKey && !event.ctrlKey;
  if (!primary) return null;
  if (event.code === "KeyR" && event.altKey && !event.shiftKey) return "run.kill";
  if (event.code === "KeyR" && event.shiftKey && !event.altKey) return "run.stop";
  if (event.code === "KeyR" && !event.shiftKey && !event.altKey) return "run.start";
  if (event.code === "KeyK" && !event.shiftKey && !event.altKey) return "output.clear";
  return null;
}
```

`apps/ui/src/editor/markers.ts`:
```ts
import type { DiagnosticPayload } from "@jslab/rpc-schema";
import type { OutputState } from "../state/output";

export interface EditorMarker {
  severity: "error" | "warning";
  message: string;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  source: "jslab" | "syntax" | "runtime";
}

const END_OF_LINE = 10_000;

/**
 * Editor squiggles for the current run: transform warnings (magic comments, logpoints), syntax errors and runtime
 * errors mapped to their source line (spec §5.11). Errors from a stale previous run are not marked, except syntax
 * errors, which always belong to the code currently in the editor.
 */
export function markersFor(diagnostics: DiagnosticPayload[], output: OutputState): EditorMarker[] {
  const markers: EditorMarker[] = diagnostics
    .filter((d) => d.code !== "syntax")
    .map((d) => ({
      severity: d.severity,
      message: d.message,
      startLineNumber: d.line,
      startColumn: d.column,
      endLineNumber: d.line,
      endColumn: END_OF_LINE,
      source: "jslab",
    }));
  for (const { event } of output.entries) {
    if (event.kind !== "error" || event.line == null) continue;
    const syntax = event.phase === "transpile";
    if (output.stale && !syntax) continue;
    markers.push({
      severity: "error",
      message: `${event.name}: ${event.message}`,
      startLineNumber: event.line,
      startColumn: event.column ?? 1,
      endLineNumber: event.line,
      endColumn: END_OF_LINE,
      source: syntax ? "syntax" : "runtime",
    });
  }
  return markers;
}
```

`apps/ui/src/output/format.ts`:
```ts
import type { EncodedValue, PropKey, StackFrame } from "@jslab/rpc-schema";

/** Text for values that render inline without a tree. Returns null for structured values. */
export function formatPrimitive(value: EncodedValue, nested: boolean): string | null {
  switch (value.t) {
    case "undefined":
      return "undefined";
    case "null":
      return "null";
    case "boolean":
      return String(value.v);
    case "number":
      return value.v;
    case "bigint":
      return `${value.v}n`;
    case "symbol":
      return `Symbol(${value.desc})`;
    case "string":
      // Strings print verbatim at the top level and quoted when nested (spec §7.2).
      return nested ? JSON.stringify(value.v) : value.v;
    case "date":
      return value.iso ?? "Invalid Date";
    case "regexp":
      return `/${value.source}/${value.flags}`;
    case "url":
      return value.href;
    case "circular":
      return "[Circular]";
    case "weak":
      return `${value.kind} { <items unknown> }`;
    default:
      return null;
  }
}

/** One-line summary for a structured value (used for collapsed nodes and map keys). */
export function summarize(value: EncodedValue): string {
  switch (value.t) {
    case "object":
      return `${value.proxy ? "Proxy " : ""}${value.ctor ?? "[Object: null prototype]"} {${value.props.length > 0 || value.more ? "…" : ""}}`;
    case "array":
      return `${value.ctor}(${value.length})`;
    case "map":
      return `Map(${value.size})`;
    case "set":
      return `Set(${value.size})`;
    case "promise":
      return `Promise { <${value.state}> }`;
    case "error":
      return `${value.name}: ${value.message}`;
    case "function":
      return value.kind === "class" ? `class ${value.name || "(anonymous)"}` : `ƒ ${value.name || "(anonymous)"}()`;
    case "typedArray":
      return `${value.ctor}(${value.length})`;
    case "arrayBuffer":
      return `ArrayBuffer(${value.byteLength})`;
    case "headers":
      return `Headers(${value.entries.length})`;
    case "response":
      return `Response { status: ${value.status} }`;
    case "getter":
      return "(...)";
    case "handle":
      return value.preview;
    default:
      return formatPrimitive(value, true) ?? "";
  }
}

export function keyLabel(key: PropKey): string {
  return "k" in key ? key.k : `[Symbol(${key.sym})]`;
}

export type Child = { label: string; value: EncodedValue } | { label: string; value: null };

const text = (v: string): EncodedValue => ({ t: "string", v });

export function formatFrame(frame: StackFrame): string {
  const where =
    frame.line != null ? `${frame.user ? "L" : `${frame.file ?? "?"}:`}${frame.line}:${frame.column ?? 0}` : "native";
  return `at ${frame.fn ?? "<anonymous>"} (${where})`;
}

/** Child rows shown when a node is expanded; null when the value has no children. */
export function childrenOf(value: EncodedValue): Child[] | null {
  switch (value.t) {
    case "object":
      return [
        ...value.props.map(([key, v]) => ({ label: keyLabel(key), value: v })),
        ...(value.proto ? [{ label: "[[Prototype]]", value: value.proto }] : []),
      ];
    case "array":
      return value.items.map((item) =>
        Array.isArray(item)
          ? { label: String(item[0]), value: item[1] }
          : { label: `<${item.hole} empty items>`, value: null },
      );
    case "map":
      return value.entries.map(([k, v]) => ({ label: `${summarize(k)} =>`, value: v }));
    case "set":
      return value.items.map((v, i) => ({ label: String(i), value: v }));
    case "promise":
      return value.value ? [{ label: "[[PromiseResult]]", value: value.value }] : null;
    case "error":
      return [
        ...(value.stack.length > 0 ? [{ label: "stack", value: text(value.stack.map(formatFrame).join("\n")) }] : []),
        ...(value.cause ? [{ label: "[cause]", value: value.cause }] : []),
      ];
    case "typedArray": {
      // Items are numbers, or strings for bigints and for NaN, ±Infinity and -0; the constructor decides the type.
      const bigint = value.ctor.startsWith("Big");
      return value.items.map((v, i) => ({
        label: String(i),
        value: bigint ? { t: "bigint", v: String(v) } : { t: "number", v: String(v) },
      }));
    }
    case "arrayBuffer":
      return [{ label: "[[Bytes]]", value: text(value.preview.join(" ")) }];
    case "headers":
      return value.entries.map(([k, v]) => ({ label: k, value: text(v) }));
    case "response":
      return [
        { label: "status", value: { t: "number", v: String(value.status) } },
        { label: "statusText", value: text(value.statusText) },
        { label: "url", value: text(value.url) },
      ];
    default:
      return null;
  }
}

/** Rows and columns for console.table: union of keys across rows, capped at 1000 rows (spec §5.10). */
export function tableModel(
  value: EncodedValue,
): { columns: string[]; rows: { key: string; cells: Map<string, EncodedValue> }[] } | null {
  const rows = childrenOf(value);
  if (!rows || (value.t !== "array" && value.t !== "object")) return null;
  const columns: string[] = [];
  const out: { key: string; cells: Map<string, EncodedValue> }[] = [];
  for (const row of rows.slice(0, 1000)) {
    if (!row.value || row.label === "[[Prototype]]") continue;
    const cells = new Map<string, EncodedValue>();
    const nested = row.value.t === "object" || row.value.t === "array" ? childrenOf(row.value) : null;
    if (nested) {
      for (const cell of nested) {
        if (!cell.value || cell.label === "[[Prototype]]") continue;
        if (!columns.includes(cell.label)) columns.push(cell.label);
        cells.set(cell.label, cell.value);
      }
    } else {
      if (!columns.includes("Values")) columns.push("Values");
      cells.set("Values", row.value);
    }
    out.push({ key: row.label, cells });
  }
  return { columns, rows: out };
}
```

`apps/ui/src/output/text.ts`:
```ts
import type { EncodedValue } from "@jslab/rpc-schema";
import type { DisplayEvent } from "../state/output";
import { childrenOf, formatPrimitive, summarize } from "./format";

const MAX_TEXT_DEPTH = 3;

/** Plain-text rendering for Copy / Copy All. Deep or lazy values fall back to their summary. */
export function valueToText(value: EncodedValue, nested = false, depth = 0): string {
  const primitive = formatPrimitive(value, nested);
  if (primitive !== null) return primitive;
  const children = childrenOf(value);
  if (!children || depth >= MAX_TEXT_DEPTH) return summarize(value);
  const child = (c: { value: EncodedValue | null; label: string }) =>
    c.value ? valueToText(c.value, true, depth + 1) : c.label;
  switch (value.t) {
    case "array":
    case "set":
      return `[${children.map(child).join(", ")}]`;
    case "object": {
      const props = children.filter((c) => c.label !== "[[Prototype]]").map((c) => `${c.label}: ${child(c)}`);
      const prefix = value.ctor && value.ctor !== "Object" ? `${value.ctor} ` : "";
      return props.length > 0 ? `${prefix}{ ${props.join(", ")} }` : `${prefix}{}`;
    }
    case "map":
      return `Map(${value.size}) { ${children.map((c) => `${c.label} ${child(c)}`).join(", ")} }`;
    default:
      return summarize(value);
  }
}

export function entryToText(event: DisplayEvent): string {
  switch (event.kind) {
    case "result":
      return valueToText(event.value);
    case "console":
      return event.args.map((arg) => valueToText(arg)).join(" ");
    case "stdout":
    case "stderr":
      return event.text.replace(/\n$/, "");
    case "error": {
      const frames = event.stack
        .filter((frame) => frame.user && frame.line != null)
        .map((frame) => `    at ${frame.fn ?? "<anonymous>"} (L${frame.line}:${frame.column ?? 1})`);
      return [`${event.name}: ${event.message}`, ...frames].join("\n");
    }
  }
}
```

- [ ] **Step 7: Run the tests**

Run: `cd apps/ui && bun test test/output.test.ts test/store.test.ts test/logic.test.ts`
Expected: `25 pass`, `0 fail`.

- [ ] **Step 8: Commit**

```bash
git add apps/ui bun.lock
git commit -m "feat(ui): output reducer, app store, safe auto-run, shortcuts, markers and text rendering"
```

---

### Task 16: Output value tree and entry rows

**Files:**
- Create: `apps/ui/src/output/ValueView.tsx`, `apps/ui/src/output/EntryRow.tsx`
- Test: `apps/ui/test/value-view.test.tsx`, `apps/ui/test/entry-row.test.tsx`

**Interfaces:**
- Consumes: `format.ts` and `OutputEntry`/`DisplayEvent` (Task 15).
- Produces:
  - `type ExpandHandle = (handle: string) => Promise<EncodedValue | null>`
  - `ValueView({ value, expand, nested?, label? })`
    - Strings print raw at the top level and quoted when nested.
    - Nodes start collapsed, and handles load when expanded.
    - An expired handle shows "Value no longer available. Re-run to inspect."
    - Truncated strings offer "… N more characters".
  - `EntryRow({ entry, stale, expand, onReveal, onHover })`
    - The `L<n>` badge reveals the line, and hovering reports the line.
    - Console levels get distinct styling, and groups are indented 16px per level.
    - `console.table` renders as a table.
    - Errors show "Uncaught (in promise)" for rejections, user frames as buttons, and a count of internal frames.

- [ ] **Step 1: Write the failing tests**

`apps/ui/test/value-view.test.tsx`:
```tsx
import { describe, expect, mock, test } from "bun:test";
import type { EncodedValue } from "@jslab/rpc-schema";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { childrenOf, tableModel } from "../src/output/format";
import { ValueView } from "../src/output/ValueView";

const noExpand = async () => null;
const num = (v: string): EncodedValue => ({ t: "number", v });
const str = (v: string): EncodedValue => ({ t: "string", v });

describe("ValueView", () => {
  test("prints top-level strings verbatim and nested strings quoted", () => {
    const { container } = render(
      <ValueView
        value={{ t: "object", id: 1, ctor: "Object", props: [[{ k: "name" }, str("Ada")]] }}
        expand={noExpand}
      />,
    );
    render(<ValueView value={str("hello")} expand={noExpand} />);
    expect(screen.getByText("hello")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Object/ }));
    expect(container.textContent).toContain('name: "Ada"');
  });

  test("renders special numbers exactly", () => {
    render(<ValueView value={num("-0")} expand={noExpand} />);
    expect(screen.getByText("-0")).toBeTruthy();
  });

  test("renders typed array items by constructor, keeping NaN and -0 exact", () => {
    const { container } = render(
      <ValueView
        value={{ t: "typedArray", ctor: "Float64Array", length: 3, items: ["NaN", "-0", 1.5] }}
        expand={noExpand}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Float64Array\(3\)/ }));
    const rows = [...container.querySelectorAll(".v-children > .v")].map((row) => [row.className, row.textContent]);
    expect(rows).toEqual([
      ["v v-number", "0: NaN"],
      ["v v-number", "1: -0"],
      ["v v-number", "2: 1.5"],
    ]);
    expect(childrenOf({ t: "typedArray", ctor: "BigInt64Array", length: 1, items: ["1"] })).toEqual([
      { label: "0", value: { t: "bigint", v: "1" } },
    ]);
  });

  test("objects start collapsed and expand on click", () => {
    render(
      <ValueView
        value={{ t: "array", id: 1, ctor: "Array", length: 2, items: [[0, num("1")], { hole: 1 }] }}
        expand={noExpand}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Array\(2\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("<1 empty items>")).toBeTruthy();
  });

  test("loads handles lazily through expand", async () => {
    const expand = mock(
      async () => ({ t: "object", id: 2, ctor: "Deep", props: [[{ k: "d" }, num("1")]] }) as EncodedValue,
    );
    const { container } = render(
      <ValueView value={{ t: "handle", handle: "h1", preview: "Object {…}" }} expand={expand} />,
    );
    expect(expand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Object/ }));
    await waitFor(() => expect(container.textContent).toContain("d: 1"));
    expect(expand).toHaveBeenCalledWith("h1");
  });

  test("shows an explanation when a handle has expired", async () => {
    render(<ValueView value={{ t: "handle", handle: "h9", preview: "Object {…}" }} expand={noExpand} />);
    fireEvent.click(screen.getByRole("button", { name: /Object/ }));
    await waitFor(() => expect(screen.getByText(/no longer available/)).toBeTruthy());
  });

  test("loads the rest of a truncated string", async () => {
    const expand = mock(async () => str("abcdefgh"));
    render(<ValueView value={{ t: "string", v: "abcd", truncated: { total: 8, handle: "h2" } }} expand={expand} />);
    fireEvent.click(screen.getByRole("button", { name: /4 more characters/ }));
    await waitFor(() => expect(screen.getByText("abcdefgh")).toBeTruthy());
  });

  test("summarizes promises and errors", () => {
    render(<ValueView value={{ t: "promise", id: 1, state: "pending" }} expand={noExpand} />);
    render(<ValueView value={{ t: "error", name: "TypeError", message: "bad", stack: [] }} expand={noExpand} />);
    expect(screen.getByText("Promise { <pending> }")).toBeTruthy();
    expect(screen.getByText("TypeError: bad")).toBeTruthy();
  });
});

describe("tableModel", () => {
  test("uses the union of row keys as columns", () => {
    const row = (props: [string, EncodedValue][]): EncodedValue => ({
      t: "object",
      id: 1,
      ctor: "Object",
      props: props.map(([k, v]) => [{ k }, v]),
    });
    const model = tableModel({
      t: "array",
      id: 1,
      ctor: "Array",
      length: 2,
      items: [
        [0, row([["a", num("1")]])],
        [1, row([["b", num("2")]])],
      ],
    });
    expect(model?.columns).toEqual(["a", "b"]);
    expect(model?.rows.map((r) => r.key)).toEqual(["0", "1"]);
  });

  test("puts primitive rows in a Values column", () => {
    expect(tableModel({ t: "array", id: 1, ctor: "Array", length: 1, items: [[0, num("5")]] })?.columns).toEqual([
      "Values",
    ]);
  });
});
```

`apps/ui/test/entry-row.test.tsx`:
```tsx
import { describe, expect, mock, test } from "bun:test";
import type { RunEvent } from "@jslab/rpc-schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { EntryRow } from "../src/output/EntryRow";
import type { DisplayEvent } from "../src/state/output";

const noExpand = async () => null;

function renderEntry(
  event: RunEvent,
  overrides: { onReveal?: (line: number) => void; onHover?: (line: number | null) => void } = {},
) {
  const onReveal = overrides.onReveal ?? mock(() => {});
  const onHover = overrides.onHover ?? mock(() => {});
  const view = render(
    <EntryRow
      entry={{ key: "k", event: event as DisplayEvent }}
      stale={false}
      expand={noExpand}
      onReveal={onReveal}
      onHover={onHover}
    />,
  );
  return { ...view, onReveal, onHover };
}

describe("EntryRow", () => {
  test("shows the source line badge and reveals the line on click", () => {
    const onReveal = mock((_line: number) => {});
    renderEntry(
      { kind: "result", line: 7, source: "autolog", value: { t: "number", v: "42" }, seq: 1, t: 0 },
      { onReveal },
    );
    fireEvent.click(screen.getByRole("button", { name: "L7" }));
    expect(onReveal).toHaveBeenCalledWith(7);
  });

  test("reports hover so the editor can highlight the line", () => {
    const onHover = mock((_line: number | null) => {});
    renderEntry(
      { kind: "console", level: "log", line: 3, groupDepth: 0, args: [{ t: "string", v: "hi" }], seq: 1, t: 0 },
      { onHover },
    );
    const row = screen.getByTestId("entry");
    fireEvent.mouseEnter(row);
    fireEvent.mouseLeave(row);
    expect(onHover.mock.calls).toEqual([[3], [null]]);
  });

  test("styles console levels and indents groups", () => {
    renderEntry({ kind: "console", level: "warn", groupDepth: 2, args: [{ t: "string", v: "careful" }], seq: 1, t: 0 });
    const row = screen.getByTestId("entry");
    expect(row.className).toContain("entry-console-warn");
    expect(row.style.paddingLeft).toBe("32px");
  });

  test("renders errors with clickable user frames and a count of internal frames", () => {
    const onReveal = mock((_line: number) => {});
    renderEntry(
      {
        kind: "error",
        phase: "unhandledRejection",
        name: "Error",
        message: "nope",
        line: 4,
        stack: [
          { fn: "load", line: 4, column: 9, user: true },
          { fn: "internal", file: "/bun/internal.js", line: 1, column: 1, user: false },
        ],
        seq: 1,
        t: 0,
      },
      { onReveal },
    );
    expect(screen.getByText(/Uncaught \(in promise\) Error: nope/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "at load (L4:9)" }));
    expect(onReveal).toHaveBeenCalledWith(4);
    expect(screen.getByText("1 internal frames")).toBeTruthy();
  });

  test("renders console.table as a table", () => {
    renderEntry({
      kind: "console",
      level: "table",
      groupDepth: 0,
      args: [
        {
          t: "array",
          id: 1,
          ctor: "Array",
          length: 1,
          items: [[0, { t: "object", id: 2, ctor: "Object", props: [[{ k: "name" }, { t: "string", v: "Ada" }]] }]],
        },
      ],
      seq: 1,
      t: 0,
    });
    expect(screen.getByRole("columnheader", { name: "name" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: '"Ada"' })).toBeTruthy();
  });

  test("renders stdout text", () => {
    renderEntry({ kind: "stdout", text: "raw output\n", seq: 1, t: 0 });
    expect(screen.getByText("raw output")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/ui && bun test test/value-view.test.tsx test/entry-row.test.tsx`
Expected: FAIL, `Cannot find module "../src/output/ValueView"`.

- [ ] **Step 3: Implement**

`apps/ui/src/output/ValueView.tsx`:
```tsx
import type { EncodedValue } from "@jslab/rpc-schema";
import { useState } from "react";
import { childrenOf, formatPrimitive, summarize } from "./format";

export type ExpandHandle = (handle: string) => Promise<EncodedValue | null>;

interface ValueViewProps {
  value: EncodedValue;
  expand: ExpandHandle;
  nested?: boolean;
  label?: string;
}

const EXPIRED = "Value no longer available. Re-run to inspect.";

export function ValueView({ value, expand, nested = false, label }: ValueViewProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<EncodedValue | "expired" | null>(null);
  const [loading, setLoading] = useState(false);

  const lazyHandle = value.t === "handle" || value.t === "getter" ? value.handle : null;
  const shown = loaded && loaded !== "expired" ? loaded : value;
  const labelNode = label !== undefined ? <span className="v-key">{label}: </span> : null;

  if (value.t === "string" && value.truncated) {
    const truncated = value.truncated;
    const full = loaded && loaded !== "expired" && loaded.t === "string" ? loaded.v : null;
    return (
      <span className="v v-string">
        {labelNode}
        {formatPrimitive(full !== null ? { t: "string", v: full } : value, nested)}
        {full === null && (
          <button
            type="button"
            className="v-more"
            onClick={async () => setLoaded((await expand(truncated.handle)) ?? "expired")}
          >
            … {truncated.total - value.v.length} more characters
          </button>
        )}
      </span>
    );
  }

  const primitive = formatPrimitive(shown, nested);
  const children = childrenOf(shown);
  const expandable = lazyHandle !== null || (children !== null && children.length > 0);

  if (primitive !== null && !(lazyHandle && !loaded)) {
    return (
      <span className={`v v-${shown.t}`}>
        {labelNode}
        {primitive}
      </span>
    );
  }

  const toggle = async () => {
    if (!open && lazyHandle && loaded === null) {
      setLoading(true);
      setLoaded((await expand(lazyHandle)) ?? "expired");
      setLoading(false);
    }
    setOpen(!open);
  };

  return (
    <div className="v-node">
      <button type="button" className="v-toggle" aria-expanded={open} disabled={!expandable} onClick={toggle}>
        {expandable ? (open ? "▾ " : "▸ ") : ""}
        {labelNode}
        <span className={`v v-${shown.t}`}>{summarize(shown)}</span>
        {loading && <span className="v-loading"> …</span>}
      </button>
      {open && loaded === "expired" && <div className="v-expired">{EXPIRED}</div>}
      {open && children && (
        <div className="v-children">
          {children.map((child, index) =>
            child.value ? (
              <ValueView
                // biome-ignore lint/suspicious/noArrayIndexKey: sibling labels can repeat (map keys, holes)
                key={`${child.label}:${index}`}
                label={child.label}
                value={child.value}
                expand={expand}
                nested
              />
            ) : (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: sibling labels can repeat (map keys, holes)
                key={`${child.label}:${index}`}
                className="v-hole"
              >
                {child.label}
              </div>
            ),
          )}
          {"more" in shown && shown.more ? <div className="v-hole">… {shown.more} more</div> : null}
        </div>
      )}
    </div>
  );
}
```

`apps/ui/src/output/EntryRow.tsx`:
```tsx
import type { RunEvent } from "@jslab/rpc-schema";
import type { OutputEntry } from "../state/output";
import { formatPrimitive, tableModel } from "./format";
import { type ExpandHandle, ValueView } from "./ValueView";

interface EntryRowProps {
  entry: OutputEntry;
  stale: boolean;
  expand: ExpandHandle;
  onReveal(line: number): void;
  onHover(line: number | null): void;
}

type ErrorEvent = Extract<RunEvent, { kind: "error" }>;
type ConsoleEvent = Extract<RunEvent, { kind: "console" }>;

function kindClass(event: OutputEntry["event"]): string {
  return event.kind === "console" ? `console-${event.level}` : event.kind;
}

export function EntryRow({ entry, stale, expand, onReveal, onHover }: EntryRowProps) {
  const { event } = entry;
  const line = event.kind === "result" || event.kind === "console" || event.kind === "error" ? event.line : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only mirrors the source-line highlight in the editor
    <div
      data-testid="entry"
      className={`entry entry-${kindClass(event)}${stale ? " entry-stale" : ""}`}
      style={{ paddingLeft: event.kind === "console" ? event.groupDepth * 16 : 0 }}
      onMouseEnter={() => onHover(line ?? null)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="entry-body">
        {event.kind === "result" && <ValueView value={event.value} expand={expand} />}
        {event.kind === "console" && <ConsoleBody event={event} expand={expand} />}
        {(event.kind === "stdout" || event.kind === "stderr") && <pre className="entry-stream">{event.text}</pre>}
        {event.kind === "error" && <ErrorBody event={event} onReveal={onReveal} />}
      </div>
      {line !== undefined && (
        <button type="button" className="entry-line" onClick={() => onReveal(line)}>
          L{line}
        </button>
      )}
    </div>
  );
}

function ConsoleBody({ event, expand }: { event: ConsoleEvent; expand: ExpandHandle }) {
  const first = event.args[0];
  const table = event.level === "table" && first ? tableModel(first) : null;
  if (table) {
    return (
      <table className="entry-table">
        <thead>
          <tr>
            <th>(index)</th>
            {table.columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row) => (
            <tr key={row.key}>
              <td>{row.key}</td>
              {table.columns.map((column) => {
                const cell = row.cells.get(column);
                return <td key={column}>{cell ? (formatPrimitive(cell, true) ?? "…") : ""}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <span className="entry-args">
      {event.args.map((arg, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: console arguments have no identity
        <ValueView key={index} value={arg} expand={expand} />
      ))}
    </span>
  );
}

function ErrorBody({ event, onReveal }: { event: ErrorEvent; onReveal(line: number): void }) {
  const userFrames = event.stack.filter((frame) => frame.user && frame.line != null);
  const internal = event.stack.length - userFrames.length;
  return (
    <div className="entry-error">
      <strong>
        {event.phase === "unhandledRejection" ? "Uncaught (in promise) " : ""}
        {event.name}: {event.message}
      </strong>
      {event.codeFrame && <pre className="entry-codeframe">{event.codeFrame}</pre>}
      {userFrames.map((frame, index) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: stack frames can repeat
          key={index}
          type="button"
          className="entry-frame"
          onClick={() => onReveal(frame.line as number)}
        >
          at {frame.fn ?? "<anonymous>"} (L{frame.line}:{frame.column})
        </button>
      ))}
      {internal > 0 && <span className="entry-internal">{internal} internal frames</span>}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and lint**

Run: `cd apps/ui && bun test test/value-view.test.tsx test/entry-row.test.tsx && cd ../.. && bun run lint`
Expected: `16 pass`, `0 fail`, then lint exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/output/ValueView.tsx apps/ui/src/output/EntryRow.tsx apps/ui/test/value-view.test.tsx apps/ui/test/entry-row.test.tsx
git commit -m "feat(ui): expandable value tree and output entry rows with line links"
```

---

### Task 17: Monaco editor, output panel and Electroview RPC client

**Files:**
- Create: `apps/ui/src/vite-env.d.ts`, `apps/ui/src/editor/monaco-setup.ts`, `apps/ui/src/editor/Editor.tsx`, `apps/ui/src/output/OutputPanel.tsx`, `apps/ui/src/rpc.ts`
- Modify: `apps/ui/tsconfig.json`

**Interfaces:**
- Consumes:
  - `AppStore` and `markersFor` (Task 15)
  - `EntryRow` (Task 16)
  - `entryToText`, `visibleEntries`, `MainApi` (Task 15)
  - `Electroview` and `RPCSchema` from `electrobun/view`
- Produces:
  - `setupMonaco()`, `languageId(language)`, `modelUri(tabId, language)`
  - `Editor({ store })`:
    - reports edits with `editCode`
    - applies external code changes
    - recreates the model when the language changes, so the URI extension matches
    - shows the hover-line decoration
    - reveals lines on request
    - sets markers from diagnostics and errors
  - `OutputPanel({ store, api })`:
    - a virtualized list that auto-scrolls while pinned to the bottom
    - a Copy All and Clear toolbar
    - a truncation notice
    - lazy handle expansion through `api.expand`
  - `createRpcApi(): MainApi`, the only UI module that imports Electrobun.

These components need a real WKWebView layout: Monaco workers and virtualization sizes don't work in happy-dom. They are verified by typecheck here, and by the running app in Task 18 and the QA checklist in Task 19.

**Before starting:** the worker imports in `monaco-setup.ts` below are the ones M0-S2 verified in the packaged app (`docs/spikes/2026-09-m0-report.md`).
- They are plain, non-inline `?worker` imports; no `&inline` or Blob-URL fallback is needed.
- The subpath specifiers are `monaco-editor/editor/editor.worker` and `monaco-editor/languages/features/typescript/ts.worker`.
- Don't use the on-disk `monaco-editor/esm/vs/...` paths. `monaco-editor@0.56.0`'s `exports` map (`"./*": "./esm/vs/*.js"`) already adds `esm/vs/`, so those resolve to a doubled, nonexistent path and the Vite build fails.
- If the `monaco-editor` version changes, re-derive the specifiers from its `exports` map.

- [ ] **Step 1: Point the UI typecheck at the Electrobun devkit**

Replace `apps/ui/tsconfig.json` with:

```json
{
  "extends": ["../desktop/.hutch/devkit/tsconfig.json", "../../tsconfig.base.json"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ESNext", "DOM", "DOM.Iterable"]
  },
  "include": ["src", "test"]
}
```

Run: `cd apps/ui && bun run typecheck`
Expected: exit 0. This shows the devkit resolves; no source files use it yet.

- [ ] **Step 2: Add Vite client types and the Monaco setup**

`apps/ui/src/vite-env.d.ts`:
```ts
/// <reference types="vite/client" />
```

`apps/ui/src/editor/monaco-setup.ts`:
```ts
import type { Language } from "@jslab/shared";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

let configured = false;

/** One-time Monaco configuration (spec §6.1). Worker imports follow the M0-S2 report. */
export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker: (_workerId: string, label: string) =>
      label === "typescript" || label === "javascript" ? new TsWorker() : new EditorWorker(),
  };

  const ts = monaco.typescript;
  const compilerOptions: monaco.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    // TypeScript's ModuleResolutionKind.Bundler; Monaco's enum predates it.
    moduleResolution: 100 as monaco.typescript.ModuleResolutionKind,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    allowJs: true,
    checkJs: false,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    // TypeScript's ModuleDetectionKind.Force, so top-level await is valid in every file.
    moduleDetection: 3,
    lib: ["esnext"],
  };
  for (const defaults of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions);
    defaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      diagnosticCodesToIgnore: [1375, 1378],
    });
  }

  monaco.editor.defineTheme("jslab-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: { "editor.background": "#282A36", "editor.lineHighlightBackground": "#44475A55" },
  });
  return monaco;
}

const EXTENSIONS: Record<Language, string> = { typescript: "ts", tsx: "tsx", javascript: "js", jsx: "jsx" };

export function languageId(language: Language): "typescript" | "javascript" {
  return language === "typescript" || language === "tsx" ? "typescript" : "javascript";
}

/** The extension matters: the TypeScript worker only parses JSX in `.tsx`/`.jsx` models. */
export function modelUri(tabId: string, language: Language): string {
  return `file:///tab/${tabId}.${EXTENSIONS[language]}`;
}
```

- [ ] **Step 3: Write the editor component**

`apps/ui/src/editor/Editor.tsx`:
```tsx
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import type { AppStore } from "../state/store";
import { markersFor } from "./markers";
import { languageId, modelUri, setupMonaco } from "./monaco-setup";

interface EditorProps {
  store: AppStore;
}

export function Editor({ store }: EditorProps) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const monaco = setupMonaco();
    const initial = store.getState();
    if (!host.current || !initial.tab || !initial.settings) return;

    const createModel = (value: string, tabId: string, language: Parameters<typeof languageId>[0]) =>
      monaco.editor.createModel(value, languageId(language), monaco.Uri.parse(modelUri(tabId, language)));

    let model = createModel(initial.code, initial.tab.id, initial.tab.language);
    const editor = monaco.editor.create(host.current, {
      model,
      theme: "jslab-dark",
      automaticLayout: true,
      fontFamily: `"${initial.settings.appearance.font}", ui-monospace, Menlo, monospace`,
      fontSize: initial.settings.appearance.fontSize,
      lineNumbers: initial.settings.editor.lineNumbers ? "on" : "off",
      wordWrap: initial.settings.editor.lineWrap ? "on" : "off",
      minimap: { enabled: false },
      glyphMargin: true,
      fixedOverflowWidgets: true,
      scrollBeyondLastLine: false,
    });

    let applyingExternal = false;
    const listenToModel = (target: Monaco.editor.ITextModel) =>
      target.onDidChangeContent(() => {
        if (!applyingExternal) store.getState().editCode(target.getValue());
      });
    let contentSubscription = listenToModel(model);
    const hover = editor.createDecorationsCollection();

    const applyMarkers = () => {
      const state = store.getState();
      monaco.editor.setModelMarkers(
        model,
        "jslab",
        markersFor(state.diagnostics, state.output).map((marker) => ({
          ...marker,
          severity: marker.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
        })),
      );
    };

    const unsubscribe = store.subscribe((state, previous) => {
      if (state.tab && previous.tab && state.tab.language !== previous.tab.language) {
        // Recreate the model so its URI extension matches the new language.
        const next = createModel(model.getValue(), state.tab.id, state.tab.language);
        contentSubscription.dispose();
        editor.setModel(next);
        model.dispose();
        model = next;
        contentSubscription = listenToModel(model);
      }
      if (state.code !== model.getValue()) {
        applyingExternal = true;
        model.setValue(state.code);
        applyingExternal = false;
      }
      if (state.hoveredLine !== previous.hoveredLine) {
        const line = state.hoveredLine;
        hover.set(
          line
            ? [{ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "line-hover" } }]
            : [],
        );
      }
      if (state.revealRequest && state.revealRequest !== previous.revealRequest) {
        const { line } = state.revealRequest;
        editor.revealLineInCenterIfOutsideViewport(line);
        editor.setPosition({ lineNumber: line, column: 1 });
        editor.focus();
      }
      if (state.diagnostics !== previous.diagnostics || state.output !== previous.output) applyMarkers();
    });

    return () => {
      unsubscribe();
      contentSubscription.dispose();
      editor.dispose();
      model.dispose();
    };
  }, [store]);

  return <div ref={host} className="editor" data-testid="editor" />;
}
```

- [ ] **Step 4: Write the output panel**

`apps/ui/src/output/OutputPanel.tsx`:
```tsx
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { visibleEntries } from "../state/output";
import type { AppStore } from "../state/store";
import { EntryRow } from "./EntryRow";
import { entryToText } from "./text";

interface OutputPanelProps {
  store: AppStore;
  api: MainApi;
}

export function OutputPanel({ store, api }: OutputPanelProps) {
  const output = useStore(store, (s) => s.output);
  const showUndefined = useStore(store, (s) => s.settings?.run.showUndefined ?? false);
  const tabId = useStore(store, (s) => s.tab?.id ?? null);
  const entries = visibleEntries(output, { showUndefined });

  const scroller = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 24,
    overscan: 20,
  });

  useEffect(() => {
    if (pinnedToBottom.current && entries.length > 0) virtualizer.scrollToIndex(entries.length - 1, { align: "end" });
  }, [entries.length, virtualizer]);

  const expand = (handle: string) =>
    tabId && output.runId ? api.expand({ tabId, runId: output.runId, handleId: handle }) : Promise.resolve(null);

  const copyAll = () => navigator.clipboard.writeText(entries.map((entry) => entryToText(entry.event)).join("\n"));

  return (
    <section className="output" aria-label="Output">
      <header className="output-toolbar">
        <span className="output-title">Console</span>
        <button type="button" onClick={copyAll} disabled={entries.length === 0}>
          Copy All
        </button>
        <button type="button" onClick={() => store.getState().clearOutput()} disabled={entries.length === 0}>
          Clear
        </button>
      </header>
      <div
        ref={scroller}
        className="output-scroller"
        onScroll={(event) => {
          const el = event.currentTarget;
          pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
        }}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index];
            if (!entry) return null;
            return (
              <div
                key={entry.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
              >
                <EntryRow
                  entry={entry}
                  stale={output.stale}
                  expand={expand}
                  onReveal={(line) => store.getState().reveal(line)}
                  onHover={(line) => store.getState().setHoveredLine(line)}
                />
              </div>
            );
          })}
        </div>
        {output.truncated > 0 && (
          <div className="output-truncated">
            Output truncated: {output.truncated} more entries were dropped. Raise the limit in Settings → Advanced.
          </div>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 5: Write the Electroview RPC client**

`apps/ui/src/rpc.ts`:
```ts
import type { MainMessages, MainRequests, ViewMessages } from "@jslab/rpc-schema";
import { Electroview, type RPCSchema } from "electrobun/view";
import type { MainApi } from "./api";

type JSLabRPC = {
  bun: RPCSchema<{ requests: MainRequests; messages: MainMessages }>;
  webview: RPCSchema<{ requests: Record<string, never>; messages: ViewMessages }>;
};

type AnyListener = (payload: never) => void;

/** Electrobun-backed implementation of MainApi. The only UI module that imports Electrobun. */
export function createRpcApi(): MainApi {
  const listeners = new Map<keyof ViewMessages, Set<AnyListener>>();
  const dispatch =
    <K extends keyof ViewMessages>(name: K) =>
    (payload: ViewMessages[K]) => {
      for (const listener of listeners.get(name) ?? []) (listener as (p: ViewMessages[K]) => void)(payload);
    };

  const rpc = Electroview.defineRPC<JSLabRPC>({
    maxRequestTime: 10_000,
    handlers: {
      requests: {},
      messages: {
        "run.events": dispatch("run.events"),
        "run.state": dispatch("run.state"),
        "run.diagnostics": dispatch("run.diagnostics"),
        "menu.command": dispatch("menu.command"),
      },
    },
  });
  new Electroview({ rpc });

  return {
    bootstrap: () => rpc.request["app.bootstrap"]({}),
    startRun: (params) => rpc.request["run.start"](params),
    expand: (params) => rpc.request["run.expand"](params),
    stop: (tabId) => rpc.send["run.stop"]({ tabId }),
    kill: (tabId) => rpc.send["run.kill"]({ tabId }),
    wait: (tabId) => rpc.send["run.wait"]({ tabId }),
    bufferChanged: (tabId, content) => rpc.send["buffer.changed"]({ tabId, content }),
    patchTab: (tabId, patch) => rpc.send["tab.patch"]({ tabId, patch }),
    heartbeat: () => rpc.send["ui.heartbeat"]({}),
    on(name, listener) {
      const set = listeners.get(name) ?? new Set<AnyListener>();
      listeners.set(name, set);
      set.add(listener as AnyListener);
      return () => {
        set.delete(listener as AnyListener);
      };
    },
  };
}
```

- [ ] **Step 6: Typecheck, test and lint**

Run: `cd apps/ui && bun run typecheck && bun test && cd ../.. && bun run lint`
Expected: typecheck exits 0, `41 pass`, `0 fail`, lint exits 0.

If `rpc.ts` fails to typecheck because Electrobun's handler or `request`/`send` signatures differ, adapt the calls to the devkit types. Keep the `MainApi` surface unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/tsconfig.json apps/ui/src/vite-env.d.ts apps/ui/src/editor apps/ui/src/output/OutputPanel.tsx apps/ui/src/rpc.ts
git commit -m "feat(ui): monaco editor, virtualized output panel and electroview rpc client"
```

---

### Task 18: App shell, entry point and first end-to-end run

**Files:**
- Create: `apps/ui/src/shell/labels.ts`, `apps/ui/src/shell/parts.tsx`, `apps/ui/src/shell/App.tsx`
- Create: `apps/ui/src/main.tsx`, `apps/ui/src/index.html`, `apps/ui/src/styles.css`, `apps/ui/vite.config.ts`
- Test: `apps/ui/test/app.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 15–17.
- Produces:
  - `LANGUAGE_LABELS`, `BUSY_STATES`, `runStateLabel({ state, activeHandles, autoRunArmed, safeMode })`
  - `ActivityBar`, `StatusBar`, `SplitPane`, `UnresponsiveDialog`, `SafeModeBanner`
  - `App({ store, api })`:
    - wires shortcuts (capture phase) and menu commands to actions
    - starts auto-run
    - subscribes to run messages
    - persists edits and tab changes through `api.bufferChanged`/`api.patchTab`
    - sends a UI heartbeat every 2 s
  - `main.tsx`: bootstraps from Main, then renders.
  - `vite.config.ts`: builds into `apps/desktop/dist/mainview`.
- **CSP:** `index.html` sets a strict CSP (spec §18). `connect-src` allows the Electrobun RPC WebSocket on `127.0.0.1`/`localhost`. If the S7 report shows the RPC transport needs another source, add only that source.

- [ ] **Step 1: Write the failing tests**

Editor and OutputPanel are mocked, because the shell behavior under test doesn't need Monaco or layout.

`apps/ui/test/app.test.tsx`:
```tsx
import { beforeAll, describe, expect, mock, test } from "bun:test";
import type { BootstrapPayload, ViewMessages } from "@jslab/rpc-schema";
import { createTab, defaultSession, defaultSettings } from "@jslab/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import type { MainApi } from "../src/api";
import { runStateLabel } from "../src/shell/labels";
import { type AppStore, createAppStore } from "../src/state/store";

// Monaco and the virtualized list need a real browser layout; the shell behavior under test does not.
mock.module("../src/editor/Editor", () => ({ Editor: () => <div data-testid="editor" /> }));
mock.module("../src/output/OutputPanel", () => ({ OutputPanel: () => <div data-testid="output" /> }));

let App: ComponentType<{ store: AppStore; api: MainApi }>;
beforeAll(async () => {
  ({ App } = await import("../src/shell/App"));
});

function fakeApi() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const api = {
    bootstrap: mock(async () => {
      throw new Error("not used");
    }),
    startRun: mock(async () => ({ runId: "r1" })),
    expand: mock(async () => null),
    stop: mock((_tabId: string) => {}),
    kill: mock((_tabId: string) => {}),
    wait: mock((_tabId: string) => {}),
    bufferChanged: mock((_tabId: string, _content: string) => {}),
    patchTab: mock((_tabId: string, _patch: unknown) => {}),
    heartbeat: mock(() => {}),
    on(name: string, listener: (payload: never) => void) {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener as (payload: unknown) => void);
      return () => set.delete(listener as (payload: unknown) => void);
    },
  } satisfies MainApi;
  const emit = <K extends keyof ViewMessages>(name: K, payload: ViewMessages[K]) =>
    act(() => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    });
  return { api, emit };
}

function renderApp(safeMode: BootstrapPayload["safeMode"] = { active: false, reason: null }) {
  const store = createAppStore();
  store.getState().hydrate({
    settings: defaultSettings(),
    session: defaultSession(() => createTab({ id: "t1" })),
    buffers: { t1: "1 + 1" },
    safeMode,
    versions: { app: "0.0.1", bun: "1.3.13" },
  });
  const { api, emit } = fakeApi();
  render(<App store={store} api={api} />);
  return { store, api, emit };
}

const press = (code: string, modifiers: { shiftKey?: boolean; altKey?: boolean } = {}) =>
  fireEvent.keyDown(window, { code, metaKey: true, ...modifiers });

describe("App shell", () => {
  test("Cmd+R starts a manual run with the current code", () => {
    const { api } = renderApp();
    press("KeyR");
    expect(api.startRun).toHaveBeenCalledWith({
      tabId: "t1",
      code: "1 + 1",
      language: "typescript",
      logpoints: [],
      reason: "manual",
    });
  });

  test("Cmd+Shift+R stops and Cmd+Alt+R kills", () => {
    const { api } = renderApp();
    press("KeyR", { shiftKey: true });
    press("KeyR", { altKey: true });
    expect(api.stop).toHaveBeenCalledWith("t1");
    expect(api.kill).toHaveBeenCalledWith("t1");
  });

  test("menu commands trigger the same actions", async () => {
    const { api, emit } = renderApp();
    await emit("menu.command", { command: "run.start" });
    expect(api.startRun).toHaveBeenCalledTimes(1);
  });

  test("the unresponsive dialog forwards Wait and Kill", async () => {
    const { api, emit } = renderApp();
    await emit("run.state", { tabId: "t1", runId: "r1", state: "transpiling" });
    await emit("run.state", { tabId: "t1", runId: "r1", state: "unresponsive" });
    fireEvent.click(screen.getByRole("button", { name: "Wait" }));
    fireEvent.click(screen.getByRole("button", { name: "Kill" }));
    expect(api.wait).toHaveBeenCalledWith("t1");
    expect(api.kill).toHaveBeenCalledWith("t1");
  });

  test("safe mode shows a banner and a paused status", () => {
    renderApp({ active: true, reason: "crashLoop" });
    expect(screen.getByTestId("safe-mode-banner").textContent).toContain("didn't shut down cleanly");
    expect(screen.getByTestId("run-status").textContent).toBe("Safe Mode: press ⌘R to run");
  });

  test("edits and language changes are sent to Main for persistence", () => {
    const { store, api } = renderApp();
    act(() => store.getState().editCode("2 + 2"));
    expect(api.bufferChanged).toHaveBeenCalledWith("t1", "2 + 2");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "javascript" } });
    expect(api.patchTab).toHaveBeenCalledWith("t1", expect.objectContaining({ language: "javascript" }));
  });
});

describe("runStateLabel", () => {
  const base = { activeHandles: 0, autoRunArmed: true, safeMode: false };

  test("describes each state", () => {
    expect(runStateLabel({ ...base, state: null, autoRunArmed: false })).toBe("Paused: press ⌘R to run");
    expect(runStateLabel({ ...base, state: "evaluating" })).toBe("Running…");
    expect(runStateLabel({ ...base, state: "settled", activeHandles: 1 })).toBe("Running: 1 active handle");
    expect(runStateLabel({ ...base, state: "settled", activeHandles: 2 })).toBe("Running: 2 active handles");
    expect(runStateLabel({ ...base, state: "killed" })).toBe("Run killed");
    expect(runStateLabel({ ...base, state: "idle" })).toBe("");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/ui && bun test test/app.test.tsx`
Expected: FAIL, `Cannot find module "../src/shell/labels"`.

- [ ] **Step 3: Implement the labels and shell parts**

`apps/ui/src/shell/labels.ts`:
```ts
import type { RunState } from "@jslab/rpc-schema";
import type { Language } from "@jslab/shared";

export const LANGUAGE_LABELS: Record<Language, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  tsx: "TSX",
  jsx: "JSX",
};

export const BUSY_STATES: ReadonlySet<RunState> = new Set([
  "transpiling",
  "evaluating",
  "settled",
  "stopping",
  "unresponsive",
]);

export function runStateLabel(input: {
  state: RunState | null;
  activeHandles: number;
  autoRunArmed: boolean;
  safeMode: boolean;
}): string {
  if (input.state === null) {
    if (input.safeMode) return "Safe Mode: press ⌘R to run";
    return input.autoRunArmed ? "" : "Paused: press ⌘R to run";
  }
  switch (input.state) {
    case "transpiling":
    case "evaluating":
      return "Running…";
    case "settled":
      return `Running: ${input.activeHandles} active ${input.activeHandles === 1 ? "handle" : "handles"}`;
    case "stopping":
      return "Stopping…";
    case "stopped":
      return "Stopped";
    case "killed":
      return "Run killed";
    case "failed":
      return "Failed";
    case "unresponsive":
      return "Not responding";
    case "idle":
      return "";
  }
}
```

`apps/ui/src/shell/parts.tsx`:
```tsx
import type { RunState } from "@jslab/rpc-schema";
import { LANGUAGES, type Language } from "@jslab/shared";
import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef } from "react";
import { useStore } from "zustand";
import type { AppStore } from "../state/store";
import { BUSY_STATES, LANGUAGE_LABELS, runStateLabel } from "./labels";

export function ActivityBar(props: { runState: RunState | null; onRun(): void; onStop(): void }) {
  const busy = props.runState !== null && BUSY_STATES.has(props.runState);
  return (
    <nav className="activity-bar" aria-label="Actions">
      <button type="button" title="Run (⌘R)" aria-label="Run" onClick={props.onRun}>
        ▶
      </button>
      <button type="button" title="Stop (⇧⌘R)" aria-label="Stop" onClick={props.onStop} disabled={!busy}>
        ■
      </button>
      {busy && <output className="activity-spinner" aria-label="Running" />}
    </nav>
  );
}

export function StatusBar({ store }: { store: AppStore }) {
  const tab = useStore(store, (s) => s.tab);
  const output = useStore(store, (s) => s.output);
  const safeMode = useStore(store, (s) => s.safeMode.active);
  const autoRunArmed = useStore(store, (s) => s.autoRunArmed);
  if (!tab) return null;
  const label = runStateLabel({ state: output.runState, activeHandles: output.activeHandles, autoRunArmed, safeMode });
  return (
    <footer className="status-bar">
      <span className="status-item">Bun</span>
      <label className="status-item">
        <span className="visually-hidden">Language</span>
        <select value={tab.language} onChange={(event) => store.getState().setLanguage(event.target.value as Language)}>
          {LANGUAGES.map((language) => (
            <option key={language} value={language}>
              {LANGUAGE_LABELS[language]}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="status-item" onClick={() => store.getState().toggleOrientation()}>
        {tab.layout.orientation === "horizontal" ? "Side by side" : "Stacked"}
      </button>
      <span className="status-item status-run" data-testid="run-status">
        {label}
      </span>
    </footer>
  );
}

export function SplitPane(props: {
  orientation: "horizontal" | "vertical";
  size: number;
  onResize(size: number): void;
  first: ReactNode;
  second: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const horizontal = props.orientation === "horizontal";

  const startDrag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const rect = container.current?.getBoundingClientRect();
    if (!rect) return;
    const move = (e: PointerEvent) => {
      const ratio = horizontal ? (e.clientX - rect.left) / rect.width : (e.clientY - rect.top) / rect.height;
      props.onResize(Math.round(ratio * 100));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={container} className={`split split-${props.orientation}`}>
      <div className="split-pane" style={{ flexBasis: `${props.size}%` }}>
        {props.first}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter needs role=separator; <hr> cannot be dragged */}
      <div
        className="split-divider"
        role="separator"
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuenow={props.size}
        aria-valuemin={10}
        aria-valuemax={90}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(event) => {
          const step = { ArrowLeft: -2, ArrowUp: -2, ArrowRight: 2, ArrowDown: 2 }[event.key] ?? 0;
          if (step !== 0) props.onResize(props.size + step);
        }}
      />
      <div className="split-pane split-pane-rest">{props.second}</div>
    </div>
  );
}

export function UnresponsiveDialog(props: { onKill(): void; onWait(): void }) {
  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="unresponsive-title">
        <h2 id="unresponsive-title">This tab isn't responding</h2>
        <p>Your code has been busy for a few seconds without responding. You can kill it, or keep waiting.</p>
        <div className="dialog-actions">
          <button type="button" onClick={props.onWait}>
            Wait
          </button>
          <button type="button" className="danger" onClick={props.onKill}>
            Kill
          </button>
        </div>
      </div>
    </div>
  );
}

const SAFE_MODE_MESSAGES = {
  crashLoop: "JSLab didn't shut down cleanly while running code. Auto Run is paused for this session.",
  shift: "Safe Mode: Shift was held at launch. Auto Run is paused for this session.",
} as const;

export function SafeModeBanner({ reason }: { reason: "crashLoop" | "shift" | null }) {
  if (!reason) return null;
  return (
    <output className="banner banner-warning" data-testid="safe-mode-banner">
      {SAFE_MODE_MESSAGES[reason]}
    </output>
  );
}
```

- [ ] **Step 4: Implement the App component**

`apps/ui/src/shell/App.tsx`:
```tsx
import type { CommandId } from "@jslab/rpc-schema";
import { useCallback, useEffect } from "react";
import { useStore } from "zustand";
import type { MainApi } from "../api";
import { Editor } from "../editor/Editor";
import { OutputPanel } from "../output/OutputPanel";
import { startAutoRun } from "../state/auto-run";
import type { AppStore } from "../state/store";
import { commandForKey } from "./keys";
import { ActivityBar, SafeModeBanner, SplitPane, StatusBar, UnresponsiveDialog } from "./parts";

const UI_HEARTBEAT_MS = 2000;

export function App({ store, api }: { store: AppStore; api: MainApi }) {
  const tab = useStore(store, (s) => s.tab);
  const runState = useStore(store, (s) => s.output.runState);
  const safeMode = useStore(store, (s) => s.safeMode);

  const run = useCallback(
    (reason: "auto" | "manual") => {
      const state = store.getState();
      if (!state.tab) return;
      if (reason === "manual") state.armAutoRun();
      void api.startRun({ tabId: state.tab.id, code: state.code, language: state.tab.language, logpoints: [], reason });
    },
    [store, api],
  );

  const execute = useCallback(
    (command: CommandId) => {
      const tabId = store.getState().tab?.id;
      switch (command) {
        case "run.start":
          run("manual");
          return;
        case "run.stop":
          if (tabId) api.stop(tabId);
          return;
        case "run.kill":
          if (tabId) api.kill(tabId);
          return;
        case "output.clear":
          store.getState().clearOutput();
          return;
        case "editor.clear":
          store.getState().editCode("");
          return;
      }
    },
    [store, api, run],
  );

  useEffect(() => startAutoRun(store, () => run("auto")), [store, run]);

  useEffect(() => {
    const unsubscribers = [
      api.on("run.events", ({ runId, events }) => store.getState().receiveEvents(runId, events)),
      api.on("run.state", ({ runId, state, activeHandles }) =>
        store.getState().receiveState(runId, state, activeHandles),
      ),
      api.on("run.diagnostics", ({ runId, diagnostics }) => store.getState().receiveDiagnostics(runId, diagnostics)),
      api.on("menu.command", ({ command }) => execute(command)),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [store, api, execute]);

  useEffect(
    () =>
      store.subscribe((state, previous) => {
        if (!state.tab) return;
        if (state.code !== previous.code) api.bufferChanged(state.tab.id, state.code);
        if (
          previous.tab &&
          (state.tab.language !== previous.tab.language || state.tab.layout !== previous.tab.layout)
        ) {
          api.patchTab(state.tab.id, { language: state.tab.language, layout: state.tab.layout });
        }
      }),
    [store, api],
  );

  useEffect(() => {
    const timer = setInterval(() => api.heartbeat(), UI_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [api]);

  useEffect(() => {
    // Capture phase so shortcuts win over Monaco and WKWebView defaults (for example Cmd+R reload).
    const onKeyDown = (event: KeyboardEvent) => {
      const command = commandForKey(event);
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      execute(command);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [execute]);

  if (!tab) return null;
  const tabId = tab.id;

  return (
    <div className="app">
      {safeMode.active && <SafeModeBanner reason={safeMode.reason} />}
      <div className="app-main">
        <ActivityBar runState={runState} onRun={() => execute("run.start")} onStop={() => execute("run.stop")} />
        <SplitPane
          orientation={tab.layout.orientation}
          size={tab.layout.editorSize}
          onResize={(size) => store.getState().setEditorSize(size)}
          first={<Editor store={store} />}
          second={<OutputPanel store={store} api={api} />}
        />
      </div>
      <StatusBar store={store} />
      {runState === "unresponsive" && (
        <UnresponsiveDialog onKill={() => execute("run.kill")} onWait={() => api.wait(tabId)} />
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests**

Run: `cd apps/ui && bun test`
Expected: `48 pass`, `0 fail`.

- [ ] **Step 6: Add the entry point, page, styles and Vite config**

`apps/ui/src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import { createRpcApi } from "./rpc";
import { App } from "./shell/App";
import { createAppStore } from "./state/store";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root element is missing from index.html");

const api = createRpcApi();
const store = createAppStore();

api
  .bootstrap()
  .then((payload) => {
    store.getState().hydrate(payload);
    createRoot(root).render(<App store={store} api={api} />);
  })
  .catch((error: unknown) => {
    root.textContent = `JSLab failed to start: ${error instanceof Error ? error.message : String(error)}`;
  });
```

`apps/ui/src/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self' views:; script-src 'self' views: 'wasm-unsafe-eval'; worker-src 'self' views: blob:; style-src 'self' views: 'unsafe-inline'; img-src 'self' views: data: blob:; font-src 'self' views: data:; connect-src 'self' views: ws://127.0.0.1:* ws://localhost:*"
    />
    <title>JSLab</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`apps/ui/src/styles.css`:
```css
:root {
  --bg: #21222c;
  --bg-elevated: #282a36;
  --fg: #f8f8f2;
  --fg-muted: #6272a4;
  --border: #191a21;
  --accent: #bd93f9;
  --danger: #ff5555;
  --warning: #f1fa8c;
  --selection: #44475a;
  --string: #f1fa8c;
  --number: #bd93f9;
  --key: #8be9fd;
  --mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
  color-scheme: dark;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  height: 100%;
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font:
    13px / 1.4 -apple-system,
    BlinkMacSystemFont,
    sans-serif;
}

button {
  font: inherit;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.4;
  cursor: default;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.app-main {
  display: flex;
  flex: 1;
  min-height: 0;
}

.activity-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 40px;
  padding: 6px 4px;
  background: var(--border);
}

.activity-bar button {
  height: 32px;
}

.activity-spinner {
  width: 16px;
  height: 16px;
  margin: 4px auto;
  border: 2px solid var(--fg-muted);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.split {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.split-vertical {
  flex-direction: column;
}

.split-pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.split-pane-rest {
  flex: 1;
}

.split-divider {
  flex: 0 0 4px;
  background: var(--border);
  cursor: col-resize;
}

.split-vertical .split-divider {
  cursor: row-resize;
}

.editor {
  height: 100%;
}

.line-hover {
  background: var(--selection);
}

.output {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-elevated);
}

.output-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
}

.output-title {
  flex: 1;
  color: var(--fg-muted);
}

.output-scroller {
  flex: 1;
  overflow: auto;
  font-family: var(--mono);
}

.entry {
  display: flex;
  gap: 8px;
  padding: 2px 8px;
  border-bottom: 1px solid #ffffff08;
}

.entry-stale {
  opacity: 0.45;
}

.entry-body {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.entry-line {
  align-self: flex-start;
  color: var(--fg-muted);
}

.entry-console-warn {
  background: #f1fa8c14;
}

.entry-console-error,
.entry-error {
  background: #ff555514;
  color: var(--danger);
}

.entry-frame {
  display: block;
  color: var(--fg-muted);
  text-align: left;
}

.entry-codeframe,
.entry-stream {
  margin: 0;
  font-family: var(--mono);
}

.entry-args > * + * {
  margin-left: 8px;
}

.entry-table {
  border-collapse: collapse;
}

.entry-table th,
.entry-table td {
  padding: 1px 6px;
  border: 1px solid var(--selection);
}

.v-string {
  color: var(--string);
}

.v-number,
.v-bigint,
.v-boolean {
  color: var(--number);
}

.v-key {
  color: var(--key);
}

.v-toggle {
  padding: 0;
  text-align: left;
}

.v-children {
  padding-left: 16px;
}

.v-hole,
.v-expired {
  color: var(--fg-muted);
}

.output-truncated {
  padding: 6px 8px;
  color: var(--warning);
}

.status-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 2px 8px;
  background: var(--border);
  color: var(--fg-muted);
}

.status-bar select {
  color: inherit;
  background: transparent;
  border: none;
}

.status-run {
  margin-left: auto;
}

.banner {
  display: block;
  padding: 6px 12px;
}

.banner-warning {
  background: #f1fa8c22;
  color: var(--warning);
}

.dialog-backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: #0008;
}

.dialog {
  max-width: 420px;
  padding: 16px 20px;
  background: var(--bg-elevated);
  border: 1px solid var(--selection);
  border-radius: 8px;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dialog-actions button {
  padding: 4px 12px;
  border-color: var(--selection);
}

.dialog-actions .danger {
  background: var(--danger);
  color: var(--bg);
}
```

`apps/ui/vite.config.ts`:
```ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { electrobunViteAliases } from "../desktop/.hutch/devkit/api/config/electrobun-vite";

// The UI is built into the desktop app's dist folder; electrobun.config.ts copies it into views/mainview.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: electrobunViteAliases(resolve(import.meta.dirname, "../desktop/.hutch/devkit")) },
  root: "src",
  base: "./",
  worker: { format: "es" },
  build: {
    outDir: "../../desktop/dist/mainview",
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
```

- [ ] **Step 7: Build the UI**

Run: `cd apps/ui && bun run build`
Expected: Vite writes `apps/desktop/dist/mainview/index.html` and `apps/desktop/dist/mainview/assets/*`, including separate worker chunks for `editor.worker` and `ts.worker`.

- [ ] **Step 8: Run the app end to end**

Run: `cd apps/desktop && hutch run dev`

Expected:
1. The JSLab window shows the editor, output panel, activity bar and status bar. The status reads `Paused: press ⌘R to run`.
2. Type `1 + 1`. About 300 ms later the output shows `2` with an `L1` badge.
3. Type `console.log('hi')` on line 2. The output shows `hi` with `L2`.
4. Type `while (true) {}` on a new line. The output shows `RangeError: Potential infinite loop: exceeded 2000 iterations`.

If step 2 shows no output:
- open Web Inspector on the view and check the console for CSP or RPC errors;
- check the terminal for `[jslab]` log lines.

Fix the cause, re-run the typechecks and tests, and repeat.

- [ ] **Step 9: Commit**

```bash
git add apps/ui
git commit -m "feat(ui): app shell with safe auto-run, shortcuts, unresponsive dialog and vite build"
```

---

### Task 19: M1 verification, QA checklist and parity status

**Files:**
- Create: `docs/qa/m1-checklist.md`
- Modify: `docs/parity.md` (M1 rows only)

**Interfaces:**
- Consumes: the complete M1 app.
- Produces: a signed-off M1, and the parity statuses the roadmap's M2 plan starts from.

- [ ] **Step 1: Add the QA checklist**

`docs/qa/m1-checklist.md`:
````markdown
# M1 Manual QA Checklist

Run against a packaged canary build (`cd apps/desktop && hutch run build`), on macOS arm64, starting from a clean data folder. Launch it the way M0-S1 recorded:
- The canary `.app` is a self-extracting installer. On first launch it extracts into the data folder below.
- Copy it to internal disk first. Launched from an external volume (`/Volumes/...`), it stalls on a hidden removable-volume permission prompt.
- Set `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`, so the installer panel closes without a click.

From the repository root (the build step above leaves the shell in `apps/desktop`, so return first):

Note: R-M2-T25-1 / final review FB-I3 superseded the `rm -rf` step below with the guarded move used in the QA checklists.

```bash
cd "$(git rev-parse --show-toplevel)"
QA_DIR="$(mktemp -d)"
# Move an existing canary data folder into the QA folder instead of deleting it (R-M2-T25-1 / FB-I3).
[ -d "$HOME/Library/Application Support/dev.jslab.app/canary" ] && mv "$HOME/Library/Application Support/dev.jslab.app/canary" "$QA_DIR/canary-data-backup-$(date +%Y%m%d-%H%M%S)"
cp -R "apps/desktop/build/canary-macos-arm64/JSLab-canary.app" "$QA_DIR/"
ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1 "$QA_DIR/JSLab-canary.app/Contents/MacOS/launcher" &
```

- Use this explicit path. `find build -name '*.app' | head -1` can pick the dev app instead of the canary.
- Relaunch with the same `launcher` command.
- To quit from a script, kill by PID (`pkill -f "$QA_DIR/JSLab-canary.app"`), because `osascript -e 'quit app …'` does not quit the app. Items that test a clean quit (Q14) still use ⌘Q.

Each item passes only if the result matches exactly. Record failures as issues and link them in the M1 PR.

## Launch and editing

- [ ] **Q1 First launch.** The app opens one window with one tab and the status bar reads `Paused: press ⌘R to run`. Nothing appears in the output until you type.
- [ ] **Q2 Auto Run.** Type `1 + 1`. About 300 ms after you stop typing, the output shows `2` with an `L1` badge.
- [ ] **Q3 TypeScript.** Replace the code with the snippet below. The output shows `hi 2` (L2) and `42` (L3).

  ```ts
  const a: number = 2
  console.log('hi', a)
  a * 21
  ```

- [ ] **Q4 Magic comments.** `[1, 2, 3].map((n) => n * 2) //?` shows `Array(3)`, which expands to `0: 2, 1: 4, 2: 6`. `'abc'.toUpperCase() /*?*/ .length` shows `ABC`.
- [ ] **Q5 Line links.**
  - Clicking an `L3` badge moves the caret to line 3.
  - Hovering an entry highlights its line in the editor.
- [ ] **Q6 Errors.**
  - `JSON.parse('{')` shows `SyntaxError: …`, with a red squiggle on that line.
  - A syntax error such as `const x = ;` shows a code frame, keeps the previous output dimmed, and adds a squiggle at the error column.

## Values and async work

- [ ] **Q7 Deep values.** `({ a: { b: { c: { d: 1 } } } })` expands level by level down to `d: 1`.
- [ ] **Q8 Promises.** `new Promise((r) => setTimeout(() => r(7), 500))` first shows `Promise { <pending> }`, which changes to `Promise { <fulfilled> }` with the result `7`.
- [ ] **Q9 Stop.** `setInterval(() => console.log(Date.now()), 200)` keeps logging and the status reads `Running: 1 active handle`. ⇧⌘R stops the logging, and the status reads `Stopped`.

## Recovery

- [ ] **Q10 Loop protection.** `while (true) {}` fails immediately with `RangeError: Potential infinite loop: exceeded 2000 iterations (line 1)…`.
- [ ] **Q11 Unresponsive.**
  1. Set `run.loopProtection` to `false` in `settings.json` and relaunch.
  2. Type `while (true) {}` and press ⌘R.
  3. After about 3 s, the dialog "This tab isn't responding" appears.
  4. Click **Wait**: the dialog returns about 3 s later.
  5. Click **Kill**: the status reads `Run killed`, and editing still works.
- [ ] **Q12 Crash-loop protection.**
  1. With loop protection still off, run `while (true) {}` and force-quit JSLab while the run is active.
  2. Relaunch. The Safe Mode banner reads "JSLab didn't shut down cleanly…", nothing runs, and typing does not auto-run.
  3. ⌘R still runs.
- [ ] **Q13 Shift safe mode.** Hold Shift while launching. A banner mentions Shift and Auto Run stays paused.

## Persistence

- [ ] **Q14 Restore.** Type code, change the language to JavaScript, drag the split divider, then quit with ⌘Q. On relaunch the code, language, split size and window frame are restored, and nothing runs until you edit.
- [ ] **Q15 Output cap.** `for (let i = 0; i < 20000; i++) console.log(i)` shows 10,000 entries plus the notice "Output truncated: 10000 more entries were dropped…", and scrolling stays smooth.
- [ ] **Q16 Clipboard.** In the editor, ⌘C/⌘V work and ⌘Z undoes. **Copy All** in the output toolbar copies every entry as text.
````

- [ ] **Step 2: Run the full automated suite from a clean install**

Run: `rm -rf node_modules && bun install --frozen-lockfile && bun run lint && bun run typecheck && bun run test`

Expected:
- lint and typecheck exit 0
- per-package test totals:

  | Package | Tests |
  |---|---|
  | `@jslab/shared` | 12 |
  | `@jslab/rpc-schema` | 5 |
  | `@jslab/serializer` | 20 |
  | `@jslab/transform` | 51 |
  | `@jslab/runner-bun` | 17 |
  | `@jslab/desktop` | 52 |
  | `@jslab/ui` | 48 |

- 205 tests in total, 0 fail

- [ ] **Step 3: Build a packaged canary app and run the checklist**

Run: `cd apps/desktop && hutch run build`

Launch it with the procedure at the top of `docs/qa/m1-checklist.md`: an internal-disk copy of `build/canary-macos-arm64/JSLab-canary.app`, started with `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1` and quit by PID when scripted (M0-S1). Work through Q1–Q16, ticking each item that passes. Any failing item blocks M1. Fix the failure with a test first where the behavior is unit-testable, then re-run Steps 2–3.

- [ ] **Step 4: Update parity statuses**

In `docs/parity.md`, set **Status** to ✅ for the rows M1 delivers and verified:
- **EX:** EX-01..EX-12, EX-17..EX-21, EX-26..EX-29, EX-36
- **OU:** OU-01..OU-09, OU-11..OU-15, OU-17
- **TF:** TF-13, TF-14
- **XT:** XT-06, XT-07, XT-09

EX-10..EX-12 are complete for magic comments only. Leave EX-14..EX-16 (the logpoint UI, M5) unchanged, even though the transform already supports logpoints.

- [ ] **Step 5: Push and confirm CI**

```bash
git add docs/qa/m1-checklist.md docs/parity.md
git commit -m "docs(qa): M1 checklist and parity status"
git push
```

Expected: the CI workflow from Task 1 passes on `macos-14`. CI needs the "Install Hutch 0.24.3" step that Task 13 Step 7b added before `bun install`. Without it, the `postinstall` from Task 13 exits with `postinstall: hutch not found`. If `bun run typecheck` fails in CI because `.hutch/devkit` is missing, confirm that both the Hutch step and the `postinstall` ran. CI must run `bun install` without `--ignore-scripts`.

---

## Spec coverage (M1)

| Spec section | Requirement | Task |
|---|---|---|
| §4.1 | Process roles; user code never in Main | 8, 9, 14 |
| §4.2 | Run data flow and batching | 7, 9, 14 |
| §4.3 | Typed RPC; zod validation; no dialogs awaited in handlers | 3, 12, 14, 17 |
| §4.4 | Repository layout | 1 and every task's file list |
| §4.5 | App data layout (`settings.json`, `session.json`, `buffers/`, `runs/`, `run.lock`) | 11, 12, 13 |
| §4.6 | Accelerator limitation; UI webview watchdog | 13, 14 |
| §5.1 | Runtime adapter surface: start/stop/kill/expand/dispose (as `RunCoordinator`) | 9 |
| §5.3 | ESM entry `.mjs`, `--no-env-file`, `NODE_PATH`, spares keyed by config | 9, 13 |
| §5.4 | Babel pipeline, source maps, syntax diagnostics, cache | 5, 10 |
| §5.5 | Auto Log, magic comments, logpoints (transform), loop protection | 5, 6 |
| §5.6 | Runner bootstrap: console, stdio, handles, errors, heartbeat, stop, expand | 7, 8 |
| §5.7 | Run state machine | 9, 15, 18 |
| §5.8 | Stop escalation, Kill, unresponsive dialog | 9, 18 |
| §5.9 | Value serialization and limits | 4 |
| §5.10 | Output events, cap, `console.clear`, `console.table`, groups | 7, 8, 15, 16 |
| §5.11 | Transpile/runtime/runner errors, stale dimming, squiggles | 9, 15, 16, 17 |
| §5.14 | Safe launch, crash-loop lock, Shift safe mode, Clear Editor | 11, 12, 15, 18 |
| §6.1 | Monaco baseline configuration | 17 |
| §7.1–7.2 | Activity bar, split, status bar, output panel behaviors | 16, 17, 18 |
| §10.1 | Buffer and session persistence, window frame | 11, 12, 14, 18 |
| §18 | CSP, validated RPC | 3, 12, 18 |
| §20 | Recovery of corrupt settings/session; runner crash reporting | 9, 11, 12 |
| §22.1–22.2 | Unit and integration suites | 2–12, 15, 16, 18 |

Deferred by design (roadmap): tabs, file open/save, the Settings window, themes and full menus (M2); npm, working directory and environment variables (M3); browser runtimes (M4); the logpoint gutter UI, snippets, AI, Gist and CLI (M5); updates and signing (M6).
