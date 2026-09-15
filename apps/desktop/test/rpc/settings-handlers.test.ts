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
