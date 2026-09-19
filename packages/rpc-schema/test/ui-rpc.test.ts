import { describe, expect, test } from "bun:test";
import {
  appCommandSchema,
  appNoticeSchema,
  bufferChangedSchema,
  commandsPublishedSchema,
  DEFAULT_NOTICE_SEVERITY,
  e2eResponseSchema,
  fileConfirmLargeSchema,
  fileConfirmSaveAsSchema,
  fileSaveParamsSchema,
  keybindingsSaveParamsSchema,
  MAX_OPEN_FILE_BYTES,
  MAX_TEXT_CHARS,
  noticeSeverity,
  runExpandParamsSchema,
  runStartParamsSchema,
  runTranspiledParamsSchema,
  STARTUP_NOTICE_IDS,
  settingsAppCommandSchema,
  settingsUpdateParamsSchema,
  tabCreateParamsSchema,
  tabParamsSchema,
  tabPatchSchema,
  tabReorderSchema,
  tabViewStateSchema,
  webRunnerMessageParamsSchema,
  webRunnerTabSchema,
} from "../src/ui-rpc";

const validStart = {
  tabId: "t1",
  code: "1 + 1",
  language: "typescript" as const,
  logpoints: [2],
  reason: "auto" as const,
  runtime: "bun" as const,
};

describe("inbound validators", () => {
  test("accept a valid run.start and strip unknown keys", () => {
    expect(runStartParamsSchema.parse({ ...validStart, extra: true })).toEqual(validStart);
  });

  test("reject bad run.start payloads", () => {
    expect(runStartParamsSchema.safeParse({ ...validStart, tabId: "" }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, language: "python" }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, logpoints: [0] }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...validStart, code: "x".repeat(MAX_TEXT_CHARS + 1) }).success).toBe(false);
  });

  test("run.start carries the tab's runtime", () => {
    const parsed = runStartParamsSchema.parse({
      tabId: "t1",
      code: "1",
      language: "typescript",
      logpoints: [],
      reason: "manual",
      runtime: "browser",
    });
    expect(parsed.runtime).toBe("browser");
  });

  test("run.start defaults an unknown runtime to bun rather than throwing", () => {
    const parsed = runStartParamsSchema.parse({
      tabId: "t1",
      code: "1",
      language: "typescript",
      logpoints: [],
      reason: "manual",
      runtime: "nope",
    });
    expect(parsed.runtime).toBe("bun");
  });

  test("tab ids must use the safe id format tabs are created with", () => {
    for (const tabId of [crypto.randomUUID(), "t1", "tab_2-B"]) {
      expect(tabParamsSchema.safeParse({ tabId }).success).toBe(true);
    }
    for (const tabId of ["../..", "..", ".", "a/b", "a\\b", "a b", "t1\u0000", "tab.json", "é", "x".repeat(101)]) {
      expect(tabParamsSchema.safeParse({ tabId }).success).toBe(false);
    }
    expect(runStartParamsSchema.safeParse({ ...validStart, tabId: "../../etc" }).success).toBe(false);
    expect(bufferChangedSchema.safeParse({ tabId: "../t1", content: "" }).success).toBe(false);
  });

  test("run.expand requires a uuid run id and a handle id", () => {
    const runId = crypto.randomUUID();
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId, handleId: "h12" }).success).toBe(true);
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId: "nope", handleId: "h12" }).success).toBe(false);
    expect(runExpandParamsSchema.safeParse({ tabId: "t1", runId, handleId: "../etc" }).success).toBe(false);
  });

  test("run.transpiled requires a safe tab id and an explicit hideInstrumentation flag", () => {
    expect(runTranspiledParamsSchema.safeParse({ tabId: "t1", hideInstrumentation: false }).success).toBe(true);
    // Not optional and not coerced: a missing or truthy-string flag would silently pick an output the caller
    // never asked for (instrumented vs not), so both are rejected at the boundary.
    expect(runTranspiledParamsSchema.safeParse({ tabId: "t1" }).success).toBe(false);
    expect(runTranspiledParamsSchema.safeParse({ tabId: "t1", hideInstrumentation: "yes" }).success).toBe(false);
    expect(runTranspiledParamsSchema.safeParse({ tabId: "../escape", hideInstrumentation: true }).success).toBe(false);
  });

  test("buffer.changed caps content size", () => {
    expect(bufferChangedSchema.safeParse({ tabId: "t1", content: "ok" }).success).toBe(true);
    expect(bufferChangedSchema.safeParse({ tabId: "t1", content: "x".repeat(MAX_TEXT_CHARS + 1) }).success).toBe(false);
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

  // Fix round 1 (F5): tiles used to require every field once present, so a partial tiles patch failed validation
  // and took the whole tab.patch down with it -- language/runtime/title included.
  test("tab.patch's layout.tiles accepts a partial patch without taking the rest of the patch down (fix round 1, F5)", () => {
    const parsed = tabPatchSchema.parse({
      tabId: "t1",
      patch: { runtime: "browser", layout: { tiles: { webviewVisible: true } } },
    });
    expect(parsed.patch.runtime).toBe("browser");
    expect(parsed.patch.layout?.tiles).toEqual({ webviewVisible: true });
    // Still rejects a genuinely invalid tiles field, partial or not.
    expect(tabPatchSchema.safeParse({ tabId: "t1", patch: { layout: { tiles: { consoleSize: 500 } } } }).success).toBe(
      false,
    );
  });

  // Task 15: `muted` is a sibling field of `tiles` in `tabLayoutSchema` (packages/shared), so it must be named here
  // too -- the same whitelist gotcha F5 documents for `tiles` above (an unlisted field is silently stripped in
  // transit: the UI updates, nothing persists, no error anywhere).
  /**
   * Final review, finding E. `runtime` was the one field in `tab.patch`'s patch object left without a fallback,
   * while its siblings `tiles`/`muted` and both `runStartParamsSchema.runtime` (`.catch("bun")`) and
   * `tabStateSchema.runtime` (`.catch(DEFAULT_RUNTIME)`) all degrade on their own. An unrecognised runtime
   * therefore failed the whole `safeParse`, so Main silently dropped the ENTIRE patch -- a legitimate simultaneous
   * title or language change included -- logging only "Rejected invalid tab.patch payload" with nothing
   * user-visible. That is the exact failure mode fix round 1's F5 was written to eliminate.
   */
  test("tab.patch survives an unrecognised runtime instead of dropping the whole patch (final review, E)", () => {
    const parsed = tabPatchSchema.parse({
      tabId: "t1",
      patch: { title: "Renamed", language: "javascript", runtime: "deno" },
    });

    // The rest of the patch survives -- this is the half that was being silently lost.
    expect(parsed.patch.title).toBe("Renamed");
    expect(parsed.patch.language).toBe("javascript");
    // The unrecognised value degrades to the default rather than failing the object.
    expect(parsed.patch.runtime).toBe("bun");

    // A patch naming only a bad runtime still parses, rather than being rejected outright.
    expect(tabPatchSchema.safeParse({ tabId: "t1", patch: { runtime: "deno" } }).success).toBe(true);
    // A well-formed runtime is still carried through untouched.
    expect(tabPatchSchema.parse({ tabId: "t1", patch: { runtime: "browser" } }).patch.runtime).toBe("browser");
  });

  test("tab.patch's layout.muted accepts a bare patch without the rest of layout", () => {
    const parsed = tabPatchSchema.parse({ tabId: "t1", patch: { layout: { muted: true } } });
    expect(parsed.patch.layout).toEqual({ muted: true });
    expect(tabPatchSchema.safeParse({ tabId: "t1", patch: { layout: { muted: "yes" } } }).success).toBe(false);
  });

  test("e2e.response requires a positive request id and caps error text", () => {
    expect(e2eResponseSchema.safeParse({ reqId: 1, ok: true, result: { any: "thing" } }).success).toBe(true);
    expect(e2eResponseSchema.safeParse({ reqId: 0, ok: true }).success).toBe(false);
    expect(e2eResponseSchema.safeParse({ reqId: 2, ok: false, error: "x".repeat(10_001) }).success).toBe(false);
  });

  test("settings.update accepts scalar patches to known sections only", () => {
    expect(
      settingsUpdateParamsSchema.safeParse({ patch: { editor: { lineWrap: false }, view: { layout: "vertical" } } })
        .success,
    ).toBe(true);
    expect(settingsUpdateParamsSchema.safeParse({ patch: { ai: { provider: "openai" } } }).success).toBe(false);
    expect(settingsUpdateParamsSchema.safeParse({ patch: { editor: { lineWrap: { nested: true } } } }).success).toBe(
      false,
    );
  });

  test("settings.update accepts at most 64 keys per section (FA-m7)", () => {
    const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`key${i}`, true]));
    expect(settingsUpdateParamsSchema.safeParse({ patch: { editor: keys(64), view: keys(64) } }).success).toBe(true);
    expect(settingsUpdateParamsSchema.safeParse({ patch: { editor: keys(65) } }).success).toBe(false);
  });

  test("workspace payloads: tab.create, widened tab.patch, tab.reorder, size-capped view state and one text cap", () => {
    expect(MAX_TEXT_CHARS).toBeGreaterThan(MAX_OPEN_FILE_BYTES);
    const large = "x".repeat(6 * 1024 * 1024);
    const tooLarge = "x".repeat(MAX_TEXT_CHARS + 1);
    const run = { tabId: "t", language: "javascript", logpoints: [], reason: "manual" };
    expect(tabCreateParamsSchema.safeParse({ content: large }).success).toBe(true);
    expect(tabCreateParamsSchema.safeParse({ content: tooLarge }).success).toBe(false);
    expect(runStartParamsSchema.safeParse({ ...run, code: large }).success).toBe(true);
    expect(runStartParamsSchema.safeParse({ ...run, code: tooLarge }).success).toBe(false);
    expect(bufferChangedSchema.safeParse({ tabId: "t", content: large }).success).toBe(true);
    expect(tabCreateParamsSchema.parse({ language: "tsx", content: "x", extra: 1 })).toEqual({
      language: "tsx",
      content: "x",
    });
    expect(tabCreateParamsSchema.safeParse({ runtime: "deno" }).success).toBe(false);
    expect(
      tabPatchSchema.safeParse({
        tabId: "t",
        patch: { titleIsCustom: true, runtime: "bun", layout: { outputVisible: false } },
      }).success,
    ).toBe(true);
    expect(tabReorderSchema.safeParse({ tabOrder: [] }).success).toBe(false);
    expect(tabViewStateSchema.safeParse({ tabId: "t", viewState: { a: 1 } }).success).toBe(true);
    expect(tabViewStateSchema.safeParse({ tabId: "t", viewState: "x".repeat(200_001) }).success).toBe(false);
  });

  test("app.command accepts only known actions", () => {
    expect(appCommandSchema.safeParse({ action: "copyDebugLog" }).success).toBe(true);
    expect(appCommandSchema.safeParse({ action: "exec" }).success).toBe(false);
  });

  test("the Settings window's app.command accepts only the Settings actions (FA-m11)", () => {
    for (const action of ["resetSettings", "openDataFolder", "restartSafeMode", "openKeybindingsFile"]) {
      expect(settingsAppCommandSchema.safeParse({ action }).success).toBe(true);
    }
    for (const action of ["closeWindow", "toggleFullScreen", "openSettings", "copyDebugLog", "exec"]) {
      expect(settingsAppCommandSchema.safeParse({ action }).success).toBe(false);
    }
  });

  // M5c §16.1. The `cliInstall` notice id matters as much as the actions: `app.notice` is the one Main -> UI
  // message the UI re-validates (App.tsx runs `appNoticeSchema` and silently drops anything that fails), so an id
  // missing from STARTUP_NOTICE_IDS would mean the install result never reaches the user.
  test("the main window can install the jslab CLI, the Settings window cannot, and its notice id is known", () => {
    for (const action of ["installCli", "uninstallCli"]) {
      expect(appCommandSchema.safeParse({ action }).success).toBe(true);
      expect(settingsAppCommandSchema.safeParse({ action }).success).toBe(false);
    }
    expect(appNoticeSchema.safeParse({ id: "cliInstall", message: "jslab is installed." }).success).toBe(true);
  });

  // M5d Task 10: both payloads cross into Main and are bounded there (spec §18).
  test("commands.published accepts a bounded id list and nothing else", () => {
    expect(commandsPublishedSchema.safeParse({ ids: [] }).success).toBe(true);
    expect(commandsPublishedSchema.safeParse({ ids: ["run.start"] }).success).toBe(true);
    expect(commandsPublishedSchema.safeParse({ ids: "run.start" }).success).toBe(false);
    expect(commandsPublishedSchema.safeParse({ ids: [""] }).success).toBe(false);
    expect(commandsPublishedSchema.safeParse({ ids: ["x".repeat(101)] }).success).toBe(false);
    expect(commandsPublishedSchema.safeParse({ ids: Array.from({ length: 1000 }, () => "x") }).success).toBe(true);
    expect(commandsPublishedSchema.safeParse({ ids: Array.from({ length: 1001 }, () => "x") }).success).toBe(false);
  });

  test("keybindings.save validates each rule and caps the override set", () => {
    expect(keybindingsSaveParamsSchema.safeParse({ rules: [] }).success).toBe(true);
    expect(keybindingsSaveParamsSchema.safeParse({ rules: [{ key: "cmd+j", command: "run.start" }] }).success).toBe(
      true,
    );
    // `when` is optional, and a removal rule ("-<id>") is a legitimate command value.
    expect(
      keybindingsSaveParamsSchema.safeParse({ rules: [{ key: "cmd+j", command: "-run.start", when: "editorFocus" }] })
        .success,
    ).toBe(true);
    expect(keybindingsSaveParamsSchema.safeParse({}).success).toBe(false);
    expect(keybindingsSaveParamsSchema.safeParse({ rules: "nope" }).success).toBe(false);
    expect(keybindingsSaveParamsSchema.safeParse({ rules: [{ key: "cmd+j" }] }).success).toBe(false);
    expect(keybindingsSaveParamsSchema.safeParse({ rules: [{ key: "", command: "run.start" }] }).success).toBe(false);
    const rule = { key: "cmd+j", command: "run.start" };
    expect(keybindingsSaveParamsSchema.safeParse({ rules: Array.from({ length: 500 }, () => rule) }).success).toBe(
      true,
    );
    expect(keybindingsSaveParamsSchema.safeParse({ rules: Array.from({ length: 501 }, () => rule) }).success).toBe(
      false,
    );
  });

  test("app.notice carries a known notice id and bounded text (FA-I3)", () => {
    expect(appNoticeSchema.safeParse({ id: "unexpectedError", message: "Something went wrong." }).success).toBe(true);
    expect(appNoticeSchema.safeParse({ id: "exec", message: "x" }).success).toBe(false);
    expect(appNoticeSchema.safeParse({ id: "unexpectedError", message: "x".repeat(2001) }).success).toBe(false);
  });

  // UI item 7. One banner voice for every id was the defect; severity is what gives it more than one. The map has
  // to be TOTAL, because an id with no severity is the failure mode that hides -- the notice still renders, just
  // in whatever tone the fallback picks.
  test("every notice id has a severity, and ids that differ in kind differ in severity", () => {
    // Drift guard. TypeScript already rejects a map that is missing a key; this catches what it cannot -- an id
    // added to the map that is no longer (or never was) a real notice id.
    expect(Object.keys(DEFAULT_NOTICE_SEVERITY).sort()).toEqual([...STARTUP_NOTICE_IDS].sort());
    expect(DEFAULT_NOTICE_SEVERITY).toEqual({
      // Recoveries: JSLab already put things right, and says so.
      settingsRecovered: "info",
      sessionRecovered: "info",
      cliInstall: "info",
      // Spec §17's restart notice: the user asked for a language and is being told when they will see it.
      // Nothing failed, so it speaks quietly and clears itself.
      languageChanged: "info",
      // Something the user still has, but degraded: changes that will not be saved, tabs that did not come back.
      settingsNewer: "warning",
      sessionNewer: "warning",
      tabsDropped: "warning",
      buffersUnreadable: "warning",
      // D1 is worded after `settingsNewer` in Main's strings ("the same situation") and has the same consequence
      // -- settings changes silently lost at restart -- so it gets that id's severity, not a louder one.
      settingsTooLarge: "warning",
      unexpectedError: "error",
    });
  });

  test("a notice carries its id's severity unless Main overrides it", () => {
    expect(noticeSeverity({ id: "unexpectedError", message: "x" })).toBe("error");
    expect(noticeSeverity({ id: "settingsTooLarge", message: "x" })).toBe("warning");
    // Spec §16.1: `cliInstall` reports BOTH a successful install and a failed one (CliInstallResult.ok), so it is
    // the one id whose severity cannot be derived from the id alone.
    expect(noticeSeverity({ id: "cliInstall", message: "x" })).toBe("info");
    expect(noticeSeverity({ id: "cliInstall", message: "x", severity: "error" })).toBe("error");
  });

  test("app.notice accepts an optional severity and rejects one that is not a severity", () => {
    expect(appNoticeSchema.safeParse({ id: "cliInstall", message: "ok" }).success).toBe(true);
    expect(appNoticeSchema.safeParse({ id: "cliInstall", message: "ok", severity: "error" }).success).toBe(true);
    expect(appNoticeSchema.safeParse({ id: "cliInstall", message: "ok", severity: "fatal" }).success).toBe(false);
  });

  test("file payloads cap content and token lists", () => {
    expect(fileSaveParamsSchema.safeParse({ tabId: "t", content: "x" }).success).toBe(true);
    expect(fileSaveParamsSchema.safeParse({ tabId: "t", content: "x".repeat(MAX_TEXT_CHARS + 1) }).success).toBe(false);
    expect(fileConfirmLargeSchema.safeParse({ tokens: Array.from({ length: 101 }, () => "t") }).success).toBe(false);
    expect(fileConfirmSaveAsSchema.safeParse({ token: "t", confirmed: "yes" }).success).toBe(false);
  });
});

// M4 Task 9a: the Main <-> UI web-runner bridge (spec §5.12). Only the UI -> Main direction is validated here;
// the Main -> UI messages are typed by `ViewMessages` and never cross an untrusted boundary.
describe("web runner bridge payloads", () => {
  test("webRunner.ready / webRunner.exit accept a tab id and generation, and reject malformed ones", () => {
    expect(webRunnerTabSchema.safeParse({ tabId: "t1", generation: 1 }).success).toBe(true);
    expect(webRunnerTabSchema.safeParse({ tabId: "", generation: 1 }).success).toBe(false);
    // The same path-safety rule every other tabId payload keeps (spec §18): Main joins these into runs/<tabId>/…
    expect(webRunnerTabSchema.safeParse({ tabId: "../escape", generation: 1 }).success).toBe(false);
    expect(webRunnerTabSchema.safeParse({ tabId: 1, generation: 1 }).success).toBe(false);
    // T9e: `generation` is what lets Main tell a stale event (from an entry it has already replaced) from a
    // current one, so it must actually be present and a real generation counter, not just any number.
    expect(webRunnerTabSchema.safeParse({ tabId: "t1" }).success).toBe(false);
    expect(webRunnerTabSchema.safeParse({ tabId: "t1", generation: 0 }).success).toBe(false);
    expect(webRunnerTabSchema.safeParse({ tabId: "t1", generation: -1 }).success).toBe(false);
    expect(webRunnerTabSchema.safeParse({ tabId: "t1", generation: 1.5 }).success).toBe(false);
    expect(webRunnerTabSchema.safeParse({ tabId: "t1", generation: "1" }).success).toBe(false);
  });

  test("webRunner.message requires an object envelope and passes its contents through untouched", () => {
    const envelope = { seq: 1, message: { type: "ready" } };
    const parsed = webRunnerMessageParamsSchema.parse({ tabId: "t1", raw: envelope });
    // `raw` is the page's own WebToHost envelope: this boundary only confirms it is routable, it never
    // re-implements the bridge's own shape check (createSequencedWebviewHost does that).
    expect(parsed.raw).toEqual(envelope);
    expect(webRunnerMessageParamsSchema.safeParse({ tabId: "t1", raw: "ready" }).success).toBe(false);
    expect(webRunnerMessageParamsSchema.safeParse({ tabId: "t1", raw: null }).success).toBe(false);
    expect(webRunnerMessageParamsSchema.safeParse({ tabId: "t1" }).success).toBe(false);
    expect(webRunnerMessageParamsSchema.safeParse({ tabId: "", raw: envelope }).success).toBe(false);
  });
});

// OU-02: `run.expand` may now name where in a collection the page should start.
describe("run.expand offsets (OU-02)", () => {
  const base = { tabId: "t1", runId: "00000000-0000-4000-8000-000000000000", handleId: "h7" };

  test("an offset is optional, non-negative and an integer", () => {
    // Absent is the pre-OU-02 shape: it must parse, and must stay absent rather than defaulting to a written 0.
    expect(runExpandParamsSchema.parse(base).offset).toBeUndefined();
    expect(runExpandParamsSchema.parse({ ...base, offset: 0 }).offset).toBe(0);
    expect(runExpandParamsSchema.parse({ ...base, offset: 10_000 }).offset).toBe(10_000);
    expect(runExpandParamsSchema.safeParse({ ...base, offset: -1 }).success).toBe(false);
    expect(runExpandParamsSchema.safeParse({ ...base, offset: 1.5 }).success).toBe(false);
    // A string must not be coerced: the UI reads `next` straight off an encoded page, and a coercing schema would
    // let a malformed value through to the encoder's arithmetic instead of failing at the boundary.
    expect(runExpandParamsSchema.safeParse({ ...base, offset: "10" }).success).toBe(false);
    expect(runExpandParamsSchema.safeParse({ ...base, offset: null }).success).toBe(false);
  });
});
