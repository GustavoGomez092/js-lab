import { describe, expect, mock, test } from "bun:test";
import { defaultSettings, mergeSettings } from "@jslab/shared";
import { createSettingsHandlers } from "../../src/main/rpc/settings-handlers";
import { InvalidPayloadError } from "../../src/main/rpc/validate";

function setup() {
  let current = defaultSettings();
  const deps = {
    settings: {
      get current() {
        return current;
      },
      update: mock(async (patch: Parameters<typeof mergeSettings>[1]) => {
        current = mergeSettings(current, patch);
        return current;
      }),
    },
    e2e: true,
    log: mock(() => {}),
  };
  return { deps, handlers: createSettingsHandlers(deps) };
}

describe("settings handlers", () => {
  test("settings.get returns the current settings and whether E2E automation is on", () => {
    const { handlers } = setup();
    expect(handlers.requests["settings.get"]({})).toEqual({ settings: defaultSettings(), e2e: true });
  });

  /**
   * `settings.get` is the first request the Settings window makes, so it is that window's proof its RPC is live --
   * which is what lets the E2E bridge stop holding sends (apps/desktop/src/main/cli/e2e-bridge.ts). The main window
   * serves `settings.get` from a SEPARATE instance of these handlers, and must never open the Settings gate.
   */
  test("settings.get reports this window's RPC as live, and stays optional for the set that has no gate", () => {
    const onViewReady = mock(() => {});
    const settingsNow = defaultSettings();
    const base = {
      settings: { current: settingsNow, update: mock(async () => settingsNow) },
      e2e: true,
      log: mock(() => {}),
    };

    const gated = createSettingsHandlers({ ...base, onViewReady });
    gated.requests["settings.get"]({});
    expect(onViewReady).toHaveBeenCalledTimes(1);

    // The main window's set gets no callback: it must still answer, and must not open the Settings window's gate.
    const ungated = createSettingsHandlers(base);
    expect(ungated.requests["settings.get"]({})).toEqual({ settings: settingsNow, e2e: true });
    expect(onViewReady).toHaveBeenCalledTimes(1);
  });

  test("settings.update validates, persists through the store and returns the repaired settings", async () => {
    const { handlers, deps } = setup();
    const next = await handlers.requests["settings.update"]({
      patch: { editor: { hoverDelayMs: 99_999, lineWrap: false } },
    });
    expect(next.editor).toMatchObject({ hoverDelayMs: 400, lineWrap: false });
    expect(() => handlers.requests["settings.update"]({ patch: { secrets: { key: "x" } } })).toThrow(
      InvalidPayloadError,
    );
    expect(deps.settings.update).toHaveBeenCalledTimes(1);
  });
});
