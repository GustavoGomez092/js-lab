import { describe, expect, test } from "bun:test";
import { appNoticeSchema } from "@jslab/rpc-schema";
import { fireEvent, render, screen } from "@testing-library/react";
import { StartupNotices } from "../src/shell/parts";
import { createAppStore } from "../src/state/store";

/**
 * The `settingsTooLarge` notice (D1), pinned end to end on the UI side.
 *
 * Main raising a notice is worth nothing if the UI drops it, and the ways it could drop it are silent: the id has
 * to survive `appNoticeSchema` (the UI validates every `app.notice` before showing it, so an id Main can raise but
 * the schema rejects is discarded without a trace), then reach the store, then actually render. `settingsNewer`
 * is covered at two of those points; this one was covered at none, which is why it is pinned here rather than
 * trusted to the path being generic.
 *
 * The exact wording lives in Main's strings and is asserted there (main-services.test.ts checks it names the file
 * and the limit). Asserting it again here would mean apps/ui reaching into apps/desktop, so this pins that
 * whatever message arrives is the message the user can read and dismiss.
 */
const MESSAGE =
  "settings.json is too large for JSLab to save (1054676 bytes; the limit is 1048576). " +
  "Changes made in this window won't be saved to it and will be lost when JSLab restarts.";

describe("the settings-too-large notice reaches the user", () => {
  test("the id crosses the app.notice contract, shows once, and can be dismissed", () => {
    // The wire contract. This is what breaks if `settingsTooLarge` is dropped from STARTUP_NOTICE_IDS: Main would
    // still raise it and the UI would still refuse it, silently -- the exact failure this notice exists to avoid.
    const parsed = appNoticeSchema.parse({ id: "settingsTooLarge", message: MESSAGE });
    expect(parsed.id).toBe("settingsTooLarge");

    // The store: one banner per id, however many times Main raises it. Main already raises it once per session,
    // so this is the second, independent guard against a banner that stacks up on every settings change.
    const store = createAppStore();
    store.getState().addNotice(parsed);
    store.getState().addNotice(parsed);
    expect(store.getState().notices.map((notice) => notice.id)).toEqual(["settingsTooLarge"]);

    // The real component, with the real notice object: the user can read it, and get rid of it.
    const dismissed: string[] = [];
    render(<StartupNotices notices={store.getState().notices} onDismiss={(id) => dismissed.push(id)} />);
    expect(screen.getByTestId("startup-notices").textContent).toContain("too large");
    expect(screen.getByText(MESSAGE, { exact: false })).toBeDefined();

    // No action is registered for this id, so the only button in the banner is its dismiss control.
    fireEvent.click(screen.getByRole("button"));
    expect(dismissed).toEqual(["settingsTooLarge"]);
  });

  test("a notice the schema rejects never reaches the store", () => {
    // The negative control for the assertion above: if `appNoticeSchema` accepted anything, the first test would
    // pass no matter what STARTUP_NOTICE_IDS contained, and would be pinning nothing at all.
    expect(() => appNoticeSchema.parse({ id: "settingsWayTooLarge", message: MESSAGE })).toThrow();
    expect(() => appNoticeSchema.parse({ id: "settingsTooLarge", message: "" })).toThrow();
  });
});
